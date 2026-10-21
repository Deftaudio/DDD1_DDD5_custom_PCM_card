// Korg DDD-1 / DDD-5 expansion sound ROM format and the conversion chain that
// replaces the Windows SoX scripts (Korg DDD Expansion Sound ROM Creator v0.4).
//
// Bank layout (32768 bytes, one 27256 EPROM):
//   0x000  "KORG" 02 FF*11
//   0x010  0A 06 <count> 00 00 00 <bank name, 8 chars> FF FF
//   0x020  8 entries x 16 bytes:
//          <size in KiB> 00 <addr lo> 00 <addr hi> 01 <sound name, 8 chars> FF FF
//          unused entry: 00 00 00 00 00 01 " NO INST" FF FF
//   0x0A0  0x80 filler up to 0x134
//   0x134  8-bit unsigned PCM data (0x80 = silence), 32460 bytes
// The PicoROM image (2 Mbit) holds 8 banks in DIP-switch order 1,5,3,7,2,6,4,8.
(function (root) {
  'use strict';

  const BANK_SIZE = 32768;
  const BANKS = 8;
  const IMAGE_SIZE = BANK_SIZE * BANKS;
  const MAX_SOUNDS = 8;
  const DATA_START = 0x134;
  const DATA_SIZE = BANK_SIZE - DATA_START;        // 32460
  const UNIT = 1024;
  const SILENCE = 0x80;
  const NAME_LEN = 8;
  const DEFAULT_BANK_NAME = ' CUSTOM ';
  const EMPTY_NAME = ' NO INST';
  // Image slot k holds bank IMAGE_ORDER[k] (0-based). Bit-reversal, so it is its own inverse.
  const IMAGE_ORDER = [0, 4, 2, 6, 1, 5, 3, 7];
  // Header size values used by the 1X..8X templates of the original scripts.
  const CLASSIC_UNITS = [32, 16, 10, 8, 6, 5, 4, 4];

  const DEFAULT_SETTINGS = Object.freeze({
    rate: 25272,          // DDD native; Deftaudio scripts use 44100, original v0.3 used 25640
    layout: 'auto',       // 'auto' (fit by length) or 'classic' (equal slots, like the 1X..8X scripts)
    normDb: -0.3,         // sox --norm=-0.3
    silencePct: 0.2,      // sox silence 1 1 0.20%
    fadeIn: 2,            // sox fade p 2s ...
    fadeOut: 50,          // ... 50s
    dither: 'rpdf',       // sox dither -r (rectangular); 'tpdf' or 'none'
    decayCurve: 'exp',    // shape of a per-sound decay: 'exp', 'linear' or 'sox'
  });

  // ---------- names ----------

  // DDD names are 8 printable ASCII characters, space padded.
  function cleanName(text, fallback = '') {
    const ascii = String(text ?? '').normalize('NFKD').replace(/[^\x20-\x7e]/g, '');
    return (ascii || fallback).slice(0, NAME_LEN);
  }
  function padName(text) { return cleanName(text).padEnd(NAME_LEN, ' '); }
  function nameFromFile(filename) {
    const base = String(filename).split(/[\\/]/).pop().replace(/\.[^.]+$/, '');
    return cleanName(base, 'SOUND');
  }
  function readName(bytes, at) {
    let s = '';
    for (let i = 0; i < NAME_LEN; i++) {
      const c = bytes[at + i];
      s += c >= 0x20 && c <= 0x7e ? String.fromCharCode(c) : ' ';
    }
    return s;
  }

  // ---------- DSP (equivalent of the two SoX passes) ----------

  // Deterministic PRNG so the same project always produces the same ROM bytes.
  function rng(seed) {
    let s = (seed >>> 0) || 0x9e3779b9;
    return () => {
      s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
      return s / 4294967296;
    };
  }

  // SoX "silence 1 1 <pct>%": the start is the first sample whose RMS over the
  // last 20 ms (window initially zero) exceeds the threshold.
  function silenceEnd(x, rate, threshold) {
    const win = Math.max(1, Math.round(rate / 50)), limit = threshold * threshold * win;
    let sum = 0;
    for (let i = 0; i < x.length; i++) {
      sum += x[i] * x[i];
      if (i >= win) sum -= x[i - win] * x[i - win];
      if (sum > limit) return i;
    }
    return x.length;
  }

  // sox -D --norm=<db> in.wav out.wav rate <rate> channels 1 silence 1 1 <pct>%
  // (the norm gain is measured on the whole input, as SoX does).
  // Input is already mono. Returns float audio at the target rate, before truncation.
  function prepare(source, sourceRate, settings) {
    const s = { ...DEFAULT_SETTINGS, ...settings };
    let peak = 0;
    for (let i = 0; i < source.length; i++) peak = Math.max(peak, Math.abs(source[i]));
    if (peak === 0) return new Float32Array(0);
    const gain = Math.pow(10, s.normDb / 20) / peak;
    const threshold = s.silencePct / 100;
    // SoX runs "silence" on the input level; --norm scales the result afterwards.
    const first = silenceEnd(source, sourceRate, threshold);
    if (first >= source.length) return new Float32Array(0);
    // Resample only up to one bank's worth of audio past the start.
    const end = Math.min(source.length, first + Math.ceil(DATA_SIZE * sourceRate / s.rate) + 256);
    const head = source.subarray(0, end);
    const x = sourceRate === s.rate ? Float32Array.from(head)
      : root.resampleSinc(head, Math.max(1, Math.round(head.length * s.rate / sourceRate)), 16);
    const start = silenceEnd(x, s.rate, threshold);
    for (let i = 0; i < x.length; i++) x[i] *= gain;
    return x.subarray(start, start + DATA_SIZE);
  }

  // Fade shapes. u runs 0 -> 1 across the fade.
  // 'sox' is SoX's "p" (inverted parabola), used by the scripts for both fades.
  function fadeInGain(u) { return 1 - (1 - u) * (1 - u); }
  function fadeOutGain(u, curve = 'sox') {
    if (curve === 'linear') return 1 - u;
    if (curve === 'exp') return (Math.exp(-5 * u) - Math.exp(-5)) / (1 - Math.exp(-5));
    return 1 - u * u;
  }

  // Per-sound envelope in samples: attack = fade-in length, decay = where the
  // fade-out starts (0 = none). The global fades remain the minimum, so a sound
  // never starts or ends with a click. Returns [fadeIn, fadeOutStart, curve].
  function envelopeFor(n, settings, { raw = false, truncated = false, attack = 0, decay = 0 } = {}) {
    const s = { ...DEFAULT_SETTINGS, ...settings };
    const fadeIn = Math.min(n, attack > 0 ? attack : raw ? 0 : s.fadeIn);
    const minOut = raw && !truncated ? 0 : s.fadeOut;
    const userOut = decay > 0 && decay < n ? n - decay : 0;
    const fadeOut = Math.min(n - fadeIn, Math.max(userOut, minOut));
    return [fadeIn, n - Math.max(0, fadeOut), userOut > minOut ? s.decayCurve : 'sox'];
  }

  // Envelope gain at sample i of a sound n samples long.
  function envelopeGain(i, n, [fadeIn, outStart, curve]) {
    let g = 1;
    if (i < fadeIn) g *= fadeInGain(i / fadeIn);
    if (i >= outStart && n > outStart) g *= fadeOutGain((i - outStart + 1) / (n - outStart), curve);
    return g;
  }

  // fade p <in>s <length>s <out>s, then 8-bit unsigned with dither.
  // raw = true for sounds read back from a ROM: keep the bytes, only fade a
  // cut or an envelope the user drew.
  function finalize(prepared, length, settings, { raw = false, seed = 1, attack = 0, decay = 0 } = {}) {
    const s = { ...DEFAULT_SETTINGS, ...settings };
    const n = Math.min(length, prepared.length);
    const truncated = n < prepared.length;
    const env = envelopeFor(n, s, { raw, truncated, attack, decay });
    const out = new Uint8Array(n);
    const rand = rng(seed);
    const dither = raw ? 'none' : s.dither;
    for (let i = 0; i < n; i++) {
      let d = 0;
      if (dither === 'rpdf') d = rand() - 0.5;
      else if (dither === 'tpdf') d = rand() - rand();
      const v = Math.round(prepared[i] * envelopeGain(i, n, env) * 128 + d);
      out[i] = Math.max(-128, Math.min(127, v)) + 128;
    }
    return out;
  }

  // ---------- layout ----------

  // items: [{ available: prepared length, max: optional user limit (samples) }]
  // Returns [{ addr, units, length, slot }] with addr relative to the bank start.
  function layoutBank(items, mode = 'auto') {
    const n = items.length;
    if (n === 0) return [];
    if (n > MAX_SOUNDS) throw new Error(`A bank holds at most ${MAX_SOUNDS} sounds.`);
    const want = items.map(it => Math.max(1, Math.min(it.available, it.max > 0 ? it.max : Infinity)));

    if (mode === 'classic') {
      // Same addresses and size bytes as the 1X..8X templates; 8X keeps
      // 4000 samples + 57 bytes of silence per slot, as in the scripts.
      const slot = Math.floor(DATA_SIZE / n);
      const cap = n === 8 ? 4000 : slot;
      return items.map((_, i) => ({
        addr: DATA_START + i * slot,
        units: CLASSIC_UNITS[n - 1],
        length: Math.min(want[i], cap),
        slot,
      }));
    }

    // Auto: whole-KiB slots so the header size matches the data exactly and no
    // sound plays into its neighbour. Space is shared out by need, shortest first.
    const total = Math.floor(DATA_SIZE / UNIT);     // 31
    const need = want.map(w => Math.min(32, Math.ceil(w / UNIT)));
    const units = new Array(n).fill(0);
    let free = total;
    if (need.reduce((a, b) => a + b, 0) <= total) {
      need.forEach((u, i) => { units[i] = u; });
    } else {
      while (free > 0) {
        let pick = -1;
        for (let i = 0; i < n; i++) {
          if (units[i] < need[i] && (pick < 0 || units[i] < units[pick])) pick = i;
        }
        if (pick < 0) break;
        units[pick]++; free--;
      }
    }
    let addr = DATA_START;
    return items.map((_, i) => {
      const slot = units[i] * UNIT;
      const r = { addr, units: units[i], length: Math.min(want[i], slot), slot };
      addr += slot;
      return r;
    });
  }

  // ---------- bank / image ----------

  function writeName(bank, at, text) {
    const name = padName(text);
    for (let i = 0; i < NAME_LEN; i++) bank[at + i] = name.charCodeAt(i);
  }

  // sounds: [{ name, data: Uint8Array, addr, units }]
  function buildBank(bankName, sounds) {
    if (sounds.length > MAX_SOUNDS) throw new Error(`A bank holds at most ${MAX_SOUNDS} sounds.`);
    const bank = new Uint8Array(BANK_SIZE).fill(SILENCE);
    bank.set([0x4b, 0x4f, 0x52, 0x47, 0x02], 0);
    bank.fill(0xff, 5, 0x10);
    bank.set([0x0a, 0x06, sounds.length, 0, 0, 0], 0x10);
    writeName(bank, 0x16, bankName && bankName.trim() ? bankName : DEFAULT_BANK_NAME);
    bank[0x1e] = bank[0x1f] = 0xff;
    for (let i = 0; i < MAX_SOUNDS; i++) {
      const at = 0x20 + i * 16;
      const s = sounds[i];
      if (s) {
        if (s.addr < DATA_START || s.addr + s.data.length > BANK_SIZE) throw new Error(`Sound ${i + 1} does not fit in the bank.`);
        bank.set([s.units & 0xff, 0, s.addr & 0xff, 0, (s.addr >> 8) & 0xff, 1], at);
        writeName(bank, at + 6, s.name);
        bank.set(s.data, s.addr);
      } else {
        bank.set([0, 0, 0, 0, 0, 1], at);
        writeName(bank, at + 6, EMPTY_NAME);
      }
      bank[at + 14] = bank[at + 15] = 0xff;
    }
    return bank;
  }

  // banks: 8 x (Uint8Array(32768) | null). Empty banks are zero filled, like empty.bin.
  function buildImage(banks) {
    const image = new Uint8Array(IMAGE_SIZE);
    for (let slot = 0; slot < BANKS; slot++) {
      const bank = banks[IMAGE_ORDER[slot]];
      if (bank) image.set(bank, slot * BANK_SIZE);
    }
    return image;
  }

  function isBank(bytes) {
    return bytes && bytes.length >= BANK_SIZE &&
      bytes[0] === 0x4b && bytes[1] === 0x4f && bytes[2] === 0x52 && bytes[3] === 0x47;
  }

  // Recover names and sample bytes from a bank image. Returns null for an empty bank.
  function parseBank(bytes) {
    if (!isBank(bytes)) return null;
    const count = Math.min(bytes[0x12], MAX_SOUNDS);
    const entries = [];
    for (let i = 0; i < count; i++) {
      const at = 0x20 + i * 16;
      entries.push({ units: bytes[at], addr: bytes[at + 2] | (bytes[at + 4] << 8), name: readName(bytes, at + 6) });
    }
    const sounds = [];
    for (const e of entries) {
      if (e.addr < DATA_START || e.addr >= BANK_SIZE || e.units === 0) continue;
      const next = entries.map(o => o.addr).filter(a => a > e.addr);
      let end = Math.min(e.addr + e.units * UNIT, BANK_SIZE, ...next);
      while (end > e.addr + 1 && bytes[end - 1] === SILENCE) end--;
      const slotEnd = Math.min(BANK_SIZE, ...next);
      sounds.push({ name: e.name.trimEnd(), data: bytes.slice(e.addr, end), addr: e.addr, units: e.units, slot: slotEnd - e.addr });
    }
    return { name: readName(bytes, 0x16), sounds };
  }

  // Accepts one bank (32 KiB) or a full PicoROM image (256 KiB); returns 8 banks in bank order.
  function splitImage(bytes) {
    if (bytes.length === BANK_SIZE) return [bytes];
    if (bytes.length !== IMAGE_SIZE) throw new Error('Expected a 32 KiB bank or a 256 KiB PicoROM image.');
    const banks = new Array(BANKS);
    for (let slot = 0; slot < BANKS; slot++) banks[IMAGE_ORDER[slot]] = bytes.slice(slot * BANK_SIZE, (slot + 1) * BANK_SIZE);
    return banks;
  }

  // ---------- WAV writing ----------

  function encodeWav(samples, rate, bits) {
    const bytesPer = bits / 8, dataLen = samples.length * bytesPer;
    const buf = new ArrayBuffer(44 + dataLen + (dataLen & 1)), v = new DataView(buf);
    const str = (at, s) => { for (let i = 0; i < s.length; i++) v.setUint8(at + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); v.setUint32(4, buf.byteLength - 8, true); str(8, 'WAVE');
    str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, bits === 32 ? 3 : 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, rate, true); v.setUint32(28, rate * bytesPer, true); v.setUint16(32, bytesPer, true); v.setUint16(34, bits, true);
    str(36, 'data'); v.setUint32(40, dataLen, true);
    for (let i = 0; i < samples.length; i++) {
      if (bits === 8) v.setUint8(44 + i, samples[i]);
      else v.setFloat32(44 + i * 4, samples[i], true);
    }
    return new Uint8Array(buf);
  }

  root.DDD = {
    BANK_SIZE, BANKS, IMAGE_SIZE, MAX_SOUNDS, DATA_START, DATA_SIZE, UNIT, SILENCE, NAME_LEN,
    DEFAULT_BANK_NAME, IMAGE_ORDER, CLASSIC_UNITS, DEFAULT_SETTINGS,
    cleanName, padName, nameFromFile, prepare, finalize, envelopeFor, envelopeGain, layoutBank,
    buildBank, buildImage, isBank, parseBank, splitImage, encodeWav,
  };
  if (typeof module !== 'undefined') module.exports = root.DDD;
})(typeof window !== 'undefined' ? window : globalThis);
