// background.js

const DEBUGGER_PROTOCOL_VERSION = "1.3";
const attachedTabs = new Set();
const pageEnabledTabs = new Set();

// per-tab network tracking state
const netStates = new Map(); // tabId -> { enabled, pending:Set, lastActivity:number }
const foregroundMaskStates = new Map(); // tabId -> { enabled, config, scriptId, appliedAt }

function normalizeArea(area) {
  return area === "sync" ? "sync" : "local";
}

function getStorageArea(area) {
  return normalizeArea(area) === "sync" ? chrome.storage.sync : chrome.storage.local;
}

function storageGetString(key, area) {
  const store = getStorageArea(area);
  return new Promise((resolve, reject) => {
    store.get(key, (items) => {
      const err = chrome.runtime?.lastError;
      if (err) {
        reject(new Error(err.message || String(err)));
        return;
      }

      const v = items && Object.prototype.hasOwnProperty.call(items, key) ? items[key] : undefined;
      resolve(typeof v === "string" ? v : undefined);
    });
  });
}

function storageSetString(key, value, area) {
  if (typeof value !== "string") throw new Error("kvSet only accepts string value");
  const store = getStorageArea(area);
  return new Promise((resolve, reject) => {
    store.set({ [key]: value }, () => {
      const err = chrome.runtime?.lastError;
      if (err) reject(new Error(err.message || String(err)));
      else resolve(true);
    });
  });
}

