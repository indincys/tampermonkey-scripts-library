const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const scriptPath = path.join(__dirname, "..", "scripts", "linuxdo-auto-expand-nested.user.js");
const script = fs.readFileSync(scriptPath, "utf8");

class FakeElement {
  constructor({ href = "", target = "", protectedContext = false } = {}) {
    this.href = href;
    this.target = target;
    this.protectedContext = protectedContext;
  }

  closest(selector) {
    if (selector === "a[href]") {
      return this.href ? this : null;
    }

    if (this.protectedContext && selector.includes("notification")) {
      return this;
    }

    return null;
  }

  getAttribute(name) {
    return name === "href" ? this.href : null;
  }

  querySelectorAll() {
    return [];
  }
}

class FakeButton extends FakeElement {}

function createHarness(initialUrl = "https://linux.do/") {
  let currentHref = initialUrl;
  const handlers = new Map();
  const timers = [];
  const openedUrls = [];
  const replaceCalls = [];

  const location = {
    get href() {
      return currentHref;
    },
    set href(value) {
      currentHref = new URL(value, currentHref).href;
    },
    get pathname() {
      return new URL(currentHref).pathname;
    },
    replace(value) {
      replaceCalls.push(value);
      currentHref = new URL(value, currentHref).href;
    },
  };

  const addHandler = (targetHandlers, type, handler) => {
    if (!targetHandlers.has(type)) {
      targetHandlers.set(type, []);
    }
    targetHandlers.get(type).push(handler);
  };

  const document = {
    documentElement: new FakeElement(),
    hidden: false,
    addEventListener(type, handler) {
      addHandler(handlers, type, handler);
    },
    querySelectorAll() {
      return [];
    },
  };

  const windowHandlers = new Map();
  const window = {
    innerHeight: 900,
    addEventListener(type, handler) {
      addHandler(windowHandlers, type, handler);
    },
    clearTimeout() {},
    setTimeout(handler) {
      timers.push(handler);
      return timers.length;
    },
    open(url) {
      openedUrls.push(url);
    },
  };

  const history = {
    pushState(_state, _title, url) {
      if (url) {
        location.href = url;
      }
    },
    replaceState(_state, _title, url) {
      if (url) {
        location.href = url;
      }
    },
  };

  class MutationObserver {
    constructor(callback) {
      this.callback = callback;
    }

    observe() {}
  }

  const context = {
    Array,
    Boolean,
    HTMLButtonElement: FakeButton,
    Element: FakeElement,
    MutationObserver,
    URL,
    WeakSet,
    document,
    history,
    location,
    window,
  };

  vm.createContext(context);
  vm.runInContext(script, context, { filename: scriptPath });

  return {
    click(link, overrides = {}) {
      const event = {
        button: 0,
        ctrlKey: false,
        defaultPrevented: false,
        metaKey: false,
        target: link,
        type: "click",
        preventDefault() {
          this.defaultPrevented = true;
        },
        stopPropagation() {
          this.stopped = true;
        },
        ...overrides,
      };

      for (const handler of handlers.get("click") || []) {
        handler(event);
      }

      return event;
    },
    flushTimers() {
      while (timers.length > 0) {
        timers.shift()();
      }
    },
    history,
    location,
    openedUrls,
    replaceCalls,
  };
}

{
  const app = createHarness("https://linux.do/t/topic/2045356");
  assert.equal(app.location.href, "https://linux.do/t/topic/2045356");
  assert.deepEqual(app.replaceCalls, []);
}

{
  const app = createHarness();
  const link = new FakeElement({ href: "https://linux.do/t/topic/2045356" });
  const event = app.click(link);
  assert.equal(event.defaultPrevented, true);
  assert.equal(app.location.href, "https://linux.do/n/topic/2045356");
}

{
  const app = createHarness();
  const link = new FakeElement({
    href: "https://linux.do/t/topic/2045356",
    protectedContext: true,
  });
  const event = app.click(link);
  assert.equal(event.defaultPrevented, false);
  assert.equal(app.location.href, "https://linux.do/");
}

{
  const app = createHarness();
  const link = new FakeElement({ href: "https://linux.do/t/topic/2045356?post_number=2" });
  const event = app.click(link);
  assert.equal(event.defaultPrevented, false);
  assert.equal(app.location.href, "https://linux.do/");
}

{
  const app = createHarness();
  app.history.pushState({}, "", "/t/topic/2045356");
  app.flushTimers();
  assert.equal(app.location.href, "https://linux.do/t/topic/2045356");
}

console.log("linuxdo routing tests passed");
