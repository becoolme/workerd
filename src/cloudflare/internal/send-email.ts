// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

// Cloudflare Email Service — `send_email` binding (VRT fork).
// Rendered as a `wrapped` binding whose `fetcher` inner binding is the
// facade-email system worker: `send(message)` forwards the
// EmailMessageBuilder JSON to `POST /send` and resolves with the CF
// result `{messageId}`.
//
// CF contract: `send()` RESOLVES on success and THROWS on failure —
// service errors surface as Error objects carrying a `.code` (E_*)
// property; local argument misuse throws a TypeError without a code
// (the same class CF raises for malformed send() arguments). This is
// the opposite envelope from K2's non-throwing `{success,error}`.

import wrappedBinding from 'cloudflare-internal:wrapped-binding';

interface Fetcher {
  fetch: typeof fetch;
}

interface EmailAddress {
  email: string;
  name?: string;
}

type AddressLike = string | EmailAddress;

interface EmailAttachment {
  content: string;
  filename: string;
  type: string;
  disposition: 'attachment' | 'inline';
  contentId?: string;
}

interface EmailMessageBuilder {
  to?: AddressLike | AddressLike[];
  cc?: AddressLike | AddressLike[];
  bcc?: AddressLike | AddressLike[];
  from: AddressLike;
  subject: string;
  html?: string;
  text?: string;
  replyTo?: AddressLike;
  attachments?: EmailAttachment[];
  headers?: Record<string, string>;
}

interface EmailSendResult {
  messageId: string;
}

interface WireError {
  code?: string;
  message?: string;
  retryable?: boolean;
}

class EmailServiceError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'EmailServiceError';
    this.code = code;
  }
}

function isAddressLike(v: unknown): v is AddressLike {
  if (typeof v === 'string') return true;
  if (v === null || typeof v !== 'object') return false;
  const a = v as { email?: unknown; name?: unknown };
  return typeof a.email === 'string' && (a.name === undefined || typeof a.name === 'string');
}

function normalizeAddress(v: AddressLike): EmailAddress {
  return typeof v === 'string' ? { email: v } : v;
}

function normalizeAddressList(
  field: string,
  v: AddressLike | AddressLike[] | undefined
): EmailAddress[] | undefined {
  if (v === undefined) return undefined;
  const list = Array.isArray(v) ? v : [v];
  for (const item of list) {
    if (!isAddressLike(item)) {
      throw new TypeError(`send_email: ${field} entries must be an address string or {email, name?}`);
    }
  }
  return list.map(normalizeAddress);
}

function normalizeMessage(message: EmailMessageBuilder): Record<string, unknown> {
  if (message === null || typeof message !== 'object' || Array.isArray(message)) {
    throw new TypeError('send_email: message must be an EmailMessageBuilder object');
  }
  if (!isAddressLike(message.from)) {
    throw new TypeError('send_email: from must be an address string or {email, name?}');
  }
  if (typeof message.subject !== 'string') {
    throw new TypeError('send_email: subject is required and must be a string');
  }
  const to = normalizeAddressList('to', message.to);
  const cc = normalizeAddressList('cc', message.cc);
  const bcc = normalizeAddressList('bcc', message.bcc);
  if ((to?.length ?? 0) + (cc?.length ?? 0) + (bcc?.length ?? 0) === 0) {
    throw new TypeError('send_email: at least one of to, cc, or bcc is required');
  }
  if (message.html !== undefined && typeof message.html !== 'string') {
    throw new TypeError('send_email: html must be a string');
  }
  if (message.text !== undefined && typeof message.text !== 'string') {
    throw new TypeError('send_email: text must be a string');
  }
  const replyTo =
    message.replyTo === undefined ? undefined : normalizeAddressList('replyTo', message.replyTo)?.[0];
  let attachments: Record<string, unknown>[] | undefined;
  if (message.attachments !== undefined) {
    if (!Array.isArray(message.attachments)) {
      throw new TypeError('send_email: attachments must be an array');
    }
    attachments = message.attachments.map((a) => {
      if (a === null || typeof a !== 'object') {
        throw new TypeError('send_email: attachment must be an object');
      }
      if (typeof a.content !== 'string' || typeof a.filename !== 'string' || typeof a.type !== 'string') {
        throw new TypeError('send_email: attachment requires string content, filename and type');
      }
      if (a.disposition !== 'attachment' && a.disposition !== 'inline') {
        throw new TypeError('send_email: attachment disposition must be "attachment" or "inline"');
      }
      const out: Record<string, unknown> = {
        content: a.content,
        filename: a.filename,
        type: a.type,
        disposition: a.disposition,
      };
      if (a.contentId !== undefined) {
        if (typeof a.contentId !== 'string') {
          throw new TypeError('send_email: attachment contentId must be a string');
        }
        out.contentId = a.contentId;
      }
      return out;
    });
  }
  if (message.headers !== undefined) {
    if (message.headers === null || typeof message.headers !== 'object') {
      throw new TypeError('send_email: headers must be a string map');
    }
    for (const v of Object.values(message.headers)) {
      if (typeof v !== 'string') {
        throw new TypeError('send_email: header values must be strings');
      }
    }
  }
  return {
    from: normalizeAddress(message.from),
    to,
    cc,
    bcc,
    subject: message.subject,
    html: message.html,
    text: message.text,
    replyTo,
    attachments,
    headers: message.headers,
  };
}

class SendEmailBinding extends wrappedBinding.WrappedBinding {
  readonly #fetcher: Fetcher;

  constructor(fetcher: Fetcher) {
    super(fetcher);
    this.#fetcher = fetcher;
  }

  async send(message: EmailMessageBuilder): Promise<EmailSendResult> {
    const wire = normalizeMessage(message);
    let resp: Response;
    try {
      resp = await this.#fetcher.fetch('https://email/send', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(wire),
      });
    } catch {
      throw new EmailServiceError(
        'E_INTERNAL_SERVER_ERROR',
        'email send channel unavailable'
      );
    }
    let body: { success?: boolean; messageId?: string; error?: WireError };
    try {
      body = (await resp.json()) as typeof body;
    } catch {
      throw new EmailServiceError(
        'E_INTERNAL_SERVER_ERROR',
        `email backend replied with a non-JSON body (HTTP ${resp.status})`
      );
    }
    if (resp.ok && body && body.success === true && typeof body.messageId === 'string') {
      return { messageId: body.messageId };
    }
    const err = body?.error;
    throw new EmailServiceError(
      typeof err?.code === 'string' ? err.code : 'E_INTERNAL_SERVER_ERROR',
      typeof err?.message === 'string' ? err.message : `email send failed (HTTP ${resp.status})`
    );
  }
}

export default function makeBinding(env: { fetcher: Fetcher }): SendEmailBinding {
  return new SendEmailBinding(env.fetcher);
}
