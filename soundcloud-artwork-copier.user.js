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
  const STATE_SUCCESS_CLASS = 'scArtworkCopy--success';
  const STATE_FAILURE_CLASS = 'scArtworkCopy--failure';
  const STATE_LOADING_CLASS = 'scArtworkCopy--loading';
  const FEEDBACK_DURATION_MS = 1500;

  const ICON_IDLE = '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path fill="currentColor" d="M9 2a1 1 0 0 0-1 1v1H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-2V3a1 1 0 0 0-1-1H9Zm0 2h6v2H9V4ZM6 6h2v2h8V6h2v14H6V6Z"/></svg>';
  const ICON_SUCCESS = '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path fill="currentColor" d="M9 16.17 4.83 12l-1.42 1.41L9 19l12-12-1.41-1.41z"/></svg>';
  const ICON_FAILURE = '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path fill="currentColor" d="M18.3 5.71 12 12.01l-6.3-6.3-1.41 1.41L10.59 13.42l-6.3 6.3 1.41 1.41 6.3-6.3 6.3 6.3 1.41-1.41-6.3-6.3 6.3-6.3z"/></svg>';
  const ICON_LOADING = '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path fill="currentColor" d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46A7.93 7.93 0 0 0 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74A7.93 7.93 0 0 0 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z"/></svg>';

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
    .${TILE_BUTTON_CLASS} svg {
      filter: drop-shadow(0 0 1.5px rgba(0, 0, 0, 0.9)) drop-shadow(0 1px 2px rgba(0, 0, 0, 0.6));
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
    // Both the wrapping <div> and the inner <span> carry the "sc-artwork"
    // class, but only the <span> has the background-image inline style.
    const span = artworkEl.querySelector('.playableTile__image span.sc-artwork');
    const match = span?.style.backgroundImage.match(/url\(["']?(.*?)["']?\)/);
    return match ? match[1] : null;
  }

  async function copyArtworkFromTile(artworkEl) {
    const baseUrl = getArtworkUrlFromTile(artworkEl);
    if (!baseUrl) throw new Error('Artwork not loaded yet');
    await copyArtworkFromBaseUrl(baseUrl);
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

  function createTileButton(artworkEl) {
    // Matches the structure/classes of the native Like/Follow/More buttons
    // in .playableTile__actionWrapper so it lines up with them visually and
    // inherits their existing hover-to-reveal behavior for free.
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `playableTile__actionButton sc-button sc-button-small sc-button-icon ${TILE_BUTTON_CLASS}`;
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

  function insertTileButtons() {
    document.querySelectorAll('.playableTile__actionWrapper').forEach((wrapperEl) => {
      if (wrapperEl.querySelector(`.${TILE_BUTTON_CLASS}`)) return;
      const artworkEl = wrapperEl.closest('.playableTile__artwork');
      if (!artworkEl) return;
      wrapperEl.appendChild(createTileButton(artworkEl));
    });
  }

  // React re-renders header__middle after initial load and can wipe out
  // our injected button, so keep watching and reinsert whenever it's gone.
  // Likes/playlist lists are also lazy-loaded and append new tiles as the
  // user scrolls, so the same observer keeps those overlay buttons in sync.
  const observer = new MutationObserver(() => {
    insertButton();
    insertTileButtons();
  });
  observer.observe(document.body, { childList: true, subtree: true });
  insertButton();
  insertTileButtons();
})();
