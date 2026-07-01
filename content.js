// Google Flow Bulk Downloader - content script
// Runs on https://labs.google/fx/tools/flow/*
// Job: read the media grid that's actually rendered in the page and report
// back media IDs to the popup/background. This deliberately reads the DOM
// (img src = .../media.getMediaUrlRedirect?name=<id>) rather than guessing
// the shape of Flow's internal tRPC JSON, because the DOM is what we can
// directly confirm works. Also injects an in-page toolbar (Select /
// Select all / Download / to .zip) next to Flow's own top-bar icons.

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

let selectionModeOn = false;
const selectedIds = new Set();
const checkboxByTile = new WeakMap();

function getProjectIdFromUrl() {
  const m = location.pathname.match(/\/project\/([0-9a-f-]{36})/i);
  return m ? m[1] : null;
}

function getProjectName() {
  // The top bar has an editable textbox holding the project title/date.
  const box = document.querySelector('nav textbox, nav input, nav [contenteditable="true"]');
  if (box && box.textContent && box.textContent.trim()) return box.textContent.trim();
  const input = document.querySelector('input[type="text"]');
  if (input && input.value) return input.value;
  return (document.title || 'Google Flow Project').replace(/^Google Flow - /, '');
}

// Flow's flow.projectInitialData API returns each media item as an object
// with a "name" field (the UUID used everywhere else) and a "displayName"
// field (the human-readable title, e.g. "Politician on dock NDIS ship").
// Confirmed directly against a live project's API response. Used to name
// downloaded files sensibly instead of by raw UUID.
async function fetchMediaTitles(projectId) {
  const map = {};
  try {
    const input = encodeURIComponent(JSON.stringify({ json: { projectId } }));
    const res = await fetch(`https://labs.google/fx/api/trpc/flow.projectInitialData?input=${input}`, { credentials: 'include' });
    if (!res.ok) return map;
    const data = await res.json();
    (function walk(node) {
      if (Array.isArray(node)) {
        node.forEach(walk);
        return;
      }
      if (node && typeof node === 'object') {
        if (typeof node.name === 'string' && UUID_RE.test(node.name) && typeof node.displayName === 'string' && node.displayName.trim()) {
          map[node.name] = node.displayName.trim();
        }
        for (const k of Object.keys(node)) walk(node[k]);
      }
    })(data);
  } catch (e) {
    console.warn('[GFBD] could not fetch media titles, falling back to IDs', e);
  }
  return map;
}

function extractMediaIdFromSrc(src) {
  if (!src || !src.includes('getMediaUrlRedirect')) return null;
  try {
    const url = new URL(src, location.origin);
    return url.searchParams.get('name');
  } catch (e) {
    return null;
  }
}

function scanDomForMediaIds() {
  const ids = new Set();
  document.querySelectorAll('img').forEach((img) => {
    const id = extractMediaIdFromSrc(img.currentSrc || img.src);
    if (id) ids.add(id);
  });
  return ids;
}

function findScrollableGridContainer() {
  // Heuristic: the media grid is the scrollable element containing the most
  // <img> thumbnails. Walk up from an image and find the first ancestor
  // whose scrollHeight exceeds its clientHeight.
  const img = document.querySelector('img[src*="getMediaUrlRedirect"]');
  let el = img ? img.parentElement : null;
  while (el && el !== document.body) {
    if (el.scrollHeight > el.clientHeight + 20) return el;
    el = el.parentElement;
  }
  return document.scrollingElement || document.documentElement;
}

async function autoScrollAndCollect(onProgress) {
  const container = findScrollableGridContainer();
  const collected = new Set(scanDomForMediaIds());
  let stableRounds = 0;
  let lastCount = collected.size;

  for (let i = 0; i < 400 && stableRounds < 4; i++) {
    container.scrollTop = container.scrollHeight;
    // also nudge window scroll in case the grid uses window scrolling
    window.scrollTo(0, document.body.scrollHeight);
    await new Promise((r) => setTimeout(r, 450));
    scanDomForMediaIds().forEach((id) => collected.add(id));
    if (onProgress) onProgress(collected.size);
    if (collected.size === lastCount) {
      stableRounds++;
    } else {
      stableRounds = 0;
      lastCount = collected.size;
    }
  }
  return Array.from(collected);
}

