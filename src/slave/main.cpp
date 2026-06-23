#include <Arduino.h>
#include <esp_now.h>
#include <esp_wifi.h>
#include <WiFi.h>

#ifndef SLAVE_ID
#define SLAVE_ID 1
#endif

// Helper macros for compile-time string conversion
#define _STR(x) #x
#define STR(x)  _STR(x)

// Master MAC: defined per-environment in platformio.ini as MASTER_MAC_B0..B5
#ifndef MASTER_MAC_B0
#define MASTER_MAC_B0 0xFF
#define MASTER_MAC_B1 0xFF
#define MASTER_MAC_B2 0xFF
#define MASTER_MAC_B3 0xFF
#define MASTER_MAC_B4 0xFF
#define MASTER_MAC_B5 0xFF
#endif

#define BUTTON_PIN   0    // BOOT button (active LOW)
#define MAX_MSG_LEN  20
#define ESP_NOW_CH   1    // must match master

// Shared XOR key (must match the website)
static const char XOR_KEY[] = "BrasilHexa";

// ---- Data packet sent to master via ESP-NOW ----
// Max 250 bytes payload; this struct is always 162 bytes.
typedef struct __attribute__((packed)) {
    uint8_t slave_id;           // 1 or 2
    uint8_t num_bits;           // valid entries in waveform[]
    int8_t  waveform[160];      // AMI levels: -1, 0, +1
} DataPacket;

static uint8_t masterMAC[6] = {
    MASTER_MAC_B0, MASTER_MAC_B1, MASTER_MAC_B2,
    MASTER_MAC_B3, MASTER_MAC_B4, MASTER_MAC_B5
};

static char    message[MAX_MSG_LEN + 1];
static bool    sendRequested = false;
static String  inputBuffer   = "";

// ---- XOR encrypt/decrypt (symmetric) ----
static void xorCrypt(uint8_t* data, uint8_t len) {
    uint8_t keyLen = (uint8_t)strlen(XOR_KEY);
    for (uint8_t i = 0; i < len; i++) {
        data[i] ^= (uint8_t)XOR_KEY[i % keyLen];
    }
}

// ---- AMI pseudo-ternary encoder ----
// 0-bit → alternates +1 / -1 ; 1-bit → level 0
static uint8_t amiEncode(const uint8_t* bytes, uint8_t byteLen, int8_t* out) {
    uint8_t count    = 0;
    int8_t  polarity = 1;   // first '0' bit becomes +1

    for (uint8_t i = 0; i < byteLen; i++) {
        for (int bit = 7; bit >= 0; bit--) {   // MSB first
            if (!((bytes[i] >> bit) & 1)) {
                out[count++] = polarity;
                polarity = -polarity;
            } else {
                out[count++] = 0;
            }
        }
    }
    return count;
}

// ---- ESP-NOW send callback ----
static void onDataSent(const uint8_t* mac, esp_now_send_status_t status) {
    Serial.print("[SLAVE " STR(SLAVE_ID) "] Send: ");
    Serial.println(status == ESP_NOW_SEND_SUCCESS ? "OK" : "FAIL");
}

void setup() {
    Serial.begin(115200);
    pinMode(BUTTON_PIN, INPUT_PULLUP);

    // Default message
    snprintf(message, sizeof(message), "Slave %d hello", SLAVE_ID);

    WiFi.mode(WIFI_STA);
    WiFi.disconnect();
    esp_wifi_set_channel(ESP_NOW_CH, WIFI_SECOND_CHAN_NONE);

    if (esp_now_init() != ESP_OK) {
        Serial.println("[ERROR] ESP-NOW init failed");
        return;
    }
    esp_now_register_send_cb(onDataSent);

    esp_now_peer_info_t peer = {};
    memcpy(peer.peer_addr, masterMAC, 6);
    peer.channel = ESP_NOW_CH;
    peer.encrypt = false;
    if (esp_now_add_peer(&peer) != ESP_OK) {
        Serial.println("[ERROR] Failed to add master peer");
        return;
    }

    Serial.println("=========================================");
    Serial.println("  Slave " STR(SLAVE_ID) " ready");
    Serial.println("=========================================");
    Serial.println("Commands via Serial Monitor:");
    Serial.println("  <text>  – set message (max 20 chars)");
    Serial.println("  SEND    – transmit current message");
    Serial.println("  BOOT button also triggers send");
    Serial.print("Current message: ");
    Serial.println(message);
}

void loop() {
    // ---- Handle Serial input ----
    while (Serial.available()) {
        char c = (char)Serial.read();
        if (c == '\n' || c == '\r') {
            if (inputBuffer.length() == 0) continue;

            if (inputBuffer == "SEND") {
                sendRequested = true;
            } else if (inputBuffer.length() <= MAX_MSG_LEN) {
                inputBuffer.toCharArray(message, sizeof(message));
                Serial.print("Message updated: ");
                Serial.println(message);
            } else {
                Serial.println("[WARN] Message too long (max 20 chars)");
            }
            inputBuffer = "";
        } else {
            inputBuffer += c;
        }
    }

    // ---- Button (active LOW, debounced) ----
    static bool lastBtn = HIGH;
    bool btn = digitalRead(BUTTON_PIN);
    if (lastBtn == HIGH && btn == LOW) {
        sendRequested = true;
        delay(50);
    }
    lastBtn = btn;

    // ---- Transmit ----
    if (sendRequested) {
        sendRequested = false;

        uint8_t msgLen = (uint8_t)strlen(message);
        uint8_t encrypted[MAX_MSG_LEN];
        memcpy(encrypted, message, msgLen);
        xorCrypt(encrypted, msgLen);

        DataPacket pkt;
        memset(&pkt, 0, sizeof(pkt));
        pkt.slave_id = SLAVE_ID;
        pkt.num_bits = amiEncode(encrypted, msgLen, pkt.waveform);

        Serial.print("[SLAVE " STR(SLAVE_ID) "] Sending \"");
        Serial.print(message);
        Serial.print("\" (");
        Serial.print(pkt.num_bits);
        Serial.println(" bits)");

        esp_now_send(masterMAC, (uint8_t*)&pkt, sizeof(DataPacket));
    }
}
