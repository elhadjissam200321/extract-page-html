"use strict";

const encoder = new TextEncoder();

function bytesToBase64(bytes) {
  const chunkSize = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function report(text, percent, done = false, error = "") {
  const payload = { type: "ARCHIVE_PROGRESS", text, percent, done, error };
  try {
    chrome.storage.local.set({ siteZipProgress: { active: !done, text, percent, error } });
  } catch {
    // extension context may be invalidated (e.g. extension reloaded mid-job)
  }
  try {
    chrome.runtime.sendMessage(payload).catch(() => {});
  } catch {
    // extension context may be invalidated (e.g. extension reloaded mid-job)
  }
}

function safeSegment(value, fallback = "item") {
  const cleaned = String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-")
    .slice(0, 80);
  return cleaned || fallback;
}

function shortHash(value) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36).slice(0, 7);
}

function normalizeUrl(value, base) {
  try {
    const url = new URL(value, base);
    if (!/^https?:$/.test(url.protocol)) return null;
    return url.href;
  } catch {
    return null;
  }
}

// Parses a srcset attribute into candidates. A URL token ends at whitespace,
// not at a comma, so splitting on "," corrupts data: URIs (whose base64 payload
// contains commas) and URLs that carry a comma in the query string.
function parseSrcset(value) {
  const candidates = [];
  const isSpace = (ch) => ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f";
  let i = 0;

  while (i < value.length) {
    while (i < value.length && (isSpace(value[i]) || value[i] === ",")) i += 1;
    if (i >= value.length) break;

    const start = i;
    while (i < value.length && !isSpace(value[i])) i += 1;
    const token = value.slice(start, i);

    if (token.endsWith(",")) {
      const bare = token.replace(/,+$/, "");
      if (bare) candidates.push({ url: bare, descriptor: "" });
      continue;
    }

    let descriptor = "";
    let depth = 0;
    while (i < value.length) {
      const ch = value[i];
      if (ch === "(") depth += 1;
      else if (ch === ")" && depth > 0) depth -= 1;
      else if (ch === "," && depth === 0) {
        i += 1;
        break;
      }
      descriptor += ch;
      i += 1;
    }
    if (token) candidates.push({ url: token, descriptor: descriptor.trim() });
  }
  return candidates;
}

function formatSrcset(candidates) {
  return candidates
    .filter((candidate) => candidate.url)
    .map((candidate) => (candidate.descriptor ? `${candidate.url} ${candidate.descriptor}` : candidate.url))
    .join(", ");
}

function contentExtension(contentType) {
  const type = (contentType || "").split(";", 1)[0].trim().toLowerCase();
  return ({
    "text/css": ".css",
    "text/javascript": ".js",
    "application/javascript": ".js",
    "application/json": ".json",
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "image/svg+xml": ".svg",
    "image/avif": ".avif",
    "font/woff": ".woff",
    "font/woff2": ".woff2",
    "font/ttf": ".ttf",
    "video/mp4": ".mp4",
    "audio/mpeg": ".mp3"
  })[type] || "";
}

function assetName(url, contentType) {
  const parsed = new URL(url);
  let base = safeSegment(decodeURIComponent(parsed.pathname.split("/").pop() || "asset"), "asset");
  if (!/\.[a-z0-9]{1,8}$/i.test(base)) base += contentExtension(contentType);
  const dot = base.lastIndexOf(".");
  if (dot > 0) return `${base.slice(0, dot)}-${shortHash(url)}${base.slice(dot)}`;
  return `${base}-${shortHash(url)}`;
}

async function replaceAsync(source, regex, replacer) {
  const matches = [...source.matchAll(regex)];
  if (!matches.length) return source;
  const replacements = await Promise.all(matches.map((match) => replacer(...match)));
  let output = "";
  let cursor = 0;
  matches.forEach((match, index) => {
    output += source.slice(cursor, match.index) + replacements[index];
    cursor = match.index + match[0].length;
  });
  return output + source.slice(cursor);
}

