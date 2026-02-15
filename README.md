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
- **Maximal-area rectangle packing** — merges contiguous same-color regions using `colspan` and `rowspan`, typically reducing cell count by 80%+
- **HTML minification** — background color inheritance from the `<table>` element, shortened hex colors (`#000000` → `#000`), stripped redundant inline properties
- **Lossy compression** *(experimental)* — strategically flips isolated data modules to create larger mergeable regions, using the QR error correction headroom as a budget. Finder patterns, alignment patterns, timing, format and version info are fully protected
- **Rich-text clipboard** — "Copy for email" writes `text/html` to the clipboard so you can paste the rendered QR directly into Gmail, Outlook, or any rich-text editor
- **Configurable** — foreground/background colors, cell size, error correction level, quiet zone toggle

## How it works

### Rectangle packing

A naive QR-to-table conversion outputs one `<td>` per module — for a 33×33 QR code, that's 1,089 cells. qr2table instead applies a greedy maximal-area rectangle packing algorithm:

1. For each uncovered cell, extend **right** as far as possible (same color)
2. Extend **down** row by row, allowing the width to narrow, tracking the largest area
3. Emit a single `<td>` with `colspan` and `rowspan` for the best rectangle found
4. Mark the rectangle as covered and continue

This exploits the large uniform regions in QR codes (quiet zone, finder patterns, alignment patterns) and typically produces ~200 cells instead of ~1,000.

### Lossy compression

QR codes include error correction (7%–30% of data, depending on level). qr2table can optionally spend some of that headroom to improve table compression:

1. Build a **protection mask** over all functional patterns (finders, timing, alignment, format/version info)
2. Score each unprotected data module by **neighbor isolation** — how many of its 4 neighbors have a different color
3. Sort by score and **flip** the most isolated modules first (lone islands that fragment the grid)
4. Stop at a configurable fraction of the EC budget (with a 50% safety margin)

The result: fewer isolated pixels → larger mergeable rectangles → fewer `<td>` elements → smaller HTML. The trade-off is that you're consuming error correction capacity, so always verify the output with a QR scanner.

## Usage

qr2table is a single self-contained HTML file. No build step, no dependencies at runtime (the QR generation library is loaded from a CDN).

1. Open `index.html` in a browser (or visit the [live demo](https://balcsida.github.io/qr2table/))
2. Enter your text or URL
3. Adjust settings (colors, cell size, EC level, lossy compression)
4. Click **Copy for email** to paste directly into your email composer, or **Copy HTML** for the raw source

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
