# Arduino on an ESP32

The same device as the ESPHome example — a pump relay and a DHT22 — written
with the Arduino core for ESP32 and three libraries from the Library Manager:
**PubSubClient** (Nick O'Leary, 2.8 or later), **ArduinoJson** (7.x) and
**DHT sensor library** (Adafruit).

## `secrets.h` — the person fills this in; list it in `.gitignore`

```cpp
#pragma once
#define WIFI_SSID      "…"
#define WIFI_PASSWORD  "…"
#define HUB_ADDRESS    "192.168.1.50"   // the hub's IP address
#define MQTT_PASSWORD  "…"              // gethome studio → the hub → Zigbee & MQTT
```

Commit a `secrets.h.example` with the same lines and placeholder values.

## `greenhouse.ino`

```cpp
#include <WiFi.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <DHT.h>
#include "secrets.h"

static const char *DEVICE_ID = "greenhouse";
static const int RELAY_PIN = 26;            // many relay modules are active LOW: swap HIGH/LOW
static const char *DISCOVERY = R"({
  "name": "Greenhouse", "vendor": "DIY", "model": "ESP32 relay board",
  "endpoints": [
    {"endpointId": 1, "deviceKind": "appliance", "capabilities": ["onOff"], "primary": "onOff"},
    {"endpointId": 2, "deviceKind": "sensor", "capabilities": ["temperature", "humidity"], "primary": "temperature"}
  ]
})";

DHT dht(27, DHT22);
WiFiClient network;
PubSubClient mqtt(network);
bool pumpOn = false;
unsigned long lastClimate = 0, lastAttempt = 0, lastBeat = 0;

String topic(const char *suffix) { return String("gethome/device/") + DEVICE_ID + suffix; }

void publishPump() {
  mqtt.publish(topic("/state").c_str(), pumpOn ? "{\"onOff\":true}" : "{\"onOff\":false}", true);
}

void publishClimate() {
  float celsius = dht.readTemperature(), humidity = dht.readHumidity();
  if (isnan(celsius) || isnan(humidity)) return;   // a failed read sends nothing
  char payload[96];
  snprintf(payload, sizeof payload, "{\"sensors\":{\"temperatureCenti\":%ld,\"humidityCenti\":%ld}}",
           lroundf(celsius * 100), lroundf(humidity * 100));
  mqtt.publish(topic("/state/2").c_str(), payload, true);
}

void setPump(bool on) {
  pumpOn = on;
  digitalWrite(RELAY_PIN, on ? HIGH : LOW);
  publishPump();                              // the report is what tells the apps it worked
}

void onMessage(char *, byte *payload, unsigned int length) {
  JsonDocument command;
  if (deserializeJson(command, payload, length)) return;   // not JSON: ignore
  const char *type = command["type"] | "";
  if (strcmp(type, "power") == 0) setPump(command["on"] | false);
  else if (strcmp(type, "toggle") == 0) setPump(!pumpOn);
  // Any other type is not this device's to do: ignore it.
}

bool connectToHub() {
  String clientId = String("gethome-") + DEVICE_ID;
  String availability = topic("/availability");
  if (!mqtt.connect(clientId.c_str(), "gethome", MQTT_PASSWORD,
                    availability.c_str(), 1, true, "offline")) {   // last will, retained
    return false;                              // mqtt.state() 4 or 5: username or password refused
  }
  mqtt.publish((String("gethome/discovery/") + DEVICE_ID + "/config").c_str(), DISCOVERY, true);
  mqtt.publish(availability.c_str(), "online", true);
  mqtt.publish(topic("/heartbeat").c_str(), "60", true);   // how often we speak, in seconds
  lastBeat = millis();
  publishPump();
  publishClimate();
  mqtt.subscribe(topic("/set").c_str());     // endpoint 1's commands; endpoint 2 takes none
  return true;
}

void setup() {
  pinMode(RELAY_PIN, OUTPUT);
  digitalWrite(RELAY_PIN, LOW);               // a known, safe state at boot
  dht.begin();
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  mqtt.setServer(HUB_ADDRESS, 1883);
  mqtt.setBufferSize(1024);                   // the default 256 bytes cannot hold the document
  mqtt.setCallback(onMessage);
}

void loop() {
  if (WiFi.status() != WL_CONNECTED) { delay(500); return; }
  if (!mqtt.connected()) {
    if (millis() - lastAttempt > 5000) { lastAttempt = millis(); connectToHub(); }
    return;
  }
  mqtt.loop();
  if (millis() - lastClimate > 60000) { lastClimate = millis(); publishClimate(); }
  if (millis() - lastBeat > 60000) { lastBeat = millis(); mqtt.publish(topic("/heartbeat").c_str(), "60", true); }
}
```

## Why it is written this way

- **`setBufferSize(1024)`** — PubSubClient's default packet buffer is 256
  bytes including the topic, and a publish that does not fit fails by
  returning `false`, silently. The discovery document alone is larger.
- **The last will is set in `connect()`** (`willQos` 1, `willRetain` true), so
  the broker publishes `offline` for the board if it vanishes without saying
  goodbye — power cut, crash, Wi-Fi lost. PubSubClient's keepalive is 15 s, so
  that is about 22 s after the board goes.
- **A heartbeat every minute**, retained: only a running broker sends a will,
  and a hub that lost power comes back holding the board's `online`. With the
  heartbeat, a board that stays quiet for two and a half minutes reads offline
  all the same.
- **Everything is published again on every connection**, document first,
  because the hub drops state from a device whose document it has not seen.
- **Commands are applied, then reported**; an unknown `type` is ignored.
- **`lroundf(… * 100)`** sends integers, which the hub requires.
- To decide what the relay does while the hub is unreachable, act in the
  `!mqtt.connected()` branch — for example switch the pump off after a few
  minutes without a connection.

## Variations

- **More endpoints**: subscribe to `topic("/set/3")` as well, and branch on
  the topic in `onMessage` — endpoint 1's commands arrive on `…/set`, never on
  `…/set/1`.
- **A dimmer**: on `setLevel`, read `command["level"] | 254` (1–254) and
  convert to your PWM range; report
  `{"level":{"current":…,"min":1,"max":254}}`. Do not switch the light on.
- **A `custom` field**: on `setCustomField`, read `command["fieldId"]` and
  `command["value"]`, apply it, and report `{"custom":{"values":{"<fieldId>":…}}}`.
