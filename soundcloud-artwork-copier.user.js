// ==UserScript==
// @name         SoundCloud Menu Extension
// @namespace    https://github.com/hitsub/sc-jacket-extensions
// @version      0.3.0
// @description  Copy track artwork from track tiles/rows/the hero page, or the More menu, and download files with missing title/artist/album/artwork tags filled in automatically (WAV/MP3/FLAC)
// @author       hitsub
// @match        *://soundcloud.com/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  const downloadableByPath = new Map();

  function permalinkPath(url) {
    try {
      return new URL(url, location.origin).pathname.replace(/\/$/, '');
    } catch {
      return null;
    }
  }

  function recordDownloadableInfo(value, depth = 0) {
    // Generic recursive scan rather than hard-coding every api-v2 response
    // shape (stream/likes/playlist/search collections all nest track
    // objects differently) — any object with both fields is a track.
    if (!value || typeof value !== 'object' || depth > 6) return;
    if (Array.isArray(value)) {
      value.forEach((item) => recordDownloadableInfo(item, depth + 1));
      return;
    }
    if (typeof value.permalink_url === 'string' && typeof value.downloadable === 'boolean') {
      const path = permalinkPath(value.permalink_url);
      if (path) downloadableByPath.set(path, value.downloadable);
    }
    for (const key of Object.keys(value)) {
      recordDownloadableInfo(value[key], depth + 1);
    }
  }

  function patchFetchForDownloadableInfo() {
    // Passively read the JSON SoundCloud's own app already fetches to
    // render track lists (stream/likes/playlists/search all go through
    // api-v2), rather than issuing our own extra requests per visible
    // track. @run-at document-start so this is installed before the page's
    // own scripts start making these calls.
    const nativeFetch = window.fetch;
    if (typeof nativeFetch !== 'function') return;
    window.fetch = function (...args) {
      const result = nativeFetch.apply(this, args);
      const urlArg = args[0];
      const url = typeof urlArg === 'string' ? urlArg : urlArg?.url;
      if (url && url.includes('api-v2.soundcloud.com')) {
        result
          .then((response) => response.clone().json())
          .then((json) => {
            recordDownloadableInfo(json);
            highlightDownloadableTriggers();
          })
          .catch(() => {});
      }
      return result;
    };
  }
  patchFetchForDownloadableInfo();

  function patchXhrForDownloadableInfo() {
    // SoundCloud's own list-loading requests (e.g. track_likes) turn out to
    // go through XMLHttpRequest rather than fetch, so that needs the same
    // passive-read treatment.
    const nativeOpen = XMLHttpRequest.prototype.open;
    const nativeSend = XMLHttpRequest.prototype.send;
    if (typeof nativeOpen !== 'function' || typeof nativeSend !== 'function') return;

    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      this._scExtUrl = url;
      return nativeOpen.call(this, method, url, ...rest);
    };

    XMLHttpRequest.prototype.send = function (...args) {
      if (typeof this._scExtUrl === 'string' && this._scExtUrl.includes('api-v2.soundcloud.com')) {
        this.addEventListener('load', () => {
          try {
            recordDownloadableInfo(JSON.parse(this.responseText));
            highlightDownloadableTriggers();
          } catch {
            // Not JSON, or not a shape we care about — ignore.
          }
        });
      }
      return nativeSend.apply(this, args);
    };
  }
  patchXhrForDownloadableInfo();

  function whenDomReady(callback) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', callback, { once: true });
    } else {
      callback();
    }
  }

  const TILE_BUTTON_CLASS = 'scArtworkCopy__tileButton';
  const DOWNLOAD_BUTTON_CLASS = 'scArtworkCopy__downloadButton';
  const MORE_BUTTON_HIGHLIGHT_CLASS = 'scArtworkCopy__moreButton--hasDownload';
  // The grid ("Badges") tile's More button sits directly on top of the
  // artwork image (like the tile copy button), so it keeps the older
  // icon-color treatment instead of the outline used everywhere else.
  const MORE_BUTTON_ICON_HIGHLIGHT_CLASS = 'scArtworkCopy__moreButton--hasDownloadIcon';
  const INLINE_DOWNLOAD_ICON_CLASS = 'scArtworkCopy__inlineDownloadIcon';
  const TOAST_CONTAINER_ID = 'scArtworkCopy__toastContainer';
  const TOAST_CLASS = 'scArtworkCopy__toast';
  const TOAST_VISIBLE_CLASS = 'scArtworkCopy__toast--visible';
  const TOAST_DURATION_MS = 4000;
  const STATE_SUCCESS_CLASS = 'scArtworkCopy--success';
  const STATE_FAILURE_CLASS = 'scArtworkCopy--failure';
  const STATE_LOADING_CLASS = 'scArtworkCopy--loading';
  const FEEDBACK_DURATION_MS = 1500;

  const ICON_IDLE = '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path fill="currentColor" d="M9 2a1 1 0 0 0-1 1v1H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-2V3a1 1 0 0 0-1-1H9Zm0 2h6v2H9V4ZM6 6h2v2h8V6h2v14H6V6Z"/></svg>';
  const ICON_SUCCESS = '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path fill="currentColor" d="M9 16.17 4.83 12l-1.42 1.41L9 19l12-12-1.41-1.41z"/></svg>';
  const ICON_FAILURE = '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path fill="currentColor" d="M18.3 5.71 12 12.01l-6.3-6.3-1.41 1.41L10.59 13.42l-6.3 6.3 1.41 1.41 6.3-6.3 6.3 6.3 1.41-1.41-6.3-6.3 6.3-6.3z"/></svg>';
  const ICON_LOADING = '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path fill="currentColor" d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46A7.93 7.93 0 0 0 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74A7.93 7.93 0 0 0 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z"/></svg>';
  const ICON_DOWNLOAD = '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path fill="currentColor" d="M19 9h-4V3H9v6H5l7 7 7-7ZM5 18v2h14v-2H5Z"/></svg>';
  // Font Awesome Free 6.7.2 "clipboard" (solid) — CC BY 4.0.
  const ICON_CLIPBOARD_SOLID = '<svg viewBox="0 0 384 512" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path fill="currentColor" d="M192 0c-41.8 0-77.4 26.7-90.5 64L64 64C28.7 64 0 92.7 0 128L0 448c0 35.3 28.7 64 64 64l256 0c35.3 0 64-28.7 64-64l0-320c0-35.3-28.7-64-64-64l-37.5 0C269.4 26.7 233.8 0 192 0zm0 64a32 32 0 1 1 0 64 32 32 0 1 1 0-64zM112 192l160 0c8.8 0 16 7.2 16 16s-7.2 16-16 16l-160 0c-8.8 0-16-7.2-16-16s7.2-16 16-16z"/></svg>';

  const style = document.createElement('style');
  style.textContent = `
    .${TILE_BUTTON_CLASS},
    .${TILE_BUTTON_CLASS} svg,
    .${TILE_BUTTON_CLASS} svg * {
      color: #ff5500 !important;
      fill: #ff5500 !important;
    }
    .${DOWNLOAD_BUTTON_CLASS},
    .${DOWNLOAD_BUTTON_CLASS} svg,
    .${DOWNLOAD_BUTTON_CLASS} svg *,
    .${DOWNLOAD_BUTTON_CLASS} .sc-button-label {
      color: #ff5500 !important;
      fill: #ff5500 !important;
    }
    .${MORE_BUTTON_HIGHLIGHT_CLASS} {
      /* Negative offset draws the outline inside the button's own box
         instead of protruding outward — an outward box-shadow/outline got
         clipped unevenly by the list row's tightly packed button group. */
      outline: 2px solid #ff5500 !important;
      outline-offset: -2px;
    }
    .${MORE_BUTTON_ICON_HIGHLIGHT_CLASS},
    .${MORE_BUTTON_ICON_HIGHLIGHT_CLASS} svg,
    .${MORE_BUTTON_ICON_HIGHLIGHT_CLASS} svg * {
      color: #ff5500 !important;
      fill: #ff5500 !important;
    }
    /* Our forced color/fill above blocks the native buttons' own :hover
       fade, so re-add the same fade explicitly to stay consistent with
       sibling buttons (Like/Follow/More etc.) on hover. */
    .${TILE_BUTTON_CLASS}:hover,
    .${DOWNLOAD_BUTTON_CLASS}:hover,
    .${MORE_BUTTON_ICON_HIGHLIGHT_CLASS}:hover {
      opacity: 0.7 !important;
    }
    .${INLINE_DOWNLOAD_ICON_CLASS} {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 20px;
      height: 20px;
      margin-right: 4px;
      color: #ff5500;
      vertical-align: middle;
    }
    .${INLINE_DOWNLOAD_ICON_CLASS} svg {
      width: 16px;
      height: 16px;
    }
    /* The row's own hover state reveals a native overlay/menu over this
       same area, which both visually clashes with and steals clicks from
       this icon — hide it while that's showing rather than fight it. */
    .trackItem:hover .${INLINE_DOWNLOAD_ICON_CLASS} {
      display: none;
    }
    .${STATE_SUCCESS_CLASS},
    .${STATE_SUCCESS_CLASS} svg,
    .${STATE_SUCCESS_CLASS} svg * {
      color: #2ecc71 !important;
      fill: #2ecc71 !important;
    }
    .${STATE_FAILURE_CLASS},
    .${STATE_FAILURE_CLASS} svg,
    .${STATE_FAILURE_CLASS} svg * {
      color: #e74c3c !important;
      fill: #e74c3c !important;
    }
    .${STATE_LOADING_CLASS},
    .${STATE_LOADING_CLASS} svg,
    .${STATE_LOADING_CLASS} svg * {
      color: #999 !important;
      fill: #999 !important;
    }
    .${STATE_LOADING_CLASS} svg {
      animation: scArtworkCopySpin 0.8s linear infinite;
    }
    @keyframes scArtworkCopySpin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }
    #${TOAST_CONTAINER_ID} {
      position: fixed;
      top: 56px;
      right: 16px;
      z-index: 10000;
      display: flex;
      flex-direction: column;
      align-items: flex-end;
      gap: 8px;
      pointer-events: none;
    }
    .${TOAST_CLASS} {
      max-width: 320px;
      padding: 10px 14px;
      border-radius: 4px;
      border-left: 3px solid #e74c3c;
      background: var(--background-surface-color, #222);
      color: var(--primary-color, #fff);
      font-family: inherit;
      font-size: 13px;
      line-height: 1.4;
      box-shadow: 0 2px 10px rgba(0, 0, 0, 0.4);
      opacity: 0;
      transform: translateY(-6px);
      transition: opacity 0.2s ease, transform 0.2s ease;
    }
    .${TOAST_CLASS}.${TOAST_VISIBLE_CLASS} {
      opacity: 1;
      transform: translateY(0);
    }
  `;

  const ERROR_MESSAGES = {
    NOT_TRACK_PAGE: {
      en: () => "This isn't a track page.",
      ja: () => 'トラックページではありません。',
    },
    NO_ARTWORK: {
      en: () => "This track doesn't have artwork set.",
      ja: () => 'このトラックにはジャケット画像が設定されていません。',
    },
    ARTWORK_NOT_LOADED: {
      en: () => "Artwork hasn't loaded yet.",
      ja: () => 'ジャケット画像がまだ読み込まれていません。',
    },
    FETCH_ARTWORK_FAILED: {
      en: ({ status }) => `Failed to fetch artwork (${status}).`,
      ja: ({ status }) => `ジャケット画像の取得に失敗しました（${status}）。`,
    },
    RESOLVE_TRACK_FAILED: {
      en: ({ status }) => `Failed to look up the track (${status}).`,
      ja: ({ status }) => `トラック情報の取得に失敗しました（${status}）。`,
    },
    NOT_A_TRACK: {
      en: () => "This isn't a track.",
      ja: () => 'トラックではありません。',
    },
    MISSING_SESSION_CREDENTIALS: {
      en: () => 'Could not read SoundCloud session credentials.',
      ja: () => 'SoundCloudのセッション情報を取得できませんでした。',
    },
    DOWNLOAD_URL_FAILED: {
      en: ({ status }) => `Failed to get a download URL (${status}).`,
      ja: ({ status }) => `ダウンロードURLの取得に失敗しました（${status}）。`,
    },
    NO_DOWNLOAD_URL: {
      en: () => 'No download URL was returned.',
      ja: () => 'ダウンロードURLが返されませんでした。',
    },
    DOWNLOAD_FILE_FAILED: {
      en: ({ status }) => `Failed to download the file (${status}).`,
      ja: ({ status }) => `ファイルのダウンロードに失敗しました（${status}）。`,
    },
    UNKNOWN: {
      en: () => 'Something went wrong.',
      ja: () => '不明なエラーが発生しました。',
    },
  };

  function failWith(code, params) {
    // The English code/params combo stays in .message so console.error
    // output is still useful for debugging regardless of locale; the
    // localized text for the toast is looked up separately from .code.
    const err = new Error(params ? `${code} ${JSON.stringify(params)}` : code);
    err.code = code;
    err.params = params || {};
    throw err;
  }

  function localizeError(err) {
    const lang = (navigator.language || 'en').slice(0, 2).toLowerCase();
    const entry = ERROR_MESSAGES[err?.code] || ERROR_MESSAGES.UNKNOWN;
    const translate = entry[lang] || entry.en;
    return translate(err?.params || {});
  }

  function getHighResUrl(baseUrl) {
    // The web app's own rendered DOM uses "-t{width}x{height}" (e.g.
    // -t500x500), but the /resolve API's artwork_url field uses SoundCloud's
    // older "-large" convention instead — match either.
    return baseUrl.replace(/-(?:t\d+x\d+|large)(?=\.\w+$)/, '-original');
  }

  async function convertBlobToPng(blob) {
    const bitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    canvas.getContext('2d').drawImage(bitmap, 0, 0);
    return canvas.convertToBlob({ type: 'image/png' });
  }

  async function copyArtworkFromBaseUrl(baseUrl) {
    let response = await fetch(getHighResUrl(baseUrl));
    if (!response.ok) response = await fetch(baseUrl);
    if (!response.ok) failWith('FETCH_ARTWORK_FAILED', { status: response.status });

    let blob = await response.blob();
    // Only image/png is guaranteed writable to the clipboard; some
    // artworks (particularly ones without a "-original" high-res variant)
    // are served as image/jpeg, which some browsers reject outright.
    if (blob.type !== 'image/png') blob = await convertBlobToPng(blob);
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
  }

  async function copyArtwork() {
    // Routed through the same api-v2 /resolve call the download feature
    // uses, rather than fetch()-ing the page's own HTML for its meta tags:
    // that HTML fetch is what was intermittently redirected to
    // m.soundcloud.com and blocked by CORS (SoundCloud's bot defenses).
    let trackData;
    try {
      trackData = await fetchTrackData(location.href);
    } catch (err) {
      if (err?.code === 'NOT_A_TRACK') failWith('NOT_TRACK_PAGE');
      throw err;
    }
    if (!trackData.artworkUrl) failWith('NO_ARTWORK');
    await copyArtworkFromBaseUrl(trackData.artworkUrl);
  }

  function getArtworkUrlFromTile(artworkEl) {
    // The wrapping <div> around the artwork also carries an "sc-artwork"
    // class, but only the inner <span> has the background-image inline
    // style, so scope the lookup to that span specifically.
    const span = artworkEl.querySelector('span.sc-artwork');
    const match = span?.style.backgroundImage.match(/url\(["']?(.*?)["']?\)/);
    return match ? match[1] : null;
  }

  async function copyArtworkFromTile(artworkEl) {
    const baseUrl = getArtworkUrlFromTile(artworkEl);
    if (!baseUrl) failWith('ARTWORK_NOT_LOADED');
    await copyArtworkFromBaseUrl(baseUrl);
  }

  function concatBytes(arrays) {
    const total = arrays.reduce((sum, a) => sum + a.length, 0);
    const result = new Uint8Array(total);
    let offset = 0;
    for (const a of arrays) {
      result.set(a, offset);
      offset += a.length;
    }
    return result;
  }

  function parseWavChunks(buffer) {
    const view = new DataView(buffer);
    const chunks = [];
    let offset = 12; // skip "RIFF" + size + "WAVE"
    while (offset + 8 <= buffer.byteLength) {
      const id = String.fromCharCode(
        view.getUint8(offset), view.getUint8(offset + 1), view.getUint8(offset + 2), view.getUint8(offset + 3)
      );
      const size = view.getUint32(offset + 4, true);
      chunks.push({ id, start: offset, dataStart: offset + 8, size });
      offset += 8 + size + (size % 2);
    }
    return chunks;
  }

  function findInfoChunk(buffer, chunks) {
    const view = new DataView(buffer);
    for (const chunk of chunks) {
      if (chunk.id !== 'LIST') continue;
      const listType = String.fromCharCode(
        view.getUint8(chunk.dataStart), view.getUint8(chunk.dataStart + 1),
        view.getUint8(chunk.dataStart + 2), view.getUint8(chunk.dataStart + 3)
      );
      if (listType === 'INFO') return chunk;
    }
    return null;
  }

  function readInfoValues(buffer, infoChunk) {
    const view = new DataView(buffer);
    const values = {};
    let offset = infoChunk.dataStart + 4; // skip the "INFO" list-type marker
    const end = infoChunk.dataStart + infoChunk.size;
    while (offset + 8 <= end) {
      const id = String.fromCharCode(
        view.getUint8(offset), view.getUint8(offset + 1), view.getUint8(offset + 2), view.getUint8(offset + 3)
      );
      const size = view.getUint32(offset + 4, true);
      const dataStart = offset + 8;
      const bytes = new Uint8Array(buffer, dataStart, size);
      values[id] = new TextDecoder('utf-8').decode(bytes).replace(/\0+$/, '');
      offset = dataStart + size + (size % 2);
    }
    return values;
  }

  function buildInfoChunk(fields) {
    const encoder = new TextEncoder();
    const entries = [
      ['INAM', fields.title],
      ['IART', fields.artist],
      ['IPRD', fields.album],
      ['IGNR', fields.genre],
    ];
    const parts = [];
    for (const [id, value] of entries) {
      if (!value) continue;
      const textBytes = encoder.encode(`${value}\0`);
      const padded = textBytes.length % 2 === 0 ? textBytes : concatBytes([textBytes, new Uint8Array([0])]);
      const header = new Uint8Array(8);
      header.set(encoder.encode(id), 0);
      new DataView(header.buffer).setUint32(4, textBytes.length, true);
      parts.push(header, padded);
    }
    const infoBody = concatBytes([encoder.encode('INFO'), ...parts]);
    const chunkHeader = new Uint8Array(8);
    chunkHeader.set(encoder.encode('LIST'), 0);
    new DataView(chunkHeader.buffer).setUint32(4, infoBody.length, true);
    return concatBytes([chunkHeader, infoBody]);
  }

  function buildRiffChunk(fourCC, data) {
    const encoder = new TextEncoder();
    const header = new Uint8Array(8);
    header.set(encoder.encode(fourCC), 0);
    new DataView(header.buffer).setUint32(4, data.length, true);
    const padded = data.length % 2 === 0 ? data : concatBytes([data, new Uint8Array([0])]);
    return concatBytes([header, padded]);
  }

  function spliceRiffChunk(buffer, existingChunk, newChunkBytes, fallbackInsertChunk) {
    const original = new Uint8Array(buffer);
    let spliced;
    if (existingChunk) {
      const chunkEnd = existingChunk.dataStart + existingChunk.size + (existingChunk.size % 2);
      spliced = concatBytes([original.subarray(0, existingChunk.start), newChunkBytes, original.subarray(chunkEnd)]);
    } else {
      const insertAt = fallbackInsertChunk ? fallbackInsertChunk.start : original.length;
      spliced = concatBytes([original.subarray(0, insertAt), newChunkBytes, original.subarray(insertAt)]);
    }
    // The top-level RIFF size field covers everything after itself, so it
    // needs correcting whenever the file's total length changes.
    new DataView(spliced.buffer).setUint32(4, spliced.byteLength - 8, true);
    return spliced.buffer;
  }

  async function mergeWavMetadata(buffer, fields) {
    let chunks = parseWavChunks(buffer);
    const existingInfo = findInfoChunk(buffer, chunks);
    const existingValues = existingInfo ? readInfoValues(buffer, existingInfo) : {};

    // Only fill in whatever the file doesn't already have set.
    const resolvedFields = {
      title: existingValues.INAM || fields.title,
      artist: existingValues.IART || fields.artist,
      album: existingValues.IPRD || fields.album,
      genre: existingValues.IGNR || fields.genre,
    };
    buffer = spliceRiffChunk(
      buffer,
      existingInfo,
      buildInfoChunk(resolvedFields),
      chunks.find((c) => c.id === 'data')
    );

    // WAV's own LIST/INFO chunk has no artwork convention, so artwork (and,
    // redundantly, the same text fields for players that only read this
    // chunk) goes into a non-standard but ffmpeg/mutagen-recognized "id3 "
    // chunk holding a full ID3v2 tag — the same format/frames as the MP3
    // path. Chunk offsets shift after the splice above, so re-parse first.
    chunks = parseWavChunks(buffer);
    const existingId3Chunk = chunks.find((c) => c.id.toLowerCase() === 'id3 ');
    const existingId3Data = existingId3Chunk
      ? buffer.slice(existingId3Chunk.dataStart, existingId3Chunk.dataStart + existingId3Chunk.size)
      : null;
    const existingId3 = existingId3Data ? parseExistingId3(existingId3Data) : {};
    const id3Tag = await buildId3Tag(existingId3, { ...resolvedFields, artworkUrl: fields.artworkUrl }, new ArrayBuffer(0));
    buffer = spliceRiffChunk(
      buffer,
      existingId3Chunk,
      buildRiffChunk('id3 ', new Uint8Array(id3Tag)),
      chunks.find((c) => c.id === 'data')
    );

    return buffer;
  }

  function readSyncsafeInt(bytes) {
    return (bytes[0] << 21) | (bytes[1] << 14) | (bytes[2] << 7) | bytes[3];
  }

  function decodeId3Text(bytes) {
    if (bytes.length === 0) return '';
    const encoding = bytes[0];
    const rest = bytes.subarray(1);
    if (encoding === 1 || encoding === 2) {
      // UTF-16, with or without a leading BOM.
      let start = 0;
      let littleEndian = encoding === 1;
      if (rest.length >= 2 && rest[0] === 0xff && rest[1] === 0xfe) {
        littleEndian = true;
        start = 2;
      } else if (rest.length >= 2 && rest[0] === 0xfe && rest[1] === 0xff) {
        littleEndian = false;
        start = 2;
      }
      const codeUnits = [];
      for (let i = start; i + 1 < rest.length; i += 2) {
        const lo = rest[i];
        const hi = rest[i + 1];
        codeUnits.push(littleEndian ? (hi << 8) | lo : (lo << 8) | hi);
      }
      return String.fromCharCode(...codeUnits).replace(/\0+$/, '');
    }
    return new TextDecoder(encoding === 3 ? 'utf-8' : 'iso-8859-1').decode(rest).replace(/\0+$/, '');
  }

  function parseApicFrame(data) {
    const encoding = data[0];
    let i = 1;
    let mimeEnd = i;
    while (mimeEnd < data.length && data[mimeEnd] !== 0) mimeEnd++;
    const mimeType = new TextDecoder('iso-8859-1').decode(data.subarray(i, mimeEnd));
    i = mimeEnd + 1;
    const pictureType = data[i];
    i += 1;
    let descEnd = i;
    if (encoding === 1 || encoding === 2) {
      while (descEnd + 1 < data.length && !(data[descEnd] === 0 && data[descEnd + 1] === 0)) descEnd += 2;
      descEnd += 2;
    } else {
      while (descEnd < data.length && data[descEnd] !== 0) descEnd++;
      descEnd += 1;
    }
    return { mimeType, pictureType, data: data.subarray(descEnd) };
  }

  function parseExistingId3(buffer) {
    // Only reads the frames we care about preserving (TIT2/TALB/TPE1/TCON/
    // APIC); anything else in the tag is intentionally not round-tripped
    // since browser-id3-writer always builds a brand-new tag from what we
    // set.
    const bytes = new Uint8Array(buffer);
    const result = {};
    if (bytes.length < 10 || bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) return result;

    const majorVersion = bytes[3];
    const tagSize = readSyncsafeInt(bytes.subarray(6, 10));
    let offset = 10;
    const end = Math.min(10 + tagSize, bytes.length);

    while (offset + 10 <= end) {
      const frameId = String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
      if (frameId === '\0\0\0\0') break;
      const sizeBytes = bytes.subarray(offset + 4, offset + 8);
      const frameSize =
        majorVersion >= 4
          ? readSyncsafeInt(sizeBytes)
          : (sizeBytes[0] << 24) | (sizeBytes[1] << 16) | (sizeBytes[2] << 8) | sizeBytes[3];
      const frameStart = offset + 10;
      const frameData = bytes.subarray(frameStart, frameStart + frameSize);

      if (frameId === 'TIT2' || frameId === 'TALB' || frameId === 'TPE1' || frameId === 'TCON') {
        result[frameId] = decodeId3Text(frameData);
      } else if (frameId === 'APIC') {
        result.APIC = parseApicFrame(frameData);
      }

      offset = frameStart + frameSize;
    }
    return result;
  }

  async function fetchArtworkBuffer(baseUrl) {
    let response = await fetch(getHighResUrl(baseUrl));
    if (!response.ok) response = await fetch(baseUrl);
    if (!response.ok) failWith('FETCH_ARTWORK_FAILED', { status: response.status });
    return { data: await response.arrayBuffer(), mimeType: response.headers.get('content-type') || 'image/jpeg' };
  }

  async function buildId3Tag(existing, fields, seedBuffer) {
    // seedBuffer is the real MP3 bytes when tagging an actual MP3 (so the
    // audio survives the rewrite), or an empty buffer when we just want the
    // standalone tag bytes (e.g. to embed in a WAV "id3 " chunk).
    // Pinned to the exact version whose source was reviewed before use.
    const { ID3Writer } = await import(
      'https://unpkg.com/browser-id3-writer@6.3.1/dist/browser-id3-writer.mjs'
    );
    const writer = new ID3Writer(seedBuffer);
    writer.setFrame('TIT2', existing.TIT2 || fields.title);
    const album = existing.TALB || fields.album;
    if (album) writer.setFrame('TALB', album);
    const artist = existing.TPE1 || fields.artist;
    if (artist) writer.setFrame('TPE1', [artist]);
    const genre = existing.TCON || fields.genre;
    if (genre) writer.setFrame('TCON', [genre]);

    if (existing.APIC) {
      const pic = existing.APIC.data;
      writer.setFrame('APIC', {
        type: existing.APIC.pictureType,
        data: pic.buffer.slice(pic.byteOffset, pic.byteOffset + pic.byteLength),
        description: '',
        useUnicodeEncoding: false,
      });
    } else if (fields.artworkUrl) {
      const artwork = await fetchArtworkBuffer(fields.artworkUrl);
      writer.setFrame('APIC', { type: 3, data: artwork.data, description: '', useUnicodeEncoding: false });
    }

    writer.addTag();
    return writer.arrayBuffer;
  }

  async function mergeMp3Metadata(buffer, fields) {
    const existing = parseExistingId3(buffer);
    return buildId3Tag(existing, fields, buffer);
  }

  function parseFlacBlocks(buffer) {
    const view = new DataView(buffer);
    const blocks = [];
    let offset = 4; // skip "fLaC" magic
    while (offset + 4 <= buffer.byteLength) {
      const headerByte = view.getUint8(offset);
      const isLast = (headerByte & 0x80) !== 0;
      const type = headerByte & 0x7f;
      const length = (view.getUint8(offset + 1) << 16) | (view.getUint8(offset + 2) << 8) | view.getUint8(offset + 3);
      blocks.push({ type, start: offset, dataStart: offset + 4, length });
      offset += 4 + length;
      if (isLast) break;
    }
    return blocks;
  }

  function readVorbisComments(buffer, block) {
    // Metadata block headers and the PICTURE block use big-endian, but
    // Vorbis comment fields are little-endian — inherited as-is from the
    // original Ogg Vorbis comment spec.
    const view = new DataView(buffer);
    let offset = block.dataStart;
    const vendorLength = view.getUint32(offset, true);
    offset += 4 + vendorLength;
    const commentCount = view.getUint32(offset, true);
    offset += 4;

    const values = {};
    for (let i = 0; i < commentCount; i++) {
      const len = view.getUint32(offset, true);
      offset += 4;
      const text = new TextDecoder('utf-8').decode(new Uint8Array(buffer, offset, len));
      const eq = text.indexOf('=');
      if (eq !== -1) values[text.slice(0, eq).toUpperCase()] = text.slice(eq + 1);
      offset += len;
    }
    return values;
  }

  function readPictureBlock(buffer, block) {
    const view = new DataView(buffer);
    let offset = block.dataStart;
    const pictureType = view.getUint32(offset, false);
    offset += 4;
    const mimeLength = view.getUint32(offset, false);
    offset += 4;
    const mimeType = new TextDecoder('ascii').decode(new Uint8Array(buffer, offset, mimeLength));
    offset += mimeLength;
    const descLength = view.getUint32(offset, false);
    offset += 4 + descLength; // description text isn't something we round-trip
    offset += 16; // width, height, color depth, indexed-color count
    const dataLength = view.getUint32(offset, false);
    offset += 4;
    return { pictureType, mimeType, data: new Uint8Array(buffer, offset, dataLength) };
  }

  function buildFlacMetadataBlock(type, data) {
    // The last-block flag gets fixed up once the final block order is
    // known, so this always constructs with it cleared.
    const header = new Uint8Array(4);
    header[0] = type & 0x7f;
    header[1] = (data.length >> 16) & 0xff;
    header[2] = (data.length >> 8) & 0xff;
    header[3] = data.length & 0xff;
    return concatBytes([header, data]);
  }

  function buildVorbisCommentBlock(fields) {
    const encoder = new TextEncoder();
    const vendor = encoder.encode('SoundCloud Artwork Copier');
    const comments = [];
    if (fields.title) comments.push(encoder.encode(`TITLE=${fields.title}`));
    if (fields.artist) comments.push(encoder.encode(`ARTIST=${fields.artist}`));
    if (fields.album) comments.push(encoder.encode(`ALBUM=${fields.album}`));
    if (fields.genre) comments.push(encoder.encode(`GENRE=${fields.genre}`));

    const le32 = (n) => {
      const buf = new Uint8Array(4);
      new DataView(buf.buffer).setUint32(0, n, true);
      return buf;
    };

    const parts = [le32(vendor.length), vendor, le32(comments.length)];
    for (const c of comments) parts.push(le32(c.length), c);

    return buildFlacMetadataBlock(4, concatBytes(parts));
  }

  function buildPictureBlock(mimeType, pictureData, pictureType = 3) {
    const encoder = new TextEncoder();
    const mimeBytes = encoder.encode(mimeType);
    const be32 = (n) => {
      const buf = new Uint8Array(4);
      new DataView(buf.buffer).setUint32(0, n, false);
      return buf;
    };

    const parts = [
      be32(pictureType),
      be32(mimeBytes.length),
      mimeBytes,
      be32(0), // no description
      new Uint8Array(16), // width, height, color depth, indexed-color count: unknown
      be32(pictureData.byteLength),
      new Uint8Array(pictureData),
    ];
    return buildFlacMetadataBlock(6, concatBytes(parts));
  }

  async function mergeFlacMetadata(buffer, fields) {
    const blocks = parseFlacBlocks(buffer);
    const existingCommentBlock = blocks.find((b) => b.type === 4);
    const existingValues = existingCommentBlock ? readVorbisComments(buffer, existingCommentBlock) : {};
    const existingPictureBlock = blocks.find((b) => b.type === 6);

    const commentBlockBytes = buildVorbisCommentBlock({
      title: existingValues.TITLE || fields.title,
      artist: existingValues.ARTIST || fields.artist,
      album: existingValues.ALBUM || fields.album,
      genre: existingValues.GENRE || fields.genre,
    });

    let pictureBlockBytes = null;
    if (existingPictureBlock) {
      const pic = readPictureBlock(buffer, existingPictureBlock);
      pictureBlockBytes = buildPictureBlock(pic.mimeType, pic.data, pic.pictureType);
    } else if (fields.artworkUrl) {
      const artwork = await fetchArtworkBuffer(fields.artworkUrl);
      pictureBlockBytes = buildPictureBlock(artwork.mimeType, artwork.data);
    }

    // STREAMINFO (type 0) must stay first; everything else (PADDING,
    // APPLICATION, SEEKTABLE, CUESHEET, ...) is kept as-is, just with our
    // comment/picture blocks replacing whatever was there before, inserted
    // right after STREAMINFO.
    const original = new Uint8Array(buffer);
    const keptBlocks = blocks.filter((b) => b.type !== 4 && b.type !== 6).map((b) => original.slice(b.start, b.start + 4 + b.length));

    const newBlocks = [
      keptBlocks[0], // STREAMINFO
      commentBlockBytes,
      ...(pictureBlockBytes ? [pictureBlockBytes] : []),
      ...keptBlocks.slice(1),
    ];
    newBlocks.forEach((block, i) => {
      block[0] = (block[0] & 0x7f) | (i === newBlocks.length - 1 ? 0x80 : 0);
    });

    const lastOriginalBlock = blocks[blocks.length - 1];
    const audioData = original.subarray(lastOriginalBlock.dataStart + lastOriginalBlock.length);
    return concatBytes([original.subarray(0, 4), ...newBlocks, audioData]).buffer;
  }

  function getHydrationEntry(hydration, key) {
    return hydration?.find((entry) => entry.hydratable === key)?.data ?? null;
  }

  function getOAuthToken() {
    // api-v2 endpoints like the download one require this in addition to
    // client_id + cookies; it's not httpOnly, so it's readable here.
    const match = document.cookie.match(/(?:^|;\s*)oauth_token=([^;]+)/);
    return match ? decodeURIComponent(match[1]) : null;
  }

  function authHeaders() {
    const token = getOAuthToken();
    return token ? { Authorization: `OAuth ${token}` } : {};
  }

  async function fetchTrackData(url) {
    // A plain fetch() of the track's HTML page gets redirected to
    // m.soundcloud.com and blocked by CORS — SoundCloud's bot defenses
    // (DataDome) appear to flag script-issued fetches of page HTML even
    // for the page currently being viewed. The api-v2 resolve endpoint is
    // the same kind of AJAX call the download endpoint already uses
    // successfully, and returns the track JSON directly (no HTML/hydration
    // parsing needed).
    const { clientId } = getSessionCredentials();
    const resolveUrl = `https://api-v2.soundcloud.com/resolve?url=${encodeURIComponent(url)}&client_id=${encodeURIComponent(clientId)}`;
    const response = await fetch(resolveUrl, { credentials: 'include', headers: authHeaders() });
    if (!response.ok) failWith('RESOLVE_TRACK_FAILED', { status: response.status });
    const sound = await response.json();
    if (sound.kind !== 'track') failWith('NOT_A_TRACK');

    return {
      id: sound.id,
      title: sound.title || 'track',
      artist: sound.user?.username || sound.user?.full_name || '',
      artworkUrl: sound.artwork_url || null,
      genre: sound.genre || '',
    };
  }

  function getSessionCredentials() {
    // Unlike the track id, client_id/app_version are session-level, not
    // per-track, so the live page's own globals are always current.
    const clientId = getHydrationEntry(window.__sc_hydration, 'apiClient')?.id;
    const appVersion = window.__sc_version;
    if (!clientId || !appVersion) failWith('MISSING_SESSION_CREDENTIALS');
    return { clientId, appVersion };
  }

  async function fetchDownloadFile(trackId) {
    const { clientId, appVersion } = getSessionCredentials();
    const apiUrl = `https://api-v2.soundcloud.com/tracks/${trackId}/download?client_id=${encodeURIComponent(clientId)}&app_version=${encodeURIComponent(appVersion)}&app_locale=en`;
    const apiResponse = await fetch(apiUrl, { credentials: 'include', headers: authHeaders() });
    if (!apiResponse.ok) failWith('DOWNLOAD_URL_FAILED', { status: apiResponse.status });
    const { redirectUri } = await apiResponse.json();
    if (!redirectUri) failWith('NO_DOWNLOAD_URL');

    const fileResponse = await fetch(redirectUri);
    if (!fileResponse.ok) failWith('DOWNLOAD_FILE_FAILED', { status: fileResponse.status });
    return {
      buffer: await fileResponse.arrayBuffer(),
      contentType: fileResponse.headers.get('content-type') || '',
    };
  }

  function detectAudioFormat(buffer, contentType) {
    const bytes = new Uint8Array(buffer, 0, Math.min(12, buffer.byteLength));
    const riff = String.fromCharCode(...bytes.subarray(0, 4));
    const wave = bytes.length >= 12 ? String.fromCharCode(...bytes.subarray(8, 12)) : '';
    if (riff === 'RIFF' && wave === 'WAVE') return 'wav';

    const isFlac = bytes[0] === 0x66 && bytes[1] === 0x4c && bytes[2] === 0x61 && bytes[3] === 0x43; // "fLaC"
    if (isFlac || contentType.includes('flac')) return 'flac';

    const isId3 = bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33; // "ID3"
    const isMpegSync = bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0;
    if (isId3 || isMpegSync || contentType.includes('mpeg')) return 'mp3';

    return 'other';
  }

  function guessExtension(format, contentType) {
    if (format === 'wav') return 'wav';
    if (format === 'mp3') return 'mp3';
    if (format === 'flac') return 'flac';
    if (contentType.includes('mp4') || contentType.includes('m4a')) return 'm4a';
    return 'bin';
  }

  function sanitizeFilename(name) {
    return name.replace(/[\\/:*?"<>|]/g, '_').trim() || 'track';
  }

  function permalinkFromScope(triggerEl) {
    // On the track's own hero page there's no tile/row wrapping the
    // trigger, so falling back to the current page's URL is exactly the
    // right answer there. Playlist track rows (.trackItem) have no
    // artwork/title link matching the other two shapes, so they need their
    // own link selector (.trackItem__trackTitle).
    const scope = triggerEl?.closest('.playableTile, .sound__body, .trackItem') ?? null;
    const link = scope?.querySelector('.playableTile__artworkLink, .sound__coverArt, .trackItem__trackTitle');
    const href = link?.getAttribute('href');
    return href ? new URL(href, location.origin).href : location.href;
  }

  function resolveTrackPermalink(dropdownEl) {
    // Dropdowns are portaled away from the tile/row that opened them, so
    // they can't be found by DOM proximity. The trigger button links back
    // to its dropdown via aria-owns; from there, walk up to the tile/row
    // that owns the trigger and read the track link straight from it.
    const trigger = document.querySelector(`[aria-owns="${CSS.escape(dropdownEl.id)}"]`);
    return permalinkFromScope(trigger);
  }

  function createInlineDownloadIcon() {
    // Not a button: the row's own hover state reveals a native
    // overlay/menu covering this same spot that steals the click, so this
    // is a purely visual indicator instead of an interactive one.
    const icon = document.createElement('span');
    icon.className = INLINE_DOWNLOAD_ICON_CLASS;
    icon.title = 'Downloadable';
    icon.setAttribute('aria-label', 'Downloadable');
    icon.innerHTML = ICON_DOWNLOAD;
    return icon;
  }

  function insertInlinePlaylistDownloadIcon(trigger) {
    // Playlist rows are dense enough that a hover-revealed "More" button
    // felt too hidden — show a standing indicator left of the play count
    // instead, for tracks already known to be downloadable.
    const row = trigger.closest('.trackItem');
    if (!row || row.querySelector(`.${INLINE_DOWNLOAD_ICON_CLASS}`)) return;
    const playCount = row.querySelector('.trackItem__playCount');
    if (!playCount) return;
    playCount.insertAdjacentElement('beforebegin', createInlineDownloadIcon());
  }

  function markTriggerDownloadable(trigger) {
    if (trigger.dataset.scHasDownload) return;
    trigger.dataset.scHasDownload = '1';
    // The grid tile's More button sits on top of the artwork, so it keeps
    // the icon-color treatment instead of the outline used elsewhere.
    const isGridTile = !!trigger.closest('.playableTile__actionWrapper');
    trigger.classList.add(isGridTile ? MORE_BUTTON_ICON_HIGHLIGHT_CLASS : MORE_BUTTON_HIGHLIGHT_CLASS);
    insertInlinePlaylistDownloadIcon(trigger);
  }

  function highlightDownloadableTriggers() {
    // Complements insertDownloadButtons()'s open-then-highlight fallback:
    // this fires as soon as passively-collected data says a track is
    // downloadable, even before its "More" button has ever been opened.
    if (downloadableByPath.size === 0) return;
    document.querySelectorAll('.sc-button-more').forEach((trigger) => {
      if (trigger.dataset.scHasDownload) return;
      const path = permalinkPath(permalinkFromScope(trigger));
      if (path && downloadableByPath.get(path)) markTriggerDownloadable(trigger);
    });
  }

  function triggerFileDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  async function downloadFileWithMetadata(trackUrl) {
    const trackData = await fetchTrackData(trackUrl);
    let { buffer, contentType } = await fetchDownloadFile(trackData.id);

    const format = detectAudioFormat(buffer, contentType);
    if (format === 'wav') {
      buffer = await mergeWavMetadata(buffer, {
        title: trackData.title,
        artist: trackData.artist,
        album: trackData.title,
        genre: trackData.genre,
        artworkUrl: trackData.artworkUrl,
      });
    } else if (format === 'mp3') {
      buffer = await mergeMp3Metadata(buffer, {
        title: trackData.title,
        artist: trackData.artist,
        album: trackData.title,
        genre: trackData.genre,
        artworkUrl: trackData.artworkUrl,
      });
    } else if (format === 'flac') {
      buffer = await mergeFlacMetadata(buffer, {
        title: trackData.title,
        artist: trackData.artist,
        album: trackData.title,
        genre: trackData.genre,
        artworkUrl: trackData.artworkUrl,
      });
    }
    // Other formats (e.g. m4a) download unmodified — no equivalent metadata
    // support implemented for them yet.

    const blob = new Blob([buffer]);
    triggerFileDownload(blob, `${sanitizeFilename(trackData.title)}.${guessExtension(format, contentType)}`);
  }

  function setIcon(button, svg) {
    (button._iconTarget || button).innerHTML = svg;
  }

  function showToast(message) {
    let container = document.getElementById(TOAST_CONTAINER_ID);
    if (!container) {
      container = document.createElement('div');
      container.id = TOAST_CONTAINER_ID;
      document.body.appendChild(container);
    }

    const toast = document.createElement('div');
    toast.className = TOAST_CLASS;
    toast.textContent = message;
    container.appendChild(toast);

    requestAnimationFrame(() => toast.classList.add(TOAST_VISIBLE_CLASS));

    setTimeout(() => {
      toast.classList.remove(TOAST_VISIBLE_CLASS);
      toast.addEventListener('transitionend', () => toast.remove(), { once: true });
    }, TOAST_DURATION_MS);
  }

  function showFeedback(button, isSuccess) {
    clearTimeout(button._feedbackTimer);
    button.classList.remove(STATE_SUCCESS_CLASS, STATE_FAILURE_CLASS);
    button.classList.add(isSuccess ? STATE_SUCCESS_CLASS : STATE_FAILURE_CLASS);
    setIcon(button, isSuccess ? ICON_SUCCESS : ICON_FAILURE);
    button._feedbackTimer = setTimeout(() => {
      button.classList.remove(STATE_SUCCESS_CLASS, STATE_FAILURE_CLASS);
      // Each button remembers its own idle icon — the download button's
      // idle icon isn't the same clipboard icon the copy buttons use.
      setIcon(button, button._idleIcon || ICON_IDLE);
    }, FEEDBACK_DURATION_MS);
  }

  function attachCopyHandler(button, copyFn) {
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (button.disabled) return;
      button.disabled = true;
      clearTimeout(button._feedbackTimer);
      button.classList.remove(STATE_SUCCESS_CLASS, STATE_FAILURE_CLASS);
      button.classList.add(STATE_LOADING_CLASS);
      setIcon(button, ICON_LOADING);

      copyFn()
        .then(() => {
          button.classList.remove(STATE_LOADING_CLASS);
          showFeedback(button, true);
        })
        .catch((err) => {
          console.error('[SC Artwork Copier]', err);
          showToast(localizeError(err));
          button.classList.remove(STATE_LOADING_CLASS);
          showFeedback(button, false);
        })
        .finally(() => {
          button.disabled = false;
        });
    });
  }

  function createTileButton(copyFn, extraClasses, icon) {
    // Matches the structure/classes of the native action buttons alongside
    // it (Like/Follow/More on grid tiles, Like/Repost/Share/... on list
    // rows and the hero page) so it lines up with them visually and
    // inherits their existing sizing and hover-to-reveal behavior for free.
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `${extraClasses} ${TILE_BUTTON_CLASS}`;
    button.title = 'Copy artwork';
    button.setAttribute('aria-label', 'Copy artwork');

    const iconWrapper = document.createElement('div');
    iconWrapper.innerHTML = icon;
    button._iconTarget = iconWrapper;
    button._idleIcon = icon;

    const label = document.createElement('span');
    label.className = 'sc-button-label sc-visuallyhidden';
    label.textContent = 'Copy artwork';

    button.append(iconWrapper, label);
    attachCopyHandler(button, copyFn);
    return button;
  }

  // Four distinct track layouts exist on the site: compact grid tiles
  // (.playableTile__artwork + .playableTile__actionWrapper, e.g. on
  // /you/likes' "Badges" view), full list rows (.sound__artwork +
  // .soundActions .sc-button-group, e.g. the "List" view / stream),
  // playlist track rows (.trackItem__image + .soundActions
  // .sc-button-group, e.g. /sets/... pages), and the track's own hero page
  // (.listenEngagement__footer .soundActions .sc-button-group — same
  // button-group markup as list rows, but not wrapped in a .sound__body
  // tile/row). Each needs its own way to resolve a copy function and its
  // own native button classes to match.
  const ACTION_ROW_CONFIGS = [
    {
      rowSelector: '.playableTile__actionWrapper',
      buttonClasses: 'playableTile__actionButton sc-button sc-button-small sc-button-icon',
      resolveCopy: (rowEl) => {
        const artworkEl = rowEl.closest('.playableTile__artwork');
        return artworkEl ? () => copyArtworkFromTile(artworkEl) : null;
      },
      icon: ICON_CLIPBOARD_SOLID,
    },
    {
      rowSelector: '.soundActions .sc-button-group',
      buttonClasses: 'sc-button-secondary sc-button sc-button-medium sc-button-icon sc-button-responsive',
      resolveCopy: (rowEl) => {
        const artworkEl = rowEl.closest('.sound__body')?.querySelector('.sound__artwork') ?? null;
        return artworkEl ? () => copyArtworkFromTile(artworkEl) : null;
      },
      icon: ICON_CLIPBOARD_SOLID,
    },
    {
      // Playlist track rows reuse the same soundActions button-group
      // markup as the "List" view, but wrap it in .trackItem (with the
      // artwork in .trackItem__image) rather than .sound__body, and use
      // one size class down (sc-button-small, not -medium).
      rowSelector: '.trackItem .soundActions .sc-button-group',
      buttonClasses: 'sc-button-secondary sc-button sc-button-small sc-button-icon sc-button-responsive',
      resolveCopy: (rowEl) => {
        const artworkEl = rowEl.closest('.trackItem')?.querySelector('.trackItem__image') ?? null;
        return artworkEl ? () => copyArtworkFromTile(artworkEl) : null;
      },
      icon: ICON_CLIPBOARD_SOLID,
    },
    {
      // The hero page's action row isn't inside a .sound__body tile/row, so
      // there's no DOM artwork element to key off of — reuse copyArtwork(),
      // the same api-v2-backed lookup the header button uses, since
      // location.href already is this track's own page.
      rowSelector: '.listenEngagement__footer .soundActions .sc-button-group',
      buttonClasses: 'sc-button-secondary sc-button sc-button-medium sc-button-icon sc-button-responsive',
      resolveCopy: () => copyArtwork,
      // Uses the same icon as the header button rather than the tile
      // overlay's Font Awesome clipboard glyph.
      icon: ICON_IDLE,
    },
  ];

  function insertTileButtons() {
    for (const config of ACTION_ROW_CONFIGS) {
      document.querySelectorAll(config.rowSelector).forEach((rowEl) => {
        if (rowEl.querySelector(`.${TILE_BUTTON_CLASS}`)) return;
        const copyFn = config.resolveCopy(rowEl);
        if (!copyFn) return;
        const button = createTileButton(copyFn, config.buttonClasses, config.icon);
        const moreButton = rowEl.querySelector('.sc-button-more');
        if (moreButton) {
          rowEl.insertBefore(button, moreButton);
        } else {
          rowEl.appendChild(button);
        }
      });
    }
  }

  function createDownloadButton(dropdownEl) {
    // Matches the native "Download file" button's classes so it lines up
    // with it visually; deliberately omits "sc-button-download" itself
    // since that class is presumably also a JS behavior hook on the site.
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `sc-button-secondary sc-button moreActions__button sc-button-medium sc-button-tertiary ${DOWNLOAD_BUTTON_CLASS}`;
    button.title = 'Download file with metadata';
    button.setAttribute('aria-label', 'Download file with metadata');

    const iconWrapper = document.createElement('div');
    iconWrapper.innerHTML = ICON_DOWNLOAD;
    button._iconTarget = iconWrapper;
    button._idleIcon = ICON_DOWNLOAD;

    const label = document.createElement('span');
    label.className = 'sc-button-label';
    label.textContent = 'Download file with metadata';

    button.append(iconWrapper, label);
    attachCopyHandler(button, () => downloadFileWithMetadata(resolveTrackPermalink(dropdownEl)));
    return button;
  }

  function insertDownloadButtons() {
    document.querySelectorAll('.moreActions__group').forEach((groupEl) => {
      const nativeDownloadButton = groupEl.querySelector('.sc-button-download');
      if (!nativeDownloadButton) return;
      const dropdownEl = groupEl.closest('.dropdownMenu');
      if (!dropdownEl) return;

      // Download availability is only knowable once the dropdown has been
      // opened (it's portaled in fresh each time), so mark the trigger
      // button here rather than up front — same aria-owns correlation
      // resolveTrackPermalink() uses. The trigger stays in the DOM as long
      // as its tile/row does, so the highlight persists after the dropdown
      // closes.
      const trigger = document.querySelector(`[aria-owns="${CSS.escape(dropdownEl.id)}"]`);
      if (trigger) markTriggerDownloadable(trigger);

      if (groupEl.querySelector(`.${DOWNLOAD_BUTTON_CLASS}`)) return;
      nativeDownloadButton.insertAdjacentElement('afterend', createDownloadButton(dropdownEl));
    });
  }

  whenDomReady(() => {
    document.head.appendChild(style);

    // The initial page load's track list (e.g. the first batch of /likes)
    // is often embedded directly in this hydration payload rather than
    // fetched via a subsequent AJAX call our fetch patch could observe, so
    // scan it once up front too. It doesn't update on SPA navigation, but
    // by then the fetch patch is already catching fresh data as it loads.
    recordDownloadableInfo(window.__sc_hydration);

    // React re-renders wipe out our injected buttons, so keep watching and
    // reinsert whenever they're gone. Likes/playlist lists are also
    // lazy-loaded and append new tiles as the user scrolls, so the same
    // observer keeps those overlay buttons in sync. "More" dropdowns are
    // portaled in fresh each time they're opened, so this also catches
    // those as they appear.
    const observer = new MutationObserver(() => {
      insertTileButtons();
      insertDownloadButtons();
      highlightDownloadableTriggers();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    insertTileButtons();
    insertDownloadButtons();
    highlightDownloadableTriggers();
  });
})();