function storageDel(key, area) {
  const store = getStorageArea(area);
  return new Promise((resolve, reject) => {
    store.remove(key, () => {
      const err = chrome.runtime?.lastError;
      if (err) reject(new Error(err.message || String(err)));
      else resolve(true);
    });
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function getTabId(sender) {
  if (sender?.tab?.id != null) return sender.tab.id;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("No active tab found to run the action.");
  return tab.id;
}

async function getSenderActiveTab(sender, inactiveMessage = "Sender tab is not the active tab in its window.") {
  const senderTab = sender?.tab;
  if (!senderTab || !Number.isInteger(senderTab.id)) {
    throw new Error("captureVisibleTab requires a sender.tab request from a tab.");
  }

  if (!Number.isInteger(senderTab.windowId)) {
    throw new Error("captureVisibleTab requires sender.tab.windowId.");
  }

  let currentTab;
  try {
    currentTab = await chrome.tabs.get(senderTab.id);
  } catch (error) {
    throw new Error(`Sender tab not found: ${error?.message || error}`);
  }

  if (!currentTab || currentTab.id !== senderTab.id) {
    throw new Error("Sender tab not found.");
  }

  if (currentTab.windowId !== senderTab.windowId) {
    throw new Error("Sender tab window mismatch.");
  }

  if (currentTab.active !== true) {
    throw new Error(inactiveMessage);
  }

  const activeTabs = await chrome.tabs.query({ active: true, windowId: senderTab.windowId });
  const activeTab = activeTabs?.[0];
  if (!activeTab || activeTab.id !== senderTab.id) {
    throw new Error(inactiveMessage);
  }

  return currentTab;
}

function normalizeCaptureOptions(msg) {
  const format = msg?.format == null ? "png" : String(msg.format).toLowerCase();
  if (format !== "png" && format !== "jpeg") {
    throw new Error("Invalid capture format. Expected png or jpeg.");
  }

  const options = { format };
  if (msg && Object.prototype.hasOwnProperty.call(msg, "quality")) {
    if (format !== "jpeg") {
      throw new Error("capture quality is only supported for jpeg format.");
    }

    if (!Number.isInteger(msg.quality) || msg.quality < 1 || msg.quality > 100) {
      throw new Error("Invalid capture quality. Expected integer 1-100.");
    }

    options.quality = msg.quality;
  }

  return options;
}

function captureVisibleTab(windowId, options) {
  return new Promise((resolve, reject) => {
    chrome.tabs.captureVisibleTab(windowId, options, (dataUrl) => {
      const err = chrome.runtime?.lastError;
      if (err) {
        reject(new Error(err.message || String(err)));
        return;
      }

      if (typeof dataUrl !== "string" || !dataUrl) {
        reject(new Error("captureVisibleTab failed: empty dataUrl returned."));
        return;
      }

      resolve(dataUrl);
    });
  });
}

async function handleCaptureVisibleTab(msg, sender) {
  if (msg && (Object.prototype.hasOwnProperty.call(msg, "tabId") || Object.prototype.hasOwnProperty.call(msg, "windowId"))) {
    throw new Error("captureVisibleTab does not accept msg.tabId or msg.windowId; request must come from sender.tab.");
  }

  const tab = await getSenderActiveTab(sender);
  const options = normalizeCaptureOptions(msg);
  const dataUrl = await captureVisibleTab(tab.windowId, options);
  await getSenderActiveTab(
    sender,
    "captureVisibleTab discarded: sender tab is no longer the active tab in its window after capture."
  );
  return { tabId: tab.id, windowId: tab.windowId, format: options.format, dataUrl };
}

function attachTarget(tabId) {
  return { tabId };
}

function getNetState(tabId) {
  let st = netStates.get(tabId);
  if (!st) {
    st = { enabled: false, pending: new Set(), lastActivity: Date.now() };
    netStates.set(tabId, st);
  }
  return st;
}

async function ensureDebuggerAttached(tabId) {
  if (attachedTabs.has(tabId)) return;

  await chrome.debugger.attach(attachTarget(tabId), DEBUGGER_PROTOCOL_VERSION);
  attachedTabs.add(tabId);

  try {
    await chrome.debugger.sendCommand(attachTarget(tabId), "Runtime.enable");
  } catch (e) {
    // ignore
  }
}

async function ensurePageEnabled(tabId) {
  if (pageEnabledTabs.has(tabId)) return;

  await chrome.debugger.sendCommand(attachTarget(tabId), "Page.enable");
  pageEnabledTabs.add(tabId);
}

async function ensureNetworkEnabled(tabId) {
  const st = getNetState(tabId);
  if (st.enabled) return;

  await chrome.debugger.sendCommand(attachTarget(tabId), "Network.enable", {});
  st.enabled = true;
  st.lastActivity = Date.now();
}

chrome.debugger.onDetach.addListener((source, reason) => {
  if (source?.tabId != null) {
    attachedTabs.delete(source.tabId);
    pageEnabledTabs.delete(source.tabId);
    netStates.delete(source.tabId);
    foregroundMaskStates.delete(source.tabId);
  }
});

// Track network activity
chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source?.tabId;
  if (tabId == null) return;

  const st = netStates.get(tabId);
  if (!st?.enabled) return;

  const now = Date.now();

  if (method === "Network.requestWillBeSent") {
    if (params?.requestId) st.pending.add(params.requestId);
    st.lastActivity = now;
    return;
  }

  if (method === "Network.loadingFinished" || method === "Network.loadingFailed") {
    if (params?.requestId) st.pending.delete(params.requestId);
    st.lastActivity = now;
    return;
  }

  // 其他事件也算“有网络活动”（让 idle 判定更稳）
  if (method.startsWith("Network.")) {
    st.lastActivity = now;
  }
});

function buildFindAndActExpression({ action, selector, selectorText, value, afterFoundMs }) {
  const payload = {
    action,
    selector: Array.isArray(selector) ? selector : selector || "",
    selectorText: Array.isArray(selectorText) ? selectorText : selectorText || "",
    value: value ?? "",
    afterFoundMs: Number.isFinite(afterFoundMs) ? Math.max(0, afterFoundMs) : 0,
  };
  const injected = JSON.stringify(payload);

  return `
(async () => {
  const { action, selector, selectorText, value, afterFoundMs } = ${injected};
  const selectors = (Array.isArray(selector) ? selector : [selector])
    .map((item) => String(item || "").trim())
    .filter(Boolean);
  const selectorTexts = (Array.isArray(selectorText) ? selectorText : [selectorText])
    .map((item) => String(item || "").trim())
    .filter(Boolean);

  const getText = (el) => {
    const parts = [
      el?.innerText,
      el?.textContent,
      el?.value,
      el?.getAttribute?.("aria-label"),
      el?.getAttribute?.("title"),
      el?.getAttribute?.("placeholder"),
    ].filter(Boolean).map(String);

    return parts.join(" ").trim();
  };

  const pick = () => {
    const all = selectors.flatMap((item) => Array.from(document.querySelectorAll(item)));
    if (!all.length) {
      return { ok: false, code: "NOT_FOUND", error: "No elements matched selector", selector, selectorText };
    }

    let el = all[0];
    if (selectorTexts.length) {
      const target = all.find((node) => {
        const text = getText(node);
        return selectorTexts.some((item) => text.includes(item));
      });
      if (!target) {
        return { ok: false, code: "NOT_FOUND_TEXT", error: "No elements matched selectorText within selector results", selector, selectorText, candidates: all.length };
      }
      el = target;
    }

    return { ok: true, el };
  };

  const first = pick();
  if (!first.ok) return first;

  if (afterFoundMs && afterFoundMs > 0) {
    await new Promise((r) => setTimeout(r, afterFoundMs));
  }

  const picked = afterFoundMs && afterFoundMs > 0 ? pick() : first;
  if (!picked.ok) return picked;

  const el = picked.el;

  try { el.scrollIntoView({ block: "center", inline: "center" }); } catch (e) {}

  if (action === "click") {
    try { el.focus?.(); } catch (e) {}
    el.click();
    return { ok: true };
  }

  if (action === "focus") {
    const isEditable =
      el instanceof HTMLInputElement ||
      el instanceof HTMLSelectElement ||
      el instanceof HTMLTextAreaElement ||
      el.isContentEditable;

    if (!isEditable) {
      return { ok: false, error: "Target is not editable/selectable (input/select/textarea/contenteditable)", selector, selectorText };
    }

    try { el.focus?.(); } catch (e) {}
    try { el.click?.(); } catch (e) {}
    return { ok: true };
  }

  if (action === "input") {
    const isEditable =
      el instanceof HTMLInputElement ||
      el instanceof HTMLSelectElement ||
      el instanceof HTMLTextAreaElement ||
      el.isContentEditable;

    if (!isEditable) {
      return { ok: false, error: "Target is not editable/selectable (input/select/textarea/contenteditable)", selector, selectorText };
    }

    try { el.focus?.(); } catch (e) {}

    if (el instanceof HTMLSelectElement) {
      const options = Array.from(el.options);
      const optionText = (option) => String(option.label || option.textContent || "").trim();
      const findOption = (item) => {
        const target = String(item);
        return options.find((option) => option.value === target) ||
          options.find((option) => optionText(option) === target) ||
          null;
      };

      if (el.multiple) {
        const targets = Array.isArray(value) ? value : [value];
        const matches = targets.map((item) => ({ item, option: findOption(item) }));
        const missing = matches.filter((match) => !match.option).map((match) => String(match.item));

        if (missing.length) {
          return { ok: false, error: "Select option not found", selector, selectorText, missing };
        }

        const selected = new Set(matches.map((match) => match.option));
        options.forEach((option) => { option.selected = selected.has(option); });
      } else {
        const target = String(value);
        const option = findOption(value);

        if (!option) {
          return { ok: false, error: "Select option not found", selector, selectorText, value: target };
        }

        el.value = option.value;
      }
    } else if (el.isContentEditable) {
      el.textContent = value;
    } else {
      el.value = value;
    }

    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));

    return { ok: true };
  }

  return { ok: false, error: "Unknown action", action };
})()
  `.trim();
}

function buildGetElementCoordinatesExpression({ selector, selectorText, afterFoundMs }) {
  const payload = {
    selector: Array.isArray(selector) ? selector : selector || "",
    selectorText: Array.isArray(selectorText) ? selectorText : selectorText || "",
    afterFoundMs: Number.isFinite(afterFoundMs) ? Math.max(0, afterFoundMs) : 0,
  };
  const injected = JSON.stringify(payload);

  return `
(async () => {
  const { selector, selectorText, afterFoundMs } = ${injected};
  const selectors = (Array.isArray(selector) ? selector : [selector])
    .map((item) => String(item || "").trim())
    .filter(Boolean);
  const selectorTexts = (Array.isArray(selectorText) ? selectorText : [selectorText])
    .map((item) => String(item || "").trim())
    .filter(Boolean);

  const getText = (el) => {
    const parts = [
      el?.innerText,
      el?.textContent,
      el?.value,
      el?.getAttribute?.("aria-label"),
      el?.getAttribute?.("title"),
      el?.getAttribute?.("placeholder"),
    ].filter(Boolean).map(String);

    return parts.join(" ").trim();
  };

  const pick = () => {
    const all = selectors.flatMap((item) => Array.from(document.querySelectorAll(item)));
    if (!all.length) {
      return { ok: false, code: "NOT_FOUND", error: "No elements matched selector", selector, selectorText };
    }

    let el = all[0];
    if (selectorTexts.length) {
      const target = all.find((node) => {
        const text = getText(node);
        return selectorTexts.some((item) => text.includes(item));
      });
      if (!target) {
        return { ok: false, code: "NOT_FOUND_TEXT", error: "No elements matched selectorText within selector results", selector, selectorText, candidates: all.length };
      }
      el = target;
    }

    return { ok: true, el, candidates: all.length };
  };

  let picked = pick();
  if (!picked.ok) return picked;

  try { picked.el.scrollIntoView({ block: "center", inline: "center" }); } catch (e) {}

  if (afterFoundMs && afterFoundMs > 0) {
    await new Promise((r) => setTimeout(r, afterFoundMs));
  }

  picked = pick();
  if (!picked.ok) return picked;

  const el = picked.el;
  try { el.scrollIntoView({ block: "center", inline: "center" }); } catch (e) {}
  await new Promise((r) => requestAnimationFrame(() => r()));

  const rect = el.getBoundingClientRect();
  if (!Number.isFinite(rect.left) || !Number.isFinite(rect.top) || rect.width <= 0 || rect.height <= 0) {
    return { ok: false, error: "Target element has no clickable bounding box", selector, selectorText };
  }

  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const visibleLeft = Math.max(rect.left, 0);
  const visibleTop = Math.max(rect.top, 0);
  const visibleRight = Math.min(rect.right, viewportWidth);
  const visibleBottom = Math.min(rect.bottom, viewportHeight);

  if (visibleRight <= visibleLeft || visibleBottom <= visibleTop) {
    return { ok: false, error: "Target element is outside the viewport", selector, selectorText };
  }

  const x = visibleLeft + (visibleRight - visibleLeft) / 2;
  const y = visibleTop + (visibleBottom - visibleTop) / 2;
  const coordinates = { x, y };

  return {
    ok: true,
    action: "clickCoordinates",
    x,
    y,
    coordinates,
    rect: {
      x: rect.x,
      y: rect.y,
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      width: rect.width,
      height: rect.height,
    },
    viewport: {
      width: viewportWidth,
      height: viewportHeight,
      devicePixelRatio: window.devicePixelRatio,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
    },
    click: { action: "clickCoordinates", type: "clickCoordinates", x, y },
    candidates: picked.candidates,
  };
})()
  `.trim();
}

function normalizeForegroundMaskConfig(config) {
  return {
    maskVisibility: config?.maskVisibility !== false,
    maskFocus: config?.maskFocus !== false,
    maskEvents: config?.maskEvents !== false,
    maskRAF: config?.maskRAF !== false,
  };
}

function buildForegroundMaskExpression(config, mode = "install") {
  const payload = JSON.stringify({
    config: normalizeForegroundMaskConfig(config),
    mode,
  });

  return `
(() => {
  const payload = ${payload};
  const bridge = window.ApliNiBrowserDebuggingExtension;
  if (typeof bridge !== "function") {
    return { ok: false, error: "Bridge is not available in page context" };
  }

  const stateKey = Symbol.for("ApliNiBrowserDebuggingExtension.foregroundMaskState");
  const state = bridge[stateKey] || (bridge[stateKey] = {
    installed: false,
    config: null,
    originals: {},
    listeners: {
      document: new WeakMap(),
      window: new WeakMap(),
    },
    raf: {
      nextId: 1,
      timers: new Map(),
    },
  });

  const eventsToBlock = new Set(["visibilitychange", "blur"]);

  const saveOriginal = (name, value) => {
    if (!Object.prototype.hasOwnProperty.call(state.originals, name)) {
      state.originals[name] = value;
    }
  };

  const defineValue = (target, key, value) => {
    Object.defineProperty(target, key, {
      configurable: true,
      writable: true,
      value,
    });
  };

  const restoreValue = (target, key, original) => {
    if (original) {
      Object.defineProperty(target, key, original);
      return;
    }

    delete target[key];
  };

  const applyPropertyMasks = (nextConfig) => {
    if (nextConfig.maskVisibility) {
      const hiddenDescriptor = Object.getOwnPropertyDescriptor(Document.prototype, "hidden");
      const visibilityStateDescriptor = Object.getOwnPropertyDescriptor(Document.prototype, "visibilityState");
      saveOriginal("Document.hidden", hiddenDescriptor);
      saveOriginal("Document.visibilityState", visibilityStateDescriptor);

      if (hiddenDescriptor?.configurable) {
        Object.defineProperty(Document.prototype, "hidden", {
          configurable: true,
          enumerable: hiddenDescriptor.enumerable,
          get() {
            return false;
          },
        });
      }

      if (visibilityStateDescriptor?.configurable) {
        Object.defineProperty(Document.prototype, "visibilityState", {
          configurable: true,
          enumerable: visibilityStateDescriptor.enumerable,
          get() {
            return "visible";
          },
        });
      }
    }

    if (nextConfig.maskFocus) {
      saveOriginal("Document.hasFocus", Document.prototype.hasFocus);
      defineValue(Document.prototype, "hasFocus", function hasFocus() {
        return true;
      });
    }
  };

  const wrapListenerApi = (target, label) => {
    const addKey = label + ".addEventListener";
    const removeKey = label + ".removeEventListener";
    saveOriginal(addKey, target.addEventListener);
    saveOriginal(removeKey, target.removeEventListener);

    defineValue(target, "addEventListener", function addEventListener(type, listener, options) {
      if (!state.config?.maskEvents || !eventsToBlock.has(String(type))) {
        return state.originals[addKey].call(this, type, listener, options);
      }

      if (typeof listener !== "function") {
        return state.originals[addKey].call(this, type, listener, options);
      }

      const wrapped = function wrappedBlockedEvent(event) {
        if (type === "blur" || type === "visibilitychange") {
          return undefined;
        }
        return listener.call(this, event);
      };

      state.listeners[label].set(listener, wrapped);
      return state.originals[addKey].call(this, type, wrapped, options);
    });

    defineValue(target, "removeEventListener", function removeEventListener(type, listener, options) {
      const wrapped = state.listeners[label].get(listener);
      if (wrapped) {
        state.listeners[label].delete(listener);
        return state.originals[removeKey].call(this, type, wrapped, options);
      }

      return state.originals[removeKey].call(this, type, listener, options);
    });
  };

  const applyEventMasks = (nextConfig) => {
    if (!nextConfig.maskEvents) {
      return;
    }

    wrapListenerApi(document, "document");
    wrapListenerApi(window, "window");

    saveOriginal("document.onvisibilitychange", Object.getOwnPropertyDescriptor(document, "onvisibilitychange"));
    saveOriginal("window.onblur", Object.getOwnPropertyDescriptor(window, "onblur"));
    saveOriginal("window.onfocus", Object.getOwnPropertyDescriptor(window, "onfocus"));

    Object.defineProperty(document, "onvisibilitychange", {
      configurable: true,
      enumerable: true,
      get() {
        return null;
      },
      set() {
        return true;
      },
    });

    Object.defineProperty(window, "onblur", {
      configurable: true,
      enumerable: true,
      get() {
        return null;
      },
      set() {
        return true;
      },
    });

    Object.defineProperty(window, "onfocus", {
      configurable: true,
      enumerable: true,
      get() {
        return null;
      },
      set(handler) {
        if (typeof handler !== "function") {
          return true;
        }
        return state.originals["window.addEventListener"].call(window, "focus", handler);
      },
    });
  };

  const applyRafMask = (nextConfig) => {
    if (!nextConfig.maskRAF) {
      return;
    }

    saveOriginal("window.requestAnimationFrame", window.requestAnimationFrame);
    saveOriginal("window.cancelAnimationFrame", window.cancelAnimationFrame);

    defineValue(window, "requestAnimationFrame", function requestAnimationFrame(callback) {
      const id = state.raf.nextId++;
      const entry = {
        done: false,
        nativeId: null,
        fallbackTimer: null,
      };

      const finish = (ts) => {
        if (entry.done) {
          return;
        }
        entry.done = true;

        if (entry.fallbackTimer != null) {
          window.clearTimeout(entry.fallbackTimer);
        }

        const cancel = state.originals["window.cancelAnimationFrame"];
        if (entry.nativeId != null && typeof cancel === "function") {
          try {
            cancel.call(window, entry.nativeId);
          } catch (error) {
            // ignore native cancel failures
          }
        }

        state.raf.timers.delete(id);
        callback(ts);
      };

      const raf = state.originals["window.requestAnimationFrame"];
      if (typeof raf === "function") {
        try {
          entry.nativeId = raf.call(this, (ts) => {
            finish(ts);
          });
        } catch (error) {
          entry.nativeId = null;
        }
      }

      entry.fallbackTimer = window.setTimeout(() => {
        finish(performance.now());
      }, 16);

      state.raf.timers.set(id, entry);
      return id;
    });

    defineValue(window, "cancelAnimationFrame", function cancelAnimationFrame(id) {
      if (state.raf.timers.has(id)) {
        const entry = state.raf.timers.get(id);
        state.raf.timers.delete(id);
        entry.done = true;

        if (entry.fallbackTimer != null) {
          window.clearTimeout(entry.fallbackTimer);
        }

        const cancel = state.originals["window.cancelAnimationFrame"];
        if (entry.nativeId != null && typeof cancel === "function") {
          try {
            cancel.call(this, entry.nativeId);
          } catch (error) {
            // ignore native cancel failures
          }
        }
        return;
      }

      const cancel = state.originals["window.cancelAnimationFrame"];
      if (typeof cancel === "function") {
        cancel.call(this, id);
      }
    });
  };

  const restore = () => {
    restoreValue(Document.prototype, "hidden", state.originals["Document.hidden"]);
    restoreValue(Document.prototype, "visibilityState", state.originals["Document.visibilityState"]);

    if (state.originals["Document.hasFocus"]) {
      defineValue(Document.prototype, "hasFocus", state.originals["Document.hasFocus"]);
    }

    if (state.originals["document.addEventListener"]) {
      defineValue(document, "addEventListener", state.originals["document.addEventListener"]);
    }
    if (state.originals["document.removeEventListener"]) {
      defineValue(document, "removeEventListener", state.originals["document.removeEventListener"]);
    }
    if (state.originals["window.addEventListener"]) {
      defineValue(window, "addEventListener", state.originals["window.addEventListener"]);
    }
    if (state.originals["window.removeEventListener"]) {
      defineValue(window, "removeEventListener", state.originals["window.removeEventListener"]);
    }

    restoreValue(document, "onvisibilitychange", state.originals["document.onvisibilitychange"]);
    restoreValue(window, "onblur", state.originals["window.onblur"]);
    restoreValue(window, "onfocus", state.originals["window.onfocus"]);

    if (state.originals["window.requestAnimationFrame"]) {
      defineValue(window, "requestAnimationFrame", state.originals["window.requestAnimationFrame"]);
    }
    if (state.originals["window.cancelAnimationFrame"]) {
      defineValue(window, "cancelAnimationFrame", state.originals["window.cancelAnimationFrame"]);
    }

    for (const timer of state.raf.timers.values()) {
      if (timer?.fallbackTimer != null) {
        window.clearTimeout(timer.fallbackTimer);
      }

      const cancel = state.originals["window.cancelAnimationFrame"];
      if (timer?.nativeId != null && typeof cancel === "function") {
        try {
          cancel.call(window, timer.nativeId);
        } catch (error) {
          // ignore native cancel failures
        }
      }
    }
    state.raf.timers.clear();
    state.listeners.document = new WeakMap();
    state.listeners.window = new WeakMap();
    state.installed = false;
    state.config = null;
    bridge[stateKey] = state;
    return { ok: true, restored: true };
  };

  if (payload.mode === "uninstall") {
    return restore();
  }

  if (state.installed) {
    restore();
  }

  state.config = payload.config;
  applyPropertyMasks(payload.config);
  applyEventMasks(payload.config);
  applyRafMask(payload.config);
  state.installed = true;
  bridge[stateKey] = state;

  return {
    ok: true,
    installed: true,
    config: state.config,
  };
})()
  `.trim();
}

async function setFocusEmulation(tabId, enabled) {
  await chrome.debugger.sendCommand(attachTarget(tabId), "Emulation.setFocusEmulationEnabled", {
    enabled: Boolean(enabled),
  });
}

function getForegroundMaskState(tabId) {
  const state = foregroundMaskStates.get(tabId);
  return {
    enabled: Boolean(state?.enabled),
    config: state?.config || null,
    appliedAt: state?.appliedAt || null,
    scriptId: state?.scriptId || null,
  };
}

async function enableForegroundMask(tabId, rawConfig) {
  const config = normalizeForegroundMaskConfig(rawConfig);

  await ensureDebuggerAttached(tabId);
  await ensurePageEnabled(tabId);

  const previous = foregroundMaskStates.get(tabId);
  if (previous?.scriptId) {
    try {
      await chrome.debugger.sendCommand(attachTarget(tabId), "Page.removeScriptToEvaluateOnNewDocument", {
        identifier: previous.scriptId,
      });
    } catch (e) {
      // ignore cleanup errors
    }
  }

  const source = buildForegroundMaskExpression(config, "install");
  const addRes = await chrome.debugger.sendCommand(
    attachTarget(tabId),
    "Page.addScriptToEvaluateOnNewDocument",
    { source }
  );

  const pageResult = await runInPageViaDebugger(tabId, source);
  if (!pageResult?.ok) {
    throw new Error(pageResult?.error || "Failed to enable foreground mask");
  }

  if (config.maskFocus) {
    try {
      await setFocusEmulation(tabId, true);
    } catch (e) {
      // ignore focus emulation failures
    }
  }

  const nextState = {
    enabled: true,
    config,
    scriptId: addRes?.identifier || null,
    appliedAt: Date.now(),
  };
  foregroundMaskStates.set(tabId, nextState);
  return nextState;
}

async function disableForegroundMask(tabId) {
  const previous = foregroundMaskStates.get(tabId);
  if (!previous) {
    return {
      enabled: false,
      config: null,
      appliedAt: null,
      restoredCurrentDocument: false,
    };
  }

  if (previous.scriptId) {
    try {
      await chrome.debugger.sendCommand(attachTarget(tabId), "Page.removeScriptToEvaluateOnNewDocument", {
        identifier: previous.scriptId,
      });
    } catch (e) {
      // ignore cleanup errors
    }
  }

  let restoredCurrentDocument = false;
  try {
    await ensureDebuggerAttached(tabId);
    const result = await runInPageViaDebugger(tabId, buildForegroundMaskExpression(previous.config, "uninstall"));
    restoredCurrentDocument = Boolean(result?.ok);
  } catch (e) {
    restoredCurrentDocument = false;
  }

  if (previous.config?.maskFocus) {
    try {
      await setFocusEmulation(tabId, false);
    } catch (e) {
      // ignore focus emulation failures
    }
  }

  foregroundMaskStates.delete(tabId);
  return {
    enabled: false,
    config: null,
    appliedAt: null,
    restoredCurrentDocument,
  };
}

async function runInPageViaDebugger(tabId, expression) {
  const res = await chrome.debugger.sendCommand(
    attachTarget(tabId),
    "Runtime.evaluate",
    {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    }
  );

  if (res?.exceptionDetails) {
    const text = res.exceptionDetails?.exception?.description || "Runtime.evaluate exception";
    throw new Error(text);
  }

  return res?.result?.value;
}

async function runFindAndActWithRetry(tabId, expression, intervalMs = 200, timeoutMs = 30000) {
  const start = Date.now();
  let attempts = 0;

  while (true) {
    attempts += 1;

    const result = await runInPageViaDebugger(tabId, expression);
    if (result?.ok) return { ok: true, attempts, result };

    const code = result?.code;
    const retriable = code === "NOT_FOUND" || code === "NOT_FOUND_TEXT";
    if (!retriable) return { ok: false, attempts, result };

    const elapsed = Date.now() - start;
    const hasTimeout = timeoutMs >= 0;
    if (hasTimeout && elapsed >= timeoutMs) {
      const details = {
        tabId,
        attempts,
        timeoutMs,
        intervalMs,
        selector: result?.selector,
        selectorText: result?.selectorText,
      };

      console.log("Element not found within timeout", details);
      return { ok: false, timeout: true, attempts, result };
    }

    await sleep(intervalMs);
  }
}

function buildKeyEventForChar(ch) {
  if (ch === "\n" || ch === "\r") {
    return { kind: "enter", key: "Enter", code: "Enter", vk: 13 };
  }

  if (ch === "\t") {
    return { kind: "tab", key: "Tab", code: "Tab", vk: 9 };
  }

  if (ch === " ") {
    return { kind: "printable", key: " ", code: "Space", vk: 32, text: " " };
  }

  if (/[a-zA-Z]/.test(ch)) {
    const upper = ch === ch.toUpperCase();
    return {
      kind: "printable",
      key: ch,
      code: `Key${ch.toUpperCase()}`,
      vk: ch.toUpperCase().charCodeAt(0),
      modifiers: upper ? 8 : 0,
      text: ch,
    };
  }

  if (/[0-9]/.test(ch)) {
    return {
      kind: "printable",
      key: ch,
      code: `Digit${ch}`,
      vk: ch.charCodeAt(0),
      text: ch,
    };
  }

  return { kind: "char", text: ch };
}

async function dispatchKeyEvent(tabId, payload) {
  await chrome.debugger.sendCommand(attachTarget(tabId), "Input.dispatchKeyEvent", payload);
}

async function dispatchMouseEvent(tabId, payload) {
  await chrome.debugger.sendCommand(attachTarget(tabId), "Input.dispatchMouseEvent", payload);
}

async function insertTextViaDebugger(tabId, text) {
  await chrome.debugger.sendCommand(attachTarget(tabId), "Input.insertText", {
    text: String(text ?? ""),
  });
}

function normalizeClickCoordinates(msg) {
  const hasTopLevelX = Object.prototype.hasOwnProperty.call(msg || {}, "x");
  const hasTopLevelY = Object.prototype.hasOwnProperty.call(msg || {}, "y");
  const source = hasTopLevelX || hasTopLevelY ? msg : msg?.coordinates;
  const x = source?.x;
  const y = source?.y;

  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error("clickCoordinates requires finite numeric x/y or coordinates.x/coordinates.y.");
  }

  const button = msg?.button == null ? "left" : String(msg.button);
  if (button !== "left" && button !== "middle" && button !== "right") {
    throw new Error("clickCoordinates button must be one of: left, middle, right.");
  }

  const clickCount = msg?.clickCount == null ? 1 : msg.clickCount;
  if (!Number.isInteger(clickCount) || clickCount < 1) {
    throw new Error("clickCoordinates clickCount must be a positive integer.");
  }

  return { x, y, button, clickCount };
}

