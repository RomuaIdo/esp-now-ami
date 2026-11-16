'use strict';

/*
 * AmiScope — oscilloscope / logic-analyzer style renderer for AMI
 * pseudo-ternary waveforms. Draws graticule, trace, per-bit row,
 * byte decoder row and plaintext row on a single high-DPI canvas.
 *
 * Shared by website/ and website-slave/ (keep both copies in sync).
 */

const AMI = {
    // Number of bits shown when there is no data (keeps the empty screen gridded)
    EMPTY_BITS: 64,

    isPrintable(b) {
        return (b >= 0x20 && b <= 0x7E) || b >= 0xA0;
    },

    hex2(b) {
        return b.toString(16).padStart(2, '0').toUpperCase();
    },

    bin8(b) {
        return b.toString(2).padStart(8, '0');
    },

    toHex(bytes) {
        return bytes.map(AMI.hex2).join(' ');
    },

    escapeHtml(s) {
        return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    },

    // Printable chars as-is, non-printable as highlighted \xNN escapes
    bytesToHtml(bytes) {
        return bytes
            .map(b => AMI.isPrintable(b)
                ? AMI.escapeHtml(String.fromCharCode(b))
                : `<span class="hex-byte">\\x${AMI.hex2(b).toLowerCase()}</span>`)
            .join('');
    },

    charLabel(b) {
        if (b === 0x20) return '␠';
        return AMI.isPrintable(b) ? String.fromCharCode(b) : `\\x${AMI.hex2(b).toLowerCase()}`;
    },

    // Pseudo-ternary stats: bit 1 → 0 V, bit 0 → alternating ±V.
    // A violation is two consecutive marks with the same polarity.
    stats(waveform) {
        let pos = 0, neg = 0, zero = 0, dc = 0, last = 0;
        const violations = new Set();
        waveform.forEach((v, i) => {
            if (v === 0) { zero++; return; }
            if (v > 0) pos++; else neg++;
            dc += v;
            if (last !== 0 && Math.sign(v) === Math.sign(last)) violations.add(i);
            last = v;
        });
        return { bits: waveform.length, bytes: Math.floor(waveform.length / 8), pos, neg, zero, dc, violations };
    },

    // Fill a <tbody> with one row per byte: plain ⊕ key = encrypted
    renderByteTable(tbody, { plain, enc, key }) {
        tbody.replaceChildren();
        if (!enc.length) {
            const tr = tbody.insertRow();
            const td = tr.insertCell();
            td.colSpan = 6;
            td.className = 'empty';
            td.textContent = 'Sem bytes para decodificar.';
            return;
        }
        enc.forEach((e, i) => {
            const k = key.charCodeAt(i % key.length);
            const p = plain[i];
            const tr = tbody.insertRow();
            const cells = [
                [String(i).padStart(2, '0'), 'idx'],
                [AMI.charLabel(p), 'chr'],
                [AMI.hex2(p), ''],
                [`${AMI.hex2(k)} ${AMI.charLabel(k)}`, 'key'],
                [AMI.hex2(e), 'enc'],
                [AMI.bin8(e), 'bin'],
            ];
            cells.forEach(([text, cls]) => {
                const td = tr.insertCell();
                td.textContent = text;
                if (cls) td.className = cls;
            });
        });
    },
};

class AmiScope {
    constructor(canvas, { emptyText = 'Sem sinal', onCursor = null } = {}) {
        this.canvas   = canvas;
        this.ctx      = canvas.getContext('2d');
        this.wrap     = canvas.parentElement;
        this.emptyText = emptyText;
        this.onCursor = onCursor;
        this.waveform = [];
        this.enc      = [];
        this.plain    = [];
        this.stats    = AMI.stats([]);
        this.cursor   = null;

        // Geometry (CSS pixels)
        this.G       = 46;   // left gutter for level / row labels
        this.H       = 252;
        this.minCell = 8;
        this.wrapW   = 0;

        // Only re-layout when the available width really changes (avoids a
        // resize loop when the horizontal scrollbar appears/disappears)
        new ResizeObserver(() => {
            const w = this.wrap.clientWidth;
            if (Math.abs(w - this.wrapW) < 2) return;
            this.wrapW = w;
            // Defer: resizing the canvas inside the callback changes the
            // observed box again in the same frame
            requestAnimationFrame(() => this.layout());
        }).observe(this.wrap);

        canvas.addEventListener('pointermove', e => {
            const r   = canvas.getBoundingClientRect();
            const idx = Math.floor((e.clientX - r.left - this.G) / this.cell);
            const next = (idx >= 0 && idx < this.waveform.length) ? idx : null;
            if (next !== this.cursor) { this.cursor = next; this.draw(); this.emitCursor(); }
        });
        canvas.addEventListener('pointerleave', () => {
            if (this.cursor === null) return;
            this.cursor = null; this.draw(); this.emitCursor();
        });
    }