async function archivePage(page, folder, selectedPages, files, failures) {
  const url = page.url;
  let html = page.renderedHtml;
  if (!html) {
    const response = await fetch(url, { credentials: "include", redirect: "follow" });
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
    html = await response.text();
  }
  const documentNode = new DOMParser().parseFromString(html, "text/html");
  const finalUrl = url;
  const assetMap = new Map();
  const assetDir = `pages/${folder}/assets/`;

  documentNode.querySelectorAll('meta[http-equiv="Content-Security-Policy"]').forEach((node) => node.remove());
  documentNode.querySelectorAll("[integrity]").forEach((node) => node.removeAttribute("integrity"));

  // Relative URLs still present in inline <style>/style="" were resolved by the
  // browser against <base href>, not against the page URL, so keep the declared
  // base for them before repointing <base> at the local assets folder.
  const declaredBase =
    normalizeUrl(documentNode.querySelector("base[href]")?.getAttribute("href"), finalUrl) || finalUrl;

  let baseNode = documentNode.querySelector("base");
  if (!baseNode) {
    baseNode = documentNode.createElement("base");
    documentNode.head.prepend(baseNode);
  }
  baseNode.setAttribute("href", "./");

  async function saveAsset(rawUrl, baseUrl = declaredBase) {
    const absolute = normalizeUrl(rawUrl, baseUrl);
    if (!absolute) return rawUrl;
    if (assetMap.has(absolute)) return assetMap.get(absolute);

    const provisional = `asset-${shortHash(absolute)}`;
    assetMap.set(absolute, provisional);

    try {
      const assetResponse = await fetch(absolute, { credentials: "include", redirect: "follow" });
      if (!assetResponse.ok) throw new Error(`HTTP ${assetResponse.status}`);
      const contentType = assetResponse.headers.get("content-type") || "";
      const localName = assetName(assetResponse.url || absolute, contentType);
      assetMap.set(absolute, localName);

      if (contentType.toLowerCase().includes("text/css") || /\.css(?:$|[?#])/i.test(absolute)) {
        let css = await assetResponse.text();
        css = await rewriteCss(css, assetResponse.url || absolute);
        files.push({ name: assetDir + localName, data: encoder.encode(css) });
      } else {
        files.push({ name: assetDir + localName, data: new Uint8Array(await assetResponse.arrayBuffer()) });
      }
      return localName;
    } catch (error) {
      assetMap.delete(absolute);
      failures.push({ page: url, asset: absolute, error: error.message || String(error) });
      return rawUrl;
    }
  }

  async function rewriteCss(css, cssUrl, localPrefix = "") {
    let output = await replaceAsync(css, /url\(\s*(["']?)(?!data:|blob:|#)([^"')]+)\1\s*\)/gi, async (_full, quote, raw) => {
      const local = await saveAsset(raw.trim(), cssUrl);
      const rewritten = local === raw.trim() ? local : `${localPrefix}${local}`;
      return `url(${quote || '"'}${rewritten}${quote || '"'})`;
    });
    output = await replaceAsync(output, /@import\s+(["'])(?!data:|blob:)([^"']+)\1/gi, async (_full, quote, raw) => {
      const local = await saveAsset(raw.trim(), cssUrl);
      const rewritten = local === raw.trim() ? local : `${localPrefix}${local}`;
      return `@import ${quote}${rewritten}${quote}`;
    });
    return output;
  }

  const attributes = [
    ["link[rel~='stylesheet'][href]", "href"],
    ["link[rel~='icon'][href]", "href"],
    ["link[rel='apple-touch-icon'][href]", "href"],
    ["script[src]", "src"],
    ["img[src]", "src"],
    ["source[src]", "src"],
    ["video[src]", "src"],
    ["video[poster]", "poster"],
    ["audio[src]", "src"],
    ["track[src]", "src"],
    ["input[type='image'][src]", "src"],
    ["object[data]", "data"],
    ["embed[src]", "src"]
  ];

  for (const [selector, attribute] of attributes) {
    for (const node of documentNode.querySelectorAll(selector)) {
      const current = node.getAttribute(attribute);
      if (!current || /^(data:|blob:|#)/i.test(current)) continue;
      const local = await saveAsset(current, declaredBase);
      if (local !== current) node.setAttribute(attribute, `assets/${local}`);
    }
  }

  for (const node of documentNode.querySelectorAll("[srcset]")) {
    const rewritten = [];
    for (const candidate of parseSrcset(node.getAttribute("srcset") || "")) {
      const local = await saveAsset(candidate.url, declaredBase);
      rewritten.push({
        url: local === candidate.url ? candidate.url : `assets/${local}`,
        descriptor: candidate.descriptor
      });
    }
    node.setAttribute("srcset", formatSrcset(rewritten));
  }

  for (const style of documentNode.querySelectorAll("style")) {
    style.textContent = await rewriteCss(style.textContent, declaredBase, "assets/");
  }

  for (const node of documentNode.querySelectorAll("[style]")) {
    node.setAttribute("style", await rewriteCss(node.getAttribute("style"), declaredBase, "assets/"));
  }

  for (const anchor of documentNode.querySelectorAll("a[href]")) {
    const original = anchor.getAttribute("href");
    if (!original || original.startsWith("#")) continue;
    const absolute = normalizeUrl(original, declaredBase);
    if (!absolute) continue;
    const parsed = new URL(absolute);
    const fragment = parsed.hash;
    parsed.hash = "";
    const targetFolder = selectedPages.get(parsed.href);
    if (targetFolder) anchor.setAttribute("href", `../${targetFolder}/index.html${fragment}`);
  }

  const serialized = "<!doctype html>\n" + documentNode.documentElement.outerHTML;
  files.push({ name: `pages/${folder}/index.html`, data: encoder.encode(serialized) });

  let screenshotSaved = false;
  if (page.screenshot) {
    try {
      const png = await stitchScreenshot(page.screenshot);
      if (png) {
        files.push({ name: `pages/${folder}/screenshot.png`, data: png });
        screenshotSaved = true;
      }
    } catch (error) {
      failures.push({ page: url, asset: "screenshot.png", error: error.message || String(error) });
    }
  }

  return {
    url,
    finalUrl,
    title: documentNode.title || page.title || url,
    folder,
    assetsSaved: assetMap.size,
    screenshotSaved
  };
}

async function dataUrlToImageBitmap(dataUrl) {
  const response = await fetch(dataUrl);
  const blob = await response.blob();
  return createImageBitmap(blob);
}

async function stitchScreenshot(screenshot) {
  const { metrics, segments, maxHeight } = screenshot;
  if (!segments || !segments.length) return null;

  const ratio = metrics.devicePixelRatio || 1;
  const canvasWidth = Math.round(metrics.viewportWidth * ratio);
  const canvasHeight = Math.round(Math.min(maxHeight, metrics.fullHeight) * ratio);
  const canvas = new OffscreenCanvas(canvasWidth, canvasHeight);
  const context = canvas.getContext("2d");

  for (const segment of segments) {
    const bitmap = await dataUrlToImageBitmap(segment.dataUrl);
    const destY = Math.round(segment.y * ratio);
    context.drawImage(bitmap, 0, destY);
    bitmap.close();
  }

  const blob = await canvas.convertToBlob({ type: "image/png" });
  return new Uint8Array(await blob.arrayBuffer());
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosTimeDate(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  };
}

function concatBytes(chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

const U16_MAX = 0xffff;
const U32_MAX = 0xffffffff;

// ZIP64 extra field (header id 0x0001) carrying 64-bit sizes and offsets.
function zip64ExtraField(values) {
  const field = new Uint8Array(4 + values.length * 8);
  const view = new DataView(field.buffer);
  view.setUint16(0, 0x0001, true);
  view.setUint16(2, values.length * 8, true);
  values.forEach((value, index) => view.setBigUint64(4 + index * 8, value, true));
  return field;
}

function zipStore(files) {
  const stamp = dosTimeDate();
  const entries = [];
  let offset = 0;

  for (const file of files) {
    const name = encoder.encode(file.name.replace(/^\/+/, ""));
    const data = file.data instanceof Uint8Array ? file.data : encoder.encode(String(file.data));
    if (data.length > U32_MAX) throw new Error("A single archive entry exceeds the 4 GB ZIP limit.");
    entries.push({ name, data, crc: crc32(data), localOffset: offset });
    offset += 30 + name.length + data.length;
  }

  const localChunks = [];
  const centralChunks = [];

  for (const entry of entries) {
    const local = new Uint8Array(30 + entry.name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true);
    lv.setUint16(8, 0, true);
    lv.setUint16(10, stamp.time, true);
    lv.setUint16(12, stamp.date, true);
    lv.setUint32(14, entry.crc, true);
    lv.setUint32(18, entry.data.length, true);
    lv.setUint32(22, entry.data.length, true);
    lv.setUint16(26, entry.name.length, true);
    lv.setUint16(28, 0, true);
    local.set(entry.name, 30);
    localChunks.push(local, entry.data);

    const wide = entry.data.length > U32_MAX || entry.localOffset > U32_MAX;
    const extra = wide
      ? zip64ExtraField([BigInt(entry.data.length), BigInt(entry.data.length), BigInt(entry.localOffset)])
      : new Uint8Array(0);
    const central = new Uint8Array(46 + entry.name.length + extra.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, wide ? 45 : 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, stamp.time, true);
    cv.setUint16(14, stamp.date, true);
    cv.setUint32(16, entry.crc, true);
    cv.setUint32(20, wide ? U32_MAX : entry.data.length, true);
    cv.setUint32(24, wide ? U32_MAX : entry.data.length, true);
    cv.setUint16(28, entry.name.length, true);
    cv.setUint16(30, extra.length, true);
    cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true);
    cv.setUint16(36, 0, true);
    cv.setUint32(38, 0, true);
    cv.setUint32(42, wide ? U32_MAX : entry.localOffset, true);
    central.set(entry.name, 46);
    central.set(extra, 46 + entry.name.length);
    centralChunks.push(central);
  }

  const centralSize = centralChunks.reduce((sum, chunk) => sum + chunk.length, 0);
  // Past these limits the classic 16/32-bit end-of-central-directory fields
  // cannot describe the archive, so a ZIP64 trailer is required.
  const needsZip64 = entries.length > U16_MAX || centralSize > U32_MAX || offset > U32_MAX;
  const chunks = [...localChunks, ...centralChunks];

  if (needsZip64) {
    const record = new Uint8Array(56);
    const rv = new DataView(record.buffer);
    rv.setUint32(0, 0x06064b50, true);
    rv.setBigUint64(4, 44n, true);
    rv.setUint16(12, 45, true);
    rv.setUint16(14, 45, true);
    rv.setUint32(16, 0, true);
    rv.setUint32(20, 0, true);
    rv.setBigUint64(24, BigInt(entries.length), true);
    rv.setBigUint64(32, BigInt(entries.length), true);
    rv.setBigUint64(40, BigInt(centralSize), true);
    rv.setBigUint64(48, BigInt(offset), true);
    chunks.push(record);

    const locator = new Uint8Array(20);
    const gv = new DataView(locator.buffer);
    gv.setUint32(0, 0x07064b50, true);
    gv.setUint32(4, 0, true);
    gv.setBigUint64(8, BigInt(offset + centralSize), true);
    gv.setUint32(16, 0, true);
    chunks.push(locator);
  }

  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, needsZip64 ? U16_MAX : entries.length, true);
  ev.setUint16(10, needsZip64 ? U16_MAX : entries.length, true);
  ev.setUint32(12, needsZip64 ? U32_MAX : centralSize, true);
  ev.setUint32(16, needsZip64 ? U32_MAX : offset, true);
  ev.setUint16(20, 0, true);
  chunks.push(end);
  return concatBytes(chunks);
}

function buildReadme(options) {
  const lines = [
    "Site ZIP Collector archive",
    "",
    "This archive was built for AI-assisted website analysis and cloning.",
    "",
    "Contents per page (in pages/<page-folder>/):",
    "  index.html   - Rendered DOM captured after JavaScript ran (what the",
    "                 visitor actually sees). Best source for cloning.",
    "  assets/      - Stylesheets, images, fonts, scripts referenced by the page.",
  ];
  if (options.screenshot) {
    lines.push("  screenshot.png - Full-page screenshot of the rendered design.");
  }
  if (options.rawHtml) {
    lines.push("  raw-server.html - Original HTML returned by the server (pre-JS).");
  }
  lines.push(
    "",
    "archive-report.json lists every saved page and any resource that failed.",
    "Some streamed, DRM, or dynamically generated resources may be unavailable offline.",
    "Use only on websites you own or have permission to archive.",
    ""
  );
  return lines.join("\n");
}

// Streaming archive session: pages arrive one at a time from background.js so
// that no single message carries all rendered HTML + screenshots at once. The
// session accumulates the built files and finalizes into a ZIP at the end.
const session = {
  active: false,
  options: {},
  siteTitle: "website",
  files: [],
  pages: [],
  failures: [],
  selectedPages: new Map(),
  urls: [],
  total: 0,
  processed: 0
};

function resetSession(options, siteTitle, urls) {
  session.active = true;
  session.options = options || {};
  session.siteTitle = siteTitle || "website";
  session.files = [];
  session.pages = [];
  session.failures = [];
  session.selectedPages = new Map();
  session.urls = [];
  session.total = urls.length;
  session.processed = 0;

  urls.forEach((url, index) => {
    let normalized = url;
    try {
      const parsed = new URL(url);
      parsed.hash = "";
      normalized = parsed.href;
    } catch {
      // leave as-is
    }
    const parsed = (() => { try { return new URL(normalized); } catch { return null; } })();
    const slug = parsed ? safeSegment(parsed.pathname.replace(/^\/+|\/+$/g, "-") || "home", "home") : "page";
    const folder = `${String(index + 1).padStart(3, "0")}-${slug}`;
    session.selectedPages.set(normalized, folder);
    session.urls.push(normalized);
  });
}

async function addPageToSession(page) {
  let url = page.url;
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    url = parsed.href;
  } catch {
    // keep original
  }
  page = { ...page, url };

  const folder = session.selectedPages.get(url) || `page-${session.processed + 1}`;
  session.processed += 1;
  const percent = 62 + Math.round((session.processed / Math.max(1, session.total)) * 26);
  report(`Saving page ${session.processed} of ${session.total}`, percent);

  if (page.error) session.failures.push({ page: url, error: page.error });

  try {
    const result = await archivePage(page, folder, session.selectedPages, session.files, session.failures);

    if (session.options.rawHtml) {
      try {
        const rawResponse = await fetch(url, { credentials: "include", redirect: "follow" });
        if (rawResponse.ok) {
          const rawHtml = await rawResponse.text();
          session.files.push({ name: `pages/${folder}/raw-server.html`, data: encoder.encode(rawHtml) });
        }
      } catch (error) {
        session.failures.push({ page: url, asset: "raw-server.html", error: error.message || String(error) });
      }
    }

    session.pages.push(result);
  } catch (error) {
    session.failures.push({ page: url, error: error.message || String(error) });
  }
}

async function finalizeSession() {
  const manifest = {
    createdAt: new Date().toISOString(),
    generator: "Site ZIP Collector",
    options: session.options,
    requestedPages: session.total,
    savedPages: session.pages.length,
    failedItems: session.failures.length,
    pages: session.pages,
    failures: session.failures
  };
  session.files.unshift({ name: "archive-report.json", data: encoder.encode(JSON.stringify(manifest, null, 2)) });
  session.files.unshift({ name: "README.txt", data: encoder.encode(buildReadme(session.options)) });

  report("Building ZIP file", 92);
  const zipBytes = zipStore(session.files);
  const firstUrl = session.urls[0] || "";
  let hostname = "website";
  try {
    hostname = new URL(firstUrl).hostname;
  } catch {
    // keep default
  }
  const filename = `${safeSegment(session.siteTitle || hostname, hostname)}-site-archive.zip`;

  const downloadResponse = await chrome.runtime.sendMessage({
    type: "SAVE_ARCHIVE",
    filename,
    base64: bytesToBase64(zipBytes)
  });
  if (!downloadResponse?.ok) {
    throw new Error(downloadResponse?.error || "Download failed.");
  }

  const savedCount = session.pages.length;
  const failCount = session.failures.length;
  session.active = false;
  session.files = [];
  report(`ZIP ready: ${savedCount} page(s) saved`, 100, true, failCount ? `${failCount} item(s) could not be saved. See archive-report.json.` : "");
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== "offscreen") return false;

  if (message.type === "ARCHIVE_START") {
    resetSession(message.options || {}, message.siteTitle || "website", message.urls || []);
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === "ARCHIVE_ADD_PAGE") {
    addPageToSession(message.page || {})
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }

  if (message.type === "ARCHIVE_FINALIZE") {
    finalizeSession()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => {
        session.active = false;
        // Drop the partially built archive so memory is reclaimed and the next
        // run starts from a clean session instead of inheriting stale files.
        session.files = [];
        session.pages = [];
        report("Archive failed", 100, true, error.message || String(error));
        sendResponse({ ok: false, error: error.message || String(error) });
      });
    return true;
  }

  return false;
});
