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
      el instanceof HTMLTextAreaElement ||
      el.isContentEditable;

    if (!isEditable) {
      return { ok: false, error: "Target is not editable (input/textarea/contenteditable)", selector, selectorText };
    }

    try { el.focus?.(); } catch (e) {}
    try { el.click?.(); } catch (e) {}
    return { ok: true };
  }

  if (action === "input") {
    const isEditable =
      el instanceof HTMLInputElement ||
      el instanceof HTMLTextAreaElement ||
      el.isContentEditable;

    if (!isEditable) {
      return { ok: false, error: "Target is not editable (input/textarea/contenteditable)", selector, selectorText };
    }

    try { el.focus?.(); } catch (e) {}

    if (el.isContentEditable) {
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

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    const { action } = msg || {};
    if (!action) throw new Error("Missing msg.action");

    const needsTab =
      action === "waitNetworkIdle" ||
      action === "waitForElement" ||
      action === "waitUrlMatch" ||
      action === "click" ||
      action === "input" ||
      action === "inputKey" ||
      action === "enableForegroundMask" ||
      action === "disableForegroundMask" ||
      action === "getForegroundMaskState";

    const tabId = needsTab ? await getTabId(sender) : undefined;

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

      const perKeyDelayMs = Number.isFinite(msg.perKeyDelayMs) ? msg.perKeyDelayMs : 0;
      await typeTextViaDebugger(tabId, value, perKeyDelayMs);

      sendResponse({ ok: true, tabId });
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
