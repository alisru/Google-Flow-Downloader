// Google Flow Bulk Downloader - background service worker
// Owns the actual download queue so a batch keeps running even if the
// popup closes. Also owns the two library-wide discovery calls
// (project.searchUserProjects, flow.projectInitialData) since those need
// to run against projects that aren't open in a tab.

importScripts('vendor/jszip.min.js');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STAGGER_MS = 150; // delay between download() calls to be polite to the API

let progressListeners = new Set();

function broadcastProgress(payload) {
  chrome.runtime.sendMessage({ type: 'PROGRESS', ...payload }).catch(() => {});
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

async function downloadIds(ids, folderName, jobId, titleById) {
  const folder = sanitizeForPath(folderName);
  let done = 0;
  let failed = 0;
  for (const id of ids) {
    try {
      await new Promise((resolve, reject) => {
        chrome.downloads.download(
          {
            url: mediaDownloadUrl(id),
            filename: `Google Flow Downloads/${folder}/${filenameBaseFor(id, titleById)}`,
            conflictAction: 'uniquify',
          },
          (downloadId) => {
            if (chrome.runtime.lastError || downloadId === undefined) {
              reject(chrome.runtime.lastError || new Error('download failed to start'));
            } else {
              resolve(downloadId);
            }
          }
        );
      });
      done++;
    } catch (e) {
      failed++;
      console.warn('[GFBD] failed to download', id, e);
    }
    broadcastProgress({ jobId, done, failed, total: ids.length });
    await new Promise((r) => setTimeout(r, STAGGER_MS));
  }
  broadcastProgress({ jobId, done, failed, total: ids.length, finished: true });
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

async function buildAndSaveOneZip(ids, filenameBase, jobId, doneSoFar, totalOverall, titleById) {
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
    broadcastProgress({ jobId, stage: 'zipping', done, failed, total: totalOverall });
  });

  broadcastProgress({ jobId, stage: 'compressing', percent: 0, done, failed, total: totalOverall });
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
    broadcastProgress({ jobId, stage: 'compressing', percent: Math.round(metadata.percent), done, failed, total: totalOverall });
  });
  broadcastProgress({ jobId, stage: 'saving-to-disk', done, failed, total: totalOverall });
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
  broadcastProgress({ jobId, stage: 'part-saved', partLabel: filenameBase, done, failed, total: totalOverall });
  return { done, failed };
}

// Splits large batches into multiple smaller zip files instead of one giant
// one. This is the concrete fix for the "is this stable?" question: a single
// zip covering hundreds of files means holding all of them in memory before
// anything gets written to disk, and a failure partway through loses the
// whole batch. Chunking bounds memory per zip and means a failure only costs
// one part, not the whole run.
async function downloadIdsAsZip(ids, folderName, jobId, titleById) {
  const folder = sanitizeForPath(folderName);
  const chunks = chunkArray(ids, ZIP_CHUNK_SIZE);
  let done = 0;
  let failed = 0;
  for (let i = 0; i < chunks.length; i++) {
    const base = chunks.length > 1 ? `${folder} (part ${i + 1} of ${chunks.length})` : folder;
    const result = await buildAndSaveOneZip(chunks[i], base, jobId, done, ids.length, titleById);
    done = result.done;
    failed += result.failed;
  }
  broadcastProgress({ jobId, stage: 'zipping', done, failed, total: ids.length, finished: true });
}

// Fix the saved file extension once we know the real content type / final
// redirect target (…/image/… or …/video/…), since we can't know that up
// front when we only have a media ID.
chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  if (!item.filename || !item.filename.startsWith('Google Flow Downloads/')) {
    suggest();
    return;
  }
  let ext = '';
  const url = item.finalUrl || item.url || '';
  if (/\/video\//.test(url)) ext = '.mp4';
  else if (/\/image\//.test(url)) ext = '.jpg';
  else if (item.mime) {
    if (item.mime.includes('video')) ext = '.mp4';
    else if (item.mime.includes('png')) ext = '.png';
    else if (item.mime.includes('jpeg') || item.mime.includes('jpg')) ext = '.jpg';
    else if (item.mime.includes('webp')) ext = '.webp';
  }
  if (!ext) {
    // Couldn't determine anything ourselves, leave whatever Chrome already
    // suggested rather than guessing blind.
    suggest();
    return;
  }
  // Unconditionally strip whatever extension-looking suffix is already on
  // item.filename and replace it with what we just determined, rather than
  // the old "if it already looks like it has one, leave it alone" check.
  // That check was the actual .jfif bug: our download URL
  // (media.getMediaUrlRedirect?name=<uuid>) has no file extension of its
  // own for Chrome to go on, so Chrome's own pre-listener heuristic sniffs
  // the content type and guesses an extension before this listener even
  // runs, for image/jpeg it sometimes lands on .jfif rather than .jpg. That
  // Chrome-guessed .jfif matched the old "already has an extension, skip
  // it" check, so it was never getting corrected to the .jpg we actually
  // determine from the real finalUrl/mime here. Always recomputing and
  // overwriting fixes that.
  const withoutExt = item.filename.replace(/\.[a-z0-9]{2,5}$/i, '');
  suggest({ filename: withoutExt + ext });
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

  // Download grouped by project folder.
  let done = 0;
  let failed = 0;
  for (const id of allIds) {
    const folder = sanitizeForPath(idToFolder.get(id) || 'Library');
    try {
      await new Promise((resolve, reject) => {
        chrome.downloads.download(
          { url: mediaDownloadUrl(id), filename: `Google Flow Downloads/${folder}/${filenameBaseFor(id, titleById)}`, conflictAction: 'uniquify' },
          (downloadId) => {
            if (chrome.runtime.lastError || downloadId === undefined) reject(chrome.runtime.lastError);
            else resolve(downloadId);
          }
        );
      });
      done++;
    } catch (e) {
      failed++;
    }
    broadcastProgress({ jobId, stage: 'downloading', done, failed, total: allIds.length });
    await new Promise((r) => setTimeout(r, STAGGER_MS));
  }
  broadcastProgress({ jobId, stage: 'downloading', done, failed, total: allIds.length, finished: true });
}

// ---- Message handling ----

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'DOWNLOAD_IDS') {
    if (msg.asZip) {
      downloadIdsAsZip(msg.ids, msg.folderName, msg.jobId, msg.titles);
    } else {
      downloadIds(msg.ids, msg.folderName, msg.jobId, msg.titles);
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
