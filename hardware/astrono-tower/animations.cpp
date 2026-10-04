#include "animations.h"

#include <algorithm>
#include <cmath>

namespace {
constexpr float kPi = 3.14159265F;

std::uint8_t channel(const float value) {
  return static_cast<std::uint8_t>(std::clamp(value, 0.0F, 255.0F));
}

RgbColor color(const float red, const float green, const float blue,
               const float brightness) {
  return RgbColor{
      channel(red * brightness),
      channel(green * brightness),
      channel(blue * brightness),
  };
}

LedFrame solidFrame(const RgbColor value) {
  LedFrame frame{};
  frame.fill(value);
  return frame;
}

float pulse(const std::uint32_t elapsedMs, const float periodMs) {
  const float phase =
      static_cast<float>(elapsedMs % static_cast<std::uint32_t>(periodMs)) /
      periodMs;
  return 0.5F - 0.5F * std::cos(phase * 2.0F * kPi);
}

LedFrame chaseFrame(const std::uint32_t elapsedMs, const std::uint32_t periodMs,
                    const RgbColor base, const RgbColor head) {
  LedFrame frame = solidFrame(base);
  const std::size_t lead = (elapsedMs / periodMs) % kLedCount;
  for (std::size_t trail = 0; trail < 6; ++trail) {
    const std::size_t index = (lead + kLedCount - trail) % kLedCount;
    const float strength = 1.0F - static_cast<float>(trail) / 6.0F;
    frame[index] = color(head.red, head.green, head.blue, strength);
  }
  return frame;
}

LedFrame connectionFrame(const DeviceState &state, const std::uint32_t nowMs) {
  const std::uint32_t elapsed = nowMs - state.connectionStartedAtMs;
  switch (state.connection) {
  case ConnectionState::Booting:
    return solidFrame(
        color(255.0F, 132.0F, 24.0F, pulse(elapsed, 900.0F) * 0.18F));
  case ConnectionState::WifiConnecting:
    return chaseFrame(elapsed, 130, RgbColor{2, 1, 0}, RgbColor{72, 34, 3});
  case ConnectionState::ServerConnecting:
    return chaseFrame(elapsed, 95, RgbColor{1, 0, 3}, RgbColor{75, 28, 120});
  case ConnectionState::Disconnected:
    return solidFrame(
        color(255.0F, 85.0F, 5.0F, 0.05F + pulse(elapsed, 1600.0F) * 0.2F));
  case ConnectionState::ProtocolError:
    return solidFrame(
        color(255.0F, 0.0F, 0.0F, pulse(elapsed, 420.0F) * 0.28F));
  case ConnectionState::Online:
    break;
  }
  return solidFrame(RgbColor{0, 0, 0});
}

LedFrame readyFrame(const std::uint32_t elapsedMs) {
  LedFrame frame =
      chaseFrame(elapsedMs, 360, RgbColor{0, 2, 7}, RgbColor{8, 42, 68});
  return frame;
}

LedFrame hearingFrame(const std::uint32_t elapsedMs) {
  const float energy = 0.12F + pulse(elapsedMs, 850.0F) * 0.24F;
  LedFrame frame = solidFrame(color(0.0F, 150.0F, 210.0F, energy));
  const std::size_t focus = (elapsedMs / 90) % kLedCount;
  frame[focus] = RgbColor{15, 92, 118};
  frame[(kLedCount - focus) % kLedCount] = RgbColor{15, 92, 118};
  return frame;
}

LedFrame thinkingFrame(const std::uint32_t elapsedMs) {
  const float acceleration =
      std::min(1.0F, static_cast<float>(elapsedMs) / 1400.0F);
  const std::uint32_t period =
      static_cast<std::uint32_t>(260.0F - acceleration * 190.0F);
  return chaseFrame(elapsedMs, period, RgbColor{2, 0, 7},
                    RgbColor{118, 52, 180});
}

LedFrame speakingFrame(const std::uint32_t elapsedMs) {
  LedFrame frame{};
  const float phase = static_cast<float>(elapsedMs % 900U) / 900.0F;
  for (std::size_t index = 0; index < kLedCount; ++index) {
    const float normalized =
        static_cast<float>(index) / static_cast<float>(kLedCount);
    const float wave =
        0.5F + 0.5F * std::sin((normalized * 2.0F - phase * 3.0F) * 2.0F * kPi);
    frame[index] = color(58.0F, 175.0F, 255.0F, 0.06F + wave * 0.27F);
  }
  return frame;
}

LedFrame errorFrame(const std::uint32_t elapsedMs) {
  const std::uint32_t phase = elapsedMs % 1800U;
  const bool illuminated = (phase < 140U) || (phase >= 260U && phase < 400U) ||
                           (phase >= 520U && phase < 660U);
  return solidFrame(illuminated ? RgbColor{78, 0, 0} : RgbColor{3, 0, 0});
}
} // namespace

LedFrame renderLedFrame(const DeviceState &state, const std::uint32_t nowMs) {
  if (state.connection != ConnectionState::Online) {
    return connectionFrame(state, nowMs);
  }
  const std::uint32_t elapsed = nowMs - state.assistantStartedAtMs;
  switch (state.assistant) {
  case AssistantState::Ready:
    return readyFrame(elapsed);
  case AssistantState::Hearing:
    return hearingFrame(elapsed);
  case AssistantState::Thinking:
    return thinkingFrame(elapsed);
  case AssistantState::Speaking:
    return speakingFrame(elapsed);
  case AssistantState::Error:
    return errorFrame(elapsed);
  }
  return errorFrame(elapsed);
}
