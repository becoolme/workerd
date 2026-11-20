// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

#pragma once

// Per-Worker resource limits for statically configured Workers (the VRT fork's `limits` group in
// `workerd.capnp`).
//
// workerd's standalone server ships `NullIsolateLimitEnforcer` / `NullLimitEnforcer`, so a config
// Worker runs unbounded. This module implements the same interfaces for one Worker:
//
// - CPU: a per-invocation budget accumulated from the thread CPU clock across `enterJs()`
//   scopes. A process-global watchdog samples the JS thread's CPU every 5 ms and terminates the
//   isolate through V8 once the budget is spent, so IoContext reports `EXCEEDED_CPU` and the
//   exception carries `CPU_LIMIT_DETAIL_ID`.
// - Memory: a per-isolate V8 JavaScript heap limit, plus a near-heap-limit callback that
//   blames the running invocation and terminates it instead of letting V8 abort the process.
// - Subrequests: a per-invocation count checked before each outbound subrequest, throwing
//   `Error: Too many subrequests.` before the request has any effect.
//
// Zero always means "unlimited". A Worker with every dimension at zero keeps the `Null*`
// enforcers and behaves exactly as an unmodified workerd.
//
// Everything here is standalone-server policy, deliberately kept out of the shared I/O core: the
// shared code only calls the generic `LimitEnforcer` / `IsolateLimitEnforcer` hooks.

#include <workerd/io/limit-enforcer.h>
#include <workerd/io/outcome.capnp.h>
#include <workerd/io/tracked-wasm-instance.h>

#include <v8-isolate.h>

#include <kj/memory.h>
#include <kj/mutex.h>
#include <kj/refcount.h>
#include <kj/thread.h>
#include <kj/time.h>
#include <kj/vector.h>

#include <atomic>
#include <cstdint>

namespace workerd {

namespace jsg {
class IsolateLiveness;
}  // namespace jsg

// The `limits` group of a config Worker. 0 means the dimension is unlimited.
struct VrtWorkerLimits {
  uint32_t cpuMs = 0;
  uint32_t memoryMb = 0;
  uint32_t subRequests = 0;

  // Whether a per-invocation `LimitEnforcer` is needed (CPU or subrequests).
  bool hasInvocationLimits() const {
    return cpuMs != 0 || subRequests != 0;
  }

  // Whether any limit is configured. When false the Worker keeps the `Null*` enforcers.
  bool any() const {
    return cpuMs != 0 || memoryMb != 0 || subRequests != 0;
  }
};

// The documented merge for a nested limit ("the lower of the two limits is used"): a set
// dimension wins over 0 (unlimited), the smaller set value wins otherwise.
constexpr uint32_t vrtLowerOf(uint32_t a, uint32_t b) {
  return a == 0 ? b : b == 0 ? a : (a < b ? a : b);
}

constexpr VrtWorkerLimits vrtLowerOf(VrtWorkerLimits a, VrtWorkerLimits b) {
  return {.cpuMs = vrtLowerOf(a.cpuMs, b.cpuMs),
    .memoryMb = vrtLowerOf(a.memoryMb, b.memoryMb),
    .subRequests = vrtLowerOf(a.subRequests, b.subRequests)};
}

// The memory budget in bytes, 0 when unlimited. Cannot overflow: `memoryMb` is 32 bits.
uint64_t vrtMemoryLimitBytes(uint32_t memoryMb);

// The stable exceptions Cloudflare's embedder throws for these limits. Both are `Error`s carrying
// the detail id that turns a termination into the matching `EventOutcome`.
kj::Exception vrtCpuLimitException();
kj::Exception vrtMemoryLimitException();

class VrtInvocationLimitState;

// The isolate-level state one isolate shares with its invocations.
//
// The isolate enforcer owns it along with the isolate; every request enforcer holds a reference.
// `currentInvocation` is only read and written while the isolate lock is held (the heap callback
// runs on the allocating JS thread), so a raw pointer is enough there. The termination counter is
// atomic because the watchdog thread increments it.
class VrtIsolateLimitState final: public kj::AtomicRefcounted {
 public:
  VrtIsolateLimitState();
  // Out of line: the liveness type is only forward-declared here.
  ~VrtIsolateLimitState() noexcept(false);

  // Called once from the isolate enforcer's `customizeIsolate()`. The liveness object outlives
  // the isolate and reports it dead once V8 tears it down, so the watchdog can hold it safely.
  void setIsolateLiveness(kj::Arc<const jsg::IsolateLiveness> liveness);

  // Thread-safe: requests V8 termination of the isolate, a no-op once the isolate is gone.
  void terminateIsolate();

  // Records that a termination was requested for a limit, so a turn that catches a termination
  // can attribute it even when its own invocation is not the one that overran.
  void noteLimitTermination();
  bool hasPendingLimitTermination() const;
  // Consumes one outstanding limit termination, if any. Returns whether one was outstanding.
  bool consumeLimitTermination();

