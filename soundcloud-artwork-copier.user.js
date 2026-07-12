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
  const STATE_SUCCESS_CLASS = `${BUTTON_CLASS}--success`;
  const STATE_FAILURE_CLASS = `${BUTTON_CLASS}--failure`;
  const FEEDBACK_DURATION_MS = 1500;

  const ICON_IDLE = '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path fill="currentColor" d="M9 2a1 1 0 0 0-1 1v1H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-2V3a1 1 0 0 0-1-1H9Zm0 2h6v2H9V4ZM6 6h2v2h8V6h2v14H6V6Z"/></svg>';
  const ICON_SUCCESS = '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path fill="currentColor" d="M9 16.17 4.83 12l-1.42 1.41L9 19l12-12-1.41-1.41z"/></svg>';
  const ICON_FAILURE = '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path fill="currentColor" d="M18.3 5.71 12 12.01l-6.3-6.3-1.41 1.41L10.59 13.42l-6.3 6.3 1.41 1.41 6.3-6.3 6.3 6.3 1.41-1.41-6.3-6.3 6.3-6.3z"/></svg>';

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
      color: var(--sc-header-icon-color, #999);
      cursor: pointer;
    }
    .${BUTTON_CLASS}:hover {
      background: rgba(0, 0, 0, 0.05);
    }
    .${BUTTON_CLASS} svg {
      width: 20px;
      height: 20px;
    }
    .${STATE_SUCCESS_CLASS} {
      color: #2ecc71;
    }
    .${STATE_FAILURE_CLASS} {
      color: #e74c3c;
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

  async function resolveArtworkUrls() {
    const meta = await fetchCurrentPageMeta();
    if (meta.ogType !== 'music.song' || !meta.ogImage) return null;
    return { highRes: getHighResUrl(meta.ogImage), fallback: meta.ogImage };
  }

  async function copyArtwork() {
    const urls = await resolveArtworkUrls();
    if (!urls) throw new Error('Not a track page');

    let response = await fetch(urls.highRes);
    if (!response.ok) response = await fetch(urls.fallback);
    if (!response.ok) throw new Error(`Failed to fetch artwork: ${response.status}`);

    const blob = await response.blob();
    await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
  }

  function showFeedback(button, isSuccess) {
    clearTimeout(button._feedbackTimer);
    button.classList.remove(STATE_SUCCESS_CLASS, STATE_FAILURE_CLASS);
    button.classList.add(isSuccess ? STATE_SUCCESS_CLASS : STATE_FAILURE_CLASS);
    button.innerHTML = isSuccess ? ICON_SUCCESS : ICON_FAILURE;
    button._feedbackTimer = setTimeout(() => {
      button.classList.remove(STATE_SUCCESS_CLASS, STATE_FAILURE_CLASS);
      button.innerHTML = ICON_IDLE;
    }, FEEDBACK_DURATION_MS);
  }

  function createButton() {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = BUTTON_CLASS;
    button.title = 'Copy artwork';
    button.setAttribute('aria-label', 'Copy artwork');
    button.innerHTML = ICON_IDLE;
    button.addEventListener('click', () => {
      copyArtwork()
        .then(() => showFeedback(button, true))
        .catch((err) => {
          console.error('[SC Artwork Copier]', err);
          showFeedback(button, false);
        });
    });
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

  // React re-renders header__middle after initial load and can wipe out
  // our injected button, so keep watching and reinsert whenever it's gone.
  const observer = new MutationObserver(() => insertButton());
  observer.observe(document.body, { childList: true, subtree: true });
  insertButton();
})();
