#include <Arduino.h>
#include <esp_now.h>
#include <esp_wifi.h>
#include <WiFi.h>

#define ESP_NOW_CH 1

typedef struct __attribute__((packed)) {
    uint8_t slave_id;
    uint8_t num_bits;
    int8_t  waveform[160];
} DataPacket;

// ---- Thread-safe slot buffer (callback → loop) ----
static portMUX_TYPE   rxMux    = portMUX_INITIALIZER_UNLOCKED;
static DataPacket     rxSlots[2];
static volatile bool  rxReady[2] = {false, false};

static void onDataRecv(const uint8_t* mac, const uint8_t* data, int len) {
    if (len < 2) return;
    const DataPacket* pkt = reinterpret_cast<const DataPacket*>(data);
    if (pkt->slave_id < 1 || pkt->slave_id > 2) return;

    uint8_t idx = pkt->slave_id - 1;
    portENTER_CRITICAL(&rxMux);
    if (!rxReady[idx]) {
        memcpy(&rxSlots[idx], pkt, sizeof(DataPacket));
        rxReady[idx] = true;
    }
    portEXIT_CRITICAL(&rxMux);
}

void setup() {
    Serial.begin(115200);
    delay(500);

    WiFi.mode(WIFI_STA);
    WiFi.disconnect();
    esp_wifi_set_channel(ESP_NOW_CH, WIFI_SECOND_CHAN_NONE);

    Serial.println("=========================================");
    Serial.println("  ESP-NOW Master");
    Serial.print("  MAC: ");
    Serial.println(WiFi.macAddress());
    Serial.println("  Copy this MAC into platformio.ini");
    Serial.println("  (MASTER_MAC_B0..B5 in slave envs)");
    Serial.println("=========================================");

    if (esp_now_init() != ESP_OK) {
        Serial.println("[ERROR] ESP-NOW init failed");
        return;
    }
    esp_now_register_recv_cb(onDataRecv);

    Serial.println("[MASTER] Ready – waiting for slave data...");
}

void loop() {
    for (uint8_t i = 0; i < 2; i++) {
        DataPacket pkt;

        portENTER_CRITICAL(&rxMux);
        bool ready = rxReady[i];
        if (ready) {
            memcpy(&pkt, &rxSlots[i], sizeof(DataPacket));
            rxReady[i] = false;
        }
        portEXIT_CRITICAL(&rxMux);

        if (!ready) continue;

        // Print complete JSON in one go — no interleaving risk
        Serial.print("{\"slave\":");
        Serial.print(pkt.slave_id);
        Serial.print(",\"num_bits\":");
        Serial.print(pkt.num_bits);
        Serial.print(",\"waveform\":[");
        for (uint8_t j = 0; j < pkt.num_bits; j++) {
            if (j > 0) Serial.print(',');
            Serial.print((int)pkt.waveform[j]);
        }
        Serial.println("]}");
    }
}
