// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

// K2 durable event log — produce binding (VRT fork).
// Rendered as a `wrapped` binding whose `fetcher` inner binding is the
// facade-k2 system worker: `send(records)` forwards
// `{records:[{content:<base64>,headers?}]}` to `POST /send` and resolves
// with the CF K2 non-throwing result — `{success:true}` on commit or
// `{success:false, error:{code,message,retryable}}` on failure. Per the
// K2 public contract `send()` resolves rather than throws; the only
// thrown path is local argument misuse (a TypeError, same class as CF
// argument validation).

import wrappedBinding from 'cloudflare-internal:wrapped-binding';

interface Fetcher {
  fetch: typeof fetch;
}

interface K2Record {
  content: string | ArrayBuffer | ArrayBufferView;
  headers?: Record<string, string>;
}

interface K2Error {
  code: string;
  message: string;
  retryable: boolean;
}

type K2SendResult = { success: true } | { success: false; error: K2Error };

const RECORD_MAX_BYTES = 1_000_000;
const BATCH_MAX_BYTES = 5_000_000;
const HEADERS_MAX = 64;
const HEADER_KV_MAX_BYTES = 1024;
// UTF-8 worst case is 3 bytes/code point in the BMP (4 for astral,
// which counts as 2 code units) — byteLength of the encoded bytes is
// what the backend enforces, so compute on the encoded form.
const textEncoder = new TextEncoder();

function contentBytes(
  content: K2Record['content']
): Uint8Array | undefined {
  if (typeof content === 'string') {
    return textEncoder.encode(content);
  }
  if (content instanceof ArrayBuffer) {
    return new Uint8Array(content);
  }
  if (ArrayBuffer.isView(content)) {
    return new Uint8Array(content.buffer, content.byteOffset, content.byteLength);
  }
  return undefined;
}

// Standard base64 — no btoa dependency on char codes; chunked to bound
// String.fromCharCode.apply argument counts.
function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    const chunk = bytes.subarray(i, i + 0x8000);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function fail(code: string, message: string, retryable = false): K2SendResult {
  return { success: false, error: { code, message, retryable } };
}

class K2Stream extends wrappedBinding.WrappedBinding {
  readonly #fetcher: Fetcher;

  constructor(fetcher: Fetcher) {
    super(fetcher);
    this.#fetcher = fetcher;
  }

  async send(records: K2Record[]): Promise<K2SendResult> {
    // Local argument validation throws (same class as CF API misuse);
    // backend/contract failures resolve with `{success:false,error}`.
    if (!Array.isArray(records)) {
      throw new TypeError('K2 send: records must be an array');
    }
    if (records.length === 0) {
      return fail('INVALID_BATCH', 'send batch must contain at least one record');
    }
    let total = 0;
    const encoded: { content: string; headers?: Record<string, string> }[] = [];
    for (const record of records) {
      if (record === null || typeof record !== 'object') {
        throw new TypeError('K2 send: each record must be an object');
      }
      const bytes = contentBytes(record.content);
      if (bytes === undefined) {
        throw new TypeError(
          'K2 send: record content must be a string, ArrayBuffer or ArrayBufferView'
        );
      }
      if (bytes.byteLength > RECORD_MAX_BYTES) {
        return fail('RECORD_TOO_LARGE', 'record content exceeds the 1MB limit');
      }
      total += bytes.byteLength;
      if (total > BATCH_MAX_BYTES) {
        return fail('BATCH_TOO_LARGE', 'record batch exceeds the 5MB limit');
      }
      let headers: Record<string, string> | undefined;
      if (record.headers !== undefined) {
        if (record.headers === null || typeof record.headers !== 'object') {
          throw new TypeError('K2 send: record headers must be a string map');
        }
        const entries = Object.entries(record.headers);
        if (entries.length > HEADERS_MAX) {
          return fail('INVALID_HEADERS', 'headers map exceeds the 64-entry limit');
        }
        headers = {};
        for (const [key, value] of entries) {
          if (typeof value !== 'string') {
            throw new TypeError('K2 send: header values must be strings');
          }
          if (
            textEncoder.encode(key).byteLength > HEADER_KV_MAX_BYTES ||
            textEncoder.encode(value).byteLength > HEADER_KV_MAX_BYTES
          ) {
            return fail('INVALID_HEADERS', 'header entry exceeds the 1KB limit');
          }
          headers[key] = value;
        }
      }
      const item: { content: string; headers?: Record<string, string> } = {
        content: bytesToBase64(bytes),
      };
      if (headers !== undefined) item.headers = headers;
      encoded.push(item);
    }

    let resp: Response;
    try {
      resp = await this.#fetcher.fetch('https://k2/send', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ records: encoded }),
      });
    } catch {
      return fail('BACKEND_UNAVAILABLE', 'k2 produce channel unavailable', true);
    }
    try {
      const body = (await resp.json()) as
        | ({ success?: boolean } & { error?: Partial<K2Error> })
        | { error?: Partial<K2Error> | string };
      if (body && typeof body === 'object' && 'success' in body && body.success === true) {
        return { success: true };
      }
      const err = (body as { error?: Partial<K2Error> | string }).error;
      if (err && typeof err === 'object') {
        return fail(
          typeof err.code === 'string' ? err.code : 'UNKNOWN',
          typeof err.message === 'string' ? err.message : 'k2 produce failed',
          err.retryable === true
        );
      }
      if (typeof err === 'string') {
        return fail('UNKNOWN', err);
      }
      return fail('UNKNOWN', `k2 produce failed (HTTP ${resp.status})`);
    } catch {
      return fail('PROTOCOL_ERROR', `k2 backend replied with a non-JSON body (HTTP ${resp.status})`);
    }
  }
}

export default function makeBinding(env: { fetcher: Fetcher }): K2Stream {
  return new K2Stream(env.fetcher);
}
