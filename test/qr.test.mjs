// Run: node test/qr.test.mjs  (Node >= 20; fetches the CDN scripts named in index.html)
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const page = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const cdn = [...html.matchAll(/<script src="([^"]*(?:qrcode-generator|jsqr)[^"]*)"/gi)].map(m => m[1]);
assert.equal(cdn.length, 2);
// One stub element per id, so a test can fill in the form and run generate(). As a canvas it does what
// verifyScan() needs: fill rectangles in black or white and hand the pixels to jsQR.
const els = {};
const element = () => ({
  value: '', checked: false, style: {}, classList: { add() {}, remove() {} }, innerHTML: '', textContent: '', placeholder: '', addEventListener() {},
  getContext() {
    const { width } = this, px = new Uint8ClampedArray(width * this.height * 4);
    return {
      fillRect(x, y, w, h) { for (let j = y; j < y + h; j++) px.fill(this.fillStyle === '#ffffff' ? 255 : 0, (j * width + x) * 4, (j * width + x + w) * 4); },
      getImageData: () => ({ data: px }),
    };
  },
});
let clipboard; // what the page last wrote to the clipboard
const ctx = vm.createContext({
  document: { getElementById: id => els[id] ??= element(), createElement: element }, console, Blob, setTimeout() {},
  navigator: { clipboard: { write: async items => { clipboard = items; } } },
  ClipboardItem: class { constructor(flavors) { Object.assign(this, flavors); } },
});
const libs = await Promise.all(cdn.map(u => fetch(u.startsWith('//') ? 'https:' + u : u).then(r => r.text())));
for (const src of [...libs, page]) vm.runInContext(src, ctx);
// qrcode-generator's RS_BLOCK_TABLE: [count, totalCount, dataCount(, count2, totalCount2, dataCount2)] × (L,M,Q,H) × 40 versions
const RS = JSON.parse(libs[0].match(/\[\[1,26,19\](?:,\[[\d,]+\])*\]/)[0]);
assert.equal(RS.length, 160);
const { qrcode, jsQR, buildProtectionMask, remaskQR, qrCodewordMap, applyQRLossy, buildTableHTML, buildTeamsHTML, copyRich } = ctx;
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
  QR_BLOCKS[v - 1].forEach(([ec, nb], l) => {
    const e = RS[(v - 1) * 4 + l];
    assert.equal(ec, e[1] - e[2], `v${v} ${'LMQH'[l]} ec per block`);
    assert.equal(nb, e[0] + (e[3] || 0), `v${v} ${'LMQH'[l]} blocks`);
  });
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
const CS = 4;
const bytes = g => buildTableHTML(g, CS, '#000', '#fff');
const pipeline = (g, budget, level, text) => { // best of 8 masks, lossy applied per candidate like generate()
  const protect = buildProtectionMask(g.length - 2 * PAD, PAD, g.length);
  let best;
  for (let m = 0; m < 8; m++) {
    const h = remaskQR(g, PAD, protect, m);
    if (budget) applyQRLossy(h, PAD, protect, level, budget);
    const t = bytes(h);
    if (!best || t.tableHTML.length < best.len) best = { len: t.tableHTML.length, cells: t.cellCount, ok: decode(h) === text };
  }
  return best;
};
const rows = [];
let total = 0;
for (const [i, text] of INPUTS.entries()) for (const L of LEVELS) {
  const g = make(text, L), t = bytes(g);
  const cols = [pipeline(g, 0, L, text), pipeline(g, 0.2, L, text), pipeline(g, 1, L, text)];
  assert.ok(cols[0].len <= t.tableHTML.length, `mask selection never worse ${L}`);
  const h = copy(g); applyQRLossy(h, PAD, buildProtectionMask(g.length - 2 * PAD, PAD, g.length), L, 1);
  assert.equal(decode(h), text, `lossy 100% ${L}`);
  assert.ok(bytes(h).tableHTML.length < t.tableHTML.length, `lossy 100% smaller ${L}`);
  for (const c of cols) assert.ok(c.ok, `pipeline decodes ${L}`);
  total += cols[0].len;
  const f = c => `${String(c.len).padStart(6)}B/${String(c.cells).padStart(4)}c ${c.ok ? 'ok' : 'FAIL'}`;
  rows.push(`in#${i} ${L} v${(g.length - 2 * PAD - 17) / 4}`.padEnd(12) + `| orig ${String(t.tableHTML.length).padStart(6)}B/${String(t.cellCount).padStart(4)}c ok | mask ${f(cols[0])} | +20% ${f(cols[1])} | +100% ${f(cols[2])}`);
}
console.log(rows.join('\n'));
// The same 12 symbols took 958,677 bytes while every cell carried its own width, height and padding
assert.ok(total < 316e3, `lossless tables of the 12 symbols total ${total} bytes`);

