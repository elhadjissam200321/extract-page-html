"use strict";

function normalizePageUrl(value) {
  try {
    const url = new URL(value, location.href);
    if (!/^https?:$/.test(url.protocol)) return null;
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
}

function scanLinks() {
  const current = new URL(location.href);
  current.hash = "";
  const links = new Map();

  links.set(current.href, document.title.trim() || current.pathname || "Current page");

  for (const anchor of document.querySelectorAll("a[href]")) {
    const raw = anchor.getAttribute("href") || "";
    // Fragment-only links must resolve against the document, not <base href>,
    // otherwise a page declaring a <base> contributes a phantom page to the scan.
    const href = normalizePageUrl(raw.startsWith("#") ? location.href + raw : anchor.href);
    if (!href) continue;
    const url = new URL(href);
    if (url.origin !== current.origin) continue;
    const title = anchor.textContent.replace(/\s+/g, " ").trim();
    if (!links.has(href) || title.length > links.get(href).length) {
      links.set(href, title || url.pathname || href);
    }
  }

  return [...links.entries()]
    .map(([url, title]) => ({ url, title }))
    .sort((a, b) => a.url.localeCompare(b.url));
}

// The browser resolves relative URLs against <base href> when the document
// declares one, so absolutizing against location.href alone would rewrite those
// URLs to the wrong absolute location.
function documentBaseHref() {
  const declared = document.querySelector("base[href]");
  if (!declared) return location.href;
  try {
    return new URL(declared.getAttribute("href"), location.href).href;
  } catch {
    return location.href;
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

function absolutizeSrcset(node, attribute, baseHref) {
  const value = node.getAttribute(attribute);
  if (!value) return;
  const rewritten = parseSrcset(value).map((candidate) => {
    if (/^(data:|blob:|javascript:|#)/i.test(candidate.url)) return candidate;
    try {
      return { url: new URL(candidate.url, baseHref).href, descriptor: candidate.descriptor };
    } catch {
      return candidate;
    }
  });
  node.setAttribute(attribute, formatSrcset(rewritten));
}

function absolutizeUrls(doc, baseHref) {
  const attrs = [
    ["[href]", "href"],
    ["[src]", "src"],
    ["[poster]", "poster"],
    ["[data-src]", "data-src"]
  ];
  for (const [selector, attr] of attrs) {
    for (const node of doc.querySelectorAll(selector)) {
      const value = node.getAttribute(attr);
      if (!value || /^(data:|blob:|javascript:|mailto:|tel:|#)/i.test(value)) continue;
      try {
        node.setAttribute(attr, new URL(value, baseHref).href);
      } catch {
        // keep original when it cannot be resolved
      }
    }
  }
  for (const node of doc.querySelectorAll("[srcset]")) absolutizeSrcset(node, "srcset", baseHref);
  for (const node of doc.querySelectorAll("[data-srcset]")) absolutizeSrcset(node, "data-srcset", baseHref);
}

function captureRenderedDom() {
  const clone = document.documentElement.cloneNode(true);
  const wrapper = document.implementation.createHTMLDocument("");
  wrapper.replaceChild(wrapper.importNode(clone, true), wrapper.documentElement);

  wrapper.querySelectorAll("script").forEach((node) => node.remove());
  wrapper.querySelectorAll('meta[http-equiv="Content-Security-Policy" i]').forEach((node) => node.remove());
  wrapper.querySelectorAll("[integrity]").forEach((node) => node.removeAttribute("integrity"));
  absolutizeUrls(wrapper, documentBaseHref());

  return "<!doctype html>\n" + wrapper.documentElement.outerHTML;
}

function pageMetrics() {
  const body = document.body;
  const html = document.documentElement;
  return {
    fullWidth: Math.max(body.scrollWidth, html.scrollWidth, html.clientWidth),
    fullHeight: Math.max(body.scrollHeight, html.scrollHeight, html.clientHeight),
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    devicePixelRatio: window.devicePixelRatio || 1
  };
}

function prepareForCapture() {
  const originalScrollY = window.scrollY;
  const html = document.documentElement;
  const previousScrollBehavior = html.style.scrollBehavior;
  html.style.scrollBehavior = "auto";
  return { originalScrollY, previousScrollBehavior };
}

const hiddenFixedNodes = [];

function hideFixedElements() {
  const nodes = document.querySelectorAll("body *");
  for (const node of nodes) {
    const position = getComputedStyle(node).position;
    if (position === "fixed" || position === "sticky") {
      hiddenFixedNodes.push([node, node.style.visibility]);
      node.style.visibility = "hidden";
    }
  }
}

function restoreFixedElements() {
  for (const [node, visibility] of hiddenFixedNodes) {
    node.style.visibility = visibility;
  }
  hiddenFixedNodes.length = 0;
}

function scrollToOffset(y, hideFixed) {
  if (hideFixed && y > 0 && !hiddenFixedNodes.length) hideFixedElements();
  window.scrollTo(0, y);
}

function restoreAfterCapture(prep) {
  if (!prep) return;
  document.documentElement.style.scrollBehavior = prep.previousScrollBehavior || "";
  window.scrollTo(0, prep.originalScrollY || 0);
}

let capturePrep = null;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "PING") {
    sendResponse({ ok: true });
    return;
  }

  if (message?.type === "SCAN_LINKS") {
    sendResponse({
      ok: true,
      title: document.title || location.hostname,
      origin: location.origin,
      links: scanLinks()
    });
    return;
  }

  if (message?.type === "CAPTURE_DOM") {
    sendResponse({ ok: true, html: captureRenderedDom(), title: document.title || location.hostname });
    return;
  }

  if (message?.type === "PAGE_METRICS") {
    capturePrep = prepareForCapture();
    sendResponse({ ok: true, metrics: pageMetrics() });
    return;
  }

  if (message?.type === "SCROLL_TO") {
    scrollToOffset(message.y || 0, message.hideFixed);
    sendResponse({ ok: true, scrollY: window.scrollY });
    return;
  }

  if (message?.type === "END_CAPTURE") {
    restoreFixedElements();
    restoreAfterCapture(capturePrep);
    capturePrep = null;
    sendResponse({ ok: true });
    return;
  }
});
