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

### Three feature areas, one shared button/feedback plumbing

1. **Header artwork-copy button** (`insertButton`/`createButton`) — injected into `.header__right`, calls `copyArtwork()`.
2. **Tile/row overlay artwork-copy button** (`insertTileButtons`/`createTileButton`) — injected next to the native Like/Follow/More (grid tiles) or Like/Repost/Share/Copy Link/More (list rows) buttons, positioned immediately before `.sc-button-more`. `ACTION_ROW_CONFIGS` holds the two distinct DOM shapes (`.playableTile__actionWrapper` for grid "Badges" view vs `.soundActions .sc-button-group` for "List" view) since SoundCloud renders the same track differently depending on view mode.
3. **"Download file with metadata"** (`insertDownloadButtons`/`createDownloadButton`) — injected into `.moreActions__group` right after the native `.sc-button-download` button; calls `downloadFileWithMetadata()`.

All three share `attachCopyHandler()`, which drives a loading → success/failure icon state machine (`showFeedback`, `setIcon`) and pops a toast (`showToast`) with a localized failure reason on error. Each button remembers its own idle icon via `button._idleIcon` (don't let `showFeedback` hardcode one icon for all buttons — that was a real bug once).

### SoundCloud is a React SPA — everything is re-injected continuously

A single `MutationObserver` on `document.body` re-runs `insertButton`/`insertTileButtons`/`insertDownloadButtons` on every DOM mutation, because:
- React re-renders `header__middle` after initial load and can wipe out the header button.
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

### Error handling / localization

Every failure path throws via `failWith(code, params)` rather than a raw string message, so the toast shown to the user (`localizeError`, keyed off `navigator.language`, English/Japanese only) stays independent from the English `err.message` still used for `console.error`. When adding a new failure case, add a `failWith('SOME_CODE', {...})` call plus a matching entry in `ERROR_MESSAGES` — don't `throw new Error('...')` directly, or it'll fall through to the generic "Something went wrong" toast.
