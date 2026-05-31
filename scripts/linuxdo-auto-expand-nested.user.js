// ==UserScript==
// @name         LINUX DO Auto Expand Nested Replies
// @name:zh-CN   LINUX DO 自动展开楼中楼
// @namespace    https://linux.do/
// @version      1.0.0
// @description  Redirect LINUX DO topics to Discourse nested view and auto-expand visible nested replies while reading.
// @description:zh-CN 将 LINUX DO 帖子切到嵌套阅读视图，并在阅读时自动展开可见楼中楼回复。
// @author       Codex
// @match        https://linux.do/*
// @icon         https://www.google.com/s2/favicons?domain=linux.do
// @run-at       document-start
// @grant        none
// @license      MIT
// ==/UserScript==

(function () {
  "use strict";

  const CONFIG = {
    autoNestedView: true,
    expandMarginPx: 1200,
    clickDelayMs: 140,
    maxClicksPerPass: 8,
    settleDelayMs: 180,
  };

  const clicked = new WeakSet();
  let scheduled = 0;
  let clickLoopRunning = false;

  function isSameSite(url) {
    return url.origin === location.origin && url.hostname === "linux.do";
  }

  function shouldSkipTopicRedirect(url) {
    return url.searchParams.get("flat") === "1";
  }

  function toNestedTopicUrl(rawUrl) {
    let url;
    try {
      url = new URL(rawUrl, location.href);
    } catch {
      return null;
    }

    if (!isSameSite(url) || shouldSkipTopicRedirect(url)) {
      return null;
    }

    const match =
      url.pathname.match(/^\/t\/topic\/(\d+)(?:\/(\d+))?\/?$/) ||
      url.pathname.match(/^\/t\/[^/]+\/(\d+)(?:\/(\d+))?\/?$/);

    if (!match) {
      return null;
    }

    const topicId = match[1];
    const postNumber = match[2];
    url.pathname = `/n/topic/${topicId}${postNumber && postNumber !== "1" ? `/${postNumber}` : ""}`;
    return url.href;
  }

  function redirectIfNeeded() {
    if (!CONFIG.autoNestedView) {
      return;
    }

    const nestedUrl = toNestedTopicUrl(location.href);
    if (nestedUrl && nestedUrl !== location.href) {
      location.replace(nestedUrl);
    }
  }

  function fixFlatViewLinks() {
    const match = location.pathname.match(/^\/n\/topic\/(\d+)\/(\d+)\/?$/);
    if (!match) {
      return;
    }

    const [, topicId, postNumber] = match;
    document.querySelectorAll('a[href*="?flat=1"]').forEach((link) => {
      const href = link.getAttribute("href") || "";
      const flatMatch = href.match(/^\/t\/topic\/(\d+)\?flat=1$/);
      if (flatMatch && flatMatch[1] === topicId) {
        link.href = `/t/topic/${topicId}/${postNumber}?flat=1`;
      }
    });
  }

  function isVisibleEnough(element) {
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return false;
    }

    return rect.bottom >= -CONFIG.expandMarginPx && rect.top <= window.innerHeight + CONFIG.expandMarginPx;
  }

  function isExpandableButton(button) {
    if (!(button instanceof HTMLButtonElement) || button.disabled || clicked.has(button)) {
      return false;
    }

    if (button.closest(".modal, .d-modal, .composer-popup")) {
      return false;
    }

    return (
      button.matches(".nested-post__expand-replies") ||
      button.matches(".post-action-menu__show-replies.show-replies")
    );
  }

  function collectExpandableButtons() {
    const selectors = [
      ".nested-view button.nested-post__expand-replies",
      ".post-stream button.post-action-menu__show-replies.show-replies",
    ];

    return selectors
      .flatMap((selector) => Array.from(document.querySelectorAll(selector)))
      .filter((button) => isExpandableButton(button) && isVisibleEnough(button));
  }

  async function expandVisibleReplies() {
    if (clickLoopRunning) {
      return;
    }

    clickLoopRunning = true;
    try {
      let expanded = 0;
      for (const button of collectExpandableButtons()) {
        if (expanded >= CONFIG.maxClicksPerPass) {
          break;
        }

        clicked.add(button);
        button.click();
        expanded += 1;
        await new Promise((resolve) => setTimeout(resolve, CONFIG.clickDelayMs));
      }

      if (expanded > 0) {
        scheduleExpand(CONFIG.settleDelayMs);
      }
    } finally {
      clickLoopRunning = false;
    }
  }

  function scheduleExpand(delay = 80) {
    window.clearTimeout(scheduled);
    scheduled = window.setTimeout(() => {
      fixFlatViewLinks();
      expandVisibleReplies();
    }, delay);
  }

  function patchHistory(methodName) {
    const original = history[methodName];
    history[methodName] = function patchedHistoryMethod() {
      const result = original.apply(this, arguments);
      window.setTimeout(() => {
        redirectIfNeeded();
        scheduleExpand();
      }, 0);
      return result;
    };
  }

  redirectIfNeeded();

  document.addEventListener(
    "click",
    (event) => {
      const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (!link) {
        return;
      }

      const nestedUrl = toNestedTopicUrl(link.href);
      if (!nestedUrl || nestedUrl === link.href) {
        return;
      }

      event.preventDefault();
      location.href = nestedUrl;
    },
    true
  );

  patchHistory("pushState");
  patchHistory("replaceState");

  window.addEventListener("popstate", () => {
    redirectIfNeeded();
    scheduleExpand();
  });
  window.addEventListener("scroll", () => scheduleExpand(), { passive: true });
  window.addEventListener("resize", () => scheduleExpand(), { passive: true });
  window.addEventListener("pageshow", () => scheduleExpand(250));
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      scheduleExpand(250);
    }
  });

  const observer = new MutationObserver(() => scheduleExpand());
  const startObserver = () => {
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
    scheduleExpand(250);
  };

  if (document.documentElement) {
    startObserver();
  } else {
    document.addEventListener("DOMContentLoaded", startObserver, { once: true });
  }
})();