function getMouseButtonsMask(button) {
  if (button === "left") return 1;
  if (button === "right") return 2;
  if (button === "middle") return 4;
  return 0;
}

async function clickCoordinatesViaDebugger(tabId, options) {
  const { x, y, button, clickCount } = options;
  const buttons = getMouseButtonsMask(button);

  await dispatchMouseEvent(tabId, {
    type: "mouseMoved",
    x,
    y,
    button: "none",
  });

  for (let i = 1; i <= clickCount; i += 1) {
    await dispatchMouseEvent(tabId, {
      type: "mousePressed",
      x,
      y,
      button,
      buttons,
      clickCount: i,
    });
    await dispatchMouseEvent(tabId, {
      type: "mouseReleased",
      x,
      y,
      button,
      buttons: 0,
      clickCount: i,
    });
  }
}

async function typeTextViaDebugger(tabId, text, delayMs) {
  const hasDelay = Number.isFinite(delayMs) && delayMs > 0;
  const chars = Array.from(String(text || ""));

  for (const ch of chars) {
    const info = buildKeyEventForChar(ch);

    if (info.kind === "char") {
      await dispatchKeyEvent(tabId, {
        type: "char",
        text: info.text,
        unmodifiedText: info.text,
      });
    } else {
      const base = {
        key: info.key,
        code: info.code,
        windowsVirtualKeyCode: info.vk,
        nativeVirtualKeyCode: info.vk,
        modifiers: info.modifiers || 0,
      };

      if (info.kind === "printable") {
        await dispatchKeyEvent(tabId, {
          type: "keyDown",
          ...base,
          text: info.text,
          unmodifiedText: info.text,
        });
        await dispatchKeyEvent(tabId, {
          type: "keyUp",
          ...base,
        });
      } else if (info.kind === "enter" || info.kind === "tab") {
        await dispatchKeyEvent(tabId, {
          type: "keyDown",
          ...base,
        });
        await dispatchKeyEvent(tabId, {
          type: "keyUp",
          ...base,
        });
      }
    }

    if (hasDelay) {
      await sleep(delayMs);
    }
  }
}

