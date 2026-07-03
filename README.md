# Google Flow Bulk Downloader

A Chrome extension (Manifest V3) that bulk-downloads images and videos generated in Google Flow (labs.google/fx/tools/flow). Three modes: current project, a manual selection, or your entire library.

## How it works

Flow renders every thumbnail as an `<img>` whose source points at Flow's own redirect endpoint, `media.getMediaUrlRedirect?name=<mediaId>`, which 302s to a signed, expiring CDN URL under `flow-content.google`. The extension reads media IDs straight out of the page (or, for library mode, out of Flow's project list and per-project data endpoints), fetches each file's actual bytes itself (see "How files get their extension" below for why), and saves it via `chrome.downloads.download()` pointed at a local data URL with the correct filename, including extension, already attached.

## How files get their extension

Every download this extension issues, plain files and zip entries alike, fetches the real bytes first and reads the true `Content-Type` off that response, rather than handing Chrome a bare URL and trusting Chrome's own guess at what to save it as.

This wasn't the original design, and got here in two steps. Plain downloads used to hand `chrome.downloads.download()` the redirect-issuing URL directly and let Chrome resolve everything itself, faster, since Chrome could stream the file straight to disk without it ever passing through the extension. That fell over on jpeg specifically: the `media.getMediaUrlRedirect?name=<mediaId>` URL has no file extension of its own for Chrome to go on, and Chrome's own pre-extension heuristic for guessing one from a sniffed `image/jpeg` content type isn't reliable, it would sometimes land on `.jfif` instead of `.jpg`.

Fetching the bytes first and building a data URL removes that guessing entirely, but introduced a second, sharper bug on the way: `chrome.downloads.onDeterminingFilename`'s `item.filename`, for a `data:` URL specifically, can be Chrome's own generic `"download"` default rather than the filename actually passed to `download()`'s `filename` option. Trusting `item.filename` there (checking whether it already looked like one of ours and only touching it if so) meant that default silently went through untouched, once, this shipped as "downloads its own file with no name or type at all." The fix: `chrome.downloads.download()`'s callback hands back a `downloadId` synchronously, before `onDeterminingFilename` ever fires, so the intended filename is now stored in a `Map` keyed by that `downloadId` the moment it's known, and `onDeterminingFilename` looks itself up by `item.id` in that map rather than trusting anything Chrome hands it in `item.filename`.

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

## Speed, and why zipping is slower than plain downloads

Plain (non-zip) downloads and zip downloads both fetch every file's actual bytes into the extension now (see "How files get their extension" above for why plain downloads changed to work this way), so the gap between them is smaller than it used to be, but zip mode is still the slower of the two.

Plain downloads fetch and save one file at a time, staggered 150ms apart between files so as not to fire everything at once, each one lands on disk as soon as its own fetch finishes.

Zip mode has to wait for every file in a batch (or a batch's worth, once chunked) to finish fetching before the archive itself can be built and written, plus the time to actually build it. That's real, unavoidable extra latency zip mode carries that plain downloads don't: nothing gets saved until the whole batch, and then the compression step, are both done.

Two things speed up the fetching itself as much as currently seems reasonable without more testing:

Concurrent fetches: files are fetched 6 at a time rather than one at a time. This is a deliberate middle ground, not a measured optimum, going higher would likely finish faster still, but there's no confirmed data yet on whether Google's endpoint rate-limits a burst of simultaneous requests to media.getMediaUrlRedirect, and 6 was chosen as a reasonably safe default rather than something benchmarked against an actual limit. If this turns out to be too conservative (or too aggressive) in practice, this is the number to revisit.

No compression: the zip is built with STORE (bytes packed as-is) instead of DEFLATE (actual compression). Every file going into one of these zips is already a compressed format, jpg, png, webp, or mp4, and running DEFLATE over already-compressed bytes buys close to zero extra size reduction while still costing real CPU time proportional to total bytes. Skipping that pass was one of the two biggest wins for zip speed, alongside the concurrent fetches above.

Realistic expectation: zipping a batch of images should now be well under the roughly one-minute-for-50-files figure this was measured at before these two changes, but zipping will still always be slower than plain downloads of the same batch, because it has to pull every byte through the extension first. For very large videos in particular, expect zip mode to take a while regardless, that's inherent to fetching full video files into memory rather than a fixable inefficiency.

Zip stability (chunking into multiple parts once a batch is larger than 60 items) is unrelated to this speed discussion, see the paragraph above about that. It bounds memory and blast radius of a failure, it isn't a speed optimization.

## File naming

Downloaded files and zip entries are named using Flow's own displayName for each item (for example "Politician on dock NDIS ship.jpg") instead of the raw media ID. This was confirmed directly by reading a live project's flow.projectInitialData response: every media item is an object with a name field (the UUID used everywhere else in the app) and a displayName field (the human-readable title Flow itself generates). If an item has no displayName for some reason, its filename falls back to the raw ID rather than failing.

This same discovery also resolved the earlier "we don't know the exact response shape" caveat that used to apply to library mode: flow.projectInitialData's media-item shape is now confirmed (name plus displayName pair), not just inferred by convention. The one endpoint still scoped by observation rather than by reading its body is project.searchUserProjects (used to enumerate all your projects in library mode). If the "entire library" project count looks off, open the extension's service worker console (chrome://extensions, then "service worker" link under this extension) and send along what it logged for the first page, that is the one spot left to tighten if needed.

## Files

manifest.json, the extension manifest.
content.js and content.css, run inside the Flow page: read the media grid, auto-scroll, draw selection checkboxes, inject the in-page toolbar, and look up real item names.
background.js, service worker: owns the download and zip queues (so they survive the popup closing), does the library-wide project/media discovery, and resolves filenames.
popup.html and popup.js, the toolbar popup UI.
vendor/jszip.min.js, the bundled zip library used for the "to .zip" option.
