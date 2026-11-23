// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

#include "vrt-limits.h"

#include <workerd/util/exception.h>

#include <kj/async.h>
#include <kj/test.h>

namespace workerd {
namespace {

KJ_TEST("vrt limits: zero means unlimited") {
  VrtWorkerLimits none;
  KJ_EXPECT(!none.any());
  KJ_EXPECT(!none.hasInvocationLimits());

  KJ_EXPECT(VrtWorkerLimits{.cpuMs = 5}.hasInvocationLimits());
  KJ_EXPECT(VrtWorkerLimits{.subRequests = 5}.hasInvocationLimits());
  KJ_EXPECT(VrtWorkerLimits{.outboundConnections = 5}.hasInvocationLimits());
  KJ_EXPECT(VrtWorkerLimits{.memoryMb = 5}.any());
  KJ_EXPECT(VrtWorkerLimits{.outboundConnections = 5}.any());
  KJ_EXPECT(!(VrtWorkerLimits{.memoryMb = 5}.hasInvocationLimits()));
}

KJ_TEST("vrt limits: nested limits take the lower of the two") {
  // A set dimension wins over 0 (unlimited); otherwise the smaller one wins.
  auto withConnections = VrtWorkerLimits{.outboundConnections = 6};
  KJ_EXPECT(vrtLowerOf(VrtWorkerLimits{}, withConnections).outboundConnections == 6);
  KJ_EXPECT(vrtLowerOf(withConnections, VrtWorkerLimits{}).outboundConnections == 6);
  KJ_EXPECT(vrtLowerOf(withConnections, VrtWorkerLimits{.outboundConnections = 4})
                .outboundConnections == 4);
  KJ_EXPECT(vrtLowerOf(VrtWorkerLimits{.outboundConnections = 4}, withConnections)
                .outboundConnections == 4);
}

KJ_TEST("vrt limits: memory budget bytes") {
  KJ_EXPECT(vrtMemoryLimitBytes(0) == 0);
  KJ_EXPECT(vrtMemoryLimitBytes(1) == 1024 * 1024);
  KJ_EXPECT(vrtMemoryLimitBytes(128) == 128ull * 1024 * 1024);
  // The largest accepted config value (64 GiB) must not overflow.
  KJ_EXPECT(vrtMemoryLimitBytes(65'536) == 65'536ull * 1024 * 1024);
}

KJ_TEST("vrt limits: memory budget counts external memory") {
  const uint64_t budget = vrtMemoryLimitBytes(100);

  // 0 is unlimited, whatever the isolate is holding.
  KJ_EXPECT(!vrtMemoryBudgetExceeded(0, budget * 10, budget * 10));

  // The JavaScript heap alone can exceed the budget.
  KJ_EXPECT(!vrtMemoryBudgetExceeded(100, budget - 1024, 0));
  KJ_EXPECT(vrtMemoryBudgetExceeded(100, budget + 1, 0));

  // So can V8's external memory (ArrayBuffer backing stores) with a small heap.
  KJ_EXPECT(!vrtMemoryBudgetExceeded(100, budget / 4, budget / 4));
  KJ_EXPECT(vrtMemoryBudgetExceeded(100, budget / 4, budget));

  // The two are accounted together.
  KJ_EXPECT(!vrtMemoryBudgetExceeded(100, budget / 2, budget / 2));
  KJ_EXPECT(vrtMemoryBudgetExceeded(100, budget / 2, budget / 2 + 1));

  // Extreme sizes must not overflow into a false negative.
  KJ_EXPECT(vrtMemoryBudgetExceeded(1, kj::maxValue, kj::maxValue));
}

KJ_TEST("vrt limits: subrequest budget") {
  auto isolateState = kj::atomicRefcounted<VrtIsolateLimitState>();
  auto enforcer = kj::refcounted<VrtLimitEnforcer>(
      VrtWorkerLimits{.subRequests = 2}, kj::atomicAddRef(*isolateState));

  enforcer->newSubrequest(false);
  // In-house calls (KV, R2, actor storage) are exempt and are not counted.
  enforcer->newSubrequest(true);
  enforcer->newSubrequest(true);
  enforcer->newSubrequest(false);
  KJ_EXPECT_THROW_MESSAGE("Too many subrequests.", enforcer->newSubrequest(false));
}

KJ_TEST("vrt limits: no subrequest budget means no counting") {
  auto isolateState = kj::atomicRefcounted<VrtIsolateLimitState>();
  auto enforcer = kj::refcounted<VrtLimitEnforcer>(VrtWorkerLimits{}, kj::atomicAddRef(*isolateState));
  for (uint i = 0; i < 1000; ++i) {
    enforcer->newSubrequest(false);
  }
}

KJ_TEST("vrt limits: cpu violation maps to EXCEEDED_CPU") {
  auto isolateState = kj::atomicRefcounted<VrtIsolateLimitState>();
  auto invocation = kj::atomicRefcounted<VrtInvocationLimitState>(kj::atomicAddRef(*isolateState));

  KJ_EXPECT(invocation->getLimitsExceeded() == kj::none);
  KJ_EXPECT(invocation->getException() == kj::none);

  // `false`: nothing is running JS, so no V8 termination is requested.
  invocation->markCpuExceeded(false);

  KJ_IF_SOME(outcome, invocation->getLimitsExceeded()) {
    KJ_EXPECT(outcome == EventOutcome::EXCEEDED_CPU);
  } else {
    KJ_FAIL_EXPECT("expected an exceeded limit");
  }

  KJ_IF_SOME(e, invocation->getException()) {
    KJ_EXPECT(e.getDescription().contains("Worker exceeded CPU time limit"));
    KJ_EXPECT(e.getDetail(CPU_LIMIT_DETAIL_ID) != kj::none);
  } else {
    KJ_FAIL_EXPECT("expected a limit exception");
  }
}

KJ_TEST("vrt limits: memory violation maps to EXCEEDED_MEMORY") {
  auto isolateState = kj::atomicRefcounted<VrtIsolateLimitState>();
  auto invocation = kj::atomicRefcounted<VrtInvocationLimitState>(kj::atomicAddRef(*isolateState));

  invocation->markMemoryExceeded(false);
  KJ_EXPECT(isolateState->hasExcessivelyExceededHeapLimit() == false);

  KJ_IF_SOME(outcome, invocation->getLimitsExceeded()) {
    KJ_EXPECT(outcome == EventOutcome::EXCEEDED_MEMORY);
  } else {
    KJ_FAIL_EXPECT("expected an exceeded limit");
  }

  KJ_IF_SOME(e, invocation->getException()) {
    KJ_EXPECT(e.getDescription().contains("Worker has exceeded memory limit"));
    KJ_EXPECT(e.getDetail(MEMORY_LIMIT_DETAIL_ID) != kj::none);
  } else {
    KJ_FAIL_EXPECT("expected a limit exception");
  }
}

KJ_TEST("vrt limits: actor top-up starts a new budget") {
  auto isolateState = kj::atomicRefcounted<VrtIsolateLimitState>();
  auto enforcer =
      kj::refcounted<VrtLimitEnforcer>(VrtWorkerLimits{.subRequests = 1}, kj::atomicAddRef(*isolateState));
  enforcer->newSubrequest(false);
  enforcer->topUpActor();
  enforcer->newSubrequest(false);
}

KJ_TEST("vrt limits: startup budget is Cloudflare's one second") {
  // Fixed by design: this mirrors the platform limit rather than the Worker's own configuration.
  KJ_EXPECT(VRT_STARTUP_CPU_BUDGET == 1000 * kj::MILLISECONDS);
}

KJ_TEST("vrt limits: startup violation maps to EXCEEDED_CPU") {
  auto e = vrtStartupCpuLimitException();
  KJ_EXPECT(e.getDescription().contains("Script startup exceeded CPU time limit"));
  // The detail id is what turns the failure into Cloudflare's exceeded-CPU outcome (1102) where
  // the platform reports it, exactly as for a per-invocation overrun.
  KJ_EXPECT(e.getDetail(CPU_LIMIT_DETAIL_ID) != kj::none);
}

KJ_TEST("vrt limits: limit terminations are counted and consumed") {
  auto isolateState = kj::atomicRefcounted<VrtIsolateLimitState>();
  KJ_EXPECT(!isolateState->hasPendingLimitTermination());
  KJ_EXPECT(!isolateState->consumeLimitTermination());

  isolateState->noteLimitTermination();
  isolateState->noteLimitTermination();
  KJ_EXPECT(isolateState->hasPendingLimitTermination());

  KJ_EXPECT(isolateState->consumeLimitTermination());
  KJ_EXPECT(isolateState->consumeLimitTermination());
  KJ_EXPECT(!isolateState->consumeLimitTermination());
}

KJ_TEST("vrt limits: connections past the limit wait for a free slot") {
  kj::EventLoop loop;
  kj::WaitScope ws(loop);

  auto slots = kj::atomicRefcounted<VrtOutboundConnections>(2);

  // The first two acquisitions are served immediately, up to the limit.
  auto first = slots->acquire().wait(ws);
  auto second = slots->acquire().wait(ws);

  auto third = slots->acquire();
  KJ_EXPECT(!third.poll(ws));

  // Releasing one connection hands its slot to the waiting request instead of dropping it.
  second = nullptr;
  KJ_EXPECT(third.poll(ws));
  auto thirdLease = third.wait(ws);

  KJ_EXPECT(first.get() != nullptr);
  KJ_EXPECT(thirdLease.get() != nullptr);
}

KJ_TEST("vrt limits: queued connections are served in arrival order") {
  kj::EventLoop loop;
  kj::WaitScope ws(loop);

  auto slots = kj::atomicRefcounted<VrtOutboundConnections>(1);
  auto first = slots->acquire().wait(ws);

  auto second = slots->acquire();
  auto third = slots->acquire();
  KJ_EXPECT(!second.poll(ws));
  KJ_EXPECT(!third.poll(ws));

  first = nullptr;
  KJ_EXPECT(second.poll(ws));
  // The slot went to the oldest waiter, not to both.
  KJ_EXPECT(!third.poll(ws));

  auto secondLease = second.wait(ws);
  secondLease = nullptr;
  KJ_EXPECT(third.poll(ws));
  auto thirdLease = third.wait(ws);
  KJ_EXPECT(thirdLease.get() != nullptr);
}

KJ_TEST("vrt limits: a cancelled queued connection gives up its place") {
  kj::EventLoop loop;
  kj::WaitScope ws(loop);

  auto slots = kj::atomicRefcounted<VrtOutboundConnections>(1);
  auto held = slots->acquire().wait(ws);

  {
    // Queued, then dropped before a slot was free: the request is gone, so it must not keep a
    // place in line (a slot handed to it would never be released).
    auto abandoned = slots->acquire();
    KJ_EXPECT(!abandoned.poll(ws));
  }

  auto next = slots->acquire();
  KJ_EXPECT(!next.poll(ws));

  held = nullptr;
  KJ_EXPECT(next.poll(ws));
  auto nextLease = next.wait(ws);
  KJ_EXPECT(nextLease.get() != nullptr);
}

KJ_TEST("vrt limits: only external subrequests take a connection slot") {
  kj::EventLoop loop;
  kj::WaitScope ws(loop);

  auto isolateState = kj::atomicRefcounted<VrtIsolateLimitState>();

  // Without the dimension the enforcer never limits concurrency.
  auto unlimited =
      kj::refcounted<VrtLimitEnforcer>(VrtWorkerLimits{}, kj::atomicAddRef(*isolateState));
  KJ_EXPECT(unlimited->newOutboundConnection(false) == kj::none);

  auto limited = kj::refcounted<VrtLimitEnforcer>(
      VrtWorkerLimits{.outboundConnections = 1}, kj::atomicAddRef(*isolateState));
  // In-house calls (KV, R2, actor storage, ...) open no outbound connection.
  KJ_EXPECT(limited->newOutboundConnection(true) == kj::none);

  auto firstSlot = limited->newOutboundConnection(false);
  KJ_IF_SOME(promise, firstSlot) {
    auto lease = promise.wait(ws);
    KJ_EXPECT(lease.get() != nullptr);
    // The single slot is taken now, so the next external subrequest has to queue.
    auto secondSlot = limited->newOutboundConnection(false);
    KJ_IF_SOME(queued, secondSlot) {
      KJ_EXPECT(!queued.poll(ws));
    } else {
      KJ_FAIL_EXPECT("expected a queued connection slot");
    }
  } else {
    KJ_FAIL_EXPECT("expected a connection slot");
  }
}

}  // namespace
}  // namespace workerd
