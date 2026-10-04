#include "connectors.h"

#include <cstdio>

namespace {
constexpr std::uint32_t kWifiRetryIntervalMs = 5000;
constexpr std::uint32_t kWebSocketReconnectIntervalMs = 3000;
constexpr std::uint32_t kWebSocketPingIntervalMs = 15000;
constexpr std::uint32_t kWebSocketPongTimeoutMs = 3000;
constexpr std::uint8_t kWebSocketMissedPongs = 2;

constexpr std::uint16_t kDisplayBackground = 0x0002;
constexpr std::uint16_t kDisplayPanel = 0x0863;
constexpr std::uint16_t kDisplayMuted = 0x6B4D;
constexpr std::uint16_t kDisplayCyan = 0x07FF;
constexpr std::uint16_t kDisplayViolet = 0xA81F;
constexpr std::uint16_t kDisplayWhite = 0xEF7D;
constexpr std::uint16_t kDisplayRed = 0xF800;
constexpr std::uint16_t kDisplayAmber = 0xFD20;

const char *displayStateLabel(const DeviceState &state) {
  if (state.connection == ConnectionState::Online) {
    return assistantStateName(state.assistant);
  }
  switch (state.connection) {
  case ConnectionState::Booting:
    return "BOOTING";
  case ConnectionState::WifiConnecting:
    return "WI-FI LINK";
  case ConnectionState::ServerConnecting:
    return "JARVIS LINK";
  case ConnectionState::Disconnected:
    return "OFFLINE";
  case ConnectionState::ProtocolError:
    return "LINK ERROR";
  case ConnectionState::Online:
    break;
  }
  return "UNKNOWN";
}

std::uint16_t displayStateColor(const DeviceState &state) {
  if (state.connection == ConnectionState::ProtocolError ||
      state.assistant == AssistantState::Error) {
    return kDisplayRed;
  }
  if (state.connection == ConnectionState::Booting ||
      state.connection == ConnectionState::WifiConnecting ||
      state.connection == ConnectionState::Disconnected) {
    return kDisplayAmber;
  }
  if (state.connection == ConnectionState::ServerConnecting ||
      state.assistant == AssistantState::Thinking) {
    return kDisplayViolet;
  }
  return kDisplayCyan;
}

std::uint32_t displayElapsedSeconds(const DeviceState &state,
                                    const std::uint32_t nowMs) {
  const std::uint32_t startedAtMs = state.connection == ConnectionState::Online
                                        ? state.assistantStartedAtMs
                                        : state.connectionStartedAtMs;
  return (nowMs - startedAtMs) / 1000U;
}
} // namespace

void WifiConnector::begin(const char *ssid, const char *password,
                          const std::uint32_t nowMs) {
  ssid_ = ssid;
  password_ = password;
  lastAttemptAtMs_ = nowMs;
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.begin(ssid_, password_);
}

void WifiConnector::tick(const std::uint32_t nowMs) {
  if (connected() || nowMs - lastAttemptAtMs_ < kWifiRetryIntervalMs) {
    return;
  }
  lastAttemptAtMs_ = nowMs;
  WiFi.disconnect();
  WiFi.begin(ssid_, password_);
}

bool WifiConnector::connected() const { return WiFi.status() == WL_CONNECTED; }

void JarvisWebSocketConnector::begin(const char *host, const std::uint16_t port,
                                     const char *token) {
  if (started_) {
    return;
  }
  authorizationHeader_ = "Authorization: Bearer ";
  authorizationHeader_ += token;
  authorizationHeader_ += "\r\n";
  client_.setExtraHeaders(authorizationHeader_.c_str());
  client_.setReconnectInterval(kWebSocketReconnectIntervalMs);
  client_.enableHeartbeat(kWebSocketPingIntervalMs, kWebSocketPongTimeoutMs,
                          kWebSocketMissedPongs);
  client_.onEvent(
      [this](WStype_t type, std::uint8_t *payload, std::size_t length) {
        handleEvent(type, payload, length);
      });
  client_.begin(host, port, "/v1/devices/state");
  started_ = true;
}

void JarvisWebSocketConnector::tick() {
  if (started_) {
    client_.loop();
  }
}

void JarvisWebSocketConnector::disconnect() {
  if (!started_) {
    return;
  }
  client_.disconnect();
  started_ = false;
}

ConnectorEvent JarvisWebSocketConnector::nextEvent() {
  if (overflowed_) {
    overflowed_ = false;
    return ConnectorEvent{ConnectorEventKind::Error, "EVENT_QUEUE_OVERFLOW"};
  }
  if (queuedCount_ == 0) {
    return ConnectorEvent{ConnectorEventKind::None, ""};
  }
  const ConnectorEvent event = queue_[readIndex_];
  readIndex_ = (readIndex_ + 1) % kQueueCapacity;
  --queuedCount_;
  return event;
}

