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

// Flow's flow.projectInitialData API represents media titles in (at least)
// two different shapes, confirmed directly against two different live
// projects this session:
//  1. A flat pair: some object has both "name" (the media UUID) and
//     "displayName" (the title) as direct sibling fields.
//  2. A workflow wrapper (this is what most real projects actually use,
//     confirmed against a 427-item project): the outer object's own "name"
//     is the *workflow's* id, not the media id, and the title lives one
//     level down at workflow.metadata.displayName, paired with the actual
//     media id at workflow.metadata.primaryMediaId, sibling to each other
//     but a level removed from the outer "name". A walk that only ever
//     checks "does this one object have both name and displayName" never
//     matches shape 2 at all, silently returning an empty map, which is
//     exactly why downloads were falling back to raw UUIDs on projects
//     built from workflows. Both shapes are checked here.
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
        // Shape 1: flat name + displayName siblings.
        if (typeof node.name === 'string' && UUID_RE.test(node.name) && typeof node.displayName === 'string' && node.displayName.trim()) {
          map[node.name] = node.displayName.trim();
        }
        // Shape 2: workflow wrapper, title+media-id live under .metadata.
        const meta = node.metadata;
        if (
          meta && typeof meta === 'object' &&
          typeof meta.primaryMediaId === 'string' && UUID_RE.test(meta.primaryMediaId) &&
          typeof meta.displayName === 'string' && meta.displayName.trim()
        ) {
          map[meta.primaryMediaId] = meta.displayName.trim();
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
  // whose scrollHeight exceeds its clientHeight AND is actually a real
  // scroll container (overflow-y: auto/scroll). The overflow check matters:
  // Flow's DOM has several wrapper divs between a thumbnail and the true
  // scrolling ancestor whose scrollHeight is technically a few px taller
  // than clientHeight but whose overflow-y is visible/hidden, not a real
  // scroll box. Assigning .scrollTop on one of those is a silent no-op, so
  // the previous version (scrollHeight/clientHeight check only, no overflow
  // check) could latch onto one of those and scroll nothing at all, capping
  // "Select all"/full-project collection at whatever was rendered on first
  // paint before any real scrolling happened (confirmed as the cause of
  // "select all only selects N" reports).
  const img = document.querySelector('img[src*="getMediaUrlRedirect"]');
  let el = img ? img.parentElement : null;
  while (el && el !== document.body) {
    const style = getComputedStyle(el);
    const canScroll = style.overflowY === 'auto' || style.overflowY === 'scroll';
    if (canScroll && el.scrollHeight > el.clientHeight + 20) return el;
    el = el.parentElement;
  }
  return document.scrollingElement || document.documentElement;
}

