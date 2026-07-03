// Google Flow Bulk Downloader - background service worker
// Owns the actual download queue so a batch keeps running even if the
// popup closes. Also owns the two library-wide discovery calls
// (project.searchUserProjects, flow.projectInitialData) since those need
// to run against projects that aren't open in a tab.

importScripts('vendor/jszip.min.js');

// Bump this string on every meaningful change and check it in the service
// worker console (chrome://extensions -> "service worker" link under this
// extension) after reloading. If the console doesn't show this exact tag,
// the reload didn't actually pick up new code, that's the fastest way to
// tell "the fix isn't working" apart from "the extension is still running
// the old version" when testing changes.
const GFBD_BUILD = 'gfbd-build-2026-07-02l-filename-map-fix';
console.log('[GFBD] background service worker loaded:', GFBD_BUILD);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let progressListeners = new Set();

// chrome.runtime.sendMessage only reaches other *extension* pages (the
// popup, when it happens to be open) -- it does NOT reach content scripts
// running inside a tab. That's the actual reason the in-page toolbar's
// status text was getting stuck on its initial string forever: every
// progress update was being sent in a way the toolbar's listener could
// never physically receive, not a bug in the listener itself. Reaching a
// content script requires chrome.tabs.sendMessage(tabId, ...) instead, so
// this now does both: chrome.runtime.sendMessage for the popup, plus
// chrome.tabs.sendMessage for the tab that actually kicked off the job (if
// known, threaded through as tabId from the DOWNLOAD_IDS/DOWNLOAD_LIBRARY
// message's sender.tab.id).
function broadcastProgress(payload, tabId) {
  chrome.runtime.sendMessage({ type: 'PROGRESS', ...payload }).catch(() => {});
  if (tabId != null) {
    chrome.tabs.sendMessage(tabId, { type: 'PROGRESS', ...payload }).catch(() => {});
  }
}