void JarvisWebSocketConnector::handleEvent(const WStype_t type,
                                           std::uint8_t *payload,
                                           const std::size_t length) {
  switch (type) {
  case WStype_CONNECTED:
    enqueue(ConnectorEvent{ConnectorEventKind::Connected, ""});
    return;
  case WStype_DISCONNECTED:
    enqueue(ConnectorEvent{ConnectorEventKind::Disconnected, ""});
    return;
  case WStype_TEXT: {
    String text;
    text.reserve(length);
    for (std::size_t index = 0; index < length; ++index) {
      text += static_cast<char>(payload[index]);
    }
    enqueue(ConnectorEvent{ConnectorEventKind::Text, text});
    return;
  }
  case WStype_ERROR:
    enqueue(ConnectorEvent{ConnectorEventKind::Error, "WEBSOCKET_ERROR"});
    return;
  case WStype_BIN:
  case WStype_FRAGMENT_TEXT_START:
  case WStype_FRAGMENT_BIN_START:
  case WStype_FRAGMENT:
  case WStype_FRAGMENT_FIN:
    enqueue(ConnectorEvent{ConnectorEventKind::Error, "UNSUPPORTED_FRAME"});
    return;
  case WStype_PING:
  case WStype_PONG:
    return;
  }
}

void JarvisWebSocketConnector::enqueue(const ConnectorEvent &event) {
  if (queuedCount_ == kQueueCapacity) {
    overflowed_ = true;
    return;
  }
  queue_[writeIndex_] = event;
  writeIndex_ = (writeIndex_ + 1) % kQueueCapacity;
  ++queuedCount_;
}

LedRingConnector::LedRingConnector(const std::uint8_t pin)
    : pixels_(kLedCount, pin, NEO_GRB + NEO_KHZ800) {}

void LedRingConnector::begin() {
  pixels_.begin();
  pixels_.setBrightness(96);
  pixels_.clear();
  pixels_.show();
}

void LedRingConnector::show(const LedFrame &frame) {
  for (std::size_t index = 0; index < frame.size(); ++index) {
    const RgbColor &value = frame[index];
    pixels_.setPixelColor(index,
                          pixels_.Color(value.red, value.green, value.blue));
  }
  pixels_.show();
}

DisplayConnector::DisplayConnector(const std::uint8_t chipSelectPin,
                                   const std::uint8_t dataCommandPin)
    : display_(chipSelectPin, dataCommandPin) {}

void DisplayConnector::begin() {
  display_.begin();
  display_.setRotation(1);
  display_.fillScreen(kDisplayBackground);
  initialized_ = true;
}

void DisplayConnector::show(const DeviceState &state,
                            const std::uint32_t nowMs) {
  if (!initialized_) {
    return;
  }
  const std::uint32_t elapsedSeconds = displayElapsedSeconds(state, nowMs);
  const bool layoutChanged = !hasFrame_ ||
                             state.connection != lastConnection_ ||
                             state.assistant != lastAssistant_;
  if (layoutChanged) {
    drawLayout(state);
  }
  if (layoutChanged || elapsedSeconds != lastElapsedSeconds_) {
    drawElapsed(state, elapsedSeconds);
  }
  drawActivity(state, nowMs);
  lastConnection_ = state.connection;
  lastAssistant_ = state.assistant;
  lastElapsedSeconds_ = elapsedSeconds;
  hasFrame_ = true;
}

void DisplayConnector::drawLayout(const DeviceState &state) {
  const std::uint16_t stateColor = displayStateColor(state);
  const char *stateLabel = displayStateLabel(state);

  display_.fillScreen(kDisplayBackground);
  display_.setTextWrap(false);
  display_.setTextColor(kDisplayWhite, kDisplayBackground);
  display_.setTextSize(2);
  display_.setCursor(18, 14);
  display_.print("ASTRONO JARVIS");
  display_.drawFastHLine(18, 39, 284, kDisplayCyan);

  display_.setTextColor(kDisplayMuted, kDisplayBackground);
  display_.setTextSize(1);
  display_.setCursor(18, 55);
  display_.print("PHYSICAL STATUS NODE / 01");

  display_.setTextColor(stateColor, kDisplayBackground);
  display_.setTextSize(3);
  display_.setCursor(18, 78);
  display_.print(stateLabel);

  display_.fillRoundRect(18, 118, 284, 55, 7, kDisplayPanel);
  display_.setTextColor(kDisplayMuted, kDisplayPanel);
  display_.setTextSize(1);
  display_.setCursor(30, 129);
  display_.print("ELAPSED");

  display_.setTextColor(kDisplayMuted, kDisplayBackground);
  display_.setCursor(18, 219);
  display_.print("LINK ");
  display_.setTextColor(stateColor, kDisplayBackground);
  display_.print(connectionStateName(state.connection));
}