// ---- Selection mode UI (checkboxes on thumbnails) ----

function makeCheckbox(tile) {
  const box = document.createElement('div');
  box.className = 'gfbd-checkbox';
  box.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const id = tile.dataset.gfbdId;
    if (!id) return;
    if (selectedIds.has(id)) {
      selectedIds.delete(id);
      box.classList.remove('gfbd-checked');
    } else {
      selectedIds.add(id);
      box.classList.add('gfbd-checked');
    }
  });
  return box;
}

function decorateTiles() {
  document.querySelectorAll('img[src*="getMediaUrlRedirect"]').forEach((img) => {
    const id = extractMediaIdFromSrc(img.currentSrc || img.src);
    if (!id) return;
    // Find a positioned ancestor to anchor the checkbox to (the button
    // wrapper Flow renders around each thumbnail).
    let tile = img.closest('button') || img.parentElement;
    if (!tile) return;
    if (getComputedStyle(tile).position === 'static') tile.style.position = 'relative';
    tile.dataset.gfbdId = id;
    if (!checkboxByTile.has(tile)) {
      const box = makeCheckbox(tile);
      tile.appendChild(box);
      checkboxByTile.set(tile, box);
    }
    const box = checkboxByTile.get(tile);
    if (box) box.classList.toggle('gfbd-checked', selectedIds.has(id));
  });
}

const observer = new MutationObserver(() => {
  if (selectionModeOn) decorateTiles();
});

function setSelectionMode(on) {
  selectionModeOn = on;
  if (on) {
    decorateTiles();
    observer.observe(document.body, { childList: true, subtree: true });
    document.body.classList.add('gfbd-selection-mode');
  } else {
    observer.disconnect();
    document.body.classList.remove('gfbd-selection-mode');
    document.querySelectorAll('.gfbd-checkbox').forEach((el) => el.remove());
    selectedIds.clear();
  }
  syncToolbarSelectButton();
}

// ---- In-page toolbar (Select / Select all / Download / to .zip) ----

function setStatusText(t) {
  const el = document.getElementById('gfbd-status-text');
  if (el) el.textContent = t;
}

function syncToolbarSelectButton() {
  const btn = document.getElementById('gfbd-btn-select');
  if (!btn) return;
  btn.textContent = selectionModeOn ? 'Selecting…' : 'Select';
  btn.classList.toggle('gfbd-btn-active', selectionModeOn);
}

async function startDownload(asZip) {
  let ids = Array.from(selectedIds);
  if (ids.length === 0) {
    setStatusText('No selection, scrolling to grab everything in this project...');
    ids = await autoScrollAndCollect((n) => setStatusText(`Found ${n} so far...`));
  }
  if (ids.length === 0) {
    setStatusText('No media found.');
    return;
  }
  const pid = getProjectIdFromUrl();
  setStatusText('Looking up names for these items...');
  const titles = pid ? await fetchMediaTitles(pid) : {};
  const jobId = (asZip ? 'inpage-zip-' : 'inpage-dl-') + Date.now();
  setStatusText(`${asZip ? 'Zipping' : 'Downloading'} ${ids.length} items...`);
  chrome.runtime.sendMessage({ type: 'DOWNLOAD_IDS', ids, titles, folderName: getProjectName(), jobId, asZip });
}

function findAnchorButton() {
  // Anchor our toolbar next to Flow's own "Add Media" button in the top bar.
  const buttons = Array.from(document.querySelectorAll('button'));
  return buttons.find(
    (b) => /add media/i.test(b.getAttribute('aria-label') || '') || /add media/i.test(b.textContent || '')
  );
}

