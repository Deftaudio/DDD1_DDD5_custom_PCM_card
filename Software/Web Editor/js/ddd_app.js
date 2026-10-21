// DDD ROM Tools: browser replacement for Deftaudio_MAIN.bat and the
// Deftaudio_PicoROM_Process_1x..8x.bat scripts. Everything runs locally.
'use strict';

const AUDIO_EXT = /\.(wav|aif|aiff|aifc|flac|mp3|ogg|m4a)$/i;
const ROM_EXT = /\.(bin|rom)$/i;
const MAX_SOURCE_FRAMES = 1 << 20;

let settings = { ...DDD.DEFAULT_SETTINGS };
let banks = Array.from({ length: DDD.BANKS }, () => ({ name: '', sounds: [] }));
let current = 0;
let nextId = 1;
let actx = null;
let playing = null;
let picoBusy = false;
let dragFrom = null;

function de(id) { return document.getElementById(id); }
function showMessage(text, kind = '') {
  const el = de('app_status');
  el.textContent = text;
  el.className = kind;
}
function toSamples(msValue) { return msValue > 0 ? Math.round(msValue * settings.rate / 1000) : 0; }
function ms(samples) { return (samples / settings.rate * 1000).toFixed(0) + ' ms'; }

// ---------- decoding ----------

function riffChunks(data, littleEndian) {
  const view = new DataView(data), chunks = new Map();
  if (data.byteLength < 12) throw new Error('Incomplete audio header.');
  const end = Math.min(view.getUint32(4, littleEndian) + 8, data.byteLength);
  for (let at = 12; at + 8 <= end;) {
    const id = String.fromCharCode(...new Uint8Array(data, at, 4)), length = view.getUint32(at + 4, littleEndian);
    if (!chunks.has(id)) chunks.set(id, { offset: at + 8, length: Math.min(length, end - at - 8) });
    at += 8 + length + (length & 1);
  }
  return chunks;
}

function pcmToMono(data, { channels, bits, offset, length, littleEndian, unsigned8, floating }) {
  const bytes = bits / 8, stride = channels * bytes;
  if (!channels || ![8, 16, 24, 32, 64].includes(bits)) throw new Error('Unsupported sample format.');
  const frames = Math.min(Math.floor(length / stride), MAX_SOURCE_FRAMES);
  const view = new DataView(data, offset, frames * stride), mono = new Float32Array(frames);
  const read = at => {
    if (floating) return bits === 32 ? view.getFloat32(at, littleEndian) : view.getFloat64(at, littleEndian);
    if (bits === 8) return unsigned8 ? (view.getUint8(at) - 128) / 128 : view.getInt8(at) / 128;
    if (bits === 16) return view.getInt16(at, littleEndian) / 32768;
    if (bits === 32) return view.getInt32(at, littleEndian) / 2147483648;
    let v = littleEndian ? view.getUint8(at) | (view.getUint8(at + 1) << 8) | (view.getUint8(at + 2) << 16)
      : (view.getUint8(at) << 16) | (view.getUint8(at + 1) << 8) | view.getUint8(at + 2);
    if (v & 0x800000) v |= ~0xffffff;
    return v / 8388608;
  };
  // sox "channels 1" averages the channels.
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) sum += read(i * stride + c * bytes);
    mono[i] = sum / channels;
  }
  return mono;
}

async function decodeAudio(data, filename) {
  const head = String.fromCharCode(...new Uint8Array(data, 0, Math.min(12, data.byteLength)));
  if (head.startsWith('RIFF') && head.slice(8) === 'WAVE') {
    const chunks = riffChunks(data, true), fmt = chunks.get('fmt '), body = chunks.get('data');
    if (fmt && body) {
      const v = new DataView(data, fmt.offset);
      let format = v.getUint16(0, true);
      if (format === 0xfffe && fmt.length >= 26) format = v.getUint16(24, true);
      if (format === 1 || format === 3) {
        const channels = v.getUint16(2, true), rate = v.getUint32(4, true), bits = v.getUint16(14, true);
        return { data: pcmToMono(data, { channels, bits, offset: body.offset, length: body.length, littleEndian: true, unsigned8: true, floating: format === 3 }), rate };
      }
    }
  } else if (head.startsWith('FORM') && (head.slice(8) === 'AIFF' || head.slice(8) === 'AIFC')) {
    const parsed = new aiff(data), chunks = riffChunks(data, false), comm = chunks.get('COMM'), body = chunks.get('SSND');
    if (parsed.readyState === parsed.DONE && comm && body) {
      const compression = head.slice(8) === 'AIFF' ? 'NONE' : String.fromCharCode(...new Uint8Array(data, comm.offset + 18, 4));
      if (['NONE', 'twos', 'sowt', 'fl32', 'FL32', 'fl64', 'FL64'].includes(compression)) {
        const skip = new DataView(data).getUint32(body.offset, false);
        return {
          data: pcmToMono(data, { channels: parsed.numChannels, bits: parsed.sampleSize, offset: body.offset + 8 + skip, length: body.length - 8 - skip, littleEndian: compression === 'sowt', unsigned8: false, floating: /^fl/i.test(compression) }),
          rate: parsed.sampleRate,
        };
      }
    }
  } else if (head.startsWith('fLaC')) {
    const decoded = new flac(data).decoder.decodeStream();
    const n = Math.min(decoded.length, MAX_SOURCE_FRAMES), mono = new Float32Array(n), ch = decoded.channels;
    for (let i = 0; i < n; i++) { let s = 0; for (const c of ch) s += c[i]; mono[i] = s / ch.length; }
    return { data: mono, rate: decoded.sampleRate };
  }
  // Compressed formats: the browser decoder at the file's own rate where possible.
  const ctx = new OfflineAudioContext(1, 1, 48000);
  const decoded = await ctx.decodeAudioData(data.slice(0));
  const n = Math.min(decoded.length, MAX_SOURCE_FRAMES), mono = new Float32Array(n);
  for (let c = 0; c < decoded.numberOfChannels; c++) {
    const ch = decoded.getChannelData(c);
    for (let i = 0; i < n; i++) mono[i] += ch[i] / decoded.numberOfChannels;
  }
  if (!n) throw new Error(`${filename}: no audio.`);
  return { data: mono, rate: decoded.sampleRate };
}

