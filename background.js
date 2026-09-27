"use strict";

const CAPTURE_THROTTLE_MS = 600;
let lastCaptureAt = 0;
// Guards against a second run starting while one is in flight, which would
// reset the offscreen session and corrupt the archive being written.
let archiveBusy = false;

async function ensureOffscreenDocument() {
  const offscreenUrl = chrome.runtime.getURL("offscreen.html");

  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [offscreenUrl]
    });
    if (contexts.length) return;
  }

  try {
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["BLOBS"],
      justification: "Build a user-requested ZIP archive from selected pages and assets."
    });
  } catch (error) {
    if (!String(error).includes("single offscreen")) throw error;
  }
}

function progress(text, percent, done = false, error = "") {
  chrome.storage.local.set({ siteZipProgress: { active: !done, text, percent, error } }).catch(() => {});
  chrome.runtime.sendMessage({ type: "ARCHIVE_PROGRESS", text, percent, done, error }).catch(() => {});
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function sendToTab(tabId, message, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      reject(new Error(`Tab message "${message.type}" timed out`));
    }, timeoutMs);
    try {
      chrome.tabs.sendMessage(tabId, message, (response) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(response);
      });
    } catch (error) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(error);
    }
  });
}

async function ensureContentScript(tabId) {
  try {
    await sendToTab(tabId, { type: "PING" }, 3000);
    return;
  } catch {
    // fall through to inject
  }
  await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
  await sleep(300);
  await sendToTab(tabId, { type: "PING" }, 5000);
}

function waitForTabComplete(tabId, timeoutMs = 45000) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    };
    const listener = (changedTabId, info) => {
      if (changedTabId === tabId && info.status === "complete") finish();
    };
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId, (tab) => {
      if (!chrome.runtime.lastError && tab && tab.status === "complete") finish();
    });
    setTimeout(finish, timeoutMs);
  });
}

async function throttledCapture(windowId) {
  const wait = CAPTURE_THROTTLE_MS - (Date.now() - lastCaptureAt);
  if (wait > 0) await sleep(wait);
  lastCaptureAt = Date.now();
  return chrome.tabs.captureVisibleTab(windowId, { format: "png" });
}

async function captureFullPage(tabId, windowId, options) {
  await ensureContentScript(tabId);

  let renderedHtml = "";
  let title = "";
  if (options.renderedHtml) {
    const domResponse = await sendToTab(tabId, { type: "CAPTURE_DOM" });
    renderedHtml = domResponse?.html || "";
    title = domResponse?.title || "";
  }

  if (!options.screenshot) {
    return { renderedHtml, title, screenshot: null };
  }

  const metricsResponse = await sendToTab(tabId, { type: "PAGE_METRICS" });
  const metrics = metricsResponse?.metrics;
  if (!metrics || !metrics.viewportHeight) {
    return { renderedHtml, title, screenshot: null };
  }

  const maxHeight = Math.min(metrics.fullHeight, 30000);
  const segments = [];
  let y = 0;

  while (y < maxHeight) {
    const scrollResponse = await sendToTab(tabId, { type: "SCROLL_TO", y, hideFixed: true });
    const actualY = typeof scrollResponse?.scrollY === "number" ? scrollResponse.scrollY : y;
    await sleep(250);
    let dataUrl;
    try {
      dataUrl = await throttledCapture(windowId);
    } catch (error) {
      if (String(error).includes("MAX_CAPTURE")) {
        await sleep(1000);
        dataUrl = await throttledCapture(windowId);
      } else {
        throw error;
      }
    }
    segments.push({ y: actualY, dataUrl });
    if (metrics.fullHeight <= metrics.viewportHeight) break;
    if (actualY + metrics.viewportHeight >= metrics.fullHeight) break;
    y += metrics.viewportHeight;
  }

  await sendToTab(tabId, { type: "END_CAPTURE" });

  return {
    renderedHtml,
    title,
    screenshot: { metrics, segments, maxHeight }
  };
}

function sendToOffscreen(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ target: "offscreen", ...message }, (response) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(response);
    });
  });
}

