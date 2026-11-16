'use strict';

// Must match the XOR_KEY in src/slave/main.cpp
const XOR_KEY = 'BrasilHexa';
const MAX_LEN = 20;
const MAX_LOG_LINES = 200;

const $ = id => document.getElementById(id);

const elInput   = $('msg-input');
const elPayload = $('payload');
const elCount   = $('payload-count');
const elLog     = $('serial-log');
const elCursor  = $('cursor');
const canvas    = $('waveform');

// ---- Encoding (mirrors slave firmware) ----

// Latin-1 bytes; chars above U+00FF become '?' (same as server.js)
const toLatin1 = str => [...str].map(c => c.charCodeAt(0) <= 0xFF ? c.charCodeAt(0) : 0x3F);

const xorBytes = bytes => bytes.map((b, i) => b ^ XOR_KEY.charCodeAt(i % XOR_KEY.length));

// bit 0 → alternating ±1 ; bit 1 → 0  (matches firmware amiEncode)
function amiEncode(bytes) {
    const waveform = [];
    let polarity = 1;
    for (const byte of bytes) {
        for (let bit = 7; bit >= 0; bit--) {
            if ((byte >> bit) & 1) waveform.push(0);
            else { waveform.push(polarity); polarity = -polarity; }
        }
    }
    return waveform;
}

const levelName = v => v === 0 ? '0 V' : v > 0 ? '+V' : '−V';

function timeStamp() {
    const d = new Date();
    return d.toLocaleTimeString('pt-BR', { hour12: false }) +
        '.' + String(d.getMilliseconds()).padStart(3, '0');
}

// ---- Scope ----

const scope = new AmiScope(canvas, {
    emptyText: 'Digite uma mensagem para ver a forma de onda',
    onCursor: info => {
        elCursor.textContent = info
            ? `Bit ${info.bit} (byte ${info.byte}, bit ${7 - info.bitInByte} MSB)  nível ${levelName(info.level)}  valor ${info.value}` +
              `  byte cifrado 0x${AMI.hex2(info.enc)}  texto '${AMI.charLabel(info.plain)}'`
            : 'Passe o cursor sobre a forma de onda para medir um bit.';
    },
});

function updateWaveform(msg) {
    const plain    = toLatin1(msg.slice(0, MAX_LEN));
    const enc      = xorBytes(plain);
    const waveform = amiEncode(enc);
    const st       = AMI.stats(waveform);
    const empty    = !plain.length;

    scope.setData(waveform, enc, plain);

    $('m-bits').textContent  = empty ? '—' : st.bits;
    $('m-bytes').textContent = empty ? '—' : st.bytes;
    $('m-pos').textContent   = empty ? '—' : st.pos;
    $('m-neg').textContent   = empty ? '—' : st.neg;
    $('m-zero').textContent  = empty ? '—' : st.zero;
    $('m-dc').textContent    = empty ? '—' : (st.dc > 0 ? `+${st.dc}` : st.dc);

    $('bits-out').textContent = empty ? '—' : enc.map(AMI.bin8).join(' ');
    $('hex-out').textContent  = empty ? '—' : AMI.toHex(enc);
    $('enc-out').innerHTML    = empty ? '—' : AMI.bytesToHtml(enc);

    canvas.setAttribute('aria-label', empty
        ? 'Forma de onda AMI: sem sinal'
        : `Forma de onda AMI: ${st.bits} bits para a mensagem "${msg}"`);
    AMI.renderByteTable($('byte-table'), { plain, enc, key: XOR_KEY });
}

// ---- Payload meter ----

for (let i = 0; i < MAX_LEN; i++) elPayload.append(document.createElement('i'));

function updatePayload() {
    const len = toLatin1(elInput.value).length;
    [...elPayload.children].forEach((c, i) => c.classList.toggle('on', i < len));
    elCount.querySelector('output').textContent = `${len} / ${MAX_LEN} bytes`;
    elCount.classList.toggle('full', len >= MAX_LEN);
}

// ---- Slave ID theming ----

function setSlaveId(id) {
    document.body.dataset.ch = id;
    $('slave-label').textContent = `Slave ${id}`;
    $('ch-tag').textContent = `CH${id}`;
    document.title = `AMI Transmitter · Slave ${id}`;
    scope.draw();  // trace color comes from CSS
}

// ---- Serial console ----

const logLines = [];

function appendLog(line, outgoing = false) {
    logLines.push({ ts: timeStamp(), line, outgoing });
    if (logLines.length > MAX_LOG_LINES) logLines.shift();

    const stick = elLog.scrollTop + elLog.clientHeight >= elLog.scrollHeight - 4;
    const frag = document.createDocumentFragment();
    for (const l of logLines) {
        const ts = document.createElement('span');
        ts.className = 'ts';
        ts.textContent = `${l.ts}  `;
        const body = document.createElement('span');
        if (l.outgoing) body.className = 'out';
        body.textContent = l.line + '\n';
        frag.append(ts, body);
    }
    elLog.replaceChildren(frag);
    if (stick) elLog.scrollTop = elLog.scrollHeight;
}

// ---- Actions ----

function doSetMessage() {
    const msg = elInput.value.trim();
    if (!msg) { elInput.focus(); return; }
    socket.emit('set-message', msg);
    $('armed-msg').textContent = `"${msg}"`;
    appendLog(`> ${msg}`, true);
}

function doSend() {
    const msg = elInput.value.trim();
    if (msg) updateWaveform(msg);
    $('waveform-source').textContent = 'última transmissão';
    $('last-tx').textContent = timeStamp();
    socket.emit('send');
    appendLog('> SEND', true);
}

// ---- Socket ----

function setLink(id, on, text) {
    const el = $(id);
    el.dataset.state = on ? 'on' : 'off';
    el.querySelector('output').textContent = text;
}

const socket = io();

socket.on('connect',    () => setLink('ws-status', true,  'conectado'));
socket.on('disconnect', () => setLink('ws-status', false, 'desconectado'));
socket.on('slave-id', id => setSlaveId(id));
socket.on('slave-status', ({ connected, port }) =>
    setLink('serial-status', !!connected, connected ? port : 'desconectado'));
socket.on('slave-log', line => appendLog(line));

// ---- UI events ----

elInput.addEventListener('input', () => {
    updatePayload();
    $('waveform-source').textContent = 'prévia ao digitar';
    updateWaveform(elInput.value.trim());
});

elInput.addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    doSetMessage();
    if (e.ctrlKey) doSend();
});

$('btn-set').addEventListener('click', doSetMessage);
$('btn-send').addEventListener('click', doSend);
$('btn-clear-log').addEventListener('click', () => {
    logLines.length = 0;
    elLog.textContent = 'Console limpo.';
});

// ---- Init ----

$('key-label').textContent = XOR_KEY;
updatePayload();
updateWaveform('');
setSlaveId(1);