// ---------- model ----------

function newSound(name, fields) {
  return { id: nextId++, name: DDD.cleanName(name, 'SOUND'), file: '', source: null, sourceRate: 0, raw: null, maxMs: 0, attackMs: 0, decayMs: 0, cacheKey: '', cache: null, ...fields };
}

function prepared(sound) {
  if (sound.raw) {
    if (!sound.cache) sound.cache = Float32Array.from(sound.raw, b => (b - 128) / 128);
    return sound.cache;
  }
  const key = `${settings.rate}|${settings.normDb}|${settings.silencePct}`;
  if (sound.cacheKey !== key) {
    sound.cache = DDD.prepare(sound.source, sound.sourceRate, settings);
    sound.cacheKey = key;
  }
  return sound.cache;
}

// Builds one bank: layout, final bytes per sound and the 32 KiB image.
// A bank read from a ROM is written back unchanged until one of its sounds,
// names or the order is edited.
function bankSignature(bank) {
  return JSON.stringify([bank.name, bank.sounds.map(s => [s.id, s.name, s.maxMs, s.attackMs, s.decayMs])]);
}

function computeBank(index) {
  const bank = banks[index];
  if (!bank.sounds.length) return { image: null, items: [] };
  if (bank.original && bank.originalSig === bankSignature(bank)) {
    const items = bank.sounds.map(sound => ({ sound, prepared: prepared(sound), data: sound.raw, ...sound.rom }));
    return { image: bank.original, items };
  }
  const preps = bank.sounds.map(prepared);
  const layout = DDD.layoutBank(bank.sounds.map((s, i) => ({
    available: Math.max(1, preps[i].length),
    max: s.maxMs > 0 ? Math.round(s.maxMs * settings.rate / 1000) : 0,
  })), settings.layout);
  const items = bank.sounds.map((sound, i) => {
    const data = DDD.finalize(preps[i].length ? preps[i] : new Float32Array(1), layout[i].length, settings,
      { raw: !!sound.raw, seed: index * 16 + i + 1, attack: toSamples(sound.attackMs), decay: toSamples(sound.decayMs) });
    return { sound, prepared: preps[i], data, ...layout[i] };
  });
  const image = DDD.buildBank(bank.name, items.map(it => ({ name: it.sound.name, data: it.data, addr: it.addr, units: it.units })));
  return { image, items };
}

function buildAllBanks() { return banks.map((_, i) => computeBank(i).image); }

// ---------- rendering ----------

function renderTabs() {
  const tabs = de('bank_tabs');
  tabs.innerHTML = '';
  banks.forEach((bank, i) => {
    const b = document.createElement('button');
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', String(i === current));
    b.className = bank.sounds.length ? '' : 'empty';
    b.innerHTML = `<span>Bank ${i + 1}</span><small></small>`;
    b.querySelector('small').textContent = bank.sounds.length ? `${bank.sounds.length} · ${(bank.name || 'CUSTOM').trim() || 'CUSTOM'}` : 'empty';
    b.onclick = () => { current = i; render(); };
    b.ondragover = e => { e.preventDefault(); if (current !== i) { current = i; render(); } };
    tabs.appendChild(b);
  });
}

function render() {
  stopPlayback();
  renderTabs();
  const bank = banks[current];
  de('bank_heading').textContent = `Bank ${current + 1}`;
  de('bank_name').value = bank.name;
  let result;
  try { result = computeBank(current); }
  catch (e) { showMessage(e.message, 'error'); result = { image: null, items: [] }; }
  renderCapacity(result.items);
  const list = de('sound_list');
  list.innerHTML = '';
  result.items.forEach((item, i) => list.appendChild(soundRow(item, i, result.items.length)));
  de('dropzone').hidden = bank.sounds.length >= DDD.MAX_SOUNDS;
  const used = banks.filter(b => b.sounds.length).length;
  de('image_summary').textContent = `${used} of 8 banks in use · ${banks.reduce((n, b) => n + b.sounds.length, 0)} sounds` + (used < 8 ? ' · empty banks are written as zeros' : '');
  const rateLabel = settings.rate === 44100 ? 'Deftaudio' : settings.rate === 25640 ? 'original' : settings.rate === 25272 ? 'native' : 'custom';
  de('settings_summary').textContent = `· ${settings.rate} Hz (${rateLabel}) · ${settings.layout === 'auto' ? 'auto-fit' : 'classic'} layout`;
}