async function runCapture(urls, siteTitle, options) {
  const uniqueUrls = [...new Set(urls)];
  const total = uniqueUrls.length;
  const needsRendering = options.renderedHtml || options.screenshot;

  await ensureOffscreenDocument();
  await sendToOffscreen({ type: "ARCHIVE_START", urls: uniqueUrls, siteTitle, options });

  if (needsRendering) {
    const captureWindow = await chrome.windows.create({
      url: "about:blank",
      focused: false,
      width: 1440,
      height: 900,
      left: 0,
      top: 0
    });
    const captureTab = captureWindow.tabs[0];

    try {
      for (let index = 0; index < uniqueUrls.length; index += 1) {
        const url = uniqueUrls[index];
        const base = Math.round((index / Math.max(1, total)) * 60);
        progress(`Rendering page ${index + 1} of ${total}`, base);

        let page;
        try {
          console.log("[capture] navigating", url);
          await chrome.tabs.update(captureTab.id, { url });
          await sleep(300);
          console.log("[capture] waiting for load", url);
          await waitForTabComplete(captureTab.id);
          await sleep(options.settleMs);
          console.log("[capture] loaded, capturing", url);

          const result = await captureFullPage(captureTab.id, captureWindow.id, options);
          console.log("[capture] captured", url, { html: result.renderedHtml.length, shots: result.screenshot?.segments.length || 0 });
          page = { url, ...result };
        } catch (error) {
          console.warn("[capture] failed", url, error.message || error);
          page = { url, renderedHtml: "", title: "", screenshot: null, error: error.message || String(error) };
        }

        // Stream each page to the offscreen document immediately so no single
        // message carries all pages' HTML + screenshots at once.
        try {
          await sendToOffscreen({ type: "ARCHIVE_ADD_PAGE", page });
        } catch (error) {
          console.warn("[capture] add-page failed", url, error.message || error);
        }
        page = null;
      }
    } finally {
      chrome.windows.remove(captureWindow.id).catch(() => {});
    }
  } else {
    for (let index = 0; index < uniqueUrls.length; index += 1) {
      const url = uniqueUrls[index];
      progress(`Fetching page ${index + 1} of ${total}`, Math.round((index / Math.max(1, total)) * 60));
      await sendToOffscreen({
        type: "ARCHIVE_ADD_PAGE",
        page: { url, renderedHtml: "", title: "", screenshot: null }
      }).catch(() => {});
    }
  }

  progress("Building archive", 90);
  await sendToOffscreen({ type: "ARCHIVE_FINALIZE" }).catch((error) => {
    progress("Archive failed", 100, true, error.message || String(error));
  });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "SAVE_ARCHIVE") {
    (async () => {
      try {
        const dataUrl = `data:application/zip;base64,${message.base64 || ""}`;
        await chrome.downloads.download({ url: dataUrl, filename: message.filename, saveAs: true });
        sendResponse({ ok: true });
      } catch (error) {
        sendResponse({ ok: false, error: error.message || String(error) });
      }
    })();
    return true;
  }

  if (message?.type === "START_ARCHIVE") {
    (async () => {
      if (archiveBusy) {
        sendResponse({ ok: false, error: "An archive is already being built. Wait for it to finish." });
        return;
      }
      archiveBusy = true;
      try {
        const options = {
          renderedHtml: message.options?.renderedHtml !== false,
          rawHtml: message.options?.rawHtml === true,
          screenshot: message.options?.screenshot === true,
          settleMs: Math.max(0, Number(message.options?.settleMs) || 1200)
        };
        // runCapture is deliberately not awaited here so the popup gets an
        // immediate ack, but its rejection must still reach the popup or the
        // progress display would never leave its starting state.
        runCapture(message.urls || [], message.siteTitle || "website", options)
          .catch((error) => {
            progress("Archive failed", 100, true, error?.message || String(error));
          })
          .finally(() => {
            archiveBusy = false;
          });
        sendResponse({ ok: true });
      } catch (error) {
        archiveBusy = false;
        sendResponse({ ok: false, error: error.message || String(error) });
      }
    })();
    return true;
  }

  return false;
});
