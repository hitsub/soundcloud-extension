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
  const ICON_IDLE = '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path fill="currentColor" d="M9 2a1 1 0 0 0-1 1v1H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-2V3a1 1 0 0 0-1-1H9Zm0 2h6v2H9V4ZM6 6h2v2h8V6h2v14H6V6Z"/></svg>';

  const style = document.createElement('style');
  style.textContent = `
    .${BUTTON_CLASS} {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 32px;
      height: 32px;
      margin-left: 8px;
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
  `;
  document.head.appendChild(style);

  function createButton() {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = BUTTON_CLASS;
    button.title = 'Copy artwork';
    button.setAttribute('aria-label', 'Copy artwork');
    button.innerHTML = ICON_IDLE;
    return button;
  }

  function insertButton() {
    if (document.querySelector(`.${BUTTON_CLASS}`)) return true;

    const searchContainer = document.querySelector('.header__middle .header__search[role="search"]');
    if (!searchContainer) return false;

    const button = createButton();
    searchContainer.insertAdjacentElement('afterend', button);
    return true;
  }

  if (!insertButton()) {
    const observer = new MutationObserver(() => {
      if (insertButton()) observer.disconnect();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }
})();
