'use strict';

const express    = require('express');
const http       = require('http');
const path       = require('path');
const { Server } = require('socket.io');
const { SerialPort }     = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');

const HTTP_PORT = parseInt(process.env.PORT      || '3001');
const BAUD_RATE = parseInt(process.env.BAUD_RATE || '115200');
const SLAVE_ID  = parseInt(process.env.SLAVE_ID  || '1');
const SLAVE_PORT_ENV = process.env.SLAVE_PORT || null;

const ESP32_VIDS = ['303A', '10C4', '1A86', '0403', '0483'];

const app    = express();
const server = http.createServer(app);
const io     = new Server(server);

app.use('/chart.js', express.static(
    path.join(__dirname, 'node_modules', 'chart.js', 'dist')
));
app.use(express.static(path.join(__dirname, 'public')));

// REST: list available ports (so the browser can show them if needed)
app.get('/api/ports', async (_req, res) => {
    res.json(await SerialPort.list());
});

let activePort = null;

async function findPort() {
    const ports = await SerialPort.list();
    console.log('Available serial ports:');
    ports.forEach(p => console.log(`  ${p.path}  VID=${p.vendorId || '?'}`));
    const match = ports.find(p =>
        p.vendorId && ESP32_VIDS.includes(p.vendorId.toUpperCase())
    );
    return match ? match.path : null;
}

async function openPort(portPath) {
    const sp = new SerialPort({ path: portPath, baudRate: BAUD_RATE });
    const parser = sp.pipe(new ReadlineParser({ delimiter: '\n' }));
    activePort = sp;

    sp.on('open', () => {
        console.log(`[Serial] Opened ${portPath} @ ${BAUD_RATE} baud`);
        io.emit('slave-status', { connected: true, port: portPath });
    });

    sp.on('error', err => console.error('[Serial] Error:', err.message));

    sp.on('close', () => {
        console.warn('[Serial] Port closed – retrying in 5s…');
        activePort = null;
        io.emit('slave-status', { connected: false });
        setTimeout(startSerial, 5000);
    });

    parser.on('data', line => {
        line = line.trim();
        if (line) {
            console.log(`[Slave ${SLAVE_ID}] ${line}`);
            io.emit('slave-log', line);
        }
    });
}

async function startSerial() {
    const portPath = SLAVE_PORT_ENV || (await findPort());
    if (!portPath) {
        console.error('[Serial] No ESP32 found. Set SLAVE_PORT or connect the slave. Retrying in 10s…');
        setTimeout(startSerial, 10000);
        return;
    }
    console.log(`[Serial] Using port: ${portPath}`);
    await openPort(portPath);
}

io.on('connection', socket => {
    console.log(`[WS] Client connected: ${socket.id}`);
    socket.emit('slave-id', SLAVE_ID);
    socket.emit('slave-status', {
        connected: !!(activePort && activePort.isOpen),
        port: SLAVE_PORT_ENV || '(auto)',
    });

    socket.on('set-message', msg => {
        if (!activePort || !activePort.isOpen) return;
        const safe = String(msg).replace(/[\r\n]/g, '').slice(0, 20);
        // Encode as Latin-1: each char becomes 1 byte (0x00–0xFF).
        // Chars outside Latin-1 (> U+00FF) become '?' so byte count == char count.
        const latin1 = Buffer.from(
            [...safe].map(c => c.charCodeAt(0) <= 0xFF ? c.charCodeAt(0) : 0x3F)
        );
        activePort.write(Buffer.concat([latin1, Buffer.from([0x0A])]), err => {
            if (err) console.error('[Serial] Write error:', err.message);
        });
        console.log(`[Slave ${SLAVE_ID}] Set message: "${safe}"`);
    });

    socket.on('send', () => {
        if (!activePort || !activePort.isOpen) return;
        activePort.write('SEND\n', err => {
            if (err) console.error('[Serial] Write error:', err.message);
        });
        console.log(`[Slave ${SLAVE_ID}] Trigger send`);
    });
});

server.listen(HTTP_PORT, () => {
    console.log(`\nESP-NOW Slave ${SLAVE_ID} Controller`);
    console.log(`Open: http://localhost:${HTTP_PORT}`);
    console.log(`SLAVE_PORT=${SLAVE_PORT_ENV || '(auto-detect)'}\n`);
    startSerial();
});