function sanitizeForPath(name) {
  return (name || 'untitled').replace(/[\\/:*?"<>|]/g, '_').trim().slice(0, 80) || 'untitled';
}

// Prefer Flow's own displayName (confirmed present in flow.projectInitialData,
// e.g. "Politician on dock NDIS ship") over the raw media UUID for the saved
// filename. Falls back to the UUID if no title was found for that item.
function filenameBaseFor(id, titleById) {
  const title = titleById && titleById[id];
  return title ? sanitizeForPath(title) : id;
}

function mediaDownloadUrl(id) {
  return `https://labs.google/fx/api/trpc/media.getMediaUrlRedirect?name=${encodeURIComponent(id)}`;
}

// ---- Downloading ----

async function downloadIds(ids, folderName, jobId, titleById, tabId) {
  const folder = sanitizeForPath(folderName);
  let done = 0;
  let failed = 0;
  // Bounded concurrency (same FETCH_CONCURRENCY/runWithConcurrency used by
  // zip mode, defined further below, function declarations are hoisted so
  // that's fine to reference here). This matters more than it used to:
  // plain downloads now fetch each file's real bytes first too (see "How
  // files get their extension" in the README), so a strictly sequential
  // loop here would carry that fetch latency on top of what used to be a
  // fast direct-URL handoff to Chrome's own download manager.
  await runWithConcurrency(ids, FETCH_CONCURRENCY, async (id) => {
    try {
      await fetchAndDownloadOne(id, `Google Flow Downloads/${folder}/${filenameBaseFor(id, titleById)}`);
      done++;
    } catch (e) {
      failed++;
      console.warn('[GFBD] failed to download', id, e);
    }
    broadcastProgress({ jobId, done, failed, total: ids.length }, tabId);
  });
  broadcastProgress({ jobId, done, failed, total: ids.length, finished: true }, tabId);
}

// Fetches the real bytes ourselves and hands chrome.downloads.download() a
// filename with the correct extension already attached, rather than handing
// it the redirect-issuing URL directly and hoping onDeterminingFilename's
// post-hoc extension guess is right. This is the fix for the .jfif issue:
// letting Chrome sniff/guess an extension itself (its own pre-listener
// heuristic, independent of anything onDeterminingFilename does) was
// unreliable for image/jpeg specifically. Fetching first and using the
// content-type we read ourselves, the same way zip mode already does (zip
// mode never had this bug, because it was never depending on Chrome's guess
// in the first place), removes the ambiguity entirely rather than
// continuing to fight it after the fact.
//
// Trade-off worth knowing: this costs one full fetch-into-memory per file,
// same as zip mode, rather than the previous "just hand off the URL and let
// Chrome stream it" approach. For a large video that's a real, if brief,
// memory cost. Correctness of the saved extension won for the tie-break
// here since that was the actual complaint, this can be revisited if memory
// on very large batches of big videos turns out to be a problem in
// practice.
function arrayBufferToBase64(buf) {
  let binary = '';
  const bytes = new Uint8Array(buf);
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

// Keyed by downloadId, populated the instant chrome.downloads.download()'s
// callback fires (before onDeterminingFilename runs). For data: URLs,
// Chrome's own item.filename seen inside onDeterminingFilename can be its
// generic "download" default rather than what was passed to download()'s
// filename option, that default doesn't start with "Google Flow
// Downloads/" so the old prefix check silently left it unchanged, that was
// the "downloaded as an untyped file named download" bug. Tracking the
// intended name ourselves by downloadId, rather than trusting item.filename
// at all, sidesteps that unreliability entirely.
const pendingFilenames = new Map();

async function fetchAndDownloadOne(id, filenameWithoutExt) {
  const { buf, ext } = await fetchMediaBytes(id);
  const dataUrl = `data:application/octet-stream;base64,${arrayBufferToBase64(buf)}`;
  const desired = `${filenameWithoutExt}${ext}`;
  await new Promise((resolve, reject) => {
    chrome.downloads.download(
      { url: dataUrl, filename: desired, conflictAction: 'uniquify' },
      (downloadId) => {
        if (chrome.runtime.lastError || downloadId === undefined) {
          reject(chrome.runtime.lastError || new Error('download failed to start'));
        } else {
          pendingFilenames.set(downloadId, desired);
          resolve(downloadId);
        }
      }
    );
  });
}

// ---- Zip mode ----
// Fetches every media item's actual bytes (rather than letting Chrome's
// downloads API follow the redirect on its own), bundles them into a zip
// with JSZip, and saves that one file. Runs entirely inside this service
// worker: no offscreen document needed, since we ask JSZip for a base64
// string rather than a Blob/object URL, and everything here is plain
// ArrayBuffer/string handling with no DOM dependency.
//
// Trade-off worth knowing: this holds every fetched file in memory until
// the zip is generated, and MV3 service workers are not meant for
// long-lived heavy work. Fine for a project or a manual selection. Not
// recommended for "entire library" if that's hundreds of videos -- the
// popup only offers the zip option for the first two modes for that
// reason.

async function fetchMediaBytes(id) {
  const res = await fetch(mediaDownloadUrl(id), { credentials: 'include' });
  if (!res.ok) throw new Error(`media fetch HTTP ${res.status}`);
  const buf = await res.arrayBuffer();
  const finalUrl = res.url || '';
  const ct = res.headers.get('content-type') || '';
  let ext = '.bin';
  if (/\/video\//.test(finalUrl) || ct.includes('video')) ext = '.mp4';
  else if (ct.includes('png')) ext = '.png';
  else if (ct.includes('webp')) ext = '.webp';
  else if (/\/image\//.test(finalUrl) || ct.includes('jpeg') || ct.includes('jpg')) ext = '.jpg';
  return { buf, ext };
}

const ZIP_CHUNK_SIZE = 60; // items per zip part -- keeps memory/time per zip bounded
const FETCH_CONCURRENCY = 6; // parallel media fetches per zip chunk

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Runs `worker` over `items` with at most `limit` in flight at once, rather
// than strictly one-at-a-time. The old version awaited each media fetch
// before starting the next, so total time was ~N times one round trip; this
// keeps several requests in flight simultaneously, bounded so a huge batch
// doesn't try to open hundreds of connections at once.
async function runWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function runner() {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i], i);
    }
  }
  const runners = Array.from({ length: Math.min(limit, items.length) }, runner);
  await Promise.all(runners);
  return results;
}

async function buildAndSaveOneZip(ids, filenameBase, jobId, doneSoFar, totalOverall, titleById, tabId) {
  const zip = new JSZip();
  let done = doneSoFar;
  let failed = 0;
  const usedNames = new Set();

  await runWithConcurrency(ids, FETCH_CONCURRENCY, async (id) => {
    try {
      const { buf, ext } = await fetchMediaBytes(id);
      let entryName = filenameBaseFor(id, titleById);
      let candidate = `${entryName}${ext}`;
      let n = 2;
      // usedNames is shared across concurrent workers but JS is single
      // threaded between awaits, so this check-then-add is still safe: no
      // two workers can interleave inside this synchronous block.
      while (usedNames.has(candidate)) {
        candidate = `${entryName} (${n})${ext}`;
        n++;
      }
      usedNames.add(candidate);
      zip.file(candidate, buf);
      done++;
    } catch (e) {
      failed++;
      console.warn('[GFBD] zip: failed to fetch', id, e);
    }
    broadcastProgress({ jobId, stage: 'zipping', done, failed, total: totalOverall }, tabId);
  });

  broadcastProgress({ jobId, stage: 'compressing', percent: 0, done, failed, total: totalOverall }, tabId);
  // STORE, not DEFLATE: every file going into this zip is already a
  // compressed format (jpg/png/webp/mp4). Running DEFLATE over
  // already-compressed bytes buys close to zero size reduction but still
  // costs real CPU time proportional to total bytes, that was a big chunk
  // of the "zipping 50 files takes a minute" complaint. STORE just packs
  // the bytes as-is, no compression pass.
  // generateAsync's second argument is a progress callback JSZip calls
  // repeatedly while it works (metadata.percent, 0-100), this is what makes
  // "Compressing..." into an actual moving number instead of a static
  // message with no way to tell whether it's stuck or just working.
  const base64 = await zip.generateAsync({ type: 'base64', compression: 'STORE' }, (metadata) => {
    broadcastProgress({ jobId, stage: 'compressing', percent: Math.round(metadata.percent), done, failed, total: totalOverall }, tabId);
  });
  broadcastProgress({ jobId, stage: 'saving-to-disk', done, failed, total: totalOverall }, tabId);
  const dataUrl = 'data:application/zip;base64,' + base64;
  await new Promise((resolve, reject) => {
    chrome.downloads.download(
      { url: dataUrl, filename: `Google Flow Downloads/${filenameBase}.zip`, conflictAction: 'uniquify' },
      (downloadId) => {
        if (chrome.runtime.lastError || downloadId === undefined) reject(chrome.runtime.lastError);
        else resolve(downloadId);
      }
    );
  });
  // Per-part completion, distinct from the overall-job "finished" broadcast
  // downloadIdsAsZip sends once every part is done, this is what lets a
  // multi-part batch show "part 1 of 3 saved" as each one actually lands
  // instead of going quiet until the entire batch finishes.
  broadcastProgress({ jobId, stage: 'part-saved', partLabel: filenameBase, done, failed, total: totalOverall }, tabId);
  return { done, failed };
}

// Splits large batches into multiple smaller zip files instead of one giant
// one. This is the concrete fix for the "is this stable?" question: a single
// zip covering hundreds of files means holding all of them in memory before
// anything gets written to disk, and a failure partway through loses the
// whole batch. Chunking bounds memory per zip and means a failure only costs
// one part, not the whole run.
async function downloadIdsAsZip(ids, folderName, jobId, titleById, tabId) {
  const folder = sanitizeForPath(folderName);
  const chunks = chunkArray(ids, ZIP_CHUNK_SIZE);
  let done = 0;
  let failed = 0;
  for (let i = 0; i < chunks.length; i++) {
    const base = chunks.length > 1 ? `${folder} (part ${i + 1} of ${chunks.length})` : folder;
    const result = await buildAndSaveOneZip(chunks[i], base, jobId, done, ids.length, titleById, tabId);
    done = result.done;
    failed += result.failed;
  }
  broadcastProgress({ jobId, stage: 'zipping', done, failed, total: ids.length, finished: true }, tabId);
}

// Defense-in-depth only now, not the primary mechanism. Every download this
// extension issues (plain files via fetchAndDownloadOne, zips via
// buildAndSaveOneZip) now goes out with its correct extension already
// baked into the filename before chrome.downloads.download() is ever
// called, using an extension determined from bytes fetched directly rather
// than trusting Chrome's own guess. That's the actual fix for the .jfif
// issue: Chrome's pre-listener heuristic for guessing an extension from a
// sniffed content type (independent of anything an extension does) was
// unreliable specifically for image/jpeg, landing on .jfif rather than
// .jpg, and by the time this listener used to run, that guess had already
// been baked into item.filename in a way the old code's "if it looks like
// it already has an extension, leave it alone" check mistook for
// intentional. Fetching first sidesteps that ambiguity rather than
// continuing to patch around it after the fact. This listener still exists
// for the (currently theoretical) case of item.finalUrl/item.mime pointing
// at a real http(s) URL this extension didn't already fully name, blob:
// and data: URLs (everything this extension issues now) won't match either
// branch below and fall through to suggest() unchanged, leaving the
// already-correct filename alone.
chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  if (pendingFilenames.has(item.id)) {
    const filename = pendingFilenames.get(item.id);
    pendingFilenames.delete(item.id);
    suggest({ filename });
    return;
  }
  suggest();
});

