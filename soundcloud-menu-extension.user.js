// ==UserScript==
// @name         SoundCloud Menu Extension
// @namespace    https://github.com/hitsub/soundcloud-extension/
// @version      0.5.0
// @description  トラックのタイル/行/単体ページ、またはMoreメニューからジャケット画像をコピーし、タイトル・アーティスト・アルバム・ジャケット画像タグが未設定のファイルをダウンロード時に自動で埋め込む（WAV/MP3/FLAC）
// @author       hitsub
// @match        *://soundcloud.com/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  const downloadableByPath = new Map();
  const purchaseUrlByPath = new Map();
  const descriptionByPath = new Map();

  function permalinkPath(url) {
    try {
      return new URL(url, location.origin).pathname.replace(/\/$/, '');
    } catch {
      return null;
    }
  }

  function recordDownloadableInfo(value, depth = 0) {
    // api-v2の各レスポンス形状（stream/likes/playlist/
    // searchのコレクションはそれぞれ違う形でトラックオブジェクトをネストしている）
    // を個別にハードコーディングせず、
    // 汎用的に再帰スキャンする。
    // 両方のフィールドを持つオブジェクトはすべてトラックとみなす。
    if (!value || typeof value !== 'object' || depth > 6) return;
    if (Array.isArray(value)) {
      value.forEach((item) => recordDownloadableInfo(item, depth + 1));
      return;
    }
    if (typeof value.permalink_url === 'string') {
      const path = permalinkPath(value.permalink_url);
      if (path) {
        // downloadableを持たないオブジェクト（purchase_urlだけ乗っている
        // プレイリストのトラック要約など）もあるため、downloadableの記録と
        // purchase_urlの記録は互いに独立させる — 片方が条件付きだからと
        // いって、もう片方まで一緒にスキップしてはいけない。
        if (typeof value.downloadable === 'boolean') {
          // downloadableはトラックのダウンロード数上限（download_count）
          // を使い切った後もtrueのままになりうる —
          // 実際にネイティブの「Download file」項目が出るかどうかはhas_downloads_leftで決まる。
          downloadableByPath.set(path, value.downloadable && value.has_downloads_left !== false);
        }
        // purchase_urlはプレイリストのリストビューではSoundCloud自身が
        // カートアイコンを描画しないため、DOMからは取得できない。
        // ただしこの同じレスポンスJSONには乗っているので、ここで一緒に拾う。
        if (value.purchase_url) purchaseUrlByPath.set(path, value.purchase_url);
        // descriptionは初回表示分（window.__sc_hydration）の軽量なトラック要約には
        // 乗っておらず、スクロールで追加読み込みされるapi-v2レスポンスにのみ含まれる
        // ことを確認済み（初回表示分では拾えない）。
        if (typeof value.description === 'string' && value.description.trim()) {
          descriptionByPath.set(path, value.description);
        }
      }
    }
    for (const key of Object.keys(value)) {
      recordDownloadableInfo(value[key], depth + 1);
    }
  }

  function patchFetchForDownloadableInfo() {
    // 表示中の各トラックについて追加のリクエストを投げるのではなく、
    // SoundCloud自身のアプリがトラック一覧描画のためにすでに取得しているJSON（stream/likes/playlist/
    // searchはすべてapi-v2経由）
    // を横から読む。
    // ページ自身のスクリプトがこれらの呼び出しを始める前に組み込む必要があるため、
    // @run-at document-startにしている。
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
    // SoundCloud自身の一覧取得リクエスト（track_likesなど）
    // はfetchではなくXMLHttpRequest経由であることが判明したため、
    // 同様の横読み処理が必要。
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
  // グリッド（Badges）タイルのMoreボタンはジャケット画像の真上に乗るため（コピー用ボタンと同様に）、
  // 他の箇所で使うアウトラインではなく従来のアイコン色変更の方式を維持する。
  const MORE_BUTTON_ICON_HIGHLIGHT_CLASS = 'scArtworkCopy__moreButton--hasDownloadIcon';
  // BuyLinkのみ（ダウンロード不可）の場合の白いハイライト。ダウンロード可能
  // でもある場合は、上のオレンジ系クラスが優先され、こちらは付与されない。
  // Playlist/Station（.trackItem）のMoreボタンにしか付かないため、グリッド
  // タイル用のアイコン色変更バリアントは不要（アウトラインのみで足りる）。
  const MORE_BUTTON_PURCHASE_HIGHLIGHT_CLASS = 'scArtworkCopy__moreButton--hasPurchaseLink';
  // グリッド（Badges）タイルはMoreボタン自体をアウトラインできない代わりに、
  // ジャケット画像そのものを囲む。優先順位はMoreボタンの色分けと同じ
  // （ダウンロード可能なら常にこちらが優先、BuyLinkのみなら白系）。
  // .playableTile__artworkに直接outlineを当てると、中の画像レイヤーが
  // （おそらくホバー拡大用のtransform/will-changeで）独自の合成レイヤーを
  // 持っており、その下に潜って見えなくなってしまった。そのため専用の
  // オーバーレイ要素（TILE_ARTWORK_OUTLINE_CLASS）を最後の子として挿入し、
  // 明示的なz-indexで確実に画像より前面に来るようにする。
  const TILE_ARTWORK_OUTLINE_CLASS = 'scArtworkCopy__tileArtworkOutline';
  const TILE_ARTWORK_DOWNLOAD_HIGHLIGHT_CLASS = 'scArtworkCopy__tileArtwork--hasDownload';
  const TILE_ARTWORK_PURCHASE_HIGHLIGHT_CLASS = 'scArtworkCopy__tileArtwork--hasPurchaseLink';
  const INLINE_DOWNLOAD_ICON_CLASS = 'scArtworkCopy__inlineDownloadIcon';
  const INLINE_PURCHASE_ICON_CLASS = 'scArtworkCopy__inlinePurchaseIcon';
  const BUY_LINK_BUTTON_CLASS = 'scArtworkCopy__buyLinkButton';
  const PURCHASE_LINK_WRAPPER_CLASS = 'scArtworkCopy__purchaseLinkWrapper';
  const PURCHASE_LINK_DOMAIN_CLASS = 'scArtworkCopy__purchaseLinkDomain';
  // 行によって再生数などまでの余白が変わるため、実測して当てる際の下限とマージン。
  const PURCHASE_LINK_DOMAIN_MIN_WIDTH_PX = 40;
  const PURCHASE_LINK_DOMAIN_SAFETY_MARGIN_PX = 8;
  const DESCRIPTION_LINK_WRAPPER_CLASS = 'scArtworkCopy__descriptionLinkWrapper';
  const DESCRIPTION_LINK_BUTTON_CLASS = 'scArtworkCopy__descriptionLinkButton';
  const DESCRIPTION_LINK_MORE_CLASS = 'scArtworkCopy__descriptionLinkMore';
  // 再生数などの隣接表示までの余白を実測できない文脈でのみ使うフォールバックの固定件数。
  const MAX_VISIBLE_DESCRIPTION_LINKS = 3;
  const DESCRIPTION_LINK_SAFETY_MARGIN_PX = 8;
  // SNS/SoundCloud自身へのリンクはほぼ全トラックの説明文に定型文として入っており、
  // 個別のリンクとして目立たせる価値が薄いため除外する。
  const DESCRIPTION_LINK_EXCLUDED_DOMAINS = new Set([
    'x.com',
    'twitter.com',
    'soundcloud.com',
    'on.soundcloud.com',
    'instagram.com',
    'facebook.com',
    'youtube.com',
    'youtu.be',
    'discord.com',
    'discord.gg',
    'ffm.bio',
    'tiktok.com',
  ]);
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
  // Feather Icons「shopping-cart」— MIT License。
  const ICON_CART = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><circle cx="9" cy="21" r="1"></circle><circle cx="20" cy="21" r="1"></circle><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"></path></svg>';

  const style = document.createElement('style');
  style.textContent = `
    .${DOWNLOAD_BUTTON_CLASS},
    .${DOWNLOAD_BUTTON_CLASS} svg,
    .${DOWNLOAD_BUTTON_CLASS} svg *,
    .${DOWNLOAD_BUTTON_CLASS} .sc-button-label {
      color: #ff5500 !important;
      fill: #ff5500 !important;
    }
    /* BuyLinkはアイコンだけオレンジにし、ラベルはネイティブの色のまま
       残す — 両方オレンジだと目立ちすぎ、逆に無色だと既存メニューに
       埋もれてしまうため。 */
    .${BUY_LINK_BUTTON_CLASS} svg,
    .${BUY_LINK_BUTTON_CLASS} svg * {
      color: #ff5500 !important;
      fill: #ff5500 !important;
    }
    /* カートアイコン（Feather Icons）は同じ24x24のviewBoxでも図形が
       枠いっぱいに描かれているため、ネイティブサイズのままだと
       「Download file with metadata」のアイコンより大きく見える。 */
    .${BUY_LINK_BUTTON_CLASS} svg {
      width: 16px;
      height: 16px;
    }
    .${MORE_BUTTON_HIGHLIGHT_CLASS} {
      /* マイナスのoffsetでアウトラインをボタンの内側に描く（外側にはみ出すbox-shadow/outlineは、
         リスト行の詰まったボタングループによって不均一に切り取られてしまっていた）。 */
      outline: 2px solid #ff5500 !important;
      outline-offset: -2px;
    }
    .${MORE_BUTTON_ICON_HIGHLIGHT_CLASS},
    .${MORE_BUTTON_ICON_HIGHLIGHT_CLASS} svg,
    .${MORE_BUTTON_ICON_HIGHLIGHT_CLASS} svg * {
      color: #ff5500 !important;
      fill: #ff5500 !important;
    }
    /* 固定の白だとLightモードで背景に溶けて見えなくなるため、
       曲タイトルなどと同じテーマ追従のテキスト色を使う。 */
    .${MORE_BUTTON_PURCHASE_HIGHLIGHT_CLASS} {
      outline: 2px solid var(--primary-color, #fff) !important;
      outline-offset: -2px;
    }
    /* 挿入先の.playableTile__artworkが常にposition:relativeとは限らないため明示する
       （このオーバーレイをinset:0で敷き詰めるための基準にするだけで、それ自体のレイアウトには影響しない）。 */
    .playableTile__artwork {
      position: relative;
    }
    .${TILE_ARTWORK_OUTLINE_CLASS} {
      position: absolute;
      inset: 0;
      pointer-events: none;
      z-index: 2;
      border-radius: inherit;
      box-sizing: border-box;
    }
    .${TILE_ARTWORK_OUTLINE_CLASS}.${TILE_ARTWORK_DOWNLOAD_HIGHLIGHT_CLASS} {
      box-shadow: inset 0 0 0 1px #ff5500;
    }
    /* 固定の白だとLightモードで背景に溶けて見えなくなるため、
       曲タイトルなどと同じテーマ追従のテキスト色を使う。 */
    .${TILE_ARTWORK_OUTLINE_CLASS}.${TILE_ARTWORK_PURCHASE_HIGHLIGHT_CLASS} {
      box-shadow: inset 0 0 0 1px var(--primary-color, #fff);
    }
    /* 上で強制しているcolor/fillがネイティブボタン自身の:hoverフェードを妨げてしまうため、
       隣のボタン（Like/Follow/Moreなど）と挙動を揃えるために同じフェードを明示的に再定義する。 */
    .${DOWNLOAD_BUTTON_CLASS}:hover,
    .${BUY_LINK_BUTTON_CLASS}:hover,
    .${MORE_BUTTON_ICON_HIGHLIGHT_CLASS}:hover {
      opacity: 0.7 !important;
    }
    .${INLINE_DOWNLOAD_ICON_CLASS},
    .${INLINE_PURCHASE_ICON_CLASS} {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 20px;
      height: 20px;
      margin-right: 4px;
      vertical-align: middle;
    }
    .${INLINE_DOWNLOAD_ICON_CLASS} {
      color: #ff5500;
    }
    .${INLINE_PURCHASE_ICON_CLASS} {
      /* 固定の白だとLightモードで背景に溶けて見えなくなるため、
         曲タイトルなどと同じテーマ追従のテキスト色を使う。 */
      color: var(--primary-color, #fff);
    }
    .${INLINE_DOWNLOAD_ICON_CLASS} svg,
    .${INLINE_PURCHASE_ICON_CLASS} svg {
      width: 16px;
      height: 16px;
    }
    /* 行自体のホバー状態になると、このアイコンと同じ場所にSoundCloud側のオーバーレイ/メニューが表示され、
       見た目もクリックも競合してしまうため、対抗せずに表示中はこのアイコンを隠す。
       同じオーバーレイは再生中の行（"active"クラスが付く）でもホバーなしで表示され続ける。 */
    .trackItem:hover .${INLINE_DOWNLOAD_ICON_CLASS},
    .trackItem.active .${INLINE_DOWNLOAD_ICON_CLASS},
    .trackItem:hover .${INLINE_PURCHASE_ICON_CLASS},
    .trackItem.active .${INLINE_PURCHASE_ICON_CLASS} {
      display: none;
    }
    /* .purchaseLink__container自体には一切スタイルを当てない
       （寸法が変わるとアイコンの縦位置や、このコンテナの矩形を基準にしているとみられるSoundCloud純正の
       「Stream / Buy」ツールチップの位置がずれる。
       また同コンテナにoverflow:hiddenが掛かっているらしく、position:absoluteで外側にはみ出す構成だと
       バッジ自体が見えなくなってしまった）。
       代わりに、コンテナとバッジを両方くるむ新しいラッパー要素（insertPurchaseLinkDomains()が生成）側でflexにする。
       align-self（外側がflexの場合）とvertical-align（inline/baselineの場合）の両方を保険として指定し、
       外側の行の揃え方に関わらず他のアクションアイコンと縦位置を揃える。 */
    .${PURCHASE_LINK_WRAPPER_CLASS} {
      display: inline-flex !important;
      align-items: center !important;
      align-self: center !important;
      vertical-align: middle;
    }
    .${PURCHASE_LINK_DOMAIN_CLASS} {
      /* カートアイコン自体（ネイティブのsc-button-tertiary）の内側paddingの分だけ
         見た目の余白が大きくなるため、マイナスマージンで詰める。 */
      margin-left: -8px;
      font-size: 11px;
      color: var(--secondary-text-color, #999) !important;
      white-space: nowrap;
      /* ドメイン名が長いと再生数などの表示に被ってしまうため、
         被らない程度の幅で省略記号に切り詰める。
         このバッジは.scArtworkCopy__purchaseLinkWrapper（inline-flex）のflex子要素なので、
         min-width: 0を明示しないとflexの自動最小サイズ（＝中身のフル幅）が
         max-width/ellipsisより優先されてしまい、切り詰めが効かない。 */
      max-width: 140px;
      min-width: 0;
      flex-shrink: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      display: inline-block;
      vertical-align: middle;
    }
    /* 挿入先（.sc-button-groupの直後、または購入リンクの隣）がflexコンテナとは
       限らないため、align-self（flexの場合）とvertical-align（inline/baselineの
       場合）の両方を保険として指定し、どちらのレイアウトでも縦中央に揃える。 */
    .${DESCRIPTION_LINK_WRAPPER_CLASS} {
      display: inline-flex !important;
      align-items: center !important;
      align-self: center !important;
      vertical-align: middle;
      gap: 6px;
      margin-left: 6px;
    }
    /* ネイティブのタグ（ジャンル/曲名下のハッシュタグ）と同じクラスを流用し、
       見た目・テーマ追従を独自に再現しない。フォントサイズだけこちらの11pxに揃える。 */
    .${DESCRIPTION_LINK_BUTTON_CLASS},
    .${DESCRIPTION_LINK_BUTTON_CLASS} .sc-tagContent {
      font-size: 11px !important;
    }
    /* ネイティブのハッシュタグは.sc-tagContentの前に"#"を疑似要素で付けているが、
       URLのドメイン表示には不要なため打ち消す。 */
    .${DESCRIPTION_LINK_BUTTON_CLASS}::before,
    .${DESCRIPTION_LINK_BUTTON_CLASS} .sc-tagContent::before {
      content: none !important;
    }
    .${DESCRIPTION_LINK_MORE_CLASS} {
      font-size: 11px;
      color: var(--secondary-text-color, #999) !important;
      white-space: nowrap;
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
    ID3_LIBRARY_FETCH_FAILED: {
      en: ({ status }) => `Failed to load the ID3 tagging library (${status}).`,
      ja: ({ status }) => `ID3タグ書き込み用ライブラリの取得に失敗しました（${status}）。`,
    },
    ID3_LIBRARY_INTEGRITY_MISMATCH: {
      en: () => 'The ID3 tagging library did not match its expected checksum.',
      ja: () => 'ID3タグ書き込み用ライブラリの内容が想定と一致しませんでした。',
    },
    UNKNOWN: {
      en: () => 'Something went wrong.',
      ja: () => '不明なエラーが発生しました。',
    },
  };

  function failWith(code, params) {
    // 英語のcode/paramsの組み合わせを.messageに残しておくことで、
    // 言語設定に関わらずconsole.errorの出力がデバッグに使える状態を保つ。
    // トースト用のローカライズ文言は.codeから別途引く。
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

  function localizeText(en, ja) {
    return getUiLang() === 'ja' ? ja : en;
  }

  function getHighResUrl(baseUrl) {
    // Webアプリ自身が描画するDOMは"-t{width}x{height}"（例: -t500x500）を使うが、
    // /resolve APIのartwork_urlフィールドはSoundCloudの古い"-large"表記を使う —
    // どちらにもマッチさせる。
    return baseUrl.replace(/-(?:t\d+x\d+|large)(?=\.\w+$)/, '-original');
  }

  async function convertBlobToPng(blob) {
    const bitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    canvas.getContext('2d').drawImage(bitmap, 0, 0);
    return canvas.convertToBlob({ type: 'image/png' });
  }

  async function fetchArtworkResponse(baseUrl) {
    let response = await fetch(getHighResUrl(baseUrl));
    if (!response.ok) response = await fetch(baseUrl);
    if (!response.ok) failWith('FETCH_ARTWORK_FAILED', { status: response.status });
    return response;
  }

  async function resolveArtworkBlob(baseUrl) {
    const response = await fetchArtworkResponse(baseUrl);
    let blob = await response.blob();
    // クリップボードへの書き込みが保証されるのはimage/pngのみ。
    // 一部のジャケット画像（特に"-original"の高解像度版が無いもの）はimage/jpegで配信されており、
    // ブラウザによっては書き込みを拒否する。
    if (blob.type !== 'image/png') blob = await convertBlobToPng(blob);
    return blob;
  }

  async function copyArtworkFromBaseUrl(baseUrl) {
    // navigator.clipboard.write()は「呼び出した瞬間にドキュメントが
    // フォーカスされていること」を要求する。ClipboardItemにはBlobの
    // 代わりにPromiseを渡せる仕様になっているため、実際のfetch/PNG変換は
    // 後回しにしつつ、.write()自体はここで（awaitを挟まず）同期的に呼ぶ
    // ことで、その後fetch中にウィンドウのフォーカスが外れても書き込みは
    // 成功する。
    return navigator.clipboard.write([
      new ClipboardItem({ 'image/png': resolveArtworkBlob(baseUrl) }),
    ]);
  }

  async function resolveHeroArtworkBlob() {
    // ページ自身のHTMLをfetch()してmetaタグを読む方式ではなく、
    // ダウンロード機能と同じapi-v2の/resolve呼び出しを経由する。
    // そのHTML fetchこそが断続的にm.soundcloud.comへリダイレクトされCORSでブロックされていたもの（SoundCloudのbot対策）。
    let trackData;
    try {
      trackData = await fetchTrackData(location.href);
    } catch (err) {
      if (err?.code === 'NOT_A_TRACK') failWith('NOT_TRACK_PAGE');
      throw err;
    }
    if (!trackData.artworkUrl) failWith('NO_ARTWORK');
    return resolveArtworkBlob(trackData.artworkUrl);
  }

  async function copyArtwork() {
    // トラック単体ページでは画像URLを知るためにapi-v2への非同期呼び出し
    // （resolveHeroArtworkBlob内のfetchTrackData）が必要になるが、それも
    // 丸ごとPromiseとしてClipboardItemに渡し、.write()自体はここで同期的に
    // 呼ぶ（copyArtworkFromBaseUrlと同じ理由）。
    return navigator.clipboard.write([
      new ClipboardItem({ 'image/png': resolveHeroArtworkBlob() }),
    ]);
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
    // await ではなく return: copyArtworkFromBaseUrl 内の
    // navigator.clipboard.write() 呼び出しが、この関数の呼び出しから
    // 一切 await を挟まず同期的に実行されることが重要なため。
    return copyArtworkFromBaseUrl(baseUrl);
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

  function uint32LE(n) {
    const buf = new Uint8Array(4);
    new DataView(buf.buffer).setUint32(0, n, true);
    return buf;
  }

  function uint32BE(n) {
    const buf = new Uint8Array(4);
    new DataView(buf.buffer).setUint32(0, n, false);
    return buf;
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
    // 各サブチャンク（fourCC + LEサイズ + データ + パディング）
    // は下のbuildRiffChunk()と同じ形なので、そのまま再利用する。
    const parts = entries
      .filter(([, value]) => value)
      .map(([id, value]) => buildRiffChunk(id, encoder.encode(`${value}\0`)));
    return buildRiffChunk('LIST', concatBytes([encoder.encode('INFO'), ...parts]));
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
    // 最上位のRIFFサイズフィールドはそれ以降の全体を表すので、
    // ファイル全体の長さが変わるたびに補正が必要。
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
    // ジャケット画像（および、このチャンクしか読まないプレイヤー向けに重複して同じテキスト項目も）は、
    // 非標準だがffmpeg/mutagenが認識する"id3 "チャンク（中身は丸ごとID3v2タグ、
    // MP3側と同じフォーマット/フレーム）に入れる。
    // 上のspliceでチャンクのオフセットがずれるため、先に再パースする。
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
    // browser-id3-writerは常にこちらが設定した内容から新規にタグを組み立てるため、
    // タグ内のそれ以外の情報は意図的に引き継がない。
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
    const response = await fetchArtworkResponse(baseUrl);
    return { data: await response.arrayBuffer(), mimeType: response.headers.get('content-type') || 'image/jpeg' };
  }

  // browser-id3-writerはESモジュール（"export"構文）でのみ配布されており、
  // Tampermonkeyの@requireは"export"を含むファイルをクラシックスクリプトとして注入しようとしてSyntaxErrorになるため使えない
  // （@requireにSRIハッシュを付ける方式が採れない）。
  // その代わりとして、fetchしたソース文字列そのものをレビュー済みバイト列のSHA-256と照合し、
  // 一致した場合のみBlob URL経由でimport()する — ネイティブのSRIと同等に、
  // 実行前に内容がレビュー時点のバイト列と完全に一致することを保証する。
  const ID3_WRITER_URL = 'https://unpkg.com/browser-id3-writer@6.3.1/dist/browser-id3-writer.mjs';
  const ID3_WRITER_SHA256 = 'f19f2d740c7502eca75662005d31dffc1635037bfa1bd63287d073bf1f7b672c';

  async function loadId3Writer() {
    const response = await fetch(ID3_WRITER_URL);
    if (!response.ok) failWith('ID3_LIBRARY_FETCH_FAILED', { status: response.status });
    const source = await response.text();
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source));
    const hex = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
    if (hex !== ID3_WRITER_SHA256) failWith('ID3_LIBRARY_INTEGRITY_MISMATCH');

    const blobUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
    try {
      return await import(blobUrl);
    } finally {
      URL.revokeObjectURL(blobUrl);
    }
  }

  async function buildId3Tag(existing, fields, seedBuffer) {
    // seedBufferは、実際のMP3にタグを付ける場合は本物のMP3バイト列（書き換え後も音声データが残るように）、
    // タグ単体のバイト列だけが欲しい場合（WAVの"id3 "チャンクに埋め込む場合など）は空のバッファ。
    const { ID3Writer } = await loadId3Writer();
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
    // メタデータブロックのヘッダーとPICTUREブロックはビッグエンディアンだが、
    // Vorbisコメントのフィールドはリトルエンディアン —
    // 元のOgg Vorbisコメント仕様をそのまま引き継いだ挙動。
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
    // 最終的なブロックの並び順が確定した時点でlast-blockフラグを調整するので、
    // ここでは常にクリアした状態で組み立てる。
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

    const parts = [uint32LE(vendor.length), vendor, uint32LE(comments.length)];
    for (const c of comments) parts.push(uint32LE(c.length), c);

    return buildFlacMetadataBlock(4, concatBytes(parts));
  }

  function buildPictureBlock(mimeType, pictureData, pictureType = 3) {
    const encoder = new TextEncoder();
    const mimeBytes = encoder.encode(mimeType);

    const parts = [
      uint32BE(pictureType),
      uint32BE(mimeBytes.length),
      mimeBytes,
      uint32BE(0), // description（説明文）なし
      new Uint8Array(16), // width, height, color depth, indexed-color count（幅・高さ・色深度・インデックスカラー数）: 不明
      uint32BE(pictureData.byteLength),
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

    // STREAMINFO（type 0）は必ず先頭に置く。
    // それ以外（PADDING、APPLICATION、SEEKTABLE、CUESHEETなど）はそのまま残し、
    // コメント/ピクチャーブロックだけを、以前あったものを置き換える形でSTREAMINFOの直後に挿入する。
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
    // client_id + cookieに加えてこれも必要とする。
    // httpOnlyではないのでここから読み取れる。
    const match = document.cookie.match(/(?:^|;\s*)oauth_token=([^;]+)/);
    return match ? decodeURIComponent(match[1]) : null;
  }

  function authHeaders() {
    const token = getOAuthToken();
    return token ? { Authorization: `OAuth ${token}` } : {};
  }

  async function fetchTrackData(url) {
    // トラックのHTMLページを単純にfetch()するとm.soundcloud.comへリダイレクトされCORSでブロックされる —
    // SoundCloudのbot対策（DataDome）が、
    // 今まさに見ているページであってもスクリプトからのページHTML取得をフラグ立てしているようだ。
    // api-v2のresolveエンドポイントは、
    // ダウンロード用エンドポイントですでにうまくいっているのと同種のAJAX呼び出しで、
    // トラックのJSONを直接返してくれる（HTML/hydrationのパースが不要）。
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
    // トラックIDと違い、client_id/app_versionはトラックごとではなくセッション単位の値なので、
    // 今表示しているページ自身のグローバル変数は常に最新。
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
    // トラック自身の単体ページでは、トリガーを包むタイル/行が存在しないため、
    // 現在のページURLにフォールバックするのがそこでは正解になる。
    // プレイリストのトラック行（.trackItem）は他の2パターンと一致するジャケット/タイトルリンクを持たないため、
    // 専用のリンクセレクタ（.trackItem__trackTitle）が必要。
    const scope = triggerEl?.closest('.playableTile, .sound__body, .trackItem') ?? null;
    const link = scope?.querySelector('.playableTile__artworkLink, .sound__coverArt, .trackItem__trackTitle');
    const href = link?.getAttribute('href');
    return href ? new URL(href, location.origin).href : location.href;
  }

  function resolveTrackPermalink(dropdownEl) {
    // ドロップダウンは、それを開いたタイル/行とは別の場所にポータルされるため、
    // DOM上の近さでは見つけられない。
    // トリガーボタンはaria-ownsで自分のドロップダウンと紐づいているので、
    // そこからトリガーを持つタイル/行まで遡り、トラックへのリンクを直接読む。
    const trigger = document.querySelector(`[aria-owns="${CSS.escape(dropdownEl.id)}"]`);
    return permalinkFromScope(trigger);
  }

  function createInlineDownloadIcon() {
    // ボタンにはしない: 行自体のホバー状態になると、
    // この同じ場所を覆うネイティブのオーバーレイ/メニューが出てクリックを奪ってしまうため、
    // これは操作可能な要素ではなく純粋な視覚的インジケーターとする。
    const icon = document.createElement('span');
    icon.className = INLINE_DOWNLOAD_ICON_CLASS;
    icon.title = 'Downloadable';
    icon.setAttribute('aria-label', 'Downloadable');
    icon.innerHTML = ICON_DOWNLOAD;
    return icon;
  }

  function insertInlinePlaylistDownloadIcon(trigger) {
    // プレイリストの行は密集していて、ホバーで出てくる「More」ボタンだけでは見つけにくいと判断したため、
    // 既にダウンロード可能と分かっているトラックについては、
    // 代わりに再生回数の左に常時表示のインジケーターを出す。
    const row = trigger.closest('.trackItem');
    if (!row || row.querySelector(`.${INLINE_DOWNLOAD_ICON_CLASS}`)) return;
    // 再生数が非公開などの理由で.trackItem__playCount自体が描画されない行もあるため、
    // その場合はアクションボタン群の直前（行の右端）にフォールバックする。
    const anchor = row.querySelector('.trackItem__playCount') || row.querySelector('.trackItem__actions');
    if (!anchor) return;
    anchor.insertAdjacentElement('beforebegin', createInlineDownloadIcon());
  }

  function createInlinePurchaseIcon() {
    // ダウンロードの目印（createInlineDownloadIcon）と同じ理由でボタンにはしない。
    // 実際にBuyLinkを開くのはMoreメニューの「Open BuyLink」からのみ。
    const icon = document.createElement('span');
    icon.className = INLINE_PURCHASE_ICON_CLASS;
    icon.title = 'BuyLink';
    icon.setAttribute('aria-label', 'BuyLink');
    icon.innerHTML = ICON_CART;
    return icon;
  }

  function insertInlinePlaylistPurchaseIcon(trigger) {
    // insertInlinePlaylistDownloadIcon と同じ理由（プレイリストの行は密集していて見つけにくい）。
    // ダウンロード可否とは独立に、BuyLinkがあれば常に出す。
    const row = trigger.closest('.trackItem');
    if (!row || row.querySelector(`.${INLINE_PURCHASE_ICON_CLASS}`)) return;
    // 両方表示される場合はカートアイコンをDLアイコンより左にしたいので、
    // DLアイコンがすでにあればその直前に、無ければ再生回数の直前に挿入する
    // （挿入の呼び出し順に関わらず、この向き付けが常に成り立つ）。
    // 再生数が非公開などで.trackItem__playCount自体が無い行は、
    // アクションボタン群の直前（行の右端）にフォールバックする。
    const anchor =
      row.querySelector(`.${INLINE_DOWNLOAD_ICON_CLASS}`) ||
      row.querySelector('.trackItem__playCount') ||
      row.querySelector('.trackItem__actions');
    if (!anchor) return;
    anchor.insertAdjacentElement('beforebegin', createInlinePurchaseIcon());
  }

  function resolveGridTileArtwork(trigger) {
    // insertTileButtons()のグリッドconfigと同じ辿り方（.playableTile__actionWrapper→closestで.playableTile__artwork）。
    return trigger.closest('.playableTile__actionWrapper')?.closest('.playableTile__artwork') ?? null;
  }

  function resolveArtworkBorderRadius(artworkEl) {
    // 角丸は.playableTile__artwork自体ではなく内側の画像要素に付いていることが多いため、
    // firstElementChildを辿りながら実際に0でないborder-radiusを持つ要素を探す。
    let el = artworkEl;
    while (el) {
      const radius = getComputedStyle(el).borderRadius;
      if (radius && radius !== '0px') return radius;
      el = el.firstElementChild;
    }
    return '0px';
  }

  function ensureTileArtworkOutline(artworkEl) {
    // .playableTile__artworkに直接クラスを当てると画像レイヤーの下に隠れてしまうため、
    // 明示的なz-indexを持つ専用オーバーレイを最後の子として挿入し、そちらにクラスを付け外しする。
    let overlay = artworkEl.querySelector(`:scope > .${TILE_ARTWORK_OUTLINE_CLASS}`);
    if (!overlay) {
      overlay = document.createElement('span');
      overlay.className = TILE_ARTWORK_OUTLINE_CLASS;
      artworkEl.appendChild(overlay);
    }
    overlay.style.borderRadius = resolveArtworkBorderRadius(artworkEl);
    return overlay;
  }

  function markTriggerDownloadable(trigger) {
    // グリッドタイルのMoreボタンはジャケット画像の上に乗っているため、
    // 他の箇所で使うアウトラインではなくアイコン色変更の方式を維持する。
    const isGridTile = !!trigger.closest('.playableTile__actionWrapper');
    // ダウンロード可能かつBuyLinkもある場合は、オレンジ（ダウンロード）を
    // 優先する — 白いBuyLink用ハイライトが先に付いていたら外す。
    trigger.classList.remove(MORE_BUTTON_PURCHASE_HIGHLIGHT_CLASS);
    trigger.classList.add(isGridTile ? MORE_BUTTON_ICON_HIGHLIGHT_CLASS : MORE_BUTTON_HIGHLIGHT_CLASS);
    if (isGridTile) {
      // Moreボタン自体には乗せられない分、ジャケット画像そのものをオレンジで囲む。
      const artwork = resolveGridTileArtwork(trigger);
      if (artwork) {
        const overlay = ensureTileArtworkOutline(artwork);
        overlay.classList.remove(TILE_ARTWORK_PURCHASE_HIGHLIGHT_CLASS);
        overlay.classList.add(TILE_ARTWORK_DOWNLOAD_HIGHLIGHT_CLASS);
      }
    }
    insertInlinePlaylistDownloadIcon(trigger);
  }

  function markTriggerHasPurchaseLink(trigger) {
    // 「Open BuyLink」メニュー項目と同じ理由で、Moreボタンの白いアウトラインも
    // Playlist/Station（.trackItem）に限定する — それ以外の文脈では
    // ネイティブの購入リンク（カートアイコン）がすでにアクション行に
    // 表示されているため。
    const isPlaylistOrStation = !!trigger.closest('.trackItem');
    const isGridTile = !!trigger.closest('.playableTile__actionWrapper');
    // ダウンロード可能としてすでにオレンジでマーク済みなら、そちらを優先し
    // Moreボタンの色は変えない（インジケーターアイコンの表示は独立に行う）。
    const alreadyDownloadHighlighted =
      trigger.classList.contains(MORE_BUTTON_HIGHLIGHT_CLASS) || trigger.classList.contains(MORE_BUTTON_ICON_HIGHLIGHT_CLASS);
    if (isPlaylistOrStation && !alreadyDownloadHighlighted) {
      trigger.classList.add(MORE_BUTTON_PURCHASE_HIGHLIGHT_CLASS);
    }
    if (isGridTile) {
      // グリッドタイルはMoreボタンではなくジャケット画像を囲む。
      // ダウンロード可能ですでにオレンジで囲まれているなら、そちらを優先し白は付けない。
      const artwork = resolveGridTileArtwork(trigger);
      if (artwork) {
        const overlay = ensureTileArtworkOutline(artwork);
        if (!overlay.classList.contains(TILE_ARTWORK_DOWNLOAD_HIGHLIGHT_CLASS)) {
          overlay.classList.add(TILE_ARTWORK_PURCHASE_HIGHLIGHT_CLASS);
        }
      }
    }
    insertInlinePlaylistPurchaseIcon(trigger);
  }

  function clearTriggerDownloadableState(trigger) {
    // SPAナビゲーションでは、まったく同じ「More」トリガー要素が別のトラックのために使い回されることがある（例えば、
    // あるトラック単体ページから別のトラック単体ページへ直接遷移する場合）。
    // そのため、この要素が以前どのトラックのためにマークされていたとしても、
    // 永久に信用せず、再評価の前にハイライトを消しておく必要がある。
    trigger.classList.remove(MORE_BUTTON_HIGHLIGHT_CLASS, MORE_BUTTON_ICON_HIGHLIGHT_CLASS, MORE_BUTTON_PURCHASE_HIGHLIGHT_CLASS);
    const row = trigger.closest('.trackItem');
    row?.querySelector(`.${INLINE_DOWNLOAD_ICON_CLASS}`)?.remove();
    row?.querySelector(`.${INLINE_PURCHASE_ICON_CLASS}`)?.remove();
    resolveGridTileArtwork(trigger)
      ?.querySelector(`.${TILE_ARTWORK_OUTLINE_CLASS}`)
      ?.remove();
  }

  function highlightDownloadableTriggers() {
    // insertDownloadButtons()の「開いてからハイライトする」フォールバックを補完するもの:
    // 「More」ボタンが一度も開かれていなくても、
    // 横読みで集めたデータがダウンロード可能・BuyLinkありだと示した時点で発火する。
    if (downloadableByPath.size === 0 && purchaseUrlByPath.size === 0) return;
    document.querySelectorAll('.sc-button-more').forEach((trigger) => {
      const path = permalinkPath(permalinkFromScope(trigger));
      // タイルのDOM挿入（MutationObserverの発火）が、そのトラックのdownloadable/purchase_url情報を
      // 運ぶAPIレスポンスの解決より先に起きることがある。そのときどちらのMapにもこのpathの記録が
      // まだ無いので、ここで「未評価」のまま次回のtickに持ち越す（dataset.scDownloadPathを書き込まない）
      // — 書き込んでしまうと、直後にデータが届いても同じpathだからと再評価をスキップし、
      // 「ダウンロード可能/BuyLinkありなのにMoreを開くまでハイライトが付かない」状態のまま固定されてしまう。
      if (path && !downloadableByPath.has(path) && !purchaseUrlByPath.has(path)) return;
      if (trigger.dataset.scDownloadPath === path) return; // このトラックについては確定済みの値で評価済み
      trigger.dataset.scDownloadPath = path || '';
      clearTriggerDownloadableState(trigger);
      const isDownloadable = path && downloadableByPath.get(path);
      const purchaseUrl = path && purchaseUrlByPath.get(path);
      if (isDownloadable) markTriggerDownloadable(trigger);
      if (purchaseUrl) markTriggerHasPurchaseLink(trigger);
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

  const METADATA_MERGERS_BY_FORMAT = {
    wav: mergeWavMetadata,
    mp3: mergeMp3Metadata,
    flac: mergeFlacMetadata,
  };

  async function downloadFileWithMetadata(trackUrl) {
    const trackData = await fetchTrackData(trackUrl);
    let { buffer, contentType } = await fetchDownloadFile(trackData.id);

    const format = detectAudioFormat(buffer, contentType);
    const mergeMetadata = METADATA_MERGERS_BY_FORMAT[format];
    let taggingFailed = false;
    if (mergeMetadata) {
      // ファイル本体の取得はすでに成功している（ダウンロード数の消費も
      // 済んでいる可能性がある）ので、この後のタグ埋め込みが失敗しても
      // ダウンロードそのものを失敗扱いにはせず、タグ無しの元ファイルで
      // 続行する。
      try {
        buffer = await mergeMetadata(buffer, {
          title: trackData.title,
          artist: trackData.artist,
          album: trackData.title,
          genre: trackData.genre,
          artworkUrl: trackData.artworkUrl,
        });
      } catch (err) {
        console.error('[SC Artwork Copier]', err);
        taggingFailed = true;
      }
    }
    // それ以外の形式（m4aなど）は無加工でダウンロードされる —
    // 同等のメタデータ対応はまだ実装していない。

    const blob = new Blob([buffer]);
    triggerFileDownload(blob, `${sanitizeFilename(trackData.title)}.${guessExtension(format, contentType)}`);

    if (taggingFailed) {
      showToast(localizeText(
        'Metadata tagging failed, so the file was downloaded without tags.',
        'メタデータの埋め込みに失敗したため、タグ無しでダウンロードしました。'
      ));
    }
  }

  function setIcon(button, svg) {
    (button._iconTarget || button).innerHTML = svg;
  }

  function attachSoundCloudTooltip(el, text) {
    // SoundCloud自身のツールチップのクラス/マークアップ（矢印＋吹き出し）
    // を再利用することで、サイト既存のCSSをそのまま活かす。
    // ネイティブの`title`属性が出すような素のOSツールチップは使わない。
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
      // SoundCloud自身のツールチップは、
      // トリガーの下側に矢印を上向きにして表示される（矢印自体の向きは向こうのCSSで固定されており、
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
      // ダウンロードボタンのアイドル時アイコンは、
      // コピー系ボタンが使うクリップボードアイコンとは異なる。
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
    // 隣に並ぶネイティブのアクションボタン（グリッドタイルならLike/Follow/More、
    // リスト行や単体ページならLike/Repost/Share/...）と同じ構造/クラスにすることで、
    // 見た目を揃え、既存のサイズ調整やホバー時に表示する挙動をそのまま引き継ぐ。
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `${extraClasses} ${TILE_BUTTON_CLASS}`;
    button.setAttribute('aria-label', 'Copy artwork');
    attachSoundCloudTooltip(button, localizeText('Copy Artwork', 'ジャケット画像をコピー'));

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

  // サイトには4種類の異なるトラックのレイアウトが存在する:
  // コンパクトなグリッドタイル（.playableTile__artwork + .playableTile__actionWrapper、
  // 例: /you/likesの「Badges」表示）、
  // フルサイズのリスト行（.sound__artwork + .soundActions .sc-button-group、
  // 例: 「List」表示やstream）、
  // プレイリストのトラック行（.trackItem__image + .soundActions .sc-button-group、
  // 例: /sets/...ページ）、
  // そしてトラック自身の単体ページ（.listenEngagement__footer .soundActions .sc-button-group —
  // リスト行と同じボタングループのマークアップだが.sound__bodyタイル/行には包まれていない）。それぞれについて、
  // コピー関数の解決方法とマッチさせるネイティブボタンのクラスが個別に必要。
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
      // アウトラインアイコン（単体ページと同じ）を使う。
      // タイルオーバーレイのFont Awesomeの塗りつぶしアイコンは、
      // ジャケット画像の真上に乗るグリッド表示専用にしている。
      icon: ICON_IDLE,
    },
    {
      // プレイリストのトラック行は「List」表示と同じsoundActionsボタングループのマークアップを再利用しているが、
      // .sound__bodyではなく.trackItem（ジャケット画像は.trackItem__image）で包まれており、
      // サイズクラスも1段階小さい（-mediumではなくsc-button-small）。
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
      // location.href自体がこのトラック自身のページなので、
      // 以前のヘッダーボタンと同じapi-v2ベースの取得方法であるcopyArtwork()を再利用する。
      rowSelector: '.listenEngagement__footer .soundActions .sc-button-group',
      buttonClasses: 'sc-button-secondary sc-button sc-button-medium sc-button-icon sc-button-responsive',
      resolveCopy: () => copyArtwork,
      // タイルオーバーレイのFont Awesomeクリップボードアイコンではなく、
      // 以前のヘッダーボタンと同じアイコンを使う。
      icon: ICON_IDLE,
    },
    {
      // アーティストが「Visuals」（TrackArt）を設定した単体ページは、通常の
      // .listenEngagement__footerではなく「List」表示と同じ.sound__body/.soundActions
      // マークアップを再利用している。ただし.sound__body内にあるのは正方形ジャケットの
      // .sound__artworkではなく、背景動画/静止画用の.visuals（別物）なので、上のList表示
      // configにマッチしても中のジャケット画像URLを読み取れず、ボタンが出せていなかった。
      // このレイアウトを一意に示す.visualSoundクラスで絞り込み、単体ページ用configと同様に
      // copyArtwork()（api-v2ベースの取得）を再利用する。
      rowSelector: '.visualSound .soundActions .sc-button-group',
      buttonClasses: 'sc-button-secondary sc-button sc-button-medium sc-button-icon sc-button-responsive',
      resolveCopy: () => copyArtwork,
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
    // 見た目を揃えるため、ネイティブの「Download file」ボタンと同じクラスを使う。
    // ただし"sc-button-download"自体は、サイト側でJSの挙動フックにもなっていると思われるため、
    // 意図的に外している。
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

  function normalizeDisplayDomain(hostname) {
    const stripped = hostname.replace(/^www\./, '');
    // open.spotify.comはただの"Spotify"の意味しか持たないサブドメインなので、
    // www.の除去と同じ理由でspotify.comとして表示する。
    if (stripped === 'open.spotify.com') return 'spotify.com';
    return stripped;
  }

  function extractLinkDomain(href) {
    try {
      const url = new URL(href, location.origin);
      // 購入リンクはゲート/リダイレクトサービス（例: gate.sc）経由になっていることが多く、
      // 本来の遷移先は"url"クエリパラメータに格納されている —
      // ゲート自身のドメインではなくそちらを表示する。
      const wrapped = url.searchParams.get('url');
      if (wrapped) {
        try {
          return normalizeDisplayDomain(new URL(wrapped).hostname);
        } catch {
          // wrappedの値が有効な絶対URLではなかった場合はそのまま続行する。
        }
      }
      return normalizeDisplayDomain(url.hostname);
    } catch {
      return null;
    }
  }

  function insertPurchaseLinkDomains() {
    document.querySelectorAll('.soundActions__purchaseLink').forEach((link) => {
      // リンク自身はアイコンサイズの小さなボックスなので、内側に追加すると見えない形でクリップされてしまう。
      // .purchaseLink__container（親コンテナ）も同様にoverflow:hiddenらしく、
      // その内側で見た目だけ外にはみ出す構成（position:absoluteなど）でもクリップされて見えなくなる。
      // そのため、コンテナ自体の寸法・スタイルには一切触れず、コンテナとバッジを両方くるむ
      // 新しいラッパー要素をDOM上でコンテナの位置に差し替える形にする。
      const container = link.closest('.purchaseLink__container') || link;
      if (container.parentElement?.classList.contains(PURCHASE_LINK_WRAPPER_CLASS)) return;
      const href = link.getAttribute('href');
      const domain = href && extractLinkDomain(href);
      if (!domain) return;

      const wrapper = document.createElement('span');
      wrapper.className = PURCHASE_LINK_WRAPPER_CLASS;
      container.replaceWith(wrapper);
      wrapper.appendChild(container);

      const badge = document.createElement('span');
      badge.className = PURCHASE_LINK_DOMAIN_CLASS;
      badge.textContent = domain;
      badge.title = domain; // CSSで省略記号に切り詰められた場合でも、ホバーで全体を確認できるようにする。
      wrapper.appendChild(badge);
      constrainPurchaseLinkDomainWidth(badge);
    });
  }

  function constrainPurchaseLinkDomainWidth(badge) {
    // 行によって再生数などの隣接表示までの余白が異なるため、固定値ではなく
    // 実際のレイアウトから使える幅を測ってmax-widthを当てる。
    const footer = badge.closest('.sound__footer');
    const statsEl = footer?.querySelector('.sound__footerRight');
    if (!statsEl) return; // 測る相手が見つからない文脈ではCSS側の固定値にフォールバックする。
    const badgeLeft = badge.getBoundingClientRect().left;
    const statsLeft = statsEl.getBoundingClientRect().left;
    const available = statsLeft - badgeLeft - PURCHASE_LINK_DOMAIN_SAFETY_MARGIN_PX;
    badge.style.maxWidth = `${Math.max(PURCHASE_LINK_DOMAIN_MIN_WIDTH_PX, available)}px`;
  }

  function extractUrlsFromText(text) {
    const matches = text.match(/https?:\/\/[^\s<>()"'　]+/g) || [];
    // 説明文中でURLの直後に来がちな句読点・閉じ括弧を取り除く。
    return matches.map((url) => url.replace(/[),.!?、。」』]+$/, ''));
  }

  function createDescriptionLinkButton(url) {
    const domain = extractLinkDomain(url) || url;
    // ネイティブのタグ（ジャンル/曲名下のハッシュタグ）と同じクラスを流用し、
    // 見た目・テーマ追従を独自に再現しない。
    const link = document.createElement('a');
    link.className = `sc-tag sc-tag-small ${DESCRIPTION_LINK_BUTTON_CLASS}`;
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener';
    link.title = url;

    const label = document.createElement('span');
    label.className = 'sc-truncate sc-tagContent';
    label.textContent = domain;
    link.appendChild(label);

    // 行自体がクリックで再生を始めてしまうため、リンク自身の遷移は妨げず伝播だけ止める。
    link.addEventListener('click', (event) => event.stopPropagation());
    return link;
  }

  function isLikesPage() {
    // /you/likes、/{username}/likesのどちらも対象。
    return /^\/[^/]+\/likes\/?$/.test(location.pathname);
  }

  function insertDescriptionLinkButtons() {
    // 「List」表示のDOM自体はFeedや各ユーザープロフィールとも共通だが、
    // それらは横幅が狭くこのボタンを表示する余白が無いため、Likes画面限定にする
    // （他の機能はすべてDOMの形だけで判定しているが、これだけは例外的にURLも見る）。
    if (!isLikesPage()) return;
    if (descriptionByPath.size === 0) return;
    document.querySelectorAll('.soundActions .sc-button-group').forEach((groupEl) => {
      if (groupEl.closest('.trackItem')) return;
      const moreButton = groupEl.querySelector('.sc-button-more');
      if (!moreButton) return;
      const row = groupEl.closest('.soundActions') || groupEl;

      let wrapper = row.querySelector(`.${DESCRIPTION_LINK_WRAPPER_CLASS}`);
      const isNewWrapper = !wrapper;
      if (!wrapper) {
        const path = permalinkPath(permalinkFromScope(moreButton));
        const description = path && descriptionByPath.get(path);
        const purchaseUrl = path && purchaseUrlByPath.get(path);
        const normalizedPurchaseUrl = purchaseUrl ? purchaseUrl.replace(/\/$/, '') : null;
        const urls = description
          ? extractUrlsFromText(description).filter((url) => {
              // SNS/SoundCloud自身へのリンクは目立たせる価値が薄いため除外する。
              const domain = extractLinkDomain(url);
              if (domain && DESCRIPTION_LINK_EXCLUDED_DOMAINS.has(domain)) return false;
              // すでにBuyLinkとして表示されているリンクは重複するので除外する。
              if (normalizedPurchaseUrl && url.replace(/\/$/, '') === normalizedPurchaseUrl) return false;
              return true;
            })
          : [];
        if (urls.length === 0) return;

        // 全件をここに保持しておく — fitDescriptionLinksToAvailableWidth()が
        // 実測のたびにここから作り直せるようにするため（一度切り詰めると元に戻せないと、
        // 初回の実測が早すぎて不正確だった場合に永久にズレたままになってしまう）。
        wrapper = document.createElement('span');
        wrapper.className = DESCRIPTION_LINK_WRAPPER_CLASS;
        wrapper._scDescriptionUrls = urls;
      }

      // .purchaseLink__container（BuyLinkが無いトラックでも空のまま常に存在する）を
      // くるむ外側の<div>に入れる。.sc-button-group内（Moreの直後）に置くと、
      // そちらは縦方向の揃え方が違うらしく上揃えになってしまうことがあるため、
      // BuyLinkの有無に関わらずこちらのコンテナに統一する。
      const outerContainer = row.querySelector('.purchaseLink__container')?.parentElement ?? null;
      if (outerContainer) {
        if (wrapper !== outerContainer.lastElementChild) {
          outerContainer.appendChild(wrapper);
        }
      } else if (wrapper.previousElementSibling !== moreButton) {
        // 購入リンク用のコンテナ自体が無い行に対するフォールバック。
        moreButton.insertAdjacentElement('afterend', wrapper);
      }

      if (isNewWrapper) {
        fitDescriptionLinksToAvailableWidth(wrapper);
      } else {
        // 初回の実測タイミングでは再生数エリアがまだ最終的な表示状態になっておらず、
        // 判定が食い違ったまま固定されてしまうことがある。安いチェック（実際に今も
        // 被っているか）だけ毎回行い、被っていれば保持しておいた全URLから作り直して
        // 自己修正する。
        const footer = wrapper.closest('.sound__footer');
        const statsEl = footer?.querySelector('.sound__footerRight');
        if (
          statsEl &&
          wrapper.getBoundingClientRect().right + DESCRIPTION_LINK_SAFETY_MARGIN_PX > statsEl.getBoundingClientRect().left
        ) {
          fitDescriptionLinksToAvailableWidth(wrapper);
        }
      }
    });
  }

  function fitDescriptionLinksToAvailableWidth(wrapper) {
    // 行によって再生数などまでの余白は異なるため、固定件数ではなく実際に入る分だけ残し、
    // 入り切らない分を「N more」にまとめる（購入リンクのドメイン表示と同じ考え方）。
    // 一度切り詰めた後に再実測しても元に戻せるよう、保持しておいた全URLから毎回作り直す。
    const urls = wrapper._scDescriptionUrls;
    if (!urls) return;
    wrapper.innerHTML = '';
    urls.forEach((url) => wrapper.appendChild(createDescriptionLinkButton(url)));

    const footer = wrapper.closest('.sound__footer');
    const statsEl = footer?.querySelector('.sound__footerRight');
    if (!statsEl) {
      // 測る相手が見つからない文脈では、従来通りの固定件数にフォールバックする。
      const buttons = wrapper.querySelectorAll(`.${DESCRIPTION_LINK_BUTTON_CLASS}`);
      const hiddenCount = buttons.length - MAX_VISIBLE_DESCRIPTION_LINKS;
      for (let i = MAX_VISIBLE_DESCRIPTION_LINKS; i < buttons.length; i++) buttons[i].remove();
      if (hiddenCount > 0) appendDescriptionLinkMoreLabel(wrapper, hiddenCount);
      return;
    }

    const statsLeft = statsEl.getBoundingClientRect().left;
    // 「N more」ラベル自体の幅も判定に含める必要があるため、先に空のまま挿入しておき、
    // 判定ループの各ステップで実際の件数をラベルに反映してから測る
    // （件数の桁が変わると仮テキストと実際の表示幅がズレるため、常に実際の件数で測る）。
    const moreLabel = document.createElement('span');
    moreLabel.className = DESCRIPTION_LINK_MORE_CLASS;
    wrapper.appendChild(moreLabel);

    let hiddenCount = 0;
    let buttons = wrapper.querySelectorAll(`.${DESCRIPTION_LINK_BUTTON_CLASS}`);
    while (buttons.length > 0 && wrapper.getBoundingClientRect().right + DESCRIPTION_LINK_SAFETY_MARGIN_PX > statsLeft) {
      buttons[buttons.length - 1].remove();
      hiddenCount++;
      moreLabel.textContent = `${hiddenCount} more`;
      buttons = wrapper.querySelectorAll(`.${DESCRIPTION_LINK_BUTTON_CLASS}`);
    }
    if (hiddenCount === 0) {
      moreLabel.remove();
    }
  }

  function appendDescriptionLinkMoreLabel(wrapper, hiddenCount) {
    const more = document.createElement('span');
    more.className = DESCRIPTION_LINK_MORE_CLASS;
    more.textContent = `${hiddenCount} more`;
    wrapper.appendChild(more);
  }

  function insertDownloadButtons() {
    document.querySelectorAll('.moreActions__group').forEach((groupEl) => {
      const nativeDownloadButton = groupEl.querySelector('.sc-button-download');
      if (!nativeDownloadButton) return;
      const dropdownEl = groupEl.closest('.dropdownMenu');
      if (!dropdownEl) return;

      // ダウンロード可否は、ドロップダウンが実際に開かれた時点で初めて分かる（開くたびに新しくポータルされるため）ので、
      // 事前にではなくここでトリガーボタンをマークする —
      // resolveTrackPermalink()と同じaria-owns相関を使う。
      const trigger = document.querySelector(`[aria-owns="${CSS.escape(dropdownEl.id)}"]`);
      if (trigger) {
        // pathも記録しておくことで、
        // highlightDownloadableTriggers()がこのトリガーは現在のトラックについてすでに正しく確定済みだと認識し、
        // すぐに再評価して（誤って）クリアしてしまうのを防ぐ。
        trigger.dataset.scDownloadPath = permalinkPath(permalinkFromScope(trigger)) || '';
        markTriggerDownloadable(trigger);
      }

      if (groupEl.querySelector(`.${DOWNLOAD_BUTTON_CLASS}`)) return;
      nativeDownloadButton.insertAdjacentElement('afterend', createDownloadButton(dropdownEl));
    });
  }

  function createBuyLinkButton(purchaseUrl) {
    const domain = extractLinkDomain(purchaseUrl) || purchaseUrl;
    const label = `Open BuyLink (${domain})`;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `sc-button-secondary sc-button moreActions__button sc-button-medium sc-button-tertiary ${BUY_LINK_BUTTON_CLASS}`;
    button.title = label;
    button.setAttribute('aria-label', label);

    const iconWrapper = document.createElement('div');
    iconWrapper.innerHTML = ICON_CART;

    const labelEl = document.createElement('span');
    labelEl.className = 'sc-button-label';
    labelEl.textContent = label;

    button.append(iconWrapper, labelEl);
    // ダウンロードのような読み込み中/成功/失敗の状態遷移が要らない、
    // その場で完結する単純な操作なのでattachCopyHandlerは使わない。
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      window.open(purchaseUrl, '_blank', 'noopener');
    });
    return button;
  }

  function insertBuyLinkButtons() {
    // ダウンロード可否と違い、開かなくてもすでにpurchase_urlが分かって
    // いれば追加できるので、ネイティブの何かの存在チェックは不要。
    if (purchaseUrlByPath.size === 0) return;
    document.querySelectorAll('.moreActions__group').forEach((groupEl) => {
      if (groupEl.querySelector(`.${BUY_LINK_BUTTON_CLASS}`)) return;
      const dropdownEl = groupEl.closest('.dropdownMenu');
      if (!dropdownEl) return;
      // Playlist/Stationの行（.trackItem）およびグリッド（Badges）タイル
      // （.playableTile__actionWrapper）以外では、ネイティブの購入リンク
      // （カートアイコン、insertPurchaseLinkDomains()がドメインを添えている）
      // がすでにアクション行に見えているはずなので、Moreメニューへの追加は
      // この2つの文脈に限定する。グリッドタイルのアクション行はLike/Follow/Moreのみで、
      // ネイティブの購入リンク自体がそもそも表示されないため対象に含める。
      const trigger = document.querySelector(`[aria-owns="${CSS.escape(dropdownEl.id)}"]`);
      if (!trigger?.closest('.trackItem') && !trigger?.closest('.playableTile__actionWrapper')) return;
      const path = permalinkPath(resolveTrackPermalink(dropdownEl));
      const purchaseUrl = path && purchaseUrlByPath.get(path);
      if (!purchaseUrl) return;
      groupEl.appendChild(createBuyLinkButton(purchaseUrl));
    });
  }

  whenDomReady(() => {
    document.head.appendChild(style);

    // 初回ページ読み込み時のトラック一覧（/likesの最初の一括分など）は、このhydrationデータに直接埋め込まれていて、
    // こちらのfetchパッチで監視できる後続のAJAX呼び出しでは取得されないことが多いので、
    // こちらも一度だけスキャンしておく。SPAナビゲーションでは更新されないが、
    // その頃にはfetchパッチが読み込み中の新しいデータを既に捕捉している。
    recordDownloadableInfo(window.__sc_hydration);

    // Reactの再描画によって挿入したボタンが消えてしまうため、監視を続けて消えるたびに再挿入する。
    // likes/プレイリストの一覧も遅延読み込みでスクロールに応じて新しいタイルが追加されるため、
    // 同じobserverでオーバーレイボタンの整合性を保つ。
    // 「More」ドロップダウンも開かれるたびに新しくポータルされるため、これも同様にここで捕捉する。
    const observer = new MutationObserver(() => {
      insertTileButtons();
      insertDownloadButtons();
      highlightDownloadableTriggers();
      insertPurchaseLinkDomains();
      insertBuyLinkButtons();
      insertDescriptionLinkButtons();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    insertTileButtons();
    insertDownloadButtons();
    highlightDownloadableTriggers();
    insertPurchaseLinkDomains();
    insertBuyLinkButtons();
    insertDescriptionLinkButtons();
  });
})();
