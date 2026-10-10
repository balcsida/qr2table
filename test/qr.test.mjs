// Run: node test/qr.test.mjs  (Node >= 20; fetches the CDN scripts named in index.html)
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const page = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const cdn = [...html.matchAll(/<script src="([^"]*(?:qrcode-generator|jsqr)[^"]*)"/gi)].map(m => m[1]);
assert.equal(cdn.length, 2);
const el = { value: '', checked: false, style: {}, innerHTML: '', textContent: '', placeholder: '', addEventListener() {}, getContext() { return {}; } };
const ctx = vm.createContext({ document: { getElementById: () => el, createElement: () => el }, console });
for (const src of [...(await Promise.all(cdn.map(u => fetch(u.startsWith('//') ? 'https:' + u : u).then(r => r.text())))), page])
  vm.runInContext(src, ctx);
const { qrcode, jsQR, buildProtectionMask, remaskQR, qrCodewordMap, applyQRLossy, buildTableHTML } = ctx;
const QR_BLOCKS = vm.runInContext('QR_BLOCKS', ctx); // top-level const: visible to scripts, not a context property

const TOTAL = [26,44,70,100,134,172,196,242,292,346,404,466,532,581,655,733,815,901,991,1085,1156,1258,1364,1474,1588,1706,1828,1921,2051,2185,2323,2465,2611,2761,2876,3034,3196,3362,3532,3706];
const remBits = v => v == 1 ? 0 : v <= 6 ? 7 : v <= 13 ? 0 : v <= 20 ? 3 : v <= 27 ? 4 : v <= 34 ? 3 : 0;
const PAD = 4;
const make = (text, level, version = 0) => {
  const qr = qrcode(version, level); qr.addData(text); qr.make();
  const n = qr.getModuleCount(), t = n + PAD * 2;
  return Array.from({ length: t }, (_, r) => Array.from({ length: t }, (_, c) => r >= PAD && c >= PAD && r < t - PAD && c < t - PAD && qr.isDark(r - PAD, c - PAD)));
};
// Decode with a 4-module white margin, 10 px per module
const decode = grid => {
  const m = 4, t = grid.length + 2 * m, w = t * 10, px = new Uint8ClampedArray(w * w * 4).fill(255);
  for (let r = 0; r < grid.length; r++) for (let c = 0; c < grid.length; c++) if (grid[r][c])
    for (let y = 0; y < 10; y++) for (let x = 0; x < 10; x++) { const i = (((r + m) * 10 + y) * w + (c + m) * 10 + x) * 4; px[i] = px[i + 1] = px[i + 2] = 0; }
  return jsQR(px, w, w)?.data ?? null;
};

// A. function-module mask matches the QR spec capacity
for (let v = 1; v <= 40; v++) {
  const g = make('A', 'L', v), n = g.length - 2 * PAD;
  const free = buildProtectionMask(n, PAD, g.length).reduce((a, row) => a + row.filter(x => !x).length, 0);
  assert.equal(free, 8 * TOTAL[v - 1] + remBits(v), `v${v} non-function modules`);
  const { codewords } = qrCodewordMap(g, PAD, buildProtectionMask(n, PAD, g.length));
  assert.equal(codewords.length, TOTAL[v - 1]);
  for (const [ec, nb] of QR_BLOCKS[v - 1]) assert.ok(nb * ec < TOTAL[v - 1]);
}

const INPUTS = ['https://example.com', 'https://example.com/path/to/some/page?utm_source=newsletter&utm_campaign=spring&id=12345',
  'BEGIN:VCARD\nVERSION:3.0\nN:Doe;Jane;;;\nFN:Jane Doe\nORG:Example Corp\nTITLE:Chief Example Officer\nTEL;TYPE=WORK:+1-555-0100\nEMAIL:jane.doe@example.com\nURL:https://example.com/jane\nADR;TYPE=WORK:;;1 Example Way;Springfield;IL;62701;USA\nNOTE:Met at the 2025 conference, follow up next week.\nEND:VCARD'];
const LEVELS = ['L', 'M', 'Q', 'H'];

