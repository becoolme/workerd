// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import assert from 'node:assert';

function code() {
  return {
    compatibilityDate: '2025-01-01',
    mainModule: 'main.js',
    modules: {
      'main.js': `export default { fetch() { return new Response('ok'); } }`,
    },
  };
}

// Distinct names under one loader each take a live-worker slot; `maxWorkers`
// bounds them, while a name already loaded is reused without taking another.
export let namedWorkersCountAgainstMaxWorkers = {
  async test(ctrl, env) {
    env.two.get('a', () => code());
    env.two.get('b', () => code());
    assert.throws(() => env.two.get('c', () => code()), /limit of 2 live workers/);

    // 'a' resolves from the cache: the callback must not run and no slot is taken.
    let again = env.two.get('a', () => {
      throw new Error('the load callback must not run for a cached name');
    });
    let res = await again.getEntrypoint().fetch('http://x/');
    assert.strictEqual(await res.text(), 'ok');
  },
};

// `load()` workers take slots too: a named worker already live leaves no room.
export let unnamedLoadsCountAgainstMaxWorkers = {
  async test(ctrl, env) {
    env.one.get('x', () => code());
    assert.throws(() => env.one.load(code()), /limit of 1 live workers/);
  },
};

// A worker's slot returns when its last handle is collected, so the loader can
// load again. The stub's channel teardown is deferred one event-loop turn past
// GC, which the two task turns below wait out.
export let releasedHandlesFreeSlots = {
  async test(ctrl, env) {
    let stub = env.one.load(code());
    let res = await stub.getEntrypoint().fetch('http://x/');
    assert.strictEqual(await res.text(), 'ok');
    assert.throws(() => env.one.get('y', () => code()), /limit of 1 live workers/);

    stub = null;
    gc();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    let y = env.one.get('y', () => code());
    res = await y.getEntrypoint().fetch('http://x/');
    assert.strictEqual(await res.text(), 'ok');
  },
};