// Collects every additional scrollable candidate in the document (not just
// the one found by walking up from the first thumbnail), as a fallback in
// case the real grid container isn't actually an ancestor of that first
// image for some layout reason. Cheap safety net, only used if the primary
// container makes no progress at all.
function findAllScrollableCandidates() {
  const out = [];
  document.querySelectorAll('*').forEach((el) => {
    const style = getComputedStyle(el);
    if ((style.overflowY === 'auto' || style.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 20) {
      out.push(el);
    }
  });
  return out;
}

// Live-tested against a real 427-item project: the grid's virtualized
// scroll container genuinely reaches its own scrollTop max (confirmed via
// direct inspection, scrollTop sitting at 28530 of a 28588 max) well before
// the DOM has rendered anywhere near all 427 items, because Flow paginates
// what it loads into that container separately from the full item list its
// own flow.projectInitialData API already knows about. Reaching the bottom
// isn't "done", it's "waiting on the next network page to land and grow the
// container." A fixed stable-round give-up can't tell those two states
// apart, so this now checks the real expected total from the API up front
// and stays patient (much longer stable-round tolerance, since we know
// there's more coming) until collection actually reaches it, or a hard
// wall-clock cap is hit as a safety net against a project where the API
// count and the renderable count genuinely don't match (e.g. trashed items
// still present in the API response).
async function autoScrollAndCollect(onProgress) {
  let container = findScrollableGridContainer();
  const collected = new Set(scanDomForMediaIds());
  let stableRounds = 0;
  let lastCount = collected.size;
  let triedFallback = false;

  const projectId = getProjectIdFromUrl();
  let expectedTotal = null;
  if (projectId) {
    try {
      const titleMap = await fetchMediaTitles(projectId);
      const n = Object.keys(titleMap).length;
      if (n > 0) expectedTotal = n;
    } catch (e) {
      // best-effort only, fall back to stable-round detection below
    }
  }

  const startTime = Date.now();
  const HARD_TIMEOUT_MS = 5 * 60 * 1000; // absolute safety net
  const giveUpRounds = expectedTotal ? 20 : 6; // more patience when we know there's a target to reach

  for (let i = 0; i < 2000; i++) {
    if (Date.now() - startTime > HARD_TIMEOUT_MS) break;
    if (expectedTotal && collected.size >= expectedTotal) break;
    if (!expectedTotal && stableRounds >= giveUpRounds) break;
    if (expectedTotal && stableRounds >= giveUpRounds) break; // genuinely stuck short of the API's total, stop anyway

    // Step by roughly one viewport height per round rather than jumping
    // straight to scrollHeight. Confirmed this matters: infinite-scroll
    // "fetch the next page" logic in apps like this is commonly wired to a
    // scroll event / intersection observer near the currently-loaded edge,
    // not to an absolute scrollTop value. A single jump straight to the
    // computed max can land past anything that's actually been fetched yet
    // (scrollHeight can already assume more items exist even though only
    // some pages are loaded) without ever crossing the trigger point
    // incrementally, so the next-page fetch never fires. Small steps mimic
    // real scrolling and reliably cross that trigger each round instead.
    const step = Math.max(300, Math.round(container.clientHeight * 0.85));
    const nextTop = Math.min(container.scrollTop + step, container.scrollHeight);
    container.scrollTop = nextTop;
    container.dispatchEvent(new Event('scroll', { bubbles: true }));
    // also nudge window scroll in case the grid uses window scrolling
    const winStep = Math.max(300, Math.round(window.innerHeight * 0.85));
    window.scrollTo(0, Math.min(window.scrollY + winStep, document.body.scrollHeight));
    await new Promise((r) => setTimeout(r, 700));
    scanDomForMediaIds().forEach((id) => collected.add(id));
    if (onProgress) {
      onProgress(collected.size, expectedTotal);
    }
    if (collected.size === lastCount) {
      stableRounds++;
      // If the primary heuristic's container turns out not to actually be
      // scrollable (edge case the overflow check above doesn't catch, e.g.
      // a container that starts non-scrollable but Flow makes scrollable
      // dynamically), try the next-best real scrollable candidate once
      // before accepting "no more items" and stopping.
      if (stableRounds === 3 && !triedFallback) {
        triedFallback = true;
        const candidates = findAllScrollableCandidates().filter((c) => c !== container);
        if (candidates.length) {
          // Prefer the one with the most overflow (most likely the grid).
          candidates.sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight));
          container = candidates[0];
          stableRounds = 0;
        }
      }
    } else {
      stableRounds = 0;
      lastCount = collected.size;
    }
  }
  return Array.from(collected);
}

// ---- Selection mode UI (checkboxes on thumbnails) ----

function toggleCheckboxTile(tile, box) {
  const id = tile.dataset.gfbdId;
  if (!id) return;
  if (selectedIds.has(id)) {
    selectedIds.delete(id);
    box.classList.remove('gfbd-checked');
  } else {
    selectedIds.add(id);
    box.classList.add('gfbd-checked');
  }
}

