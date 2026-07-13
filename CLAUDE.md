# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A single-file Tampermonkey userscript (`soundcloud-artwork-copier.user.js`) that adds artwork-copy buttons and a metadata-tagging download feature to soundcloud.com. There is no build system, package.json, bundler, linter, or test suite — it's plain vanilla JS wrapped in one IIFE, loaded directly by Tampermonkey. See `README.md` for the user-facing feature list and Japanese usage notes.

## Development workflow

There are no build/lint/test commands — this project has none. To verify a change:
1. Edit `soundcloud-artwork-copier.user.js` directly.
2. Paste the updated contents into the script in Tampermonkey's dashboard (or reload if installed from disk).
3. Test manually on soundcloud.com — a logged-in session is required for every feature.

There is no way to execute or type-check this script outside a real browser (no `node`/bundler in this repo); read the code carefully and reason through binary offsets/DOM selectors by hand when `node` isn't available in the dev environment.

## Architecture

### Two feature areas, one shared button/feedback plumbing

1. **Tile/row overlay artwork-copy button** (`insertTileButtons`/`createTileButton`) — injected next to the native Like/Follow/More (grid tiles), Like/Repost/Share/Copy Link/More (list rows, playlist track rows), or Like/Repost/Share/Copy Link/More (the track's own hero page) buttons, positioned immediately before `.sc-button-more`. `ACTION_ROW_CONFIGS` holds four distinct DOM shapes (`.playableTile__actionWrapper` for grid "Badges" view, `.soundActions .sc-button-group` for "List" view, `.trackItem .soundActions .sc-button-group` for playlist (`/sets/...`) track rows, `.listenEngagement__footer .soundActions .sc-button-group` for the hero page) since SoundCloud renders the same track differently depending on context — playlist rows in particular reuse the exact same button-group markup as "List" view rows, just wrapped in `.trackItem`/`.trackItem__image` instead of `.sound__body`/`.sound__artwork`, which is why `permalinkFromScope()` and each config's `resolveCopy` need to check multiple wrapper shapes rather than assuming one. The grid/list/playlist configs extract the artwork URL from the tile/row's own DOM (`copyArtworkFromTile`); the hero-page config instead reuses `copyArtwork()` (the api-v2-backed lookup, since there's no `.sound__body` tile/row to read artwork from there) and uses the same icon (`ICON_IDLE`) rather than the tile overlay's Font Awesome clipboard glyph.
2. **"Download file with metadata"** (`insertDownloadButtons`/`createDownloadButton`) — injected into `.moreActions__group` right after the native `.sc-button-download` button; calls `downloadFileWithMetadata()`.

Both share `attachCopyHandler()`, which drives a loading → success/failure icon state machine (`showFeedback`, `setIcon`) and pops a toast (`showToast`) with a localized failure reason on error. Each button remembers its own idle icon via `button._idleIcon` (don't let `showFeedback` hardcode one icon for all buttons — that was a real bug once).

### SoundCloud is a React SPA — everything is re-injected continuously

A single `MutationObserver` on `document.body` re-runs `insertTileButtons`/`insertDownloadButtons` on every DOM mutation, because:
- Track lists lazy-load more tiles/rows as the user scrolls.
- "More" dropdown menus are portaled into the DOM fresh each time they're opened (not nested near the tile/row that opened them).

Because dropdowns are portaled away from their trigger, `resolveTrackPermalink()` correlates a dropdown back to its owning tile/row via the trigger button's `aria-owns` attribute (which matches the dropdown's `id`), then reads the track permalink from that tile/row's artwork or title link. If no trigger/scope is found (i.e. the dropdown belongs to the track's own hero page), it falls back to `location.href`, which is correct in that case.

### Never fetch SoundCloud page HTML directly — use the api-v2 AJAX endpoints instead

`fetch(someTrackPageUrl)` gets intermittently redirected to `m.soundcloud.com` and blocked by CORS — this is SoundCloud's bot defense (DataDome) flagging script-issued HTML fetches, even for the page currently being viewed. Both track data lookup (`fetchTrackData`, via `GET api-v2.soundcloud.com/resolve?url=...`) and the download flow (`fetchDownloadFile`, via `GET api-v2.soundcloud.com/tracks/{id}/download`) go through api-v2 JSON endpoints instead, which don't trigger this.