function buildToolbar() {
  const bar = document.createElement('div');
  bar.className = 'gfbd-toolbar';

  const btnSelect = document.createElement('button');
  btnSelect.id = 'gfbd-btn-select';
  btnSelect.type = 'button';
  btnSelect.className = 'gfbd-btn';
  btnSelect.textContent = 'Select';
  btnSelect.addEventListener('click', () => setSelectionMode(!selectionModeOn));

  const btnSelectAll = document.createElement('button');
  btnSelectAll.type = 'button';
  btnSelectAll.className = 'gfbd-btn';
  btnSelectAll.textContent = 'Select all';
  btnSelectAll.addEventListener('click', async () => {
    setSelectionMode(true);
    setStatusText('Scrolling to find all media...');
    const ids = await autoScrollAndCollect((n) => setStatusText(`Found ${n} so far...`));
    ids.forEach((id) => selectedIds.add(id));
    decorateTiles();
    setStatusText(`Selected all ${ids.length} items.`);
  });

  const btnDownload = document.createElement('button');
  btnDownload.type = 'button';
  btnDownload.className = 'gfbd-btn gfbd-btn-primary';
  btnDownload.textContent = 'Download';
  btnDownload.addEventListener('click', () => startDownload(false));

  const btnZip = document.createElement('button');
  btnZip.type = 'button';
  btnZip.className = 'gfbd-btn gfbd-btn-primary';
  btnZip.textContent = 'to .zip';
  btnZip.addEventListener('click', () => startDownload(true));

  const status = document.createElement('span');
  status.id = 'gfbd-status-text';
  status.className = 'gfbd-status';

  bar.append(btnSelect, btnSelectAll, btnDownload, btnZip, status);
  return bar;
}

function tryInjectToolbar() {
  if (document.querySelector('.gfbd-toolbar')) return true;
  const anchor = findAnchorButton();
  if (!anchor || !anchor.parentElement) return false;
  anchor.parentElement.insertBefore(buildToolbar(), anchor);
  return true;
}

// Flow is a client-routed SPA, so the header can re-render between project
// views. Keep quietly retrying rather than injecting once and giving up.
setInterval(tryInjectToolbar, 1500);
tryInjectToolbar();

// ---- Message handling ----

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'PROGRESS') {
    if (msg.stage === 'zipping') {
      setStatusText(`Zip: ${msg.done}/${msg.total}${msg.failed ? ` (${msg.failed} failed)` : ''}${msg.finished ? ' — saved.' : ''}`);
    } else if (msg.stage === 'compressing') {
      setStatusText('Compressing into a zip...');
    } else if (msg.done !== undefined) {
      setStatusText(`Downloading ${msg.done}/${msg.total}${msg.finished ? ' — done.' : ''}`);
    }
    return false;
  }

  (async () => {
    if (msg.type === 'PING') {
      sendResponse({ ok: true, projectId: getProjectIdFromUrl(), projectName: getProjectName() });
    } else if (msg.type === 'GET_ALL_MEDIA_IDS') {
      const ids = await autoScrollAndCollect();
      const pid = getProjectIdFromUrl();
      const titles = pid ? await fetchMediaTitles(pid) : {};
      sendResponse({ ok: true, projectId: pid, projectName: getProjectName(), ids, titles });
    } else if (msg.type === 'ENABLE_SELECTION_MODE') {
      setSelectionMode(true);
      sendResponse({ ok: true });
    } else if (msg.type === 'DISABLE_SELECTION_MODE') {
      setSelectionMode(false);
      sendResponse({ ok: true });
    } else if (msg.type === 'GET_SELECTED_MEDIA_IDS') {
      const pid = getProjectIdFromUrl();
      const titles = pid ? await fetchMediaTitles(pid) : {};
      sendResponse({ ok: true, projectId: pid, projectName: getProjectName(), ids: Array.from(selectedIds), titles });
    } else {
      sendResponse({ ok: false, error: 'unknown message type' });
    }
  })();
  return true; // keep the message channel open for the async response
});
