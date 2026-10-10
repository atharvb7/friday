# Friday desk companion (ESP32-S3) — v1 prototype

One Friday, one body more. The device is a **display + senses**; all intelligence stays on the server.
Status: **protocol side is implemented and tested on the server; the firmware is untested on hardware.**

## Bill of materials (~US$40)
ESP32-S3 DevKitC-1 (N16R8, PSRAM) · SSD1306 0.96" I2C OLED · 2× SG90 micro servos (pan/tilt) · INMP441 I2S mic ·
MAX98357A I2S amp + 3 W speaker · LD2410C mmWave (or HC-SR501 PIR) presence sensor · momentary button · LED · USB-C 5 V/2 A.
A 3D-printed shell/head mount is for the design students; reserve: mic opening, speaker grille, OLED window, servo cradle.

## Pair it
```bash
node bin/friday.mjs device add desk-companion read,chat   # copy the token into secrets.h
cp secrets.h.example secrets.h   # edit; open friday_companion.ino in Arduino IDE (ESP32 core 3.x)
# libraries: Adafruit SSD1306, Adafruit GFX, ESP32Servo, ArduinoJson (v7)
```
The server is on your tailnet: use `tailscale serve --https=443 http://127.0.0.1:4317` so the device can reach HTTPS.

## Protocol (tested server side: test/companion.test.mjs, test/voice-server.test.mjs)
| Direction | Endpoint | Notes |
|---|---|---|
| ↓ | `GET /v1/companion/stream` (SSE) | `event: state`, `{"state","detail","pet","unread","approvals","nodeOnline"}`; states: idle listening thinking planning researching browsing coding computer_use speaking waiting verifying success error offline |
| ↑ | `POST /v1/companion/events` | `{"type":"presence"|"absence"|"button","distanceCm"?}` — telemetry only, no authority |
| ↕ | `POST /v1/voice/ask` | wav (16 kHz mono) in → wav out; text in `X-Friday-Heard` / `X-Friday-Reply` (URL-encoded) |

Deterministic things stay on the device (blink timing, servo easing, LED); the model is never used for them.
Voice needs server-side engines: set `FRIDAY_WHISPER_BIN/MODEL` (whisper.cpp) and `FRIDAY_PIPER_BIN/MODEL` (Piper).
Raw audio is processed in a temp dir and deleted immediately.

## Next on the bench
1. Compile + fix pin map. 2. Implement `askByVoice()` I2S record/play. 3. Pin the TLS certificate. 4. Tune eye animations with the shared pet style.
