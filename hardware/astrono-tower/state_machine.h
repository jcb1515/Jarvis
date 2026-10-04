#pragma once

#include <Arduino.h>

#include <cstdint>

enum class ConnectionState : std::uint8_t {
  Booting,
  WifiConnecting,
  ServerConnecting,
  Online,
  Disconnected,
  ProtocolError,
};

enum class AssistantState : std::uint8_t {
  Ready,
  Hearing,
  Thinking,
  Speaking,
  Error,
};

enum class TransitionError : std::uint8_t {
  None,
  StaleSession,
  StaleSequence,
  ConflictingRevision,
};

struct DeviceState {
  ConnectionState connection;
  AssistantState assistant;
  std::uint32_t sequence;
  std::uint32_t connectionStartedAtMs;
  std::uint32_t assistantStartedAtMs;
  std::uint32_t lastServerMessageAtMs;
  std::uint64_t stateStartedAtMs;
  std::uint64_t serverSessionStartedAtMs;
};

struct AssistantStateParseResult {
  bool valid;
  AssistantState state;
};

struct TransitionResult {
  DeviceState state;
  TransitionError error;
};

DeviceState initialDeviceState(std::uint32_t nowMs);
DeviceState withConnectionState(const DeviceState &current,
                                ConnectionState connection,
                                std::uint32_t nowMs);
TransitionResult
applyAssistantTransition(const DeviceState &current, AssistantState assistant,
                         std::uint32_t sequence, std::uint64_t stateStartedAtMs,
                         std::uint64_t sessionStartedAtMs,
                         std::uint64_t serverTimeMs, std::uint32_t nowMs);
TransitionResult applyHeartbeat(const DeviceState &current,
                                std::uint32_t sequence,
                                std::uint64_t sessionStartedAtMs,
                                std::uint32_t nowMs);
AssistantStateParseResult parseAssistantState(const String &value);
const char *assistantStateName(AssistantState state);
const char *connectionStateName(ConnectionState state);
const char *transitionErrorName(TransitionError error);
bool serverStateIsStale(const DeviceState &state, std::uint32_t nowMs,
                        std::uint32_t staleAfterMs);
