'use strict';

// ── Defaults ─────────────────────────────────────────────────────────────────

const DEFAULT_SETTINGS = {
  autoRefresh: true,
  chronological: true,
  compactMedia: false,
  autoExpandThreads: true,
};

let settings = { ...DEFAULT_SETTINGS };
let newPostsObserver = null;
let threadObserver = null;
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

// ── Reveal-scroll state (smooth reveal of newly-loaded tweets) ────────────────

let revealScrollRaf = null;
const REVEAL_PX_PER_FRAME = 3; // ≈ 180 px/s at 60 fps

// ── Link preview cache ────────────────────────────────────────────────────────

const previewCache = new Map();

// ── Bootstrap ─────────────────────────────────────────────────────────────────

(async function init() {
  await loadSettings();
  setupScrollTracking();
  watchNavigation();
  injectAutoScrollerUI();
  injectLinkPreviewTooltip();
  setupLinkPreviews();
  setupCompactMediaClicks();
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
    savedScrollY = window.scrollY;
    hadSavedScroll = true;
  } else if (!wasHome && isHome && hadSavedScroll) {
    hadSavedScroll = false;
    const scrollTarget  = savedScrollY;
    const hadNewContent = newContentWhileAway;
    newContentWhileAway = false;

    setTimeout(() => {
      if (scrollTarget > 0) window.scrollTo({ top: scrollTarget, behavior: 'instant' });
      if (hadNewContent) showNewContentBanner();
    }, 1000);
  }

  hideLinkPreview();
}

// ── Apply settings ────────────────────────────────────────────────────────────

async function applySettings() {
  if (applyPending) return;
  applyPending = true;
  await sleep(800);
  applyPending = false;

  injectAutoScrollerUI();
  applyCompactMedia();

  if (!isHomeFeed()) {
    stopAutoRefresh();
    if (settings.autoExpandThreads && isThreadPage()) startThreadExpander();
    else stopThreadExpander();
    return;
  }

  stopThreadExpander();
  if (settings.chronological) await switchToFollowing();
  if (settings.autoRefresh)   startAutoRefresh();
  else                        stopAutoRefresh();
}

function isHomeFeed() { return isHomeFeedUrl(location.href); }

function isHomeFeedUrl(url) {
  try { const p = new URL(url).pathname; return p === '/home' || p === '/'; }
  catch { return false; }
}

function isThreadPage() {
  return /\/status\/\d+/.test(location.pathname);
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

  if (!isHomeFeed()) {
    newContentWhileAway = true;
    return;
  }

  // Never auto-refresh while auto-scroll or reveal-scroll is running
  if (autoScrollRaf !== null || revealScrollRaf !== null) return;

  const idleMs       = Date.now() - lastScrollTime;
  const scrolledDown = window.scrollY > 200;

  if (scrolledDown && idleMs < SCROLL_IDLE_MS) return;

  clickPillWithReveal(pill);
}

async function clickPillWithReveal(pill) {
  const scrollHeightBefore = document.documentElement.scrollHeight;

  pill.click();

  // Wait for Twitter to insert new tweets and perform its own scroll
  await sleep(600);

  const addedHeight = document.documentElement.scrollHeight - scrollHeightBefore;

  // If no meaningful content was added, nothing to reveal
  if (addedHeight < 100) return;

  // Twitter scrolls the window to the top after loading new tweets.
  // Jump the viewport down so the "old" first tweet is back in view,
  // then smoothly scroll up to reveal all the new tweets.
  window.scrollTo({ top: addedHeight, behavior: 'instant' });
  startRevealScroll();
}