  // Drops any outstanding termination and cancels the V8 termination flag. Called before running
  // JS, when no JS is executing, so a termination requested for a turn that already ended cannot
  // kill the next one.
  void cancelPendingLimitTerminations();

  // The invocation whose JS turn is running, or null between turns.
  void setCurrentInvocation(VrtInvocationLimitState& invocation);
  void clearCurrentInvocation(VrtInvocationLimitState& invocation);

  // Called by the near-heap-limit callback: flags the heap, blames the running invocation if
  // any, and terminates the isolate.
  void condemnMemory(v8::Isolate* isolate);

  bool hasExcessivelyExceededHeapLimit() const {
    return heapLimitHit.load(std::memory_order_relaxed);
  }
  void clearHeapLimit() {
    heapLimitHit.store(false, std::memory_order_relaxed);
  }

 private:
  kj::MutexGuarded<kj::Maybe<kj::Arc<const jsg::IsolateLiveness>>> liveness;
  std::atomic<VrtInvocationLimitState*> currentInvocation{nullptr};
  std::atomic<bool> heapLimitHit{false};
  std::atomic<uint32_t> pendingLimitTerminations{0};
};

// The per-invocation accounting (one IoContext) shared with the watchdog.
class VrtInvocationLimitState final: public kj::AtomicRefcounted {
 public:
  explicit VrtInvocationLimitState(kj::Own<VrtIsolateLimitState> isolateState)
      : isolateState(kj::mv(isolateState)) {}

  // Marks the invocation as over its CPU budget. `requestTermination` is false when the budget
  // ran out between turns, where terminating would leave V8's flag set for the next turn.
  void markCpuExceeded(bool requestTermination);
  void markMemoryExceeded(bool requestTermination);

  bool cpuExceeded() const {
    return cpuExceededFlag.load(std::memory_order_relaxed);
  }
  bool memoryExceeded() const {
    return memoryExceededFlag.load(std::memory_order_relaxed);
  }

  // The outcome to report, or none when this invocation has not exceeded a limit.
  kj::Maybe<EventOutcome> getLimitsExceeded() const;
  // The stable exception for the violation, or none.
  kj::Maybe<kj::Exception> getException() const;

  // Starts a new budget (actor event admission).
  void reset();

 private:
  kj::Own<VrtIsolateLimitState> isolateState;
  std::atomic<bool> cpuExceededFlag{false};
  std::atomic<bool> memoryExceededFlag{false};
};

// Samples the CPU clock of every thread running limited JavaScript and terminates the isolates of
// invocations that have spent their budget.
//
// The sampling thread does no KJ I/O and takes no isolate lock: it only reads a thread CPU clock
// and calls V8's thread-safe `TerminateExecution()`.
class VrtLimitWatchdog final {
 public:
  // The sampling cadence; the worst-case overshoot of a CPU budget. Not tunable.
  static constexpr kj::Duration SAMPLE_INTERVAL = 5 * kj::MILLISECONDS;

  // The process-global watchdog. Never destroyed: it may outlive static destructors.
  static VrtLimitWatchdog& instance();

  // Whether thread CPU accounting is available on this platform (`cpuMs` fails closed otherwise).
  static bool isSupported();

  // CPU time consumed by the calling thread so far, or none when unavailable.
  static kj::Maybe<kj::Duration> currentThreadCpu();

  struct Token {
    uint64_t epoch = 0;
    uint64_t threadHandle = 0;
    bool valid = false;
  };

  // Registers one JS turn of `invocation` on the calling thread. `startCpu` and `remaining` come
  // from the caller's clock reading, so accounting and enforcement share one deadline.
  Token registerTurn(
      kj::Own<VrtInvocationLimitState> invocation, kj::Duration startCpu, kj::Duration remaining);

  // Unregisters the turn. Must be called on the thread that registered it.
  void finishTurn(const Token& token);

  // One sampling sweep, exposed so tests can drive it without a thread.
  void pollOnce();

  // `startThread` is false in tests; production uses the `instance()` watchdog.
  explicit VrtLimitWatchdog(bool startThread);
  ~VrtLimitWatchdog() noexcept(false);
  KJ_DISALLOW_COPY_AND_MOVE(VrtLimitWatchdog);

 private:
  struct Turn {
    uint64_t epoch;
    kj::Own<VrtInvocationLimitState> invocation;
    uint64_t threadHandle;
    kj::Duration deadline;
  };

  void loop();
  void ensureThreadStarted();

