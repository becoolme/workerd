// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

#include "vrt-limits.h"

#include <workerd/util/exception.h>

#include <kj/test.h>

namespace workerd {
namespace {

KJ_TEST("vrt limits: zero means unlimited") {
  VrtWorkerLimits none;
  KJ_EXPECT(!none.any());
  KJ_EXPECT(!none.hasInvocationLimits());

  KJ_EXPECT(VrtWorkerLimits{.cpuMs = 5}.hasInvocationLimits());
  KJ_EXPECT(VrtWorkerLimits{.subRequests = 5}.hasInvocationLimits());
  KJ_EXPECT(VrtWorkerLimits{.memoryMb = 5}.any());
  KJ_EXPECT(!(VrtWorkerLimits{.memoryMb = 5}.hasInvocationLimits()));
}

KJ_TEST("vrt limits: memory budget bytes") {
  KJ_EXPECT(vrtMemoryLimitBytes(0) == 0);
  KJ_EXPECT(vrtMemoryLimitBytes(1) == 1024 * 1024);
  KJ_EXPECT(vrtMemoryLimitBytes(128) == 128ull * 1024 * 1024);
  // The largest accepted config value (64 GiB) must not overflow.
  KJ_EXPECT(vrtMemoryLimitBytes(65'536) == 65'536ull * 1024 * 1024);
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

}  // namespace
}  // namespace workerd
