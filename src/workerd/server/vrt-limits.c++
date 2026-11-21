// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

#include "vrt-limits.h"

#include <workerd/io/actor-cache.h>
#include <workerd/jsg/exception.h>
#include <workerd/jsg/setup.h>
#include <workerd/util/exception.h>

#include <kj/debug.h>
#include <kj/thread.h>

#if defined(__linux__)
#include <pthread.h>
#include <time.h>
#elif defined(__APPLE__)
#include <mach/mach.h>
#include <mach/thread_act.h>
#include <mach/thread_info.h>
#endif

#include <algorithm>
#include <chrono>
#include <cstring>
#include <limits>
#include <thread>

namespace workerd {

namespace {

// =======================================================================================
// Thread CPU clock
//
// The budget must follow CPU time actually spent running JavaScript, never wall time: awaiting
// I/O or waiting for the isolate lock must not be billed. Each platform has a per-thread CPU
// clock; the watchdog also needs to read *another* live thread's clock, which is why the handle
// is captured when a turn starts.

#if defined(__linux__)

kj::Duration durationFromTimespec(const struct timespec& ts) {
  return ts.tv_sec * kj::SECONDS + ts.tv_nsec * kj::NANOSECONDS;
}

kj::Maybe<kj::Duration> readCurrentThreadCpu() {
  struct timespec ts;
  if (clock_gettime(CLOCK_THREAD_CPUTIME_ID, &ts) != 0) return kj::none;
  return durationFromTimespec(ts);
}

kj::Maybe<uint64_t> captureThreadHandle() {
  static_assert(sizeof(pthread_t) <= sizeof(uint64_t), "pthread_t does not fit in a handle");
  pthread_t self = pthread_self();
  uint64_t handle = 0;
  std::memcpy(&handle, &self, sizeof(self));
  return handle;
}

kj::Maybe<kj::Duration> readThreadCpu(uint64_t handle) {
  pthread_t thread;
  std::memcpy(&thread, &handle, sizeof(thread));
  clockid_t clockId;
  // ESRCH when the thread has exited: nothing left to sample.
  if (pthread_getcpuclockid(thread, &clockId) != 0) return kj::none;
  struct timespec ts;
  if (clock_gettime(clockId, &ts) != 0) return kj::none;
  return durationFromTimespec(ts);
}

void releaseThreadHandle(uint64_t) {}

#elif defined(__APPLE__)

kj::Maybe<kj::Duration> readMachThreadCpu(mach_port_t thread) {
  thread_basic_info_data_t info;
  mach_msg_type_number_t count = THREAD_BASIC_INFO_COUNT;
  if (thread_info(thread, THREAD_BASIC_INFO, reinterpret_cast<thread_info_t>(&info), &count) !=
      KERN_SUCCESS) {
    return kj::none;
  }
  return info.user_time.seconds * kj::SECONDS + info.user_time.microseconds * kj::MICROSECONDS +
      info.system_time.seconds * kj::SECONDS + info.system_time.microseconds * kj::MICROSECONDS;
}

kj::Maybe<kj::Duration> readCurrentThreadCpu() {
  mach_port_t self = mach_thread_self();
  KJ_DEFER(mach_port_deallocate(mach_task_self(), self));
  return readMachThreadCpu(self);
}

kj::Maybe<uint64_t> captureThreadHandle() {
  // The send right carries an extra reference, released by releaseThreadHandle() when the turn
  // ends on the owning thread.
  return static_cast<uint64_t>(mach_thread_self());
}

kj::Maybe<kj::Duration> readThreadCpu(uint64_t handle) {
  return readMachThreadCpu(static_cast<mach_port_t>(handle));
}

void releaseThreadHandle(uint64_t handle) {
  mach_port_deallocate(mach_task_self(), static_cast<mach_port_t>(handle));
}

#else

// No per-thread CPU clock: `cpuMs` fails closed (see VrtLimitEnforcer::enterJs).
kj::Maybe<kj::Duration> readCurrentThreadCpu() {
  return kj::none;
}
kj::Maybe<uint64_t> captureThreadHandle() {
  return kj::none;
}
kj::Maybe<kj::Duration> readThreadCpu(uint64_t) {
  return kj::none;
}
void releaseThreadHandle(uint64_t) {}

#endif

}  // namespace

// =======================================================================================
// Limits and stable exceptions

uint64_t vrtMemoryLimitBytes(uint32_t memoryMb) {
  return static_cast<uint64_t>(memoryMb) << 20;
}

kj::Exception vrtCpuLimitException() {
  auto e = JSG_KJ_EXCEPTION(OVERLOADED, Error, "Worker exceeded CPU time limit.");
  e.setDetail(CPU_LIMIT_DETAIL_ID, kj::heapArray<kj::byte>(0));
  return e;
}

kj::Exception vrtMemoryLimitException() {
  auto e = JSG_KJ_EXCEPTION(OVERLOADED, Error, "Worker has exceeded memory limit.");
  e.setDetail(MEMORY_LIMIT_DETAIL_ID, kj::heapArray<kj::byte>(0));
  return e;
}

// =======================================================================================
// VrtInvocationLimitState

void VrtInvocationLimitState::markCpuExceeded(bool requestTermination) {
  // Only the first mark requests termination; the watchdog samples every 5 ms until the turn
  // unwinds, and each extra call must not post another termination.
  if (cpuExceededFlag.exchange(true, std::memory_order_relaxed)) return;
  if (requestTermination) {
    // Note before terminating: the turn that catches the termination may not be this invocation
    // (a turn can end between two watchdog samples), and the note lets it be attributed.
    isolateState->noteLimitTermination();
    isolateState->terminateIsolate();
  }
}

void VrtInvocationLimitState::markMemoryExceeded(bool requestTermination) {
  if (memoryExceededFlag.exchange(true, std::memory_order_relaxed)) return;
  if (requestTermination) {
    isolateState->noteLimitTermination();
    isolateState->terminateIsolate();
  }
}

kj::Maybe<EventOutcome> VrtInvocationLimitState::getLimitsExceeded() const {
  // A run that exceeds both is reported as memory: the heap limit is the more terminal one.
  if (memoryExceeded()) return EventOutcome::EXCEEDED_MEMORY;
  if (cpuExceeded()) return EventOutcome::EXCEEDED_CPU;
  return kj::none;
}

kj::Maybe<kj::Exception> VrtInvocationLimitState::getException() const {
  if (memoryExceeded()) return vrtMemoryLimitException();
  if (cpuExceeded()) return vrtCpuLimitException();
  return kj::none;
}

void VrtInvocationLimitState::reset() {
  cpuExceededFlag.store(false, std::memory_order_relaxed);
  memoryExceededFlag.store(false, std::memory_order_relaxed);
}

// =======================================================================================
// VrtIsolateLimitState

VrtIsolateLimitState::VrtIsolateLimitState() = default;
VrtIsolateLimitState::~VrtIsolateLimitState() noexcept(false) = default;

void VrtIsolateLimitState::setIsolateLiveness(kj::Arc<const jsg::IsolateLiveness> value) {
  *liveness.lockExclusive() = kj::mv(value);
}

void VrtIsolateLimitState::terminateIsolate() {
  auto lock = liveness.lockExclusive();
  KJ_IF_SOME(ref, *lock) {
    // The liveness object reports nullptr once V8 tears the isolate down, so this never
    // dereferences a destroyed isolate.
    if (auto* v8Isolate = ref->tryGetIsolate()) {
      v8Isolate->TerminateExecution();
    }
  }
}

void VrtIsolateLimitState::noteLimitTermination() {
  pendingLimitTerminations.fetch_add(1, std::memory_order_relaxed);
}

bool VrtIsolateLimitState::hasPendingLimitTermination() const {
  return pendingLimitTerminations.load(std::memory_order_relaxed) != 0;
}

bool VrtIsolateLimitState::consumeLimitTermination() {
  uint32_t value = pendingLimitTerminations.load(std::memory_order_relaxed);
  while (value != 0) {
    if (pendingLimitTerminations.compare_exchange_weak(
            value, value - 1, std::memory_order_relaxed)) {
      return true;
    }
  }
  return false;
}

void VrtIsolateLimitState::cancelPendingLimitTerminations() {
  if (pendingLimitTerminations.exchange(0, std::memory_order_relaxed) == 0) return;
  auto lock = liveness.lockExclusive();
  KJ_IF_SOME(ref, *lock) {
    if (auto* v8Isolate = ref->tryGetIsolate()) {
      // Safe here only because the caller is between JS turns: no JS is executing.
      v8Isolate->CancelTerminateExecution();
    }
  }
}

void VrtIsolateLimitState::setCurrentInvocation(VrtInvocationLimitState& invocation) {
  currentInvocation.store(&invocation, std::memory_order_relaxed);
}

void VrtIsolateLimitState::clearCurrentInvocation(VrtInvocationLimitState& invocation) {
  VrtInvocationLimitState* expected = &invocation;
  currentInvocation.compare_exchange_strong(
      expected, nullptr, std::memory_order_relaxed, std::memory_order_relaxed);
}

void VrtIsolateLimitState::condemnMemory(v8::Isolate* isolate) {
  heapLimitHit.store(true, std::memory_order_relaxed);
  // The heap callback runs on the allocating JS thread, so the current invocation is the one to
  // blame. Without one (startup, GC from another thread) only the isolate flag is set.
  if (auto* invocation = currentInvocation.load(std::memory_order_relaxed)) {
    invocation->markMemoryExceeded(false);
  }
  noteLimitTermination();
  if (isolate != nullptr) {
    isolate->TerminateExecution();
  }
}

// =======================================================================================
// VrtLimitWatchdog

VrtLimitWatchdog::VrtLimitWatchdog(bool startThread): startThread(startThread) {}

VrtLimitWatchdog::~VrtLimitWatchdog() noexcept(false) {
  stopThread.store(true, std::memory_order_relaxed);
  // Dropping the Thread joins it (kj::Thread's destructor joins).
  thread = kj::none;
}

VrtLimitWatchdog& VrtLimitWatchdog::instance() {
  // Intentionally leaked: static destructors may run after V8 teardown, and the watchdog thread
  // is harmless until process exit.
  static VrtLimitWatchdog* watchdog = new VrtLimitWatchdog(true);
  return *watchdog;
}

bool VrtLimitWatchdog::isSupported() {
#if defined(__linux__) || defined(__APPLE__)
  return true;
#else
  return false;
#endif
}

kj::Maybe<kj::Duration> VrtLimitWatchdog::currentThreadCpu() {
  return readCurrentThreadCpu();
}

void VrtLimitWatchdog::ensureThreadStarted() {
  if (!startThread) return;
  if (threadStarted.exchange(true, std::memory_order_relaxed)) return;
  thread = kj::heap<kj::Thread>([this]() { loop(); });
}

VrtLimitWatchdog::Token VrtLimitWatchdog::registerTurn(
    kj::Own<VrtInvocationLimitState> invocation, kj::Duration startCpu, kj::Duration remaining) {
  if (!isSupported()) return {};
  ensureThreadStarted();

  KJ_IF_SOME(threadHandle, captureThreadHandle()) {
    Token token;
    token.epoch = nextEpoch.fetch_add(1, std::memory_order_relaxed);
    token.threadHandle = threadHandle;
    token.valid = true;

    auto turnsLock = turns.lockExclusive();
    turnsLock->add(Turn{
      .epoch = token.epoch,
      .invocation = kj::mv(invocation),
      .threadHandle = token.threadHandle,
      .deadline = startCpu + remaining,
    });
    return token;
  }
  return {};
}

void VrtLimitWatchdog::finishTurn(const Token& token) {
  if (!token.valid) return;
  auto turnsLock = turns.lockExclusive();
  for (uint i = 0; i < turnsLock->size(); ++i) {
    if ((*turnsLock)[i].epoch != token.epoch) continue;
    releaseThreadHandle(token.threadHandle);
    for (uint j = i; j + 1 < turnsLock->size(); ++j) {
      (*turnsLock)[j] = kj::mv((*turnsLock)[j + 1]);
    }
    turnsLock->removeLast();
    return;
  }
}

void VrtLimitWatchdog::pollOnce() {
  auto turnsLock = turns.lockExclusive();
  for (auto& turn: *turnsLock) {
    KJ_IF_SOME(cpu, readThreadCpu(turn.threadHandle)) {
      if (cpu < turn.deadline) continue;
      // Terminate while still holding the registry lock. A turn cannot unregister without the
      // lock, so the per-invocation budget cannot be spent while this termination is decided.
      turn.invocation->markCpuExceeded(true);
    }
  }
}

void VrtLimitWatchdog::loop() {
  constexpr int64_t sampleNs = SAMPLE_INTERVAL / kj::NANOSECONDS;
  while (!stopThread.load(std::memory_order_relaxed)) {
    pollOnce();
    std::this_thread::sleep_for(std::chrono::nanoseconds(sampleNs));
  }
}

// =======================================================================================
// VrtLimitEnforcer

VrtLimitEnforcer::VrtLimitEnforcer(
    VrtWorkerLimits limits, kj::Own<VrtIsolateLimitState> isolateState)
    : limits(limits),
      isolateState(kj::mv(isolateState)),
      invocation(kj::atomicRefcounted<VrtInvocationLimitState>(
          kj::atomicAddRef(*this->isolateState))) {}

kj::Duration VrtLimitEnforcer::cpuBudget() const {
  return static_cast<int64_t>(limits.cpuMs) * kj::MILLISECONDS;
}

void VrtLimitEnforcer::throwIfExceeded() {
  KJ_IF_SOME(e, invocation->getException()) {
    // About to throw instead of running JS: no termination may be left pending, or V8 would
    // terminate the next turn (possibly another request) once it starts.
    isolateState->cancelPendingLimitTerminations();
    kj::throwRecoverableException(kj::mv(e));
  }
}

class VrtLimitEnforcer::JsScope final {
 public:
  explicit JsScope(VrtLimitEnforcer& enforcer): enforcer(enforcer) {}
  ~JsScope() noexcept(false) {
    enforcer.endJs();
  }
  KJ_DISALLOW_COPY_AND_MOVE(JsScope);