void DisplayConnector::drawElapsed(const DeviceState &state,
                                   const std::uint32_t elapsedSeconds) {
  char elapsedText[12];
  const unsigned long minutes =
      static_cast<unsigned long>((elapsedSeconds / 60U) % 100U);
  const unsigned long seconds =
      static_cast<unsigned long>(elapsedSeconds % 60U);
  std::snprintf(elapsedText, sizeof(elapsedText), "%02lu:%02lu", minutes,
                seconds);

  display_.fillRect(142, 129, 145, 32, kDisplayPanel);
  display_.setTextColor(displayStateColor(state), kDisplayPanel);
  display_.setTextSize(3);
  display_.setCursor(178, 132);
  display_.print(elapsedText);
}

void DisplayConnector::drawActivity(const DeviceState &state,
                                    const std::uint32_t nowMs) {
  constexpr std::uint8_t kDotCount = 7;
  const std::uint8_t activeDot =
      static_cast<std::uint8_t>((nowMs / 180U) % kDotCount);
  const std::uint16_t activeColor = displayStateColor(state);

  display_.fillRect(18, 184, 284, 23, kDisplayBackground);
  for (std::uint8_t index = 0; index < kDotCount; ++index) {
    const std::int16_t x = 97 + static_cast<std::int16_t>(index) * 21;
    const std::uint16_t color =
        index == activeDot ? activeColor : kDisplayPanel;
    display_.fillCircle(x, 195, index == activeDot ? 5 : 3, color);
  }
}

TouchConnector::TouchConnector(const std::uint8_t chipSelectPin,
                               const std::uint8_t interruptPin)
    : touchscreen_(chipSelectPin, interruptPin) {}

void TouchConnector::begin() {
  touchscreen_.begin();
  touchscreen_.setRotation(1);
}

TouchSample TouchConnector::sample() {
  if (!touchscreen_.touched()) {
    return TouchSample{false, 0, 0, 0};
  }
  const TS_Point point = touchscreen_.getPoint();
  return TouchSample{true, static_cast<std::int16_t>(point.x),
                     static_cast<std::int16_t>(point.y),
                     static_cast<std::int16_t>(point.z)};
}

SimulationControlsConnector::SimulationControlsConnector(
    const std::uint8_t microphonePin, const std::uint8_t modePin,
    const std::uint8_t errorPin, const std::uint8_t touchPin)
    : microphonePin_(microphonePin), modePin_(modePin), errorPin_(errorPin),
      touchPin_(touchPin) {}

void SimulationControlsConnector::begin() {
  pinMode(microphonePin_, INPUT);
  pinMode(modePin_, INPUT_PULLUP);
  pinMode(errorPin_, INPUT_PULLUP);
  pinMode(touchPin_, INPUT_PULLUP);
}

SimulationInputs SimulationControlsConnector::sample() const {
  return SimulationInputs{
      digitalRead(modePin_) == HIGH,
      digitalRead(errorPin_) == LOW,
      digitalRead(touchPin_) == LOW,
      static_cast<std::uint16_t>(analogRead(microphonePin_)),
  };
}

BuzzerConnector::BuzzerConnector(const std::uint8_t pin) : pin_(pin) {}

void BuzzerConnector::begin() {
  pinMode(pin_, OUTPUT);
  noTone(pin_);
}

void BuzzerConnector::show(const AssistantState assistant,
                           const std::uint32_t nowMs) {
  const bool pulseOn = (nowMs / 220U) % 2U == 0U;
  const bool shouldSound = assistant == AssistantState::Speaking && pulseOn;
  if (shouldSound == sounding_) {
    return;
  }
  sounding_ = shouldSound;
  if (sounding_) {
    tone(pin_, 880);
    return;
  }
  noTone(pin_);
}

void SerialCommandConnector::begin(const std::uint32_t baudRate) {
  Serial.begin(baudRate);
  buffer_.reserve(32);
}

String SerialCommandConnector::nextCommand() {
  while (Serial.available() > 0) {
    const char character = static_cast<char>(Serial.read());
    if (character == '\r') {
      continue;
    }
    if (character == '\n') {
      const String command = buffer_;
      buffer_ = "";
      return command;
    }
    if (buffer_.length() >= 31) {
      buffer_ = "";
      return "COMMAND_TOO_LONG";
    }
    buffer_ += character;
  }
  return "";
}
