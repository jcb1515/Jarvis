# Astrono Tower firmware

This ESP32-S3 prototype mirrors Astrono Jarvis runtime state on a 24-pixel
WS2812 ring and a landscape SPI TFT. It connects to the read-only
`/v1/devices/state` WebSocket with a dedicated bearer token and rejects
malformed, unsupported, or out-of-order messages.

## Build

Copy `arduino_secrets.example.h` to `arduino_secrets.h`, then set the device
token. The real file is ignored by Git.

```powershell
arduino-cli compile --profile wokwi --warnings all --output-dir build .
```

The pinned `sketch.yaml` profile downloads its platform and libraries into an
isolated Arduino CLI build cache rather than relying on global libraries.

## Simulate

Open this folder in VS Code, compile it, enable Wokwi's private IoT gateway,
and run `Wokwi: Start Simulator`. The simulator resolves the local computer as
`host.wokwi.internal`, so the default secret template targets the Jarvis
backend on port 8000.

The physical target is a generic 2.8-inch ILI9341 SPI display with an XPT2046
resistive-touch controller. The Wokwi model renders the ILI9341 in landscape
mode, but Wokwi does not simulate the XPT2046 controller. Touch therefore has
real firmware and documented wiring, while its electrical behavior must be
validated on the physical module.
The serial monitor accepts `READY`, `HEARING`, `THINKING`, `SPEAKING`, and
`ERROR` to exercise the ring and display deterministically. `STATUS` prints the
current connection state, assistant state, and server sequence without
printing any credentials.

The simulator includes a complete local state-machine harness:

- Leave the mode switch on `LIVE` to follow the authenticated Jarvis backend.
- Move it to `DEMO`, then raise the simulated microphone potentiometer to enter
  `HEARING`.
- Lower the microphone to advance through `THINKING`, `SPEAKING`, and back to
  `READY` automatically.
- Press the red button to inject `ERROR` from any demo state.
- Press the blue button to simulate a touch event.
- The buzzer is an audible stand-in for the future I2S speaker path.

The 470-ohm ring data resistor is modeled directly. Wokwi does not model the
fuse, bulk capacitor, 74AHCT125 level shifter, XPT2046 controller, or ESP32-S3
I2S audio path, so these are labeled in the diagram instead of being replaced
with electrically incorrect parts. The real power and audio stages remain
required in the physical build.

## Signal wiring

| Device | ESP32-S3 pin |
| --- | --- |
| WS2812 ring data | GPIO 5 |
| TFT D/C | GPIO 9 |
| TFT CS | GPIO 10 |
| TFT MOSI | GPIO 11 |
| TFT SCK | GPIO 12 |
| Touch IRQ | GPIO 6 |
| Touch CS | GPIO 7 |
| Touch DIN | GPIO 11, shared SPI MOSI |
| Touch CLK | GPIO 12, shared SPI SCK |
| Touch DO | GPIO 13, SPI MISO |

The display itself is write-only, but the XPT2046 touch controller needs MISO
on GPIO 13. Display and touch share MOSI and SCK while retaining separate chip
selects. The TFT reset can remain tied to the module reset circuit. Firmware
reports the first sample of each press in the serial monitor for calibration;
no Jarvis action is assigned to a touch until the control interface is defined.

## Physical wiring

- ESP32-S3 GPIO 5 to the ring data input through a 330-470 ohm resistor.
- Regulated 5 V to the ring through a fused supply sized for its brightness.
- Regulated display power at the voltage required by the exact TFT breakout.
- ESP32 and LED power-supply grounds connected together.
- 1000 uF capacitor across the ring's 5 V and ground inputs.
- 74AHCT125 level shifter between the ESP32 and ring for reliable 5 V data.

Firmware brightness is capped for the prototype. The final enclosure should
still use a dedicated 5 V supply rather than powering a full-brightness ring
through the ESP32 board.