function renderCapacity(items) {
  const cap = de('capacity');
  cap.innerHTML = '';
  const seg = (cls, bytes, label, title) => {
    const d = document.createElement('div');
    d.className = cls;
    d.style.flex = `0 0 ${bytes / DDD.BANK_SIZE * 100}%`;
    d.textContent = label;
    d.title = title;
    cap.appendChild(d);
    return d;
  };
  seg('hdr', DDD.DATA_START, '', 'Header and names (308 bytes)');
  let end = DDD.DATA_START, usedSamples = 0;
  items.forEach((it, i) => {
    const d = seg('snd', it.slot, `${i + 1}`, `${it.sound.name.trim()}: ${it.data.length} bytes used of ${it.slot} (${it.units} KiB in header)`);
    d.onclick = () => play(i);
    end = it.addr + it.slot;
    usedSamples += it.data.length;
  });
  if (end < DDD.BANK_SIZE) seg('', DDD.BANK_SIZE - end, '', `Unused: ${DDD.BANK_SIZE - end} bytes`);
  de('capacity_text').textContent = items.length
    ? `${items.length} sound${items.length > 1 ? 's' : ''} · ${ms(usedSamples)} of ${ms(DDD.DATA_SIZE)} used at ${settings.rate} Hz`
    : `Empty bank · ${ms(DDD.DATA_SIZE)} available at ${settings.rate} Hz`;
}

function soundRow(item, index, count) {
  const { sound } = item;
  const li = document.createElement('li');
  li.className = 'sound';
  li.dataset.id = sound.id;

  // Only the number is a drag handle, so dragging on the waveform edits the envelope.
  const idx = document.createElement('span');
  idx.className = 'idx';
  idx.textContent = index + 1;
  idx.title = 'Drag to reorder';
  idx.draggable = true;

  const name = document.createElement('input');
  name.className = 'name';
  name.maxLength = DDD.NAME_LEN;
  name.value = sound.name;
  name.spellcheck = false;
  name.autocomplete = 'off';
  name.setAttribute('aria-label', `Name of sound ${index + 1}`);
  name.oninput = () => {
    const clean = DDD.cleanName(name.value);
    if (clean !== name.value) { const p = name.selectionStart; name.value = clean; name.setSelectionRange(p - 1, p - 1); }
    sound.name = clean;
    renderTabs();
  };
  name.onblur = () => { if (!sound.name.trim()) { sound.name = DDD.nameFromFile(sound.file || `SOUND${index + 1}`); name.value = sound.name; } };

  const info = document.createElement('div');
  info.className = 'info';
  const src = document.createElement('span');
  src.className = 'src';
  src.textContent = sound.raw ? 'from ROM (kept as-is)' : sound.file;
  src.title = src.textContent;
  const line = document.createElement('span');
  info.append(src, line);

  // Envelope fields, kept in sync with the handles on the waveform.
  const fields = document.createElement('div');
  fields.className = 'env-fields';
  const field = (label, key, title) => {
    const wrap = document.createElement('label');
    wrap.title = title;
    const input = document.createElement('input');
    input.type = 'number'; input.min = 0; input.step = 0.1; input.placeholder = 'auto';
    input.setAttribute('aria-label', `${title}, sound ${index + 1}`);
    input.onchange = () => { sound[key] = Math.max(0, Math.round((Number(input.value) || 0) * 10) / 10); render(); };
    wrap.append(label, input);
    fields.appendChild(wrap);
    return input;
  };
  const inputs = {
    attackMs: field('A', 'attackMs', 'Attack (fade-in) length in ms'),
    decayMs: field('D', 'decayMs', 'Decay start in ms (fades out from here to the end)'),
    maxMs: field('End', 'maxMs', 'End: longest allowed length in ms (empty = as long as fits)'),
  };

  const actions = document.createElement('div');
  actions.className = 'actions';
  const btn = (label, title, fn, disabled = false) => {
    const b = document.createElement('button');
    b.className = 'icon'; b.textContent = label; b.title = title; b.setAttribute('aria-label', title);
    b.disabled = disabled; b.onclick = fn;
    return b;
  };
  actions.append(
    btn('▶', 'Play', () => play(index)),
    btn('↺', 'Reset envelope', () => { resetEnvelope(sound); render(); }, !hasEnvelope(sound)),
    btn('↑', 'Move up', () => moveSound(index, index - 1), index === 0),
    btn('↓', 'Move down', () => moveSound(index, index + 1), index === count - 1),
    btn('×', 'Remove', () => { banks[current].sounds.splice(index, 1); render(); }),
  );

  const canvas = document.createElement('canvas');
  canvas.className = 'env';
  canvas.setAttribute('aria-label', `Waveform and envelope of sound ${index + 1}. Drag A, D and End to shape it; click to play; double-click to reset.`);

  const view = { item, canvas, hover: null };
  const update = () => {
    const { item: it } = view;
    const cut = it.prepared.length - it.data.length;
    line.textContent = `${ms(it.data.length)} · ${it.units} KiB`;
    if (cut > 0) {
      const c = document.createElement('span');
      c.className = 'cut';
      c.textContent = ` · cut ${ms(cut)}`;
      c.title = `The prepared sound is ${ms(it.prepared.length)} long; the last ${ms(cut)} are not used.`;
      line.appendChild(c);
    }
    for (const [key, input] of Object.entries(inputs)) {
      if (document.activeElement !== input) input.value = sound[key] || '';
    }
    drawWave(view);
  };
  view.update = update;
  attachEnvelopeEditor(view, sound, index);
  canvas.view = view;
  waveResizer.observe(canvas);    // draws once the grid has sized the canvas
  update();

  li.append(idx, name, info, fields, actions, canvas);
  idx.ondragstart = e => { dragFrom = index; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(index)); };
  idx.ondragend = () => { dragFrom = null; };
  li.ondragover = e => { if (dragFrom !== null) { e.preventDefault(); e.stopPropagation(); li.classList.add('drag-over'); } };
  li.ondragleave = () => li.classList.remove('drag-over');
  li.ondrop = e => {
    if (dragFrom === null) return;
    e.preventDefault(); e.stopPropagation();
    moveSound(dragFrom, index);
    dragFrom = null;
  };
  return li;
}