async function getElementCoordinates(tabId, msg) {
  const { selector, selectorText } = msg || {};
  if (!selector) throw new Error("Missing msg.selector");

  const waitElement = msg?.waitElement !== false;
  const intervalMs = Number.isFinite(msg.intervalMs) ? msg.intervalMs : 200;
  const timeoutMs = Number.isFinite(msg.timeoutMs) ? msg.timeoutMs : 30000;

  if (msg && Object.prototype.hasOwnProperty.call(msg, "afterFoundMs")) {
    throw new Error("Unsupported parameter: afterFoundMs. Use waitAfterFoundMs instead.");
  }

  const waitAfterFoundMs = Number.isFinite(msg.waitAfterFoundMs) ? msg.waitAfterFoundMs : 100;
  const afterFoundMs = waitElement ? waitAfterFoundMs : 0;
  const expression = buildGetElementCoordinatesExpression({ selector, selectorText, afterFoundMs });

  let result;
  let attempts = 1;
  if (waitElement) {
    const execRes = await runFindAndActWithRetry(tabId, expression, intervalMs, timeoutMs);
    attempts = execRes?.attempts || 1;

    if (!execRes?.ok) {
      const errText = execRes?.result?.error || "getElementCoordinates failed";
      if (execRes?.timeout) {
        throw new Error(`${errText} (timeout waiting for element)`);
      }
      throw new Error(errText);
    }
    result = execRes.result;
  } else {
    result = await runInPageViaDebugger(tabId, expression);
    if (!result?.ok) {
      throw new Error(result?.error || "getElementCoordinates failed");
    }
  }

  return { attempts, result };
}

