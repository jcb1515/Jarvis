#pragma once

#include <Arduino.h>

#include <array>
#include <cstdint>

#include "state_machine.h"

constexpr std::size_t kLedCount = 24;

struct RgbColor {
  std::uint8_t red;
  std::uint8_t green;
  std::uint8_t blue;
};

using LedFrame = std::array<RgbColor, kLedCount>;

LedFrame renderLedFrame(const DeviceState &state, std::uint32_t nowMs);
