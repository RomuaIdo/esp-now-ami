'use strict';

// Must match the XOR_KEY in src/slave/main.cpp
const XOR_KEY = 'BrasilHexa';

// ---- Decoding ----

// Pseudo-ternary: non-zero level (±V) → bit 0 ; zero level → bit 1
const amiDecode = waveform => waveform.map(v => v !== 0 ? 0 : 1);

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

const xorBytes = bytes => bytes.map((b, i) => b ^ XOR_KEY.charCodeAt(i % XOR_KEY.length));

const bytesToString = bytes =>
    bytes.map(b => AMI.isPrintable(b) ? String.fromCharCode(b) : '?').join('');

function bitString(bits) {
    const groups = [];
    for (let i = 0; i < bits.length; i += 8) groups.push(bits.slice(i, i + 8).join(''));
    return groups.join(' ');
}

const levelName = v => v === 0 ? '0 V' : v > 0 ? '+V' : '−V';

function timeStamp() {
    const d = new Date();
    return d.toLocaleTimeString('pt-BR', { hour12: false }) +
        '.' + String(d.getMilliseconds()).padStart(3, '0');
}

// ---- Channels ----

const tpl = document.getElementById('channel-tpl');
const channelsEl = document.getElementById('channels');
const channels = {};

for (const id of [1, 2]) {
    const node = tpl.content.firstElementChild.cloneNode(true);
    node.id = `ch-${id}`;
    node.dataset.ch = id;
    node.querySelector('.ch-tag').textContent = `CH${id}`;
    node.querySelector('.ch-name').textContent = `Slave ${id}`;
    channelsEl.append(node);

    const f = name => node.querySelector(`[data-f="${name}"]`);
    const canvas = node.querySelector('canvas');
    canvas.setAttribute('aria-label', `Forma de onda AMI do slave ${id}: sem sinal`);

    const ch = { id, node, f, canvas, count: 0, tbody: node.querySelector('tbody') };
    ch.scope = new AmiScope(canvas, {
        emptyText: `Aguardando pacote do slave ${id}`,
        onCursor: info => {
            f('cursor').textContent = info
                ? `Bit ${info.bit} (byte ${info.byte}, bit ${7 - info.bitInByte} MSB)  nível ${levelName(info.level)}  valor ${info.value}` +
                  (info.enc !== undefined ? `  byte cifrado 0x${AMI.hex2(info.enc)}  texto '${AMI.charLabel(info.plain)}'` : '') +
                  (info.violation ? '  violação de polaridade' : '')
                : 'Passe o cursor sobre a forma de onda para medir um bit.';
        },
    });
    AMI.renderByteTable(ch.tbody, { plain: [], enc: [], key: XOR_KEY });
    channels[id] = ch;
}

document.getElementById('key-label').textContent = XOR_KEY;

function updateChannel(ch, packet) {
    const waveform = packet.waveform.slice(0, packet.num_bits ?? packet.waveform.length);
    const bits  = amiDecode(waveform);
    const enc   = bitsToBytes(bits);
    const plain = xorBytes(enc);
    const msg   = bytesToString(plain);
    const st    = AMI.stats(waveform);
    const { f } = ch;

    ch.count++;
    ch.scope.setData(waveform, enc, plain);

    f('count').textContent  = ch.count;
    f('ts').textContent     = timeStamp();
    f('bits').textContent   = st.bits;
    f('bytes').textContent  = st.bytes;
    f('pos').textContent    = st.pos;
    f('neg').textContent    = st.neg;
    f('zero').textContent   = st.zero;
    f('dc').textContent     = st.dc > 0 ? `+${st.dc}` : st.dc;
    f('viol').textContent   = st.violations.size;
    f('viol').classList.toggle('fault', st.violations.size > 0);

    f('bitstr').textContent = bitString(bits);
    f('hex').textContent    = AMI.toHex(enc);
    f('enc').innerHTML      = AMI.bytesToHtml(enc);
    f('msg').textContent    = msg;

    ch.canvas.setAttribute('aria-label',
        `Forma de onda AMI do slave ${ch.id}: ${st.bits} bits, mensagem decifrada "${msg}"`);
    AMI.renderByteTable(ch.tbody, { plain, enc, key: XOR_KEY });

    // Brief flash on the channel tag to mark a new packet
    ch.node.classList.remove('rx');
    void ch.node.offsetWidth;
    ch.node.classList.add('rx');
}

// ---- Link status ----

function setLink(id, on, text) {
    const el = document.getElementById(id);
    el.dataset.state = on ? 'on' : 'off';
    el.querySelector('output').textContent = text;
}

const socket = io();

socket.on('connect',    () => setLink('ws-status', true,  'conectado'));
socket.on('disconnect', () => setLink('ws-status', false, 'desconectado'));

socket.on('serial-status', ({ connected, port }) =>
    setLink('serial-status', connected, connected ? port : 'desconectado'));

socket.on('waveform-data', packet => {
    const ch = channels[packet.slave];
    if (ch && Array.isArray(packet.waveform)) updateChannel(ch, packet);
});
