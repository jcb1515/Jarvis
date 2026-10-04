#pragma once

#include <Adafruit_ILI9341.h>
#include <Adafruit_NeoPixel.h>
#include <Arduino.h>
#include <WebSocketsClient.h>
#include <WiFi.h>
#include <XPT2046_Touchscreen.h>

#include <array>
#include <cstdint>

#include "animations.h"

enum class ConnectorEventKind : std::uint8_t {
  None,
  Connected,
  Disconnected,
  Text,
  Error,
};

struct ConnectorEvent {
  ConnectorEventKind kind;
  String payload;
};

struct TouchSample {
  bool touched;
  std::int16_t rawX;
  std::int16_t rawY;
  std::int16_t pressure;
};

struct SimulationInputs {
  bool demoEnabled;
  bool errorPressed;
  bool touchPressed;
  std::uint16_t microphoneLevel;
};

class WifiConnector {
public:
  void begin(const char *ssid, const char *password, std::uint32_t nowMs);
  void tick(std::uint32_t nowMs);
  bool connected() const;

private:
  const char *ssid_ = nullptr;
  const char *password_ = nullptr;
  std::uint32_t lastAttemptAtMs_ = 0;
};

class JarvisWebSocketConnector {
public:
  void begin(const char *host, std::uint16_t port, const char *token);
  void tick();
  void disconnect();
  ConnectorEvent nextEvent();

private:
  static constexpr std::size_t kQueueCapacity = 8;

  void handleEvent(WStype_t type, std::uint8_t *payload, std::size_t length);
  void enqueue(const ConnectorEvent &event);

  WebSocketsClient client_;
  String authorizationHeader_;
  std::array<ConnectorEvent, kQueueCapacity> queue_{};
  std::size_t readIndex_ = 0;
  std::size_t writeIndex_ = 0;
  std::size_t queuedCount_ = 0;
  bool overflowed_ = false;
  bool started_ = false;
};

class LedRingConnector {
public:
  explicit LedRingConnector(std::uint8_t pin);
  void begin();
  void show(const LedFrame &frame);

private:
  Adafruit_NeoPixel pixels_;
};

class DisplayConnector {
public:
  DisplayConnector(std::uint8_t chipSelectPin, std::uint8_t dataCommandPin);
  void begin();
  void show(const DeviceState &state, std::uint32_t nowMs);

private:
  void drawLayout(const DeviceState &state);
  void drawElapsed(const DeviceState &state, std::uint32_t elapsedSeconds);
  void drawActivity(const DeviceState &state, std::uint32_t nowMs);

  Adafruit_ILI9341 display_;
  ConnectionState lastConnection_ = ConnectionState::Booting;
  AssistantState lastAssistant_ = AssistantState::Ready;
  std::uint32_t lastElapsedSeconds_ = 0;
  bool initialized_ = false;
  bool hasFrame_ = false;
};

class TouchConnector {
public:
  TouchConnector(std::uint8_t chipSelectPin, std::uint8_t interruptPin);
  void begin();
  TouchSample sample();

private:
  XPT2046_Touchscreen touchscreen_;
};

class SimulationControlsConnector {
public:
  SimulationControlsConnector(std::uint8_t microphonePin, std::uint8_t modePin,
                              std::uint8_t errorPin, std::uint8_t touchPin);
  void begin();
  SimulationInputs sample() const;

private:
  std::uint8_t microphonePin_;
  std::uint8_t modePin_;
  std::uint8_t errorPin_;
  std::uint8_t touchPin_;
};

class BuzzerConnector {
public:
  explicit BuzzerConnector(std::uint8_t pin);
  void begin();
  void show(AssistantState assistant, std::uint32_t nowMs);

private:
  std::uint8_t pin_;
  bool sounding_ = false;
};

class SerialCommandConnector {
public:
  void begin(std::uint32_t baudRate);
  String nextCommand();

private:
  String buffer_;
};