    emitCursor() {
        if (!this.onCursor) return;
        const i = this.cursor;
        if (i === null) { this.onCursor(null); return; }
        const byte = Math.floor(i / 8);
        this.onCursor({
            bit: i,
            byte,
            bitInByte: i % 8,
            level: this.waveform[i],
            value: this.waveform[i] === 0 ? 1 : 0,
            enc: this.enc[byte],
            plain: this.plain[byte],
            violation: this.stats.violations.has(i),
        });
    }

    setData(waveform, enc = [], plain = []) {
        this.waveform = waveform;
        this.enc      = enc;
        this.plain    = plain;
        this.stats    = AMI.stats(waveform);
        this.cursor   = null;
        this.emitCursor();
        this.layout();
    }

    layout() {
        const n     = this.waveform.length || AMI.EMPTY_BITS;
        const avail = (this.wrapW || this.wrap.clientWidth) - this.G - 8;
        this.cell   = Math.max(this.minCell, avail / n);
        const w     = Math.ceil(this.G + this.cell * n + 8);
        const dpr   = window.devicePixelRatio || 1;

        this.W = w;
        this.canvas.style.width  = `${w}px`;
        this.canvas.style.height = `${this.H}px`;
        this.canvas.width  = Math.round(w * dpr);
        this.canvas.height = Math.round(this.H * dpr);
        this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        this.draw();
    }

    css(name) {
        return getComputedStyle(this.canvas).getPropertyValue(name).trim();
    }

