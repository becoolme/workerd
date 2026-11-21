import assert from 'node:assert';

const baseMessage = {
  from: 'hello@example.com',
  to: 'user@example.com',
  subject: 'hi',
  text: 'hello',
};

export const sendHappyPath = {
  async test(_ctrl, env) {
    const r = await env.EMAIL.send({
      ...baseMessage,
      to: [{ email: 'a@example.com', name: 'A' }, 'b@example.com'],
      cc: 'c@example.com',
      attachments: [
        { content: 'aGVsbG8=', filename: 'a.txt', type: 'text/plain', disposition: 'attachment' },
      ],
      headers: { 'x-tag': 't1' },
      replyTo: 'reply@example.com',
    });
    assert.deepStrictEqual(r, { messageId: 'msg-test-1' });
  },
};

export const sendServiceErrorThrows = {
  async test(_ctrl, env) {
    // CF contract: service failures THROW an Error carrying `.code`
    // (not a resolved failure envelope).
    try {
      await env.EMAIL.send({ ...baseMessage, headers: { 'x-mock': 'denied' } });
      assert.fail('send should throw');
    } catch (e) {
      assert.strictEqual(e.code, 'E_SENDER_NOT_VERIFIED');
      assert.match(e.message, /sender not allowed/);
      assert.ok(!(e instanceof TypeError));
    }
  },
};

export const sendRetryableErrorThrows = {
  async test(_ctrl, env) {
    try {
      await env.EMAIL.send({ ...baseMessage, headers: { 'x-mock': 'retryable' } });
      assert.fail('send should throw');
    } catch (e) {
      assert.strictEqual(e.code, 'E_INTERNAL_SERVER_ERROR');
    }
  },
};

export const sendLocalValidationTypeError = {
  async test(_ctrl, env) {
    // Local argument misuse throws TypeError WITHOUT a code property.
    for (const bad of [
      undefined,
      null,
      'x',
      { ...baseMessage, from: 7 },
      { ...baseMessage, subject: undefined },
      { from: 'a@b.com', subject: 's', text: 't' }, // no recipients
      { ...baseMessage, to: 7 },
      { ...baseMessage, html: 5 },
      { ...baseMessage, attachments: 'x' },
      { ...baseMessage, attachments: [{ content: 'x', filename: 'f' }] }, // missing type
      { ...baseMessage, attachments: [{ content: 'x', filename: 'f', type: 't', disposition: 'weird' }] },
      { ...baseMessage, headers: { 'x-k': 9 } },
    ]) {
      try {
        await env.EMAIL.send(bad);
        assert.fail(`send(${JSON.stringify(bad)}) should throw`);
      } catch (e) {
        assert.ok(e instanceof TypeError, `expected TypeError, got ${e}`);
        assert.strictEqual(e.code, undefined);
      }
    }
  },
};

export const sendBackendBadJsonThrows = {
  async test(_ctrl, env) {
    try {
      await env.EMAIL.send({ ...baseMessage, headers: { 'x-mock': 'badjson' } });
      assert.fail('send should throw');
    } catch (e) {
      assert.strictEqual(e.code, 'E_INTERNAL_SERVER_ERROR');
      assert.match(e.message, /non-JSON|HTTP 502/);
    }
  },
};
