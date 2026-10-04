#include <Arduino.h>

#include <cstdint>

#include "animations.h"
#include "arduino_secrets.h"
#include "connectors.h"
#include "demo_state_machine.h"
#include "device_protocol.h"
#include "state_machine.h"

namespace {
constexpr std::uint8_t kRingPin = 5;
constexpr std::uint8_t kDisplayChipSelectPin = 10;
constexpr std::uint8_t kDisplayDataCommandPin = 9;
constexpr std::uint8_t kTouchChipSelectPin = 7;
constexpr std::uint8_t kTouchInterruptPin = 6;
constexpr std::uint8_t kSimulatedMicrophonePin = 1;
constexpr std::uint8_t kSimulationModePin = 2;
constexpr std::uint8_t kSimulationErrorPin = 4;
constexpr std::uint8_t kSimulationTouchPin = 8;
constexpr std::uint8_t kSimulatedSpeakerPin = 14;
constexpr std::uint32_t kSerialBaudRate = 115200;
constexpr std::uint32_t kRenderIntervalMs = 16;
constexpr std::uint32_t kDisplayIntervalMs = 120;
constexpr std::uint32_t kTouchIntervalMs = 30;
constexpr std::uint32_t kServerStaleAfterMs = 35000;

class FirmwareApp {
public:
  FirmwareApp()
      : state_(initialDeviceState(0)), ring_(kRingPin),
        display_(kDisplayChipSelectPin, kDisplayDataCommandPin),
        touch_(kTouchChipSelectPin, kTouchInterruptPin),
        simulationControls_(kSimulatedMicrophonePin, kSimulationModePin,
                            kSimulationErrorPin, kSimulationTouchPin),
        buzzer_(kSimulatedSpeakerPin), demoState_(initialDemoState(0)) {}

  void begin() {
    const std::uint32_t nowMs = millis();
    serial_.begin(kSerialBaudRate);
    ring_.begin();
    display_.begin();
    touch_.begin();
    simulationControls_.begin();
    buzzer_.begin();
    state_ = initialDeviceState(nowMs);
    demoState_ = initialDemoState(nowMs);
    state_ =
        withConnectionState(state_, ConnectionState::WifiConnecting, nowMs);
    wifi_.begin(SECRET_WIFI_SSID, SECRET_WIFI_PASSWORD, nowMs);
    Serial.println("ASTRONO_TOWER_READY");
    Serial.println(
        "Commands: READY, HEARING, THINKING, SPEAKING, ERROR, STATUS");
  }

  void tick() {
    const std::uint32_t nowMs = millis();
    wifi_.tick(nowMs);
    updateConnectivity(nowMs);
    websocket_.tick();
    processWebSocketEvents(nowMs);
    processSerialCommand(nowMs);
    processTouch(nowMs);
    processSimulation(nowMs);
    detectStaleServer(nowMs);
    render(nowMs);
    const AssistantState audibleState =
        state_.connection == ConnectionState::Online ? state_.assistant
                                                     : AssistantState::Ready;
    buzzer_.show(audibleState, nowMs);
    delay(2);
  }

private:
  void updateConnectivity(const std::uint32_t nowMs) {
    if (!wifi_.connected()) {
      state_ =
          withConnectionState(state_, ConnectionState::WifiConnecting, nowMs);
      return;
    }
    if (!websocketStarted_) {
      state_ =
          withConnectionState(state_, ConnectionState::ServerConnecting, nowMs);
      websocket_.begin(SECRET_JARVIS_HOST, SECRET_JARVIS_PORT,
                       SECRET_DEVICE_TOKEN);
      websocketStarted_ = true;
    }
  }

