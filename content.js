'use strict';

// ── Defaults ─────────────────────────────────────────────────────────────────

const DEFAULT_SETTINGS = {
  autoRefresh: true,
  chronological: true,
};

let settings = { ...DEFAULT_SETTINGS };
let newPostsObserver = null;
let lastUrl = location.href;
let applyPending = false;

// ── Bootstrap ─────────────────────────────────────────────────────────────────

(async function init() {
  await loadSettings();
  watchNavigation();
  await applySettings();
})();

// ── Settings ──────────────────────────────────────────────────────────────────

async function loadSettings() {
  const stored = await chrome.storage.sync.get(Object.keys(DEFAULT_SETTINGS));
  settings = { ...DEFAULT_SETTINGS, ...stored };
}

// React immediately when settings change (e.g. user toggles in popup)
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;
  let changed = false;
  for (const [key, { newValue }] of Object.entries(changes)) {
    if (key in settings) {
      settings[key] = newValue;
      changed = true;
    }
  }
  if (changed) applySettings();
});

// ── SPA navigation detection ──────────────────────────────────────────────────

// Twitter is a single-page app — the content script doesn't reload on navigation.
// We watch for URL changes via MutationObserver (cheaper than polling).
function watchNavigation() {
  const nav = new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      applySettings();
    }
  });
  nav.observe(document.documentElement, { childList: true, subtree: true });
}

// ── Apply settings ────────────────────────────────────────────────────────────

async function applySettings() {
  // Debounce — SPA navigation can fire many mutations at once
  if (applyPending) return;
  applyPending = true;
  await sleep(800); // let Twitter finish rendering the new route
  applyPending = false;

  if (!isHomeFeed()) {
    stopAutoRefresh();
    return;
  }

  if (settings.chronological) {
    await switchToFollowing();
  }

  if (settings.autoRefresh) {
    startAutoRefresh();
  } else {
    stopAutoRefresh();
  }
}

function isHomeFeed() {
  return location.pathname === '/home' || location.pathname === '/';
}

// ── Chronological feed ────────────────────────────────────────────────────────

// Twitter's Home feed has "For you" and "Following" tabs.
// "Following" is reverse-chronological tweets from accounts you follow —
// exactly what Tweetbot showed.
async function switchToFollowing() {
  // Give Twitter a bit more time to render the tab bar
  await sleep(500);

  // Strategy 1: [role="tab"] elements (most reliable)
  const tabs = document.querySelectorAll('[role="tab"]');
  for (const tab of tabs) {
    if (normalizeText(tab.textContent) === 'following') {
      if (tab.getAttribute('aria-selected') !== 'true') {
        tab.click();
      }
      return; // Already on Following, or just clicked it
    }
  }

  // Strategy 2: <a> elements inside the ScrollSnap tab list
  const links = document.querySelectorAll(
    '[data-testid="ScrollSnap-SwipeableList"] a, [data-testid="primaryColumn"] a[role="tab"]'
  );
  for (const link of links) {
    if (normalizeText(link.textContent) === 'following') {
      link.click();
      return;
    }
  }

  // Strategy 3: any element with "Following" text that's inside the main column
  const primary = document.querySelector('[data-testid="primaryColumn"]');
  if (primary) {
    const candidates = primary.querySelectorAll('[role="tab"], [role="button"], a');
    for (const el of candidates) {
      if (normalizeText(el.textContent) === 'following') {
        el.click();
        return;
      }
    }
  }
}

// ── Auto-refresh (new posts pill) ─────────────────────────────────────────────

// Twitter shows a "Show X new posts" pill at the top of the feed when new
// tweets are available. We watch for it and click it automatically.
function startAutoRefresh() {
  stopAutoRefresh(); // clear any previous observer

  // Click any pill that's already visible
  clickNewPostsPill();

  // Watch for the pill to appear — MutationObserver is much lighter than polling
  const anchor = document.querySelector('[data-testid="primaryColumn"]') ?? document.body;

  newPostsObserver = new MutationObserver(() => {
    clickNewPostsPill();
  });

  newPostsObserver.observe(anchor, { childList: true, subtree: true });
}

function stopAutoRefresh() {
  newPostsObserver?.disconnect();
  newPostsObserver = null;
}

function clickNewPostsPill() {
  // Primary selector — Twitter's test ID for the pill button
  const pill = document.querySelector('[data-testid="pillLabel"]');
  if (pill) {
    pill.click();
    return;
  }

  // Fallback: find by text content (handles Twitter DOM renames)
  const candidates = document.querySelectorAll(
    '[role="button"], button, [tabindex="0"]'
  );
  for (const el of candidates) {
    const text = normalizeText(el.textContent);
    if (text.includes('new post') || text.includes('new tweet') || text.includes('show')) {
      // Make sure it's not a nav button by checking it's inside the timeline area
      const primary = document.querySelector('[data-testid="primaryColumn"]');
      if (!primary || primary.contains(el)) {
        el.click();
        return;
      }
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function normalizeText(text) {
  return text.trim().toLowerCase().replace(/\s+/g, ' ');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