Auth for these calls: `client_id` and `app_version` come from live globals on the current page (`window.__sc_hydration`'s `apiClient` entry, `window.__sc_version` — session-level, not per-track, so always fresh regardless of SPA navigation) via `getSessionCredentials()`. On top of that, an `Authorization: OAuth <token>` header (`authHeaders()`) is required, sourced from the non-httpOnly `oauth_token` cookie — `client_id` + cookies alone return 401.

### Artwork URL resolution and clipboard quirks

- `getHighResUrl()` swaps a track's thumbnail-size URL to `-original` for the highest resolution. It has to match **two different suffix conventions**: the web app's own rendered DOM uses `-t{width}x{height}` (e.g. `-t500x500`), but the api-v2 `/resolve` response's `artwork_url` field uses SoundCloud's older `-large` convention. Missing either pattern silently skips the upgrade and falls back to a small, often non-PNG, image.
- Chrome's Clipboard API only guarantees `image/png` for `navigator.clipboard.write()` — some artwork is served as `image/jpeg` (particularly when no `-original` variant exists), which can be rejected outright (`NotAllowedError: ... Type image/jpeg not supported on write`). `copyArtworkFromBaseUrl()` converts any non-PNG blob via `OffscreenCanvas`/`createImageBitmap` before writing. This conversion is intentionally *not* applied to the download-and-tag feature's artwork fetch (`fetchArtworkBuffer`) — that's a separate code path and doesn't have the clipboard's format restriction.

### Metadata tag writing (WAV / MP3 / FLAC)

Each format's "if already set, keep it; otherwise fill in title/artist/album/genre(/artwork)" logic is hand-rolled per-format binary parsing — there is no shared abstraction across formats because the container formats are unrelated:

- **WAV**: `parseWavChunks`/`buildInfoChunk`/`mergeWavMetadata` read/write a `LIST/INFO` RIFF chunk (`INAM`/`IART`/`IPRD`/`IGNR`) for title/artist/album/genre. Since WAV's own INFO chunk has no artwork convention, artwork *also* goes into a non-standard but ffmpeg/mutagen-recognized `id3 ` RIFF chunk holding a full ID3v2 tag, reusing the MP3 tag-building logic (`buildId3Tag` called with an empty seed buffer to get standalone tag bytes, then wrapped via `buildRiffChunk`).
- **MP3**: `parseExistingId3` (hand-rolled ID3v2 reader — only understands `TIT2`/`TALB`/`TPE1`/`TCON`/`APIC`, nothing else) + `buildId3Tag`, which delegates actual tag writing to `browser-id3-writer` (dynamically `import()`-ed from a **version-pinned** unpkg URL — the source was manually reviewed before pinning; re-review before bumping the version). Because `browser-id3-writer` always rebuilds the tag from scratch, any *other* pre-existing ID3 frames (e.g. comments) are silently dropped — this is an accepted, deliberate tradeoff, not a bug to fix.
- **FLAC**: `parseFlacBlocks`/`buildVorbisCommentBlock`/`buildPictureBlock`/`mergeFlacMetadata` — fully hand-rolled, no external library. Vorbis comment fields are little-endian while the metadata block headers and `PICTURE` block fields are big-endian (an inherited Ogg Vorbis quirk, easy to get backwards). `STREAMINFO` must stay the first block; the "last metadata block" flag must be recomputed across the whole block chain whenever blocks are inserted/removed.

`downloadFileWithMetadata()` dispatches on `detectAudioFormat()` (magic-byte + content-type sniffing); any other format (e.g. m4a) downloads unmodified.

### Passive "More button has a download" detection (`document-start` + fetch/XHR patching)

Rather than issuing an extra api-v2 request per visible track to check downloadability up front, `patchFetchForDownloadableInfo()`/`patchXhrForDownloadableInfo()` wrap both `window.fetch` and `XMLHttpRequest` to passively read the JSON that SoundCloud's own app already fetches to render track lists (stream/likes/playlists/search all go through api-v2 under the hood). **Both** need patching, not just `fetch` — e.g. the likes list (`/users/{id}/track_likes`) turned out to go through `XMLHttpRequest`, not `fetch`, discovered by adding temporary debug logging and checking the Network tab's "Type" column when the passive highlight silently never fired. `recordDownloadableInfo()` recursively scans any parsed JSON for objects carrying both `permalink_url` and `downloadable` fields — rather than hard-coding every endpoint's differently-shaped response — and records them in `downloadableByPath` keyed by URL pathname. `highlightDownloadableTriggers()` then matches each `.sc-button-more` trigger's own tile/row permalink against that map and calls `markTriggerDownloadable()`, which adds `MORE_BUTTON_HIGHLIGHT_CLASS`/`MORE_BUTTON_ICON_HIGHLIGHT_CLASS` (guarded by a one-way `trigger.dataset.scHasDownload` latch, never removed, since a trigger's tile/row doesn't change track once rendered) and, on playlist (`/sets/...`) rows specifically, also inserts a standing (non-hover) download indicator left of `.trackItem__playCount` via `insertInlinePlaylistDownloadIcon()` — playlist rows are dense enough that a hover-revealed "More" button alone wasn't considered discoverable enough. That indicator is a plain `<span>`, not a button: hovering a `.trackItem` row reveals a native SoundCloud overlay/menu over the same spot that would otherwise steal its click, so `.trackItem:hover .scArtworkCopy__inlineDownloadIcon { display: none }` just hides it for the duration instead of fighting for the click. `downloadFileWithMetadata(trackUrl)` (used only by the More-menu item now) takes a resolved track URL rather than a dropdown element — `createDownloadButton()` resolves that itself via `resolveTrackPermalink(dropdownEl)` before calling it.

This only works if the patches are installed **before** SoundCloud's own scripts start making these calls, hence `@run-at document-start`. That in turn means `document.body`/`document.head` may not exist yet when the script's top-level code runs, so all DOM-touching setup (style injection, the `MutationObserver`, initial button-insertion calls) is deferred via `whenDomReady()` (waits for `DOMContentLoaded` if `document.readyState === 'loading'`, otherwise runs immediately). The very first page load's initial track list is often embedded directly in `window.__sc_hydration` rather than fetched via an interceptable AJAX call, so that's scanned once inside the same `whenDomReady` callback as a one-time fallback; SPA navigations and lazy-loaded scrolling are covered by the live fetch/XHR patches instead.

`insertDownloadButtons()` still separately marks a track's trigger the first time its "More" dropdown is actually opened and found to contain a native `.sc-button-download` — a fallback for any track the passive scan didn't catch data for.

### Error handling / localization

Every failure path throws via `failWith(code, params)` rather than a raw string message, so the toast shown to the user (`localizeError`, keyed off `navigator.language`, English/Japanese only) stays independent from the English `err.message` still used for `console.error`. When adding a new failure case, add a `failWith('SOME_CODE', {...})` call plus a matching entry in `ERROR_MESSAGES` — don't `throw new Error('...')` directly, or it'll fall through to the generic "Something went wrong" toast.
