'use strict';

let floatWindowId = null;
let unfocusedAlarmCount = 0;

// Restore persisted window ID when the service worker starts (MV3 workers are
// killed after ~30 s of inactivity and lose all in-memory state on restart).
chrome.storage.local.get('floatWindowId').then(async ({ floatWindowId: savedId }) => {
  if (!savedId) return;
  try {
    await chrome.windows.get(savedId); // throws if window no longer exists
    floatWindowId = savedId;
    scheduleRefreshAlarm();
  } catch {
    chrome.storage.local.remove('floatWindowId');
  }
});

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

  let win;
  try {
    win = await chrome.windows.create({
      url: 'https://x.com/home',
      type: 'popup',
      width: bounds.width,
      height: bounds.height,
      left: bounds.left,
      top: bounds.top,
      focused: true,
    });
  } catch (err) {
    // Saved bounds are off-screen (e.g. a monitor was disconnected). Keep the
    // user's preferred width/height but reset position to a safe primary-display spot.
    const safeBounds = { width: bounds.width, height: bounds.height, left: 100, top: 100 };
    chrome.storage.local.set({ windowBounds: safeBounds });
    win = await chrome.windows.create({
      url: 'https://x.com/home',
      type: 'popup',
      width: safeBounds.width,
      height: safeBounds.height,
      left: safeBounds.left,
      top: safeBounds.top,
      focused: true,
    });
  }

  floatWindowId = win.id;
  chrome.storage.local.set({ floatWindowId: win.id });
  scheduleRefreshAlarm();
}

// Save position whenever the float window loses focus (user moved/resized it)
chrome.windows.onFocusChanged.addListener(async (focusedWindowId) => {
  if (focusedWindowId === floatWindowId) {
    unfocusedAlarmCount = 0;
  }
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
    chrome.storage.local.remove('floatWindowId');
    chrome.alarms.clear('tf-refresh');
    chrome.runtime.sendMessage({ action: 'windowClosed' }).catch(() => {});
  }
});

// ── Alarm-based background refresh ───────────────────────────────────────────
// chrome.alarms fires reliably even when the popup window doesn't have focus,
// unlike setInterval which Chrome throttles for unfocused windows/tabs.
// Chrome enforces a 1-min minimum for periodInMinutes but allows 30-second
// one-shot alarms via delayInMinutes: 0.5.  We self-reschedule to achieve that.

function scheduleRefreshAlarm() {
  chrome.alarms.create('tf-refresh', { delayInMinutes: 0.5 });
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== 'tf-refresh') return;

  // If the service worker restarted since the alarm was scheduled, floatWindowId
  // may still be null while the async storage restore is pending. Recover it now.
  if (floatWindowId === null) {
    const { floatWindowId: savedId } = await chrome.storage.local.get('floatWindowId');
    if (!savedId) return; // no window, stop the chain
    try {
      await chrome.windows.get(savedId);
      floatWindowId = savedId;
    } catch {
      chrome.storage.local.remove('floatWindowId');
      return; // window is gone, stop the chain
    }
  }

  try {
    const win = await chrome.windows.get(floatWindowId, { populate: true });
    const tab = win?.tabs?.[0];
    if (!tab?.id) { scheduleRefreshAlarm(); return; }

    if (win.focused) {
      // Window is active — pill-click approach works fine
      unfocusedAlarmCount = 0;
      chrome.tabs.sendMessage(tab.id, { action: 'pollNewPosts' }).catch(() => {});
    } else {
      // Window is backgrounded — Twitter JS is throttled, pill won't appear
      unfocusedAlarmCount++;
      if (unfocusedAlarmCount >= 10) {  // 10 × 30 s = 5 min safety net
        unfocusedAlarmCount = 0;
        try {
          const results = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => {
              const articles = document.querySelectorAll('article[data-testid="tweet"]');
              for (const article of articles) {
                const rect = article.getBoundingClientRect();
                if (rect.top >= -50 && rect.top < window.innerHeight) {
                  const timeLink = article.querySelector('a[href*="/status/"] time');
                  if (timeLink) return timeLink.closest('a').getAttribute('href');
                }
              }
              return null;
            }
          });
          const href = results?.[0]?.result;
          if (href) await chrome.storage.local.set({ restoreScrollTarget: href });
        } catch {}
        chrome.tabs.reload(tab.id);
      }
      // Still try pill-click in case pill is already present
      chrome.tabs.sendMessage(tab.id, { action: 'pollNewPosts' }).catch(() => {});
    }
  } catch {}

  // Always reschedule — the chain must never die while a float window exists.
  scheduleRefreshAlarm();
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
    // floatWindowId may still be null if the service worker just restarted and
    // the async storage restoration hasn't resolved yet. Fall back to storage.
    if (floatWindowId !== null) {
      sendResponse({ windowOpen: true });
      return false;
    }
    chrome.storage.local.get('floatWindowId').then(async ({ floatWindowId: savedId }) => {
      if (!savedId) { sendResponse({ windowOpen: false }); return; }
      try {
        await chrome.windows.get(savedId);
        floatWindowId = savedId;
        sendResponse({ windowOpen: true });
      } catch {
        chrome.storage.local.remove('floatWindowId');
        sendResponse({ windowOpen: false });
      }
    });
    return true; // async response
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
