"use strict";

const state = { links: [], title: "website", selected: new Set(), groupByTemplate: true };
const $ = (selector) => document.querySelector(selector);

function pathSegments(url) {
  try {
    return new URL(url).pathname.split("/").filter(Boolean);
  } catch {
    return null;
  }
}

// Builds a prefix tree of all scanned URL paths, then decides at each node
// whether its children are "variable" (many distinct siblings under the same
// parent => individual items sharing one template) or "structural" (few,
// repeated => part of the template path). This learns each site's own URL
// shape with no hardcoded platform words.
function buildTemplateModel(links) {
  const root = { children: new Map() };
  for (const item of links) {
    const segments = pathSegments(item.url);
    if (!segments) continue;
    let node = root;
    for (const segment of segments) {
      if (!node.children.has(segment)) node.children.set(segment, { children: new Map() });
      node = node.children.get(segment);
    }
  }
  return root;
}

// A node's children collapse to "*" when there are several of them and they
// mostly behave like leaves (individual pages), i.e. a listing of items.
function childrenAreVariable(node) {
  const kids = [...node.children.values()];
  if (kids.length < 3) return false;
  const leafish = kids.filter((kid) => kid.children.size <= 1).length;
  return leafish / kids.length >= 0.6;
}

// Lightweight per-segment heuristic for values that are clearly a specific
// item rather than a structural word: dates, numeric ids, hashes, or long
// hyphenated slugs. Catches date-based permalinks (e.g. /2024/01/post) that
// the tree heuristic alone can miss.
function segmentLooksVariable(segment) {
  if (/^\d+$/.test(segment)) return true;                         // 2024, 01, 12345
  if (/^\d{4}-\d{2}-\d{2}$/.test(segment)) return true;           // 2024-01-31
  if (/^[0-9a-f]{8,}$/i.test(segment)) return true;               // hex id / hash
  if (segment.length > 24) return true;                           // long slug
  if ((segment.match(/-/g) || []).length >= 2) return true;       // multi-word slug
  return false;
}

function computeTemplateKey(url, model) {
  const segments = pathSegments(url);
  if (segments === null) return url;
  if (!segments.length) return "home";

  const keyParts = [];
  let node = model;
  let collapsed = false;
  for (const segment of segments) {
    const variable = collapsed || (node && childrenAreVariable(node)) || segmentLooksVariable(segment);
    keyParts.push(variable ? "*" : segment.toLowerCase());
    // Once a segment is variable, deeper segments belong to that same item, so
    // collapse the rest of the path into the template too.
    if (variable) collapsed = true;
    node = node ? node.children.get(segment) || null : null;
  }
  // Collapse a trailing run of "*" (e.g. "*/*/*") to a single "*".
  return keyParts.join("/").replace(/(\/\*)+$/, "/*").replace(/^\*(\/\*)+$/, "*");
}