function hasInputKeySelector(selector) {
  if (Array.isArray(selector)) {
    return selector.some((item) => String(item ?? "").trim() !== "");
  }

  return String(selector ?? "").trim() !== "";
}

function buildWaitForElementExpression({ selector, selectorText }) {
  const payload = {
    selector: Array.isArray(selector) ? selector : selector || "",
    selectorText: Array.isArray(selectorText) ? selectorText : selectorText || "",
  };
  const injected = JSON.stringify(payload);

  return `
(() => {
  const { selector, selectorText } = ${injected};
  const selectors = (Array.isArray(selector) ? selector : [selector])
    .map((item) => String(item || "").trim())
    .filter(Boolean);
  const selectorTexts = (Array.isArray(selectorText) ? selectorText : [selectorText])
    .map((item) => String(item || "").trim())
    .filter(Boolean);

  const all = selectors.flatMap((item) => Array.from(document.querySelectorAll(item)));
  if (!all.length) {
    return { ok: false, code: "NOT_FOUND", error: "No elements matched selector", selector, selectorText };
  }

  const getText = (el) => {
    const parts = [
      el?.innerText,
      el?.textContent,
      el?.value,
      el?.getAttribute?.("aria-label"),
      el?.getAttribute?.("title"),
      el?.getAttribute?.("placeholder"),
    ].filter(Boolean).map(String);

    return parts.join(" ").trim();
  };

  if (selectorTexts.length) {
    const target = all.find((node) => {
      const text = getText(node);
      return selectorTexts.some((item) => text.includes(item));
    });
    if (!target) {
      return { ok: false, code: "NOT_FOUND_TEXT", error: "No elements matched selectorText within selector results", selector, selectorText, candidates: all.length };
    }
  }

  return { ok: true, candidates: all.length };
})()
  `.trim();
}

