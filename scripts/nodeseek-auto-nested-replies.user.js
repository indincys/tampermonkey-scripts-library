// ==UserScript==
// @name         NodeSeek Auto Nested Replies
// @name:zh-CN   NodeSeek 自动楼中楼
// @namespace    https://www.nodeseek.com/
// @version      1.11.0
// @description  Turn visible NodeSeek reply references into Linux.do-like nested threads, show user rank/join age/signatures, auto-load next pages, and check in daily with a visible reminder.
// @description:zh-CN 在 NodeSeek 自动签到并提醒；帖子页以类似 Linux.do 的样式整理楼中楼、展示用户等级/加入天数/签名，并自动加载下一页评论。
// @author       Codex
// @match        https://www.nodeseek.com/*
// @icon         https://www.google.com/s2/favicons?domain=nodeseek.com
// @updateURL    https://raw.githubusercontent.com/indincys/tampermonkey-scripts-library/main/scripts/nodeseek-auto-nested-replies.user.js
// @downloadURL  https://raw.githubusercontent.com/indincys/tampermonkey-scripts-library/main/scripts/nodeseek-auto-nested-replies.user.js
// @run-at       document-idle
// @grant        none
// @license      MIT
// ==/UserScript==

(function () {
  "use strict";

  const CONFIG = {
    maxDepth: 4,
    rerenderDelayMs: 180,
    minParentFloor: 1,
    warmupDelaysMs: [250, 700, 1500, 3000, 6000],
    profileCacheKey: "ns-auto-nested-profile-cache-v3",
    profileCacheTtlMs: 6 * 60 * 60 * 1000,
    profileConcurrency: 3,
    collapseFromDepth: Infinity,
    autoPageThresholdPx: 900,
    autoPageRetryDelayMs: 800,
    checkinEnabled: true,
    checkinStorageKey: "ns-auto-checkin-state-v1",
    checkinDelayMs: 2600,
    checkinPendingBackoffMs: 25 * 1000,
    checkinFailureBackoffMs: 30 * 60 * 1000,
    checkinToastMs: 5600,
  };

  let scheduled = 0;
  let profileScheduled = 0;
  let currentPath = "";
  let started = false;
  let applying = false;
  let observer = null;
  let observedTarget = null;
  let autoPageState = null;
  let checkinScheduled = 0;
  let checkinRunning = false;
  let checkinToastTimer = 0;
  let activeProfileRequests = 0;
  const profileCache = loadProfileCache();
  const profileQueue = [];
  const profilePending = new Map();

  function topicPageFromPath(pathname = location.pathname) {
    const match = pathname.match(/^\/post-(\d+)-(\d+)\/?$/);
    return match
      ? {
          topicId: match[1],
          page: Number(match[2]),
        }
      : null;
  }

  function postUrlInfo(rawUrl, baseUrl = location.href) {
    let url;
    try {
      url = new URL(rawUrl, baseUrl);
    } catch {
      return null;
    }

    if (url.origin !== location.origin) {
      return null;
    }

    const info = topicPageFromPath(url.pathname);
    return info ? { ...info, url } : null;
  }

  function getTopicId() {
    return topicPageFromPath()?.topicId || null;
  }

  function floorNumber(comment) {
    const id = comment?.id || "";
    return /^\d+$/.test(id) ? Number(id) : null;
  }

  function sameTopicFloorFromLink(link, topicId) {
    let url;
    try {
      url = new URL(link.getAttribute("href") || "", location.href);
    } catch {
      return null;
    }

    if (url.hostname !== location.hostname) {
      return null;
    }

    const pathMatch = url.pathname.match(/^\/post-(\d+)-(\d+)\/?$/);
    if (!pathMatch || pathMatch[1] !== topicId) {
      return null;
    }

    const floorMatch = url.hash.match(/^#(\d+)$/);
    return floorMatch ? Number(floorMatch[1]) : null;
  }

  function findParentFloor(comment, topicId) {
    const selfFloor = floorNumber(comment);
    if (selfFloor === null) {
      return null;
    }

    const links = Array.from(comment.querySelectorAll(":scope > .post-content a[href]"));
    const floors = links
      .map((link) => sameTopicFloorFromLink(link, topicId))
      .filter(
        (floor) =>
          Number.isInteger(floor) &&
          floor >= CONFIG.minParentFloor &&
          floor !== selfFloor &&
          floor < selfFloor
      );

    return floors.length ? Math.max(...floors) : null;
  }

  function collectComments() {
    return Array.from(document.querySelectorAll(".nsk-post .content-item[id], .comments .content-item[id]")).filter(
      (comment) => floorNumber(comment) !== null
    );
  }

  function commentsList() {
    return document.querySelector(".comment-container .comments");
  }

  function createAutoPageState() {
    const info = topicPageFromPath();
    return {
      topicId: info?.topicId || "",
      loadedPages: new Set(info ? [info.page] : []),
      nextUrl: "",
      loading: false,
      done: false,
      error: false,
      statusEl: null,
    };
  }

  function getAutoPageState() {
    if (!autoPageState) {
      autoPageState = createAutoPageState();
    }

    return autoPageState;
  }

  function resetAutoPageState() {
    autoPageState = createAutoPageState();
    updateNextPageFromDocument(document);
    renderAutoPageStatus();
  }

  function updateAutoPageRootClass() {
    const active = Boolean(topicPageFromPath() && commentsList());
    document.documentElement.classList.toggle("ns-auto-page-active", active);
  }

  function findNextPageUrl(sourceDoc = document, baseUrl = location.href) {
    const state = getAutoPageState();
    const sourceInfo = postUrlInfo(baseUrl);
    const topicId = state.topicId || sourceInfo?.topicId;
    if (!topicId) {
      return "";
    }

    const candidates = Array.from(sourceDoc.querySelectorAll("a.pager-next[href], .nsk-pager a[href]"))
      .map((link) => postUrlInfo(link.getAttribute("href"), baseUrl))
      .filter(
        (info) =>
          info &&
          info.topicId === topicId &&
          Number.isInteger(info.page) &&
          !state.loadedPages.has(info.page)
      )
      .sort((a, b) => a.page - b.page);

    return candidates[0]?.url.href || "";
  }

  function updateNextPageFromDocument(sourceDoc = document, baseUrl = location.href) {
    const state = getAutoPageState();
    if (state.loading || state.done) {
      return;
    }

    const nextUrl = findNextPageUrl(sourceDoc, baseUrl);
    if (nextUrl) {
      state.nextUrl = nextUrl;
      state.error = false;
    } else if (state.loadedPages.size > 0 && commentsList()) {
      state.done = true;
    }
  }

  function ensureAutoPageStatus() {
    const list = commentsList();
    if (!list) {
      return null;
    }

    const state = getAutoPageState();
    if (state.statusEl?.isConnected) {
      return state.statusEl;
    }

    const status = document.createElement("div");
    status.className = "ns-auto-page-status";
    const text = document.createElement("span");
    text.className = "ns-auto-page-status__text";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ns-auto-page-status__button";
    button.addEventListener("click", () => loadNextPage("manual"));
    status.append(text, button);
    list.insertAdjacentElement("afterend", status);
    state.statusEl = status;
    return status;
  }

  function renderAutoPageStatus() {
    updateAutoPageRootClass();
    const state = getAutoPageState();
    const status = ensureAutoPageStatus();
    if (!status) {
      return;
    }

    const text = status.querySelector(".ns-auto-page-status__text");
    const button = status.querySelector(".ns-auto-page-status__button");
    const stateName = state.loading ? "loading" : state.done ? "done" : state.error ? "error" : "ready";
    if (status.dataset.state !== stateName) {
      status.dataset.state = stateName;
    }

    const setText = (element, value) => {
      if (element.textContent !== value) {
        element.textContent = value;
      }
    };

    const setButton = (hidden, value = "") => {
      if (button.hidden !== hidden) {
        button.hidden = hidden;
      }
      if (!hidden && button.textContent !== value) {
        button.textContent = value;
      }
    };

    if (state.loading) {
      setText(text, "正在加载下一页评论...");
      setButton(true);
      return;
    }

    if (state.error) {
      setText(text, "自动翻页加载失败");
      setButton(false, "重试");
      return;
    }

    if (state.done) {
      setText(text, "已加载到最后一页");
      setButton(true);
      return;
    }

    if (state.nextUrl) {
      const nextInfo = postUrlInfo(state.nextUrl);
      setText(text, `自动翻页已开启${nextInfo ? `，下一页 ${nextInfo.page}` : ""}`);
      setButton(false, "立即加载");
      return;
    }

    setText(text, "正在检测下一页...");
    setButton(true);
  }

  function nearPageBottom() {
    const root = document.documentElement;
    return root.scrollHeight - (window.scrollY + window.innerHeight) <= CONFIG.autoPageThresholdPx;
  }

  function insertPageDivider(page) {
    const list = commentsList();
    if (!list || list.querySelector(`:scope > .ns-auto-page-divider[data-page="${page}"]`)) {
      return;
    }

    const divider = document.createElement("li");
    divider.className = "ns-auto-page-divider";
    divider.dataset.page = String(page);
    divider.textContent = `第 ${page} 页`;
    list.append(divider);
  }

  function appendFetchedComments(sourceDoc, page) {
    const list = commentsList();
    if (!list) {
      return 0;
    }

    const existingIds = new Set(collectComments().map((comment) => comment.id));
    const incoming = Array.from(sourceDoc.querySelectorAll(".comments > .content-item[id]")).filter(
      (comment) => floorNumber(comment) !== null && !existingIds.has(comment.id)
    );

    if (!incoming.length) {
      return 0;
    }

    insertPageDivider(page);
    incoming.forEach((comment) => {
      list.append(document.importNode(comment, true));
      existingIds.add(comment.id);
    });
    return incoming.length;
  }

  async function loadNextPage(reason = "auto") {
    const state = getAutoPageState();
    updateNextPageFromDocument(document);
    if (state.loading || state.done || !state.nextUrl) {
      renderAutoPageStatus();
      return;
    }

    state.loading = true;
    state.error = false;
    renderAutoPageStatus();

    const targetUrl = state.nextUrl;
    try {
      const response = await fetch(targetUrl, {
        credentials: "same-origin",
        headers: {
          accept: "text/html,application/xhtml+xml",
        },
      });
      if (!response.ok) {
        throw new Error(`page ${targetUrl}: ${response.status}`);
      }

      const html = await response.text();
      const doc = new DOMParser().parseFromString(html, "text/html");
      const pageInfo = postUrlInfo(response.url || targetUrl);
      if (!pageInfo || pageInfo.topicId !== state.topicId) {
        throw new Error("unexpected page");
      }

      const appended = appendFetchedComments(doc, pageInfo.page);
      state.loadedPages.add(pageInfo.page);
      state.nextUrl = findNextPageUrl(doc, response.url || targetUrl);
      state.done = !state.nextUrl;
      state.error = false;

      if (appended > 0) {
        observeBestTarget();
        applyNesting();
        applyUserProfiles();
      }
    } catch {
      state.error = true;
    } finally {
      state.loading = false;
      renderAutoPageStatus();
      if (reason === "auto" && !state.error && !state.done && nearPageBottom()) {
        window.setTimeout(() => loadNextPage("auto"), CONFIG.autoPageRetryDelayMs);
      }
    }
  }

  function maybeLoadNextPage() {
    const state = getAutoPageState();
    updateNextPageFromDocument(document);
    renderAutoPageStatus();
    if (!state.loading && !state.done && state.nextUrl && nearPageBottom()) {
      loadNextPage("auto");
    }
  }

  function checkinTodayKey(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function readCheckinState() {
    try {
      const parsed = JSON.parse(localStorage.getItem(CONFIG.checkinStorageKey) || "{}");
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  function writeCheckinState(patch) {
    const next = {
      ...readCheckinState(),
      ...patch,
    };

    try {
      localStorage.setItem(CONFIG.checkinStorageKey, JSON.stringify(next));
    } catch {
      // Ignore storage failures. The request itself should not be blocked by private-mode storage.
    }

    return next;
  }

  function checkinDoneToday(state = readCheckinState()) {
    return (
      state.date === checkinTodayKey() &&
      (state.status === "success" || state.status === "already")
    );
  }

  function shouldSkipCheckin() {
    const state = readCheckinState();
    if (checkinDoneToday(state)) {
      return true;
    }

    const lastAttemptAt = Number(state.lastAttemptAt || 0);
    if (state.lastAttemptDate !== checkinTodayKey() || lastAttemptAt <= 0) {
      return false;
    }

    const backoffMs = state.status === "pending" ? CONFIG.checkinPendingBackoffMs : CONFIG.checkinFailureBackoffMs;
    return ["pending", "login", "error"].includes(state.status) && Date.now() - lastAttemptAt < backoffMs;
  }

  function messageFromCheckinPayload(payload, fallbackText) {
    const candidates = [
      payload?.message,
      payload?.msg,
      payload?.detail?.message,
      payload?.detail?.msg,
      payload?.data?.message,
      payload?.data?.msg,
      typeof payload?.detail === "string" ? payload.detail : "",
      typeof payload?.data === "string" ? payload.data : "",
      fallbackText,
    ];

    return candidates
      .map((value) => String(value || "").replace(/\s+/g, " ").trim())
      .find(Boolean) || "";
  }

  function parseCheckinResult(statusCode, text) {
    let payload = null;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }

    const message = messageFromCheckinPayload(payload, text).slice(0, 140);
    const inspectText = `${message} ${String(text || "").slice(0, 360)}`.toLowerCase();
    const already = /已签到|已经签到|今日.*签到|already\s*signed|checked\s*in|signed\s*in/.test(inspectText);
    const loginRequired = /未登录|请先登录|登录后|user\s*not\s*found|login|unauthorized|forbidden/.test(inspectText);
    const apiSuccess =
      payload?.success === true ||
      payload?.ok === true ||
      payload?.code === 0 ||
      payload?.code === 200 ||
      payload?.status === 0 ||
      payload?.status === 200 ||
      payload?.status === true ||
      payload?.status === "success";
    const successText = /签到成功|打卡成功|签到.*成功|获得.*?(鸡腿|积分|经验|奖励)|successfully|success/.test(inspectText);

    if (apiSuccess || (statusCode >= 200 && statusCode < 300 && successText && !loginRequired)) {
      return {
        ok: true,
        status: already ? "already" : "success",
        message: message || "签到成功",
      };
    }

    if (already) {
      return {
        ok: true,
        status: "already",
        message: message || "今日已签到",
      };
    }

    if (statusCode === 401 || statusCode === 403 || loginRequired) {
      return {
        ok: false,
        status: "login",
        message: "未登录或会话过期，已跳过自动签到",
      };
    }

    return {
      ok: false,
      status: "error",
      message: message || `签到接口返回 ${statusCode || "未知状态"}`,
    };
  }

  function showCheckinToast(message, tone = "success") {
    if (!message) {
      return;
    }

    if (!document.body) {
      window.setTimeout(() => showCheckinToast(message, tone), 200);
      return;
    }

    let toast = document.querySelector(".ns-auto-checkin-toast");
    if (!toast) {
      toast = document.createElement("div");
      toast.className = "ns-auto-checkin-toast";
      toast.setAttribute("role", "status");
      toast.setAttribute("aria-live", "polite");
      document.body.append(toast);
    }

    toast.dataset.tone = tone;
    toast.textContent = message;
    toast.dataset.visible = "true";

    window.clearTimeout(checkinToastTimer);
    checkinToastTimer = window.setTimeout(() => {
      toast.dataset.visible = "false";
      window.setTimeout(() => {
        if (toast.dataset.visible !== "true") {
          toast.remove();
        }
      }, 180);
    }, CONFIG.checkinToastMs);
  }

  function notifyCheckinResult(result, today) {
    if (!result?.ok) {
      return;
    }

    const state = readCheckinState();
    if (state.notifiedDate === today && state.notifiedStatus === result.status) {
      return;
    }

    const label = result.status === "already" ? "NodeSeek 今日已签到" : "NodeSeek 签到成功";
    const duplicate =
      result.status === "already"
        ? /已签到|已经签到/.test(result.message)
        : /签到成功|打卡成功|success/i.test(result.message);
    const suffix = result.message && !duplicate ? `：${result.message}` : "";
    showCheckinToast(`${label}${suffix}`, result.status === "already" ? "already" : "success");
    writeCheckinState({
      notifiedAt: Date.now(),
      notifiedDate: today,
      notifiedStatus: result.status,
    });
  }

  async function runAutoCheckin() {
    if (!CONFIG.checkinEnabled || checkinRunning || shouldSkipCheckin()) {
      return;
    }

    checkinRunning = true;
    const today = checkinTodayKey();
    writeCheckinState({
      status: "pending",
      lastAttemptAt: Date.now(),
      lastAttemptDate: today,
    });

    try {
      const response = await fetch("/api/attendance", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          accept: "application/json, text/plain, */*",
          "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
          "x-requested-with": "XMLHttpRequest",
        },
        body: "random=true",
      });
      const text = await response.text();
      const result = parseCheckinResult(response.status, text);

      writeCheckinState({
        date: result.ok ? today : undefined,
        status: result.status,
        message: result.message,
        lastAttemptAt: Date.now(),
        lastAttemptDate: today,
      });

      if (result.ok) {
        notifyCheckinResult(result, today);
      } else if (result.status !== "login") {
        console.debug("[NodeSeek Auto Nested Replies] auto check-in skipped:", result.message);
      }
    } catch (error) {
      writeCheckinState({
        status: "error",
        message: error?.message || String(error),
        lastAttemptAt: Date.now(),
        lastAttemptDate: today,
      });
      console.debug("[NodeSeek Auto Nested Replies] auto check-in failed:", error);
    } finally {
      checkinRunning = false;
    }
  }

  function scheduleCheckin(delay = CONFIG.checkinDelayMs) {
    window.clearTimeout(checkinScheduled);
    checkinScheduled = window.setTimeout(runAutoCheckin, delay);
  }

  function loadProfileCache() {
    try {
      const parsed = JSON.parse(localStorage.getItem(CONFIG.profileCacheKey) || "{}");
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  function saveProfileCache() {
    try {
      localStorage.setItem(CONFIG.profileCacheKey, JSON.stringify(profileCache));
    } catch {
      // Ignore quota and private-mode failures. The badge still works for this page load.
    }
  }

  function getMemberIdFromAuthor(authorLink) {
    const href = authorLink?.getAttribute("href") || "";
    const match = href.match(/^\/space\/(\d+)\/?$/);
    return match ? match[1] : null;
  }

  function normalizeJoinDays(value) {
    if (!value) {
      return "";
    }

    const text = String(value).trim();
    const days = text.match(/^(\d+)\s*days?\s*ago$/i);
    if (days) {
      return `${days[1]}天`;
    }

    return text
      .replace(/\s*days?\s*ago/i, "天")
      .replace(/\s*day\s*ago/i, "天")
      .replace(/\s+/g, "");
  }

  function cachedProfile(memberId) {
    const record = profileCache[memberId];
    if (!record || Date.now() - record.cachedAt > CONFIG.profileCacheTtlMs) {
      return null;
    }

    return record.data;
  }

  function profileFromApi(detail) {
    const rank = Number(detail?.rank);
    const joinDays = normalizeJoinDays(detail?.created_at_str);
    const signature = String(detail?.readme || detail?.bio || "")
      .replace(/\r\n/g, "\n")
      .trim();
    return {
      rank: Number.isFinite(rank) ? rank : null,
      joinDays,
      signature,
    };
  }

  async function fetchProfile(memberId) {
    const cached = cachedProfile(memberId);
    if (cached) {
      return cached;
    }

    if (profilePending.has(memberId)) {
      return profilePending.get(memberId);
    }

    const request = fetch(`/api/account/getInfo/${memberId}?readme=1`, {
      credentials: "same-origin",
      headers: {
        accept: "application/json",
      },
    })
      .then((response) => {
        if (!response.ok) {
          throw new Error(`profile ${memberId}: ${response.status}`);
        }
        return response.json();
      })
      .then((json) => {
        if (!json?.success) {
          throw new Error(`profile ${memberId}: api failed`);
        }

        const data = profileFromApi(json.detail);
        profileCache[memberId] = {
          cachedAt: Date.now(),
          data,
        };
        saveProfileCache();
        return data;
      })
      .catch(() => null)
      .finally(() => {
        profilePending.delete(memberId);
      });

    profilePending.set(memberId, request);
    return request;
  }

  function rankTone(rank) {
    if (!Number.isFinite(rank)) {
      return "unknown";
    }

    return String(Math.max(0, Math.min(9, rank)));
  }

  function normalizeSignature(signature) {
    return String(signature || "")
      .replace(/\r\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
      .slice(0, 600);
  }

  function interactiveTarget(target) {
    return Boolean(target?.closest?.("a, button, input, textarea, select, label, summary, .comment-menu"));
  }

  function setupNestedSignatureToggle(comment) {
    if (!comment || comment.dataset.nsSignatureToggleReady === "true") {
      return;
    }

    comment.dataset.nsSignatureToggleReady = "true";
    comment.addEventListener("click", (event) => {
      if (interactiveTarget(event.target)) {
        return;
      }

      const ownItem = event.target.closest?.(".content-item.ns-auto-nested-item");
      if (ownItem !== comment) {
        return;
      }

      const signature = comment.querySelector(":scope > .ns-auto-nested-signature");
      if (!signature || signature.hidden) {
        return;
      }

      const opened = comment.dataset.signatureOpen === "true";
      comment.dataset.signatureOpen = opened ? "false" : "true";
    });
  }

  function paragraphWithoutParentReferences(paragraph) {
    const clone = paragraph.cloneNode(true);
    clone.querySelectorAll(".ns-auto-parent-reference").forEach((element) => element.remove());
    return clone.textContent.replace(/\s+/g, "").trim();
  }

  function onlyParentMentionLeft(text) {
    return /^@[\w.\-_\u4e00-\u9fff]+$/.test(text);
  }

  function hideParentMentionBefore(link) {
    let cursor = link.previousSibling;
    while (cursor && cursor.nodeType === Node.TEXT_NODE && !cursor.textContent.trim()) {
      const previous = cursor.previousSibling;
      cursor.textContent = "";
      cursor = previous;
    }

    if (!cursor) {
      return;
    }

    if (cursor.nodeType === Node.ELEMENT_NODE) {
      const text = cursor.textContent.trim();
      if (cursor.matches("a") && /^@/.test(text)) {
        cursor.classList.add("ns-auto-parent-reference");
      }
      return;
    }

    if (cursor.nodeType === Node.TEXT_NODE) {
      cursor.textContent = cursor.textContent.replace(/@[\w.\-_\u4e00-\u9fff]+\s*$/, "");
    }
  }

  function comparableText(text) {
    return String(text || "")
      .replace(/\s+/g, "")
      .trim();
  }

  function hideNestedInlineSignature(comment, signatureText) {
    const signatureKey = comparableText(signatureText);
    const content = comment.querySelector(":scope > .post-content");
    if (!content || !signatureKey) {
      return;
    }

    Array.from(content.children).forEach((child) => {
      if (comparableText(child.textContent) === signatureKey) {
        child.classList.add("ns-auto-inline-signature");
        const previous = child.previousElementSibling;
        if (previous && (previous.tagName === "HR" || !comparableText(previous.textContent))) {
          previous.classList.add("ns-auto-inline-signature");
        }
      }
    });
  }

  function ensureNestedSignature(comment, signatureText) {
    const normalized = normalizeSignature(signatureText);
    let signature = comment.querySelector(":scope > .ns-auto-nested-signature");
    if (!signature) {
      signature = document.createElement("div");
      signature.className = "ns-auto-nested-signature";
      const content = comment.querySelector(":scope > .post-content");
      if (content) {
        content.insertAdjacentElement("afterend", signature);
      } else {
        comment.append(signature);
      }
    }

    if (!normalized) {
      signature.hidden = true;
      signature.textContent = "";
      comment.dataset.nsSignatureAvailable = "false";
      comment.removeAttribute("title");
      return;
    }

    signature.hidden = false;
    signature.textContent = normalized;
    comment.dataset.nsSignatureAvailable = "true";
    if (!comment.dataset.signatureOpen) {
      comment.dataset.signatureOpen = "false";
    }
    comment.title = "点击显示/隐藏签名";
  }

  function markInlineSignatureCandidate(comment) {
    const content = comment.querySelector(":scope > .post-content");
    if (!content || content.dataset.nsSignatureCandidateChecked === "true") {
      return;
    }

    content.dataset.nsSignatureCandidateChecked = "true";
    const separators = Array.from(content.children).filter((child) => child.tagName === "HR");
    const separator = separators.at(-1);
    if (!separator) {
      return;
    }

    const trailing = [];
    let cursor = separator.nextElementSibling;
    while (cursor) {
      trailing.push(cursor);
      cursor = cursor.nextElementSibling;
    }

    const text = trailing.map((element) => element.textContent.trim()).filter(Boolean).join("\n");
    const compact = comparableText(text);
    const containsHeavyContent = trailing.some((element) =>
      element.matches("pre, code, blockquote, table, video, iframe") ||
      element.querySelector("pre, code, blockquote, table, video, iframe")
    );

    if (!compact || compact.length > 160 || trailing.length > 4 || containsHeavyContent) {
      return;
    }

    separator.classList.add("ns-auto-inline-signature");
    trailing.forEach((element) => element.classList.add("ns-auto-inline-signature"));
    comment.dataset.nsInlineSignatureText = text;
    ensureNestedSignature(comment, text);
  }

  function hideLeadingReplyReferences(comment, topicId) {
    const content = comment.querySelector(":scope > .post-content");
    const selfFloor = floorNumber(comment);
    if (!content || !topicId || !Number.isInteger(selfFloor)) {
      return;
    }

    const paragraphs = Array.from(content.querySelectorAll(":scope > p"));
    for (const paragraph of paragraphs) {
      const references = Array.from(paragraph.querySelectorAll("a[href]")).filter((link) => {
        const floor = sameTopicFloorFromLink(link, topicId);
        return Number.isInteger(floor) && floor < selfFloor;
      });

      references.forEach((link) => {
        hideParentMentionBefore(link);
        link.classList.add("ns-auto-parent-reference");
      });

      const remaining = paragraphWithoutParentReferences(paragraph);
      if (paragraph.querySelector(".ns-auto-parent-reference") && (!remaining || onlyParentMentionLeft(remaining))) {
        paragraph.classList.add("ns-auto-parent-reference-line");
      }

      if (remaining && !onlyParentMentionLeft(remaining)) {
        break;
      }
    }
  }

  function prepareNestedComment(comment, parentFloor, topicId) {
    comment.classList.add("ns-auto-nested-item");
    comment.dataset.nsNestedParent = String(parentFloor || "");
    hideLeadingReplyReferences(comment, topicId);
    markInlineSignatureCandidate(comment);
    setupNestedSignatureToggle(comment);
  }

  function renderNestedSignature(authorLink, profile) {
    const comment = authorLink.closest(".content-item.ns-auto-nested-item");
    if (!comment) {
      return;
    }

    setupNestedSignatureToggle(comment);
    markInlineSignatureCandidate(comment);
    const signatureText = normalizeSignature(profile.signature || comment.dataset.nsInlineSignatureText || "");
    hideNestedInlineSignature(comment, signatureText);
    ensureNestedSignature(comment, signatureText);
  }

  function renderProfileBadge(authorLink, profile) {
    if (!profile || !authorLink || !authorLink.parentElement) {
      return;
    }

    let badge = authorLink.parentElement.querySelector(":scope > .ns-auto-user-profile-badge");
    if (!badge) {
      badge = document.createElement("span");
      badge.className = "ns-auto-user-profile-badge";
      authorLink.insertAdjacentElement("afterend", badge);
    }

    const rankText = profile.rank === null ? "Lv?" : `Lv${profile.rank}`;
    const joinText = profile.joinDays || "未知";
    badge.dataset.rank = rankTone(profile.rank);
    badge.textContent = `${rankText} · ${joinText}`;
    badge.title = `等级 ${rankText}，加入 ${joinText}`;
    renderNestedSignature(authorLink, profile);
  }

  function enqueueProfile(authorLink, memberId) {
    if (!memberId || authorLink.dataset.nsProfileQueued === "true") {
      return;
    }

    const cached = cachedProfile(memberId);
    if (cached) {
      renderProfileBadge(authorLink, cached);
      return;
    }

    authorLink.dataset.nsProfileQueued = "true";
    profileQueue.push({ authorLink, memberId });
  }

  function pumpProfileQueue() {
    while (activeProfileRequests < CONFIG.profileConcurrency && profileQueue.length) {
      const { authorLink, memberId } = profileQueue.shift();
      activeProfileRequests += 1;

      fetchProfile(memberId)
      .then((profile) => {
        renderProfileBadge(authorLink, profile);
      })
      .finally(() => {
        if (!authorLink.parentElement?.querySelector(":scope > .ns-auto-user-profile-badge")) {
          delete authorLink.dataset.nsProfileQueued;
        }
        activeProfileRequests -= 1;
        pumpProfileQueue();
      });
    }
  }

  function applyUserProfiles() {
    const authors = Array.from(document.querySelectorAll(".content-item .author-name[href^='/space/']"));
    authors.forEach((authorLink) => enqueueProfile(authorLink, getMemberIdFromAuthor(authorLink)));
    pumpProfileQueue();
  }

  function depthOf(comment) {
    let depth = 0;
    let cursor = comment.parentElement;
    while (cursor) {
      if (cursor.classList?.contains("ns-auto-nested-children")) {
        depth += 1;
      }
      cursor = cursor.parentElement;
    }
    return depth;
  }

  function getOrCreateChildren(parent) {
    let children = parent.querySelector(":scope > .ns-auto-nested-children");
    if (children) {
      children.dataset.depth = children.dataset.depth || String(depthOf(parent) + 1);
      return children;
    }

    children = document.createElement("ol");
    children.className = "ns-auto-nested-children";
    children.dataset.depth = String(depthOf(parent) + 1);
    children.dataset.collapsed = "false";

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "ns-auto-nested-toggle";
    toggle.textContent = "楼中楼";
    toggle.addEventListener("click", () => {
      const collapsed = children.dataset.collapsed === "true";
      children.dataset.collapsed = collapsed ? "false" : "true";
      updateToggle(children);
    });

    parent.append(toggle, children);
    updateToggle(children);
    return children;
  }

  function updateToggle(children) {
    const toggle = children.previousElementSibling;
    if (!toggle?.classList?.contains("ns-auto-nested-toggle")) {
      return;
    }

    const count = children.querySelectorAll(":scope > .content-item").length;
    const collapsed = children.dataset.collapsed === "true";
    const depth = Number(children.dataset.depth || 1);
    const label = depth >= CONFIG.collapseFromDepth ? "后续回复" : "楼中楼";
    const nextText = `${collapsed ? "展开" : "收起"}${label} (${count})`;
    if (toggle.textContent !== nextText) {
      toggle.textContent = nextText;
    }
    toggle.setAttribute("aria-expanded", String(!collapsed));
  }

  function moveIntoParent(comment, parent, parentFloor, topicId) {
    if (!parent || parent === comment || comment.contains(parent)) {
      return false;
    }

    if (depthOf(parent) >= CONFIG.maxDepth) {
      return false;
    }

    const children = getOrCreateChildren(parent);
    prepareNestedComment(comment, parentFloor, topicId);
    if (comment.parentElement === children) {
      return false;
    }

    children.append(comment);
    comment.dataset.nsNestedDepth = children.dataset.depth || String(depthOf(parent) + 1);
    parent.classList.add("ns-auto-nested-parent");
    updateToggle(children);
    return true;
  }

  function resetForPathChange() {
    if (currentPath === location.pathname) {
      return;
    }

    currentPath = location.pathname;
    document.documentElement.classList.remove("ns-auto-nested-ready");
    resetAutoPageState();
  }

  function applyNesting() {
    if (applying) {
      return;
    }

    applying = true;
    try {
      resetForPathChange();

      const topicId = getTopicId();
      if (!topicId) {
        return;
      }

      const comments = collectComments();
      const byFloor = new Map(comments.map((comment) => [floorNumber(comment), comment]));
      let moved = 0;

      comments.forEach((comment) => {
        const parentFloor = findParentFloor(comment, topicId);
        if (!parentFloor) {
          return;
        }

        const parent = byFloor.get(parentFloor);
        if (moveIntoParent(comment, parent, parentFloor, topicId)) {
          moved += 1;
        }
      });

      document.querySelectorAll(".ns-auto-nested-children").forEach(updateToggle);
      document.documentElement.classList.toggle(
        "ns-auto-nested-ready",
        moved > 0 || document.querySelector(".ns-auto-nested-item")
      );
      updateNextPageFromDocument(document);
      renderAutoPageStatus();
      scheduleProfiles();
    } finally {
      applying = false;
    }
  }

  function scheduleApply(delay = CONFIG.rerenderDelayMs) {
    window.clearTimeout(scheduled);
    scheduled = window.setTimeout(applyNesting, delay);
  }

  function scheduleProfiles(delay = CONFIG.rerenderDelayMs) {
    window.clearTimeout(profileScheduled);
    profileScheduled = window.setTimeout(applyUserProfiles, delay);
  }

  function installStyles() {
    if (document.getElementById("ns-auto-nested-style")) {
      return;
    }

    const style = document.createElement("style");
    style.id = "ns-auto-nested-style";
    style.textContent = `
      .ns-auto-nested-toggle {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 4px;
        margin: 7px 0 0 58px;
        padding: 0;
        border: 0;
        border-radius: 0;
        background: transparent;
        color: rgba(75, 88, 108, .58);
        font-size: 11px;
        font-weight: 600;
        line-height: 1.6;
        cursor: pointer;
        user-select: none;
      }

      .ns-auto-nested-toggle::before {
        content: "+";
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 12px;
        height: 12px;
        border: 1px solid rgba(112, 125, 143, .24);
        border-radius: 999px;
        color: rgba(75, 88, 108, .46);
        font-size: 10px;
        line-height: 1;
      }

      .ns-auto-nested-toggle[aria-expanded="true"]::before {
        content: "-";
      }

      .ns-auto-nested-toggle:hover {
        color: rgba(75, 88, 108, .86);
      }

      .ns-auto-page-status {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
        margin: 12px 0;
        min-height: 30px;
        color: rgba(75, 88, 108, .72);
        font-size: 12px;
      }

      .ns-auto-page-status__button {
        padding: 2px 9px;
        border: 1px solid rgba(112, 125, 143, .26);
        border-radius: 4px;
        background: rgba(112, 125, 143, .06);
        color: rgba(75, 88, 108, .90);
        font-size: 12px;
        line-height: 1.55;
        cursor: pointer;
      }

      .ns-auto-page-status[data-state="loading"] .ns-auto-page-status__text::before {
        content: "";
        display: inline-block;
        width: 7px;
        height: 7px;
        margin-right: 6px;
        border: 1px solid currentColor;
        border-top-color: transparent;
        border-radius: 999px;
        animation: ns-auto-spin .75s linear infinite;
        vertical-align: 1px;
      }

      .ns-auto-page-status[data-state="error"] {
        color: #b42318;
      }

      html.ns-auto-page-active .comment-container .nsk-pager,
      html.ns-auto-page-active .comment-container .pager,
      html.ns-auto-page-active .comment-container .pagination,
      html.ns-auto-page-active .comment-container [class*="pagination"],
      html.ns-auto-page-active .comment-container [class*="pager"] {
        display: none !important;
      }

      .ns-auto-checkin-toast {
        position: fixed;
        right: 16px;
        top: 18px;
        z-index: 2147483647;
        max-width: min(360px, calc(100vw - 32px));
        padding: 9px 12px;
        border: 1px solid rgba(20, 148, 105, .26);
        border-radius: 6px;
        background: rgba(255, 255, 255, .96);
        color: #087451;
        box-shadow: 0 8px 24px rgba(16, 24, 40, .14);
        font-size: 12px;
        font-weight: 650;
        line-height: 1.55;
        opacity: 0;
        transform: translateY(8px);
        transition: opacity .16s ease, transform .16s ease;
        pointer-events: none;
      }

      .ns-auto-checkin-toast::before {
        content: "签到";
        display: inline-flex;
        margin-right: 7px;
        padding: 0 5px;
        border-radius: 999px;
        background: rgba(20, 148, 105, .12);
        color: #087451;
        font-size: 11px;
        line-height: 1.55;
      }

      .ns-auto-checkin-toast[data-tone="already"] {
        border-color: rgba(37, 99, 235, .22);
        color: #1d4ed8;
      }

      .ns-auto-checkin-toast[data-tone="already"]::before {
        background: rgba(37, 99, 235, .11);
        color: #1d4ed8;
      }

      .ns-auto-checkin-toast[data-visible="true"] {
        opacity: 1;
        transform: translateY(0);
      }

      .ns-auto-page-divider {
        display: flex;
        align-items: center;
        gap: 10px;
        margin: 14px 0 10px;
        color: rgba(75, 88, 108, .56);
        font-size: 12px;
        list-style: none;
      }

      .ns-auto-page-divider::before,
      .ns-auto-page-divider::after {
        content: "";
        flex: 1;
        height: 1px;
        background: rgba(112, 125, 143, .16);
      }

      @keyframes ns-auto-spin {
        to {
          transform: rotate(360deg);
        }
      }

      .ns-auto-user-profile-badge {
        --ns-rank-bg: rgba(112, 125, 143, .10);
        --ns-rank-border: rgba(112, 125, 143, .22);
        --ns-rank-text: rgba(76, 88, 106, .90);
        --ns-rank-shadow: none;
        display: inline-flex;
        align-items: center;
        margin-left: 6px;
        padding: 1px 6px;
        border: 1px solid var(--ns-rank-border);
        border-radius: 999px;
        background: var(--ns-rank-bg);
        color: var(--ns-rank-text);
        box-shadow: var(--ns-rank-shadow);
        font-size: 11px;
        font-weight: 650;
        line-height: 1.45;
        white-space: nowrap;
        vertical-align: 1px;
      }

      .ns-auto-user-profile-badge[data-rank="0"],
      .ns-auto-user-profile-badge[data-rank="unknown"] {
        --ns-rank-bg: rgba(116, 122, 132, .10);
        --ns-rank-border: rgba(116, 122, 132, .24);
        --ns-rank-text: #667085;
      }

      .ns-auto-user-profile-badge[data-rank="1"] {
        --ns-rank-bg: rgba(20, 148, 105, .11);
        --ns-rank-border: rgba(20, 148, 105, .30);
        --ns-rank-text: #087451;
      }

      .ns-auto-user-profile-badge[data-rank="2"] {
        --ns-rank-bg: rgba(8, 145, 178, .12);
        --ns-rank-border: rgba(8, 145, 178, .32);
        --ns-rank-text: #0e7490;
      }

      .ns-auto-user-profile-badge[data-rank="3"] {
        --ns-rank-bg: rgba(37, 99, 235, .12);
        --ns-rank-border: rgba(37, 99, 235, .32);
        --ns-rank-text: #1d4ed8;
      }

      .ns-auto-user-profile-badge[data-rank="4"] {
        --ns-rank-bg: linear-gradient(135deg, rgba(124, 58, 237, .16), rgba(99, 102, 241, .09));
        --ns-rank-border: rgba(124, 58, 237, .38);
        --ns-rank-text: #6d28d9;
      }

      .ns-auto-user-profile-badge[data-rank="5"] {
        --ns-rank-bg: linear-gradient(135deg, rgba(219, 39, 119, .15), rgba(168, 85, 247, .10));
        --ns-rank-border: rgba(219, 39, 119, .38);
        --ns-rank-text: #be185d;
      }

      .ns-auto-user-profile-badge[data-rank="6"] {
        --ns-rank-bg: linear-gradient(135deg, rgba(251, 191, 36, .25), rgba(217, 119, 6, .12));
        --ns-rank-border: rgba(217, 119, 6, .42);
        --ns-rank-text: #9a4a00;
        --ns-rank-shadow: inset 0 1px 0 rgba(255, 255, 255, .45);
      }

      .ns-auto-user-profile-badge[data-rank="7"] {
        --ns-rank-bg: linear-gradient(135deg, rgba(250, 204, 21, .34), rgba(220, 38, 38, .14));
        --ns-rank-border: rgba(202, 138, 4, .52);
        --ns-rank-text: #8a3b00;
        --ns-rank-shadow: inset 0 1px 0 rgba(255, 255, 255, .52), 0 1px 3px rgba(202, 138, 4, .18);
      }

      .ns-auto-user-profile-badge[data-rank="8"] {
        --ns-rank-bg: linear-gradient(135deg, rgba(255, 244, 214, .88), rgba(185, 28, 28, .18) 42%, rgba(250, 204, 21, .28));
        --ns-rank-border: rgba(180, 83, 9, .58);
        --ns-rank-text: #7f1d1d;
        --ns-rank-shadow: inset 0 1px 0 rgba(255, 255, 255, .58), 0 1px 4px rgba(180, 83, 9, .22);
      }

      .ns-auto-user-profile-badge[data-rank="9"] {
        --ns-rank-bg: linear-gradient(135deg, #241b11, #6b3f12 46%, #f7d774);
        --ns-rank-border: rgba(247, 215, 116, .76);
        --ns-rank-text: #fff4bf;
        --ns-rank-shadow: inset 0 1px 0 rgba(255, 255, 255, .22), 0 1px 6px rgba(111, 66, 18, .32);
      }

      .ns-auto-nested-children {
        --ns-tree-line: rgba(112, 125, 143, .20);
        --ns-tree-line-strong: rgba(112, 125, 143, .32);
        --ns-tree-surface: #fff;
        position: relative;
        margin: 8px 0 0 44px;
        padding: 0 0 0 18px;
        border-left: 0;
        list-style: none;
      }

      .ns-auto-nested-children::before {
        content: "";
        position: absolute;
        left: 0;
        top: 4px;
        bottom: 23px;
        width: 2px;
        border-radius: 999px;
        background: linear-gradient(
          to bottom,
          transparent,
          var(--ns-tree-line) 12px,
          var(--ns-tree-line) calc(100% - 8px),
          transparent
        );
      }

      .ns-auto-nested-children[data-collapsed="true"] {
        display: none;
      }

      .ns-auto-nested-children > .content-item {
        position: relative;
        width: auto !important;
        margin: 0 !important;
        padding: 7px 0 7px 0 !important;
        border: 0;
        border-radius: 0;
        background: transparent;
        box-sizing: border-box;
      }

      .ns-auto-nested-children > .content-item::before {
        content: "";
        position: absolute;
        left: -18px;
        top: 21px;
        width: 18px;
        height: 14px;
        border-left: 2px solid var(--ns-tree-line);
        border-bottom: 2px solid var(--ns-tree-line-strong);
        border-bottom-left-radius: 12px;
        background: transparent;
      }

      .ns-auto-nested-children > .content-item::after {
        content: "";
        position: absolute;
        left: -3px;
        top: 33px;
        width: 5px;
        height: 5px;
        border-radius: 999px;
        background: var(--ns-tree-line-strong);
        box-shadow: 0 0 0 3px var(--ns-tree-surface);
      }

      .ns-auto-nested-children > .content-item > .nsk-content-meta-info {
        display: flex !important;
        min-height: 34px;
        align-items: center;
        gap: 10px;
        margin: 0 0 4px !important;
        color: rgba(75, 88, 108, .66);
      }

      .ns-auto-nested-children > .content-item > .nsk-content-meta-info .avatar-wrapper {
        display: block !important;
        width: 34px !important;
        min-width: 34px !important;
        margin-right: 0 !important;
      }

      .ns-auto-nested-children > .content-item .avatar-normal {
        width: 32px !important;
        height: 32px !important;
        border-radius: 50% !important;
      }

      .ns-auto-nested-children > .content-item .post-content {
        margin: 0 0 0 38px !important;
        padding: 0 !important;
        color: rgba(36, 42, 52, .92);
        font-size: 15px;
        line-height: 1.75;
        overflow-wrap: anywhere;
      }

      .ns-auto-nested-children > .content-item .post-content p {
        margin: 0 0 5px;
      }

      .ns-auto-nested-children > .content-item .post-content p:last-child {
        margin-bottom: 0;
      }

      .ns-auto-nested-children > .content-item .author-name {
        color: rgba(36, 42, 52, .80);
        font-size: 15px;
        font-weight: 700;
      }

      .ns-auto-nested-children > .content-item .ns-auto-user-profile-badge {
        margin-left: 6px;
        padding: 1px 6px;
        border-color: var(--ns-rank-border);
        background: var(--ns-rank-bg);
        color: var(--ns-rank-text);
        box-shadow: var(--ns-rank-shadow);
        font-size: 11px;
        font-weight: 650;
        line-height: 1.45;
        opacity: 1;
      }

      .ns-auto-nested-children > .content-item [class*="medal"],
      .ns-auto-nested-children > .content-item [class*="honor"],
      .ns-auto-nested-children > .content-item [class*="decoration"] {
        display: none !important;
      }

      .ns-auto-nested-children > .content-item .content-info,
      .ns-auto-nested-children > .content-item .floor-link {
        color: rgba(75, 88, 108, .42);
        font-size: 13px;
        opacity: 1;
      }

      .ns-auto-nested-children > .content-item .floor-link-wrapper {
        margin-left: auto;
      }

      .ns-auto-nested-children > .content-item .comment-menu {
        display: flex !important;
        justify-content: flex-start !important;
        margin: 6px 0 0 38px !important;
        opacity: .44;
        transform: none;
        transform-origin: left center;
      }

      .ns-auto-nested-children > .content-item:hover .comment-menu,
      .ns-auto-nested-children > .content-item:focus-within .comment-menu {
        opacity: .72;
      }

      .ns-auto-nested-children > .content-item .comment-menu .menu-item {
        margin-right: 14px !important;
      }

      .ns-auto-parent-reference,
      .ns-auto-parent-reference-line,
      .ns-auto-inline-signature {
        display: none !important;
      }

      .ns-auto-nested-children > .content-item .post-content img:not(.emoji) {
        max-width: min(220px, 100%) !important;
        max-height: 180px !important;
        object-fit: contain;
      }

      .ns-auto-nested-children > .content-item .post-content .emoji {
        width: 1.2em !important;
        height: 1.2em !important;
        vertical-align: -.18em;
      }

      .ns-auto-nested-children > .content-item[data-ns-signature-available="true"] {
        cursor: pointer;
      }

      .ns-auto-nested-signature {
        display: none;
        margin: 6px 0 0 38px;
        padding: 7px 10px;
        border-left: 3px solid rgba(112, 125, 143, .16);
        border-radius: 0 4px 4px 0;
        background: rgba(112, 125, 143, .045);
        color: rgba(75, 88, 108, .76);
        font-size: 12px;
        line-height: 1.65;
        white-space: pre-wrap;
      }

      .ns-auto-nested-children > .content-item[data-signature-open="true"] > .ns-auto-nested-signature {
        display: block;
      }

      .ns-auto-nested-children .ns-auto-nested-toggle {
        margin: 5px 0 0 38px;
        opacity: .72;
      }

      .ns-auto-nested-children .ns-auto-nested-children {
        margin: 5px 0 0 12px;
        padding-left: 14px;
        border-left: 0;
      }

      .ns-auto-nested-children .ns-auto-nested-children > .content-item {
        padding-top: 6px !important;
        padding-bottom: 6px !important;
      }

      .ns-auto-nested-children .ns-auto-nested-children > .content-item::before {
        left: -14px;
        width: 14px;
      }

      .ns-auto-nested-children .ns-auto-nested-children > .content-item::after {
        left: -3px;
      }

      .ns-auto-nested-children .ns-auto-nested-children .ns-auto-nested-children {
        margin-left: 10px;
        padding-left: 12px;
      }

      .ns-auto-nested-parent > .floor-link-wrapper .floor-link::after {
        content: " · 有楼中楼";
        opacity: .68;
        font-weight: normal;
      }

      .dark-layout .ns-auto-nested-toggle {
        color: rgba(218, 226, 237, .86);
      }

      .dark-layout .ns-auto-nested-toggle::before {
        border-color: rgba(185, 198, 216, .22);
        color: rgba(218, 226, 237, .52);
      }

      .dark-layout .ns-auto-nested-children {
        --ns-tree-line: rgba(185, 198, 216, .18);
        --ns-tree-line-strong: rgba(185, 198, 216, .30);
        --ns-tree-surface: #161c24;
        border-left-color: transparent;
      }

      .dark-layout .ns-auto-nested-children > .content-item {
        border-color: rgba(185, 198, 216, .12);
        background: transparent;
      }

      .dark-layout .ns-auto-nested-children > .content-item::before {
        border-left-color: var(--ns-tree-line);
        border-bottom-color: var(--ns-tree-line-strong);
        background: transparent;
      }

      .dark-layout .ns-auto-nested-children > .content-item::after {
        background: var(--ns-tree-line-strong);
        box-shadow: 0 0 0 3px var(--ns-tree-surface);
      }

      .dark-layout .ns-auto-nested-children > .content-item > .nsk-content-meta-info {
        color: rgba(218, 226, 237, .62);
      }

      .dark-layout .ns-auto-nested-children > .content-item .post-content {
        color: rgba(234, 240, 248, .88);
      }

      .dark-layout .ns-auto-nested-children > .content-item .author-name {
        color: rgba(234, 240, 248, .76);
      }

      .dark-layout .ns-auto-nested-children > .content-item .ns-auto-user-profile-badge {
        border-color: var(--ns-rank-border);
        background: var(--ns-rank-bg);
        color: var(--ns-rank-text);
        box-shadow: var(--ns-rank-shadow);
      }

      .dark-layout .ns-auto-nested-children > .content-item .content-info,
      .dark-layout .ns-auto-nested-children > .content-item .floor-link {
        color: rgba(218, 226, 237, .42);
      }

      .dark-layout .ns-auto-nested-signature {
        border-left-color: rgba(185, 198, 216, .18);
        background: rgba(185, 198, 216, .06);
        color: rgba(218, 226, 237, .70);
      }

      .dark-layout .ns-auto-user-profile-badge {
        filter: saturate(.95) brightness(1.12);
      }

      .dark-layout .ns-auto-page-status {
        color: rgba(218, 226, 237, .70);
      }

      .dark-layout .ns-auto-page-status__button {
        border-color: rgba(185, 198, 216, .22);
        background: rgba(185, 198, 216, .08);
        color: rgba(218, 226, 237, .86);
      }

      .dark-layout .ns-auto-page-divider {
        color: rgba(218, 226, 237, .52);
      }

      .dark-layout .ns-auto-page-divider::before,
      .dark-layout .ns-auto-page-divider::after {
        background: rgba(185, 198, 216, .16);
      }

      .dark-layout .ns-auto-checkin-toast {
        border-color: rgba(20, 148, 105, .34);
        background: rgba(22, 28, 36, .96);
        color: #6ee7b7;
        box-shadow: 0 8px 24px rgba(0, 0, 0, .30);
      }

      .dark-layout .ns-auto-checkin-toast::before {
        background: rgba(20, 148, 105, .16);
        color: #6ee7b7;
      }

      .dark-layout .ns-auto-checkin-toast[data-tone="already"] {
        border-color: rgba(96, 165, 250, .28);
        color: #93c5fd;
      }

      .dark-layout .ns-auto-checkin-toast[data-tone="already"]::before {
        background: rgba(96, 165, 250, .16);
        color: #93c5fd;
      }

      @media (max-width: 720px) {
        .ns-auto-nested-toggle,
        .ns-auto-nested-children {
          margin-left: 8px;
        }

        .ns-auto-nested-children {
          padding-left: 12px;
        }

        .ns-auto-nested-children > .content-item::before {
          left: -12px;
          width: 12px;
          border-left-width: 2px;
          border-bottom-width: 2px;
        }

        .ns-auto-nested-children > .content-item::after {
          left: -3px;
          width: 5px;
          height: 5px;
        }

        .ns-auto-nested-children > .content-item .post-content,
        .ns-auto-nested-children > .content-item .comment-menu,
        .ns-auto-nested-signature,
        .ns-auto-nested-children .ns-auto-nested-toggle,
        .ns-auto-nested-children .ns-auto-nested-children {
          margin-left: 36px;
        }

        .ns-auto-nested-children .ns-auto-nested-children {
          margin-left: 7px;
          padding-left: 10px;
        }

        .ns-auto-nested-children .ns-auto-nested-children .ns-auto-nested-children {
          margin-left: 6px;
          padding-left: 9px;
        }
      }
    `;
    const root = document.head || document.body || document.documentElement;
    if (!root) {
      window.setTimeout(installStyles, 50);
      return;
    }

    root.append(style);
  }

  function patchHistory(methodName) {
    const original = history[methodName];
    history[methodName] = function patchedHistoryMethod() {
      const result = original.apply(this, arguments);
      scheduleApply(250);
      scheduleProfiles(300);
      scheduleCheckin(1000);
      return result;
    };
  }

  function observeBestTarget() {
    const target =
      document.querySelector(".comment-container") ||
      document.querySelector(".nsk-post-wrapper") ||
      document.body ||
      document.documentElement;

    if (!target || observedTarget === target) {
      return;
    }

    if (observer) {
      observer.disconnect();
    }

    observedTarget = target;
    observer = new MutationObserver(() => {
      scheduleApply();
      scheduleProfiles();
    });
    observer.observe(target, { childList: true, subtree: true });
  }

  function warmup() {
    CONFIG.warmupDelaysMs.forEach((delay) => {
      window.setTimeout(() => {
        observeBestTarget();
        applyNesting();
        applyUserProfiles();
      }, delay);
    });
  }

  function start() {
    if (started) {
      return;
    }

    if (!document.documentElement) {
      window.setTimeout(start, 50);
      return;
    }

    started = true;
    installStyles();
    patchHistory("pushState");
    patchHistory("replaceState");

    window.addEventListener("popstate", () => scheduleApply(250));
    window.addEventListener("pageshow", () => {
      scheduleApply(250);
      scheduleProfiles(250);
      scheduleCheckin(1000);
      window.setTimeout(maybeLoadNextPage, 500);
    });
    window.addEventListener("scroll", maybeLoadNextPage, { passive: true });
    window.addEventListener("resize", maybeLoadNextPage, { passive: true });

    observeBestTarget();
    warmup();
    scheduleApply(250);
    scheduleProfiles(300);
    scheduleCheckin();
    window.setTimeout(maybeLoadNextPage, 800);
  }

  start();
})();
