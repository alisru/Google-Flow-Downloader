# Google Flow internal API notes

Unofficial, reverse-engineered notes on the internal API behind Google Flow (labs.google/fx/tools/flow). Nothing here is documented by Google. It was captured by watching live network traffic and, where noted, by reading actual response bodies in a real logged-in session on 2026-07-02. Endpoints, field names, and behavior can change without notice since this is a private frontend API, not a published product. Each item below is marked confirmed (read the real request or response directly) or inferred (shape assumed from Google's standard tRPC/superjson conventions, not directly verified).

Internal codename: Flow's own API refers to the tool as "PINHOLE" in at least one endpoint parameter (toolName). Confirmed.

## Auth model

Confirmed. Every labs.google/fx/api/trpc/* endpoint is same-origin and authenticated by the normal browser session cookie for labs.google, the one already set by being logged into Google and having opened Flow. No separate API key or bearer token is needed for these. A plain fetch with credentials: 'include' from a page or extension with host permission for labs.google works.

Separately, some calls go to aisandbox-pa.googleapis.com (Google's shared "AI sandbox" backend used by several Labs products, not Flow-specific). Those carry a client API key as a URL parameter (key=AIzaSy...). This is a public, client-side restricted key of the kind Google ships in most of its web SDKs, not a secret credential. Confirmed present, not confirmed how it's scoped/restricted.

## Endpoint: media.getMediaUrlRedirect

Confirmed, fully verified against real image and video generations.

Request: GET https://labs.google/fx/api/trpc/media.getMediaUrlRedirect?name=<mediaId>

Optional parameter: &mediaUrlType=MEDIA_URL_TYPE_THUMBNAIL — returns a thumbnail-resolution URL instead of full resolution. Omitting this parameter returns full resolution.

Behavior: responds with a 302 redirect to a signed, time-limited CDN URL. Both plain browser navigation (an img src pointed at this URL) and chrome.downloads.download() follow the redirect automatically and load or save the real file.

Redirect target format: https://flow-content.google/image/<mediaId>?Expires=<unix-timestamp>&KeyName=labs-flow-prod-cdn-key&Signature=<signature>, or the same shape under /video/<mediaId> for video items. Confirmed both paths directly (one real image generation, one real video generation, same project).

The signature expires (Expires is a Unix timestamp, observed roughly 20 minutes out from generation). Re-requesting media.getMediaUrlRedirect issues a fresh signed URL, so as long as downloads go through this endpoint rather than a cached signed URL, staleness isn't a practical problem.

## Endpoint: flow.projectInitialData

Partially confirmed. Read a real response body directly for one project.

Request: GET https://labs.google/fx/api/trpc/flow.projectInitialData?input=<url-encoded JSON>

The input parameter is a URL-encoded JSON object of the shape {"json":{"projectId":"<project-uuid>"}}. This input-encoding convention (URL-encoded JSON wrapped in a "json" key) is standard tRPC-with-superjson behavior and was confirmed to work for both this endpoint and project.searchUserProjects below.

Response: a large JSON object (confirmed one real response, roughly 114KB for a project with around 60 media items) under a top-level result key. Somewhere in that structure, once per media item, confirmed a pair of fields on the same object: name (a UUID, the same identifier media.getMediaUrlRedirect expects) and displayName (a human-readable title Flow generated for that item, for example "Politician on dock NDIS ship" or "NDIS front fell off"). Confirmed by direct extraction from a real payload, across at least 10 distinct items in one project.

Not confirmed: the exact full schema (what other fields exist per item, how scenes/characters/images/videos are structurally distinguished within the payload, whether there's a "type" field, pagination if a project has very many items). The extension currently walks the entire object tree looking for any {name: <uuid>, displayName: <string>} pair rather than assuming a specific path into the JSON, specifically to avoid depending on structure that hasn't been directly verified.

## Endpoint: project.searchUserProjects

Inferred, not confirmed. Observed in network traffic; the response body itself was not read (tooling used for this research blocks reading response bodies that carry cookies or query-string-like data, and this endpoint's response wasn't accessible another way this session).

Request: GET https://labs.google/fx/api/trpc/project.searchUserProjects?input=<url-encoded JSON>

Observed real input parameter from live traffic: {"json":{"pageSize":20,"toolName":"PINHOLE","cursor":null}}. Confirmed this exact shape was sent by Flow's own frontend when loading the project list page.

Assumed (standard tRPC infinite-query convention, not verified): response contains an array of project entries and a nextCursor value to page with, cursor: null on the first page. Each project entry is assumed to carry an id (or similarly-named UUID field) and a title/name field, mirroring the name/displayName pattern confirmed above for media items.

This is the one piece of the reverse-engineered API still resting on inference rather than direct verification. If something built against it doesn't line up (wrong project count, wrong names), the fix is to log one raw response body from this endpoint and adjust the parser to match, the same way the media-item shape got nailed down for flow.projectInitialData above.

## Other endpoints, since actually checked

These were originally just seen in network traffic and not investigated. Follow-up calls confirmed what several of them actually return.

/fx/api/auth/session — GET, confirmed. Returns the logged-in user's name, email, and profile image, plus a live Google OAuth access_token good until the value in its expires field. This is a genuine credential, not a session ID. Never log, paste, or commit the response of this endpoint anywhere; treat it the same as a password.

/fx/api/trpc/videoFx.getFlowAppConfig — GET, confirmed. Returns Flow's own app configuration: a changeLogId, and site content like in-app promotional banners (for example one currently advertising "Gemini Omni Flash"). Purely cosmetic/config data, nothing sensitive.

/fx/api/trpc/videoFx.getUserSettings — GET, confirmed. Returns the user's own Flow preferences: last-used video model (for example veo_3_0_t2v_fast_portrait), last acknowledged change-log entry, whether edit history is visible, which onboarding flows they've completed, and a couple of UI toggle states (agent mode, chat panel open).

/fx/api/trpc/general.fetchUserLocale — GET, confirmed. Returns just a language code (for example "en").

/fx/api/trpc/general.fetchUserPreferences — GET, confirmed. Returns two booleans: enableHistory and enableProductImprovement.

/fx/api/trpc/general.fetchToolAvailability — GET, confirmed to respond, takes a tool name (e.g. PINHOLE) and returns an availabilityState field for that tool. Full set of possible states not confirmed.

/fx/api/trpc/general.fetchUserAcknowledgement — GET, not re-checked this pass, presumed ToS/acknowledgement state per the parameter it takes (acknowledgementVersion or toolName).

/fx/api/trpc/general.submitBatchLog — POST, analytics/telemetry. Not called deliberately, since it exists to submit data rather than fetch it and firing it would just inject fake analytics events into Google's own logging.

aisandbox-pa.googleapis.com endpoints (credits, flow/likeness:checkEligibility, flowAppletAgent/applets, flowCreationAgent/sessions, and the two batch/recommendation POST endpoints) — confirmed these reject the API-key-plus-cookie approach that works for labs.google's own trpc endpoints. Calling credits and likeness:checkEligibility directly returned 401 UNAUTHENTICATED with "API keys are not supported by this API. Expected OAuth2 access token." So Flow's own frontend must be attaching the access_token from /fx/api/auth/session as an Authorization: Bearer header when it calls these, not just relying on cookies. That makes this whole family of endpoints a materially bigger lift to use from an extension (it would mean the extension handling a live OAuth token itself), and out of scope for anything built here. None of the remaining ones in this group (checkAppAvailability, fetchUserRecommendations, batchLogFrontendEvents) were called, same reasoning applies to them by association.

## Practical implications for the extension

The Google Flow Bulk Downloader extension in this same folder only relies on the two fully-or-partially-confirmed endpoints (media.getMediaUrlRedirect, flow.projectInitialData) for its per-project and selection modes. Only its "entire library" mode touches the inferred project.searchUserProjects endpoint, which is why that's the one mode flagged as having a soft spot in the extension's own README.
