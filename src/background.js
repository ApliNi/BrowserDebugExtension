// background.js

const DEBUGGER_PROTOCOL_VERSION = "1.3";
const STARTUP_URL_STORAGE_KEY = "apliNiBrowserDebuggingExtensionStartupUrl";
const STARTUP_OPEN_DELAY_MS = 1000;
const attachedTabs = new Set();
const pageEnabledTabs = new Set();
const eventListeners = new Map();

const EVENT_REMOVE_ACTIONS = new Set(["removeEventListener", "unlistenEvent", "removeEvent"]);

// per-tab network tracking state
const netStates = new Map(); // tabId -> { enabled, pending:Set, lastActivity:number }
const foregroundMaskStates = new Map(); // tabId -> { enabled, config, scriptId, appliedAt }

function normalizeEventName(name) {
  const normalizedName = String(name || "").trim();
  if (!normalizedName) {
    throw new Error("Missing msg.name");
  }
  return normalizedName;
}

function normalizeEventListenerId(msg) {
  const listenerId = msg?.listenerId ?? msg?.id;
  const normalizedId = String(listenerId || "").trim();
  if (!normalizedId) {
    throw new Error("Missing msg.listenerId or msg.id");
  }
  return normalizedId;
}

function getEventSenderLocation(sender) {
  const tabId = sender?.tab?.id;
  if (!Number.isInteger(tabId)) {
    throw new Error("Event listeners require a sender tab.");
  }

  const frameId = Number.isInteger(sender?.frameId) ? sender.frameId : 0;
  return { tabId, frameId };
}

function sendEventDelivery(listener, data) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(
      listener.tabId,
      {
        kind: "debug-event-delivery",
        listenerId: listener.listenerId,
        name: listener.name,
        data,
      },
      { frameId: listener.frameId },
      (response) => {
        const err = chrome.runtime?.lastError;
        if (err) {
          reject(new Error(err.message || String(err)));
          return;
        }

        if (!response?.ok || response?.handled !== true) {
          reject(new Error(response?.error || "Event delivery was not handled."));
          return;
        }

        resolve(response);
      }
    );
  });
}

function cleanupTabEventListeners(tabId) {
  if (!Number.isInteger(tabId)) return 0;

  let removed = 0;
  for (const [listenerId, listener] of eventListeners.entries()) {
    if (listener.tabId === tabId) {
      eventListeners.delete(listenerId);
      removed += 1;
    }
  }
  return removed;
}

function registerEventListener(msg, sender, once) {
  const name = normalizeEventName(msg?.name);
  const listenerId = normalizeEventListenerId(msg);
  if (eventListeners.has(listenerId)) {
    throw new Error("Duplicate event listenerId: " + listenerId);
  }

  const location = getEventSenderLocation(sender);
  eventListeners.set(listenerId, { listenerId, name, once: Boolean(once), ...location });
  return { ok: true, listenerId, name };
}

function removeEventListenerRegistration(msg) {
  const listenerId = normalizeEventListenerId(msg);
  if (!eventListeners.delete(listenerId)) {
    throw new Error("Unknown event listenerId: " + listenerId);
  }

  return { ok: true, listenerId };
}

async function broadcastDebugEvent(msg) {
  const name = normalizeEventName(msg?.name);
  const targets = Array.from(eventListeners.values()).filter((listener) => listener.name === name);
  let delivered = 0;
  const failures = [];

  for (const listener of targets) {
    try {
      await sendEventDelivery(listener, msg?.data);
      delivered += 1;
      if (listener.once) {
        eventListeners.delete(listener.listenerId);
      }
    } catch (error) {
      eventListeners.delete(listener.listenerId);
      const failure = {
        listenerId: listener.listenerId,
        tabId: listener.tabId,
        frameId: listener.frameId,
        error: String(error?.message || error),
      };
      failures.push(failure);
      console.warn("Debug event delivery failed", failure);
    }
  }

  return { ok: true, name, delivered, failed: failures.length, failures };
}

chrome.tabs.onRemoved.addListener((tabId) => {
  cleanupTabEventListeners(tabId);
});

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

function normalizeHttpUrl(rawUrl, label) {
  const urlText = String(rawUrl || "").trim();
  if (!urlText) return "";

  let parsedUrl;
  try {
    parsedUrl = new URL(urlText);
  } catch (error) {
    throw new Error(`${label} is invalid: ${String(error?.message || error)}`);
  }

  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new Error(`${label} must use http or https.`);
  }

  return parsedUrl.href;
}

function normalizeStartupUrl(rawUrl) {
  return normalizeHttpUrl(rawUrl, "Startup URL");
}

function parseStartupUrls(rawUrls) {
  return String(rawUrls || "")
    .split(/\r?\n/)
    .map((rawUrl, index) => ({ rawUrl, lineNumber: index + 1 }))
    .filter(({ rawUrl }) => String(rawUrl || "").trim())
    .reduce((urls, { rawUrl, lineNumber }) => {
      try {
        urls.push(normalizeHttpUrl(rawUrl, `Startup URL line ${lineNumber}`));
      } catch (error) {
        console.error("Invalid configured startup URL:", {
          lineNumber,
          url: rawUrl,
          error: String(error?.message || error),
        });
      }

      return urls;
    }, []);
}

function createTab(url) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const resolveOnce = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const rejectOnce = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    try {
      const maybePromise = chrome.tabs.create({ url }, (tab) => {
        const err = chrome.runtime?.lastError;
        if (err) {
          rejectOnce(new Error(err.message || String(err)));
          return;
        }

        resolveOnce(tab);
      });

      if (maybePromise && typeof maybePromise.then === "function") {
        maybePromise.then(resolveOnce, rejectOnce);
      }
    } catch (error) {
      rejectOnce(error);
    }
  });
}

async function openConfiguredStartupUrl() {
  const storedUrls = await storageGetString(STARTUP_URL_STORAGE_KEY, "local");
  const startupUrls = parseStartupUrls(storedUrls);
  if (!startupUrls.length) return;

  await sleep(STARTUP_OPEN_DELAY_MS);
  for (const startupUrl of startupUrls) {
    try {
      await createTab(startupUrl);
    } catch (error) {
      console.error("Failed to open configured startup URL:", {
        url: startupUrl,
        error: String(error?.message || error),
      });
    }
  }
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

function normalizeOpenTabFocus(msg) {
  if (!msg || !Object.prototype.hasOwnProperty.call(msg, "focus")) {
    return true;
  }

  if (typeof msg.focus !== "boolean") {
    throw new Error("openTab focus must be a boolean when provided.");
  }

  return msg.focus;
}

function normalizeOpenTabIncognito(msg) {
  if (!msg || !Object.prototype.hasOwnProperty.call(msg, "incognito")) {
    return false;
  }

  if (typeof msg.incognito !== "boolean") {
    throw new Error("openTab incognito must be a boolean when provided.");
  }

  return msg.incognito;
}

function isAllowedIncognitoAccess() {
  return new Promise((resolve, reject) => {
    try {
      chrome.extension.isAllowedIncognitoAccess((allowed) => {
        const err = chrome.runtime?.lastError;
        if (err) {
          reject(new Error(err.message || String(err)));
          return;
        }

        resolve(Boolean(allowed));
      });
    } catch (error) {
      reject(error);
    }
  });
}

function createIncognitoWindow(url, focus) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const resolveOnce = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const rejectOnce = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    try {
      const maybePromise = chrome.windows.create({ url, incognito: true, focused: focus }, (createdWindow) => {
        const err = chrome.runtime?.lastError;
        if (err) {
          rejectOnce(new Error(err.message || String(err)));
          return;
        }

        resolveOnce(createdWindow);
      });

      if (maybePromise && typeof maybePromise.then === "function") {
        maybePromise.then(resolveOnce, rejectOnce);
      }
    } catch (error) {
      rejectOnce(error);
    }
  });
}