function hasEnvelope(sound) { return sound.attackMs > 0 || sound.decayMs > 0 || sound.maxMs > 0; }
function resetEnvelope(sound) { sound.attackMs = sound.decayMs = sound.maxMs = 0; }

// ---------- envelope editor ----------

const ENV_PAD = 7;
const waveResizer = new ResizeObserver(entries => {
  for (const { target } of entries) if (target.view && target.isConnected) drawWave(target.view);
});

function envelopeOf(item) {
  const { sound, data, prepared: prep } = item;
  const n = data.length;
  return DDD.envelopeFor(n, settings, { raw: !!sound.raw, truncated: n < prep.length, attack: toSamples(sound.attackMs), decay: toSamples(sound.decayMs) });
}

// Handle positions in samples: A = end of attack, D = start of decay, E = end.
function handlePositions(item) {
  const n = item.data.length, [fadeIn, outStart] = envelopeOf(item);
  return { A: fadeIn, D: item.sound.decayMs > 0 ? outStart : n, E: n };
}

function attachEnvelopeEditor(view, sound, index) {
  const { canvas } = view;
  const span = () => Math.max(view.item.prepared.length, view.item.slot, 1);
  const toX = (sample, rect) => sample / span() * rect.width;
  const toSample = (clientX, rect) => Math.max(0, Math.min(span(), (clientX - rect.left) / rect.width * span()));
  const toMs = samples => Math.round(samples / settings.rate * 10000) / 10;

  function hit(e) {
    const rect = canvas.getBoundingClientRect(), x = e.clientX - rect.left, y = e.clientY - rect.top;
    const pos = handlePositions(view.item);
    let best = null, bestDist = 9;
    for (const key of ['A', 'D', 'E']) {
      const d = Math.abs(toX(pos[key], rect) - x);
      // A and D sit on the top edge, E is the end line; break ties by height.
      const bias = (key === 'E') === (y > rect.height * 0.55) ? 0 : 4;
      if (d + bias < bestDist) { best = key; bestDist = d + bias; }
    }
    return best;
  }

  function apply(key, e) {
    const rect = canvas.getBoundingClientRect(), at = toSample(e.clientX, rect);
    const { A, D, E } = handlePositions(view.item);
    const near = 3 / rect.width * span();           // within 3 px of the end = no limit
    if (key === 'A') {
      sound.attackMs = at < near ? 0 : toMs(Math.min(at, D, E));
    } else if (key === 'D') {
      sound.decayMs = at >= E - near ? 0 : toMs(Math.max(at, A, 1));
    } else {
      const full = Math.min(view.item.prepared.length, span());
      sound.maxMs = at >= full - near ? 0 : toMs(Math.max(at, A + 1, settings.rate / 1000));
    }
    // Recompute the bank: a new end changes how much room the other sounds get.
    const result = computeBank(current);
    view.item = result.items[index];
    renderCapacity(result.items);
    view.update();
  }

  let drag = null;
  canvas.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    drag = { key: hit(e), x: e.clientX, moved: false };
    canvas.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  canvas.addEventListener('pointermove', e => {
    if (!drag) {
      const key = hit(e);
      if (key !== view.hover) { view.hover = key; drawWave(view); }
      canvas.style.cursor = key ? 'ew-resize' : 'pointer';
      return;
    }
    if (Math.abs(e.clientX - drag.x) > 2) drag.moved = true;
    if (drag.key && drag.moved) { stopPlayback(); apply(drag.key, e); }
  });
  canvas.addEventListener('pointerup', e => {
    if (!drag) return;
    const { key, moved } = drag;
    drag = null;
    if (key && moved) render();
    else play(index);
  });
  canvas.addEventListener('pointercancel', () => { drag = null; render(); });
  canvas.addEventListener('pointerleave', () => { if (!drag && view.hover) { view.hover = null; drawWave(view); } });
  canvas.addEventListener('dblclick', () => { resetEnvelope(sound); render(); });
}