// ---- Library-wide discovery ----
// NOTE: project.searchUserProjects and flow.projectInitialData response
// shapes were not directly inspected (the browser tooling used to scope
// this blocks reading response bodies that carry cookies/query data). The
// parsers below are written defensively against the standard tRPC/superjson
// convention and log the raw payload on first use so they can be tightened
// in one pass if Flow's actual shape differs.

function trpcInputParam(obj) {
  return encodeURIComponent(JSON.stringify({ json: obj }));
}

function findFirstArrayDeep(node, path = '') {
  if (Array.isArray(node)) return node;
  if (node && typeof node === 'object') {
    for (const key of Object.keys(node)) {
      const found = findFirstArrayDeep(node[key], path + '.' + key);
      if (found) return found;
    }
  }
  return null;
}

function findValueByKeyDeep(node, targetKey) {
  if (node && typeof node === 'object') {
    if (targetKey in node) return node[targetKey];
    for (const key of Object.keys(node)) {
      const found = findValueByKeyDeep(node[key], targetKey);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

async function fetchProjectsPage(cursor) {
  const input = trpcInputParam({ pageSize: 50, toolName: 'PINHOLE', cursor: cursor || null });
  const res = await fetch(
    `https://labs.google/fx/api/trpc/project.searchUserProjects?input=${input}`,
    { credentials: 'include' }
  );
  if (!res.ok) throw new Error(`searchUserProjects HTTP ${res.status}`);
  const data = await res.json();
  if (!cursor) console.log('[GFBD] raw searchUserProjects payload (first page):', JSON.stringify(data).slice(0, 6000));
  const json = data?.result?.data?.json ?? data?.result?.data ?? data;
  const items = findFirstArrayDeep(json) || [];
  const nextCursor = findValueByKeyDeep(json, 'nextCursor') || null;
  const projects = items
    .map((it) => ({
      id: it.projectId || it.id || it.name,
      name: it.title || it.name || it.projectName || 'Untitled project',
    }))
    .filter((p) => p.id && UUID_RE.test(p.id));
  return { projects, nextCursor };
}

async function fetchAllProjects(onProgress) {
  let cursor = null;
  const all = [];
  for (let i = 0; i < 200; i++) {
    const { projects, nextCursor } = await fetchProjectsPage(cursor);
    all.push(...projects);
    if (onProgress) onProgress(all.length);
    if (!nextCursor || projects.length === 0) break;
    cursor = nextCursor;
  }
  return all;
}

async function fetchProjectMediaIds(projectId) {
  const input = trpcInputParam({ projectId });
  const res = await fetch(
    `https://labs.google/fx/api/trpc/flow.projectInitialData?input=${input}`,
    { credentials: 'include' }
  );
  if (!res.ok) throw new Error(`projectInitialData HTTP ${res.status}`);
  const data = await res.json();
  // flow.projectInitialData uses (at least) two different shapes for media
  // items, confirmed directly against two different live projects:
  //  1. Flat: some object has both "name" (the media UUID) and
  //     "displayName" (the title) as direct sibling fields.
  //  2. Workflow wrapper (what most real projects actually use, confirmed
  //     against a 427-item project): the outer object's own "name" is the
  //     *workflow's* id, not a media id at all, the real media id and title
  //     live one level down as sibling fields metadata.primaryMediaId and
  //     metadata.displayName. Blindly trusting every bare "name" match
  //     (the old behavior) meant workflow ids themselves were getting added
  //     to the download list as if they were media ids on this shape, which
  //     would just fail to resolve. Skip the flat-name match whenever the
  //     object also carries a .metadata sibling (that marks it as a
  //     workflow wrapper, its .name isn't a media id) and pull the real id
  //     from .metadata.primaryMediaId instead.
  const titleById = {};
  (function walk(node) {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node && typeof node === 'object') {
      const meta = node.metadata;
      const hasMetadata = meta && typeof meta === 'object';
      if (!hasMetadata && typeof node.name === 'string' && UUID_RE.test(node.name)) {
        if (typeof node.displayName === 'string' && node.displayName.trim()) {
          titleById[node.name] = node.displayName.trim();
        } else if (!(node.name in titleById)) {
          titleById[node.name] = null;
        }
      }
      if (hasMetadata && typeof meta.primaryMediaId === 'string' && UUID_RE.test(meta.primaryMediaId)) {
        const id = meta.primaryMediaId;
        if (typeof meta.displayName === 'string' && meta.displayName.trim()) {
          titleById[id] = meta.displayName.trim();
        } else if (!(id in titleById)) {
          titleById[id] = null;
        }
      }
      for (const k of Object.keys(node)) walk(node[k]);
    }
  })(data);
  const ids = Object.keys(titleById).filter((id) => id.toLowerCase() !== projectId.toLowerCase());
  return { ids, titleById };
}

async function downloadEntireLibrary(jobId) {
  broadcastProgress({ jobId, stage: 'listing-projects' });
  const projects = await fetchAllProjects((n) => broadcastProgress({ jobId, stage: 'listing-projects', found: n }));
  broadcastProgress({ jobId, stage: 'listing-media', totalProjects: projects.length });

  const allIds = [];
  const idToFolder = new Map();
  const titleById = {};
  for (let i = 0; i < projects.length; i++) {
    const p = projects[i];
    try {
      const { ids, titleById: projectTitles } = await fetchProjectMediaIds(p.id);
      ids.forEach((id) => {
        allIds.push(id);
        idToFolder.set(id, p.name);
        if (projectTitles[id]) titleById[id] = projectTitles[id];
      });
    } catch (e) {
      console.warn('[GFBD] failed to read project', p.id, e);
    }
    broadcastProgress({ jobId, stage: 'listing-media', projectIndex: i + 1, totalProjects: projects.length, mediaFound: allIds.length });
  }

  // Download grouped by project folder. Same bounded concurrency as
  // downloadIds, see the comment there, same reasoning applies here.
  let done = 0;
  let failed = 0;
  await runWithConcurrency(allIds, FETCH_CONCURRENCY, async (id) => {
    const folder = sanitizeForPath(idToFolder.get(id) || 'Library');
    try {
      await fetchAndDownloadOne(id, `Google Flow Downloads/${folder}/${filenameBaseFor(id, titleById)}`);
      done++;
    } catch (e) {
      failed++;
    }
    broadcastProgress({ jobId, stage: 'downloading', done, failed, total: allIds.length });
  });
  broadcastProgress({ jobId, stage: 'downloading', done, failed, total: allIds.length, finished: true });
}

// ---- Message handling ----

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'DOWNLOAD_IDS') {
    // sender.tab.id is only set when this message came from a content
    // script (the in-page toolbar), not from the popup, that's the id
    // broadcastProgress needs to be able to reach that toolbar's status
    // text via chrome.tabs.sendMessage. When the popup itself is the
    // sender, sender.tab is undefined and broadcastProgress's plain
    // chrome.runtime.sendMessage half already covers reaching it.
    const tabId = sender.tab?.id;
    if (msg.asZip) {
      downloadIdsAsZip(msg.ids, msg.folderName, msg.jobId, msg.titles, tabId);
    } else {
      downloadIds(msg.ids, msg.folderName, msg.jobId, msg.titles, tabId);
    }
    sendResponse({ ok: true, started: true });
    return false;
  }
  if (msg.type === 'DOWNLOAD_LIBRARY') {
    downloadEntireLibrary(msg.jobId);
    sendResponse({ ok: true, started: true });
    return false;
  }
  return false;
});
