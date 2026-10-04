#include "state_machine.h"

DeviceState initialDeviceState(const std::uint32_t nowMs) {
  return DeviceState{
      ConnectionState::Booting,
      AssistantState::Ready,
      0,
      nowMs,
      nowMs,
      nowMs,
      0,
      0,
  };
}

namespace {
std::uint32_t localStateStartedAtMs(const std::uint64_t stateStartedAtMs,
                                    const std::uint64_t serverTimeMs,
                                    const std::uint32_t nowMs) {
  if (stateStartedAtMs >= serverTimeMs) {
    return nowMs;
  }
  const std::uint64_t ageMs = serverTimeMs - stateStartedAtMs;
  if (ageMs >= nowMs) {
    return 0;
  }
  return nowMs - static_cast<std::uint32_t>(ageMs);
}
} // namespace

DeviceState withConnectionState(const DeviceState &current,
                                const ConnectionState connection,
                                const std::uint32_t nowMs) {
  if (current.connection == connection) {
    return current;
  }
  DeviceState next = current;
  next.connection = connection;
  next.connectionStartedAtMs = nowMs;
  return next;
}

TransitionResult applyAssistantTransition(
    const DeviceState &current, const AssistantState assistant,
    const std::uint32_t sequence, const std::uint64_t stateStartedAtMs,
    const std::uint64_t sessionStartedAtMs, const std::uint64_t serverTimeMs,
    const std::uint32_t nowMs) {
  const bool hasSession = current.serverSessionStartedAtMs != 0;
  if (hasSession && sessionStartedAtMs < current.serverSessionStartedAtMs) {
    return TransitionResult{current, TransitionError::StaleSession};
  }
  const bool sameSession =
      hasSession && sessionStartedAtMs == current.serverSessionStartedAtMs;
  if (sameSession && sequence < current.sequence) {
    return TransitionResult{current, TransitionError::StaleSequence};
  }
  if (sameSession && sequence == current.sequence &&
      current.stateStartedAtMs != 0 &&
      (assistant != current.assistant ||
       stateStartedAtMs != current.stateStartedAtMs)) {
    return TransitionResult{current, TransitionError::ConflictingRevision};
  }

  DeviceState next = current;
  next.connection = ConnectionState::Online;
  next.connectionStartedAtMs = nowMs;
  next.lastServerMessageAtMs = nowMs;
  if (!sameSession || sequence != current.sequence ||
      current.stateStartedAtMs == 0) {
    next.assistant = assistant;
    next.sequence = sequence;
    next.assistantStartedAtMs =
        localStateStartedAtMs(stateStartedAtMs, serverTimeMs, nowMs);
    next.stateStartedAtMs = stateStartedAtMs;
    next.serverSessionStartedAtMs = sessionStartedAtMs;
  }
  return TransitionResult{next, TransitionError::None};
}

TransitionResult applyHeartbeat(const DeviceState &current,
                                const std::uint32_t sequence,
                                const std::uint64_t sessionStartedAtMs,
                                const std::uint32_t nowMs) {
  if (current.serverSessionStartedAtMs != 0 &&
      sessionStartedAtMs < current.serverSessionStartedAtMs) {
    return TransitionResult{current, TransitionError::StaleSession};
  }
  if (sessionStartedAtMs == current.serverSessionStartedAtMs &&
      sequence < current.sequence) {
    return TransitionResult{current, TransitionError::StaleSequence};
  }
  DeviceState next = current;
  next.lastServerMessageAtMs = nowMs;
  return TransitionResult{next, TransitionError::None};
}

AssistantStateParseResult parseAssistantState(const String &value) {
  if (value == "READY") {
    return AssistantStateParseResult{true, AssistantState::Ready};
  }
  if (value == "HEARING") {
    return AssistantStateParseResult{true, AssistantState::Hearing};
  }
  if (value == "THINKING" || value == "RESPONDING") {
    return AssistantStateParseResult{true, AssistantState::Thinking};
  }
  if (value == "SPEAKING") {
    return AssistantStateParseResult{true, AssistantState::Speaking};
  }
  if (value == "ERROR") {
    return AssistantStateParseResult{true, AssistantState::Error};
  }
  return AssistantStateParseResult{false, AssistantState::Error};
}

const char *assistantStateName(const AssistantState state) {
  switch (state) {
  case AssistantState::Ready:
    return "READY";
  case AssistantState::Hearing:
    return "HEARING";
  case AssistantState::Thinking:
    return "THINKING";
  case AssistantState::Speaking:
    return "SPEAKING";
  case AssistantState::Error:
    return "ERROR";
  }
  return "INVALID";
}

const char *connectionStateName(const ConnectionState state) {
  switch (state) {
  case ConnectionState::Booting:
    return "BOOTING";
  case ConnectionState::WifiConnecting:
    return "WIFI_CONNECTING";
  case ConnectionState::ServerConnecting:
    return "SERVER_CONNECTING";
  case ConnectionState::Online:
    return "ONLINE";
  case ConnectionState::Disconnected:
    return "DISCONNECTED";
  case ConnectionState::ProtocolError:
    return "PROTOCOL_ERROR";
  }
  return "INVALID";
}

const char *transitionErrorName(const TransitionError error) {
  switch (error) {
  case TransitionError::None:
    return "NONE";
  case TransitionError::StaleSession:
    return "STALE_SESSION";
  case TransitionError::StaleSequence:
    return "STALE_SEQUENCE";
  case TransitionError::ConflictingRevision:
    return "CONFLICTING_REVISION";
  }
  return "INVALID_TRANSITION_ERROR";
}

bool serverStateIsStale(const DeviceState &state, const std::uint32_t nowMs,
                        const std::uint32_t staleAfterMs) {
  if (state.connection != ConnectionState::Online) {
    return false;
  }
  return nowMs - state.lastServerMessageAtMs > staleAfterMs;
}
