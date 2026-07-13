// ==UserScript==
// @name         SoundCloud Menu Extension
// @namespace    https://github.com/hitsub/sc-jacket-extensions
// @version      0.3.0
// @description  トラックのタイル/行/単体ページ、またはMoreメニューからジャケット画像をコピーし、タイトル・アーティスト・アルバム・ジャケット画像タグが未設定のファイルをダウンロード時に自動で埋め込む（WAV/MP3/FLAC）
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
    // api-v2の各レスポンス形状（stream/likes/playlist/searchのコレクションは
    // それぞれ違う形でトラックオブジェクトをネストしている）を個別にハード
    // コーディングせず、汎用的に再帰スキャンする。両方のフィールドを持つ
    // オブジェクトはすべてトラックとみなす。
    if (!value || typeof value !== 'object' || depth > 6) return;
    if (Array.isArray(value)) {
      value.forEach((item) => recordDownloadableInfo(item, depth + 1));
      return;
    }
    if (typeof value.permalink_url === 'string' && typeof value.downloadable === 'boolean') {
      const path = permalinkPath(value.permalink_url);
      // downloadableはトラックのダウンロード数上限（download_count）を
      // 使い切った後もtrueのままになりうる — 実際にネイティブの
      // 「Download file」項目が出るかどうかはhas_downloads_leftで決まる。
      if (path) downloadableByPath.set(path, value.downloadable && value.has_downloads_left !== false);
    }
    for (const key of Object.keys(value)) {
      recordDownloadableInfo(value[key], depth + 1);
    }
  }

  function patchFetchForDownloadableInfo() {
    // 表示中の各トラックについて追加のリクエストを投げるのではなく、
    // SoundCloud自身のアプリがトラック一覧描画のためにすでに取得している
    // JSON（stream/likes/playlist/searchはすべてapi-v2経由）を横から読む。
    // ページ自身のスクリプトがこれらの呼び出しを始める前に組み込む必要が
    // あるため、@run-at document-startにしている。
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
    // SoundCloud自身の一覧取得リクエスト（track_likesなど）はfetchではなく
    // XMLHttpRequest経由であることが判明したため、同様の横読み処理が必要。
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
            // JSONでない、または対象の形状でない場合は無視する。
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
  // グリッド（Badges）タイルのMoreボタンはジャケット画像の真上に乗るため
  // （コピー用ボタンと同様に）、他の箇所で使うアウトラインではなく従来の
  // アイコン色変更の方式を維持する。
  const MORE_BUTTON_ICON_HIGHLIGHT_CLASS = 'scArtworkCopy__moreButton--hasDownloadIcon';
  const INLINE_DOWNLOAD_ICON_CLASS = 'scArtworkCopy__inlineDownloadIcon';
  const PURCHASE_LINK_DOMAIN_CLASS = 'scArtworkCopy__purchaseLinkDomain';
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
  // Font Awesome Free 6.7.2の「clipboard」（塗りつぶし）アイコン — CC BY 4.0。
  const ICON_CLIPBOARD_SOLID = '<svg viewBox="0 0 384 512" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path fill="currentColor" d="M192 0c-41.8 0-77.4 26.7-90.5 64L64 64C28.7 64 0 92.7 0 128L0 448c0 35.3 28.7 64 64 64l256 0c35.3 0 64-28.7 64-64l0-320c0-35.3-28.7-64-64-64l-37.5 0C269.4 26.7 233.8 0 192 0zm0 64a32 32 0 1 1 0 64 32 32 0 1 1 0-64zM112 192l160 0c8.8 0 16 7.2 16 16s-7.2 16-16 16l-160 0c-8.8 0-16-7.2-16-16s7.2-16 16-16z"/></svg>';

  const style = document.createElement('style');
  style.textContent = `
    .${DOWNLOAD_BUTTON_CLASS},
    .${DOWNLOAD_BUTTON_CLASS} svg,
    .${DOWNLOAD_BUTTON_CLASS} svg *,
    .${DOWNLOAD_BUTTON_CLASS} .sc-button-label {
      color: #ff5500 !important;
      fill: #ff5500 !important;
    }
    .${MORE_BUTTON_HIGHLIGHT_CLASS} {
      /* マイナスのoffsetでアウトラインをボタンの内側に描く（外側にはみ出す
         box-shadow/outlineは、リスト行の詰まったボタングループによって
         不均一に切り取られてしまっていた）。 */
      outline: 2px solid #ff5500 !important;
      outline-offset: -2px;
    }
    .${MORE_BUTTON_ICON_HIGHLIGHT_CLASS},
    .${MORE_BUTTON_ICON_HIGHLIGHT_CLASS} svg,
    .${MORE_BUTTON_ICON_HIGHLIGHT_CLASS} svg * {
      color: #ff5500 !important;
      fill: #ff5500 !important;
    }
    /* 上で強制しているcolor/fillがネイティブボタン自身の:hoverフェードを
       妨げてしまうため、隣のボタン（Like/Follow/Moreなど）と挙動を揃える
       ために同じフェードを明示的に再定義する。 */
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
    /* 行自体のホバー状態になると、このアイコンと同じ場所にSoundCloud側の
       オーバーレイ/メニューが表示され、見た目もクリックも競合してしまう
       ため、対抗せずに表示中はこのアイコンを隠す。同じオーバーレイは
       再生中の行（"active"クラスが付く）でもホバーなしで表示され続ける。 */
    .trackItem:hover .${INLINE_DOWNLOAD_ICON_CLASS},
    .trackItem.active .${INLINE_DOWNLOAD_ICON_CLASS} {
      display: none;
    }
    /* デフォルトではflexコンテナではないため、そのままだと唯一の子要素
       （リンク）と追加したドメインバッジが横並びにならず縦に積まれて
       しまう。 */
    .purchaseLink__container {
      display: inline-flex !important;
      align-items: center !important;
    }
    .${PURCHASE_LINK_DOMAIN_CLASS} {
      margin-left: 4px;
      font-size: 11px;
      color: var(--secondary-text-color, #999) !important;
      white-space: nowrap;
      vertical-align: middle;
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
    // 英語のcode/paramsの組み合わせを.messageに残しておくことで、言語設定に
    // 関わらずconsole.errorの出力がデバッグに使える状態を保つ。トースト用の
    // ローカライズ文言は.codeから別途引く。
    const err = new Error(params ? `${code} ${JSON.stringify(params)}` : code);
    err.code = code;
    err.params = params || {};
    throw err;
  }

  function getUiLang() {
    return (navigator.language || 'en').slice(0, 2).toLowerCase();
  }

  function localizeError(err) {
    const entry = ERROR_MESSAGES[err?.code] || ERROR_MESSAGES.UNKNOWN;
    const translate = entry[getUiLang()] || entry.en;
    return translate(err?.params || {});
  }

  function localizeTooltip(en, ja) {
    return getUiLang() === 'ja' ? ja : en;
  }

  function getHighResUrl(baseUrl) {
    // Webアプリ自身が描画するDOMは"-t{width}x{height}"（例: -t500x500）を
    // 使うが、/resolve APIのartwork_urlフィールドはSoundCloudの古い
    // "-large"表記を使う — どちらにもマッチさせる。
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
    // クリップボードへの書き込みが保証されるのはimage/pngのみ。一部の
    // ジャケット画像（特に"-original"の高解像度版が無いもの）は
    // image/jpegで配信されており、ブラウザによっては書き込みを拒否する。
    if (blob.type !== 'image/png') blob = await convertBlobToPng(blob);
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
  }

  async function copyArtwork() {
    // ページ自身のHTMLをfetch()してmetaタグを読む方式ではなく、ダウンロード
    // 機能と同じapi-v2の/resolve呼び出しを経由する。そのHTML fetchこそが
    // 断続的にm.soundcloud.comへリダイレクトされCORSでブロックされていた
    // もの（SoundCloudのbot対策）。
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
    // ジャケット画像を包む<div>にも"sc-artwork"クラスが付いているが、
    // background-imageのインラインstyleを持つのは内側の<span>だけなので、
    // そのspanに絞って探す。
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
    let offset = 12; // "RIFF" + size + "WAVE" をスキップ
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
    let offset = infoChunk.dataStart + 4; // "INFO" のlist-typeマーカーをスキップ
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
    // 最上位のRIFFサイズフィールドはそれ以降の全体を表すので、ファイル全体の
    // 長さが変わるたびに補正が必要。
    new DataView(spliced.buffer).setUint32(4, spliced.byteLength - 8, true);
    return spliced.buffer;
  }

  async function mergeWavMetadata(buffer, fields) {
    let chunks = parseWavChunks(buffer);
    const existingInfo = findInfoChunk(buffer, chunks);
    const existingValues = existingInfo ? readInfoValues(buffer, existingInfo) : {};

    // ファイルにまだ設定されていない項目だけを埋める。
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

    // WAV自体のLIST/INFOチャンクにはジャケット画像の規約が無いため、
    // ジャケット画像（および、このチャンクしか読まないプレイヤー向けに
    // 重複して同じテキスト項目も）は、非標準だがffmpeg/mutagenが認識する
    // "id3 "チャンク（中身は丸ごとID3v2タグ、MP3側と同じフォーマット/
    // フレーム）に入れる。上のspliceでチャンクのオフセットがずれるため、
    // 先に再パースする。
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
      // UTF-16。先頭にBOMが付いている場合と付いていない場合がある。
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
    // 保持したいフレーム（TIT2/TALB/TPE1/TCON/APIC）だけを読む。
    // browser-id3-writerは常にこちらが設定した内容から新規にタグを
    // 組み立てるため、タグ内のそれ以外の情報は意図的に引き継がない。
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
    // seedBufferは、実際のMP3にタグを付ける場合は本物のMP3バイト列
    // （書き換え後も音声データが残るように）、タグ単体のバイト列だけが
    // 欲しい場合（WAVの"id3 "チャンクに埋め込む場合など）は空のバッファ。
    // 使用前にソースをレビュー済みの、特定バージョンに固定している。
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
    let offset = 4; // "fLaC" のマジックナンバーをスキップ
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
    // メタデータブロックのヘッダーとPICTUREブロックはビッグエンディアン
    // だが、Vorbisコメントのフィールドはリトルエンディアン — 元のOgg
    // Vorbisコメント仕様をそのまま引き継いだ挙動。
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
    offset += 4 + descLength; // description（説明文）は引き継がない
    offset += 16; // width, height, color depth, indexed-color count（幅・高さ・色深度・インデックスカラー数）
    const dataLength = view.getUint32(offset, false);
    offset += 4;
    return { pictureType, mimeType, data: new Uint8Array(buffer, offset, dataLength) };
  }

  function buildFlacMetadataBlock(type, data) {
    // 最終的なブロックの並び順が確定した時点でlast-blockフラグを調整する
    // ので、ここでは常にクリアした状態で組み立てる。
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
      be32(0), // description（説明文）なし
      new Uint8Array(16), // width, height, color depth, indexed-color count（幅・高さ・色深度・インデックスカラー数）: 不明
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

    // STREAMINFO（type 0）は必ず先頭に置く。それ以外（PADDING、
    // APPLICATION、SEEKTABLE、CUESHEETなど）はそのまま残し、コメント/
    // ピクチャーブロックだけを、以前あったものを置き換える形でSTREAMINFO
    // の直後に挿入する。
    const original = new Uint8Array(buffer);
    const keptBlocks = blocks.filter((b) => b.type !== 4 && b.type !== 6).map((b) => original.slice(b.start, b.start + 4 + b.length));

    const newBlocks = [
      keptBlocks[0], // STREAMINFOブロック
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
    // ダウンロード用エンドポイントなどのapi-v2エンドポイントは、
    // client_id + cookieに加えてこれも必要とする。httpOnlyではないので
    // ここから読み取れる。
    const match = document.cookie.match(/(?:^|;\s*)oauth_token=([^;]+)/);
    return match ? decodeURIComponent(match[1]) : null;
  }

  function authHeaders() {
    const token = getOAuthToken();
    return token ? { Authorization: `OAuth ${token}` } : {};
  }

  async function fetchTrackData(url) {
    // トラックのHTMLページを単純にfetch()するとm.soundcloud.comへ
    // リダイレクトされCORSでブロックされる — SoundCloudのbot対策
    // （DataDome）が、今まさに見ているページであってもスクリプトからの
    // ページHTML取得をフラグ立てしているようだ。api-v2のresolve
    // エンドポイントは、ダウンロード用エンドポイントですでにうまく
    // いっているのと同種のAJAX呼び出しで、トラックのJSONを直接返して
    // くれる（HTML/hydrationのパースが不要）。
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
    // トラックIDと違い、client_id/app_versionはトラックごとではなく
    // セッション単位の値なので、今表示しているページ自身のグローバル
    // 変数は常に最新。
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

    const isFlac = bytes[0] === 0x66 && bytes[1] === 0x4c && bytes[2] === 0x61 && bytes[3] === 0x43; // "fLaC" のマジックナンバー
    if (isFlac || contentType.includes('flac')) return 'flac';

    const isId3 = bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33; // "ID3" のマジックナンバー
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
    // トラック自身の単体ページでは、トリガーを包むタイル/行が存在しない
    // ため、現在のページURLにフォールバックするのがそこでは正解になる。
    // プレイリストのトラック行（.trackItem）は他の2パターンと一致する
    // ジャケット/タイトルリンクを持たないため、専用のリンクセレクタ
    // （.trackItem__trackTitle）が必要。
    const scope = triggerEl?.closest('.playableTile, .sound__body, .trackItem') ?? null;
    const link = scope?.querySelector('.playableTile__artworkLink, .sound__coverArt, .trackItem__trackTitle');
    const href = link?.getAttribute('href');
    return href ? new URL(href, location.origin).href : location.href;
  }

  function resolveTrackPermalink(dropdownEl) {
    // ドロップダウンは、それを開いたタイル/行とは別の場所にポータル
    // されるため、DOM上の近さでは見つけられない。トリガーボタンは
    // aria-ownsで自分のドロップダウンと紐づいているので、そこから
    // トリガーを持つタイル/行まで遡り、トラックへのリンクを直接読む。
    const trigger = document.querySelector(`[aria-owns="${CSS.escape(dropdownEl.id)}"]`);
    return permalinkFromScope(trigger);
  }

  function createInlineDownloadIcon() {
    // ボタンにはしない: 行自体のホバー状態になると、この同じ場所を覆う
    // ネイティブのオーバーレイ/メニューが出てクリックを奪ってしまうため、
    // これは操作可能な要素ではなく純粋な視覚的インジケーターとする。
    const icon = document.createElement('span');
    icon.className = INLINE_DOWNLOAD_ICON_CLASS;
    icon.title = 'Downloadable';
    icon.setAttribute('aria-label', 'Downloadable');
    icon.innerHTML = ICON_DOWNLOAD;
    return icon;
  }

  function insertInlinePlaylistDownloadIcon(trigger) {
    // プレイリストの行は密集していて、ホバーで出てくる「More」ボタンだけ
    // では見つけにくいと判断したため、既にダウンロード可能と分かっている
    // トラックについては、代わりに再生回数の左に常時表示のインジケーター
    // を出す。
    const row = trigger.closest('.trackItem');
    if (!row || row.querySelector(`.${INLINE_DOWNLOAD_ICON_CLASS}`)) return;
    const playCount = row.querySelector('.trackItem__playCount');
    if (!playCount) return;
    playCount.insertAdjacentElement('beforebegin', createInlineDownloadIcon());
  }

  function markTriggerDownloadable(trigger) {
    // グリッドタイルのMoreボタンはジャケット画像の上に乗っているため、
    // 他の箇所で使うアウトラインではなくアイコン色変更の方式を維持する。
    const isGridTile = !!trigger.closest('.playableTile__actionWrapper');
    trigger.classList.add(isGridTile ? MORE_BUTTON_ICON_HIGHLIGHT_CLASS : MORE_BUTTON_HIGHLIGHT_CLASS);
    insertInlinePlaylistDownloadIcon(trigger);
  }

  function clearTriggerDownloadableState(trigger) {
    // SPAナビゲーションでは、まったく同じ「More」トリガー要素が別の
    // トラックのために使い回されることがある（例えば、あるトラック単体
    // ページから別のトラック単体ページへ直接遷移する場合）。そのため、
    // この要素が以前どのトラックのためにマークされていたとしても、
    // 永久に信用せず、再評価の前にハイライトを消しておく必要がある。
    trigger.classList.remove(MORE_BUTTON_HIGHLIGHT_CLASS, MORE_BUTTON_ICON_HIGHLIGHT_CLASS);
    trigger.closest('.trackItem')?.querySelector(`.${INLINE_DOWNLOAD_ICON_CLASS}`)?.remove();
  }

  function highlightDownloadableTriggers() {
    // insertDownloadButtons()の「開いてからハイライトする」フォールバック
    // を補完するもの: 「More」ボタンが一度も開かれていなくても、横読みで
    // 集めたデータがダウンロード可能だと示した時点で発火する。
    if (downloadableByPath.size === 0) return;
    document.querySelectorAll('.sc-button-more').forEach((trigger) => {
      const path = permalinkPath(permalinkFromScope(trigger));
      if (trigger.dataset.scDownloadPath === path) return; // このトラックについてはすでに評価済み
      trigger.dataset.scDownloadPath = path || '';
      if (path && downloadableByPath.get(path)) markTriggerDownloadable(trigger);
      else clearTriggerDownloadableState(trigger);
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
    // それ以外の形式（m4aなど）は無加工でダウンロードされる — 同等の
    // メタデータ対応はまだ実装していない。

    const blob = new Blob([buffer]);
    triggerFileDownload(blob, `${sanitizeFilename(trackData.title)}.${guessExtension(format, contentType)}`);
  }

  function setIcon(button, svg) {
    (button._iconTarget || button).innerHTML = svg;
  }

  function attachSoundCloudTooltip(el, text) {
    // SoundCloud自身のツールチップのクラス/マークアップ（矢印＋吹き出し）
    // を再利用することで、サイト既存のCSSをそのまま活かす。ネイティブの
    // `title`属性が出すような素のOSツールチップは使わない。
    let tooltipEl = null;

    const show = () => {
      tooltipEl = document.createElement('div');
      tooltipEl.setAttribute('role', 'tooltip');
      tooltipEl.className = 'tooltip g-z-index-overlay g-opacity-transition sc-selection-disabled';
      tooltipEl.style.position = 'absolute';
      tooltipEl.style.width = 'auto';
      tooltipEl.style.minHeight = 'auto';

      const arrow = document.createElement('div');
      arrow.className = 'tooltip__arrow';
      const content = document.createElement('div');
      content.className = 'tooltip__content sc-text-captions';
      content.textContent = text;
      tooltipEl.append(arrow, content);
      document.body.appendChild(tooltipEl);

      const elRect = el.getBoundingClientRect();
      const tooltipRect = tooltipEl.getBoundingClientRect();
      // SoundCloud自身のツールチップは、トリガーの下側に矢印を上向きに
      // して表示される（矢印自体の向きは向こうのCSSで固定されており、
      // インスタンスごとに制御できるものではない）。
      tooltipEl.style.top = `${elRect.bottom + window.scrollY + 12}px`;
      tooltipEl.style.left = `${elRect.left + window.scrollX + elRect.width / 2 - tooltipRect.width / 2}px`;

      requestAnimationFrame(() => tooltipEl?.classList.add('m-is-visible'));
    };

    const hide = () => {
      tooltipEl?.remove();
      tooltipEl = null;
    };

    el.addEventListener('mouseenter', show);
    el.addEventListener('mouseleave', hide);
    el.addEventListener('blur', hide);
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
      // 各ボタンは自分自身のアイドル時アイコンを覚えている —
      // ダウンロードボタンのアイドル時アイコンは、コピー系ボタンが使う
      // クリップボードアイコンとは異なる。
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
    // 隣に並ぶネイティブのアクションボタン（グリッドタイルなら
    // Like/Follow/More、リスト行や単体ページならLike/Repost/Share/...）
    // と同じ構造/クラスにすることで、見た目を揃え、既存のサイズ調整や
    // ホバー時に表示する挙動をそのまま引き継ぐ。
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `${extraClasses} ${TILE_BUTTON_CLASS}`;
    button.setAttribute('aria-label', 'Copy artwork');
    attachSoundCloudTooltip(button, localizeTooltip('Copy Artwork', 'ジャケット画像をコピー'));

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

  // サイトには4種類の異なるトラックのレイアウトが存在する: コンパクトな
  // グリッドタイル（.playableTile__artwork + .playableTile__actionWrapper、
  // 例: /you/likesの「Badges」表示）、フルサイズのリスト行
  // （.sound__artwork + .soundActions .sc-button-group、例: 「List」表示
  // やstream）、プレイリストのトラック行（.trackItem__image +
  // .soundActions .sc-button-group、例: /sets/...ページ）、そしてトラック
  // 自身の単体ページ（.listenEngagement__footer .soundActions
  // .sc-button-group — リスト行と同じボタングループのマークアップだが
  // .sound__bodyタイル/行には包まれていない）。それぞれについて、コピー
  // 関数の解決方法とマッチさせるネイティブボタンのクラスが個別に必要。
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
      // アウトラインアイコン（単体ページと同じ）を使う。タイルオーバーレイ
      // のFont Awesomeの塗りつぶしアイコンは、ジャケット画像の真上に乗る
      // グリッド表示専用にしている。
      icon: ICON_IDLE,
    },
    {
      // プレイリストのトラック行は「List」表示と同じsoundActions
      // ボタングループのマークアップを再利用しているが、.sound__body
      // ではなく.trackItem（ジャケット画像は.trackItem__image）で包まれて
      // おり、サイズクラスも1段階小さい（-mediumではなくsc-button-small）。
      rowSelector: '.trackItem .soundActions .sc-button-group',
      buttonClasses: 'sc-button-secondary sc-button sc-button-small sc-button-icon sc-button-responsive',
      resolveCopy: (rowEl) => {
        const artworkEl = rowEl.closest('.trackItem')?.querySelector('.trackItem__image') ?? null;
        return artworkEl ? () => copyArtworkFromTile(artworkEl) : null;
      },
      icon: ICON_IDLE,
    },
    {
      // 単体ページのアクション行は.sound__bodyタイル/行の中には無いため、
      // 手がかりにできるDOM上のジャケット画像要素が存在しない —
      // location.href自体がこのトラック自身のページなので、以前のヘッダー
      // ボタンと同じapi-v2ベースの取得方法であるcopyArtwork()を再利用する。
      rowSelector: '.listenEngagement__footer .soundActions .sc-button-group',
      buttonClasses: 'sc-button-secondary sc-button sc-button-medium sc-button-icon sc-button-responsive',
      resolveCopy: () => copyArtwork,
      // タイルオーバーレイのFont Awesomeクリップボードアイコンではなく、
      // 以前のヘッダーボタンと同じアイコンを使う。
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
    // 見た目を揃えるため、ネイティブの「Download file」ボタンと同じ
    // クラスを使う。ただし"sc-button-download"自体は、サイト側でJSの
    // 挙動フックにもなっていると思われるため、意図的に外している。
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

  function extractLinkDomain(href) {
    try {
      const url = new URL(href, location.origin);
      // 購入リンクはゲート/リダイレクトサービス（例: gate.sc）経由に
      // なっていることが多く、本来の遷移先は"url"クエリパラメータに
      // 格納されている — ゲート自身のドメインではなくそちらを表示する。
      const wrapped = url.searchParams.get('url');
      if (wrapped) {
        try {
          return new URL(wrapped).hostname.replace(/^www\./, '');
        } catch {
          // wrappedの値が有効な絶対URLではなかった場合はそのまま続行する。
        }
      }
      return url.hostname.replace(/^www\./, '');
    } catch {
      return null;
    }
  }

  function insertPurchaseLinkDomains() {
    document.querySelectorAll('.soundActions__purchaseLink').forEach((link) => {
      if (link.nextElementSibling?.classList.contains(PURCHASE_LINK_DOMAIN_CLASS)) return;
      const href = link.getAttribute('href');
      const domain = href && extractLinkDomain(href);
      if (!domain) return;
      const badge = document.createElement('span');
      badge.className = PURCHASE_LINK_DOMAIN_CLASS;
      badge.textContent = domain;
      // リンク自身はアイコンサイズの小さなボックスなので（内側に追加
      // すると見えない形でクリップされてしまった）、代わりにその外側の
      // 兄弟要素として置く — それだけでは横並びにするのに不十分な理由は
      // 下の.purchaseLink__containerのCSS上書きを参照。
      link.insertAdjacentElement('afterend', badge);
    });
  }

  function insertDownloadButtons() {
    document.querySelectorAll('.moreActions__group').forEach((groupEl) => {
      const nativeDownloadButton = groupEl.querySelector('.sc-button-download');
      if (!nativeDownloadButton) return;
      const dropdownEl = groupEl.closest('.dropdownMenu');
      if (!dropdownEl) return;

      // ダウンロード可否は、ドロップダウンが実際に開かれた時点で初めて
      // 分かる（開くたびに新しくポータルされるため）ので、事前にではなく
      // ここでトリガーボタンをマークする — resolveTrackPermalink()と
      // 同じaria-owns相関を使う。
      const trigger = document.querySelector(`[aria-owns="${CSS.escape(dropdownEl.id)}"]`);
      if (trigger) {
        // pathも記録しておくことで、highlightDownloadableTriggers()が
        // このトリガーは現在のトラックについてすでに正しく確定済みだと
        // 認識し、すぐに再評価して（誤って）クリアしてしまうのを防ぐ。
        trigger.dataset.scDownloadPath = permalinkPath(permalinkFromScope(trigger)) || '';
        markTriggerDownloadable(trigger);
      }

      if (groupEl.querySelector(`.${DOWNLOAD_BUTTON_CLASS}`)) return;
      nativeDownloadButton.insertAdjacentElement('afterend', createDownloadButton(dropdownEl));
    });
  }

  whenDomReady(() => {
    document.head.appendChild(style);

    // 初回ページ読み込み時のトラック一覧（/likesの最初の一括分など）は、
    // このhydrationデータに直接埋め込まれていて、こちらのfetchパッチで
    // 監視できる後続のAJAX呼び出しでは取得されないことが多いので、こちら
    // も一度だけスキャンしておく。SPAナビゲーションでは更新されないが、
    // その頃にはfetchパッチが読み込み中の新しいデータを既に捕捉している。
    recordDownloadableInfo(window.__sc_hydration);

    // Reactの再描画によって挿入したボタンが消えてしまうため、監視を続けて
    // 消えるたびに再挿入する。likes/プレイリストの一覧も遅延読み込みで
    // スクロールに応じて新しいタイルが追加されるため、同じobserverで
    // オーバーレイボタンの整合性を保つ。「More」ドロップダウンも開かれる
    // たびに新しくポータルされるため、これも同様にここで捕捉する。
    const observer = new MutationObserver(() => {
      insertTileButtons();
      insertDownloadButtons();
      highlightDownloadableTriggers();
      insertPurchaseLinkDomains();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    insertTileButtons();
    insertDownloadButtons();
    highlightDownloadableTriggers();
    insertPurchaseLinkDomains();
  });
})();
