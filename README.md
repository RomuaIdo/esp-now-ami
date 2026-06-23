# ESP-NOW AMI Waveform

Projeto com 1 master + 2 slaves ESP32-S3 comunicando via ESP-NOW. As slaves codificam mensagens em AMI pseudo-ternário com criptografia XOR e enviam ao master, que repassa ao PC via Serial. Um servidor Node.js exibe as formas de onda em tempo real no navegador.

## Arquitetura

```
[Slave 1] ──ESP-NOW──┐
                      ├──► [Master] ──Serial USB──► [PC Master]
[Slave 2] ──ESP-NOW──┘                               └─ website/ (porta 3000)

[PC Slave 1] ──Serial USB──► [Slave 1]
└─ website-slave/ (porta 3001)

[PC Slave 2] ──Serial USB──► [Slave 2]
└─ website-slave/ (porta 3002)
```

## Hardware

| Dispositivo | Placa             | Papel   |
|-------------|-------------------|---------|
| Master      | ESP32-S3 SuperMini | Roteador Serial↔ESP-NOW |
| Slave 1     | ESP32-S3 DevKit   | Transmissor |
| Slave 2     | ESP32-S3 DevKit   | Transmissor |

## Protocolo

- **Codificação:** AMI pseudo-ternário — bit `0` alterna entre +V e −V; bit `1` permanece em 0 V
- **Criptografia:** XOR com chave `ESP32Key2024` (simétrica, aplicada antes da codificação AMI)
- **Transporte:** ESP-NOW canal 1, sem criptografia de camada

## Estrutura do projeto

```
├── platformio.ini          # Configuração PlatformIO (master, slave1, slave2, supermini)
├── src/
│   ├── master/main.cpp     # Firmware do master
│   └── slave/main.cpp      # Firmware compartilhado dos slaves (SLAVE_ID via build flag)
├── website/                # Interface de exibição (PC Master)
│   ├── server.js
│   └── public/
└── website-slave/          # Interface de controle (PC Slave)
    ├── server.js
    └── public/
```

## Configuração do firmware

### 1. Obter o MAC do master

Grave e abra o monitor Serial do master (`pio run -e supermini -t upload`). O MAC é impresso na inicialização:

```
MAC: AA:BB:CC:DD:EE:FF
```

### 2. Atualizar `platformio.ini`

Nos ambientes `[env:slave1]` e `[env:slave2]`, substitua os valores `0xFF` pelo MAC real do master:

```ini
-DMASTER_MAC_B0=0xAA
-DMASTER_MAC_B1=0xBB
-DMASTER_MAC_B2=0xCC
-DMASTER_MAC_B3=0xDD
-DMASTER_MAC_B4=0xEE
-DMASTER_MAC_B5=0xFF
```

### 3. Gravar slaves

```bash
pio run -e slave1 -t upload
pio run -e slave2 -t upload
```

## Website — Exibição (PC Master)

```bash
cd website
npm install
node server.js          # auto-detecta a porta Serial do master
```

Acesse `http://localhost:3000`. Exibe para cada slave:
- Forma de onda AMI
- Bits decodificados
- Bytes em hexadecimal
- Mensagem cifrada e decifrada

## Website-slave — Controle (PC Slave)

```bash
cd website-slave
npm install
SLAVE_ID=1 node server.js   # slave 1, porta HTTP 3001
```

Acesse `http://localhost:3001`. Permite:
- Digitar a mensagem e visualizar a forma de onda AMI em tempo real (prévia)
- Definir a mensagem na slave via Serial
- Disparar o envio ESP-NOW

### Variáveis de ambiente

| Variável     | Padrão       | Descrição                          |
|--------------|--------------|------------------------------------|
| `SLAVE_ID`   | `1`          | ID visual da slave (1 ou 2)        |
| `SLAVE_PORT` | auto-detecta | Porta Serial da slave              |
| `PORT`       | `3001`       | Porta HTTP do servidor             |
| `BAUD_RATE`  | `115200`     | Velocidade Serial                  |

### Teste com tudo no mesmo PC

```bash
# Terminal 1 — master display
cd website && node server.js

# Terminal 2 — slave 1
cd website-slave && SLAVE_ID=1 SLAVE_PORT=/dev/ttyACM1 node server.js

# Terminal 3 — slave 2
cd website-slave && SLAVE_ID=2 SLAVE_PORT=/dev/ttyACM2 PORT=3002 node server.js
```

## Comandos Serial (slaves)

Os slaves também aceitam comandos diretos pelo monitor Serial:

| Comando      | Efeito                             |
|--------------|------------------------------------|
| `<texto>`    | Define a mensagem (máx. 20 chars)  |
| `SEND`       | Dispara o envio imediatamente      |
| Botão BOOT   | Dispara o envio                    |