async function getCreatedTabIdByTargetId(targetId) {
  if (!targetId) return null;

  const targets = await chrome.debugger.getTargets();
  const target = Array.isArray(targets) ? targets.find((item) => item?.id === targetId) : undefined;
  return Number.isInteger(target?.tabId) ? target.tabId : null;
}

async function openTabViaDebugger(tabId, msg) {
  const url = normalizeHttpUrl(msg?.url, "openTab url");
  if (!url) {
    throw new Error("Missing msg.url");
  }

  const focus = normalizeOpenTabFocus(msg);
  const incognito = normalizeOpenTabIncognito(msg);

  if (incognito) {
    const allowed = await isAllowedIncognitoAccess();
    if (!allowed) {
      throw new Error("openTab incognito requires allowing this extension to run in incognito mode.");
    }

    const createdWindow = await createIncognitoWindow(url, focus);
    const windowId = Number.isInteger(createdWindow?.id) ? createdWindow.id : null;
    const createdTab = Array.isArray(createdWindow?.tabs) ? createdWindow.tabs.find((tab) => Number.isInteger(tab?.id)) : null;
    const createdTabId = Number.isInteger(createdTab?.id) ? createdTab.id : null;

    if (!Number.isInteger(windowId)) {
      throw new Error("chrome.windows.create did not return a valid incognito window id.");
    }

    if (createdWindow?.incognito !== true) {
      throw new Error("chrome.windows.create did not return an incognito window.");
    }

    return {
      ok: true,
      incognito: true,
      windowId,
      tabId,
      createdTabId,
      sourceTabId: tabId,
    };
  }

  await ensureDebuggerAttached(tabId);

  const result = await chrome.debugger.sendCommand(attachTarget(tabId), "Target.createTarget", {
    url,
    newWindow: false,
    background: !focus,
  });

  const targetId = result?.targetId;
  if (typeof targetId !== "string" || !targetId) {
    throw new Error("Target.createTarget did not return targetId.");
  }

  let createdTabId = null;
  try {
    createdTabId = await getCreatedTabIdByTargetId(targetId);
  } catch (error) {
    console.warn("openTab could not resolve created tab id", {
      tabId,
      targetId,
      error: String(error?.message || error),
    });
  }

  return { ok: true, tabId, sourceTabId: tabId, targetId, createdTabId };
}

const FETCH_NULL_BODY_STATUS = new Set([204, 205, 304]);

function removeHeader(headers, name) {
  const lowerName = String(name).toLowerCase();
  for (const key of Array.from(headers.keys())) {
    if (String(key).toLowerCase() === lowerName) {
      headers.delete(key);
    }
  }
}

function deserializeBodyPart(part) {
  if (!part || typeof part !== "object") {
    throw new Error("Invalid serialized body part");
  }

  if (part.kind === "string") return String(part.value ?? "");
  if (part.kind === "blob") return new Blob([part.body], { type: part.type || "" });
  if (part.kind === "file") {
    return new File([part.body], part.name || "blob", {
      type: part.type || "",
      lastModified: Number.isFinite(part.lastModified) ? part.lastModified : Date.now(),
    });
  }

  throw new Error("Unsupported serialized FormData part kind: " + String(part.kind));
}

function deserializeFetchBody(serializedBody) {
  if (serializedBody == null) return null;
  if (!serializedBody || typeof serializedBody !== "object") {
    throw new Error("Invalid serialized fetch body");
  }

  if (serializedBody.kind === "string") return String(serializedBody.value ?? "");
  if (serializedBody.kind === "urlSearchParams") return new URLSearchParams(String(serializedBody.value ?? ""));
  if (serializedBody.kind === "arrayBuffer") return serializedBody.body;
  if (serializedBody.kind === "blob") return new Blob([serializedBody.body], { type: serializedBody.type || "" });
  if (serializedBody.kind === "file") {
    return new File([serializedBody.body], serializedBody.name || "blob", {
      type: serializedBody.type || "",
      lastModified: Number.isFinite(serializedBody.lastModified) ? serializedBody.lastModified : Date.now(),
    });
  }
  if (serializedBody.kind === "formData") {
    const formData = new FormData();
    for (const entry of serializedBody.entries || []) {
      const [name, value] = entry;
      formData.append(String(name), deserializeBodyPart(value));
    }
    return formData;
  }

  throw new Error("Unsupported serialized fetch body kind: " + String(serializedBody.kind));
}

function copyFetchInitFields(source, target) {
  const fields = [
    "method",
    "credentials",
    "cache",
    "redirect",
    "referrer",
    "referrerPolicy",
    "integrity",
    "keepalive",
    "mode",
    "priority",
    "duplex",
  ];
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(source, field)) {
      target[field] = source[field];
    }
  }
}

