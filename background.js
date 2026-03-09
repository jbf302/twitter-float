'use strict';

let floatWindowId = null;

// ── Window management ────────────────────────────────────────────────────────

async function openFloatWindow() {
  // If window already exists, just bring it to front
  if (floatWindowId !== null) {
    try {
      await chrome.windows.update(floatWindowId, { focused: true });
      return;
    } catch {
      // Window was closed without us knowing
      floatWindowId = null;
    }
  }

  // Restore last position/size, or use sensible defaults
  const { windowBounds } = await chrome.storage.local.get('windowBounds');
  const bounds = windowBounds ?? { width: 390, height: 844, left: 1200, top: 0 };

  const win = await chrome.windows.create({
    url: 'https://x.com/home',
    type: 'popup',       // No address bar, no toolbar — compact like Tweetbot
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
        windowBounds: {
          width: win.width,
          height: win.height,
          left: win.left,
          top: win.top,
        },
      });
    } catch {
      // Window may have been closed
    }
  }
});

// Clean up when the float window is closed
chrome.windows.onRemoved.addListener((windowId) => {
  if (windowId === floatWindowId) {
    floatWindowId = null;
    // Notify the popup so it can update the button label
    chrome.runtime.sendMessage({ action: 'windowClosed' }).catch(() => {});
  }
});

// ── Message handling (from popup) ────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.action === 'openFloatWindow') {
    openFloatWindow().then(() => sendResponse({ success: true, windowId: floatWindowId }));
    return true; // Keep message channel open for async response
  }

  if (message.action === 'getWindowStatus') {
    sendResponse({ windowOpen: floatWindowId !== null });
    return false;
  }
});

// ── Keyboard shortcut ────────────────────────────────────────────────────────

chrome.commands.onCommand.addListener((command) => {
  if (command === 'open-float-window') {
    openFloatWindow();
  }
});
