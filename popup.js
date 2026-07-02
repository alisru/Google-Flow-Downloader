const statusEl = document.getElementById('status');
const btnCurrentProject = document.getElementById('btnCurrentProject');
const btnToggleSelect = document.getElementById('btnToggleSelect');
const btnDownloadSelected = document.getElementById('btnDownloadSelected');
const btnLibrary = document.getElementById('btnLibrary');
const chkZip = document.getElementById('chkZip');

let selectionModeOn = false;
let activeTabId = null;

function setStatus(text) {
  statusEl.textContent = text;
}

async function getActiveFlowTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url || !tab.url.includes('labs.google/fx/tools/flow')) return null;
  return tab;
}

async function init() {
  const tab = await getActiveFlowTab();
  if (!tab) {
    setStatus('Open a Google Flow project tab to get started. The "entire library" download works from any Flow tab.');
    btnCurrentProject.disabled = true;
    btnToggleSelect.disabled = true;
    return;
  }
  activeTabId = tab.id;
  try {
    const res = await chrome.tabs.sendMessage(tab.id, { type: 'PING' });
    if (res?.projectId) {
      setStatus(`Ready. Current project: ${res.projectName || res.projectId}`);
    } else {
      setStatus('Open a specific project (not the project list) to use per-project downloads.');
      btnCurrentProject.disabled = true;
      btnToggleSelect.disabled = true;
    }
  } catch (e) {
    setStatus('Could not reach the page. Try reloading the Flow tab.');
  }
}

btnCurrentProject.addEventListener('click', async () => {
  if (!activeTabId) return;
  setStatus('Scrolling through project media, this can take a moment for large projects...');
  const res = await chrome.tabs.sendMessage(activeTabId, { type: 'GET_ALL_MEDIA_IDS' });
  if (!res?.ids?.length) {
    setStatus('No media found on this page.');
    return;
  }
  const jobId = 'current-' + Date.now();
  setStatus(`Found ${res.ids.length} items. Starting ${chkZip.checked ? 'zip build' : 'download'}...`);
  chrome.runtime.sendMessage({ type: 'DOWNLOAD_IDS', ids: res.ids, titles: res.titles, folderName: res.projectName, jobId, asZip: chkZip.checked });
});

btnToggleSelect.addEventListener('click', async () => {
  if (!activeTabId) return;
  selectionModeOn = !selectionModeOn;
  await chrome.tabs.sendMessage(activeTabId, { type: selectionModeOn ? 'ENABLE_SELECTION_MODE' : 'DISABLE_SELECTION_MODE' });
  btnToggleSelect.textContent = selectionModeOn ? 'Disable selection mode' : 'Enable selection mode';
  btnDownloadSelected.disabled = !selectionModeOn;
  setStatus(selectionModeOn ? 'Click thumbnails in the page to select them, then come back here.' : 'Selection mode off.');
});

btnDownloadSelected.addEventListener('click', async () => {
  if (!activeTabId) return;
  const res = await chrome.tabs.sendMessage(activeTabId, { type: 'GET_SELECTED_MEDIA_IDS' });
  if (!res?.ids?.length) {
    setStatus('No items selected yet.');
    return;
  }
  const jobId = 'selected-' + Date.now();
  setStatus(`${chkZip.checked ? 'Zipping' : 'Downloading'} ${res.ids.length} selected items...`);
  chrome.runtime.sendMessage({ type: 'DOWNLOAD_IDS', ids: res.ids, titles: res.titles, folderName: res.projectName, jobId, asZip: chkZip.checked });
});

btnLibrary.addEventListener('click', async () => {
  const confirmed = confirm('This downloads every media item across every project in your Flow account. Continue?');
  if (!confirmed) return;
  const jobId = 'library-' + Date.now();
  setStatus('Listing your projects...');
  chrome.runtime.sendMessage({ type: 'DOWNLOAD_LIBRARY', jobId });
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type !== 'PROGRESS') return;
  if (msg.stage === 'listing-projects') {
    setStatus(`Listing projects... found ${msg.found || 0} so far.`);
  } else if (msg.stage === 'listing-media') {
    setStatus(`Reading media from project ${msg.projectIndex || 0}/${msg.totalProjects || '?'}. ${msg.mediaFound || 0} items found so far.`);
  } else if (msg.stage === 'zipping') {
    const finishedNote = msg.finished ? ' All zip parts saved.' : '';
    setStatus(`Fetching ${msg.done}/${msg.total} for zip (${msg.failed} failed).${finishedNote}`);
  } else if (msg.stage === 'compressing') {
    setStatus(`Compressing into a zip... ${msg.percent ?? 0}%`);
  } else if (msg.stage === 'saving-to-disk') {
    setStatus('Zip ready, saving to disk...');
  } else if (msg.stage === 'part-saved') {
    setStatus(`Saved "${msg.partLabel}.zip" (${msg.done}/${msg.total} files so far).`);
  } else if (msg.stage === 'downloading' || msg.done !== undefined) {
    const finishedNote = msg.finished ? ' Done.' : '';
    setStatus(`Downloading ${msg.done}/${msg.total} (${msg.failed} failed).${finishedNote}`);
  }
});

init();