async function handleFetchAction(msg) {
  const request = msg?.request;
  if (!request || typeof request !== "object") {
    throw new Error("Missing fetch request payload");
  }

  const url = request.url || request.input;
  if (typeof url !== "string" || !url) {
    throw new Error("Missing fetch request url");
  }

  const sourceInit = request.init || {};
  const headers = new Headers(sourceInit.headers || []);
  const body = deserializeFetchBody(sourceInit.body);
  if (sourceInit.body?.kind === "formData") {
    removeHeader(headers, "Content-Type");
    removeHeader(headers, "Content-Length");
  }

  const init = { headers };
  copyFetchInitFields(sourceInit, init);
  if (body != null) {
    init.body = body;
  }
  if (body != null && typeof init.duplex === "undefined" && typeof ReadableStream !== "undefined" && body instanceof ReadableStream) {
    init.duplex = "half";
  }

  const response = await fetch(url, init);
  const status = response.status;
  const responseBody = FETCH_NULL_BODY_STATUS.has(status) ? null : await response.arrayBuffer();

  return {
    ok: true,
    fetch: true,
    response: {
      status,
      statusText: response.statusText,
      headers: Array.from(response.headers.entries()),
      body: responseBody,
      url: response.url,
      redirected: response.redirected,
      type: response.type,
    },
  };
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

chrome.runtime.onStartup.addListener(() => {
  openConfiguredStartupUrl().catch((error) => {
    console.error("Failed to open configured startup URL:", error);
  });
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

const ELEMENT_FINDER_HELPER = String.raw`
  const isPlainObject = (value) => value && typeof value === "object" && !Array.isArray(value);

  const normalizeItems = (value) => (Array.isArray(value) ? value : [value])
    .map((item) => String(item || "").trim())
    .filter(Boolean);

  const normalizeTextItems = (value) => (Array.isArray(value) ? value : [value])
    .map((item) => String(item ?? ""))
    .filter((item) => item.trim() !== "");

  const isExpressionValue = (value) => {
    if (Array.isArray(value)) return value.some(isExpressionValue);
    if (isPlainObject(value)) return Object.keys(value).length > 0;
    return String(value ?? "").trim() !== "";
  };

  const getTextParts = (el) => {
    const parts = [
      el?.innerText,
      el?.textContent,
      el?.value,
      el?.getAttribute?.("aria-label"),
      el?.getAttribute?.("title"),
      el?.getAttribute?.("placeholder"),
    ].filter(Boolean).map(String);

    return parts;
  };

  const getDepth = (el) => {
    let depth = 0;
    for (let node = el; node && node.parentElement; node = node.parentElement) depth += 1;
    return depth;
  };

  const getVisibleArea = (el) => {
    const rect = el.getBoundingClientRect();
    if (!Number.isFinite(rect.width) || !Number.isFinite(rect.height) || rect.width <= 0 || rect.height <= 0) {
      return Number.POSITIVE_INFINITY;
    }

    const visibleLeft = Math.max(rect.left, 0);
    const visibleTop = Math.max(rect.top, 0);
    const visibleRight = Math.min(rect.right, window.innerWidth);
    const visibleBottom = Math.min(rect.bottom, window.innerHeight);
    const visibleWidth = Math.max(0, visibleRight - visibleLeft);
    const visibleHeight = Math.max(0, visibleBottom - visibleTop);
    const visibleArea = visibleWidth * visibleHeight;
    return visibleArea > 0 ? visibleArea : Number.POSITIVE_INFINITY;
  };

  const isRootContainer = (el) => el === document.documentElement || el === document.body;

  const getTextMatchRank = (el, texts) => {
    const textParts = getTextParts(el);
    let bestRank = Number.POSITIVE_INFINITY;

    for (const item of texts) {
      const trimmedItem = item.trim();
      for (const text of textParts) {
        if (text === item) return 0;

        const trimmedText = text.trim();
        if (trimmedText === trimmedItem) bestRank = Math.min(bestRank, 1);
        else if (text.includes(item) || trimmedText.includes(trimmedItem)) bestRank = Math.min(bestRank, 2);
      }
    }

    return bestRank;
  };

  const getTextMatch = (el, texts) => {
    const rank = getTextMatchRank(el, texts);
    return Number.isFinite(rank) ? { el, rank } : null;
  };

  const uniqueElements = (elements) => {
    const seen = new Set();
    const unique = [];
    for (const el of elements) {
      if (seen.has(el)) continue;
      seen.add(el);
      unique.push(el);
    }
    return unique;
  };

  const compareDocumentOrder = (a, b) => {
    if (a === b) return 0;
    const position = a.compareDocumentPosition(b);
    if (position & Node.DOCUMENT_POSITION_PRECEDING) return 1;
    if (position & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
    return 0;
  };

  const getSubtreeSize = (el) => el ? el.querySelectorAll("*").length : Number.POSITIVE_INFINITY;

  const getLowestCommonAncestor = (elements) => {
    const valid = elements.filter(Boolean);
    if (!valid.length) return null;
    let current = valid[0];
    while (current) {
      if (valid.every((el) => current.contains(el))) return current;
      current = current.parentElement;
    }
    return document.documentElement;
  };

  const hasDistinctAssignment = (groups) => {
    const ordered = groups
      .map((items, index) => ({ index, items: uniqueElements(items) }))
      .sort((a, b) => a.items.length - b.items.length);
    const used = new Set();
    const visit = (index) => {
      if (index >= ordered.length) return true;
      for (const el of ordered[index].items) {
        if (used.has(el)) continue;
        used.add(el);
        if (visit(index + 1)) return true;
        used.delete(el);
      }
      return false;
    };
    return visit(0);
  };

  const rankContainers = (containers, childGroups) => {
    const ranked = uniqueElements(containers)
      .filter(Boolean)
      .map((el, index) => {
        const scopedGroups = childGroups.map((group) => group.filter((item) => el.contains(item)));
        return {
          el,
          index,
          depthRank: -getDepth(el),
          subtreeSize: getSubtreeSize(el),
          area: getVisibleArea(el),
          distinctRank: hasDistinctAssignment(scopedGroups) ? 0 : 1,
        };
      });

    ranked.sort((a, b) =>
      a.distinctRank - b.distinctRank ||
      a.depthRank - b.depthRank ||
      a.subtreeSize - b.subtreeSize ||
      a.area - b.area ||
      compareDocumentOrder(a.el, b.el) ||
      a.index - b.index
    );
    return ranked.map((item) => item.el);
  };

  const buildAndContainers = (childGroups) => {
    if (!childGroups.length || childGroups.some((group) => !group.length)) return [];
    const containers = [];
    const selected = [];
    const visit = (index) => {
      if (index >= childGroups.length) {
        const lca = getLowestCommonAncestor(selected);
        if (lca && !isRootContainer(lca)) containers.push(lca);
        else if (lca) containers.push(lca);
        return;
      }
      for (const el of childGroups[index]) {
        selected.push(el);
        visit(index + 1);
        selected.pop();
      }
    };
    visit(0);
    return rankContainers(containers, childGroups);
  };

  const queryAllWithin = (root, selector) => {
    const matches = [];
    if (root instanceof Element && root.matches(selector)) matches.push(root);
    const queryRoot = root instanceof Document ? root : root;
    matches.push(...Array.from(queryRoot.querySelectorAll(selector)));
    return uniqueElements(matches);
  };

  const getTextMatchesWithin = (root, texts) => {
    const nodes = root instanceof Document
      ? Array.from(document.querySelectorAll("*"))
      : [root, ...Array.from(root.querySelectorAll("*"))];
    return nodes
      .filter((node) => !isRootContainer(node))
      .map((node) => getTextMatch(node, texts))
      .filter(Boolean);
  };

  const makeInvalidExpression = (kind, reason, selector, selectorText) => ({
    ok: false,
    code: "INVALID_" + kind.toUpperCase() + "_EXPRESSION",
    error: reason,
    selector,
    selectorText,
  });

  const evaluateSelectorExpression = (expr, root, rawSelector, rawSelectorText, allowFinal) => {
    if (Array.isArray(expr)) {
      const all = [];
      for (const item of expr) {
        const result = evaluateSelectorExpression(item, root, rawSelector, rawSelectorText, false);
        if (!result.ok) return result;
        all.push(...result.elements);
      }
      return { ok: true, elements: uniqueElements(all) };
    }

    if (isPlainObject(expr)) {
      const hasAnd = Object.prototype.hasOwnProperty.call(expr, "AND");
      const hasOr = Object.prototype.hasOwnProperty.call(expr, "OR");
      const hasFinal = Object.prototype.hasOwnProperty.call(expr, "final");
      const known = new Set(["AND", "OR", "final"]);
      const unknown = Object.keys(expr).filter((key) => !known.has(key));
      if (unknown.length) return makeInvalidExpression("selector", "Unknown selector expression field: " + unknown.join(", "), rawSelector, rawSelectorText);
      if (hasAnd && hasOr) return makeInvalidExpression("selector", "selector expression cannot contain both AND and OR at the same level", rawSelector, rawSelectorText);
      if (hasFinal && !allowFinal) return makeInvalidExpression("selector", "selector.final is only allowed at the top level", rawSelector, rawSelectorText);
      if (!hasAnd && !hasOr) return makeInvalidExpression("selector", "selector expression requires AND or OR", rawSelector, rawSelectorText);

      const operator = hasAnd ? "AND" : "OR";
      const children = expr[operator];
      if (!Array.isArray(children) || !children.length) return makeInvalidExpression("selector", "selector." + operator + " requires a non-empty array", rawSelector, rawSelectorText);

      const childGroups = [];
      for (const child of children) {
        const result = evaluateSelectorExpression(child, root, rawSelector, rawSelectorText, false);
        if (!result.ok) return result;
        childGroups.push(result.elements);
      }

      const scoped = operator === "OR"
        ? uniqueElements(childGroups.flat())
        : buildAndContainers(childGroups);

      if (!hasFinal) return { ok: true, elements: scoped };

      const finalElements = [];
      for (const scope of scoped) {
        const result = evaluateSelectorExpression(expr.final, scope, rawSelector, rawSelectorText, false);
        if (!result.ok) return result;
        finalElements.push(...result.elements);
      }
      return { ok: true, elements: uniqueElements(finalElements), scopedCandidates: scoped.length };
    }

    const item = String(expr || "").trim();
    if (!item) return { ok: true, elements: [] };
    try {
      return { ok: true, elements: queryAllWithin(root, item) };
    } catch (error) {
      return { ok: false, code: "INVALID_SELECTOR", error: "Invalid selector: " + item + " (" + String(error?.message || error) + ")", selector: rawSelector, selectorText: rawSelectorText };
    }
  };

  const evaluateTextExpression = (expr, root, rawSelector, rawSelectorText, allowFinal) => {
    if (Array.isArray(expr)) {
      const all = [];
      const matches = [];
      for (const item of expr) {
        const result = evaluateTextExpression(item, root, rawSelector, rawSelectorText, false);
        if (!result.ok) return result;
        all.push(...result.elements);
        matches.push(...(result.matches || result.elements.map((el) => ({ el, rank: 0 }))));
      }
      return { ok: true, elements: uniqueElements(all), matches };
    }

    if (isPlainObject(expr)) {
      const hasAnd = Object.prototype.hasOwnProperty.call(expr, "AND");
      const hasOr = Object.prototype.hasOwnProperty.call(expr, "OR");
      const hasFinal = Object.prototype.hasOwnProperty.call(expr, "final");
      const known = new Set(["AND", "OR", "final"]);
      const unknown = Object.keys(expr).filter((key) => !known.has(key));
      if (unknown.length) return makeInvalidExpression("selectorText", "Unknown selectorText expression field: " + unknown.join(", "), rawSelector, rawSelectorText);
      if (hasAnd && hasOr) return makeInvalidExpression("selectorText", "selectorText expression cannot contain both AND and OR at the same level", rawSelector, rawSelectorText);
      if (hasFinal && !allowFinal) return makeInvalidExpression("selectorText", "selectorText.final is only allowed at the top level", rawSelector, rawSelectorText);
      if (!hasAnd && !hasOr) return makeInvalidExpression("selectorText", "selectorText expression requires AND or OR", rawSelector, rawSelectorText);

      const operator = hasAnd ? "AND" : "OR";
      const children = expr[operator];
      if (!Array.isArray(children) || !children.length) return makeInvalidExpression("selectorText", "selectorText." + operator + " requires a non-empty array", rawSelector, rawSelectorText);

      const childGroups = [];
      for (const child of children) {
        const result = evaluateTextExpression(child, root, rawSelector, rawSelectorText, false);
        if (!result.ok) return result;
        childGroups.push(result.elements);
      }

      const scoped = operator === "OR"
        ? uniqueElements(childGroups.flat())
        : buildAndContainers(childGroups);

      if (!hasFinal) return { ok: true, elements: scoped };

      const finalElements = [];
      for (const scope of scoped) {
        const result = evaluateTextExpression(expr.final, scope, rawSelector, rawSelectorText, false);
        if (!result.ok) return result;
        finalElements.push(...result.elements);
      }
      return { ok: true, elements: uniqueElements(finalElements), scopedCandidates: scoped.length };
    }

    const texts = normalizeTextItems(expr);
    if (!texts.length) return { ok: true, elements: [] };
    const matches = getTextMatchesWithin(root, texts);
    return { ok: true, elements: uniqueElements(matches.map((match) => match.el)), matches };
  };

  const querySelectorCandidates = (selectors, rawSelector, rawSelectorText) => {
    const all = [];
    for (const item of selectors) {
      try {
        all.push(...Array.from(document.querySelectorAll(item)));
      } catch (error) {
        return { ok: false, code: "INVALID_SELECTOR", error: "Invalid selector: " + item + " (" + String(error?.message || error) + ")", selector: rawSelector, selectorText: rawSelectorText };
      }
    }
    return { ok: true, elements: uniqueElements(all) };
  };

  const pickSmallestTextMatch = (matches) => {
    const nonRootMatches = matches.filter((match) => !isRootContainer(match.el));
    const pool = nonRootMatches.length ? nonRootMatches : matches;
    const elements = pool.map((match) => match.el);
    const candidateSet = new Set(elements);
    const rankByElement = new Map(pool.map((match) => [match.el, match.rank]));
    const ranked = pool.map((match, index) => {
      const el = match.el;
      let containsOtherMatch = false;
      for (const other of candidateSet) {
        if (other !== el && rankByElement.get(other) === match.rank && el.contains(other)) {
          containsOtherMatch = true;
          break;
        }
      }
      return {
        el,
        index,
        matchRank: match.rank,
        leafRank: containsOtherMatch ? 1 : 0,
        area: getVisibleArea(el),
        depthRank: -getDepth(el),
      };
    });

    ranked.sort((a, b) =>
      a.matchRank - b.matchRank ||
      a.leafRank - b.leafRank ||
      a.area - b.area ||
      a.depthRank - b.depthRank ||
      a.index - b.index
    );
    return ranked[0]?.el || null;
  };

  const pickElement = ({ selector, selectorText }) => {
    const hasSelector = isExpressionValue(selector);
    const hasSelectorText = isExpressionValue(selectorText);
    if (!hasSelector && !hasSelectorText) {
      return { ok: false, code: "MISSING_TARGET", error: "Missing msg.selector or msg.selectorText", selector, selectorText };
    }

    if (hasSelector) {
      const queried = evaluateSelectorExpression(selector, document, selector, selectorText, true);
      if (!queried.ok) return queried;

      const all = queried.elements;
      if (!all.length) {
        return { ok: false, code: "NOT_FOUND", error: "No elements matched selector", selector, selectorText };
      }

      if (!hasSelectorText) {
        return { ok: true, el: all[0], candidates: all.length };
      }

      if (!isPlainObject(selectorText)) {
        const selectorTexts = normalizeTextItems(selectorText);
        const matched = all.map((node) => getTextMatch(node, selectorTexts)).filter(Boolean);
        if (!matched.length) {
          return { ok: false, code: "NOT_FOUND_TEXT", error: "No elements matched selectorText within selector results", selector, selectorText, candidates: all.length };
        }

        const el = pickSmallestTextMatch(matched);
        return { ok: true, el, candidates: all.length, textCandidates: matched.length };
      }

      const textMatchedElements = [];
      const filtered = [];
      for (const scope of all) {
        const result = evaluateTextExpression(selectorText, scope, selector, selectorText, true);
        if (!result.ok) return result;
        if (result.elements.length) {
          filtered.push(scope);
          textMatchedElements.push(...result.elements);
        }
      }

      if (!filtered.length) {
        return { ok: false, code: "NOT_FOUND_TEXT", error: "No elements matched selectorText within selector results", selector, selectorText, candidates: all.length };
      }

      return { ok: true, el: filtered[0], candidates: all.length, textCandidates: uniqueElements(textMatchedElements).length };
    }

    const textResult = isPlainObject(selectorText)
      ? evaluateTextExpression(selectorText, document, selector, selectorText, true)
      : evaluateTextExpression(selectorText, document, selector, selectorText, false);
    if (!textResult.ok) return textResult;

    const allTextMatches = textResult.matches || uniqueElements(textResult.elements).map((node) => ({ el: node, rank: 0 }));

    if (!allTextMatches.length) {
      return { ok: false, code: "NOT_FOUND_TEXT", error: "No elements matched selectorText", selector, selectorText, candidates: 0 };
    }

    const el = pickSmallestTextMatch(allTextMatches);
    if (!el) {
      return { ok: false, code: "NOT_FOUND_TEXT", error: "No elements matched selectorText", selector, selectorText, candidates: allTextMatches.length };
    }

    return { ok: true, el, candidates: allTextMatches.length, textCandidates: allTextMatches.length };
  };
`;

function hasElementTarget(selector, selectorText) {
  const hasValue = (value) => {
    if (Array.isArray(value)) return value.some(hasValue);
    if (value && typeof value === "object") return Object.keys(value).length > 0;
    return String(value ?? "").trim() !== "";
  };
  return hasValue(selector) || hasValue(selectorText);
}

function normalizeElementTargetPayload(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") return value;
  return value || "";
}

function buildFindAndActExpression({ action, selector, selectorText, value, afterFoundMs }) {
  const payload = {
    action,
    selector: normalizeElementTargetPayload(selector),
    selectorText: normalizeElementTargetPayload(selectorText),
    value: value ?? "",
    afterFoundMs: Number.isFinite(afterFoundMs) ? Math.max(0, afterFoundMs) : 0,
  };
  const injected = JSON.stringify(payload);

  return `
(async () => {
  const { action, selector, selectorText, value, afterFoundMs } = ${injected};
  ${ELEMENT_FINDER_HELPER}
  const pick = () => pickElement({ selector, selectorText });

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
    selector: normalizeElementTargetPayload(selector),
    selectorText: normalizeElementTargetPayload(selectorText),
    afterFoundMs: Number.isFinite(afterFoundMs) ? Math.max(0, afterFoundMs) : 0,
  };
  const injected = JSON.stringify(payload);

  return `
(async () => {
  const { selector, selectorText, afterFoundMs } = ${injected};
  ${ELEMENT_FINDER_HELPER}
  const pick = () => pickElement({ selector, selectorText });

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

function normalizeMoveMouseCircleOptions(msg) {
  const durationMs = msg?.durationMs == null ? 1200 : msg.durationMs;
  if (!Number.isFinite(durationMs) || durationMs <= 0 || durationMs > 60000) {
    throw new Error("moveMouseCircle durationMs must be a finite positive number <= 60000.");
  }

  const revolutions = msg?.revolutions == null ? 1 : msg.revolutions;
  if (!Number.isFinite(revolutions) || revolutions <= 0 || revolutions > 20) {
    throw new Error("moveMouseCircle revolutions must be a finite positive number <= 20.");
  }

  const defaultSteps = Math.max(72, Math.ceil(durationMs / 12), Math.ceil(revolutions * 72));
  const steps = msg?.steps == null ? defaultSteps : msg.steps;
  if (!Number.isInteger(steps) || steps < 12 || steps > 5000) {
    throw new Error("moveMouseCircle steps must be an integer between 12 and 5000.");
  }

  const jitterPx = msg?.jitterPx == null ? 1.25 : msg.jitterPx;
  if (!Number.isFinite(jitterPx) || jitterPx < 0) {
    throw new Error("moveMouseCircle jitterPx must be a finite non-negative number.");
  }

  const clockwise = msg?.clockwise == null ? true : msg.clockwise;
  if (typeof clockwise !== "boolean") {
    throw new Error("moveMouseCircle clockwise must be a boolean when provided.");
  }

  const startAngleDeg = msg?.startAngleDeg == null ? -90 : msg.startAngleDeg;
  if (!Number.isFinite(startAngleDeg)) {
    throw new Error("moveMouseCircle startAngleDeg must be a finite number.");
  }

  return { durationMs, steps, jitterPx, revolutions, clockwise, startAngleDeg };
}

async function getViewportMetricsViaDebugger(tabId) {
  const metrics = await runInPageViaDebugger(
    tabId,
    `(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio,
      scrollX: window.scrollX,
      scrollY: window.scrollY
    }))()`
  );

  if (!metrics || !Number.isFinite(metrics.width) || !Number.isFinite(metrics.height) || metrics.width <= 0 || metrics.height <= 0) {
    throw new Error("moveMouseCircle failed to read a valid viewport size.");
  }

  return metrics;
}

function clampNumber(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function buildMoveMouseCirclePoints(viewport, options) {
  const { durationMs, steps, jitterPx, revolutions, clockwise, startAngleDeg } = options;
  const width = viewport.width;
  const height = viewport.height;
  const maxX = Math.max(0, width - 0.01);
  const maxY = Math.max(0, height - 0.01);
  const center = { x: width / 2, y: height / 2 };
  const radius = Math.min(width, height) * 0.45;
  const marginX = Math.max(0, center.x - radius);
  const marginY = Math.max(0, center.y - radius);
  const safeJitterPx = Math.min(jitterPx, Math.max(0, Math.min(marginX, marginY)));
  const direction = clockwise ? 1 : -1;
  const startAngleRad = (startAngleDeg * Math.PI) / 180;
  const points = [];
  const intervals = [];
  let totalWeight = 0;

  for (let i = 0; i < steps - 1; i += 1) {
    const progress = i / Math.max(1, steps - 2);
    const weight = Math.max(0.35, 1 + 0.22 * Math.sin(progress * Math.PI * 2.7 + 0.8) + (Math.random() - 0.5) * 0.18);
    intervals.push(weight);
    totalWeight += weight;
  }

  for (let i = 0; i < steps; i += 1) {
    const progress = steps === 1 ? 1 : i / (steps - 1);
    const angle = startAngleRad + direction * progress * Math.PI * 2 * revolutions;
    const radialJitter = safeJitterPx > 0 ? (Math.random() - 0.5) * safeJitterPx : 0;
    const tangentialJitter = safeJitterPx > 0 ? (Math.random() - 0.5) * safeJitterPx * 0.7 : 0;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const rawX = center.x + (radius + radialJitter) * cos - tangentialJitter * sin;
    const rawY = center.y + (radius + radialJitter) * sin + tangentialJitter * cos;

    points.push({
      x: clampNumber(rawX, 0, maxX),
      y: clampNumber(rawY, 0, maxY),
    });
  }

  return {
    center,
    radius,
    requestedJitterPx: jitterPx,
    jitterPx: safeJitterPx,
    points,
    intervalsMs: intervals.map((weight) => (durationMs * weight) / totalWeight),
  };
}

async function moveMouseCircleViaDebugger(tabId, msg) {
  const options = normalizeMoveMouseCircleOptions(msg || {});
  const viewport = await getViewportMetricsViaDebugger(tabId);
  const trajectory = buildMoveMouseCirclePoints(viewport, options);
  const startedAt = Date.now();

  for (let i = 0; i < trajectory.points.length; i += 1) {
    const point = trajectory.points[i];
    await dispatchMouseEvent(tabId, {
      type: "mouseMoved",
      x: point.x,
      y: point.y,
      button: "none",
      buttons: 0,
      timestamp: Date.now() / 1000,
    });

    if (i < trajectory.intervalsMs.length) {
      await sleep(trajectory.intervalsMs[i]);
    }
  }

  const elapsedMs = Date.now() - startedAt;
  return {
    center: trajectory.center,
    radius: trajectory.radius,
    points: trajectory.points.length,
    elapsedMs,
    durationMs: options.durationMs,
    steps: options.steps,
    revolutions: options.revolutions,
    clockwise: options.clockwise,
    startAngleDeg: options.startAngleDeg,
    jitterPx: trajectory.jitterPx,
    requestedJitterPx: trajectory.requestedJitterPx,
    viewport,
  };
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
  const chars = Array.from(String(text ?? ""));

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
  if (!hasElementTarget(selector, selectorText)) throw new Error("Missing msg.selector or msg.selectorText");

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

function buildWaitForElementExpression({ selector, selectorText, intervalMs = 200, timeoutMs = 30000 }) {
  const payload = {
    selector: normalizeElementTargetPayload(selector),
    selectorText: normalizeElementTargetPayload(selectorText),
    intervalMs: Number.isFinite(intervalMs) ? intervalMs : 200,
    timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : 30000,
  };
  const injected = JSON.stringify(payload);

  return `
(async () => {
  const { selector, selectorText, intervalMs, timeoutMs } = ${injected};
  ${ELEMENT_FINDER_HELPER}
  const retryableCodes = new Set(["NOT_FOUND", "NOT_FOUND_TEXT"]);
  const hasTimeout = timeoutMs >= 0;
  const startedAt = Date.now();
  let attempts = 0;
  let lastRetryable = null;

  const formatResult = (picked, extra = {}) => {
    if (picked?.ok) {
      return {
        ok: true,
        attempts,
        candidates: picked.candidates ?? 1,
        textCandidates: picked.textCandidates,
        ...extra,
      };
    }
    return {
      ok: false,
      attempts,
      error: String(picked?.error || "waitForElement failed"),
      code: picked?.code,
      selector: picked?.selector,
      selectorText: picked?.selectorText,
      candidates: picked?.candidates,
      textCandidates: picked?.textCandidates,
      ...extra,
    };
  };

  const checkOnce = () => {
    attempts += 1;
    const picked = pickElement({ selector, selectorText });
    if (picked?.ok || !retryableCodes.has(picked?.code)) return formatResult(picked);
    lastRetryable = picked;

    if (hasTimeout && Date.now() - startedAt >= timeoutMs) {
      return formatResult(picked, { timeout: true, timeoutMs, intervalMs });
    }

    return null;
  };

  const initial = checkOnce();
  if (initial) return initial;

  const hasMutationObserver = typeof MutationObserver === "function";
  if (!hasTimeout && !hasMutationObserver && intervalMs <= 0) {
    return formatResult(lastRetryable || { ok: false, code: "NOT_FOUND", error: "No elements matched selector", selector, selectorText }, {
      code: "UNSUPPORTED_WAIT_CONFIGURATION",
      error: "waitForElement requires MutationObserver or positive intervalMs when timeoutMs is negative",
      timeoutMs,
      intervalMs,
    });
  }

  return await new Promise((resolve) => {
    let done = false;
    let observer = null;
    let intervalId = null;
    let timeoutId = null;

    const cleanup = () => {
      if (observer) observer.disconnect();
      if (intervalId !== null) clearInterval(intervalId);
      if (timeoutId !== null) clearTimeout(timeoutId);
    };

    const finish = (result) => {
      if (done) return;
      done = true;
      cleanup();
      resolve(result);
    };

    const checkAndMaybeFinish = () => {
      const result = checkOnce();
      if (result) finish(result);
    };

    const finishTimeout = () => {
      if (done) return;
      finish(formatResult(lastRetryable || { ok: false, code: "NOT_FOUND", error: "No elements matched selector", selector, selectorText }, { timeout: true, timeoutMs, intervalMs }));
    };

    if (hasMutationObserver) {
      observer = new MutationObserver(() => checkAndMaybeFinish());
      observer.observe(document.documentElement || document, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
      });
    }

    if (intervalMs > 0) {
      intervalId = setInterval(checkAndMaybeFinish, intervalMs);
    }

    if (hasTimeout) {
      const remaining = Math.max(0, timeoutMs - (Date.now() - startedAt));
      timeoutId = setTimeout(finishTimeout, remaining);
    }
  });
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

function normalizeSiteDataDomain(rawDomain) {
  const value = String(rawDomain || "").trim().toLowerCase().replace(/^\.+|\.+$/g, "");
  if (!value) {
    throw new Error("clearSiteData domain must be a non-empty domain name.");
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value) || /[/?#:@\s\\]/.test(value)) {
    throw new Error("clearSiteData domain must be a bare domain name without protocol, path, port, or credentials: " + rawDomain);
  }

  const labels = value.split(".");
  if (labels.length < 2) {
    throw new Error("clearSiteData domain must not be a single-label public suffix: " + rawDomain);
  }

  for (const label of labels) {
    if (!label || label.length > 63 || !/^[a-z0-9-]+$/.test(label) || label.startsWith("-") || label.endsWith("-")) {
      throw new Error("clearSiteData domain is invalid: " + rawDomain);
    }
  }

  return value;
}

function normalizeSiteDataDomains(msg) {
  const rawDomains = Object.prototype.hasOwnProperty.call(msg || {}, "domains") ? msg.domains : msg?.domain;
  const values = Array.isArray(rawDomains) ? rawDomains : [rawDomains];
  if (!values.length || values.some((item) => typeof item !== "string" || item.trim() === "")) {
    throw new Error("clearSiteData requires msg.domain or msg.domains as a non-empty domain string or string array.");
  }

  return Array.from(new Set(values.map(normalizeSiteDataDomain)));
}

function getClearSiteDataProfileScope(sender) {
  const senderTab = sender?.tab;
  const senderIncognito = typeof senderTab?.incognito === "boolean" ? senderTab.incognito : null;
  if (senderIncognito === null) {
    throw new Error("clearSiteData requires a sender tab with an incognito profile flag.");
  }

  return {
    senderTabId: Number.isInteger(senderTab?.id) ? senderTab.id : null,
    senderWindowId: Number.isInteger(senderTab?.windowId) ? senderTab.windowId : null,
    senderIncognito,
    tabFilteringApplied: true,
  };
}

function siteDomainMatches(host, domain) {
  const normalizedHost = normalizeCookieDomain(host).toLowerCase();
  const normalizedDomain = normalizeSiteDataDomain(domain);
  return normalizedHost === normalizedDomain || normalizedHost.endsWith("." + normalizedDomain);
}

function addHttpAndHttpsOrigins(origins, host) {
  const normalizedHost = normalizeCookieDomain(host).toLowerCase();
  if (!normalizedHost) return;
  origins.add("http://" + normalizedHost);
  origins.add("https://" + normalizedHost);
}

function queryTabs(queryInfo) {
  return new Promise((resolve, reject) => {
    chrome.tabs.query(queryInfo, (tabs) => {
      const err = chrome.runtime?.lastError;
      if (err) {
        reject(new Error(err.message || String(err)));
        return;
      }

      resolve(Array.isArray(tabs) ? tabs : []);
    });
  });
}

function reloadTab(tabId, reloadProperties) {
  return new Promise((resolve, reject) => {
    chrome.tabs.reload(tabId, reloadProperties, () => {
      const err = chrome.runtime?.lastError;
      if (err) {
        reject(new Error(err.message || String(err)));
        return;
      }

      resolve(true);
    });
  });
}

function detachDebugger(tabId) {
  return new Promise((resolve, reject) => {
    chrome.debugger.detach(attachTarget(tabId), () => {
      const err = chrome.runtime?.lastError;
      if (err) {
        reject(new Error(err.message || String(err)));
        return;
      }

      attachedTabs.delete(tabId);
      pageEnabledTabs.delete(tabId);
      resolve(true);
    });
  });
}

async function ensureDebuggerAttachedForSiteData(tabId, temporaryAttachedTabs) {
  const alreadyAttached = attachedTabs.has(tabId);
  await ensureDebuggerAttached(tabId);
  if (!alreadyAttached) {
    temporaryAttachedTabs.add(tabId);
  }
}

async function detachTemporarySiteDataDebuggers(temporaryAttachedTabs) {
  const detached = [];
  const failures = [];
  for (const tabId of temporaryAttachedTabs) {
    try {
      await detachDebugger(tabId);
      detached.push(tabId);
    } catch (error) {
      failures.push({ tabId, error: String(error?.message || error) });
    }
  }

  return { detached, failures };
}

async function collectMatchingSiteDataTabs(domains, profileScope) {
  const tabs = await queryTabs({});
  const matchingTabs = [];
  const seenTabIds = new Set();
  const filterIncognito = profileScope?.senderIncognito;

  for (const tab of tabs) {
    if (!Number.isInteger(tab?.id) || seenTabIds.has(tab.id)) continue;
    if (typeof filterIncognito === "boolean" && tab.incognito !== filterIncognito) continue;
    if (typeof tab.url !== "string" || tab.url.trim() === "") continue;

    let url;
    try {
      url = new URL(tab.url);
    } catch (error) {
      continue;
    }

    if (url.protocol !== "http:" && url.protocol !== "https:") continue;
    const host = url.hostname.toLowerCase();
    if (!domains.some((domain) => siteDomainMatches(host, domain))) continue;

    seenTabIds.add(tab.id);
    matchingTabs.push({
      tabId: tab.id,
      url: url.href,
      origin: url.origin,
      incognito: tab.incognito === true,
    });
  }

  return matchingTabs;
}

async function clearPageStorageForTabs(matchingTabs, temporaryAttachedTabs) {
  const storageCleared = [];
  const storageFailures = [];
  const expression = `(() => {
    const result = { ok: true, sessionStorage: false, localStorage: false, failures: [] };
    try {
      if (typeof sessionStorage !== "undefined") {
        sessionStorage.clear();
        result.sessionStorage = true;
      }
    } catch (error) {
      result.failures.push({ storage: "sessionStorage", error: String(error?.message || error) });
    }

    try {
      if (typeof localStorage !== "undefined") {
        localStorage.clear();
        result.localStorage = true;
      }
    } catch (error) {
      result.failures.push({ storage: "localStorage", error: String(error?.message || error) });
    }

    result.ok = result.failures.length === 0;
    return result;
  })()`;

  for (const item of matchingTabs) {
    try {
      await ensureDebuggerAttachedForSiteData(item.tabId, temporaryAttachedTabs);
      const result = await runInPageViaDebugger(item.tabId, expression);
      const entry = { ...item, result };
      if (result?.ok) {
        storageCleared.push(entry);
      } else {
        storageFailures.push({ ...entry, error: result?.failures?.length ? "Page storage clear reported failures." : "Page storage clear did not return ok." });
      }
    } catch (error) {
      storageFailures.push({ ...item, error: String(error?.message || error) });
    }
  }

  return { storageCleared, storageFailures };
}

async function clearOriginStorageViaDebugger(originList, matchingTabs, temporaryAttachedTabs) {
  const cleared = [];
  const failures = [];
  const driverTab = matchingTabs.find((item) => Number.isInteger(item.tabId));

  if (!driverTab) {
    return {
      attempted: 0,
      skipped: true,
      driverTabId: null,
      driverIncognito: null,
      reason: "No matching http/https tab is available for Chrome DevTools Protocol Storage.clearDataForOrigin.",
      cleared,
      failures,
    };
  }

  try {
    await ensureDebuggerAttachedForSiteData(driverTab.tabId, temporaryAttachedTabs);
  } catch (error) {
    return {
      attempted: 0,
      driverTabId: driverTab.tabId,
      driverIncognito: typeof driverTab.incognito === "boolean" ? driverTab.incognito : null,
      cleared,
      failures: originList.map((origin) => ({ origin, tabId: driverTab.tabId, error: String(error?.message || error) })),
    };
  }

  for (const origin of originList) {
    try {
      await chrome.debugger.sendCommand(attachTarget(driverTab.tabId), "Storage.clearDataForOrigin", {
        origin,
        storageTypes: "all",
      });
      cleared.push({ origin, tabId: driverTab.tabId });
    } catch (error) {
      failures.push({ origin, tabId: driverTab.tabId, error: String(error?.message || error) });
    }
  }

  return {
    attempted: originList.length,
    driverTabId: driverTab.tabId,
    driverIncognito: typeof driverTab.incognito === "boolean" ? driverTab.incognito : null,
    cleared,
    failures,
  };
}

async function reloadSiteDataTabs(matchingTabs) {
  const reloaded = [];
  const reloadFailures = [];

  for (const item of matchingTabs) {
    try {
      await reloadTab(item.tabId, { bypassCache: true });
      reloaded.push(item);
    } catch (error) {
      reloadFailures.push({ ...item, error: String(error?.message || error) });
    }
  }

  return { reloaded, reloadFailures };
}

function removeSiteDataBrowsingData(options, dataToRemove) {
  return new Promise((resolve, reject) => {
    chrome.browsingData.remove(options, dataToRemove, () => {
      const err = chrome.runtime?.lastError;
      if (err) {
        reject(new Error(err.message || String(err)));
        return;
      }

      resolve(true);
    });
  });
}

async function collectSiteDataCookies(domains, storeId) {
  const cookieGroups = await Promise.all(
    domains.map((domain) => {
      const query = { domain };
      if (storeId) query.storeId = storeId;
      return getCookies(query);
    })
  );

  return dedupeCookies(cookieGroups.flat()).filter((cookie) => {
    const host = normalizeCookieDomain(cookie.domain);
    return domains.some((domain) => siteDomainMatches(host, domain));
  });
}

async function removeSiteDataCookies(cookies) {
  const removed = [];
  const failures = [];

  for (const cookie of cookies) {
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

      removed.push({ ...summarizeCookie(cookie), details: removeDetails });
    } catch (error) {
      failures.push({ cookie: summarizeCookie(cookie), details: removeDetails, error: String(error?.message || error) });
    }
  }

  return { removed, failures };
}

async function clearSiteData(msg, sender) {
  const profileScope = getClearSiteDataProfileScope(sender);
  const domains = normalizeSiteDataDomains(msg || {});
  if (Object.prototype.hasOwnProperty.call(msg || {}, "storeId") && (typeof msg.storeId !== "string" || msg.storeId.trim() === "")) {
    throw new Error("clearSiteData storeId must be a non-empty string when provided.");
  }

  const storeId = typeof msg?.storeId === "string" ? msg.storeId.trim() : undefined;
  const reloadTabs = msg?.reloadTabs !== false;
  const clearSessionStorage = msg?.clearSessionStorage !== false;
  const temporaryAttachedTabs = new Set();
  const discoveredHosts = new Set();
  const origins = new Set();
  const originSources = [];
  const dataTypes = ["cache", "cacheStorage", "cookies", "fileSystems", "indexedDB", "localStorage", "serviceWorkers", "webSQL"];

  for (const domain of domains) {
    discoveredHosts.add(domain);
    addHttpAndHttpsOrigins(origins, domain);
    originSources.push({ source: "domain", domain, origins: ["http://" + domain, "https://" + domain] });
  }

  const discoveryCookies = await collectSiteDataCookies(domains, storeId);
  for (const cookie of discoveryCookies) {
    const host = normalizeCookieDomain(cookie.domain).toLowerCase();
    if (host && domains.some((domain) => siteDomainMatches(host, domain))) {
      discoveredHosts.add(host);
      addHttpAndHttpsOrigins(origins, host);
      originSources.push({ source: "cookie", host, origins: ["http://" + host, "https://" + host], cookie: summarizeCookie(cookie) });
    }
  }

  const matchingTabs = await collectMatchingSiteDataTabs(domains, profileScope);
  for (const item of matchingTabs) {
    let host = "";
    try {
      host = new URL(item.url).hostname.toLowerCase();
    } catch (error) {
      host = "";
    }
    if (host) discoveredHosts.add(host);
    origins.add(item.origin);
    originSources.push({ source: "tab", tabId: item.tabId, url: item.url, origin: item.origin, incognito: item.incognito });
  }

  const pageStorage = clearSessionStorage
    ? await clearPageStorageForTabs(matchingTabs, temporaryAttachedTabs)
    : { storageCleared: [], storageFailures: [] };

  const originList = Array.from(origins).sort();
  const debuggerStorage = await clearOriginStorageViaDebugger(originList, matchingTabs, temporaryAttachedTabs);
  const browsingData = {
    ok: true,
    error: null,
    dataTypes,
  };

  try {
    await removeSiteDataBrowsingData(
      {
        origins: originList,
        originTypes: { unprotectedWeb: true },
      },
      {
        cache: true,
        cacheStorage: true,
        cookies: true,
        fileSystems: true,
        indexedDB: true,
        localStorage: true,
        serviceWorkers: true,
        webSQL: true,
      }
    );
  } catch (error) {
    browsingData.ok = false;
    browsingData.error = String(error?.message || error);
  }

  const remainingCookies = await collectSiteDataCookies(domains, storeId);
  const cookieRemoval = await removeSiteDataCookies(remainingCookies);
  const tabReload = reloadTabs
    ? await reloadSiteDataTabs(matchingTabs)
    : { reloaded: [], reloadFailures: [] };
  const debuggerDetach = await detachTemporarySiteDataDebuggers(temporaryAttachedTabs);

  return {
    ok: browsingData.ok && cookieRemoval.failures.length === 0,
    domains,
    discoveredHosts: Array.from(discoveredHosts).sort(),
    origins: originList,
    originSources,
    browsingData,
    debuggerStorage: {
      attempted: debuggerStorage.attempted,
      skipped: debuggerStorage.skipped === true,
      driverTabId: Number.isInteger(debuggerStorage.driverTabId) ? debuggerStorage.driverTabId : null,
      driverIncognito: typeof debuggerStorage.driverIncognito === "boolean" ? debuggerStorage.driverIncognito : null,
      reason: debuggerStorage.reason || null,
      cleared: debuggerStorage.cleared.length,
      failures: debuggerStorage.failures,
    },
    cookies: {
      matched: remainingCookies.length,
      removed: cookieRemoval.removed.length,
      failed: cookieRemoval.failures.length,
      cookies: cookieRemoval.removed,
      failures: cookieRemoval.failures,
    },
    tabs: {
      matched: matchingTabs.length,
      reloaded: tabReload.reloaded.length,
      reloadFailures: tabReload.reloadFailures,
      storageCleared: pageStorage.storageCleared.length,
      storageFailures: pageStorage.storageFailures,
      debuggerDetached: debuggerDetach.detached,
      debuggerDetachFailures: debuggerDetach.failures,
      items: matchingTabs,
    },
    limitations: [
      "Cookie domains and currently open tabs are used to discover subdomains. Unknown subdomains without matching cookies or open tabs cannot be enumerated by Chrome extension APIs.",
      "Only http and https origins derived from the input domains, discovered cookie domains, and matching open tab URL origins are cleared.",
      "Chrome extension APIs do not guarantee clearing HSTS, site permissions, media licenses, Shared Storage, Interest Groups, Storage Buckets, or other browser-internal site data. When a matching tab exists, Chrome DevTools Protocol Storage.clearDataForOrigin is also attempted as an extra best-effort cleanup layer.",
    ],
    diagnostic: {
      manifestIncognito: "split",
      senderProfile: {
        senderTabId: profileScope.senderTabId,
        senderWindowId: profileScope.senderWindowId,
        senderIncognito: profileScope.senderIncognito,
      },
      tabProfileFilter: {
        applied: profileScope.tabFilteringApplied,
        incognito: profileScope.senderIncognito,
      },
      requestedOptions: {
        domains,
        storeId: storeId || null,
        reloadTabs,
        clearSessionStorage,
      },
    },
  };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    const action = msg?.action || msg?.type;
    if (!action) throw new Error("Missing msg.action or msg.type");

    if (action === "fetch") {
      const result = await handleFetchAction(msg || {});
      sendResponse(result);
      return;
    }

    if (action === "newEvent") {
      const result = await broadcastDebugEvent(msg || {});
      sendResponse(result);
      return;
    }

    if (action === "listenEvent") {
      const result = registerEventListener(msg || {}, sender, false);
      sendResponse(result);
      return;
    }

    if (action === "awaitEvent") {
      const result = registerEventListener(msg || {}, sender, true);
      sendResponse(result);
      return;
    }

    if (EVENT_REMOVE_ACTIONS.has(action)) {
      const result = removeEventListenerRegistration(msg || {});
      sendResponse(result);
      return;
    }

    const needsTab =
      action === "waitNetworkIdle" ||
      action === "openTab" ||
      action === "waitForElement" ||
      action === "waitUrlMatch" ||
      action === "click" ||
      action === "clickElementCoordinates" ||
      action === "getElementCoordinates" ||
      action === "clickCoordinates" ||
      action === "moveMouseCircle" ||
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

    if (action === "clearSiteData") {
      const result = await clearSiteData(msg || {}, sender);
      sendResponse(result);
      return;
    }

    if (action === "openTab") {
      const result = await openTabViaDebugger(tabId, msg || {});
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
      if (!hasElementTarget(selector, selectorText)) throw new Error("Missing msg.selector or msg.selectorText");

      const intervalMs = Number.isFinite(msg.intervalMs) ? msg.intervalMs : 200;
      const timeoutMs = Number.isFinite(msg.timeoutMs) ? msg.timeoutMs : 30000;

      await ensureDebuggerAttached(tabId);

      const expression = buildWaitForElementExpression({ selector, selectorText, intervalMs, timeoutMs });
      const result = await runInPageViaDebugger(tabId, expression);

      if (!result?.ok) {
        sendResponse({
          ok: false,
          tabId,
          error: String(result?.error || "waitForElement failed"),
          timeout: Boolean(result?.timeout),
          attempts: result?.attempts ?? 0,
          code: result?.code,
          candidates: result?.candidates,
          textCandidates: result?.textCandidates,
        });
        return;
      }

      sendResponse({ ok: true, tabId, attempts: result.attempts ?? 1, candidates: result?.candidates ?? 0, textCandidates: result?.textCandidates });
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
      const shouldFocusSelector = hasElementTarget(selector, selectorText);

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
      const shouldFocusSelector = hasElementTarget(selector, selectorText);

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

    if (action === "moveMouseCircle") {
      await ensureDebuggerAttached(tabId);

      const result = await moveMouseCircleViaDebugger(tabId, msg || {});
      sendResponse({ ok: true, tabId, ...result });
      return;
    }

    // click / input (保持兼容你的现有调用)
    const { selector, selectorText, value } = msg || {};
    if (!hasElementTarget(selector, selectorText)) throw new Error("Missing msg.selector or msg.selectorText");

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