function startRevealScroll() {
  if (revealScrollRaf !== null) cancelAnimationFrame(revealScrollRaf);

  function tick() {
    if (window.scrollY <= 0) {
      revealScrollRaf = null;
      return;
    }
    window.scrollBy(0, -REVEAL_PX_PER_FRAME);
    lastScrollTime = Date.now(); // prevent auto-refresh from firing during reveal
    revealScrollRaf = requestAnimationFrame(tick);
  }
  revealScrollRaf = requestAnimationFrame(tick);
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
  document.addEventListener('scroll', () => { lastScrollTime = Date.now(); }, { passive: true });

  // When the user returns to this tab/window, immediately check for new posts.
  // Reset the idle timer first so the pill check isn't blocked by the 15 s guard.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      lastScrollTime = 0;
      clickNewPostsPillIfIdle();
    }
  });

  window.addEventListener('focus', () => {
    lastScrollTime = 0;
    clickNewPostsPillIfIdle();
  });
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
    setTimeout(() => { const pill = findNewPostsPill(); if (pill) pill.click(); }, 600);
  });
  document.body.appendChild(banner);
}

// ── Compact media ─────────────────────────────────────────────────────────────

function applyCompactMedia() {
  document.documentElement.classList.toggle('tf-compact-media', settings.compactMedia);
}

function setupCompactMediaClicks() {
  // Click on a collapsed media element to expand it inline
  document.addEventListener('click', (e) => {
    if (!settings.compactMedia) return;
    const media = e.target.closest(
      '[data-testid="tweetPhoto"], [data-testid="videoComponent"], ' +
      '[data-testid="card.layoutLarge.media"], [data-testid="previewInterstitial"]'
    );
    if (!media) return;
    if (media.classList.contains('tf-media-expanded')) return;
    media.classList.add('tf-media-expanded');
    e.stopPropagation();
  }, true);
}

// ── Thread auto-expander ──────────────────────────────────────────────────────

const expandedSet = new WeakSet();

function startThreadExpander() {
  stopThreadExpander();
  expandThreadItems();
  threadObserver = new MutationObserver(debounce(expandThreadItems, 400));
  threadObserver.observe(document.body, { childList: true, subtree: true });
}

function stopThreadExpander() {
  threadObserver?.disconnect();
  threadObserver = null;
}

function expandThreadItems() {
  // Expand truncated long tweets
  document.querySelectorAll('[data-testid="tweet_show_more_button"]').forEach(btn => {
    if (expandedSet.has(btn)) return;
    expandedSet.add(btn);
    btn.click();
  });

  // Expand "X more replies" / "Show more replies" inside threads
  const primary = document.querySelector('[data-testid="primaryColumn"]');
  if (!primary) return;

  primary.querySelectorAll('[role="button"], button').forEach(btn => {
    if (expandedSet.has(btn)) return;
    const text = normalizeText(btn.textContent);
    if (
      (text.includes('more repl') || text.includes('show more repl')) &&
      !text.includes('compose')
    ) {
      expandedSet.add(btn);
      btn.click();
    }
  });
}

// ── Ad removal ────────────────────────────────────────────────────────────────

function startAdRemover() {
  removeAds();
  new MutationObserver(removeAds).observe(document.body, { childList: true, subtree: true });
}

function removeAds() {
  document.querySelectorAll('article[data-testid="tweet"]').forEach(article => {
    if (article.style.display === 'none') return;
    if (article.querySelector('[data-testid="promotedIndicator"]')) {
      article.style.setProperty('display', 'none', 'important');
    }
  });
  document.querySelectorAll(
    '[data-testid="WhoToFollowSection"], [data-testid="inline_follow_suggestions"]'
  ).forEach(el => el.style.setProperty('display', 'none', 'important'));
}

// ── Link preview tooltip ──────────────────────────────────────────────────────

function injectLinkPreviewTooltip() {
  if (document.getElementById('tf-link-preview')) return;
  const el = document.createElement('div');
  el.id = 'tf-link-preview';
  document.body.appendChild(el);
}

