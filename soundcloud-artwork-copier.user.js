// ==UserScript==
// @name         SoundCloud Artwork Copier & Metadata Downloader
// @namespace    https://github.com/hitsub/sc-jacket-extensions
// @version      0.2.0
// @description  Copy track artwork from the header, track tiles/rows, or the More menu, and download files with missing title/artist/album/artwork tags filled in automatically (WAV/MP3/FLAC)
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
    // Only reads the frames we care about preserving (TIT2/TALB/TPE1/APIC);
    // anything else in the tag is intentionally not round-tripped since
    // browser-id3-writer always builds a brand-new tag from what we set.
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

      if (frameId === 'TIT2' || frameId === 'TALB' || frameId === 'TPE1') {
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
    if (!response.ok) throw new Error(`Failed to fetch artwork: ${response.status}`);
    return { data: await response.arrayBuffer(), mimeType: response.headers.get('content-type') || 'image/jpeg' };
  }

  async function mergeMp3Metadata(buffer, fields) {
    const existing = parseExistingId3(buffer);

    // Pinned to the exact version whose source was reviewed before use.
    const { ID3Writer } = await import(
      'https://unpkg.com/browser-id3-writer@6.3.1/dist/browser-id3-writer.mjs'
    );
    const writer = new ID3Writer(buffer);
    writer.setFrame('TIT2', existing.TIT2 || fields.title);
    const album = existing.TALB || fields.album;
    if (album) writer.setFrame('TALB', album);
    const artist = existing.TPE1 || fields.artist;
    if (artist) writer.setFrame('TPE1', [artist]);

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
    if (!response.ok) throw new Error(`Failed to resolve track: ${response.status}`);
    const sound = await response.json();
    if (sound.kind !== 'track') throw new Error('Not a track');

    return {
      id: sound.id,
      title: sound.title || 'track',
      artist: sound.user?.username || sound.user?.full_name || '',
      artworkUrl: sound.artwork_url || null,
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
    const apiResponse = await fetch(apiUrl, { credentials: 'include', headers: authHeaders() });
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

    const format = detectAudioFormat(buffer, contentType);
    if (format === 'wav') {
      buffer = mergeWavMetadata(buffer, {
        title: trackData.title,
        artist: trackData.artist,
        album: trackData.title,
      });
    } else if (format === 'mp3') {
      buffer = await mergeMp3Metadata(buffer, {
        title: trackData.title,
        artist: trackData.artist,
        album: trackData.title,
        artworkUrl: trackData.artworkUrl,
      });
    } else if (format === 'flac') {
      buffer = await mergeFlacMetadata(buffer, {
        title: trackData.title,
        artist: trackData.artist,
        album: trackData.title,
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
