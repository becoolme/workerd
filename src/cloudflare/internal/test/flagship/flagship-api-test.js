// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import * as assert from 'node:assert';

// get() returns the raw variant value.
export const getRawValue = {
  async test(_ctrl, env) {
    assert.strictEqual(await env.FLAGS.get('simple-bool'), false);
    assert.strictEqual(await env.FLAGS.get('number-flag'), 42);
    assert.deepStrictEqual(await env.FLAGS.get('json-flag'), {
      theme: 'dark',
    });
  },
};

// get() with a default returns it on known failures (missing flag, bad
// context); without a default they are thrown.
export const getDefaultAndThrow = {
  async test(_ctrl, env) {
    assert.strictEqual(await env.FLAGS.get('no-such-flag', 'fallback'), 'fallback');
    await assert.rejects(() => env.FLAGS.get('no-such-flag'), (err) => {
      assert.strictEqual(err.errorCode, 'FLAG_NOT_FOUND');
      return true;
    });
    // Arity ≥ 2 counts as a supplied default even when it is undefined, so
    // known failures (invalid context here) return the fallback.
    assert.strictEqual(
      await env.FLAGS.get('simple-bool', undefined, NaN),
      undefined
    );
    assert.strictEqual(await env.FLAGS.get('no-such-flag', undefined), undefined);
  },
};

// Typed value methods: hit, and type mismatch falls back to the default.
export const typedValues = {
  async test(_ctrl, env) {
    assert.strictEqual(await env.FLAGS.getBooleanValue('simple-bool', true), false);
    assert.strictEqual(await env.FLAGS.getStringValue('plan-gated', 'x'), 'basic-copy');
    assert.strictEqual(await env.FLAGS.getNumberValue('number-flag', 0), 42);
    assert.deepStrictEqual(
      await env.FLAGS.getObjectValue('json-flag', { theme: 'none' }),
      { theme: 'dark' }
    );

    // Mismatches → supplied default.
    assert.strictEqual(await env.FLAGS.getStringValue('simple-bool', 'd'), 'd');
    assert.strictEqual(await env.FLAGS.getBooleanValue('number-flag', true), true);
    assert.strictEqual(await env.FLAGS.getNumberValue('json-flag', 7), 7);
    assert.deepStrictEqual(
      await env.FLAGS.getObjectValue('simple-bool', { a: 1 }),
      { a: 1 }
    );
  },
};

// *Details methods expose value + variant + reason.
export const detailsShape = {
  async test(_ctrl, env) {
    const d = await env.FLAGS.getBooleanDetails('simple-bool', true);
    assert.strictEqual(d.flagKey, 'simple-bool');
    assert.strictEqual(d.value, false);
    assert.strictEqual(d.variant, 'off');
    assert.strictEqual(d.reason, 'STATIC');
    assert.strictEqual(d.errorCode, undefined);

    const miss = await env.FLAGS.getStringDetails('nope', 'dv');
    assert.strictEqual(miss.value, 'dv');
    assert.strictEqual(miss.reason, 'ERROR');
    assert.strictEqual(miss.errorCode, 'FLAG_NOT_FOUND');
    assert.strictEqual(typeof miss.errorMessage, 'string');

    const mm = await env.FLAGS.getNumberDetails('json-flag', 1);
    assert.strictEqual(mm.errorCode, 'TYPE_MISMATCH');
    assert.strictEqual(mm.value, 1);
  },
};

// Disabled flags always return the default variant regardless of rules.
export const disabledFlag = {
  async test(_ctrl, env) {
    const d = await env.FLAGS.getBooleanDetails('disabled-flag', true, {
      plan: 'ent',
    });
    assert.strictEqual(d.value, false);
    assert.strictEqual(d.variant, 'off');
    assert.strictEqual(d.reason, 'DISABLED');
  },
};

