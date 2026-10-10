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
const { qrcode, jsQR, buildProtectionMask, remaskQR } = ctx;

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
console.log('ok');