function drawWave(view) {
  const { canvas, item } = view;
  const { prepared: prep, data, slot } = item;
  if (!canvas.isConnected || !canvas.clientWidth) return;
  const dpr = window.devicePixelRatio || 1;
  const cw = Math.max(1, Math.round(canvas.clientWidth * dpr)), ch = Math.max(1, Math.round(canvas.clientHeight * dpr));
  if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; }
  const g = canvas.getContext('2d'), w = cw, h = ch, mid = h / 2, pad = ENV_PAD * dpr;
  const span = Math.max(prep.length, slot, 1), n = data.length;
  const X = sample => sample / span * w;
  g.clearRect(0, 0, w, h);
  g.fillStyle = '#2f2d34';                     // the space this sound has in the bank
  g.fillRect(0, 0, X(slot), h);
  const column = (from, to, color, getter) => {
    g.fillStyle = color;
    for (let x = 0; x < w; x++) {
      const a = Math.floor(x * span / w), b = Math.max(a + 1, Math.floor((x + 1) * span / w));
      if (b <= from || a >= to) continue;
      let lo = 0, hi = 0;
      for (let i = Math.max(a, from); i < Math.min(b, to); i++) { const v = getter(i); if (v < lo) lo = v; if (v > hi) hi = v; }
      g.fillRect(x, mid - hi * mid, 1, Math.max(1, (hi - lo) * mid));
    }
  };
  column(0, n, '#47434f', i => prep[i]);                    // before the envelope
  column(n, prep.length, '#6b5a3e', i => prep[i]);         // cut off
  column(0, n, '#b9b0c8', i => (data[i] - 128) / 128);     // what goes into the ROM
  g.fillStyle = '#ffffff1f';
  g.fillRect(0, mid, w, 1);

  // Envelope line
  const env = envelopeOf(item), top = pad, bottom = h - pad;
  const Y = gain => bottom - gain * (bottom - top);
  g.beginPath();
  g.moveTo(0, Y(0));
  for (let x = 0; x <= Math.ceil(X(n)); x++) {
    const i = Math.min(n - 1, Math.floor(x / w * span));
    g.lineTo(x, Y(DDD.envelopeGain(i, n, env)));
  }
  g.lineTo(X(n), Y(0));
  g.fillStyle = '#7fd1c214';
  g.fill();
  g.strokeStyle = '#7fd1c2';
  g.lineWidth = 1.5 * dpr;
  g.stroke();

  // Handles
  const pos = handlePositions(item);
  g.strokeStyle = view.hover === 'E' ? '#ffffff' : '#7fd1c2';
  g.setLineDash([3 * dpr, 3 * dpr]);
  g.beginPath(); g.moveTo(X(pos.E), 0); g.lineTo(X(pos.E), h); g.stroke();
  g.setLineDash([]);
  const knob = (key, x, y, set) => {
    g.beginPath();
    g.arc(Math.min(Math.max(x, pad * 0.8), w - pad * 0.8), y, (view.hover === key ? 6 : 4.5) * dpr, 0, Math.PI * 2);
    g.fillStyle = set ? '#7fd1c2' : '#2b2a30';
    g.fill();
    g.strokeStyle = view.hover === key ? '#ffffff' : '#7fd1c2';
    g.lineWidth = 1.5 * dpr;
    g.stroke();
  };
  knob('A', X(pos.A), top, item.sound.attackMs > 0);
  knob('D', X(pos.D), top, item.sound.decayMs > 0);
  knob('E', X(pos.E), bottom, item.sound.maxMs > 0);
  g.fillStyle = '#9fded3';
  g.font = `${11 * dpr}px system-ui, sans-serif`;
  g.textBaseline = 'top';
  const label = (text, x, y) => g.fillText(text, Math.min(Math.max(x + 7 * dpr, 2), w - 30 * dpr), y);
  label('A', X(pos.A), top + 4 * dpr);
  if (Math.abs(X(pos.D) - X(pos.A)) > 18 * dpr) label('D', X(pos.D), top + 4 * dpr);
  g.textBaseline = 'bottom';
  label('End', X(pos.E), bottom - 4 * dpr);
}

// ---------- editing ----------

function moveSound(from, to) {
  const list = banks[current].sounds;
  if (to < 0 || to >= list.length || from === to) return;
  list.splice(to, 0, list.splice(from, 1)[0]);
  render();
}

function clearBank() {
  if (!banks[current].sounds.length) return;
  if (!confirm(`Remove all sounds from Bank ${current + 1}?`)) return;
  banks[current] = { name: '', sounds: [] };
  render();
}

function uppercaseNames() {
  const bank = banks[current];
  bank.sounds.forEach(s => { s.name = s.name.toUpperCase(); });
  bank.name = bank.name.toUpperCase();
  render();
}

function applySettingsFromUI() {
  const preset = de('set_rate_preset').value;
  de('set_rate').hidden = preset !== 'custom';
  if (preset !== 'custom') de('set_rate').value = preset;
  const rate = Math.round(Number(de('set_rate').value));
  settings = {
    rate: rate >= 8000 && rate <= 96000 ? rate : settings.rate,
    layout: de('set_layout').value,
    dither: de('set_dither').value,
    decayCurve: de('set_curve').value,
    normDb: Math.min(0, Number(de('set_norm').value) || 0),
    silencePct: Math.max(0, Number(de('set_silence').value) || 0),
    fadeIn: Math.max(0, Math.round(Number(de('set_fadein').value) || 0)),
    fadeOut: Math.max(0, Math.round(Number(de('set_fadeout').value) || 0)),
  };
  render();
}

