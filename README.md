# Site ZIP Collector

A Chrome Manifest V3 extension that scans the current website, lets you choose pages, and downloads one ZIP archive built for **AI-assisted website analysis and cloning**. Each page is captured as rendered HTML (after JavaScript runs), its accessible assets, and an optional full-page screenshot.

## Capture options

- **Rendered HTML** — the live DOM after JavaScript executes, i.e. what the visitor actually sees. This is the best source for cloning JS-heavy sites (Shopify, React, etc.) where the raw server HTML is nearly empty.
- **Full-page screenshot** — a stitched PNG of the entire page so the AI can see the real design. Capturing opens each selected page briefly in an unfocused window.
- **Raw server HTML** — optionally also save the original pre-JavaScript HTML returned by the server.
- **Add page URL** — manually add pages the link scan did not find.

## Install

1. Extract `site-zip-collector.zip` to a permanent folder.
2. Open `chrome://extensions` in Google Chrome.
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select the extracted `site-zip-collector` folder.
6. Pin the extension to the Chrome toolbar.

## Use

1. Open the website homepage.
2. Open Site ZIP Collector.
3. Click **Scan links on this page**.
4. Select the pages you want.
5. Click **Download selected pages as ZIP**.
6. Keep Chrome open until the download prompt appears.

The archive contains one folder per page, an `archive-report.json` file, and a list of any resources that could not be downloaded.

## Important limitations

- Use the extension only on websites you own or have permission to archive.
- It saves the HTML returned by the server plus accessible images, stylesheets, fonts, scripts, and common media files.
- Streaming media, DRM, CAPTCHA-protected resources, browser-extension URLs, blob URLs, and some dynamically generated assets cannot be archived reliably.
- A saved copy is useful for visual and code analysis, but it is not guaranteed to reproduce server-side features, forms, booking engines, or logged-in applications offline.
- Very large sites may use substantial browser memory because the ZIP is assembled locally before download.