// First matching rule wins (TARGETING_MATCH); no match → default (DEFAULT).
export const targetingMatchAndDefault = {
  async test(_ctrl, env) {
    const hit = await env.FLAGS.getStringDetails('plan-gated', 'x', {
      plan: 'ent',
    });
    assert.strictEqual(hit.value, 'pro-copy');
    assert.strictEqual(hit.variant, 'pro');
    assert.strictEqual(hit.reason, 'TARGETING_MATCH');

    const miss = await env.FLAGS.getStringDetails('plan-gated', 'x', {
      plan: 'free',
    });
    assert.strictEqual(miss.value, 'basic-copy');
    assert.strictEqual(miss.reason, 'DEFAULT');
  },
};

// Percentage rollouts: 100 always passes, 0 never does, custom attribute is
// honored, and a non-scalar bucketing value fails the whole rule.
export const rollouts = {
  async test(_ctrl, env) {
    const inRollout = await env.FLAGS.getStringDetails('rollout-100', 'x');
    assert.strictEqual(inRollout.reason, 'SPLIT');
    assert.strictEqual(inRollout.value, 'in');

    const outRollout = await env.FLAGS.getStringDetails('rollout-0', 'x');
    assert.strictEqual(outRollout.reason, 'DEFAULT');
    assert.strictEqual(outRollout.value, 'out');

    // Custom bucketing attribute + missing value → random bucket; at 100%
    // any bucket passes.
    const custom = await env.FLAGS.getStringDetails('rollout-attr', 'x', {
      userId: 'u-1',
    });
    assert.strictEqual(custom.reason, 'SPLIT');
    const missing = await env.FLAGS.getStringDetails('rollout-attr', 'x');
    assert.strictEqual(missing.reason, 'SPLIT');

    // Array bucketing value → rule fails entirely → default variant.
    const arr = await env.FLAGS.getStringDetails('rollout-attr', 'x', {
      userId: ['u-1'],
    });
    assert.strictEqual(arr.reason, 'DEFAULT');
  },
};

// Sticky bucketing: same scalar value lands in the same bucket.
export const stickyBuckets = {
  async test(_ctrl, env) {
    const flag = 'rollout-attr';
    const ctx = { userId: 'stable-id-7' };
    const a = await env.FLAGS.get(flag, 'x', ctx);
    const b = await env.FLAGS.get(flag, 'x', ctx);
    assert.strictEqual(a, b);
  },
};

// Dot-path traversal + literal top-level key precedence + >5 segments.
export const attributePaths = {
  async test(_ctrl, env) {
    assert.strictEqual(
      await env.FLAGS.getBooleanValue('nested-path', false, {
        profile: { plan: 'ent' },
      }),
      true
    );
    assert.strictEqual(
      await env.FLAGS.getBooleanValue('nested-path', false, {
        profile: { plan: 'free' },
      }),
      false
    );

    // Literal "a.b" key beats nested {a: {b}}.
    assert.strictEqual(
      await env.FLAGS.getBooleanValue('literal-key', false, { 'a.b': 'lit' }),
      true
    );
    assert.strictEqual(
      await env.FLAGS.getBooleanValue('literal-key', false, {
        a: { b: 'lit' },
      }),
      true
    );
    assert.strictEqual(
      await env.FLAGS.getBooleanValue('literal-key', false, {
        'a.b': 'lit',
        a: { b: 'nope' },
      }),
      true
    );
  },
};

// Operator spot-checks across the documented set.
export const operators = {
  async test(_ctrl, env) {
    assert.strictEqual(
      await env.FLAGS.getBooleanValue('num-gt', false, { age: 21 }),
      true
    );
    assert.strictEqual(
      await env.FLAGS.getBooleanValue('num-gt', false, { age: 17 }),
      false
    );
    // ISO 8601 datetime comparison.
    assert.strictEqual(
      await env.FLAGS.getBooleanValue('date-gt', false, {
        since: '2026-02-01T00:00:00Z',
      }),
      true
    );
    assert.strictEqual(
      await env.FLAGS.getBooleanValue('date-gt', false, {
        since: '2025-02-01T00:00:00Z',
      }),
      false
    );
    assert.strictEqual(
      await env.FLAGS.getBooleanValue('in-op', false, { plan: 'biz' }),
      true
    );
    assert.strictEqual(
      await env.FLAGS.getBooleanValue('in-op', false, { plan: 'free' }),
      false
    );
    assert.strictEqual(
      await env.FLAGS.getBooleanValue('has-op', false, { tags: ['vip'] }),
      true
    );
    assert.strictEqual(
      await env.FLAGS.getBooleanValue('has-op', false, { tags: ['regular'] }),
      false
    );
    assert.strictEqual(
      await env.FLAGS.getBooleanValue('contains-op', false, {
        email: 'a@corp.com',
      }),
      true
    );
    assert.strictEqual(
      await env.FLAGS.getBooleanValue('contains-op', false, {
        email: 'a@other.com',
      }),
      false
    );
  },
};