function settingsToUI() {
  const presets = ['44100', '25640', '25272'];
  de('set_rate_preset').value = presets.includes(String(settings.rate)) ? String(settings.rate) : 'custom';
  de('set_rate').hidden = de('set_rate_preset').value !== 'custom';
  de('set_rate').value = settings.rate;
  de('set_layout').value = settings.layout;
  de('set_dither').value = settings.dither;
  de('set_curve').value = settings.decayCurve;
  de('set_norm').value = settings.normDb;
  de('set_silence').value = settings.silencePct;
  de('set_fadein').value = settings.fadeIn;
  de('set_fadeout').value = settings.fadeOut;
}

function resetSettings() { settings = { ...DDD.DEFAULT_SETTINGS }; settingsToUI(); render(); }

// ---------- playback ----------

function stopPlayback() {
  if (playing) { try { playing.node.stop(); } catch (_) { /* already stopped */ } playing = null; }
  document.querySelectorAll('.sound.playing').forEach(el => el.classList.remove('playing'));
}

function play(index) {
  const sound = banks[current].sounds[index];
  if (!sound) return;
  stopPlayback();
  const item = computeBank(current).items[index];
  actx = actx || new AudioContext();
  const buffer = actx.createBuffer(1, Math.max(1, item.data.length), settings.rate);
  const ch = buffer.getChannelData(0);
  for (let i = 0; i < item.data.length; i++) ch[i] = (item.data[i] - 128) / 128;
  const node = actx.createBufferSource();
  node.buffer = buffer;
  node.connect(actx.destination);
  node.onended = () => { if (playing?.node === node) stopPlayback(); };
  node.start();
  playing = { node };
  de('sound_list').children[index]?.classList.add('playing');
}

// ---------- import ----------

async function readEntries(entry, path) {
  if (entry.isFile) {
    const file = await new Promise((res, rej) => entry.file(res, rej));
    return [{ file, path: path + file.name }];
  }
  const reader = entry.createReader(), out = [];
  for (;;) {
    const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
    if (!batch.length) break;
    for (const child of batch) out.push(...await readEntries(child, `${path}${entry.name}/`));
  }
  return out;
}

function bankFromPath(path) {
  const parts = path.split('/').slice(0, -1);
  for (let i = parts.length - 1; i >= 0; i--) {
    const m = /^bank\s*[_-]?\s*([1-8])$/i.exec(parts[i].trim());
    if (m) return Number(m[1]) - 1;
  }
  return -1;
}

const byName = (a, b) => a.file.name.localeCompare(b.file.name, undefined, { sensitivity: 'base' });

async function importAudio(entries) {
  const decoded = [];
  for (const { file } of entries) {
    try {
      const { data, rate } = await decodeAudio(await file.arrayBuffer(), file.name);
      decoded.push(newSound(DDD.nameFromFile(file.name), { file: file.name, source: data, sourceRate: rate }));
    } catch (e) {
      throw new Error(`${file.name}: ${e.message || 'cannot decode'}`);
    }
  }
  return decoded;
}

// Routes dropped or chosen files: ROM images, project ZIPs, [WAV_IN]/BankN folders, loose audio.
async function importEntries(entries) {
  const roms = entries.filter(e => ROM_EXT.test(e.file.name));
  const zips = entries.filter(e => /\.zip$/i.test(e.file.name));
  const audio = entries.filter(e => AUDIO_EXT.test(e.file.name) && !e.file.name.startsWith('._'));
  try {
    for (const z of zips) await loadZip(z.file);
    for (const r of roms) await loadRomBytes(new Uint8Array(await r.file.arrayBuffer()), r.file.name);
    if (!audio.length) { if (!zips.length && !roms.length) showMessage('No audio, ROM or ZIP files found.', 'warn'); return; }

    const grouped = new Map(), loose = [];
    for (const e of audio) {
      const b = bankFromPath(e.path);
      if (b < 0) loose.push(e);
      else { if (!grouped.has(b)) grouped.set(b, []); grouped.get(b).push(e); }
    }
    const notes = [];
    showMessage('Converting…');
    // Bank folders replace their bank, in filename order, like Deftaudio_MAIN.bat.
    for (const [b, list] of [...grouped].sort((x, y) => x[0] - y[0])) {
      list.sort(byName);
      if (list.length > DDD.MAX_SOUNDS) notes.push(`Bank ${b + 1}: only the first 8 of ${list.length} files were used`);
      banks[b] = { name: banks[b].name, sounds: await importAudio(list.slice(0, DDD.MAX_SOUNDS)) };
    }
    if (loose.length) {
      loose.sort(byName);
      const bank = banks[current], room = DDD.MAX_SOUNDS - bank.sounds.length;
      if (room <= 0) notes.push(`Bank ${current + 1} is full`);
      else {
        if (loose.length > room) notes.push(`Bank ${current + 1}: ${loose.length - room} file(s) did not fit`);
        bank.sounds.push(...await importAudio(loose.slice(0, room)));
      }
    }
    if (grouped.size && !grouped.has(current)) current = Math.min(...grouped.keys());
    render();
    showMessage(notes.length ? notes.join(' · ') : `Added ${audio.length} sound${audio.length > 1 ? 's' : ''}.`, notes.length ? 'warn' : '');
  } catch (e) {
    render();
    showMessage(e.message, 'error');
  }
}

