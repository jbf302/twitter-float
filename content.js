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

// ── Scroll state ──────────────────────────────────────────────────────────────

let lastScrollTime = 0;
const SCROLL_IDLE_MS = 15_000;

// ── Scroll-position restore state ─────────────────────────────────────────────

let savedScrollY = 0;
let hadSavedScroll = false;
let newContentWhileAway = false;

// ── Auto-scroll state ─────────────────────────────────────────────────────────

let autoScrollRaf = null;
let autoScrollDir = 1; // 1 = down, -1 = up

// ── Bootstrap ─────────────────────────────────────────────────────────────────

(async function init() {
  await loadSettings();
  setupScrollTracking();
  watchNavigation();
  injectAutoScrollerUI();
  startAdRemover();
  await applySettings();
})();

// ── Settings ──────────────────────────────────────────────────────────────────

async function loadSettings() {
  const stored = await chrome.storage.sync.get(Object.keys(DEFAULT_SETTINGS));
  settings = { ...DEFAULT_SETTINGS, ...stored };
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;
  let changed = false;
  for (const [key, { newValue }] of Object.entries(changes)) {
    if (key in settings) { settings[key] = newValue; changed = true; }
  }
  if (changed) applySettings();
});

// ── SPA navigation detection ──────────────────────────────────────────────────

function watchNavigation() {
  const nav = new MutationObserver(() => {
    if (location.href !== lastUrl) {
      const oldUrl = lastUrl;
      lastUrl = location.href;
      handleUrlChange(oldUrl, lastUrl);
      applySettings();
    }
  });
  nav.observe(document.documentElement, { childList: true, subtree: true });
}

function handleUrlChange(oldUrl, newUrl) {
  const wasHome = isHomeFeedUrl(oldUrl);
  const isHome  = isHomeFeedUrl(newUrl);

  if (wasHome && !isHome) {
    // Leaving feed → save scroll position
    savedScrollY = window.scrollY;
    hadSavedScroll = true;
  } else if (!wasHome && isHome && hadSavedScroll) {
    // Returning to feed → restore position and maybe show new-content banner
    hadSavedScroll = false;
    const scrollTarget   = savedScrollY;
    const hadNewContent  = newContentWhileAway;
    newContentWhileAway  = false;

    setTimeout(() => {
      if (scrollTarget > 0) {
        window.scrollTo({ top: scrollTarget, behavior: 'instant' });
      }
      if (hadNewContent) showNewContentBanner();
    }, 1000); // let Twitter finish rendering the feed
  }
}

// ── Apply settings ────────────────────────────────────────────────────────────

async function applySettings() {
  if (applyPending) return;
  applyPending = true;
  await sleep(800);
  applyPending = false;

  // Re-inject UI in case Twitter replaced the DOM
  injectAutoScrollerUI();

  if (!isHomeFeed()) {
    stopAutoRefresh();
    return;
  }

  if (settings.chronological) await switchToFollowing();
  if (settings.autoRefresh)   startAutoRefresh();
  else                        stopAutoRefresh();
}

function isHomeFeed() {
  return isHomeFeedUrl(location.href);
}

function isHomeFeedUrl(url) {
  try {
    const p = new URL(url).pathname;
    return p === '/home' || p === '/';
  } catch { return false; }
}

// ── Chronological feed ────────────────────────────────────────────────────────

async function switchToFollowing() {
  await sleep(500);

  const tabs = document.querySelectorAll('[role="tab"]');
  for (const tab of tabs) {
    if (normalizeText(tab.textContent) === 'following') {
      if (tab.getAttribute('aria-selected') !== 'true') tab.click();
      return;
    }
  }

  const links = document.querySelectorAll(
    '[data-testid="ScrollSnap-SwipeableList"] a, [data-testid="primaryColumn"] a[role="tab"]'
  );
  for (const link of links) {
    if (normalizeText(link.textContent) === 'following') { link.click(); return; }
  }

  const primary = document.querySelector('[data-testid="primaryColumn"]');
  if (primary) {
    for (const el of primary.querySelectorAll('[role="tab"], [role="button"], a')) {
      if (normalizeText(el.textContent) === 'following') { el.click(); return; }
    }
  }
}

// ── Auto-refresh (new posts pill) ─────────────────────────────────────────────

function startAutoRefresh() {
  stopAutoRefresh();
  clickNewPostsPillIfIdle();
  const anchor = document.querySelector('[data-testid="primaryColumn"]') ?? document.body;
  newPostsObserver = new MutationObserver(clickNewPostsPillIfIdle);
  newPostsObserver.observe(anchor, { childList: true, subtree: true });
}

function stopAutoRefresh() {
  newPostsObserver?.disconnect();
  newPostsObserver = null;
}

function clickNewPostsPillIfIdle() {
  const pill = findNewPostsPill();
  if (!pill) return;

  // If user is away on a tweet page, flag it for the return banner
  if (!isHomeFeed()) {
    newContentWhileAway = true;
    return;
  }

  // Never auto-refresh while auto-scroll is running — it would yank the feed
  if (autoScrollRaf !== null) return;

  const idleMs       = Date.now() - lastScrollTime;
  const scrolledDown = window.scrollY > 200;

  // Don't auto-refresh while user is actively scrolled and not idle
  if (scrolledDown && idleMs < SCROLL_IDLE_MS) return;

  pill.click();
}