    draw() {
        const { ctx, G, H, cell } = this;
        const W     = this.W;
        const wf    = this.waveform;
        const n     = wf.length || AMI.EMPTY_BITS;
        const color = this.css('--trace');
        const grat  = this.css('--grat');
        const gratM = this.css('--grat-major');
        const dim   = this.css('--dim');
        const ink   = this.css('--ink');
        const bad   = this.css('--fault');
        const mono  = this.css('--font-mono') || 'monospace';

        // Row geometry
        const axisY  = 16;                 // byte index labels
        const tTop   = 26, tBot = 146;     // trace band
        const yOf    = v => v > 0 ? tTop + 18 : v < 0 ? tBot - 18 : (tTop + tBot) / 2;
        const bitY   = 166;                // bit values row (center)
        const decTop = 180, decBot = 204;  // decoder row
        const txtY   = 228;                // plaintext row (center)
        const xOf    = i => G + i * cell;

        ctx.clearRect(0, 0, W, H);

        // Violation cells (behind everything)
        ctx.fillStyle = bad;
        ctx.globalAlpha = 0.16;
        this.stats.violations.forEach(i => ctx.fillRect(xOf(i), tTop, cell, tBot - tTop));
        ctx.globalAlpha = 1;

        // Cursor cell
        if (this.cursor !== null) {
            ctx.fillStyle = color;
            ctx.globalAlpha = 0.1;
            ctx.fillRect(xOf(this.cursor), tTop, cell, decBot - tTop);
            ctx.globalAlpha = 1;
        }

        // Vertical graticule: faint per bit, stronger per byte
        ctx.lineWidth = 1;
        for (let i = 0; i <= n; i++) {
            const x = Math.round(xOf(i)) + 0.5;
            const major = i % 8 === 0;
            if (!major && cell < 7) continue;
            ctx.strokeStyle = major ? gratM : grat;
            ctx.beginPath();
            ctx.moveTo(x, major ? axisY + 4 : tTop);
            ctx.lineTo(x, major ? decBot : tBot);
            ctx.stroke();
        }

        // Horizontal level lines
        ctx.setLineDash([2, 4]);
        [1, 0, -1].forEach(v => {
            const y = Math.round(yOf(v)) + 0.5;
            ctx.strokeStyle = v === 0 ? gratM : grat;
            ctx.beginPath(); ctx.moveTo(G, y); ctx.lineTo(xOf(n), y); ctx.stroke();
        });
        ctx.setLineDash([]);

        // Band separators
        ctx.strokeStyle = gratM;
        [tBot + 0.5, decTop - 6.5].forEach(y => {
            ctx.beginPath(); ctx.moveTo(G, y); ctx.lineTo(xOf(n), y); ctx.stroke();
        });

        // Gutter labels
        ctx.font = `500 11px ${mono}`;
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'right';
        ctx.fillStyle = dim;
        ctx.fillText('+V', G - 8, yOf(1));
        ctx.fillText('0',  G - 8, yOf(0));
        ctx.fillText('−V', G - 8, yOf(-1));
        ctx.font = `400 10px ${mono}`;
        ctx.fillText('bit', G - 8, bitY);
        ctx.fillText('enc', G - 8, (decTop + decBot) / 2);
        ctx.fillText('txt', G - 8, txtY);

        // Byte index axis
        ctx.textAlign = 'left';
        ctx.font = `400 10px ${mono}`;
        for (let b = 0; b * 8 < n; b++) {
            ctx.fillStyle = dim;
            ctx.fillText(`B${b}  ${b * 8}`, xOf(b * 8) + 4, axisY);
        }

        if (!wf.length) {
            ctx.textAlign = 'center';
            ctx.font = `400 12px ${mono}`;
            ctx.fillStyle = dim;
            ctx.fillText(this.emptyText, G + (xOf(n) - G) / 2, (tTop + tBot) / 2 - 22);
            return;
        }

        // Trace
        ctx.save();
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.lineJoin = 'miter';
        ctx.shadowColor = color;
        ctx.shadowBlur = 6;
        ctx.beginPath();
        ctx.moveTo(xOf(0), yOf(wf[0]));
        wf.forEach((v, i) => {
            const y = yOf(v);
            ctx.lineTo(xOf(i), y);
            ctx.lineTo(xOf(i + 1), y);
        });
        ctx.stroke();
        ctx.restore();

        // Bit row
        ctx.textAlign = 'center';
        if (cell >= 8) {
            ctx.font = `500 ${cell >= 12 ? 11 : 9}px ${mono}`;
            wf.forEach((v, i) => {
                const viol = this.stats.violations.has(i);
                ctx.fillStyle = viol ? bad : (i === this.cursor ? ink : dim);
                ctx.fillText(v === 0 ? '1' : '0', xOf(i) + cell / 2, bitY);
            });
        }

        // Decoder row: hexagonal byte frames (logic-analyzer style)
        const bytes = Math.floor(wf.length / 8);
        const mid = (decTop + decBot) / 2;
        ctx.lineWidth = 1;
        for (let b = 0; b < bytes; b++) {
            const x0 = xOf(b * 8) + 2, x1 = xOf(b * 8 + 8) - 2, k = 5;
            ctx.beginPath();
            ctx.moveTo(x0, mid);
            ctx.lineTo(x0 + k, decTop);
            ctx.lineTo(x1 - k, decTop);
            ctx.lineTo(x1, mid);
            ctx.lineTo(x1 - k, decBot);
            ctx.lineTo(x0 + k, decBot);
            ctx.closePath();
            ctx.fillStyle = color;
            ctx.globalAlpha = 0.14;
            ctx.fill();
            ctx.globalAlpha = 1;
            ctx.strokeStyle = color;
            ctx.stroke();

            ctx.fillStyle = ink;
            ctx.font = `600 11px ${mono}`;
            if (this.enc[b] !== undefined) ctx.fillText(`0x${AMI.hex2(this.enc[b])}`, (x0 + x1) / 2, mid + 0.5);

            if (this.plain[b] !== undefined) {
                ctx.fillStyle = color;
                ctx.font = `600 13px ${mono}`;
                ctx.fillText(AMI.charLabel(this.plain[b]), (x0 + x1) / 2, txtY);
            }
        }

        // Cursor line
        if (this.cursor !== null) {
            const x = Math.round(xOf(this.cursor) + cell / 2) + 0.5;
            ctx.strokeStyle = ink;
            ctx.globalAlpha = 0.5;
            ctx.setLineDash([3, 3]);
            ctx.beginPath(); ctx.moveTo(x, tTop); ctx.lineTo(x, decBot); ctx.stroke();
            ctx.setLineDash([]);
            ctx.globalAlpha = 1;
        }
    }
}