function makeCheckbox(tile) {
  const box = document.createElement('div');
  box.className = 'gfbd-checkbox';
  box.title = 'Click to select/deselect this item';
  // No listeners attached here on purpose, see the document-level capture
  // listeners registered once below (documentClickCapture and friends).
  // Listeners added directly on this element only ever run in the bubble
  // phase (even ones registered with {capture:true} on the element itself,
  // since capture vs bubble only matters relative to *ancestors*), and
  // Flow's own React root attaches its click handling at the document
  // capture phase. Capture always runs top-down before bubble runs
  // bottom-up, so Flow's "open this item" handler was winning the race and
  // firing before stopPropagation() called from a listener on this element
  // ever got a chance to run, that's what caused deselect-then-reselect (and
  // sometimes plain select) to intermittently open the item instead of
  // toggling it. Intercepting on document itself, in the capture phase,
  // runs before Flow's own root listener no matter what, since document is
  // higher in the tree than Flow's root container.
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

// Registered once, on document itself, in the capture phase, specifically
// so this runs before Flow's own React root listener sees the event at all
// (see the long comment in makeCheckbox for why bubble-phase listeners on
// the checkbox element weren't reliable). preventDefault + stopPropagation +
// stopImmediatePropagation here means Flow's click-to-open handler never
// fires for anything inside a .gfbd-checkbox zone while selection mode is
// on, on every phase Flow might be listening on.
function installSelectionClickGuard() {
  const intercept = (e) => {
    if (!selectionModeOn) return;
    const box = e.target.closest && e.target.closest('.gfbd-checkbox');
    if (!box) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.stopImmediatePropagation) e.stopImmediatePropagation();
    if (e.type === 'click') {
      const tile = box.parentElement;
      if (tile) toggleCheckboxTile(tile, box);
    }
  };
  ['pointerdown', 'mousedown', 'mouseup', 'click'].forEach((type) => {
    document.addEventListener(type, intercept, true); // true = capture phase
  });
}
installSelectionClickGuard();

function setSelectionMode(on) {
  selectionModeOn = on;
  if (on) {
    decorateTiles();
    observer.observe(document.body, { childList: true, subtree: true });
    document.body.classList.add('gfbd-selection-mode');
  } else {
    observer.disconnect();
    document.body.classList.remove('gfbd-selection-mode');
    // checkboxByTile is a WeakMap keyed by tile element. Just removing the
    // checkbox <div>s from the DOM here isn't enough: the map entry for
    // each tile survives, so next time selection mode turns back on,
    // decorateTiles()'s "if (!checkboxByTile.has(tile))" check thinks that
    // tile already has a checkbox and skips creating a new one, it just
    // re-toggles a class on the old, now-detached element. Nothing ever
    // gets re-appended. That was the actual "turn selecting off then back
    // on doesn't bring back the checkboxes" bug: deleting each tile's map
    // entry here, not just removing the element, is what fixes it.
    document.querySelectorAll('.gfbd-checkbox').forEach((el) => {
      const tile = el.parentElement;
      if (tile) checkboxByTile.delete(tile);
      el.remove();
    });
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
    ids = await autoScrollAndCollect((n, total) => setStatusText(total ? `Found ${n} of ${total}...` : `Found ${n} so far...`));
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
    const ids = await autoScrollAndCollect((n, total) => setStatusText(total ? `Found ${n} of ${total}...` : `Found ${n} so far...`));
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

// Two earlier approaches both tried to live *inside* Flow's own header row
// (as a flex child, inserted next to the "Add Media" button), and both broke
// the same way: navigating into a single item's editor and back out doesn't
// reload the page, but it does disturb Flow's own header layout. First that
// meant our toolbar got stranded in a dying, squeezed-off-screen old header.
// After fixing that (re-homing next to the current anchor every tick), the
// deeper problem showed up: Flow's own header *row itself* comes back
// mispositioned after that round trip (its container's own bounding rect
// sits off past the right edge of the viewport, nothing to do with our
// code, confirmed by reading Flow's own row's rect directly), and every
// flex child riding inside it, including "Add Media" itself, goes with it.
// There's no reliable way to anchor correctly next to a native element
// whose own container Flow is placing off-screen.
//
// So: stop being a flex child of Flow's header at all. The toolbar is now a
// fixed-position float, appended once to <body>, positioned in the gap
// between the left sidebar and Flow's search bar. That gap is empty in
// every view this extension cares about and isn't part of Flow's own flex
// row, so nothing Flow does to its own header layout can touch it.
function ensureToolbar() {
  let toolbar = document.querySelector('.gfbd-toolbar');
  if (!toolbar || !toolbar.isConnected) {
    toolbar = buildToolbar();
    document.body.appendChild(toolbar);
  }
  // Only makes sense on the grid view. Flow's single-item editor uses a
  // /project/<id>/edit/<mediaId> URL, hide the toolbar there rather than
  // floating it over an unrelated screen.
  const inEditor = /\/edit\//.test(location.pathname);
  toolbar.style.display = inEditor ? 'none' : 'flex';
  syncToolbarSelectButton();
  return true;
}

// Keep quietly re-checking (URL/view can change without a page reload on
// this SPA) rather than injecting once and giving up.
setInterval(ensureToolbar, 1000);
ensureToolbar();

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