function findNewPostsPill() {
  const pill = document.querySelector('[data-testid="pillLabel"]');
  if (pill) return pill;

  const primary    = document.querySelector('[data-testid="primaryColumn"]');
  const candidates = document.querySelectorAll('[role="button"], button, [tabindex="0"]');
  for (const el of candidates) {
    const text = normalizeText(el.textContent);
    if (text.includes('new post') || text.includes('new tweet') || text.includes('show')) {
      if (!primary || primary.contains(el)) return el;
    }
  }
  return null;
}

// ── Scroll tracking ───────────────────────────────────────────────────────────

function setupScrollTracking() {
  document.addEventListener('scroll', () => {
    lastScrollTime = Date.now();
  }, { passive: true });
}

// ── New content banner ────────────────────────────────────────────────────────

function showNewContentBanner() {
  if (document.getElementById('tf-new-content-banner')) return;

  const banner = document.createElement('div');
  banner.id = 'tf-new-content-banner';
  banner.textContent = '↑ New content available';
  banner.addEventListener('click', () => {
    banner.remove();
    window.scrollTo({ top: 0, behavior: 'smooth' });
    setTimeout(() => {
      const pill = findNewPostsPill();
      if (pill) pill.click();
    }, 600);
  });
  document.body.appendChild(banner);
}

// ── Ad removal ────────────────────────────────────────────────────────────────

function startAdRemover() {
  removeAds();
  const observer = new MutationObserver(removeAds);
  observer.observe(document.body, { childList: true, subtree: true });
}

function removeAds() {
  // Promoted tweets that CSS :has() may have missed
  document.querySelectorAll('article[data-testid="tweet"]').forEach(article => {
    if (article.style.display === 'none') return;
    if (article.querySelector('[data-testid="promotedIndicator"]')) {
      article.style.setProperty('display', 'none', 'important');
    }
  });

  // "Who to follow" inline cells in the timeline
  document.querySelectorAll(
    '[data-testid="WhoToFollowSection"], [data-testid="inline_follow_suggestions"]'
  ).forEach(el => el.style.setProperty('display', 'none', 'important'));
}

// ── Auto-scroller UI ──────────────────────────────────────────────────────────

function injectAutoScrollerUI() {
  if (document.getElementById('tf-autoscroller')) return;

  const el = document.createElement('div');
  el.id = 'tf-autoscroller';
  el.innerHTML = `
    <button id="tf-scroll-play" title="Start / stop">▶</button>
    <button id="tf-scroll-dir"  title="Toggle direction">↓</button>
    <span class="tf-speed-label">Speed</span>
    <input type="range" id="tf-scroll-speed" min="1" max="10" value="3">
  `;
  document.body.appendChild(el);

  const playBtn    = document.getElementById('tf-scroll-play');
  const dirBtn     = document.getElementById('tf-scroll-dir');
  const speedSlider = document.getElementById('tf-scroll-speed');

  playBtn.addEventListener('click', () => {
    if (autoScrollRaf !== null) {
      stopAutoScroll();
      playBtn.textContent = '▶';
      el.classList.remove('tf-active');
    } else {
      startAutoScroll(parseInt(speedSlider.value, 10), autoScrollDir);
      playBtn.textContent = '⏸';
      el.classList.add('tf-active');
    }
  });

  dirBtn.addEventListener('click', () => {
    autoScrollDir *= -1;
    dirBtn.textContent = autoScrollDir > 0 ? '↓' : '↑';
    if (autoScrollRaf !== null) {
      stopAutoScroll();
      startAutoScroll(parseInt(speedSlider.value, 10), autoScrollDir);
    }
  });

  speedSlider.addEventListener('input', () => {
    if (autoScrollRaf !== null) {
      stopAutoScroll();
      startAutoScroll(parseInt(speedSlider.value, 10), autoScrollDir);
    }
  });
}

function startAutoScroll(speed, dir) {
  const pxPerFrame = speed * 0.5 * dir; // speed 1–10 → 0.5–5 px/frame at 60fps

  function tick() {
    const before = window.scrollY;
    window.scrollBy(0, pxPerFrame);
    lastScrollTime = Date.now(); // prevent auto-refresh from interrupting

    if (window.scrollY === before) {
      // Hit the top or bottom boundary — stop
      stopAutoScroll();
      const btn = document.getElementById('tf-scroll-play');
      const ui  = document.getElementById('tf-autoscroller');
      if (btn) btn.textContent = '▶';
      if (ui)  ui.classList.remove('tf-active');
      return;
    }

    autoScrollRaf = requestAnimationFrame(tick);
  }

  autoScrollRaf = requestAnimationFrame(tick);
}

function stopAutoScroll() {
  if (autoScrollRaf !== null) {
    cancelAnimationFrame(autoScrollRaf);
    autoScrollRaf = null;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function normalizeText(text) {
  return text.trim().toLowerCase().replace(/\s+/g, ' ');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
