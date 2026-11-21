// Mock facade-k2 backend for k2-api tests: inspects the path/body and
// replies with the CF K2 produce envelopes the real vrt-sql emits.
export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname !== '/send' || request.method !== 'POST') {
      return new Response(JSON.stringify({ error: { code: 'BAD_ROUTE', message: 'bad route', retryable: false } }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    }
    const body = await request.json();
    const marker = body.records?.[0]?.headers?.['x-mock'];
    if (marker === 'fail') {
      return new Response(
        JSON.stringify({ success: false, error: { code: 'SLOTS_FULL', message: 'no lease', retryable: true } }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (marker === 'badjson') {
      return new Response('not json', { status: 200 });
    }
    if (marker === 'rawstring') {
      return new Response(JSON.stringify({ error: 'plain failure' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  },
};
