'use strict';

const XOR_KEY = 'ESP32Key2024';  // must match slave firmware

const COLORS = {
    1: { line: '#00bfff', fill: 'rgba(0,191,255,0.08)' },
    2: { line: '#00e676', fill: 'rgba(0,230,118,0.08)' },
};
const MAX_LOG_LINES = 60;
const logLines = [];

let slaveId = 1;

// ---- DOM refs ----
const elLabel        = document.getElementById('slave-label');
const elWsStatus     = document.getElementById('ws-status');
const elSerialStatus = document.getElementById('serial-status');
const elInput        = document.getElementById('msg-input');
const elCharCount    = document.getElementById('char-count');
const elBtnSet       = document.getElementById('btn-set');
const elBtnSend      = document.getElementById('btn-send');
const elBitsOut      = document.getElementById('bits-out');
const elHexOut       = document.getElementById('hex-out');
const elEncOut       = document.getElementById('enc-out');
const elLog          = document.getElementById('serial-log');
const elBtnClearLog  = document.getElementById('btn-clear-log');
const elWaveformHint = document.getElementById('waveform-hint');

// ---- Encoding (mirrors slave firmware) ----

function xorEncrypt(str) {
    const bytes = [];
    for (let i = 0; i < str.length; i++) {
        bytes.push(str.charCodeAt(i) ^ XOR_KEY.charCodeAt(i % XOR_KEY.length));
    }
    return bytes;
}

// 0-bit → alternates ±1 ; 1-bit → 0  (matches firmware amiEncode)
function amiEncode(bytes) {
    const waveform = [];
    let polarity = 1;
    for (const byte of bytes) {
        for (let bit = 7; bit >= 0; bit--) {
            if (!((byte >> bit) & 1)) {
                waveform.push(polarity);
                polarity = -polarity;
            } else {
                waveform.push(0);
            }
        }
    }
    return waveform;
}

function toHex(bytes) {
    return bytes.map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
}

function bitString(bytes) {
    const groups = [];
    for (const b of bytes) {
        groups.push(b.toString(2).padStart(8, '0'));
    }
    return groups.join(' ');
}

function encryptedToString(bytes) {
    return bytes
        .map(b => (b >= 32 && b < 127) ? String.fromCharCode(b) : `\\x${b.toString(16).padStart(2, '0')}`)
        .join('');
}

// ---- Chart ----

const chart = new Chart(
    document.getElementById('waveform-chart').getContext('2d'),
    {
        type: 'line',
        data: { datasets: [{ data: [], stepped: true, borderWidth: 2, pointRadius: 0, tension: 0 }] },
        options: {
            animation: false,
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                x: {
                    type: 'linear',
                    title: { display: true, text: 'Bit', color: '#aaa' },
                    min: 0,
                    grid: { color: 'rgba(255,255,255,0.07)' },
                    ticks: { color: '#888', maxTicksLimit: 20, callback: v => Number.isInteger(v) ? v : '' },
                },
                y: {
                    min: -1.6, max: 1.6,
                    ticks: {
                        color: '#aaa',
                        stepSize: 1,
                        callback: v => ({ '-1': '−V', 0: '0', 1: '+V' }[v] ?? ''),
                    },
                    grid: { color: 'rgba(255,255,255,0.1)' },
                },
            },
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        label: ctx => {
                            const v = ctx.parsed.y;
                            return `Bit ${ctx.parsed.x}: ${v === 0 ? '0 V' : v > 0 ? '+V' : '−V'}`;
                        }
                    }
                }
            }
        }
    }
);

function applySlaveColors(id) {
    const c = COLORS[id] || COLORS[1];
    chart.data.datasets[0].borderColor     = c.line;
    chart.data.datasets[0].backgroundColor = c.fill;
    chart.data.datasets[0].label = `Slave ${id} – AMI`;
    chart.update();
}

function updateWaveform(msg) {
    if (!msg) {
        chart.data.datasets[0].data = [];
        chart.update();
        elBitsOut.textContent = '—';
        elHexOut.textContent  = '—';
        elEncOut.textContent  = '—';
        return;
    }

    const encBytes = xorEncrypt(msg);
    const waveform = amiEncode(encBytes);
    const numBits  = waveform.length;

    const xyData = waveform.map((v, i) => ({ x: i, y: v }));
    if (xyData.length > 0) xyData.push({ x: numBits, y: waveform[numBits - 1] });

    chart.data.datasets[0].data = xyData;
    chart.options.scales.x.max  = numBits;
    chart.update();

    elBitsOut.textContent = bitString(encBytes);
    elHexOut.textContent  = toHex(encBytes);
    elEncOut.textContent  = encryptedToString(encBytes);
}

// ---- Slave ID theming ----

function setSlaveId(id) {
    slaveId = id;
    const color = COLORS[id]?.line || '#e6edf3';
    elLabel.textContent    = id;
    elLabel.style.color    = color;
    elLabel.style.borderColor = color;
    document.title         = `ESP-NOW · Slave ${id} Controller`;
    elBtnSend.style.borderColor = color;
    elBtnSend.style.color       = color;
    elBtnSend.style.background  = `${color}1a`;
    applySlaveColors(id);
}

// ---- Log ----

function appendLog(line) {
    const ts = new Date().toLocaleTimeString();
    logLines.push(`[${ts}] ${line}`);
    if (logLines.length > MAX_LOG_LINES) logLines.shift();
    elLog.textContent = logLines.join('\n');
    elLog.scrollTop   = elLog.scrollHeight;
}

// ---- Actions ----

function doSetMessage() {
    const msg = elInput.value.trim();
    if (!msg) return;
    socket.emit('set-message', msg);
    appendLog(`→ Set message: "${msg}"`);
}

function doSend() {
    const msg = elInput.value.trim();
    if (msg) updateWaveform(msg);        // ensure chart reflects current text
    elWaveformHint.textContent = '(última mensagem enviada)';
    socket.emit('send');
    appendLog('→ SEND');
}

// ---- Socket ----

const socket = io();

socket.on('connect', () => {
    elWsStatus.classList.replace('badge-off', 'badge-on');
    elWsStatus.textContent = 'WebSocket ✓';
});

socket.on('disconnect', () => {
    elWsStatus.classList.replace('badge-on', 'badge-off');
    elWsStatus.textContent = 'WebSocket';
});

socket.on('slave-id', id => setSlaveId(id));

socket.on('slave-status', ({ connected, port }) => {
    if (connected) {
        elSerialStatus.classList.replace('badge-off', 'badge-on');
        elSerialStatus.textContent = `Serial ✓ ${port}`;
    } else {
        elSerialStatus.classList.replace('badge-on', 'badge-off');
        elSerialStatus.textContent = 'Serial (desconectado)';
    }
});

socket.on('slave-log', line => appendLog(line));

// ---- UI events ----

elInput.addEventListener('input', () => {
    const len = elInput.value.length;
    elCharCount.textContent = `${len} / 20`;
    elCharCount.classList.toggle('over', len >= 20);
    elWaveformHint.textContent = '(prévia — atualiza ao digitar)';
    updateWaveform(elInput.value.trim());
});

elInput.addEventListener('keydown', e => {
    if (e.key === 'Enter' && e.ctrlKey) { doSetMessage(); doSend(); }
    else if (e.key === 'Enter')          { doSetMessage(); }
});

elBtnSet.addEventListener('click', doSetMessage);
elBtnSend.addEventListener('click', doSend);
elBtnClearLog.addEventListener('click', () => {
    logLines.length   = 0;
    elLog.textContent = '—';
});

// Init
setSlaveId(1);
