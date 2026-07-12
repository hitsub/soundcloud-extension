// ==UserScript==
// @name         SoundCloud Artwork Copier
// @namespace    https://github.com/hitsub/sc-jacket-extensions
// @version      0.1.0
// @description  Copy the current track's artwork image to the clipboard from a button next to the SoundCloud header search box
// @author       hitsub
// @match        *://soundcloud.com/*
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const BUTTON_CLASS = 'scArtworkCopy__button';
  const TILE_BUTTON_CLASS = 'scArtworkCopy__tileButton';
  const TILE_SHADOW_CLASS = 'scArtworkCopy__tileButton--onArtwork';
  const DOWNLOAD_BUTTON_CLASS = 'scArtworkCopy__downloadButton';
  const STATE_SUCCESS_CLASS = 'scArtworkCopy--success';
  const STATE_FAILURE_CLASS = 'scArtworkCopy--failure';
  const STATE_LOADING_CLASS = 'scArtworkCopy--loading';
  const FEEDBACK_DURATION_MS = 1500;

  const ICON_IDLE = '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path fill="currentColor" d="M9 2a1 1 0 0 0-1 1v1H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-2V3a1 1 0 0 0-1-1H9Zm0 2h6v2H9V4ZM6 6h2v2h8V6h2v14H6V6Z"/></svg>';
  const ICON_SUCCESS = '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path fill="currentColor" d="M9 16.17 4.83 12l-1.42 1.41L9 19l12-12-1.41-1.41z"/></svg>';
  const ICON_FAILURE = '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path fill="currentColor" d="M18.3 5.71 12 12.01l-6.3-6.3-1.41 1.41L10.59 13.42l-6.3 6.3 1.41 1.41 6.3-6.3 6.3 6.3 1.41-1.41-6.3-6.3 6.3-6.3z"/></svg>';
  const ICON_LOADING = '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path fill="currentColor" d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46A7.93 7.93 0 0 0 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74A7.93 7.93 0 0 0 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z"/></svg>';
  const ICON_DOWNLOAD = '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path fill="currentColor" d="M19 9h-4V3H9v6H5l7 7 7-7ZM5 18v2h14v-2H5Z"/></svg>';

  const style = document.createElement('style');
  style.textContent = `
    .${BUTTON_CLASS} {
      float: left;
      position: relative;
      top: 50%;
      transform: translateY(-50%);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 32px;
      height: 32px;
      margin-right: 8px;
      padding: 0;
      border: none;
      border-radius: 3px;
      background: transparent;
      color: #ff5500;
      cursor: pointer;
    }
    .${BUTTON_CLASS}:hover {
      background: rgba(0, 0, 0, 0.05);
    }
    .${BUTTON_CLASS} svg {
      width: 20px;
      height: 20px;
    }
    .${TILE_BUTTON_CLASS} {
      color: #ff5500;
    }
    .${TILE_SHADOW_CLASS} svg {
      filter: drop-shadow(0 0 1.5px rgba(255, 255, 255, 0.9)) drop-shadow(0 0 2px rgba(255, 255, 255, 0.6));
    }
    .${STATE_SUCCESS_CLASS} {
      color: #2ecc71;
    }
    .${STATE_FAILURE_CLASS} {
      color: #e74c3c;
    }
    .${STATE_LOADING_CLASS} {
      color: #999;
    }
    .${STATE_LOADING_CLASS} svg {
      animation: scArtworkCopySpin 0.8s linear infinite;
    }
    @keyframes scArtworkCopySpin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }
  `;
  document.head.appendChild(style);

  function getHighResUrl(baseUrl) {
    return baseUrl.replace(/-t\d+x\d+(?=\.\w+$)/, '-original');
  }

  async function fetchCurrentPageMeta() {
    // SoundCloud is an SPA: navigating between tracks updates the URL via
    // pushState but never touches the <meta> tags left over from the page
    // that was first loaded. Re-fetch the current URL's HTML fresh so we
    // always read the meta tags for the track actually being viewed.
    const response = await fetch(location.href, { credentials: 'same-origin' });
    const html = await response.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    return {
      ogType: doc.querySelector('meta[property="og:type"]')?.getAttribute('content') ?? null,
      ogImage: doc.querySelector('meta[property="og:image"]')?.getAttribute('content') ?? null,
    };
  }

  async function copyArtworkFromBaseUrl(baseUrl) {
    let response = await fetch(getHighResUrl(baseUrl));
    if (!response.ok) response = await fetch(baseUrl);
    if (!response.ok) throw new Error(`Failed to fetch artwork: ${response.status}`);

    const blob = await response.blob();
    await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
  }

  async function copyArtwork() {
    const meta = await fetchCurrentPageMeta();
    if (meta.ogType !== 'music.song' || !meta.ogImage) throw new Error('Not a track page');
    await copyArtworkFromBaseUrl(meta.ogImage);
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
    if (!baseUrl) throw new Error('Artwork not loaded yet');
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

  function mergeWavMetadata(buffer, fields) {
    const chunks = parseWavChunks(buffer);
    const existingInfo = findInfoChunk(buffer, chunks);
    const existingValues = existingInfo ? readInfoValues(buffer, existingInfo) : {};

    // Only fill in whatever the file doesn't already have set.
    const resolvedFields = {
      title: existingValues.INAM || fields.title,
      artist: existingValues.IART || fields.artist,
      album: existingValues.IPRD || fields.album,
    };
    const newInfoChunk = buildInfoChunk(resolvedFields);
    const original = new Uint8Array(buffer);

    let spliced;
    if (existingInfo) {
      const chunkEnd = existingInfo.dataStart + existingInfo.size + (existingInfo.size % 2);
      spliced = concatBytes([original.subarray(0, existingInfo.start), newInfoChunk, original.subarray(chunkEnd)]);
    } else {
      const dataChunk = chunks.find((c) => c.id === 'data');
      const insertAt = dataChunk ? dataChunk.start : original.length;
      spliced = concatBytes([original.subarray(0, insertAt), newInfoChunk, original.subarray(insertAt)]);
    }

    // The top-level RIFF size field covers everything after itself, so it
    // needs correcting whenever the file's total length changes.
    new DataView(spliced.buffer).setUint32(4, spliced.byteLength - 8, true);
    return spliced.buffer;
  }

  function extractHydrationJson(html) {
    // window.__sc_hydration is one large embedded JSON array. A naive
    // regex up to the first "];" breaks on track titles that contain
    // literal brackets (e.g. "[Buzz's Mix n Mash]"), so bracket-match by
    // hand while staying aware of string literals.
    const marker = 'window.__sc_hydration = ';
    const start = html.indexOf(marker);
    if (start === -1) return null;
    const jsonStart = start + marker.length;

    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = jsonStart; i < html.length; i++) {
      const ch = html[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '[') depth++;
      else if (ch === ']') {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(html.slice(jsonStart, i + 1));
          } catch {
            return null;
          }
        }
      }
    }
    return null;
  }

  function getHydrationEntry(hydration, key) {
    return hydration?.find((entry) => entry.hydratable === key)?.data ?? null;
  }

  async function fetchTrackData(url) {
    // Same staleness concern as fetchCurrentPageMeta: SPA navigation never
    // updates window.__sc_hydration for the newly-viewed track, so always
    // re-fetch the target track's own page fresh.
    const response = await fetch(url, { credentials: 'same-origin' });
    const html = await response.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const ogType = doc.querySelector('meta[property="og:type"]')?.getAttribute('content');
    if (ogType !== 'music.song') throw new Error('Not a track page');

    const sound = getHydrationEntry(extractHydrationJson(html), 'sound');
    if (!sound?.id) throw new Error('Could not read track data');

    return {
      id: sound.id,
      title: sound.title || doc.querySelector('meta[property="og:title"]')?.getAttribute('content') || 'track',
      artist: sound.user?.username || sound.user?.full_name || '',
    };
  }

  function getSessionCredentials() {
    // Unlike the track id, client_id/app_version are session-level, not
    // per-track, so the live page's own globals are always current.
    const clientId = getHydrationEntry(window.__sc_hydration, 'apiClient')?.id;
    const appVersion = window.__sc_version;
    if (!clientId || !appVersion) throw new Error('Missing session credentials');
    return { clientId, appVersion };
  }

  async function fetchDownloadFile(trackId) {
    const { clientId, appVersion } = getSessionCredentials();
    const apiUrl = `https://api-v2.soundcloud.com/tracks/${trackId}/download?client_id=${encodeURIComponent(clientId)}&app_version=${encodeURIComponent(appVersion)}&app_locale=en`;
    const apiResponse = await fetch(apiUrl, { credentials: 'include' });
    if (!apiResponse.ok) throw new Error(`Failed to get download URL: ${apiResponse.status}`);
    const { redirectUri } = await apiResponse.json();
    if (!redirectUri) throw new Error('No download URL returned');

    const fileResponse = await fetch(redirectUri);
    if (!fileResponse.ok) throw new Error(`Failed to download file: ${fileResponse.status}`);
    return {
      buffer: await fileResponse.arrayBuffer(),
      contentType: fileResponse.headers.get('content-type') || '',
    };
  }

  function detectAudioFormat(buffer) {
    const bytes = new Uint8Array(buffer, 0, 12);
    const riff = String.fromCharCode(...bytes.subarray(0, 4));
    const wave = String.fromCharCode(...bytes.subarray(8, 12));
    return riff === 'RIFF' && wave === 'WAVE' ? 'wav' : 'other';
  }

  function guessExtension(format, contentType) {
    if (format === 'wav') return 'wav';
    if (contentType.includes('mp4') || contentType.includes('m4a')) return 'm4a';
    if (contentType.includes('flac')) return 'flac';
    return 'mp3';
  }

  function sanitizeFilename(name) {
    return name.replace(/[\\/:*?"<>|]/g, '_').trim() || 'track';
  }

  function resolveTrackPermalink(dropdownEl) {
    // Dropdowns are portaled away from the tile/row that opened them, so
    // they can't be found by DOM proximity. The trigger button links back
    // to its dropdown via aria-owns; from there, walk up to the tile/row
    // that owns the trigger and read the track link straight from it.
    // On the track's own hero page there's no such tile/row, so falling
    // back to the current page's URL is exactly the right answer there.
    const trigger = document.querySelector(`[aria-owns="${CSS.escape(dropdownEl.id)}"]`);
    const scope = trigger?.closest('.playableTile, .sound__body') ?? null;
    const link = scope?.querySelector('.playableTile__artworkLink, .sound__coverArt');
    const href = link?.getAttribute('href');
    return href ? new URL(href, location.origin).href : location.href;
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

  async function downloadFileWithMetadata(dropdownEl) {
    const trackUrl = resolveTrackPermalink(dropdownEl);
    const trackData = await fetchTrackData(trackUrl);
    let { buffer, contentType } = await fetchDownloadFile(trackData.id);

    const format = detectAudioFormat(buffer);
    if (format === 'wav') {
      buffer = mergeWavMetadata(buffer, {
        title: trackData.title,
        artist: trackData.artist,
        album: trackData.title,
      });
    }
    // Non-WAV formats (mp3, etc.) download unmodified for now; ID3 tagging
    // support is planned as a follow-up.

    const blob = new Blob([buffer]);
    triggerFileDownload(blob, `${sanitizeFilename(trackData.title)}.${guessExtension(format, contentType)}`);
  }

  function setIcon(button, svg) {
    (button._iconTarget || button).innerHTML = svg;
  }

  function showFeedback(button, isSuccess) {
    clearTimeout(button._feedbackTimer);
    button.classList.remove(STATE_SUCCESS_CLASS, STATE_FAILURE_CLASS);
    button.classList.add(isSuccess ? STATE_SUCCESS_CLASS : STATE_FAILURE_CLASS);
    setIcon(button, isSuccess ? ICON_SUCCESS : ICON_FAILURE);
    button._feedbackTimer = setTimeout(() => {
      button.classList.remove(STATE_SUCCESS_CLASS, STATE_FAILURE_CLASS);
      setIcon(button, ICON_IDLE);
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
          button.classList.remove(STATE_LOADING_CLASS);
          showFeedback(button, false);
        })
        .finally(() => {
          button.disabled = false;
        });
    });
  }

  function createButton() {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = BUTTON_CLASS;
    button.title = 'Copy artwork';
    button.setAttribute('aria-label', 'Copy artwork');
    button.innerHTML = ICON_IDLE;
    attachCopyHandler(button, copyArtwork);
    return button;
  }

  function insertButton() {
    if (document.querySelector(`.${BUTTON_CLASS}`)) return true;

    const rightSection = document.querySelector('.header__right');
    if (!rightSection) return false;

    const button = createButton();
    rightSection.insertBefore(button, rightSection.firstChild);
    return true;
  }

  function createTileButton(artworkEl, extraClasses, withShadow) {
    // Matches the structure/classes of the native action buttons alongside
    // it (Like/Follow/More on grid tiles, Like/Repost/Share/... on list
    // rows) so it lines up with them visually and inherits their existing
    // sizing and hover-to-reveal behavior for free.
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `${extraClasses} ${TILE_BUTTON_CLASS}${withShadow ? ` ${TILE_SHADOW_CLASS}` : ''}`;
    button.title = 'Copy artwork';
    button.setAttribute('aria-label', 'Copy artwork');

    const iconWrapper = document.createElement('div');
    iconWrapper.innerHTML = ICON_IDLE;
    button._iconTarget = iconWrapper;

    const label = document.createElement('span');
    label.className = 'sc-button-label sc-visuallyhidden';
    label.textContent = 'Copy artwork';

    button.append(iconWrapper, label);
    attachCopyHandler(button, () => copyArtworkFromTile(artworkEl));
    return button;
  }

  // Two distinct track layouts exist on the site: compact grid tiles
  // (.playableTile__artwork + .playableTile__actionWrapper, e.g. on
  // /you/likes' "Badges" view) and full list rows (.sound__artwork +
  // .soundActions .sc-button-group, e.g. the "List" view / stream). Each
  // needs its own artwork lookup and native button classes to match.
  const ACTION_ROW_CONFIGS = [
    {
      rowSelector: '.playableTile__actionWrapper',
      buttonClasses: 'playableTile__actionButton sc-button sc-button-small sc-button-icon',
      findArtwork: (rowEl) => rowEl.closest('.playableTile__artwork'),
      // This action row sits directly on top of the artwork image, so the
      // icon needs a contrast shadow. The "List" row's action row sits
      // below the artwork on the page background, so it doesn't.
      withShadow: true,
    },
    {
      rowSelector: '.soundActions .sc-button-group',
      buttonClasses: 'sc-button-secondary sc-button sc-button-medium sc-button-icon sc-button-responsive',
      findArtwork: (rowEl) => rowEl.closest('.sound__body')?.querySelector('.sound__artwork') ?? null,
      withShadow: false,
    },
  ];

  function insertTileButtons() {
    for (const config of ACTION_ROW_CONFIGS) {
      document.querySelectorAll(config.rowSelector).forEach((rowEl) => {
        if (rowEl.querySelector(`.${TILE_BUTTON_CLASS}`)) return;
        const artworkEl = config.findArtwork(rowEl);
        if (!artworkEl) return;
        rowEl.appendChild(createTileButton(artworkEl, config.buttonClasses, config.withShadow));
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

    const label = document.createElement('span');
    label.className = 'sc-button-label';
    label.textContent = 'Download file with metadata';

    button.append(iconWrapper, label);
    attachCopyHandler(button, () => downloadFileWithMetadata(dropdownEl));
    return button;
  }

  function insertDownloadButtons() {
    document.querySelectorAll('.moreActions__group').forEach((groupEl) => {
      if (groupEl.querySelector(`.${DOWNLOAD_BUTTON_CLASS}`)) return;
      const nativeDownloadButton = groupEl.querySelector('.sc-button-download');
      if (!nativeDownloadButton) return;
      const dropdownEl = groupEl.closest('.dropdownMenu');
      if (!dropdownEl) return;
      nativeDownloadButton.insertAdjacentElement('afterend', createDownloadButton(dropdownEl));
    });
  }

  // React re-renders header__middle after initial load and can wipe out
  // our injected button, so keep watching and reinsert whenever it's gone.
  // Likes/playlist lists are also lazy-loaded and append new tiles as the
  // user scrolls, so the same observer keeps those overlay buttons in sync.
  // "More" dropdowns are portaled in fresh each time they're opened, so
  // this also catches those as they appear.
  const observer = new MutationObserver(() => {
    insertButton();
    insertTileButtons();
    insertDownloadButtons();
  });
  observer.observe(document.body, { childList: true, subtree: true });
  insertButton();
  insertTileButtons();
  insertDownloadButtons();
})();
