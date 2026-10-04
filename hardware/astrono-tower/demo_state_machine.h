#pragma once

#include <cstdint>

#include "state_machine.h"

struct DemoInputs {
  bool errorPressed;
  std::uint16_t microphoneLevel;
};

struct DemoState {
  AssistantState assistant;
  std::uint32_t stateStartedAtMs;
  std::uint32_t lastVoiceAtMs;
};

DemoState initialDemoState(std::uint32_t nowMs);
DemoState advanceDemoState(const DemoState &current, const DemoInputs &inputs,
                           std::uint32_t nowMs);
