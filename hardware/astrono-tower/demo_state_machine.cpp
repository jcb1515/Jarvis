#include "demo_state_machine.h"

namespace {
constexpr std::uint16_t kVoiceThreshold = 1700;
constexpr std::uint32_t kSilenceBeforeThinkingMs = 900;
constexpr std::uint32_t kThinkingDurationMs = 2600;
constexpr std::uint32_t kSpeakingDurationMs = 3600;
constexpr std::uint32_t kErrorDurationMs = 1800;

DemoState enterState(const DemoState &current, const AssistantState assistant,
                     const std::uint32_t nowMs) {
  DemoState next = current;
  next.assistant = assistant;
  next.stateStartedAtMs = nowMs;
  return next;
}
} // namespace

DemoState initialDemoState(const std::uint32_t nowMs) {
  return DemoState{AssistantState::Ready, nowMs, nowMs};
}

DemoState advanceDemoState(const DemoState &current, const DemoInputs &inputs,
                           const std::uint32_t nowMs) {
  if (inputs.errorPressed) {
    if (current.assistant == AssistantState::Error) {
      return current;
    }
    return enterState(current, AssistantState::Error, nowMs);
  }

  const bool voiceActive = inputs.microphoneLevel >= kVoiceThreshold;
  const std::uint32_t elapsedMs = nowMs - current.stateStartedAtMs;
  if (current.assistant == AssistantState::Ready && voiceActive) {
    DemoState next = enterState(current, AssistantState::Hearing, nowMs);
    next.lastVoiceAtMs = nowMs;
    return next;
  }
  if (current.assistant == AssistantState::Hearing) {
    if (voiceActive) {
      DemoState next = current;
      next.lastVoiceAtMs = nowMs;
      return next;
    }
    if (nowMs - current.lastVoiceAtMs >= kSilenceBeforeThinkingMs) {
      return enterState(current, AssistantState::Thinking, nowMs);
    }
    return current;
  }
  if (current.assistant == AssistantState::Thinking &&
      elapsedMs >= kThinkingDurationMs) {
    return enterState(current, AssistantState::Speaking, nowMs);
  }
  if (current.assistant == AssistantState::Speaking &&
      elapsedMs >= kSpeakingDurationMs) {
    return enterState(current, AssistantState::Ready, nowMs);
  }
  if (current.assistant == AssistantState::Error &&
      elapsedMs >= kErrorDurationMs) {
    return enterState(current, AssistantState::Ready, nowMs);
  }
  return current;
}
