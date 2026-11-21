import assert from 'node:assert';

export const sendHappyPath = {
  async test(_ctrl, env) {
    const r = await env.K2.send([
      { content: 'hello' },
      { content: new Uint8Array([1, 2, 3]).buffer, headers: { a: 'b' } },
      { content: new Uint8Array([9]) },
    ]);
    assert.deepStrictEqual(r, { success: true });
  },
};

export const sendErrorEnvelope = {
  async test(_ctrl, env) {
    const r = await env.K2.send([
      { content: 'x', headers: { 'x-mock': 'fail' } },
    ]);
    assert.strictEqual(r.success, false);
    assert.strictEqual(r.error.code, 'SLOTS_FULL');
    assert.strictEqual(r.error.retryable, true);
  },
};

export const sendLocalValidation = {
  async test(_ctrl, env) {
    // Empty batch resolves, does not throw.
    const empty = await env.K2.send([]);
    assert.strictEqual(empty.success, false);
    assert.strictEqual(empty.error.code, 'INVALID_BATCH');

    // Oversize record resolves with RECORD_TOO_LARGE.
    const big = await env.K2.send([{ content: new Uint8Array(1_000_001) }]);
    assert.strictEqual(big.success, false);
    assert.strictEqual(big.error.code, 'RECORD_TOO_LARGE');

    // Batch total >5MB resolves with BATCH_TOO_LARGE.
    const five = new Uint8Array(1_000_000);
    const batch = await env.K2.send([
      { content: five },
      { content: five },
      { content: five },
      { content: five },
      { content: five },
      { content: five },
    ]);
    assert.strictEqual(batch.success, false);
    assert.strictEqual(batch.error.code, 'BATCH_TOO_LARGE');

    // Too many headers resolves with INVALID_HEADERS.
    const headers = {};
    for (let i = 0; i < 65; i++) headers[`h${i}`] = 'v';
    const h = await env.K2.send([{ content: 'x', headers }]);
    assert.strictEqual(h.success, false);
    assert.strictEqual(h.error.code, 'INVALID_HEADERS');

    // Argument misuse throws TypeError (never reaches the backend).
    await assert.rejects(env.K2.send('nope'), TypeError);
    await assert.rejects(env.K2.send([{ content: 42 }]), TypeError);
    await assert.rejects(env.K2.send([{ content: 'x', headers: { a: 1 } }]), TypeError);
    await assert.rejects(env.K2.send(['x']), TypeError);
  },
};

export const sendMalformedBackend = {
  async test(_ctrl, env) {
    // Non-JSON backend body → typed PROTOCOL_ERROR, never a throw.
    const r1 = await env.K2.send([{ content: 'x', headers: { 'x-mock': 'badjson' } }]);
    assert.strictEqual(r1.success, false);
    assert.strictEqual(r1.error.code, 'PROTOCOL_ERROR');

    // Legacy `{error: "…"}` string surface → UNKNOWN with message.
    const r2 = await env.K2.send([{ content: 'x', headers: { 'x-mock': 'rawstring' } }]);
    assert.strictEqual(r2.success, false);
    assert.strictEqual(r2.error.code, 'UNKNOWN');
    assert.strictEqual(r2.error.message, 'plain failure');
  },
};