 private:
  VrtLimitEnforcer& enforcer;
};

kj::Own<void> VrtLimitEnforcer::enterJs(jsg::Lock&, IoContext&) {
  throwIfExceeded();

  if (jsScopeDepth > 0) {
    // Nested turn: the outer scope already registered it and bills the whole interval.
    ++jsScopeDepth;
    return kj::heap<JsScope>(*this);
  }

  if (limits.cpuMs != 0 && !VrtLimitWatchdog::isSupported()) {
    // Fail closed: a configured CPU budget that cannot be enforced must not silently run
    // unbounded.
    JSG_FAIL_REQUIRE(Error, "CPU limits are not supported on this platform.");
  }

  // No JS is running here, so a termination left behind by a turn that ended between watchdog
  // samples can be cancelled safely.
  isolateState->cancelPendingLimitTerminations();
  if (limits.memoryMb != 0) isolateState->clearHeapLimit();
  isolateState->setCurrentInvocation(*invocation);
  jsScopeDepth = 1;

  if (limits.cpuMs != 0) {
    KJ_IF_SOME(start, VrtLimitWatchdog::currentThreadCpu()) {
      auto budget = cpuBudget();
      auto remaining = budget > cpuUsed ? budget - cpuUsed : 0 * kj::SECONDS;
      if (remaining == 0 * kj::SECONDS) {
        // The budget was already spent by earlier turns of this invocation. Nothing is running,
        // so do not request termination; just fail the turn.
        jsScopeDepth = 0;
        isolateState->clearCurrentInvocation(*invocation);
        invocation->markCpuExceeded(false);
        kj::throwRecoverableException(vrtCpuLimitException());
      }
      jsStart = start;
      auto registered = VrtLimitWatchdog::instance().registerTurn(
          kj::atomicAddRef(*invocation), start, remaining);
      if (!registered.valid) {
        jsScopeDepth = 0;
        isolateState->clearCurrentInvocation(*invocation);
        jsStart = kj::none;
        JSG_FAIL_REQUIRE(Error, "CPU limits are not supported on this platform.");
      }
      token = registered;
    } else {
      jsScopeDepth = 0;
      isolateState->clearCurrentInvocation(*invocation);
      JSG_FAIL_REQUIRE(Error, "CPU limits are not supported on this platform.");
    }
  }

  return kj::heap<JsScope>(*this);
}

void VrtLimitEnforcer::endJs() {
  KJ_REQUIRE(jsScopeDepth > 0, "unbalanced JS scope");
  if (--jsScopeDepth > 0) return;

  KJ_IF_SOME(t, token) {
    VrtLimitWatchdog::instance().finishTurn(t);
    token = kj::none;
  }
  isolateState->clearCurrentInvocation(*invocation);

  KJ_IF_SOME(start, jsStart) {
    KJ_IF_SOME(end, VrtLimitWatchdog::currentThreadCpu()) {
      if (end > start) cpuUsed += end - start;
    }
    jsStart = kj::none;
  }

  if (limits.cpuMs != 0 && cpuUsed > cpuBudget()) {
    // The overrun was detected at the end of the turn, so there is nothing left to terminate.
    // Marking it makes the invocation fail its next check; the watchdog normally catches a long
    // overrun while JS is still running.
    invocation->markCpuExceeded(false);
  }
}

void VrtLimitEnforcer::topUpActor() {
  throwIfExceeded();
  cpuUsed = 0 * kj::SECONDS;
  subrequestsUsed = 0;
  aeEventsUsed = 0;
  invocation->reset();
  isolateState->clearHeapLimit();
}

void VrtLimitEnforcer::newSubrequest(bool isInHouse) {
  throwIfExceeded();
  // `isInHouse` marks calls to a service provided internally (KV, R2, actor storage, ...). Like
  // Cloudflare's embedder, those are not charged to the external-subrequest budget.
  if (isInHouse || limits.subRequests == 0) return;
  if (subrequestsUsed >= limits.subRequests) {
    // Fail before the (N+1)th subrequest has any side effect.
    JSG_FAIL_REQUIRE(Error, "Too many subrequests.");
  }
  ++subrequestsUsed;
}

void VrtLimitEnforcer::newAnalyticsEngineRequest() {
  throwIfExceeded();
  // Cloudflare caps writeDataPoint at 250 data points per invocation; the
  // budget is fixed there (no config knob), so mirror it as a constant.
  // https://developers.cloudflare.com/analytics/analytics-engine/limits/
  if (aeEventsUsed >= 250) {
    JSG_FAIL_REQUIRE(Error, "Too many Analytics Engine data points.");
  }
  ++aeEventsUsed;
}

kj::Promise<void> VrtLimitEnforcer::limitDrain() {
  return kj::NEVER_DONE;
}

kj::Promise<void> VrtLimitEnforcer::limitScheduled() {
  return kj::NEVER_DONE;
}

kj::Duration VrtLimitEnforcer::getAlarmLimit() {
  return 15 * kj::MINUTES;
}

size_t VrtLimitEnforcer::getBufferingLimit() {
  return kj::maxValue;
}

kj::Maybe<EventOutcome> VrtLimitEnforcer::getLimitsExceeded() {
  return invocation->getLimitsExceeded();
}

kj::Promise<void> VrtLimitEnforcer::onLimitsExceeded() {
  // Enforcement is V8 termination: once the watchdog calls TerminateExecution(), the running turn
  // throws immediately, so there is nothing to wait for here. (An invocation that is not running
  // JS cannot consume CPU.)
  return kj::NEVER_DONE;
}

void VrtLimitEnforcer::requireLimitsNotExceeded() {
  KJ_IF_SOME(e, invocation->getException()) {
    isolateState->consumeLimitTermination();
    kj::throwRecoverableException(kj::mv(e));
  }
  // A termination our watchdog requested for a turn that already ended may arrive in this one.
  // Report it as a CPU overrun rather than letting IoContext fail on an unattributed
  // termination.
  if (isolateState->consumeLimitTermination()) {
    kj::throwRecoverableException(vrtCpuLimitException());
  }
}

// =======================================================================================
// VrtIsolateLimitEnforcer

VrtIsolateLimitEnforcer::VrtIsolateLimitEnforcer(
    uint32_t memoryMb, kj::Own<VrtIsolateLimitState> state)
    : memoryMb(memoryMb),
      state(kj::mv(state)) {}

v8::Isolate::CreateParams VrtIsolateLimitEnforcer::getCreateParams() {
  v8::Isolate::CreateParams params;
  if (memoryMb != 0) {
    // Size the young generation consistently with the old one so the whole JS heap, not just the
    // old generation, tracks the configured budget.
    v8::ResourceConstraints constraints;
    constraints.ConfigureDefaultsFromHeapSize(0, vrtMemoryLimitBytes(memoryMb));
    params.constraints = constraints;
  }
  return params;
}

size_t VrtIsolateLimitEnforcer::onNearHeapLimit(
    void* data, size_t currentHeapLimit, size_t) {
  auto& self = *static_cast<VrtIsolateLimitEnforcer*>(data);
  self.state->condemnMemory(self.isolate);

  // V8 requires the callback to return a limit. Return one fixed ceiling — the configured budget
  // plus bounded emergency headroom — rather than growing by headroom on every call, so repeated
  // OOMs cannot creep the budget upward. If V8 is already at that ceiling, returning the current
  // limit tells it to abort; termination should have unwound the isolate by then.
  const size_t budget = vrtMemoryLimitBytes(self.memoryMb);
  size_t headroom = budget / 8;
  headroom = std::max(headroom, static_cast<size_t>(1024 * 1024));
  headroom = std::min(headroom, static_cast<size_t>(16 * 1024 * 1024));
  const size_t ceiling =
      budget > std::numeric_limits<size_t>::max() - headroom ? budget : budget + headroom;
  if (currentHeapLimit < ceiling) {
    return ceiling;
  }
  return currentHeapLimit;
}

void VrtIsolateLimitEnforcer::customizeIsolate(v8::Isolate* isolate) {
  this->isolate = isolate;
  state->setIsolateLiveness(jsg::IsolateBase::from(isolate).getIsolateLiveness());
  if (memoryMb != 0) {
    isolate->AddNearHeapLimitCallback(&onNearHeapLimit, this);
  }
}

ActorCacheSharedLruOptions VrtIsolateLimitEnforcer::getActorCacheLruOptions() {
  // Durable Object cache sizing is not part of the Worker's heap budget; keep the standalone
  // defaults so a limited Worker behaves like an unlimited one here.
  return {.softLimit = 16 * (1ull << 20),
    .hardLimit = 128 * (1ull << 20),
    .staleTimeout = 30 * kj::SECONDS,
    .dirtyListByteLimit = 8 * (1ull << 20),
    .maxKeysPerRpc = 128,
    .neverFlush = true};
}

kj::Own<void> VrtIsolateLimitEnforcer::enterStartupJs(
    jsg::Lock&, kj::OneOf<kj::Exception, kj::Duration>&) const {
  // Startup CPU is not limited by this patch; only invocations are.
  return {};
}

kj::Own<void> VrtIsolateLimitEnforcer::enterStartupPython(
    jsg::Lock&, kj::OneOf<kj::Exception, kj::Duration>&) const {
  return {};
}

kj::Own<void> VrtIsolateLimitEnforcer::enterDynamicImportJs(
    jsg::Lock&, kj::OneOf<kj::Exception, kj::Duration>&) const {
  return {};
}

kj::Own<void> VrtIsolateLimitEnforcer::enterLoggingJs(
    jsg::Lock&, kj::OneOf<kj::Exception, kj::Duration>&) const {
  return {};
}

kj::Own<void> VrtIsolateLimitEnforcer::enterInspectorJs(
    jsg::Lock&, kj::OneOf<kj::Exception, kj::Duration>&) const {
  return {};
}

bool VrtIsolateLimitEnforcer::exitJs(jsg::Lock&) const {
  // Heap enforcement happens in getCreateParams() and the near-heap-limit callback. Nothing here
  // condemns the isolate permanently: the standalone server has no isolate replacement hook.
  return false;
}

bool VrtIsolateLimitEnforcer::hasExcessivelyExceededHeapLimit() const {
  return state->hasExcessivelyExceededHeapLimit();
}

}  // namespace workerd