async function waitForUrlMatch(tabId, pattern, flags, intervalMs = 200, timeoutMs = 30000) {
  let regex;
  try {
    if (pattern instanceof RegExp) {
      regex = new RegExp(pattern.source, flags ?? pattern.flags);
    } else if (typeof pattern === "string") {
      regex = new RegExp(pattern, flags || "");
    } else {
      throw new Error("pattern must be a string or RegExp");
    }
  } catch (e) {
    throw new Error(`Invalid regex: ${String(e?.message || e)}`);
  }

  const start = Date.now();
  let attempts = 0;

  while (true) {
    attempts += 1;
    const tab = await chrome.tabs.get(tabId);
    const url = tab?.url || "";

    if (regex.test(url)) {
      return { ok: true, attempts, url };
    }

    const elapsed = Date.now() - start;
    const hasTimeout = timeoutMs >= 0;
    if (hasTimeout && elapsed >= timeoutMs) {
      throw new Error(
        `waitUrlMatch timeout (timeoutMs=${timeoutMs}, intervalMs=${intervalMs}, pattern=${pattern})`
      );
    }

    await sleep(intervalMs);
  }
}

async function waitForNetworkIdle(tabId, idleMs = 1000, timeoutMs = 30000) {
  await ensureDebuggerAttached(tabId);
  await ensureNetworkEnabled(tabId);

  const st = getNetState(tabId);

  const start = Date.now();

  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      const now = Date.now();

      if (now - start > timeoutMs) {
        clearInterval(timer);
        reject(
          new Error(
            `waitNetworkIdle timeout (timeoutMs=${timeoutMs}, idleMs=${idleMs}, pending=${st.pending.size})`
          )
        );
        return;
      }

      const idleFor = now - st.lastActivity;
      if (st.pending.size === 0 && idleFor >= idleMs) {
        clearInterval(timer);
        resolve({ ok: true, pending: 0, idleFor });
      }
    }, 100);
  });
}

function normalizeCookieDomain(domain) {
  return String(domain || "").replace(/^\.+/, "");
}

function cookieDomainMatches(cookieDomain, requestedDomain) {
  const cookieValue = String(cookieDomain || "");
  const requestedValue = String(requestedDomain || "");
  return cookieValue === requestedValue || normalizeCookieDomain(cookieValue) === normalizeCookieDomain(requestedValue);
}

function getCookies(query) {
  return new Promise((resolve, reject) => {
    chrome.cookies.getAll(query, (cookies) => {
      const err = chrome.runtime?.lastError;
      if (err) {
        reject(new Error(err.message || String(err)));
        return;
      }

      resolve(Array.isArray(cookies) ? cookies : []);
    });
  });
}

function removeCookie(details) {
  return new Promise((resolve, reject) => {
    chrome.cookies.remove(details, (removedCookie) => {
      const err = chrome.runtime?.lastError;
      if (err) {
        reject(new Error(err.message || String(err)));
        return;
      }

      resolve(removedCookie || null);
    });
  });
}

function buildCookieRemoveUrl(cookie) {
  const scheme = cookie.secure ? "https" : "http";
  const host = normalizeCookieDomain(cookie.domain);
  const path = cookie.path || "/";
  return `${scheme}://${host}${path.startsWith("/") ? path : `/${path}`}`;
}

function summarizeCookie(cookie) {
  return {
    name: cookie.name,
    domain: cookie.domain,
    path: cookie.path,
    secure: !!cookie.secure,
    storeId: cookie.storeId,
    partitionKey: cookie.partitionKey,
  };
}

function cookieIdentityKey(cookie) {
  return JSON.stringify({
    name: cookie.name || "",
    domain: cookie.domain || "",
    path: cookie.path || "",
    storeId: cookie.storeId || "",
    partitionKey: cookie.partitionKey || null,
  });
}

function dedupeCookies(cookies) {
  const seen = new Set();
  const uniqueCookies = [];

  for (const cookie of cookies) {
    const key = cookieIdentityKey(cookie);
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueCookies.push(cookie);
  }

  return uniqueCookies;
}

