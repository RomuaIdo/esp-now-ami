'use strict';

const express    = require('express');
const http       = require('http');
const path       = require('path');
const { Server } = require('socket.io');
const { SerialPort }       = require('serialport');
const { ReadlineParser }   = require('@serialport/parser-readline');

const PORT        = process.env.PORT        || 3000;
const BAUD_RATE   = parseInt(process.env.BAUD_RATE || '115200');
const SERIAL_PORT = process.env.SERIAL_PORT || null;  // null = auto-detect

const app    = express();
const server = http.createServer(app);
const io     = new Server(server);

// Serve Chart.js from node_modules so no external CDN is required
app.use('/chart.js', express.static(
    path.join(__dirname, 'node_modules', 'chart.js', 'dist')
));
app.use(express.static(path.join(__dirname, 'public')));

// REST: list available serial ports
app.get('/api/ports', async (_req, res) => {
    const ports = await SerialPort.list();
    res.json(ports);
});

// REST: current state (last packet from each slave)
const slaveData = { 1: null, 2: null };
app.get('/api/state', (_req, res) => res.json(slaveData));

// ---- Serial port ----

const ESP32_VIDS = ['303A','10C4', '1A86', '0403', '0483'];  // CP210x, CH340, FTDI, STM32

async function findESP32Port() {
    const ports = await SerialPort.list();
    console.log('Available serial ports:');
    ports.forEach(p => console.log(`  ${p.path}  VID=${p.vendorId || '?'} PID=${p.productId || '?'}`));

    const match = ports.find(p =>
        p.vendorId && ESP32_VIDS.includes(p.vendorId.toUpperCase())
    );
    return match ? match.path : null;
}

async function openSerial(portPath) {
    const sp = new SerialPort({ path: portPath, baudRate: BAUD_RATE });
    const parser = sp.pipe(new ReadlineParser({ delimiter: '\n' }));

    sp.on('open',  () => console.log(`[Serial] Opened ${portPath} @ ${BAUD_RATE} baud`));
    sp.on('error', err => console.error('[Serial] Error:', err.message));
    sp.on('close', () => {
        console.warn('[Serial] Port closed – retrying in 5s…');
        io.emit('serial-status', { connected: false });
        setTimeout(() => startSerial(), 5000);
    });

    parser.on('data', line => {
        line = line.trim();
        if (!line.startsWith('{')) return;  // ignore non-JSON lines

        let packet;
        try {
            packet = JSON.parse(line);
        } catch {
            return;
        }

        if (!packet || typeof packet.slave !== 'number' ||
            !Array.isArray(packet.waveform)) return;

        const slaveId = packet.slave;
        slaveData[slaveId] = packet;

        console.log(`[Data] Slave ${slaveId}: ${packet.num_bits} bits`);
        io.emit('waveform-data', packet);
    });

    io.emit('serial-status', { connected: true, port: portPath });
}

async function startSerial() {
    const portPath = SERIAL_PORT || (await findESP32Port());

    if (!portPath) {
        console.error(
            '[Serial] No ESP32 found. Set SERIAL_PORT env var or connect the master ESP32.\n' +
            '         Retrying in 10s…'
        );
        setTimeout(startSerial, 10000);
        return;
    }

    console.log(`[Serial] Using port: ${portPath}`);
    await openSerial(portPath);
}

// ---- Socket.io ----
io.on('connection', socket => {
    console.log(`[WS] Client connected: ${socket.id}`);

    // Send current state to newly connected client
    if (slaveData[1]) socket.emit('waveform-data', slaveData[1]);
    if (slaveData[2]) socket.emit('waveform-data', slaveData[2]);
});

// ---- Start ----
server.listen(PORT, () => {
    console.log(`\nESP-NOW Waveform Display\nOpen: http://localhost:${PORT}\n`);
    startSerial();
});