  void processWebSocketEvents(const std::uint32_t nowMs) {
    while (true) {
      const ConnectorEvent event = websocket_.nextEvent();
      if (event.kind == ConnectorEventKind::None) {
        return;
      }
      if (event.kind == ConnectorEventKind::Connected) {
        state_ = withConnectionState(state_, ConnectionState::ServerConnecting,
                                     nowMs);
        Serial.println("WEBSOCKET_CONNECTED");
        continue;
      }
      if (event.kind == ConnectorEventKind::Disconnected) {
        state_ =
            withConnectionState(state_, ConnectionState::Disconnected, nowMs);
        Serial.println("WEBSOCKET_DISCONNECTED");
        continue;
      }
      if (event.kind == ConnectorEventKind::Error) {
        state_ =
            withConnectionState(state_, ConnectionState::ProtocolError, nowMs);
        Serial.print("CONNECTOR_ERROR name=");
        Serial.println(event.payload);
        continue;
      }
      applyServerPayload(event.payload, nowMs);
    }
  }

  void applyServerPayload(const String &payload, const std::uint32_t nowMs) {
    if (demoEnabled_) {
      return;
    }
    const DeviceMessage message = parseDeviceMessage(payload);
    if (message.kind == DeviceMessageKind::Invalid) {
      state_ =
          withConnectionState(state_, ConnectionState::ProtocolError, nowMs);
      Serial.print("PROTOCOL_ERROR name=");
      Serial.println(protocolErrorName(message.error));
      return;
    }
    if (message.kind == DeviceMessageKind::Heartbeat) {
      const TransitionResult heartbeat = applyHeartbeat(
          state_, message.sequence, message.sessionStartedAtMs, nowMs);
      if (heartbeat.error != TransitionError::None) {
        Serial.print("HEARTBEAT_REJECTED reason=");
        Serial.println(transitionErrorName(heartbeat.error));
        return;
      }
      state_ = heartbeat.state;
      return;
    }
    const TransitionResult transition = applyAssistantTransition(
        state_, message.assistant, message.sequence, message.stateStartedAtMs,
        message.sessionStartedAtMs, message.serverTimeMs, nowMs);
    if (transition.error != TransitionError::None) {
      Serial.print("STATE_REJECTED reason=");
      Serial.print(transitionErrorName(transition.error));
      Serial.print(" sequence=");
      Serial.println(message.sequence);
      return;
    }
    state_ = transition.state;
    Serial.print("STATE_APPLIED state=");
    Serial.print(assistantStateName(state_.assistant));
    Serial.print(" sequence=");
    Serial.println(state_.sequence);
  }

  void processSerialCommand(const std::uint32_t nowMs) {
    String command = serial_.nextCommand();
    if (command.isEmpty()) {
      return;
    }
    command.trim();
    command.toUpperCase();
    if (command == "STATUS") {
      printStatus();
      return;
    }
    const AssistantStateParseResult parsed = parseAssistantState(command);
    if (!parsed.valid) {
      Serial.print("COMMAND_ERROR command=");
      Serial.println(command);
      return;
    }
    DeviceState next = state_;
    next.connection = ConnectionState::Online;
    next.connectionStartedAtMs = nowMs;
    next.assistant = parsed.state;
    next.assistantStartedAtMs = nowMs;
    next.lastServerMessageAtMs = nowMs;
    state_ = next;
    Serial.print("SIMULATION_STATE state=");
    Serial.println(assistantStateName(state_.assistant));
  }

  void detectStaleServer(const std::uint32_t nowMs) {
    if (!serverStateIsStale(state_, nowMs, kServerStaleAfterMs)) {
      return;
    }
    state_ = withConnectionState(state_, ConnectionState::Disconnected, nowMs);
    websocket_.disconnect();
    websocketStarted_ = false;
    Serial.println("SERVER_STALE reconnecting=true");
  }

  void processTouch(const std::uint32_t nowMs) {
    if (nowMs - lastTouchAtMs_ < kTouchIntervalMs) {
      return;
    }
    lastTouchAtMs_ = nowMs;
    const TouchSample touch = touch_.sample();
    if (!touch.touched) {
      touchActive_ = false;
      return;
    }
    if (touchActive_) {
      return;
    }
    touchActive_ = true;
    Serial.print("TOUCH raw_x=");
    Serial.print(touch.rawX);
    Serial.print(" raw_y=");
    Serial.print(touch.rawY);
    Serial.print(" pressure=");
    Serial.println(touch.pressure);
  }

