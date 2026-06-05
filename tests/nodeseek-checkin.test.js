const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const scriptPath = path.join(__dirname, "..", "scripts", "nodeseek-auto-nested-replies.user.js");
const script = fs.readFileSync(scriptPath, "utf8");

class FakeClassList {
  constructor() {
    this.items = new Set();
  }

  add(name) {
    this.items.add(name);
  }

  remove(name) {
    this.items.delete(name);
  }

  toggle(name, force) {
    if (force) {
      this.add(name);
    } else {
      this.remove(name);
    }
  }

  contains(name) {
    return this.items.has(name);
  }
}

class FakeElement {
  constructor(tagName = "div", owner = null) {
    this.tagName = tagName.toUpperCase();
    this.owner = owner;
    this.children = [];
    this.className = "";
    this.dataset = {};
    this.hidden = false;
    this.id = "";
    this.parentElement = null;
    this.textContent = "";
    this.classList = new FakeClassList();
  }

  append(...children) {
    children.forEach((child) => {
      child.parentElement = this;
      this.children.push(child);
      this.owner?.elements.push(child);
    });
  }

  appendChild(child) {
    this.append(child);
    return child;
  }

  addEventListener() {}

  closest() {
    return null;
  }

  getBoundingClientRect() {
    return { bottom: 0, height: 0, top: 0, width: 0 };
  }

  matches() {
    return false;
  }

  querySelector() {
    return null;
  }

  querySelectorAll() {
    return [];
  }

  remove() {
    if (!this.parentElement) {
      return;
    }

    this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
    this.parentElement = null;
  }

  setAttribute(name, value) {
    this[name] = String(value);
  }
}

function createStorage(seed = {}) {
  const data = { ...seed };
  return {
    getItem(key) {
      return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null;
    },
    setItem(key, value) {
      data[key] = String(value);
    },
    snapshot() {
      return { ...data };
    },
  };
}

async function createHarness({ storageSeed = {}, responseText = '{"code":0,"message":"签到成功，获得鸡腿"}' } = {}) {
  const storage = createStorage(storageSeed);
  const timers = [];
  let fetchCount = 0;

  const document = {
    body: null,
    elements: [],
    head: null,
    hidden: false,
    documentElement: null,
    addEventListener() {},
    createElement(tagName) {
      return new FakeElement(tagName, document);
    },
    getElementById(id) {
      return document.elements.find((element) => element.id === id) || null;
    },
    querySelector(selector) {
      if (selector === ".ns-auto-checkin-toast") {
        return document.elements.find((element) => element.className === "ns-auto-checkin-toast") || null;
      }
      return null;
    },
    querySelectorAll() {
      return [];
    },
  };
  document.documentElement = new FakeElement("html", document);
  document.head = new FakeElement("head", document);
  document.body = new FakeElement("body", document);
  document.elements.push(document.documentElement, document.head, document.body);

  const window = {
    addEventListener() {},
    clearTimeout(id) {
      const timer = timers.find((item) => item.id === id);
      if (timer) {
        timer.cancelled = true;
      }
    },
    innerHeight: 900,
    scrollY: 0,
    setTimeout(callback, delay = 0) {
      const id = timers.length + 1;
      timers.push({ callback, cancelled: false, delay, id });
      return id;
    },
  };

  const context = {
    Array,
    Boolean,
    DOMParser: class {},
    Date,
    Element: FakeElement,
    Error,
    HTMLButtonElement: FakeElement,
    JSON,
    Map,
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    Node: { ELEMENT_NODE: 1, TEXT_NODE: 3 },
    Number,
    Promise,
    RegExp,
    Set,
    String,
    URL,
    WeakSet,
    console,
    document,
    fetch: async () => {
      fetchCount += 1;
      return {
        ok: true,
        status: 200,
        text: async () => responseText,
      };
    },
    history: {
      pushState() {},
      replaceState() {},
    },
    localStorage: storage,
    location: new URL("https://www.nodeseek.com/"),
    window,
  };

  vm.createContext(context);
  vm.runInContext(script, context, { filename: scriptPath });

  async function flushTimers(maxDelay) {
    let ran = true;
    while (ran) {
      ran = false;
      for (const timer of timers) {
        if (!timer.cancelled && !timer.ran && timer.delay <= maxDelay) {
          timer.ran = true;
          ran = true;
          await timer.callback();
          await Promise.resolve();
        }
      }
    }
  }

  return {
    document,
    fetchCount: () => fetchCount,
    flushTimers,
    storage,
  };
}

(async () => {
  const first = await createHarness();
  await first.flushTimers(3000);
  assert.equal(first.fetchCount(), 1);

  const state = JSON.parse(first.storage.getItem("ns-auto-checkin-state-v1"));
  assert.equal(state.status, "success");
  assert.equal(state.notifiedStatus, "success");
  assert.equal(Boolean(state.date), true);

  const toast = first.document.querySelector(".ns-auto-checkin-toast");
  assert.equal(Boolean(toast), true);
  assert.match(toast.textContent, /NodeSeek 签到成功/);

  const second = await createHarness({ storageSeed: first.storage.snapshot() });
  await second.flushTimers(3000);
  assert.equal(second.fetchCount(), 0);

  console.log("nodeseek check-in tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
