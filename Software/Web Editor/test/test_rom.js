// node ddd_editor/test/test_rom.js
// Checks the generated headers against the original script templates.
const fs = require('fs');
const path = require('path');
const assert = require('assert');
global.resampleSinc = require('../js/resample_sinc.js').resampleSinc;
const DDD = require('../js/ddd_rom.js');

const ref = path.join(__dirname, '..', '..', 'Korg DDD Expansion Sound ROM Creator v0.4');
const meta = f => new Uint8Array(fs.readFileSync(path.join(ref, 'tools', 'meta', f)));

// 1. Classic layout reproduces the NX.ddd template header byte for byte.
for (let n = 1; n <= 8; n++) {
  const lay = DDD.layoutBank(Array.from({ length: n }, () => ({ available: 40000 })), 'classic');
  const sounds = lay.map((l, i) => ({ name: `SAMPLE ${i + 1}`, data: new Uint8Array(l.length).fill(0x40), addr: l.addr, units: l.units }));
  const bank = DDD.buildBank(' CUSTOM ', sounds);
  const tpl = meta(`${n}x.ddd`);
  assert.deepStrictEqual(bank.subarray(0, tpl.length), tpl, `${n}x header differs`);
  // Data follows the script concatenation: sample, then 0x80 padding (57 bytes in 8X).
  if (n === 8) {
    assert.strictEqual(lay[1].addr - lay[0].addr - lay[0].length, 57);
    assert.ok(bank.subarray(lay[0].addr + 4000, lay[1].addr).every(b => b === 0x80));
  }
  console.log(`ok  ${n}x header matches template`);
}

// 2. Auto layout never overlaps and stays inside the bank.
for (const lens of [[100], [40000], [5000, 300, 90000], Array(8).fill(9000), [1, 2, 3, 4, 5, 6, 7, 8]]) {
  const lay = DDD.layoutBank(lens.map(available => ({ available })), 'auto');
  let end = DDD.DATA_START;
  lay.forEach(l => {
    assert.ok(l.addr === end && l.units >= 1 && l.length <= l.units * 1024 && l.length >= 1);
    end = l.addr + l.slot;
  });
  assert.ok(end <= DDD.BANK_SIZE);
}
console.log('ok  auto layout');

// 3. Round trip: build -> parse keeps names and data.
{
  const lay = DDD.layoutBank([{ available: 3000 }, { available: 7000 }], 'auto');
  const data = [new Uint8Array(3000).map((_, i) => (i * 7) & 0x7f), new Uint8Array(7000).map((_, i) => 0x81 + (i & 0x3f))];
  const bank = DDD.buildBank('MY KIT', lay.map((l, i) => ({ name: ['Kick', 'Snare 2'][i], data: data[i], addr: l.addr, units: l.units })));
  const parsed = DDD.parseBank(bank);
  assert.strictEqual(parsed.name, 'MY KIT  ');
  assert.deepStrictEqual(parsed.sounds.map(s => s.name), ['Kick', 'Snare 2']);
  assert.deepStrictEqual(parsed.sounds[0].data, data[0]);
  assert.deepStrictEqual(parsed.sounds[1].data, data[1]);
  console.log('ok  bank round trip');
}

// 4. Image order matches the script: copy /b Bank1+Bank5+Bank3+Bank7+Bank2+Bank6+Bank4+Bank8.
{
  const banks = Array.from({ length: 8 }, (_, b) => new Uint8Array(DDD.BANK_SIZE).fill(b + 1));
  const image = DDD.buildImage(banks);
  assert.deepStrictEqual([0, 1, 2, 3, 4, 5, 6, 7].map(k => image[k * DDD.BANK_SIZE]), [1, 5, 3, 7, 2, 6, 4, 8]);
  const back = DDD.splitImage(image);
  back.forEach((b, i) => assert.strictEqual(b[0], i + 1));
  console.log('ok  PicoROM image order');
}

// 5. Existing script output parses (Bank1.bin, or bank 1 of PicoROM.BIN).
{
  const bin = path.join(ref, 'banks', 'Bank1.bin'), image = path.join(ref, 'PicoROM.BIN');
  const b1 = fs.existsSync(bin) ? new Uint8Array(fs.readFileSync(bin))
    : fs.existsSync(image) ? DDD.splitImage(new Uint8Array(fs.readFileSync(image)))[0] : null;
  if (!b1) console.log('skip parse test: no Bank1.bin or PicoROM.BIN');
  else {
    const parsed = DDD.parseBank(b1);
    assert.strictEqual(parsed.sounds.length, 8);
    console.log('ok  parsed bank 1:', parsed.sounds.map(s => `${s.name}(${s.data.length})`).join(', '));
  }
}

// 6. DSP: trims leading silence, normalizes, fades, quantizes.
{
  const src = new Float32Array(1000);
  for (let i = 100; i < 1000; i++) src[i] = 0.5 * Math.sin(i / 5);
  const prep = DDD.prepare(src, 44100, { rate: 44100 });
  assert.ok(prep.length < 1000 && prep.length >= 890);
  const peak = Math.max(...prep.map(Math.abs));
  assert.ok(Math.abs(peak - Math.pow(10, -0.3 / 20)) < 1e-6);
  const out = DDD.finalize(prep, 500, {});
  assert.strictEqual(out.length, 500);
  assert.ok(Math.abs(out[499] - 128) <= 1);
  const raw = new Uint8Array([128, 200, 50, 255, 0]);
  const rt = DDD.finalize(Float32Array.from(raw, b => (b - 128) / 128), 5, {}, { raw: true });
  assert.deepStrictEqual(rt, raw);
  // Per-sound envelope: decay from sample 200 to the end, attack of 100 samples.
  const flat = new Float32Array(400).fill(0.5);
  const env = DDD.finalize(flat, 400, { dither: 'none' }, { attack: 100, decay: 200 });
  assert.ok(env[0] === 128 && env[150] === 192 && env[199] === 192);
  assert.ok(env[300] < 160 && env[300] > 128 && Math.abs(env[399] - 128) <= 1);
  // Without an envelope, the middle is untouched (only the 2/50-sample fades apply).
  const plain = DDD.finalize(flat, 400, { dither: 'none' });
  assert.ok(plain[2] === 192 && plain[349] === 192 && plain[360] < 192);
  // Raw ROM data stays bit-exact unless an envelope is drawn.
  assert.deepStrictEqual(DDD.finalize(Float32Array.from(raw, b => (b - 128) / 128), 5, {}, { raw: true }), raw);
  console.log('ok  dsp');
}
console.log('all tests passed');