// B. every mask decodes; re-masking to the original mask is the identity
for (const text of INPUTS) for (const L of LEVELS) {
  const g = make(text, L), n = g.length - 2 * PAD, protect = buildProtectionMask(n, PAD, g.length);
  let orig = 0;
  for (let i = 0; i < 15; i++) orig |= g[PAD + (i < 6 ? i : i < 8 ? i + 1 : n - 15 + i)][PAD + 8] << i;
  orig = ((orig ^ 0x5412) >> 10) & 7;
  assert.ok(JSON.stringify(remaskQR(g, PAD, protect, orig)) == JSON.stringify(g), 'identity re-mask'); // JSON: arrays cross vm realms
  for (let m = 0; m < 8; m++) {
    const r = remaskQR(g, PAD, protect, m);
    for (let i = 0; i < 15; i++) assert.equal(r[PAD + 8][PAD + (i < 8 ? n - 1 - i : i == 8 ? 7 : 14 - i)], r[PAD + (i < 6 ? i : i < 8 ? i + 1 : n - 15 + i)][PAD + 8], 'format copies agree');
    assert.equal(decode(r), text, `mask ${m} ${L} ${text.length}`);
  }
}

const pbits = (v, l) => v == 1 ? [3, 2, 1, 1][l] : v == 2 && l == 0 ? 2 : v == 3 && l == 0 ? 1 : 0;
const copy = g => g.map(r => r.slice());

// C. block mapping: `capacity` bad codewords per block decode, capacity+1 in one block does not
for (const text of INPUTS) for (const [l, L] of [...LEVELS].entries()) {
  const g = make(text, L), n = g.length - 2 * PAD, v = (n - 17) / 4, protect = buildProtectionMask(n, PAD, g.length);
  const { codewords } = qrCodewordMap(g, PAD, protect), [ec, nb] = QR_BLOCKS[v - 1][l];
  // Independent layout: build each block, then interleave data columns followed by EC columns
  const data = codewords.length - nb * ec, lens = Array.from({ length: nb }, (_, b) => Math.floor(data / nb) + (b >= nb - data % nb ? 1 : 0));
  const blocks = lens.map(() => []);
  let k = 0;
  for (let i = 0; i < Math.max(...lens); i++) for (let b = 0; b < nb; b++) if (i < lens[b]) blocks[b].push(k++);
  for (let i = 0; i < ec; i++) for (let b = 0; b < nb; b++) blocks[b].push(k++);
  assert.equal(k, codewords.length);
  const cap = Math.floor((ec - pbits(v, l)) / 2);
  const spread = (b, count) => Array.from({ length: count }, (_, i) => blocks[b][Math.floor(i * blocks[b].length / count)]);
  const hit = ks => { const h = copy(g); for (const q of ks) for (const [r, c] of codewords[q]) h[r][c] = !h[r][c]; return h; };
  assert.equal(decode(hit(blocks.flatMap((_, b) => spread(b, cap)))), text, `${L} v${v} capacity`);
  // jsQR has no misdecode guard, so it still fixes cap+1 when 2*(cap+1) <= ec
  if (2 * (cap + 1) > ec) assert.notEqual(decode(hit(spread(nb - 1, cap + 1))), text, `${L} v${v} capacity+1`);
}

// D/E. lossy output stays scannable and smaller; benchmark
const bytes = g => buildTableHTML(g, g.length, g.length, 4, '#000', '#fff');
const pipeline = (g, budget, level) => { // best of 8 masks, lossy applied per candidate like generate()
  const protect = buildProtectionMask(g.length - 2 * PAD, PAD, g.length);
  let best;
  for (let m = 0; m < 8; m++) {
    const h = remaskQR(g, PAD, protect, m);
    if (budget) applyQRLossy(h, PAD, protect, level, budget);
    const t = bytes(h);
    if (!best || t.tableHTML.length < best.len) best = { len: t.tableHTML.length, cells: t.cellCount, ok: decode(h) !== null };
  }
  return best;
};
const rows = [];
for (const [i, text] of INPUTS.entries()) for (const L of LEVELS) {
  const g = make(text, L), t = bytes(g);
  const cols = [pipeline(g, 0, L), pipeline(g, 0.2, L), pipeline(g, 1, L)];
  const h = copy(g); applyQRLossy(h, PAD, buildProtectionMask(g.length - 2 * PAD, PAD, g.length), L, 1);
  assert.equal(decode(h), text, `lossy 100% ${L}`);
  assert.ok(bytes(h).tableHTML.length < t.tableHTML.length, `lossy 100% smaller ${L}`);
  for (const c of cols) assert.ok(c.ok, `pipeline decodes ${L}`);
  const f = c => `${String(c.len).padStart(6)}B/${String(c.cells).padStart(4)}c ${c.ok ? 'ok' : 'FAIL'}`;
  rows.push(`in#${i} ${L} v${(g.length - 2 * PAD - 17) / 4}`.padEnd(12) + `| orig ${String(t.tableHTML.length).padStart(6)}B/${String(t.cellCount).padStart(4)}c ok | mask ${f(cols[0])} | +20% ${f(cols[1])} | +100% ${f(cols[2])}`);
}
console.log(rows.join('\n'));
console.log('ok');