// The cells of each <tr> as attribute strings; end tags are optional
const cellRows = html => [...html.matchAll(/<tr>(.*?)(?=<tr>|<\/table>)/g)].map(([, row]) => [...row.matchAll(/<td([^>]*)>/g)].map(([, attrs]) => attrs));
const spanOf = (attrs, k) => +(attrs.match(new RegExp(`${k}span="?(\\d+)`))?.[1] ?? 1);
// Lay a table back out into a grid as the HTML table model does: each cell takes the next free slot of its row
const layout = (html, isDark) => {
  const g = [], occupied = [];
  cellRows(html).forEach((row, r) => {
    g[r] ??= []; occupied[r] ??= [];
    let c = 0;
    for (const attrs of row) {
      const w = spanOf(attrs, 'col'), h = spanOf(attrs, 'row');
      while (occupied[r][c]) c++;
      for (let dr = 0; dr < h; dr++) for (let dc = 0; dc < w; dc++) {
        assert.ok(!occupied[r + dr]?.[c + dc], 'cells overlap');
        (g[r + dr] ??= [])[c + dc] = isDark(attrs);
        (occupied[r + dr] ??= [])[c + dc] = 1;
      }
      c += w;
    }
  });
  return g;
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b); // JSON: arrays cross vm realms

// The two formats on the smallest grid with a cell that is neither in row 0 nor in column 0.
// Email: sizes on the edge cells only, unquoted attribute values, no </td> or </tr>. Teams: as posted and checked in Teams.
const dot = [[true, false], [false, true]];
assert.equal(buildTableHTML(dot, CS, '#000', '#fff').tableHTML, '<table role=presentation cellpadding=0 cellspacing=0 border=0 style="border-collapse:collapse;border-spacing:0;margin:0 auto;font-size:0;line-height:0;background:#fff">'
  + '<tr><td height=4 style=width:4px;height:4px;background:#000><td style=width:4px><tr><td height=4 style=height:4px><td style=background:#000></table>', 'email markup');
assert.equal(buildTeamsHTML(dot), '<table><tr><td width="21" style="background-color:currentcolor"></td><td width="21"></td></tr>'
  + '<tr><td></td><td style="background-color:currentcolor"></td></tr></table>', 'Teams markup');

