// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
import assert from 'node:assert';
import { DurableObject } from 'cloudflare:workers';

// Tests for the resource-limit semantics Cloudflare documents for dynamic Workers
// (`WorkerCode.limits`, `getEntrypoint`/`getDurableObjectClass` `options.limits`):
// the lower of the call-site limits and the Worker's own applies per invocation, and the
// loading Worker's `limits` group is the ceiling `code.limits` may tighten but never exceed.
// The test worker itself runs under `limits = (memoryMb = 96)`.

const CPU_EXCEEDED = 'Worker exceeded CPU time limit.';
const MEMORY_EXCEEDED = 'Worker has exceeded memory limit.';
const TOO_MANY_SUBREQUESTS = 'Too many subrequests.';

// A worker that burns CPU in a counted loop (long enough that any small cpuMs budget trips,
// deterministic under a frozen test clock) or answers pings.
const SPIN_CHILD = `
  import {WorkerEntrypoint} from "cloudflare:workers";
  export default class extends WorkerEntrypoint {
    spin() {
      let x = 0;
      for (let i = 0; i < 1e9; i++) {
        x += i % 7;
      }
      return "spun " + x;
    }
    ping() { return "pong"; }
  }
`;

// A worker whose fetch handler makes three global fetches, recording each outcome. The
// test worker's `globalOutbound` loops those fetches back to `echoOutbound` below, so each
// is a billable subrequest of the dynamic Worker's invocation.
const FETCH_CHILD = `
  export default {
    async fetch(req) {
      let results = [];
      for (let i = 0; i < 3; i++) {
        try {
          let resp = await fetch("https://example.com/" + i);
          results.push(await resp.text());
        } catch (e) {
          results.push(e.message);
        }
      }
      return new Response(results.join("|"));
    },
  }
`;

// A worker that grows its V8 heap in 1 MiB chunks until it has ~300 MiB, well over the
// parent's 96 MiB ceiling.
const HOG_CHILD = `
  export default {
    async fetch() {
      let chunks = [];
      for (let i = 0; i < 300; i++) {
        chunks.push(new Array(131072).fill(i));
      }
      return new Response("kept " + chunks.length);
    },
  }
`;

// A worker exporting a Durable Object class, instantiated below as a facet of FacetHost
// through `getDurableObjectClass`.
const DO_CHILD = `
  import {DurableObject} from "cloudflare:workers";
  export class Counter extends DurableObject {
    i = 0;
    ping() { return "pong"; }
    spin() {
      let x = 0;
      for (let i = 0; i < 1e9; i++) {
        x += i % 7;
      }
      return "spun " + x;
    }
    async fetches() {
      let results = [];
      for (let i = 0; i < 3; i++) {
        try {
          let resp = await fetch("https://example.com/" + i);
          results.push(await resp.text());
        } catch (e) {
          results.push(e.message);
        }
      }
      return results.join("|");
    }
  }
`;

function makeCode(overrides) {
  return {
    compatibilityDate: '2025-01-01',
    mainModule: 'main.js',
    modules: { 'main.js': SPIN_CHILD },
    ...overrides,
  };
}

// The fetch target the test worker's `globalOutbound` loops back to.
export let echoOutbound = {
  async fetch(req) {
    return new Response('echo:' + new URL(req.url).pathname);
  },
};

// The Durable Object that instantiates a dynamically loaded class as a facet. `ctx.facets`
// exists only on an actor's context, so `getDurableObjectClass` is exercised from here. The
// loaded Worker inherits this worker's `globalOutbound`, which loops its `fetch()` calls
// back to `echoOutbound`.
export class FacetHost extends DurableObject {
  async callDynamic(name, options, method) {
    let worker = this.env.loader.get(name, () =>
      makeCode({ modules: { 'main.js': DO_CHILD } })
    );
    let cls = worker.getDurableObjectClass('Counter', options);
    let facet = this.ctx.facets.get(name, () => ({ class: cls }));
    return facet[method]();
  }
}

function overCpu(e) {
  return e instanceof Error && e.message.includes(CPU_EXCEEDED);
}
function overMemory(e) {
  return e instanceof Error && e.message.includes(MEMORY_EXCEEDED);
}

// `code.limits.cpuMs` bounds every invocation of the loaded Worker.
export let codeLimitsCpu = {
  async test(ctrl, env, ctx) {
    let worker = env.loader.get('codeLimitsCpu', () =>
      makeCode({ limits: { cpuMs: 50 } })
    );
    await assert.rejects(worker.getEntrypoint().spin(), overCpu);
  },
};

