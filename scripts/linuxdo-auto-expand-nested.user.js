// ==UserScript==
// @name         LINUX DO Auto Expand Nested Replies
// @name:zh-CN   LINUX DO 自动展开楼中楼
// @namespace    https://linux.do/
// @version      1.4.0
// @description  Convert ordinary LINUX DO topic clicks to Discourse nested view while leaving notification, reply, search, and hash links to the original router.
// @description:zh-CN 将 LINUX DO 普通帖子点击切到嵌套阅读视图，同时保留通知、回复、查询参数和锚点链接给原站路由处理。
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

  const SKIP_TOPIC_LINK_CONTEXTS = [
    "#quick-access-notifications",
    ".quick-access-panel",
    ".quick-access-notifications",
    ".user-menu",
    ".user-menu-tab",
    ".user-notifications-list",
    ".notifications",
    ".notification",
    "[data-notification-id]",
    "[class*='notification']",
  ].join(", ");

  function isLinuxDoTopicHost(url) {
    return url.hostname === "linux.do" || url.hostname === "go.linux.do";
  }

  function shouldSkipTopicRedirect(url) {
    return url.searchParams.get("flat") === "1";
  }

  function hasSearchOrHash(url) {
    return url.search !== "" || url.hash !== "";
  }

  function toNestedTopicUrl(rawUrl) {
    let url;
    try {
      url = new URL(rawUrl, location.href);
    } catch {
      return null;
    }

    if (!isLinuxDoTopicHost(url) || shouldSkipTopicRedirect(url) || hasSearchOrHash(url)) {
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
    if (postNumber && postNumber !== "1") {
      return null;
    }

    url.protocol = "https:";
    url.hostname = "linux.do";
    url.pathname = `/n/topic/${topicId}`;
    return url.href;
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
      window.setTimeout(() => scheduleExpand(), 0);
      return result;
    };
  }

  function isProtectedTopicLinkContext(link) {
    return Boolean(link.closest(SKIP_TOPIC_LINK_CONTEXTS));
  }

  function shouldOpenInNewTab(event, link) {
    return event.metaKey || event.ctrlKey || event.button === 1 || link.target === "_blank";
  }

  function openNestedUrl(event, link, nestedUrl) {
    event.preventDefault();
    event.stopPropagation();

    if (shouldOpenInNewTab(event, link)) {
      window.open(nestedUrl, "_blank", "noopener");
      return;
    }

    location.href = nestedUrl;
  }

  function handleTopicLinkClick(event) {
    if (!CONFIG.autoNestedView || event.defaultPrevented || (event.type === "auxclick" && event.button !== 1)) {
      return;
    }

    const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
    if (!link || isProtectedTopicLinkContext(link)) {
      return;
    }

    const nestedUrl = toNestedTopicUrl(link.href);
    if (!nestedUrl || nestedUrl === link.href) {
      return;
    }

    openNestedUrl(event, link, nestedUrl);
  }

  document.addEventListener("click", handleTopicLinkClick, true);
  document.addEventListener("auxclick", handleTopicLinkClick, true);

  patchHistory("pushState");
  patchHistory("replaceState");

  window.addEventListener("popstate", () => {
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
