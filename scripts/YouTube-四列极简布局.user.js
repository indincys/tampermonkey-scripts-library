// ==UserScript==
// @name         YouTube 四列极简布局（每行4个视频）
// @namespace    local.codex.youtube.grid4
// @version      0.1.0
// @description  将 YouTube 视频网格布局固定为每行 4 个视频（极简版）
// @author       Codex
// @match        https://www.youtube.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const STYLE_ID = 'codex-youtube-grid-4col-style';

  function injectStyle () {
    if (document.getElementById(STYLE_ID)) return;

    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      /* YouTube 首页 / 订阅等 rich grid：强制每行 4 个 */
      ytd-rich-grid-renderer {
        --ytd-rich-grid-items-per-row: 4 !important;
        --ytd-rich-grid-posts-per-row: 4 !important;
        --ytd-rich-grid-movies-per-row: 4 !important;
      }

      /* 一些页面会在更深层容器上重新定义变量，补一层覆盖 */
      ytd-two-column-browse-results-renderer ytd-rich-grid-renderer {
        --ytd-rich-grid-items-per-row: 4 !important;
      }
    `;

    const root = document.head || document.documentElement;
    if (root) {
      root.appendChild(style);
    }
  }

  injectStyle();

  // YouTube 是 SPA，导航切换后仍可能重建 head，做一次轻量兜底
  new MutationObserver(() => injectStyle()).observe(document.documentElement, {
    childList: true,
    subtree: true
  });
})();
