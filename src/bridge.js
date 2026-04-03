(() => {

  if (window.__ApliNiBrowserDebuggingExtension_CONTENT_BRIDGE_INSTALLED__) {
    return;
  }
  window.__ApliNiBrowserDebuggingExtension_CONTENT_BRIDGE_INSTALLED__ = true;

  const STORAGE_KEY = "apliNiBrowserDebuggingExtensionToken";
  const bridgeTarget = document;
  let activeToken = "";
  let activeListener = null;

  function generateToken() {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (item) => item.toString(16).padStart(2, "0")).join("");
  }

  function storageGetToken() {
    return new Promise((resolve, reject) => {
      chrome.storage.local.get(STORAGE_KEY, (items) => {
        const err = chrome.runtime?.lastError;
        if (err) {
          reject(new Error(err.message || String(err)));
          return;
        }

        const token = typeof items?.[STORAGE_KEY] === "string" ? items[STORAGE_KEY].trim() : "";
        resolve(token || "");
      });
    });
  }

  function storageSetToken(token) {
    return new Promise((resolve, reject) => {
      chrome.storage.local.set({ [STORAGE_KEY]: token }, () => {
        const err = chrome.runtime?.lastError;
        if (err) {
          reject(new Error(err.message || String(err)));
          return;
        }

        resolve(true);
      });
    });
  }

  function emitResponse(token, requestId, ok, result, error) {
    bridgeTarget.dispatchEvent(new CustomEvent(token, {
      detail: {
        kind: "response",
        requestId,
        ok,
        result,
        error,
      },
    }));
  }

  function emitHandshakeResponse(token, requestId, ok, error) {
    bridgeTarget.dispatchEvent(new CustomEvent(token, {
      detail: {
        kind: "handshake-response",
        requestId,
        ok,
        error,
      },
    }));
  }

  function bindBridgeListener(token) {
    if (!token || token === activeToken) {
      return;
    }

    if (activeListener && activeToken) {
      bridgeTarget.removeEventListener(activeToken, activeListener);
    }

    activeToken = token;
    activeListener = (event) => {
      const { kind, requestId, payload } = event.detail || {};
      if (!requestId) {
        return;
      }

      if (kind === "handshake-request") {
        emitHandshakeResponse(token, requestId, true);
        return;
      }

      if (kind !== "request") {
        return;
      }

      chrome.runtime.sendMessage(payload).then(
        (result) => {
          emitResponse(token, requestId, true, result);
        },
        (error) => {
          emitResponse(token, requestId, false, null, String(error?.message || error || "Unknown error"));
        }
      );
    };

    bridgeTarget.addEventListener(token, activeListener);
  }

  async function ensureToken() {
    let token = await storageGetToken();
    if (!token) {
      token = generateToken();
      await storageSetToken(token);
    }

    bindBridgeListener(token);
    return token;
  }

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local" || !changes[STORAGE_KEY]) {
      return;
    }

    const nextValue = typeof changes[STORAGE_KEY].newValue === "string" ? changes[STORAGE_KEY].newValue.trim() : "";
    if (nextValue) {
      bindBridgeListener(nextValue);
      return;
    }

    ensureToken().catch((error) => {
      console.error("Failed to regenerate bridge token", error);
    });
  });

  ensureToken().catch((error) => {
    console.error("Failed to initialize bridge token", error);
  });
})();