function groupedLinks() {
  const model = buildTemplateModel(state.links);
  const groups = new Map();
  for (const item of state.links) {
    const key = computeTemplateKey(item.url, model);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return groups;
}

function defaultSelection() {
  // One representative page per template group by default.
  const selected = new Set();
  for (const [, items] of groupedLinks()) {
    if (items[0]) selected.add(items[0].url);
  }
  return selected;
}

function showError(message) {
  const element = $("#error");
  element.textContent = message;
  element.hidden = !message;
}

function selectedUrls() {
  return [...document.querySelectorAll(".page-check:checked")].map((input) => input.value);
}

function updateCount() {
  const count = selectedUrls().length;
  $("#count").textContent = `${count} selected`;
  $("#download").disabled = count === 0;
}

function matchesQuery(item, query) {
  if (!query) return true;
  return `${item.title} ${item.url}`.toLowerCase().includes(query);
}

function linkItemHtml(item) {
  return `
    <input class="page-check" type="checkbox" value="${escapeHtml(item.url)}" ${state.selected.has(item.url) ? "checked" : ""}>
    <span><strong>${escapeHtml(item.title || "Untitled page")}</strong><small>${escapeHtml(item.url)}</small></span>
  `;
}

function renderFlat(container, query) {
  state.links.forEach((item) => {
    if (!matchesQuery(item, query)) return;
    const label = document.createElement("label");
    label.className = "link-item";
    label.innerHTML = linkItemHtml(item);
    container.appendChild(label);
  });
}

function renderGrouped(container, query) {
  for (const [key, items] of groupedLinks()) {
    const visible = items.filter((item) => matchesQuery(item, query));
    if (!visible.length) continue;

    const group = document.createElement("div");
    group.className = "link-group";

    const header = document.createElement("div");
    header.className = "group-header";
    header.textContent = items.length > 1 ? `${key}  (${items.length} pages, same template)` : key;
    group.appendChild(header);

    visible.forEach((item, index) => {
      const label = document.createElement("label");
      label.className = "link-item" + (items.length > 1 && index > 0 ? " variant" : "");
      label.innerHTML = linkItemHtml(item);
      group.appendChild(label);
    });

    container.appendChild(group);
  }
}

function renderLinks() {
  const query = $("#filter").value.trim().toLowerCase();
  const container = $("#links");
  container.textContent = "";

  if (state.groupByTemplate) renderGrouped(container, query);
  else renderFlat(container, query);

  container.querySelectorAll(".page-check").forEach((input) => {
    input.addEventListener("change", () => {
      if (input.checked) state.selected.add(input.value);
      else state.selected.delete(input.value);
      updateCount();
    });
  });
  updateCount();
}

function addUrl() {
  const input = $("#addUrlInput");
  const raw = input.value.trim();
  if (!raw) return;

  showError("");
  let parsed;
  try {
    parsed = new URL(raw);
    if (!/^https?:$/.test(parsed.protocol)) throw new Error();
  } catch {
    showError("Enter a valid http(s) page URL.");
    return;
  }
  parsed.hash = "";
  const url = parsed.href;

  if (!state.links.some((item) => item.url === url)) {
    state.links.unshift({ url, title: parsed.pathname || url });
  }
  state.selected.add(url);
  input.value = "";
  $("#results").hidden = false;
  renderLinks();
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function scan() {
  showError("");
  $("#scan").disabled = true;
  $("#scan").textContent = "Scanning...";

  try {
    const tab = await activeTab();
    if (!tab?.id || !/^https?:/.test(tab.url || "")) throw new Error("Open a normal website page first.");

    let response;
    try {
      response = await chrome.tabs.sendMessage(tab.id, { type: "SCAN_LINKS" });
    } catch {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
      response = await chrome.tabs.sendMessage(tab.id, { type: "SCAN_LINKS" });
    }

    if (!response?.ok) throw new Error("The page links could not be scanned.");
    state.links = response.links || [];
    state.title = response.title || new URL(tab.url).hostname;
    state.selected = defaultSelection();
    $("#results").hidden = false;
    renderLinks();
  } catch (error) {
    showError(error.message || String(error));
  } finally {
    $("#scan").disabled = false;
    $("#scan").textContent = "Scan links on this page";
  }
}

async function download() {
  const urls = selectedUrls();
  if (!urls.length) return;

  showError("");
  $("#download").disabled = true;
  $("#status").hidden = false;
  $("#statusText").textContent = "Starting archive...";

  const options = {
    renderedHtml: $("#optRendered").checked,
    screenshot: $("#optScreenshot").checked,
    rawHtml: $("#optRaw").checked,
    settleMs: 900
  };

  try {
    const result = await chrome.runtime.sendMessage({
      type: "START_ARCHIVE",
      urls,
      siteTitle: state.title,
      options
    });
    if (result && result.ok === false) throw new Error(result.error || "Archive failed.");
  } catch (error) {
    showError(error.message || String(error));
    $("#download").disabled = false;
  }
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== "ARCHIVE_PROGRESS") return;
  const percent = Math.max(0, Math.min(100, Number(message.percent) || 0));
  $("#status").hidden = false;
  $("#statusText").textContent = message.text || "Working...";
  $("#statusPercent").textContent = `${percent}%`;
  $("#progressBar").style.width = `${percent}%`;

  if (message.done) {
    $("#download").disabled = false;
    if (message.error) showError(message.error);
  }
});

$("#scan").addEventListener("click", scan);
$("#filter").addEventListener("input", renderLinks);
$("#all").addEventListener("click", () => {
  document.querySelectorAll(".page-check").forEach((input) => {
    input.checked = true;
    state.selected.add(input.value);
  });
  updateCount();
});
$("#none").addEventListener("click", () => {
  document.querySelectorAll(".page-check").forEach((input) => {
    input.checked = false;
    state.selected.delete(input.value);
  });
  updateCount();
});
$("#onePerTemplate").addEventListener("click", () => {
  state.selected = defaultSelection();
  renderLinks();
});
$("#groupToggle").addEventListener("change", (event) => {
  state.groupByTemplate = event.target.checked;
  renderLinks();
});
$("#download").addEventListener("click", download);
$("#addUrl").addEventListener("click", addUrl);
$("#addUrlInput").addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    addUrl();
  }
});

chrome.storage.local.get("siteZipProgress").then(({ siteZipProgress }) => {
  if (!siteZipProgress?.active) return;
  $("#status").hidden = false;
  $("#statusText").textContent = siteZipProgress.text || "Working...";
  $("#statusPercent").textContent = `${siteZipProgress.percent || 0}%`;
  $("#progressBar").style.width = `${siteZipProgress.percent || 0}%`;
});
