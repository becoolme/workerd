// Mock facade-email backend for send-email-api tests: inspects the
// path/body and replies with the wire envelopes the real provider's
// /internal/bindings/v1/email/{id}/send emits.
export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname !== '/send' || request.method !== 'POST') {
      return new Response(JSON.stringify({ error: { code: 'E_VALIDATION_ERROR', message: 'bad route', retryable: false } }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    }
    const body = await request.json();
    const marker = body.headers?.['x-mock'];
    if (marker === 'denied') {
      return new Response(
        JSON.stringify({ success: false, error: { code: 'E_SENDER_NOT_VERIFIED', message: 'sender not allowed', retryable: false } }),
        { status: 403, headers: { 'content-type': 'application/json' } }
      );
    }
    if (marker === 'retryable') {
      return new Response(
        JSON.stringify({ success: false, error: { code: 'E_INTERNAL_SERVER_ERROR', message: 'upstream down', retryable: true } }),
        { status: 503, headers: { 'content-type': 'application/json' } }
      );
    }
    if (marker === 'badjson') {
      return new Response('not json', { status: 502 });
    }
    return new Response(JSON.stringify({ success: true, messageId: 'msg-test-1' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  },
};