// F. the Teams table (modules in currentcolor, no px sizes) lays back out to the same grid
const teamsGrid = g => layout(buildTeamsHTML(g), attrs => attrs.includes('background-color:currentcolor'));
for (const text of INPUTS) for (const L of LEVELS) {
  const g = make(text, L);
  const teams = buildTeamsHTML(g), back = teamsGrid(g);
  // Teams' dark theme rewrites hex and rgb() colors, which is what turned a painted code black on dark gray
  assert.ok(!/#[0-9a-f]{3}|rgb\(/i.test(teams), `Teams table has no literal colors ${L} ${text.length}`);
  assert.ok(same(back, g), `Teams table round-trips ${L} ${text.length}`);
  assert.equal(decode(back), text, `Teams table decodes ${L} ${text.length}`);
}

// G. the email table states each track's size once, widths on row 0 and heights on column 0, and lays back out to the grid
const emailTable = html => {
  const rows = cellRows(html);
  // a size is stated by the attribute or by the CSS property; min-height does not size a table cell
  const size = (attrs, k) => +(attrs.match(new RegExp(`(?:^|[ ;="])${k}(?::|="?)(\\d+)`))?.[1] ?? NaN) / CS;
  const widths = rows[0].map(attrs => size(attrs, 'width')), heights = rows.map(row => size(row[0], 'height'));
  assert.ok([...widths, ...heights].every(Number.isInteger), 'every track states its size');
  rows.forEach((row, r) => row.forEach((attrs, c) => {
    assert.ok(r === 0 || !attrs.includes('width'), 'only row 0 states widths');
    assert.ok(c === 0 || !attrs.includes('height'), 'only column 0 states heights');
  }));
  const grid = layout(html, attrs => attrs.includes('background:')).flatMap((row, r) => Array.from({ length: heights[r] }, () => row.flatMap((dark, c) => Array(widths[c]).fill(dark))));
  return { rows, widths, heights, grid };
};
// What mail clients are known to do to the markup (caniemail: css-height, html-height, html-width)
const CLIENTS = {
  'as sent': html => html,
  'in Yahoo and AOL, which turn CSS height into min-height': html => html.replace(/([;="])height:/g, '$1min-height:'),
  'in HEY, which drops size attributes': html => html.replace(/ (?:width|height)="?\d+"?/g, ''),
};
const checkEmail = (g, label) => {
  const { tableHTML, cellCount } = buildTableHTML(g, CS, '#000', '#fff');
  assert.equal(cellCount, tableHTML.match(/<td/g).length, `cell count ${label}`);
  for (const [client, rewrite] of Object.entries(CLIENTS)) assert.ok(same(emailTable(rewrite(tableHTML)).grid, g), `email table lays back out ${client}: ${label}`);
  const t = emailTable(tableHTML);
  // packing is by bytes: a merged cell never costs more than its modules would as 1x1 cells (<td> or <td style=background:#000>)
  t.rows.forEach((row, r) => row.forEach((attrs, c) => {
    if (r && c) assert.ok(attrs.length + 4 <= spanOf(attrs, 'col') * spanOf(attrs, 'row') * (attrs.includes('background:') ? 26 : 4), `merge pays for itself: <td${attrs}> ${label}`);
  }));
  return t;
};
for (const text of INPUTS) for (const L of LEVELS) {
  const g = make(text, L), t = checkEmail(g, `${L} ${text.length}`);
  assert.deepEqual([t.widths[0], t.widths.at(-1), t.heights[0], t.heights.at(-1)], [PAD, PAD, PAD, PAD], `each side of the quiet zone is one track ${L} ${text.length}`);
}
const small = make(INPUTS[0], 'M');
checkEmail(small.slice(PAD, -PAD).map(row => row.slice(PAD, -PAD)), 'no quiet zone');
// bwip-js draws 2D modules as 2x2 px: the tracks are those of the modules, twice the size
const doubled = small.flatMap(row => { const wide = row.flatMap(dark => [dark, dark]); return [wide, wide]; });
assert.deepEqual(checkEmail(doubled, '2x2 px modules').widths, checkEmail(small, 'modules').widths.map(w => w * 2), '2x2 px modules are one cell each');
// a 1D barcode is a single row whose columns are its bars
const bars = [...'110100101100111010010110001101'].map(bit => bit === '1');
const barcode = checkEmail(Array.from({ length: 12 }, () => bars), '1D barcode');
assert.deepEqual([barcode.heights, barcode.widths], [[12], [2, 1, 1, 2, 1, 1, 2, 2, 3, 1, 1, 2, 1, 1, 2, 3, 2, 1, 1]], '1D barcode tracks');
let seed = 1;
const random = () => (seed = Math.imul(seed, 1103515245) + 12345 & 0x7fffffff) / 0x80000000;
for (let i = 0; i < 300; i++) {
  const R = 1 + Math.floor(random() * 14), C = 1 + Math.floor(random() * 14), density = [0.1, 0.5, 0.9][i % 3];
  const g = Array.from({ length: R }, () => Array.from({ length: C }, () => random() < density));
  checkEmail(g, `random ${R}x${C} #${i}`);
  assert.ok(same(teamsGrid(g), g), `Teams table round-trips random ${R}x${C} #${i}`);
}

// H. "Copy for email" puts a line break after the table: WebKit drops the last empty cell of a pasted table when nothing follows it
vm.runInContext(`currentTableHTML = '<table><tr><td></table>'`, ctx);
copyRich();
assert.equal(await clipboard[0]['text/html'].text(), '<table><tr><td></table><br>', 'rich copy has content after the table');
assert.equal(await clipboard[0]['text/plain'].text(), '<table><tr><td></table>', 'plain copy is the table');

// Fill in the form and run generate(), as the page does on input
const FORM = { 'barcode-type': 'qrcode', 'ec-level': 'M', 'cell-size': '4', 'fg-color': '#000000', 'bg-color': '#ffffff', 'quiet-zone': true, 'lossy-enabled': false, 'lossy-budget': '100' };
const run = form => {
  for (const [id, value] of Object.entries({ ...FORM, ...form })) els[id][typeof value === 'boolean' ? 'checked' : 'value'] = value;
  ctx.generate();
  assert.ok(els['preview-area'].innerHTML.includes('<table'), 'generate() rendered a table');
  return { html: vm.runInContext('currentTableHTML', ctx), teams: vm.runInContext('currentTeamsHTML', ctx), stats: els.stats.innerHTML };
};

// I. generate() end to end: both tables it hands out are the code that was asked for, and it scan-verifies
for (const text of INPUTS) {
  const { html, teams, stats } = run({ 'qr-input': text });
  assert.equal(decode(emailTable(html).grid), text, `generated email table decodes ${text.length}`);
  assert.equal(decode(layout(teams, attrs => attrs.includes('background-color:currentcolor'))), text, `generated Teams table decodes ${text.length}`);
  assert.ok(stats.includes('Scan verified'), `scan verified ${text.length}`);
}

// J. on other codes the lossy step can cost bytes: flipped px cells keep 2x2 px modules from collapsing into one track.
// generate() then keeps the lossless table. bwip-js needs a canvas, so it is stood in for by a symbol drawn at 2x2 px.
ctx.bwipjs = { toCanvas(canvas) {
  canvas.width = doubled[0].length; canvas.height = doubled.length;
  canvas.getContext = () => ({ getImageData: () => ({ data: doubled.flat().flatMap(dark => [0, 0, 0, dark ? 255 : 0]) }) });
} };
const other = { 'barcode-type': 'datamatrix', 'qr-input': 'x', 'quiet-zone': false };
assert.ok(run({ ...other, 'lossy-enabled': true }).html.length <= run(other).html.length, 'lossy never makes another code\'s table longer');
console.log('ok');
