#pragma once

#include <Arduino.h>

#include <cstdint>

#include "state_machine.h"

enum class DeviceMessageKind : std::uint8_t {
  Invalid,
  State,
  Heartbeat,
};

enum class ProtocolError : std::uint8_t {
  None,
  InvalidJson,
  UnsupportedVersion,
  UnknownMessageType,
  MissingSequence,
  MissingState,
  UnknownState,
  MissingStartedAt,
  MissingSessionStartedAt,
  MissingServerTime,
};

struct DeviceMessage {
  DeviceMessageKind kind;
  ProtocolError error;
  AssistantState assistant;
  std::uint32_t sequence;
  std::uint64_t stateStartedAtMs;
  std::uint64_t sessionStartedAtMs;
  std::uint64_t serverTimeMs;
};

DeviceMessage parseDeviceMessage(const String &payload);
const char *protocolErrorName(ProtocolError error);