function setupLinkPreviews() {
  let hoverTimer = null;
  let hideTimer  = null;
  let activeLink = null;

  document.addEventListener('mouseover', (e) => {
    // Don't hide when hovering into the tooltip itself
    if (e.target.closest('#tf-link-preview')) {
      clearTimeout(hideTimer);
      return;
    }

    const link = e.target.closest('a[href]');
    if (!link || link === activeLink || !isPreviewableLink(link)) return;

    clearTimeout(hoverTimer);
    clearTimeout(hideTimer);
    activeLink = link;
    hoverTimer = setTimeout(() => fetchAndShowPreview(link), 600);
  });

  document.addEventListener('mouseout', (e) => {
    if (e.target.closest('#tf-link-preview')) return;
    const link = e.target.closest('a[href]');
    if (!link && !e.target.closest('#tf-link-preview')) return;

    // Moving into tooltip — keep it open
    if (e.relatedTarget?.closest('#tf-link-preview')) return;

    clearTimeout(hoverTimer);
    activeLink = null;
    hideTimer = setTimeout(hideLinkPreview, 300);
  });
}

function isPreviewableLink(link) {
  if (!link.closest('[data-testid="tweetText"]')) return false;
  const href = link.href || '';
  // Skip internal Twitter/X navigation
  if (/^https?:\/\/(www\.)?(twitter|x)\.com/.test(href)) return false;
  return href.startsWith('http');
}

async function fetchAndShowPreview(link) {
  const tooltip = document.getElementById('tf-link-preview');
  if (!tooltip) return;

  const url = link.dataset.expandedUrl || link.href;
  if (!url?.startsWith('http')) return;

  // Show loading
  tooltip.className = 'tf-loading';
  tooltip.innerHTML = '';
  tooltip.style.display = 'block';
  positionTooltip(link, tooltip);

  // Fetch with cache
  let data = previewCache.get(url);
  if (!data) {
    try {
      data = await chrome.runtime.sendMessage({ action: 'fetchLinkPreview', url });
      if (data?.title) previewCache.set(url, data);
    } catch { data = null; }
  }

  if (!data?.title) { hideLinkPreview(); return; }

  tooltip.className = '';
  tooltip.innerHTML = `
    ${data.image ? `<div class="tf-pi"><img src="${escAttr(data.image)}" alt="" onerror="this.closest('.tf-pi').remove()"></div>` : ''}
    <div class="tf-pb">
      <div class="tf-pt">${escHtml(data.title)}</div>
      ${data.description ? `<div class="tf-pd">${escHtml(data.description.slice(0, 140))}</div>` : ''}
      <div class="tf-pu">${escHtml(getDomain(data.finalUrl || url))}</div>
    </div>
  `;

  positionTooltip(link, tooltip);
}

function positionTooltip(link, tooltip) {
  const r  = link.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  let top  = r.bottom + 8;
  let left = r.left;

  tooltip.style.left = `${left}px`;
  tooltip.style.top  = `${top}px`;

  requestAnimationFrame(() => {
    const tr = tooltip.getBoundingClientRect();
    if (left + tr.width > vw - 8) left = Math.max(8, vw - tr.width - 8);
    if (top  + tr.height > vh - 8) top  = r.top - tr.height - 8;
    tooltip.style.left = `${left}px`;
    tooltip.style.top  = `${top}px`;
  });
}

function hideLinkPreview() {
  const t = document.getElementById('tf-link-preview');
  if (t) t.style.display = 'none';
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
  const pxPerFrame = speed * 0.5 * dir;
  function tick() {
    const before = window.scrollY;
    window.scrollBy(0, pxPerFrame);
    lastScrollTime = Date.now();
    if (window.scrollY === before) {
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
  if (autoScrollRaf !== null) { cancelAnimationFrame(autoScrollRaf); autoScrollRaf = null; }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function normalizeText(text) {
  return text.trim().toLowerCase().replace(/\s+/g, ' ');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

function getDomain(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function escAttr(s) {
  return String(s).replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
