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
const { qrcode, jsQR, buildProtectionMask, remaskQR, qrCodewordMap, applyQRLossy, shapeQRPadding, rsEncode, buildTableHTML, buildTeamsHTML, copyRich } = ctx;
const QR_BLOCKS = vm.runInContext('QR_BLOCKS', ctx); // top-level const: visible to scripts, not a context property

const TOTAL = [26,44,70,100,134,172,196,242,292,346,404,466,532,581,655,733,815,901,991,1085,1156,1258,1364,1474,1588,1706,1828,1921,2051,2185,2323,2465,2611,2761,2876,3034,3196,3362,3532,3706];
const remBits = v => v == 1 ? 0 : v <= 6 ? 7 : v <= 13 ? 0 : v <= 20 ? 3 : v <= 27 ? 4 : v <= 34 ? 3 : 0;
const PAD = 4;
const make = (text, level, version = 0, mode) => {
  const qr = qrcode(version, level);
  for (const segment of [text].flat()) qr.addData(segment, mode);
  qr.make();
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

// Independent block layout: build each block, then interleave data columns followed by EC columns.
// blocks[b] lists the codeword indices of block b, its lens[b] data codewords first.
const blockLayout = (total, v, l) => {
  const [ec, nb] = QR_BLOCKS[v - 1][l];
  const data = total - nb * ec, lens = Array.from({ length: nb }, (_, b) => Math.floor(data / nb) + (b >= nb - data % nb ? 1 : 0));
  const blocks = lens.map(() => []);
  let k = 0;
  for (let i = 0; i < Math.max(...lens); i++) for (let b = 0; b < nb; b++) if (i < lens[b]) blocks[b].push(k++);
  for (let i = 0; i < ec; i++) for (let b = 0; b < nb; b++) blocks[b].push(k++);
  assert.equal(k, total);
  return { blocks, lens, ec, nb, cap: Math.floor((ec - pbits(v, l)) / 2) };
};
const spread = (ks, count) => Array.from({ length: count }, (_, i) => ks[Math.floor(i * ks.length / count)]);
// g with the given codewords inverted
const hit = (g, codewords, ks) => { const h = copy(g); for (const q of ks) for (const [r, c] of codewords[q]) h[r][c] = !h[r][c]; return h; };

// C. block mapping: `capacity` bad codewords per block decode, capacity+1 in one block does not
for (const text of INPUTS) for (const [l, L] of LEVELS.entries()) {
  const g = make(text, L), n = g.length - 2 * PAD, v = (n - 17) / 4, protect = buildProtectionMask(n, PAD, g.length);
  const { codewords } = qrCodewordMap(g, PAD, protect), { blocks, ec, nb, cap } = blockLayout(codewords.length, v, l);
  assert.equal(decode(hit(g, codewords, blocks.flatMap(ks => spread(ks, cap)))), text, `${L} v${v} capacity`);
  // jsQR has no misdecode guard, so it still fixes cap+1 when 2*(cap+1) <= ec
  if (2 * (cap + 1) > ec) assert.notEqual(decode(hit(g, codewords, spread(blocks[nb - 1], cap + 1))), text, `${L} v${v} capacity+1`);
}

// D/E. lossy output stays scannable and smaller; benchmark
const CS = 4;
const bytes = g => buildTableHTML(g, CS, '#000', '#fff');
const pipeline = (g, budget, level, text) => { // best of 8 masks, pad codewords shaped and lossy applied per candidate like generate()
  const protect = buildProtectionMask(g.length - 2 * PAD, PAD, g.length);
  let best;
  for (let m = 0; m < 8; m++) {
    const h = remaskQR(g, PAD, protect, m);
    shapeQRPadding(h, PAD, protect, level, m);
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
  rows.push(`in#${i} ${L} v${(g.length - 2 * PAD - 17) / 4}`.padEnd(12) + `| orig ${String(t.tableHTML.length).padStart(6)}B/${String(t.cellCount).padStart(4)}c ok | lossless ${f(cols[0])} | +20% ${f(cols[1])} | +100% ${f(cols[2])}`);
}
console.log(rows.join('\n'));
// The same 12 symbols took 958,677 bytes while every cell carried its own width, height and padding
assert.ok(total < 307e3, `lossless tables of the 12 symbols total ${total} bytes`);

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

// K. text made of digits, or of the 45 alphanumeric characters, is encoded in the smaller mode
for (const [text, mode] of [['0123456789', 'Numeric'], ['HTTPS://EXAMPLE.COM/A-B.C', 'Alphanumeric'], ['$%*+-./: 09AZ', 'Alphanumeric'], ['https://example.com', 'Byte'], ['A?B', 'Byte'], ['A\nB', 'Byte'], ['１２３', 'Byte']])
  assert.equal(ctx.qrMode(text), mode, `mode of ${JSON.stringify(text)}`);
// At level M, 19 alphanumeric characters or 30 digits fit version 1 (21 modules); 19 bytes need version 2 (25)
for (const [text, modules] of [['HTTPS://EXAMPLE.COM', 21], ['012345678901234567890123456789', 21], ['https://example.com', 25]]) {
  const { html, stats } = run({ 'qr-input': text, 'quiet-zone': false });
  assert.ok(stats.includes(`<span>${modules}×${modules}</span> grid`), `${text} takes ${modules} modules: ${stats}`);
  assert.equal(decode(emailTable(html).grid), text, `${text} decodes`);
}

// L. the pad codewords after the terminator carry nothing: they are filled with light modules and the error correction
//    of their blocks is recomputed, which keeps every data bit and the full correction capacity.
// Codeword values of a symbol, read through mask 0 (a checkerboard)
const codewordBytes = (g, protect, codewords) => {
  const checkered = remaskQR(g, PAD, protect, 0);
  return codewords.map(mods => mods.reduce((value, [r, c]) => value << 1 | (checkered[r][c] !== ((r + c) % 2 === 0)), 0));
};
const dataCodewords = (v, l) => TOTAL[v - 1] - QR_BLOCKS[v - 1][l][0] * QR_BLOCKS[v - 1][l][1];
// rsEncode() agrees with the encoder of qrcode-generator on every block of every version and level, each nearly full of varied bytes
const varied = Array.from({ length: 3000 }, () => String.fromCharCode(32 + Math.floor(random() * 95))).join('');
for (let v = 1; v <= 40; v++) for (const [l, L] of LEVELS.entries()) {
  const g = make(varied.slice(0, dataCodewords(v, l) - 3), L, v), protect = buildProtectionMask(g.length - 2 * PAD, PAD, g.length), { codewords } = qrCodewordMap(g, PAD, protect);
  const values = codewordBytes(g, protect, codewords), { blocks, lens, ec } = blockLayout(codewords.length, v, l);
  blocks.forEach((ks, b) => assert.deepEqual([...rsEncode(ks.slice(0, lens[b]).map(k => values[k]), ec)], ks.slice(lens[b]).map(k => values[k]), `Reed-Solomon v${v} ${L} block ${b}`));
}
// How many data codewords come before the pads: the mode (4 bits), the character count, the characters and a 4-bit
// terminator, rounded up to whole codewords. The count takes 10/12/14 bits for digits, 9/11/13 for alphanumeric and
// 8/16/16 for bytes, in versions 1-9/10-26/27-40. Three digits take 10 bits (one 4, two 7), two characters 11 (one 6).
const SHAPED = [
  ...INPUTS.map(text => [text, 'Byte', v => text.length + (v < 10 ? 2 : 3)]),
  ['a'.repeat(1400), 'Byte', 1403, ['L']],                          // version 27: 4 + 16 + 11200 + 4 bits
  ['42', 'Numeric', 4],                                             // 4 + 10 + 7 + 4 = 25 bits
  ['2024', 'Numeric', 4],                                           // 4 + 10 + 10 + 4 + 4 = 32
  ['123456789', 'Numeric', 6],                                      // 4 + 10 + 30 + 4 = 48
  ['012345678901234567890123456789', 'Numeric', 15],                // 4 + 10 + 100 + 4 = 118
  ['7'.repeat(700), 'Numeric', 295, ['L']],                         // version 11: 4 + 12 + 2330 + 4 + 4 = 2354
  ['7'.repeat(3300), 'Numeric', 1378, ['L']],                       // version 27: 4 + 14 + 11000 + 4 = 11022
  ['ABCDEFGHIJ', 'Alphanumeric', 9],                                // 4 + 9 + 55 + 4 = 72
  ['HELLO WORLD 1', 'Alphanumeric', 12],                            // 4 + 9 + 66 + 6 + 4 = 89
  ['HTTPS://EXAMPLE.COM', 'Alphanumeric', 16],                      // 4 + 9 + 99 + 6 + 4 = 122
  ['A'.repeat(400), 'Alphanumeric', 278, ['L']],                    // version 11: 4 + 11 + 2200 + 4 = 2219
  ['A'.repeat(2000), 'Alphanumeric', 1378, ['L']],                  // version 27: 4 + 13 + 11000 + 4 = 11021
  // either side of the two version boundaries where the count grows (all three modes switch at the same versions)
  ['a', 'Byte', 3, ['L'], 9], ['a', 'Byte', 4, ['L'], 10],          // 4 + 8 + 8 + 4 = 24 bits, then 4 + 16 + 8 + 4 = 32
  ['7', 'Numeric', 3, ['L'], 26], ['7', 'Numeric', 4, ['L'], 27],   // 4 + 12 + 4 + 4 = 24 bits, then 4 + 14 + 4 + 4 = 26
  // version 1-L holds 19 codewords, 152 bits: no pads when the terminator ends exactly there, or does not fit at all
  ['a'.repeat(17), 'Byte', 19, ['L']],                              // 4 + 8 + 136 + 4 = 152
  ['1234567890'.repeat(4) + '1', 'Numeric', 19, ['L']],             // 4 + 10 + 130 + 7 = 151, one bit short of a terminator
];
for (const [text, mode, used, levels = LEVELS, version = 0] of SHAPED) for (const L of levels) {
  const l = LEVELS.indexOf(L), g = make(text, L, version, mode), n = g.length - 2 * PAD, v = (n - 17) / 4, protect = buildProtectionMask(n, PAD, g.length);
  const { codewords } = qrCodewordMap(g, PAD, protect), { blocks, lens, ec, cap } = blockLayout(codewords.length, v, l);
  const stream = blocks.flatMap((ks, b) => ks.slice(0, lens[b])), kept = stream.slice(0, typeof used === 'number' ? used : used(v));
  const pads = dataCodewords(v, l) - kept.length, before = codewordBytes(g, protect, codewords);
  for (const m of levels === LEVELS ? [1, 6] : [4]) {
    const masked = remaskQR(g, PAD, protect, m), h = copy(masked), label = `${mode} ${text.length} ${L} v${v} mask ${m}`;
    assert.equal(shapeQRPadding(h, PAD, protect, L, m), pads, `pad codewords ${label}`);
    const after = codewordBytes(h, protect, codewords);
    assert.deepEqual(kept.map(k => after[k]), kept.map(k => before[k]), `data codewords are kept ${label}`);
    blocks.forEach((ks, b) => assert.deepEqual([...rsEncode(ks.slice(0, lens[b]).map(k => after[k]), ec)], ks.slice(lens[b]).map(k => after[k]), `error correction is exact ${label} block ${b}`));
    for (const k of stream.slice(kept.length)) assert.ok(codewords[k].every(([r, c]) => !h[r][c]), `pad modules are light ${label}`);
    assert.ok(h.every((row, r) => row.every((dark, c) => !protect[r][c] || dark === masked[r][c])), `function patterns are kept ${label}`);
    if (pads === 0) assert.ok(same(h, masked), `nothing to shape, nothing changes ${label}`);
    assert.equal(decode(h), text, `shaped symbol decodes ${label}`);
    assert.equal(decode(hit(h, codewords, blocks.flatMap(ks => spread(ks, cap)))), text, `shaped symbol keeps its capacity ${label}`);
  }
}
// A second segment where the terminator would be: nothing is free and nothing is touched
const twoSegments = make(['AB', 'CD'], 'M'), twoProtect = buildProtectionMask(twoSegments.length - 2 * PAD, PAD, twoSegments.length);
const twoMasked = remaskQR(twoSegments, PAD, twoProtect, 2), twoShaped = copy(twoMasked);
assert.equal(shapeQRPadding(twoShaped, PAD, twoProtect, 'M', 2), 0, 'no pad codewords are claimed after the first of two segments');
assert.ok(same(twoShaped, twoMasked) && decode(twoShaped) === 'ABCD', 'a symbol of two segments is left alone');
// generate() shapes: the default URL at level L has 13 pad codewords and comes out below the best mask without shaping
const roomy = make(INPUTS[0], 'L'), roomyProtect = buildProtectionMask(roomy.length - 2 * PAD, PAD, roomy.length);
const unshaped = Math.min(...[0, 1, 2, 3, 4, 5, 6, 7].map(m => bytes(remaskQR(roomy, PAD, roomyProtect, m)).tableHTML.length));
assert.ok(run({ 'qr-input': INPUTS[0], 'ec-level': 'L' }).html.length < unshaped, 'generate() shapes the pad codewords');
// Without a quiet zone the same modules change
const bare = g => g.slice(PAD, -PAD).map(row => row.slice(PAD, -PAD));
const withZone = remaskQR(roomy, PAD, roomyProtect, 3), without = bare(withZone);
shapeQRPadding(withZone, PAD, roomyProtect, 'L', 3);
shapeQRPadding(without, 0, buildProtectionMask(without.length, 0, without.length), 'L', 3);
assert.ok(same(without, bare(withZone)), 'shaping does not depend on the quiet zone');
// The lossy step on top of the shaping, on a byte and an alphanumeric symbol
for (const text of [INPUTS[0], 'HTTPS://EXAMPLE.COM']) {
  const { html, stats } = run({ 'qr-input': text, 'lossy-enabled': true });
  assert.equal(decode(emailTable(html).grid), text, `shaped and lossy table decodes: ${text}`);
  assert.ok(stats.includes('Scan verified'), `shaped and lossy table is scan verified: ${text}`);
}
console.log('ok');
