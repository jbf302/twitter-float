'use strict';

const openBtn          = document.getElementById('open-btn');
const chronoToggle     = document.getElementById('toggle-chrono');
const refreshToggle    = document.getElementById('toggle-refresh');
const compactToggle    = document.getElementById('toggle-compact-media');
const expandToggle     = document.getElementById('toggle-expand-threads');
const statusDot        = document.getElementById('status-dot');
const statusText       = document.getElementById('status-text');
const shortcutHint     = document.getElementById('shortcut-hint');

// Adjust shortcut hint for platform
if (navigator.platform.startsWith('Mac')) {
  shortcutHint.textContent = 'Cmd+Shift+T to open / focus';
}

// ── Load initial state ────────────────────────────────────────────────────────

async function init() {
  // Settings from sync storage
  const settings = await chrome.storage.sync.get({
    chronological: true,
    autoRefresh: true,
    compactMedia: false,
    autoExpandThreads: true,
  });
  chronoToggle.checked  = settings.chronological;
  refreshToggle.checked = settings.autoRefresh;
  compactToggle.checked = settings.compactMedia;
  expandToggle.checked  = settings.autoExpandThreads;

  // Window status from background
  const { windowOpen } = await chrome.runtime.sendMessage({ action: 'getWindowStatus' });
  setWindowStatus(windowOpen);
}

// ── Open / focus button ───────────────────────────────────────────────────────

openBtn.addEventListener('click', async () => {
  openBtn.disabled = true;
  try {
    await chrome.runtime.sendMessage({ action: 'openFloatWindow' });
    setWindowStatus(true);
  } finally {
    openBtn.disabled = false;
  }
});

// ── Toggles ───────────────────────────────────────────────────────────────────

chronoToggle.addEventListener('change', () => {
  chrome.storage.sync.set({ chronological: chronoToggle.checked });
});

refreshToggle.addEventListener('change', () => {
  chrome.storage.sync.set({ autoRefresh: refreshToggle.checked });
});

compactToggle.addEventListener('change', () => {
  chrome.storage.sync.set({ compactMedia: compactToggle.checked });
});

expandToggle.addEventListener('change', () => {
  chrome.storage.sync.set({ autoExpandThreads: expandToggle.checked });
});

// ── Window status ─────────────────────────────────────────────────────────────

function setWindowStatus(open) {
  statusDot.classList.toggle('open', open);
  statusText.textContent = open ? 'Float window is open' : 'Float window closed';
  openBtn.textContent = open ? 'Focus Float Window' : 'Open Float Window';
  openBtn.classList.toggle('active', open);
}

// Background notifies us when the window is closed
chrome.runtime.onMessage.addListener((message) => {
  if (message.action === 'windowClosed') {
    setWindowStatus(false);
  }
});

// ── Go ────────────────────────────────────────────────────────────────────────

init();