async function clearCookies(msg) {
  const hasUrl = typeof msg?.url === "string" && msg.url.trim() !== "";
  const hasDomain = Object.prototype.hasOwnProperty.call(msg || {}, "domain");

  if (!hasUrl && !hasDomain) {
    throw new Error("clearCookies requires url or domain.");
  }

  let url;
  if (hasUrl) {
    try {
      url = new URL(msg.url);
    } catch (e) {
      throw new Error(`clearCookies url is invalid: ${String(e?.message || e)}`);
    }

    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("clearCookies url must use http or https.");
    }
  }

  let domain;
  let domains;
  if (hasDomain) {
    if (Array.isArray(msg.domain)) {
      if (msg.domain.length === 0 || msg.domain.some((item) => typeof item !== "string" || item.trim() === "")) {
        throw new Error("clearCookies domain array must be non-empty and contain only non-empty strings.");
      }
      domain = msg.domain;
      domains = msg.domain.map((item) => item.trim());
    } else {
      if (typeof msg.domain !== "string" || msg.domain.trim() === "") {
        throw new Error("clearCookies domain must be a non-empty string or a non-empty string array.");
      }
      domain = msg.domain;
      domains = [msg.domain.trim()];
    }
  }

  let names;
  if (Object.prototype.hasOwnProperty.call(msg || {}, "names")) {
    if (!Array.isArray(msg.names) || msg.names.some((name) => typeof name !== "string")) {
      throw new Error("clearCookies names must be an array of strings.");
    }
    names = new Set(msg.names);
  }

  if (Object.prototype.hasOwnProperty.call(msg || {}, "storeId")) {
    if (typeof msg.storeId !== "string" || msg.storeId.trim() === "") {
      throw new Error("clearCookies storeId must be a non-empty string.");
    }
  }

  let allCookies;
  if (url) {
    const getAllQuery = { url: url.href };
    if (typeof msg?.storeId === "string") getAllQuery.storeId = msg.storeId;
    allCookies = await getCookies(getAllQuery);
  } else {
    const cookieGroups = await Promise.all(
      domains.map((item) => {
        const getAllQuery = { domain: normalizeCookieDomain(item) };
        if (typeof msg?.storeId === "string") getAllQuery.storeId = msg.storeId;
        return getCookies(getAllQuery);
      })
    );
    allCookies = dedupeCookies(cookieGroups.flat());
  }

  const targetCookies = allCookies.filter((cookie) => {
    if (domains && !domains.some((item) => cookieDomainMatches(cookie.domain, item))) return false;
    if (names && !names.has(cookie.name)) return false;
    return true;
  });

  const cookies = [];
  const failures = [];

  for (const cookie of targetCookies) {
    const removeDetails = {
      url: buildCookieRemoveUrl(cookie),
      name: cookie.name,
    };
    if (cookie.storeId) removeDetails.storeId = cookie.storeId;
    if (cookie.partitionKey) removeDetails.partitionKey = cookie.partitionKey;

    try {
      const removedCookie = await removeCookie(removeDetails);
      if (!removedCookie) {
        failures.push({ cookie: summarizeCookie(cookie), details: removeDetails, error: "chrome.cookies.remove returned no cookie." });
        continue;
      }
      cookies.push({ ...summarizeCookie(cookie), details: removeDetails });
    } catch (e) {
      failures.push({ cookie: summarizeCookie(cookie), details: removeDetails, error: String(e?.message || e) });
    }
  }

  return {
    ok: true,
    scope: url ? "url" : "domain",
    query: {
      ...(url ? { url: url.href } : {}),
      ...(domain ? { domain } : {}),
      ...(names ? { names: Array.from(names) } : {}),
      ...(msg?.storeId ? { storeId: msg.storeId } : {}),
    },
    removed: cookies.length,
    failed: failures.length,
    cookies,
    failures,
  };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    const action = msg?.action || msg?.type;
    if (!action) throw new Error("Missing msg.action or msg.type");

    const needsTab =
      action === "waitNetworkIdle" ||
      action === "waitForElement" ||
      action === "waitUrlMatch" ||
      action === "click" ||
      action === "clickElementCoordinates" ||
      action === "getElementCoordinates" ||
      action === "clickCoordinates" ||
      action === "input" ||
      action === "inputKey" ||
      action === "pasteInput" ||
      action === "enableForegroundMask" ||
      action === "disableForegroundMask" ||
      action === "getForegroundMaskState";

    const tabId = needsTab ? await getTabId(sender) : undefined;

    if (action === "captureVisibleTab") {
      const result = await handleCaptureVisibleTab(msg, sender);
      sendResponse({ ok: true, ...result });
      return;
    }

    if (action === "clearCookies") {
      const result = await clearCookies(msg || {});
      sendResponse(result);
      return;
    }

    if (action === "waitNetworkIdle") {
      const idleMs = Number.isFinite(msg.idleMs) ? msg.idleMs : 1000;
      const timeoutMs = Number.isFinite(msg.timeoutMs) ? msg.timeoutMs : 30000;

      const result = await waitForNetworkIdle(tabId, idleMs, timeoutMs);
      sendResponse({ ok: true, tabId, ...result });
      return;
    }

    if (action === "enableForegroundMask") {
      const result = await enableForegroundMask(tabId, msg || {});
      sendResponse({ ok: true, tabId, ...result });
      return;
    }

    if (action === "disableForegroundMask") {
      const result = await disableForegroundMask(tabId);
      sendResponse({ ok: true, tabId, ...result });
      return;
    }

    if (action === "getForegroundMaskState") {
      const result = getForegroundMaskState(tabId);
      sendResponse({ ok: true, tabId, ...result });
      return;
    }

    if (action === "kvGet") {
      const { key } = msg || {};
      if (!key) throw new Error("Missing msg.key");
      const area = normalizeArea(msg?.area);
      const value = await storageGetString(key, area);
      sendResponse({ ok: true, area, key, value });
      return;
    }

    if (action === "kvSet") {
      const { key, value } = msg || {};
      if (!key) throw new Error("Missing msg.key");
      const area = normalizeArea(msg?.area);
      await storageSetString(key, value, area);
      sendResponse({ ok: true, area, key });
      return;
    }

    if (action === "kvDel") {
      const { key } = msg || {};
      if (!key) throw new Error("Missing msg.key");
      const area = normalizeArea(msg?.area);
      await storageDel(key, area);
      sendResponse({ ok: true, area, key });
      return;
    }

    if (action === "waitForElement") {
      const { selector, selectorText } = msg || {};
      if (!selector) throw new Error("Missing msg.selector");

      const intervalMs = Number.isFinite(msg.intervalMs) ? msg.intervalMs : 200;
      const timeoutMs = Number.isFinite(msg.timeoutMs) ? msg.timeoutMs : 30000;

      await ensureDebuggerAttached(tabId);

      const expression = buildWaitForElementExpression({ selector, selectorText });
      const execRes = await runFindAndActWithRetry(tabId, expression, intervalMs, timeoutMs);

      if (!execRes?.ok) {
        const errText = execRes?.result?.error || "waitForElement failed";
        if (execRes?.timeout) {
          throw new Error(`${errText} (timeout waiting for element)`);
        }
        throw new Error(errText);
      }

      sendResponse({ ok: true, tabId, attempts: execRes.attempts, candidates: execRes?.result?.candidates ?? 0 });
      return;
    }

    if (action === "waitUrlMatch") {
      const { pattern, flags } = msg || {};
      if (!pattern) throw new Error("Missing msg.pattern");

      const intervalMs = Number.isFinite(msg.intervalMs) ? msg.intervalMs : 200;
      const timeoutMs = Number.isFinite(msg.timeoutMs) ? msg.timeoutMs : 30000;

      const result = await waitForUrlMatch(tabId, pattern, flags, intervalMs, timeoutMs);
      sendResponse({ ok: true, tabId, ...result });
      return;
    }

    if (action === "inputKey") {
      const { selector, selectorText, value } = msg || {};
      const shouldFocusSelector = hasInputKeySelector(selector);

      await ensureDebuggerAttached(tabId);

      const waitElement = msg?.waitElement !== false;

      if (msg && Object.prototype.hasOwnProperty.call(msg, "afterFoundMs")) {
        throw new Error("Unsupported parameter: afterFoundMs. Use waitAfterFoundMs instead.");
      }

      if (shouldFocusSelector) {
        const intervalMs = Number.isFinite(msg.intervalMs) ? msg.intervalMs : 200;
        const timeoutMs = Number.isFinite(msg.timeoutMs) ? msg.timeoutMs : 30000;
        const waitAfterFoundMs = Number.isFinite(msg.waitAfterFoundMs) ? msg.waitAfterFoundMs : 100;
        const afterFoundMs = waitElement ? waitAfterFoundMs : 0;

        const expression = buildFindAndActExpression({
          action: "focus",
          selector,
          selectorText,
          value: "",
          afterFoundMs,
        });

        if (waitElement) {
          const execRes = await runFindAndActWithRetry(tabId, expression, intervalMs, timeoutMs);

          if (!execRes?.ok) {
            const errText = execRes?.result?.error || "Action failed";
            if (execRes?.timeout) {
              throw new Error(`${errText} (timeout waiting for element)`);
            }
            throw new Error(errText);
          }
        } else {
          const result = await runInPageViaDebugger(tabId, expression);
          if (!result?.ok) {
            throw new Error(result?.error || "Action failed");
          }
        }
      }

      const perKeyDelayMs = Number.isFinite(msg.perKeyDelayMs) ? msg.perKeyDelayMs : 0;
      await typeTextViaDebugger(tabId, value, perKeyDelayMs);

      sendResponse({ ok: true, tabId });
      return;
    }

    if (action === "pasteInput") {
      const { selector, selectorText, value } = msg || {};
      const shouldFocusSelector = hasInputKeySelector(selector);

      await ensureDebuggerAttached(tabId);

      const waitElement = msg?.waitElement !== false;

      if (msg && Object.prototype.hasOwnProperty.call(msg, "afterFoundMs")) {
        throw new Error("Unsupported parameter: afterFoundMs. Use waitAfterFoundMs instead.");
      }

      if (shouldFocusSelector) {
        const intervalMs = Number.isFinite(msg.intervalMs) ? msg.intervalMs : 200;
        const timeoutMs = Number.isFinite(msg.timeoutMs) ? msg.timeoutMs : 30000;
        const waitAfterFoundMs = Number.isFinite(msg.waitAfterFoundMs) ? msg.waitAfterFoundMs : 100;
        const afterFoundMs = waitElement ? waitAfterFoundMs : 0;

        const expression = buildFindAndActExpression({
          action: "focus",
          selector,
          selectorText,
          value: "",
          afterFoundMs,
        });

        if (waitElement) {
          const execRes = await runFindAndActWithRetry(tabId, expression, intervalMs, timeoutMs);

          if (!execRes?.ok) {
            const errText = execRes?.result?.error || "Action failed";
            if (execRes?.timeout) {
              throw new Error(`${errText} (timeout waiting for element)`);
            }
            throw new Error(errText);
          }
        } else {
          const result = await runInPageViaDebugger(tabId, expression);
          if (!result?.ok) {
            throw new Error(result?.error || "Action failed");
          }
        }
      }

      await insertTextViaDebugger(tabId, value);

      sendResponse({ ok: true, tabId });
      return;
    }

    if (action === "getElementCoordinates") {
      await ensureDebuggerAttached(tabId);
      const { attempts, result } = await getElementCoordinates(tabId, msg || {});

      sendResponse({ ok: true, tabId, attempts, ...result });
      return;
    }

    if (action === "clickElementCoordinates") {
      await ensureDebuggerAttached(tabId);
      const { attempts, result } = await getElementCoordinates(tabId, msg || {});
      const coordinates = normalizeClickCoordinates({ ...result, button: msg?.button, clickCount: msg?.clickCount });
      await clickCoordinatesViaDebugger(tabId, coordinates);

      sendResponse({ ok: true, tabId, attempts, ...coordinates, coordinates, element: result });
      return;
    }

    if (action === "clickCoordinates") {
      await ensureDebuggerAttached(tabId);

      const coordinates = normalizeClickCoordinates(msg || {});
      await clickCoordinatesViaDebugger(tabId, coordinates);

      sendResponse({ ok: true, tabId, ...coordinates });
      return;
    }

    // click / input (保持兼容你的现有调用)
    const { selector, selectorText, value } = msg || {};
    if (!selector) throw new Error("Missing msg.selector");

    await ensureDebuggerAttached(tabId);

    const waitElement = msg?.waitElement !== false;
    const intervalMs = Number.isFinite(msg.intervalMs) ? msg.intervalMs : 200;
    const timeoutMs = Number.isFinite(msg.timeoutMs) ? msg.timeoutMs : 30000;

    if (msg && Object.prototype.hasOwnProperty.call(msg, "afterFoundMs")) {
      throw new Error("Unsupported parameter: afterFoundMs. Use waitAfterFoundMs instead.");
    }

    const waitAfterFoundMs = Number.isFinite(msg.waitAfterFoundMs) ? msg.waitAfterFoundMs : 100;

    const afterFoundMs = waitElement ? waitAfterFoundMs : 0;

    const expression = buildFindAndActExpression({
      action,
      selector,
      selectorText,
      value,
      afterFoundMs,
    });

    if (waitElement) {
      const execRes = await runFindAndActWithRetry(tabId, expression, intervalMs, timeoutMs);

      if (!execRes?.ok) {
        const errText = execRes?.result?.error || "Action failed";
        if (execRes?.timeout) {
          throw new Error(`${errText} (timeout waiting for element)`);
        }
        throw new Error(errText);
      }
    } else {
      const result = await runInPageViaDebugger(tabId, expression);
      if (!result?.ok) {
        throw new Error(result?.error || "Action failed");
      }
    }

    sendResponse({ ok: true, tabId });
  })().catch((err) => {
    sendResponse({ ok: false, error: String(err?.message || err) });
  });

  return true;
});
