# qr2table

Generate email-safe QR codes as pure HTML tables with colspan/rowspan optimization and experimental lossy compression.

No images, no base64, no external dependencies in the output — just a `<table>` with inline styles that renders in every email client.

## Demo

https://github.com/user-attachments/assets/38682c00-f228-41e3-8eff-a9bd0bb6c2fa

## Why?

Most email clients (Gmail, Outlook, Apple Mail, Yahoo) aggressively block or strip images. A QR code embedded as an `<img>` tag may never reach the recipient. HTML tables, on the other hand, are the backbone of email rendering and pass through even the most aggressive sanitizers.

qr2table generates QR codes built entirely from `<td>` cells with inline styles, and applies several optimization techniques to keep the HTML size small enough for practical email use.

## Features

- **Pure HTML table output** — works in every email client that supports basic HTML tables
- **Sizes stated once** — the first row carries the column widths and the first column the row heights, so every other cell is a bare `<td>` with at most a span and a background
- **Byte-aware rectangle packing** — merges contiguous same-color regions using `colspan` and `rowspan` wherever that makes the HTML shorter
- **HTML minification** — background color inheritance from the `<table>` element, shortened hex colors (`#000000` → `#000`), unquoted attribute values, no `</td>` or `</tr>`
- **Mask selection** — QR decoders accept all 8 data masks, so the one that packs into the shortest table is used (lossless)
- **Compact QR modes** — all-digit text is encoded in numeric mode, and text made of digits, capitals, spaces and `$%*+-./:` in alphanumeric mode. At levels L and M, `HTTPS://EXAMPLE.COM` fits a 21×21 code where `https://example.com` needs 25×25
- **Lossy compression** *(experimental)* — for QR, sacrifices whole Reed-Solomon codewords up to the error correction capacity of each block and smooths them into larger mergeable regions. Finder patterns, alignment patterns, timing, format and version info are fully protected
- **Rich-text clipboard** — "Copy for email" writes `text/html` to the clipboard so you can paste the rendered QR directly into Gmail, Outlook, or any rich-text editor. The copy ends with a line break, because WebKit drops the last cell of a pasted table when nothing follows it
- **Teams CLI command** — "Copy Teams command" emits a ready-to-run `teams message send` command carrying a table built for Teams, because Teams strips cell styling from anything pasted into its compose box
- **Configurable** — foreground/background colors, cell size, error correction level, quiet zone toggle

## How it works

### Table structure

A naive QR-to-table conversion outputs one `<td>` per module, each with its own width, height and color. qr2table states every size once:

1. Identical neighboring rows and columns are merged into one track that is a multiple of the cell size. A quiet zone becomes one track per side and a 1D barcode a single row.
2. The first row is emitted cell by cell and carries the column widths; the first column carries the row heights.
3. Every other cell is a bare `<td>` with at most a `colspan`, a `rowspan` and a background.

Heights are written both as an attribute and as CSS, because Yahoo and AOL rewrite CSS `height` to `min-height` (which table cells ignore) and HEY drops size attributes. Giving every column and row a cell of its own to size it also keeps WebKit from rendering some columns narrower than others.

### Rectangle packing

The remaining cells are packed greedily:

1. For each uncovered cell, extend **right** as far as possible (same color)
2. Extend **down** row by row, allowing the width to narrow
3. Take the rectangle that saves the most bytes over single cells and emit one `<td>` with `colspan` and `rowspan` for it
4. Mark the rectangle as covered and continue

Counting bytes instead of area matters because a merge is not always a win: `<td><td>` is shorter than `<td colspan=2>`. The scan runs in all 8 orientations, and each same-color region keeps the orientation that packed it into the fewest bytes.

The markup itself is minified: attribute values are unquoted and `</td>` and `</tr>` are left out, both of which HTML allows. The default `https://example.com` code comes out at about 6 KB.

### Lossy compression

QR codes include error correction (7%–30% of data, depending on level). qr2table can optionally spend some of that headroom to improve table compression:

