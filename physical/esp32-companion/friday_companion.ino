// Friday desk companion — ESP32-S3 firmware (Arduino-ESP32 core 3.x).
// STATUS: written against Friday's tested server protocol, but NOT compiled or run on hardware yet
// (no ESP32 toolchain/board was available while building it). Expect to debug pin maps and I2S on the bench.
//
// Hardware (see README.md): SSD1306 128x64 OLED (I2C), 2x micro servos (pan/tilt), push-to-talk button,
// I2S MEMS mic (INMP441), I2S amp (MAX98357A), LD2410/PIR presence sensor, status LED.
//
// Protocol (all HTTPS to your Friday server, Authorization: Bearer <device token, scopes read+chat>):
//   GET  /v1/companion/stream   SSE: event "state" data {"state":"researching","detail":..,"unread":n,...}
//   POST /v1/companion/events   {"type":"presence"|"absence"|"button"}
//   POST /v1/voice/ask          body: audio/wav (16 kHz mono 16-bit) -> audio/wav reply (X-Friday-* headers = texts)
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <ESP32Servo.h>
#include <ArduinoJson.h>
#include "secrets.h"   // WIFI_SSID, WIFI_PASS, FRIDAY_HOST ("friday.tailnet.ts.net"), FRIDAY_TOKEN ("fdv_...")

#define PIN_SDA 8
#define PIN_SCL 9
#define PIN_SERVO_PAN 4
#define PIN_SERVO_TILT 5
#define PIN_BUTTON 0
#define PIN_PRESENCE 6
#define PIN_LED 48

Adafruit_SSD1306 oled(128, 64, &Wire, -1);
Servo pan, tilt;
WiFiClientSecure tls;
String state = "offline";
unsigned long lastBlink = 0, lastDraw = 0, lastPresence = 0;
bool present = false;

// ---- face -------------------------------------------------------------------
void eyes(int openL, int openR, int dx, int dy) {         // two rounded-rect eyes; openX in px height
  oled.clearDisplay();
  oled.fillRoundRect(24 + dx, 20 + dy + (28 - openL) / 2, 32, openL, 8, SSD1306_WHITE);
  oled.fillRoundRect(72 + dx, 20 + dy + (28 - openR) / 2, 32, openR, 8, SSD1306_WHITE);
}
void drawFace(unsigned long t) {
  int blink = ((t / 3200) % 1 == 0 && (t % 3200) < 140) ? 3 : 28;
  if (state == "idle")            { eyes(blink, blink, 0, 0); }
  else if (state == "listening")  { eyes(30, 30, 0, -2); }
  else if (state == "thinking" || state == "planning") { int d = (t / 300) % 4; eyes(18, 18, d == 1 ? -8 : d == 3 ? 8 : 0, -6); }
  else if (state == "researching" || state == "browsing") { int d = (t / 250) % 6; eyes(22, 22, d < 3 ? d * 4 - 4 : 8 - (d - 3) * 4, 0); }
  else if (state == "coding" || state == "computer_use")   { eyes(14, 14, 0, 4 + (t / 120) % 3); }
  else if (state == "waiting")    { eyes(10, 10, 0, 6); }
  else if (state == "success")    { eyes(26, 26, 0, -4); oled.fillRect(24, 40, 80, 8, SSD1306_BLACK); }      // happy squint
  else if (state == "error")      { eyes(8, 20, 0, 0); }                                                       // annoyed
  else if (state == "offline")    { eyes(3, 3, 0, 8); }                                                        // asleep
  else                            { eyes(blink, blink, 0, 0); }
  oled.display();
}
void headFor() {                                              // simple, state-driven head motion
  if (state == "listening") { pan.write(90); tilt.write(80); }
  else if (state == "success") { tilt.write(70 + (millis() / 150) % 2 * 20); }
  else if (state == "error") { pan.write(90 + (millis() / 120) % 2 * 12 - 6); }
  else if (state == "thinking") { pan.write(80 + (millis() / 700) % 2 * 20); }
  else if (state == "offline") { tilt.write(110); }
}

// ---- network ------------------------------------------------------------------
void post(const char* path, const String& json) {
  HTTPClient http; http.begin(tls, String("https://") + FRIDAY_HOST + path);
  http.addHeader("Authorization", String("Bearer ") + FRIDAY_TOKEN); http.addHeader("Content-Type", "application/json");
  http.POST(json); http.end();
}
void handleStateLine(const String& line) {                    // "data: {...}"
  JsonDocument doc; if (deserializeJson(doc, line.substring(6))) return;
  state = doc["state"].as<String>();
  digitalWrite(PIN_LED, (doc["unread"] | 0) > 0 ? HIGH : LOW);
}
void streamLoop() {                                           // blocks while connected; caller reconnects
  if (!tls.connect(FRIDAY_HOST, 443)) { state = "offline"; delay(3000); return; }
  tls.print(String("GET /v1/companion/stream HTTP/1.1\r\nHost: ") + FRIDAY_HOST + "\r\nAuthorization: Bearer " + FRIDAY_TOKEN + "\r\nAccept: text/event-stream\r\nConnection: keep-alive\r\n\r\n");
  while (tls.connected()) {
    while (tls.available()) { String l = tls.readStringUntil('\n'); l.trim(); if (l.startsWith("data: ")) handleStateLine(l); }
    unsigned long now = millis();
    if (now - lastDraw > 40) { lastDraw = now; drawFace(now); headFor(); }
    bool pr = digitalRead(PIN_PRESENCE);
    if (pr != present && now - lastPresence > 5000) { present = pr; lastPresence = now; post("/v1/companion/events", pr ? "{\"type\":\"presence\"}" : "{\"type\":\"absence\"}"); }
    if (digitalRead(PIN_BUTTON) == LOW) { askByVoice(); }
  }
  tls.stop(); state = "offline";
}

// Push-to-talk: record while the button is held, POST wav to /v1/voice/ask, play the answer.
void askByVoice() {
  // TODO(bench): record 16 kHz mono PCM into PSRAM via I2S (INMP441) while PIN_BUTTON is LOW, wrap in a WAV header,
  // POST to /v1/voice/ask with the Bearer token, stream the returned WAV to the MAX98357A over I2S.
  // Server returns 501 {"error":"stt_not_installed"} until whisper.cpp/piper are installed there.
  post("/v1/companion/events", "{\"type\":\"button\"}");
  delay(400);
}

void setup() {
  pinMode(PIN_BUTTON, INPUT_PULLUP); pinMode(PIN_PRESENCE, INPUT); pinMode(PIN_LED, OUTPUT);
  Wire.begin(PIN_SDA, PIN_SCL); oled.begin(SSD1306_SWITCHCAPVCC, 0x3C);
  pan.attach(PIN_SERVO_PAN); tilt.attach(PIN_SERVO_TILT); pan.write(90); tilt.write(90);
  WiFi.begin(WIFI_SSID, WIFI_PASS); while (WiFi.status() != WL_CONNECTED) { drawFace(millis()); delay(200); }
  tls.setInsecure();   // TODO: pin your server's CA / Tailscale cert instead of skipping verification
}
void loop() { streamLoop(); }