  void processSimulation(const std::uint32_t nowMs) {
    const SimulationInputs inputs = simulationControls_.sample();
    if (inputs.demoEnabled != demoEnabled_) {
      demoEnabled_ = inputs.demoEnabled;
      Serial.print("SIMULATION_MODE enabled=");
      Serial.println(demoEnabled_ ? "true" : "false");
      if (demoEnabled_) {
        demoState_ = initialDemoState(nowMs);
        DeviceState simulated = state_;
        simulated.connection = ConnectionState::Online;
        simulated.assistant = AssistantState::Ready;
        simulated.connectionStartedAtMs = nowMs;
        simulated.assistantStartedAtMs = nowMs;
        simulated.lastServerMessageAtMs = nowMs;
        simulated.stateStartedAtMs = 0;
        simulated.serverSessionStartedAtMs = 0;
        state_ = simulated;
      } else {
        websocket_.disconnect();
        websocketStarted_ = false;
        DeviceState reconnecting = state_;
        reconnecting.stateStartedAtMs = 0;
        reconnecting.serverSessionStartedAtMs = 0;
        state_ = reconnecting;
        state_ = withConnectionState(state_, ConnectionState::ServerConnecting,
                                     nowMs);
      }
    }
    if (inputs.touchPressed && !simulationTouchActive_) {
      simulationTouchActive_ = true;
      Serial.println("SIMULATION_TOUCH pressed=true");
    } else if (!inputs.touchPressed) {
      simulationTouchActive_ = false;
    }
    if (!demoEnabled_) {
      return;
    }
    const DemoState next = advanceDemoState(
        demoState_, DemoInputs{inputs.errorPressed, inputs.microphoneLevel},
        nowMs);
    const bool stateChanged = next.assistant != demoState_.assistant;
    demoState_ = next;
    DeviceState simulated = state_;
    simulated.connection = ConnectionState::Online;
    simulated.assistant = demoState_.assistant;
    simulated.connectionStartedAtMs = nowMs;
    simulated.assistantStartedAtMs = demoState_.stateStartedAtMs;
    simulated.lastServerMessageAtMs = nowMs;
    simulated.stateStartedAtMs = 0;
    simulated.serverSessionStartedAtMs = 0;
    state_ = simulated;
    if (stateChanged) {
      Serial.print("SIMULATION_STATE state=");
      Serial.println(assistantStateName(state_.assistant));
    }
  }

  void render(const std::uint32_t nowMs) {
    if (nowMs - lastRenderAtMs_ < kRenderIntervalMs) {
      return;
    }
    lastRenderAtMs_ = nowMs;
    ring_.show(renderLedFrame(state_, nowMs));
    if (nowMs - lastDisplayAtMs_ < kDisplayIntervalMs) {
      return;
    }
    lastDisplayAtMs_ = nowMs;
    display_.show(state_, nowMs);
  }

  void printStatus() const {
    Serial.print("STATUS connection=");
    Serial.print(connectionStateName(state_.connection));
    Serial.print(" state=");
    Serial.print(assistantStateName(state_.assistant));
    Serial.print(" sequence=");
    Serial.println(state_.sequence);
  }

  DeviceState state_;
  WifiConnector wifi_;
  JarvisWebSocketConnector websocket_;
  LedRingConnector ring_;
  DisplayConnector display_;
  TouchConnector touch_;
  SimulationControlsConnector simulationControls_;
  BuzzerConnector buzzer_;
  SerialCommandConnector serial_;
  DemoState demoState_;
  std::uint32_t lastRenderAtMs_ = 0;
  std::uint32_t lastDisplayAtMs_ = 0;
  std::uint32_t lastTouchAtMs_ = 0;
  bool websocketStarted_ = false;
  bool touchActive_ = false;
  bool demoEnabled_ = false;
  bool simulationTouchActive_ = false;
};

FirmwareApp app;
} // namespace

void setup() { app.begin(); }

void loop() { app.tick(); }