1. Build a **protection mask** over all functional patterns (finders, timing, alignment, format/version info)
2. Map every **codeword** (8 modules) to its Reed-Solomon block — any number of wrong bits inside one codeword costs exactly one unit of that block's capacity
3. Score each codeword by how much **smoothing** it would remove color boundaries, and pick the best ones per block, up to the block's capacity × the slider fraction (100% = all of it)
4. Smooth the picked codewords (and the unused remainder bits) toward their neighbors' majority color

The result: fewer isolated pixels → larger mergeable rectangles → fewer `<td>` elements → smaller HTML. Each of the 8 data masks is tried with this step applied and the shortest table wins, then the result is re-decoded with jsQR. At 100% the code only scans in clean conditions, so always verify the output with a QR scanner. Other barcode types still flip isolated modules, and keep the result only when it makes the table shorter.

## Usage

qr2table is a single self-contained HTML file. No build step, no dependencies at runtime (the QR generation library is loaded from a CDN).

1. Open `index.html` in a browser (or visit the [live demo](https://balcsida.github.io/qr2table/))
2. Enter your text or URL
3. Adjust settings (colors, cell size, EC level, lossy compression)
4. Click **Copy for email** to paste directly into your email composer, **Copy HTML** for the raw source, or **Copy Teams command** to post it into a Teams chat or channel

### Microsoft Teams

Teams will not take a pasted QR. Everything inside the cells (colors, widths, borders) is stripped on paste, leaving a grid of empty `<td>&nbsp;</td>`. Messages sent through the Graph API do keep cell colors, so **Copy Teams command** hands over a command for the [OSO MS Teams CLI](https://msteamscli.com) instead:

```sh
teams message send --chat "<chat-id>" --content-type html --stdin <<'QR2TABLE'
<table>…</table>
QR2TABLE
```

The table in that command is built differently from the email one, because Teams:

- drops the `background` shorthand and only honors `background-color`
- rewrites hex and `rgb()` colors in dark theme (`#ffffff` becomes the dark surface color `#292929`, which leaves a painted code black on dark gray), but leaves `currentcolor` alone
- ignores px sizes and fixes row height at ~21px, so the first row carries `width="21"` attributes to square the modules up
- gives every row the same fixed height, so the first column is emitted cell by cell as a precaution against a `<tr>` left empty by a `rowspan` from above

So the modules are painted with `background-color:currentcolor` and the light cells are left unpainted. The code takes the message's text color on the theme's own table background and follows the theme: dark on light in light theme, light on dark in dark theme. The color pickers do not apply to it. In dark theme that makes it an inverted code, which not every scanner reads.

In a narrow window Teams squeezes the columns below 21px. The code still decodes in testing, but with less margin than usual, so keep lossy compression low or off for Teams.

## Prior art

This project was developed independently, but the concept of rendering QR codes as HTML tables is not new. After building qr2table, I found these existing implementations:

- **[QRCode.js](https://davidshimjs.github.io/qrcodejs/)** — JavaScript library that can render QR codes as HTML tables (as a fallback for browsers without canvas support)
- **[HTML::Barcode::QRCode](https://metacpan.org/pod/HTML::Barcode::QRCode)** — Perl module that generates QR codes as HTML tables with optional inline styles
- **[jQuery qrcode](https://github.com/jeromeetienne/jquery-qrcode)** — jQuery plugin supporting both canvas and table-based QR rendering

However, none of these implement **colspan/rowspan rectangle packing** to optimize the output size — they all emit one `<td>` per module. The **lossy compression via EC headroom** approach also appears to be novel.

### Security context

It's worth noting that this technique has been observed in the wild for malicious purposes. In December 2025, SANS Internet Storm Center researchers [identified phishing campaigns](https://www.paubox.com/blog/html-based-qr-codes-help-phishing-emails-bypass-security-scans) that used HTML table-based QR codes to bypass email security scanners that only analyze image attachments. This is a reminder that email security tools should inspect HTML structures, not just images, for embedded QR codes.

qr2table is intended for legitimate use cases — embedding scannable links, contact cards, or event tickets in marketing emails, transactional emails, and newsletters where image blocking would otherwise break the QR code.

## Built with

This project was fully vibe-coded with [Claude](https://claude.ai) by Anthropic. Every line of code — the QR generation, rectangle packing algorithm, lossy compression, UI, and this README — was written by Claude through iterative conversation.

## License

MIT