// Missing attributes never match — even negative operators. Null attributes
// only match not_equals / not_in.
export const missingAndNullAttributes = {
  async test(_ctrl, env) {
    // `plan-gated` (equals) and `has-op`/`in-op` all miss with no context.
    assert.strictEqual(await env.FLAGS.getBooleanValue('has-op', false), false);
    assert.strictEqual(await env.FLAGS.getBooleanValue('in-op', false), false);

    // A flag whose rule misses on an absent attribute falls through to
    // the default variant.
    const miss = await env.FLAGS.getBooleanDetails('has-op', true, {});
    assert.strictEqual(miss.reason, 'DEFAULT');

    // Null attributes match not_equals / not_in only: NEG has a
    // not_equals rule on `x`, so null matches but a missing `x` does not.
    const nullCtx = await env.NEG.getBooleanDetails('f', false, {
      x: null,
    });
    assert.strictEqual(nullCtx.reason, 'TARGETING_MATCH');
    const missCtx = await env.NEG.getBooleanDetails('f', false, {});
    assert.strictEqual(missCtx.reason, 'DEFAULT');
  },
};

// Nested all/any condition groups.
export const conditionGroups = {
  async test(_ctrl, env) {
    assert.strictEqual(
      await env.FLAGS.getBooleanValue('grouped', false, {
        plan: 'ent',
        region: 'eu',
      }),
      true
    );
    assert.strictEqual(
      await env.FLAGS.getBooleanValue('grouped', false, {
        plan: 'ent',
        region: 'ap',
      }),
      false
    );
    assert.strictEqual(
      await env.FLAGS.getBooleanValue('grouped', false, {
        plan: 'free',
        region: 'us',
      }),
      false
    );
  },
};

// Context validation: non-finite numbers, cycles, non-object context and
// Date normalization.
export const contextValidation = {
  async test(_ctrl, env) {
    const nan = await env.FLAGS.getBooleanDetails('simple-bool', true, {
      x: NaN,
    });
    assert.strictEqual(nan.errorCode, 'INVALID_CONTEXT');
    assert.strictEqual(nan.value, true);

    const cyclic = {};
    cyclic.self = cyclic;
    const cyc = await env.FLAGS.getBooleanDetails('simple-bool', true, cyclic);
    assert.strictEqual(cyc.errorCode, 'INVALID_CONTEXT');

    const arr = await env.FLAGS.getBooleanDetails('simple-bool', true, [1, 2]);
    assert.strictEqual(arr.errorCode, 'INVALID_CONTEXT');

    // Dates normalize to ISO strings — match a date-aware rule via the
    // string the binding normalized to.
    const d = await env.FLAGS.getBooleanDetails('date-gt', false, {
      since: new Date('2026-03-01T00:00:00Z'),
    });
    assert.strictEqual(d.value, true);
    assert.strictEqual(d.reason, 'TARGETING_MATCH');
  },
};

// An empty app evaluates every key to the supplied default — the same
// behavior an unconfigured/broken app would degrade to.
export const emptyApp = {
  async test(_ctrl, env) {
    assert.strictEqual(await env.EMPTY.getBooleanValue('x', true), true);
    const d = await env.EMPTY.getStringDetails('x', 'd');
    assert.strictEqual(d.errorCode, 'FLAG_NOT_FOUND');
  },
};
