'use strict';

let floatWindowId = null;

// ── Link preview cache ────────────────────────────────────────────────────────

const previewCache = new Map();

// ── Window management ────────────────────────────────────────────────────────

async function openFloatWindow() {
  if (floatWindowId !== null) {
    try {
      await chrome.windows.update(floatWindowId, { focused: true });
      return;
    } catch {
      floatWindowId = null;
    }
  }

  const { windowBounds } = await chrome.storage.local.get('windowBounds');
  const bounds = windowBounds ?? { width: 390, height: 844, left: 1200, top: 0 };

  const win = await chrome.windows.create({
    url: 'https://x.com/home',
    type: 'popup',
    width: bounds.width,
    height: bounds.height,
    left: bounds.left,
    top: bounds.top,
    focused: true,
  });

  floatWindowId = win.id;
}

// Save position whenever the float window loses focus (user moved/resized it)
chrome.windows.onFocusChanged.addListener(async (focusedWindowId) => {
  if (focusedWindowId !== floatWindowId && floatWindowId !== null) {
    try {
      const win = await chrome.windows.get(floatWindowId);
      chrome.storage.local.set({
        windowBounds: { width: win.width, height: win.height, left: win.left, top: win.top },
      });
    } catch {}
  }
});

chrome.windows.onRemoved.addListener((windowId) => {
  if (windowId === floatWindowId) {
    floatWindowId = null;
    chrome.runtime.sendMessage({ action: 'windowClosed' }).catch(() => {});
  }
});

// ── Link preview fetcher ──────────────────────────────────────────────────────

async function fetchLinkPreview(url) {
  if (previewCache.has(url)) return previewCache.get(url);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const resp = await fetch(url, {
      signal: controller.signal,
      headers: { 'Accept': 'text/html,*/*' },
    });
    clearTimeout(timeout);
    if (!resp.ok) return null;

    // Read only the first 50 KB — meta tags are always in <head>
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let html = '';
    let bytes = 0;
    while (bytes < 50_000) {
      const { done, value } = await reader.read();
      if (done) break;
      html  += decoder.decode(value, { stream: true });
      bytes += value.byteLength;
      // Stop once </head> is found
      if (html.includes('</head>')) break;
    }
    reader.cancel().catch(() => {});

    const title       = extractMeta(html, 'og:title')       || extractTitle(html);
    const description = extractMeta(html, 'og:description') || extractMeta(html, 'description');
    const image       = extractMeta(html, 'og:image');

    if (!title) return null;

    const result = { title, description, image, finalUrl: resp.url };
    previewCache.set(url, result);
    return result;
  } catch {
    clearTimeout(timeout);
    return null;
  }
}

function extractMeta(html, name) {
  const pats = [
    new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]+content=["']([^"'<>]{1,500})["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"'<>]{1,500})["'][^>]+(?:property|name)=["']${name}["']`, 'i'),
  ];
  for (const p of pats) { const m = html.match(p); if (m) return m[1].trim(); }
  return '';
}

function extractTitle(html) {
  const m = html.match(/<title[^>]*>([^<]{1,200})<\/title>/i);
  return m ? m[1].trim() : '';
}

// ── Message handling ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.action === 'openFloatWindow') {
    openFloatWindow().then(() => sendResponse({ success: true, windowId: floatWindowId }));
    return true;
  }
  if (message.action === 'getWindowStatus') {
    sendResponse({ windowOpen: floatWindowId !== null });
    return false;
  }
  if (message.action === 'fetchLinkPreview') {
    fetchLinkPreview(message.url).then(sendResponse);
    return true; // async response
  }
});

// ── Keyboard shortcut ────────────────────────────────────────────────────────

chrome.commands.onCommand.addListener((command) => {
  if (command === 'open-float-window') openFloatWindow();
});