function soundsFromRomBank(bytes) {
  const parsed = DDD.parseBank(bytes);
  if (!parsed) return null;
  const name = parsed.name === DDD.DEFAULT_BANK_NAME ? '' : parsed.name.trimEnd();
  const bank = {
    name,
    sounds: parsed.sounds.map(s => newSound(s.name || 'SOUND', { raw: s.data, rom: { addr: s.addr, units: s.units, slot: s.slot, length: s.data.length } })),
  };
  // Only keep the exact bytes when the names survive editing unchanged.
  if (bank.sounds.every((s, i) => s.name === parsed.sounds[i].name)) {
    bank.original = bytes;
    bank.originalSig = bankSignature(bank);
  }
  return bank;
}

async function loadRomBytes(bytes, label) {
  const parts = DDD.splitImage(bytes);
  if (parts.length === 1) {
    const bank = soundsFromRomBank(parts[0]);
    if (!bank) throw new Error(`${label} is not a DDD sound bank (no KORG header).`);
    if (banks[current].sounds.length && !confirm(`Replace Bank ${current + 1} with ${label}?`)) return;
    banks[current] = bank;
    render();
    showMessage(`Loaded ${label} into Bank ${current + 1}: ${bank.sounds.length} sounds.`);
    return;
  }
  if (banks.some(b => b.sounds.length) && !confirm(`Replace all 8 banks with ${label}?`)) return;
  let found = 0;
  banks = parts.map(p => { const b = soundsFromRomBank(p); if (b) found++; return b || { name: '', sounds: [] }; });
  current = Math.max(0, banks.findIndex(b => b.sounds.length));
  render();
  showMessage(`Loaded ${label}: ${found} bank${found === 1 ? '' : 's'} with sounds.`);
}

// ---------- project ZIP ----------