  const bool startThread;
  kj::MutexGuarded<kj::Vector<Turn>> turns;
  std::atomic<uint64_t> nextEpoch{1};
  std::atomic<bool> threadStarted{false};
  std::atomic<bool> stopThread{false};
  kj::Maybe<kj::Own<kj::Thread>> thread;
};

// The `LimitEnforcer` of one invocation of a limited Worker.
class VrtLimitEnforcer final: public LimitEnforcer, public kj::Refcounted {
 public:
  VrtLimitEnforcer(VrtWorkerLimits limits, kj::Own<VrtIsolateLimitState> isolateState);

  // ---------------------------------------------------------------------------
  // LimitEnforcer

  kj::Own<void> enterJs(jsg::Lock& lock, IoContext& context) override;
  void topUpActor() override;
  void newSubrequest(bool isInHouse) override;
  void newKvRequest(KvOpType) override {}
  void newAnalyticsEngineRequest() override {}
  kj::Promise<void> limitDrain() override;
  kj::Promise<void> limitScheduled() override;
  kj::Duration getAlarmLimit() override;
  size_t getBufferingLimit() override;
  kj::Maybe<EventOutcome> getLimitsExceeded() override;
  kj::Promise<void> onLimitsExceeded() override;
  void setCpuLimitNearlyExceededCallback(kj::Function<void()>) override {}
  void requireLimitsNotExceeded() override;
  void reportMetrics(RequestObserver&) override {}
  kj::Duration consumeTimeElapsedForPeriodicLogging() override {
    return 0 * kj::SECONDS;
  }
  size_t getSqliteMemoryUsage() const override {
    return 0;
  }

 private:
  // A nested class, so it can call the private endJs().
  class JsScope;

  // Throws this invocation's stable limit exception if it has exceeded one.
  void throwIfExceeded();
  // Bills the turn that just ended and clears the per-turn state.
  void endJs();
  kj::Duration cpuBudget() const;

  const VrtWorkerLimits limits;
  kj::Own<VrtIsolateLimitState> isolateState;
  kj::Own<VrtInvocationLimitState> invocation;

  // All below are touched only while the isolate lock is held, which serializes every turn of one
  // invocation (IoContext cannot switch threads, and only one thread locks an isolate at a time).
  kj::Duration cpuUsed = 0 * kj::SECONDS;
  uint32_t subrequestsUsed = 0;
  uint32_t jsScopeDepth = 0;
  kj::Maybe<kj::Duration> jsStart;
  kj::Maybe<VrtLimitWatchdog::Token> token;
};

// The `IsolateLimitEnforcer` of a Worker with at least one limit. Every dimension it does not
// implement keeps the same defaults the unlimited enforcer has.
class VrtIsolateLimitEnforcer final: public IsolateLimitEnforcer {
 public:
  VrtIsolateLimitEnforcer(uint32_t memoryMb, kj::Own<VrtIsolateLimitState> state);

  // ---------------------------------------------------------------------------
  // IsolateLimitEnforcer

  v8::Isolate::CreateParams getCreateParams() override;
  void customizeIsolate(v8::Isolate* isolate) override;
  ActorCacheSharedLruOptions getActorCacheLruOptions() override;
  kj::Own<void> enterStartupJs(
      jsg::Lock& lock, kj::OneOf<kj::Exception, kj::Duration>& limitErrorOrTime) const override;
  kj::Own<void> enterStartupPython(
      jsg::Lock& lock, kj::OneOf<kj::Exception, kj::Duration>& limitErrorOrTime) const override;
  kj::Own<void> enterDynamicImportJs(
      jsg::Lock& lock, kj::OneOf<kj::Exception, kj::Duration>& limitErrorOrTime) const override;
  kj::Own<void> enterLoggingJs(
      jsg::Lock& lock, kj::OneOf<kj::Exception, kj::Duration>& limitErrorOrTime) const override;
  kj::Own<void> enterInspectorJs(
      jsg::Lock& lock, kj::OneOf<kj::Exception, kj::Duration>& limitErrorOrTime) const override;
  void completedRequest(kj::StringPtr) const override {}
  bool exitJs(jsg::Lock& lock) const override;
  void reportMetrics(IsolateObserver&) const override {}
  kj::Maybe<size_t> checkPbkdfIterations(jsg::Lock&, size_t) const override {
    return kj::none;
  }
  bool hasExcessivelyExceededHeapLimit() const override;
  const TrackedWasmInstanceList& getTrackedWasmInstances() const override {
    return trackedWasmInstances;
  }

 private:
  // Condemns the running invocation and gives V8 emergency headroom so it can unwind instead of
  // aborting the process.
  static size_t onNearHeapLimit(void* data, size_t currentHeapLimit, size_t initialHeapLimit);

  const uint32_t memoryMb;
  kj::Own<VrtIsolateLimitState> state;
  v8::Isolate* isolate = nullptr;
  TrackedWasmInstanceList trackedWasmInstances;
};

}  // namespace workerd
