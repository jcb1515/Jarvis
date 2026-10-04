#include "device_protocol.h"

#include <ArduinoJson.h>

namespace {
constexpr std::uint8_t kProtocolVersion = 2;

DeviceMessage invalidMessage(const ProtocolError error) {
  return DeviceMessage{
      DeviceMessageKind::Invalid, error, AssistantState::Error, 0, 0, 0, 0,
  };
}
} // namespace

DeviceMessage parseDeviceMessage(const String &payload) {
  JsonDocument document;
  const DeserializationError parseError = deserializeJson(document, payload);
  if (parseError) {
    return invalidMessage(ProtocolError::InvalidJson);
  }

  const std::uint8_t version = document["version"] | 0;
  if (version != kProtocolVersion) {
    return invalidMessage(ProtocolError::UnsupportedVersion);
  }
  if (!document["sequence"].is<std::uint32_t>()) {
    return invalidMessage(ProtocolError::MissingSequence);
  }
  const std::uint32_t sequence = document["sequence"].as<std::uint32_t>();
  if (!document["session_started_at_ms"].is<std::uint64_t>()) {
    return invalidMessage(ProtocolError::MissingSessionStartedAt);
  }
  if (!document["server_time_ms"].is<std::uint64_t>()) {
    return invalidMessage(ProtocolError::MissingServerTime);
  }
  const std::uint64_t sessionStartedAtMs =
      document["session_started_at_ms"].as<std::uint64_t>();
  const std::uint64_t serverTimeMs =
      document["server_time_ms"].as<std::uint64_t>();
  const String type = document["type"] | "";
  if (type == "heartbeat") {
    return DeviceMessage{
        DeviceMessageKind::Heartbeat,
        ProtocolError::None,
        AssistantState::Ready,
        sequence,
        0,
        sessionStartedAtMs,
        serverTimeMs,
    };
  }
  if (type != "jarvis_state") {
    return invalidMessage(ProtocolError::UnknownMessageType);
  }
  if (!document["state"].is<const char *>()) {
    return invalidMessage(ProtocolError::MissingState);
  }
  if (!document["started_at_ms"].is<std::uint64_t>()) {
    return invalidMessage(ProtocolError::MissingStartedAt);
  }

  const AssistantStateParseResult parsedState =
      parseAssistantState(String(document["state"].as<const char *>()));
  if (!parsedState.valid) {
    return invalidMessage(ProtocolError::UnknownState);
  }
  return DeviceMessage{
      DeviceMessageKind::State,
      ProtocolError::None,
      parsedState.state,
      sequence,
      document["started_at_ms"].as<std::uint64_t>(),
      sessionStartedAtMs,
      serverTimeMs,
  };
}

const char *protocolErrorName(const ProtocolError error) {
  switch (error) {
  case ProtocolError::None:
    return "NONE";
  case ProtocolError::InvalidJson:
    return "INVALID_JSON";
  case ProtocolError::UnsupportedVersion:
    return "UNSUPPORTED_VERSION";
  case ProtocolError::UnknownMessageType:
    return "UNKNOWN_MESSAGE_TYPE";
  case ProtocolError::MissingSequence:
    return "MISSING_SEQUENCE";
  case ProtocolError::MissingState:
    return "MISSING_STATE";
  case ProtocolError::UnknownState:
    return "UNKNOWN_STATE";
  case ProtocolError::MissingStartedAt:
    return "MISSING_STARTED_AT";
  case ProtocolError::MissingSessionStartedAt:
    return "MISSING_SESSION_STARTED_AT";
  case ProtocolError::MissingServerTime:
    return "MISSING_SERVER_TIME";
  }
  return "INVALID_PROTOCOL_ERROR";
}