async function saveProjectZip() {
  try {
    const zip = new JSZip(), images = [];
    const project = { app: 'ddd-rom-tools', version: 1, settings, banks: [] };
    banks.forEach((bank, b) => {
      const result = computeBank(b);
      images.push(result.image);
      project.banks.push({
        name: bank.name,
        sounds: bank.sounds.map((s, i) => {
          const file = `sources/Bank${b + 1}/${String(i + 1).padStart(2, '0')}.wav`;
          zip.file(file, s.raw ? DDD.encodeWav(s.raw, settings.rate, 8) : DDD.encodeWav(s.source, s.sourceRate, 32));
          return { name: s.name, file, original: s.file, maxMs: s.maxMs, attackMs: s.attackMs, decayMs: s.decayMs, raw: !!s.raw };
        }),
      });
      if (result.image) {
        zip.file(`banks/Bank${b + 1}.bin`, result.image);
        result.items.forEach((it, i) => zip.file(`processed/Bank${b + 1}/${i + 1} ${it.sound.name.trim() || 'sound'}.wav`, DDD.encodeWav(it.data, settings.rate, 8)));
      }
    });
    zip.file('PicoROM.BIN', DDD.buildImage(images));
    zip.file('project.json', JSON.stringify(project, null, 2));
    download(await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' }), 'DDD_project.zip');
    showMessage('Project saved: sources, bank .bin files, PicoROM.BIN and processed WAVs.');
  } catch (e) { showMessage(`Save failed: ${e.message}`, 'error'); }
}

function envelopeFields(ps) {
  return { maxMs: ps.maxMs || 0, attackMs: ps.attackMs || 0, decayMs: ps.decayMs || 0 };
}

async function loadZip(file) {
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const manifest = zip.file('project.json');
  if (!manifest) {
    // A zipped [WAV_IN] folder or loose files.
    const entries = [];
    for (const f of Object.values(zip.files)) {
      if (f.dir || f.name.includes('__MACOSX')) continue;
      const blob = await f.async('blob');
      entries.push({ file: new File([blob], f.name.split('/').pop()), path: f.name });
    }
    await importEntries(entries);
    return;
  }
  const project = JSON.parse(await manifest.async('string'));
  if (project.app !== 'ddd-rom-tools' || !Array.isArray(project.banks)) throw new Error('Unknown project file.');
  if (banks.some(b => b.sounds.length) && !confirm('Replace the current banks with this project?')) return;
  settings = { ...DDD.DEFAULT_SETTINGS, ...project.settings };
  const loaded = [];
  for (let b = 0; b < DDD.BANKS; b++) {
    const pb = project.banks[b] || { name: '', sounds: [] };
    const sounds = [];
    for (const ps of (pb.sounds || []).slice(0, DDD.MAX_SOUNDS)) {
      const entry = zip.file(ps.file);
      if (!entry) throw new Error(`Missing ${ps.file} in project.`);
      const buf = await entry.async('arraybuffer');
      if (ps.raw) {
        const body = riffChunks(buf, true).get('data');
        sounds.push(newSound(ps.name, { raw: new Uint8Array(buf, body.offset, body.length).slice(), ...envelopeFields(ps) }));
      } else {
        const { data, rate } = await decodeAudio(buf, ps.file);
        sounds.push(newSound(ps.name, { file: ps.original || ps.file, source: data, sourceRate: rate, ...envelopeFields(ps) }));
      }
    }
    loaded.push({ name: DDD.cleanName(pb.name || ''), sounds });
  }
  banks = loaded;
  current = Math.max(0, banks.findIndex(b => b.sounds.length));
  settingsToUI();
  render();
  showMessage(`Project ${file.name} loaded.`);
}

// ---------- export / PicoROM ----------

function download(data, filename) {
  const blob = data instanceof Blob ? data : new Blob([data], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob), a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function exportBankBin() {
  try {
    const { image } = computeBank(current);
    if (!image) { showMessage(`Bank ${current + 1} is empty.`, 'warn'); return; }
    download(image, `Bank${current + 1}.bin`);
    showMessage(`Bank${current + 1}.bin exported (32768 bytes).`);
  } catch (e) { showMessage(e.message, 'error'); }
}

function emptyBankNote() {
  const empty = banks.map((b, i) => b.sounds.length ? 0 : i + 1).filter(Boolean);
  return empty.length ? ` Empty bank${empty.length > 1 ? 's' : ''} ${empty.join(', ')} written as zeros.` : '';
}

function exportImage() {
  try {
    download(DDD.buildImage(buildAllBanks()), 'PicoROM.BIN');
    showMessage('PicoROM.BIN exported (262144 bytes).' + emptyBankNote(), emptyBankNote() ? 'warn' : '');
  } catch (e) { showMessage(e.message, 'error'); }
}

function setPicoBusy(busy) {
  picoBusy = busy;
  de('read_picorom').disabled = de('program_picorom').disabled = busy;
}

async function programPicoROMClicked() {
  if (picoBusy) return;
  setPicoBusy(true);
  try {
    const image = DDD.buildImage(buildAllBanks());
    showMessage('Choose the PicoROM to program.');
    // The device keeps its name ("PicoROM"); only the 2 Mbit image is replaced.
    await window.PicoROM.upload(image.buffer, (done, total) => showMessage(`Programming PicoROM: ${Math.floor(done / total * 100)}%`), null);
    showMessage('PicoROM programmed and verified.' + emptyBankNote(), emptyBankNote() ? 'warn' : '');
  } catch (e) {
    showMessage(`PicoROM programming failed: ${e.message}`, 'error');
  } finally { setPicoBusy(false); }
}

async function readPicoROMClicked() {
  if (picoBusy) return;
  setPicoBusy(true);
  try {
    showMessage('Choose the PicoROM to read.');
    const image = new Uint8Array(await window.PicoROM.readImage((done, total) => showMessage(`Reading PicoROM: ${Math.floor(done / total * 100)}%`)));
    await loadRomBytes(image, 'PicoROM');
  } catch (e) {
    showMessage(`PicoROM read failed: ${e.message}`, 'error');
  } finally { setPicoBusy(false); }
}

// ---------- wiring ----------

function init() {
  settingsToUI();
  for (const id of ['set_rate_preset', 'set_rate', 'set_layout', 'set_dither', 'set_curve', 'set_norm', 'set_silence', 'set_fadein', 'set_fadeout']) {
    de(id).addEventListener('change', applySettingsFromUI);
  }
  de('bank_name').addEventListener('input', e => {
    const clean = DDD.cleanName(e.target.value);
    if (clean !== e.target.value) e.target.value = clean;
    banks[current].name = clean;
    renderTabs();
  });
  const fromInput = input => {
    const entries = [...input.files].map(file => ({ file, path: file.webkitRelativePath || file.name }));
    input.value = '';
    importEntries(entries);
  };
  for (const id of ['open_files', 'add_files', 'open_folder']) de(id).addEventListener('change', e => fromInput(e.target));

  const panel = de('bank_panel');
  document.addEventListener('dragover', e => {
    if (dragFrom !== null) return;
    e.preventDefault();
    panel.classList.add('drag-active');
  });
  document.addEventListener('dragleave', e => { if (!e.relatedTarget) panel.classList.remove('drag-active'); });
  document.addEventListener('drop', async e => {
    panel.classList.remove('drag-active');
    if (dragFrom !== null) return;
    e.preventDefault();
    // Read everything from the event before the first await. Plain files come
    // from dataTransfer.files: the entry API's file() fails on file:// pages,
    // so it is only used to walk dropped folders.
    const files = [...e.dataTransfer.files];
    const items = [...(e.dataTransfer.items || [])].filter(i => i.kind === 'file').map(i => i.webkitGetAsEntry?.());
    const entries = [], failed = [];
    for (let i = 0; i < files.length; i++) {
      const entry = items.length === files.length ? items[i] : null;
      if (!entry?.isDirectory) { entries.push({ file: files[i], path: files[i].name }); continue; }
      try { entries.push(...await readEntries(entry, '')); }
      catch (_) { failed.push(entry.name); }
    }
    if (failed.length && !entries.length) {
      showMessage(`This browser cannot read dropped folders on a page opened from disk (${failed.join(', ')}). Use Open folder… instead.`, 'error');
      return;
    }
    await importEntries(entries);
    if (failed.length) showMessage(`${de('app_status').textContent} Folder(s) ${failed.join(', ')} could not be read here; use Open folder… for them.`, 'warn');
  });

  document.addEventListener('keydown', e => {
    const t = e.target;
    if (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || e.metaKey || e.ctrlKey || e.altKey) return;
    if (/^[1-8]$/.test(e.key)) { e.preventDefault(); play(Number(e.key) - 1); }
    else if (e.key === 'Escape') stopPlayback();
  });
  if (!navigator.serial) {
    de('program_picorom').title = de('read_picorom').title = 'Needs desktop Chrome or Edge (Web Serial). Open index.html directly, or host it on HTTPS or localhost.';
  }
  render();
}

document.addEventListener('DOMContentLoaded', init);
