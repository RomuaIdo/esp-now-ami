'use strict';

// Must match the XOR_KEY in slave/main.cpp
const XOR_KEY = 'BrasilHexa';

// ---- XOR decrypt ----
function xorDecrypt(bytes) {
    const key = XOR_KEY;
    return bytes.map((b, i) => b ^ key.charCodeAt(i % key.length));
}

// ---- AMI decode ----
// Rule: non-zero level (±V) → bit 0 ; zero level → bit 1
function amiDecode(waveform) {
    return waveform.map(v => v !== 0 ? 0 : 1);
}

// Pack bit array (MSB-first) into byte array
function bitsToBytes(bits) {
    const bytes = [];
    for (let i = 0; i + 8 <= bits.length; i += 8) {
        let b = 0;
        for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
        bytes.push(b);
    }
    return bytes;
}

function bytesToString(bytes) {
    return bytes
        .map(b => (b >= 0x20 && b <= 0x7E) || b >= 0xA0 ? String.fromCharCode(b) : '?')
        .join('');
}

function escapeHtml(ch) {
    return ch.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Encrypted bytes as HTML: printable chars shown as-is, non-printable as
// colored \xNN spans so hex escapes are never confused with literal chars.
function encryptedToString(bytes) {
    return bytes
        .map(b => (b >= 0x20 && b <= 0x7E) || b >= 0xA0
            ? escapeHtml(String.fromCharCode(b))
            : `<span class="hex-byte">\\x${b.toString(16).padStart(2, '0')}</span>`)
        .join('');
}

function toHex(bytes) {
    return bytes.map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
}

function bitString(bits) {
    const groups = [];
    for (let i = 0; i < bits.length; i += 8) {
        groups.push(bits.slice(i, i + 8).join(''));
    }
    return groups.join(' ');
}

// ---- Chart.js setup ----
const CHART_COLORS = {
    1: { line: '#00bfff', fill: 'rgba(0,191,255,0.08)' },
    2: { line: '#00e676', fill: 'rgba(0,230,118,0.08)' },
};

function makeChart(canvasId, slaveId) {
    const ctx = document.getElementById(canvasId).getContext('2d');
    return new Chart(ctx, {
        type: 'line',
        data: {
            datasets: [{
                label: `Slave ${slaveId} – AMI`,
                data: [],
                stepped: true,
                borderColor: CHART_COLORS[slaveId].line,
                backgroundColor: CHART_COLORS[slaveId].fill,
                borderWidth: 2,
                pointRadius: 0,
                tension: 0,
            }]
        },
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
                    ticks: {
                        color: '#888',
                        maxTicksLimit: 20,
                        callback: v => Number.isInteger(v) ? v : '',
                    }
                },
                y: {
                    min: -1.6,
                    max: 1.6,
                    ticks: {
                        color: '#aaa',
                        stepSize: 1,
                        callback: v => ({ '-1': '−V', 0: '0', 1: '+V' }[v] ?? ''),
                    },
                    grid: { color: 'rgba(255,255,255,0.1)' },
                }
            },
            plugins: {
                legend: {
                    labels: { color: '#ccc' }
                },
                tooltip: {
                    callbacks: {
                        label: ctx => {
                            const v = ctx.parsed.y;
                            const lvl = v === 0 ? '0 V' : v > 0 ? '+V' : '−V';
                            return `Bit ${ctx.parsed.x}: ${lvl}`;
                        }
                    }
                }
            }
        }
    });
}

// ---- Update a slave panel ----
function updatePanel(chart, slaveId, packet) {
    const { waveform, num_bits } = packet;
    const bits      = amiDecode(waveform);
    const encBytes  = bitsToBytes(bits);
    const decBytes  = xorDecrypt(encBytes);
    const message   = bytesToString(decBytes);

    // Waveform data as {x, y} points; add sentinel to show last bit's full width
    const xyData = waveform.map((v, i) => ({ x: i, y: v }));
    if (xyData.length > 0) xyData.push({ x: num_bits, y: waveform[num_bits - 1] });

    chart.data.datasets[0].data = xyData;
    chart.options.scales.x.max = num_bits;
    chart.update();

    document.getElementById(`bits-${slaveId}`).textContent = bitString(bits);
    document.getElementById(`hex-${slaveId}`).textContent  = toHex(encBytes);
    document.getElementById(`enc-${slaveId}`).innerHTML    = encryptedToString(encBytes);
    document.getElementById(`msg-${slaveId}`).textContent  = message;
    document.getElementById(`ts-${slaveId}`).textContent   =
        `Último pacote: ${new Date().toLocaleTimeString()}`;
}

// ---- Main ----
const charts = {
    1: makeChart('chart-1', 1),
    2: makeChart('chart-2', 2),
};

const socket = io();

socket.on('connect', () => {
    document.getElementById('ws-status').classList.replace('badge-off', 'badge-on');
    document.getElementById('ws-status').textContent = 'WebSocket ✓';
});

socket.on('disconnect', () => {
    document.getElementById('ws-status').classList.replace('badge-on', 'badge-off');
    document.getElementById('ws-status').textContent = 'WebSocket';
});

socket.on('serial-status', ({ connected, port }) => {
    const el = document.getElementById('serial-status');
    if (connected) {
        el.classList.replace('badge-off', 'badge-on');
        el.textContent = `Serial ✓ ${port}`;
    } else {
        el.classList.replace('badge-on', 'badge-off');
        el.textContent = 'Serial (desconectado)';
    }
});

socket.on('waveform-data', packet => {
    const id = packet.slave;
    if (id !== 1 && id !== 2) return;
    updatePanel(charts[id], id, packet);
});
