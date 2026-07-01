# Google Flow Bulk Downloader

A Chrome extension (Manifest V3) that bulk-downloads images and videos generated in Google Flow (labs.google/fx/tools/flow). Three modes: current project, a manual selection, or your entire library.

## How it works

Flow renders every thumbnail as an `<img>` whose source points at Flow's own redirect endpoint, `media.getMediaUrlRedirect?name=<mediaId>`, which 302s to a signed, expiring CDN URL under `flow-content.google`. The extension reads media IDs straight out of the page (or, for library mode, out of Flow's project list and per-project data endpoints), then hands each ID to `chrome.downloads.download()` pointed at that same redirect endpoint. Chrome resolves the redirect live and saves the file, so there's no stale-signed-URL problem even on a large batch.

Files land under a `Google Flow Downloads` folder in your normal Chrome downloads location, organized into one subfolder per project.

## Installing it (unpacked)

Open Chrome and go to chrome://extensions. Turn on Developer mode, top right. Click "Load unpacked" and select this folder. The extension icon will appear in your toolbar.

## Using it

Current project: open a Flow project (a URL like labs.google/fx/tools/flow/project/<id>), click the extension icon, click "Download current project (all)". It auto-scrolls the media grid to load everything Flow hasn't rendered yet, then downloads all of it.

Selected items: click "Enable selection mode", then click the checkboxes that appear on each thumbnail in the page itself. Come back to the popup and click "Download selected".

In-page toolbar: on any open project, four buttons now sit in Flow's own top bar next to "Add Media": Select, Select all, Download, and to .zip. Select toggles the same checkbox mode as the popup. Select all auto-scrolls the whole project and selects everything it finds. Download and to .zip act on whatever is selected, or on the whole project if nothing is selected. This is the fastest path for "grab everything in this project," no popup needed.

Zip option: tick "Download as one .zip instead of separate files" in the popup (or use "to .zip" in the in-page toolbar), and the extension fetches every file's actual bytes, bundles them with the bundled JSZip library, and saves a .zip instead of many separate downloads. This is not offered for "entire library" in the popup, since that mode can mean fetching hundreds of large video files into memory before a single zip can be written.

Zip stability: to keep any one zip job bounded, batches larger than 60 items are automatically split into multiple zip parts (folder (part 1 of 3).zip, and so on) rather than built as one giant zip. This bounds memory per zip and means a failure partway through only costs one part, not the whole batch. For a modest set of images this is very stable; for many large videos in one go, expect it to take a while and produce several zip parts rather than one.

Entire library: click "Download entire library" from any Flow tab. It pages through every project you own, reads each project's media, then downloads all of it.

## File naming

Downloaded files and zip entries are named using Flow's own displayName for each item (for example "Politician on dock NDIS ship.jpg") instead of the raw media ID. This was confirmed directly by reading a live project's flow.projectInitialData response: every media item is an object with a name field (the UUID used everywhere else in the app) and a displayName field (the human-readable title Flow itself generates). If an item has no displayName for some reason, its filename falls back to the raw ID rather than failing.

This same discovery also resolved the earlier "we don't know the exact response shape" caveat that used to apply to library mode: flow.projectInitialData's media-item shape is now confirmed (name plus displayName pair), not just inferred by convention. The one endpoint still scoped by observation rather than by reading its body is project.searchUserProjects (used to enumerate all your projects in library mode). If the "entire library" project count looks off, open the extension's service worker console (chrome://extensions, then "service worker" link under this extension) and send along what it logged for the first page, that is the one spot left to tighten if needed.

## Files

manifest.json, the extension manifest.
content.js and content.css, run inside the Flow page: read the media grid, auto-scroll, draw selection checkboxes, inject the in-page toolbar, and look up real item names.
background.js, service worker: owns the download and zip queues (so they survive the popup closing), does the library-wide project/media discovery, and resolves filenames.
popup.html and popup.js, the toolbar popup UI.
vendor/jszip.min.js, the bundled zip library used for the "to .zip" option.
