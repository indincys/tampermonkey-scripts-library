// ==UserScript==
// @name         视频快捷键精简版（Enter / Shift+Enter / ZXC）
// @namespace    local.codex.minimal-video-hotkeys
// @version      0.1.0
// @description  仅保留 Enter 自动全屏播放、Shift+Enter 网页全屏、Z/X/C 倍速控制
// @author       Codex
// @match        *://*/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const CLASS = {
    htmlPageFs: '__mini_vhk_html_pagefs__',
    bodyPageFs: '__mini_vhk_body_pagefs__',
    pageFsContainer: '__mini_vhk_pagefs_container__',
    pageFsChain: '__mini_vhk_pagefs_chain__',
    pageFsVideo: '__mini_vhk_pagefs_video__',
    toast: '__mini_vhk_toast__'
  };

  const RATE_MIN = 0.1;
  const RATE_MAX = 16;
  const RATE_STEP = 0.1;
  const lastNonOneRateMap = new WeakMap();

  let activeVideo = null;
  let pageFullscreenState = null;
  let toastTimer = null;

  injectStyle();
  bindVideoTracking();
  document.addEventListener('keydown', onKeydown, true);

  function injectStyle () {
    if (document.getElementById('__mini_vhk_style__')) return;
    const style = document.createElement('style');
    style.id = '__mini_vhk_style__';
    style.textContent = `
      html.${CLASS.htmlPageFs},
      body.${CLASS.bodyPageFs} {
        overflow: hidden !important;
      }

      .${CLASS.pageFsChain} {
        z-index: 2147483646 !important;
      }

      .${CLASS.pageFsContainer} {
        position: fixed !important;
        inset: 0 !important;
        width: 100vw !important;
        height: 100vh !important;
        max-width: 100vw !important;
        max-height: 100vh !important;
        background: #000 !important;
        margin: 0 !important;
        transform: none !important;
        z-index: 2147483647 !important;
      }

      .${CLASS.pageFsVideo} {
        width: 100% !important;
        height: 100% !important;
        max-width: 100% !important;
        max-height: 100% !important;
        object-fit: contain !important;
        background: #000 !important;
      }

      .${CLASS.toast} {
        position: fixed !important;
        left: 50% !important;
        top: 12% !important;
        transform: translateX(-50%) !important;
        padding: 8px 12px !important;
        border-radius: 8px !important;
        background: rgba(0, 0, 0, 0.72) !important;
        color: #fff !important;
        font: 13px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif !important;
        z-index: 2147483647 !important;
        pointer-events: none !important;
        white-space: nowrap !important;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function bindVideoTracking () {
    document.addEventListener('play', (event) => {
      const video = toVideoFromEvent(event);
      if (video) setActiveVideo(video);
    }, true);

    document.addEventListener('pointerdown', (event) => {
      const video = toVideoFromEvent(event);
      if (video) setActiveVideo(video);
    }, true);

    document.addEventListener('mouseover', (event) => {
      const video = toVideoFromEvent(event);
      if (video) setActiveVideo(video);
    }, true);
  }

  function onKeydown (event) {
    if (!event || event.defaultPrevented) return;

    const target = getEventTarget(event);
    if (isEditableTarget(target)) return;

    const key = String(event.key || '').toLowerCase();
    if (!key) return;

    if (key === 'escape' && pageFullscreenState) {
      exitPageFullscreen();
      return;
    }

    const onlyShift = event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey;
    const noModifier = !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey;

    if (onlyShift && key === 'enter') {
      const video = getBestVideo(event);
      if (!video) return;
      setActiveVideo(video);
      prevent(event);
      togglePageFullscreen(video);
      return;
    }

    if (noModifier && key === 'enter') {
      const video = getBestVideo(event);
      if (!video) return;
      setActiveVideo(video);
      prevent(event);
      toggleNativeFullscreenAndAutoplay(video);
      return;
    }

    if (!noModifier) return;

    if (key === 'x' || key === 'c' || key === 'z') {
      const video = getBestVideo(event);
      if (!video) return;
      setActiveVideo(video);
      prevent(event);

      if (key === 'x') {
        adjustPlaybackRate(video, -RATE_STEP);
      } else if (key === 'c') {
        adjustPlaybackRate(video, RATE_STEP);
      } else {
        toggleResetPlaybackRate(video);
      }
    }
  }

  function prevent (event) {
    event.stopPropagation();
    event.preventDefault();
  }

  function toggleNativeFullscreenAndAutoplay (video) {
    const doc = document;
    const inNativeFullscreen = !!(doc.fullscreenElement || doc.webkitFullscreenElement || doc.mozFullScreenElement || doc.msFullscreenElement);

    if (inNativeFullscreen) {
      exitNativeFullscreen();
      return;
    }

    if (video.paused) {
      try {
        const p = video.play();
        if (p && typeof p.catch === 'function') {
          p.catch(() => {});
        }
      } catch (e) {}
    }

    const container = getFullscreenContainer(video);
    requestNativeFullscreen(container || video);
  }

  function requestNativeFullscreen (el) {
    if (!el) return;
    const fn = el.requestFullscreen || el.webkitRequestFullscreen || el.webkitRequestFullScreen || el.mozRequestFullScreen || el.msRequestFullscreen;
    if (!fn) return;
    try {
      const p = fn.call(el);
      if (p && typeof p.catch === 'function') {
        p.catch(() => {});
      }
    } catch (e) {}
  }

  function exitNativeFullscreen () {
    const doc = document;
    const fn = doc.exitFullscreen || doc.webkitExitFullscreen || doc.webkitCancelFullScreen || doc.mozCancelFullScreen || doc.msExitFullscreen;
    if (!fn) return;
    try {
      const p = fn.call(doc);
      if (p && typeof p.catch === 'function') {
        p.catch(() => {});
      }
    } catch (e) {}
  }

  function togglePageFullscreen (video) {
    if (pageFullscreenState && pageFullscreenState.video === video && pageFullscreenState.container && pageFullscreenState.container.isConnected) {
      exitPageFullscreen();
      return;
    }

    exitPageFullscreen();

    const container = getFullscreenContainer(video);
    const chain = [];
    let node = container;
    while (node && node.nodeType === 1 && node !== document.documentElement) {
      chain.push(node);
      node = node.parentElement;
    }

    for (const el of chain) {
      el.classList.add(CLASS.pageFsChain);
    }
    container.classList.add(CLASS.pageFsContainer);
    video.classList.add(CLASS.pageFsVideo);
    document.documentElement.classList.add(CLASS.htmlPageFs);
    if (document.body) {
      document.body.classList.add(CLASS.bodyPageFs);
    }

    pageFullscreenState = { video, container, chain };
  }

  function exitPageFullscreen () {
    if (!pageFullscreenState) return;

    const { video, container, chain } = pageFullscreenState;
    if (chain) {
      for (const el of chain) {
        if (el && el.classList) {
          el.classList.remove(CLASS.pageFsChain);
        }
      }
    }
    if (container && container.classList) {
      container.classList.remove(CLASS.pageFsContainer);
    }
    if (video && video.classList) {
      video.classList.remove(CLASS.pageFsVideo);
    }
    document.documentElement.classList.remove(CLASS.htmlPageFs);
    if (document.body) {
      document.body.classList.remove(CLASS.bodyPageFs);
    }

    pageFullscreenState = null;
  }

  function adjustPlaybackRate (video, delta) {
    if (!video) return;
    const current = normalizeRate(video.playbackRate || 1);
    const next = normalizeRate(current + delta);
    if (next !== 1) {
      lastNonOneRateMap.set(video, next);
    } else if (current !== 1) {
      lastNonOneRateMap.set(video, current);
    }
    video.playbackRate = next;
    showToast(`播放速度 ${next.toFixed(1)}x`);
  }

  function toggleResetPlaybackRate (video) {
    if (!video) return;
    const current = normalizeRate(video.playbackRate || 1);
    const last = normalizeRate(lastNonOneRateMap.get(video) || 1.5);
    let next = 1;

    if (current === 1) {
      next = last === 1 ? 1.5 : last;
    } else {
      lastNonOneRateMap.set(video, current);
      next = 1;
    }

    video.playbackRate = normalizeRate(next);
    showToast(`播放速度 ${video.playbackRate.toFixed(1)}x`);
  }

  function normalizeRate (value) {
    let n = Number(value);
    if (!Number.isFinite(n)) n = 1;
    if (n < RATE_MIN) n = RATE_MIN;
    if (n > RATE_MAX) n = RATE_MAX;
    return Number(n.toFixed(1));
  }

  function showToast (message) {
    if (!document.body) return;

    let el = document.querySelector(`.${CLASS.toast}`);
    if (!el) {
      el = document.createElement('div');
      el.className = CLASS.toast;
      document.body.appendChild(el);
    }

    el.textContent = message;
    el.style.display = 'block';

    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      if (el) el.style.display = 'none';
    }, 900);
  }

  function setActiveVideo (video) {
    if (!(video instanceof HTMLVideoElement)) return;
    activeVideo = video;
  }

  function getBestVideo (event) {
    const fromEvent = toVideoFromEvent(event);
    if (fromEvent && isUsableVideo(fromEvent)) return fromEvent;

    if (activeVideo && isUsableVideo(activeVideo)) return activeVideo;

    const list = Array.from(document.querySelectorAll('video'));
    if (!list.length) return null;

    let best = null;
    let bestScore = -Infinity;

    for (const video of list) {
      if (!isUsableVideo(video)) continue;
      const score = scoreVideo(video);
      if (score > bestScore) {
        bestScore = score;
        best = video;
      }
    }

    return best;
  }

  function isUsableVideo (video) {
    if (!(video instanceof HTMLVideoElement)) return false;
    if (!video.isConnected) return false;

    const rect = safeRect(video);
    if (!rect || rect.width < 8 || rect.height < 8) return false;

    const visibleW = Math.max(0, Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0));
    const visibleH = Math.max(0, Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0));
    return visibleW > 0 && visibleH > 0;
  }

  function scoreVideo (video) {
    const rect = safeRect(video);
    if (!rect) return -Infinity;

    const visibleW = Math.max(0, Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0));
    const visibleH = Math.max(0, Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0));
    const visibleArea = visibleW * visibleH;
    const totalArea = rect.width * rect.height || 1;
    const visibilityRatio = visibleArea / totalArea;

    let score = visibleArea * visibilityRatio;
    if (!video.paused && !video.ended) score += 1e12;
    if (video === activeVideo) score += 5e11;
    if (video.matches && video.matches(':hover')) score += 2e11;
    return score;
  }

  function safeRect (el) {
    try {
      return el.getBoundingClientRect();
    } catch (e) {
      return null;
    }
  }

  function getFullscreenContainer (video) {
    if (!video) return null;
    const videoRect = safeRect(video);
    if (!videoRect) return video;

    let container = video;
    let parent = video.parentElement;

    while (parent && parent.nodeType === 1 && parent !== document.body && parent !== document.documentElement) {
      const rect = safeRect(parent);
      if (!rect) break;

      const widthFits = rect.width <= videoRect.width + 8;
      const heightFits = rect.height <= videoRect.height + 8;
      if (widthFits && heightFits) {
        container = parent;
        parent = parent.parentElement;
        continue;
      }
      break;
    }

    return container;
  }

  function toVideoFromEvent (event) {
    if (!event) return null;

    const path = typeof event.composedPath === 'function' ? event.composedPath() : null;
    if (Array.isArray(path)) {
      for (const node of path) {
        if (node instanceof HTMLVideoElement) return node;
      }
    }

    const target = getEventTarget(event);
    if (target instanceof HTMLVideoElement) return target;
    if (target && target.closest) {
      const video = target.closest('video');
      if (video instanceof HTMLVideoElement) return video;
    }
    return null;
  }

  function getEventTarget (event) {
    if (!event) return null;
    if (typeof event.composedPath === 'function') {
      const path = event.composedPath();
      if (path && path.length) return path[0];
    }
    return event.target || null;
  }

  function isEditableTarget (target) {
    if (!target || !(target instanceof Element)) return false;
    if (target.isContentEditable) return true;

    const editable = target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="textbox"]');
    return !!editable;
  }
})();