// `code.limits.subRequests` bounds the subrequests of one invocation.
export let codeLimitsSubRequests = {
  async test(ctrl, env, ctx) {
    let worker = env.loader.get('codeLimitsSubRequests', () =>
      makeCode({
        modules: { 'main.js': FETCH_CHILD },
        limits: { subRequests: 1 },
        globalOutbound: ctx.exports.echoOutbound,
      })
    );
    let resp = await worker.getEntrypoint().fetch('https://example.com');
    assert.strictEqual(
      await resp.text(),
      `echo:/0|${TOO_MANY_SUBREQUESTS}|${TOO_MANY_SUBREQUESTS}`
    );
  },
};

// `getEntrypoint(name, {limits})` bounds only invocations made through that entrypoint.
export let entrypointLimitsCpu = {
  async test(ctrl, env, ctx) {
    let limited = env.loader.get('entrypointLimitsCpu', () => makeCode());
    await assert.rejects(
      limited.getEntrypoint('default', { limits: { cpuMs: 50 } }).spin(),
      overCpu
    );

    // The same options on an invocation of a different Worker stay per-invocation: a Worker
    // loaded without limits runs to completion.
    let unbounded = env.loader.get('entrypointNoLimits', () => makeCode());
    assert.strictEqual(await unbounded.getEntrypoint().ping(), 'pong');
  },
};

// `getEntrypoint(name, {limits})` can only lower the Worker's own `code.limits`, per the
// documented "the lower of the two limits is used".
export let lowerOfTwoLimits = {
  async test(ctrl, env, ctx) {
    // The call site's limit is the lower one.
    let optionWins = env.loader.get('lowerOptionWins', () =>
      makeCode({
        modules: { 'main.js': FETCH_CHILD },
        limits: { subRequests: 5 },
        globalOutbound: ctx.exports.echoOutbound,
      })
    );
    let resp = await optionWins
      .getEntrypoint('default', { limits: { subRequests: 2 } })
      .fetch('https://example.com');
    assert.strictEqual(
      await resp.text(),
      `echo:/0|echo:/1|${TOO_MANY_SUBREQUESTS}`
    );

    // The Worker's own limit is the lower one.
    let codeWins = env.loader.get('lowerCodeWins', () =>
      makeCode({
        modules: { 'main.js': FETCH_CHILD },
        limits: { subRequests: 1 },
        globalOutbound: ctx.exports.echoOutbound,
      })
    );
    resp = await codeWins
      .getEntrypoint('default', { limits: { subRequests: 5 } })
      .fetch('https://example.com');
    assert.strictEqual(
      await resp.text(),
      `echo:/0|${TOO_MANY_SUBREQUESTS}|${TOO_MANY_SUBREQUESTS}`
    );
  },
};

// `getDurableObjectClass(name, {limits})` applies to requests on the returned class.
export let doClassLimits = {
  async test(ctrl, env, ctx) {
    let id = ctx.exports.FacetHost.idFromName('limits');
    let host = ctx.exports.FacetHost.get(id);

    await assert.rejects(
      host.callDynamic('doCpuLimited', { limits: { cpuMs: 50 } }, 'spin'),
      overCpu
    );

    // Subrequest budgets on the class bound its actor's calls too.
    let results = await host.callDynamic(
      'doSubreqLimited',
      { limits: { subRequests: 2 } },
      'fetches'
    );
    assert.strictEqual(results, `echo:/0|echo:/1|${TOO_MANY_SUBREQUESTS}`);
  },
};

// The loading Worker's `limits` group is the ceiling: a dynamic Worker that asks for no
// limit still inherits it, and `ResourceLimits` has no memory dimension to argue with.
// The parent's 96 MiB cap turns a ~300 MiB hog into an exceeded-memory error.
export let parentCeiling = {
  async test(ctrl, env, ctx) {
    let worker = env.loader.get('parentCeiling', () =>
      makeCode({ modules: { 'main.js': HOG_CHILD } })
    );
    await assert.rejects(
      worker.getEntrypoint().fetch('https://example.com'),
      overMemory
    );
  },
};

// A Worker loaded under a ceiling but with tight `code.limits` is still governed by the
// lower of the two.
export let codeLimitsUnderCeiling = {
  async test(ctrl, env, ctx) {
    let worker = env.loader.get('codeLimitsUnderCeiling', () =>
      makeCode({
        modules: { 'main.js': FETCH_CHILD },
        limits: { cpuMs: 0, subRequests: 1 },
        globalOutbound: ctx.exports.echoOutbound,
      })
    );
    let resp = await worker.getEntrypoint().fetch('https://example.com');
    assert.strictEqual(
      await resp.text(),
      `echo:/0|${TOO_MANY_SUBREQUESTS}|${TOO_MANY_SUBREQUESTS}`
    );
  },
};
