(() => {

  const bridgeTarget = document;
  const nativeAddEventListener = EventTarget.prototype.addEventListener;
  const nativeDispatchEvent = EventTarget.prototype.dispatchEvent;
  const NativeCustomEvent = CustomEvent;
  const nativeSetTimeout = window.setTimeout;
  const nativeClearTimeout = window.clearTimeout;

  if (window.ApliNiBrowserDebuggingExtension) {
    return;
  }

  let seq = 0;
  const pending = new Map();
  const listeningTokens = new Set();
  const readySenders = new Map();

  function ensureTokenListener(token) {
    if (listeningTokens.has(token)) {
      return;
    }

    nativeAddEventListener.call(bridgeTarget, token, (event) => {
      const { kind, requestId, ok, result, error } = event.detail || {};
      if (!requestId) {
        return;
      }

      const task = pending.get(requestId);
      if (!task || task.token !== token || task.kind !== kind) {
        return;
      }

      pending.delete(requestId);
      nativeClearTimeout.call(window, task.timer);

      if (ok) {
        task.resolve(kind === "response" ? result : true);
        return;
      }

      task.reject(new Error(error || "Bridge request failed"));
    });

    listeningTokens.add(token);
  }

  function sendHandshake(token, timeoutMs) {
    ensureTokenListener(token);

    const requestId = "hs_" + Date.now() + "_" + (++seq);

    return new Promise((resolve, reject) => {
      const timer = nativeSetTimeout.call(window, () => {
        pending.delete(requestId);
        reject(new Error("Bridge access token mismatch"));
      }, timeoutMs);

      pending.set(requestId, {
        resolve,
        reject,
        timer,
        token,
        kind: "handshake-response",
      });

      nativeDispatchEvent.call(
        bridgeTarget,
        new NativeCustomEvent(token, {
          detail: {
            kind: "handshake-request",
            requestId,
          },
        })
      );
    });
  }

  function createSend(token) {
    return (payload) => {
      const timeoutMs = (Number.isFinite(payload?.timeoutMs) ? payload.timeoutMs : 30000) + 5000;
      let messagePayload = payload;

      if (payload?.action === "waitUrlMatch" && payload.pattern instanceof RegExp) {
        messagePayload = {
          ...payload,
          pattern: payload.pattern.source,
          flags: payload.flags ?? payload.pattern.flags,
        };
      }

      const requestId = "req_" + Date.now() + "_" + (++seq);

      return new Promise((resolve, reject) => {
        ensureTokenListener(token);

        const timer = nativeSetTimeout.call(window, () => {
          pending.delete(requestId);
          reject(new Error("Bridge request timeout after " + timeoutMs + "ms"));
        }, timeoutMs);

        pending.set(requestId, {
          resolve,
          reject,
          timer,
          token,
          kind: "response",
        });

        nativeDispatchEvent.call(
          bridgeTarget,
          new NativeCustomEvent(token, {
            detail: {
              kind: "request",
              requestId,
              payload: messagePayload,
            },
          })
        );
      });
    };
  }

  async function createBridgeSender(token, timeoutMs) {
    const providedToken = String(token || "").trim();
    if (!providedToken) {
      throw new Error("Bridge access token is required");
    }

    if (readySenders.has(providedToken)) {
      return readySenders.get(providedToken);
    }

    const handshakeTimeoutMs = Math.max(300, Math.min(timeoutMs, 3000));

    await sendHandshake(providedToken, handshakeTimeoutMs);

    const send = createSend(providedToken);
    readySenders.set(providedToken, send);
    return send;
  }

  window.ApliNiBrowserDebuggingExtension = async (token, options = {}) => {
    const initTimeoutMs = Number.isFinite(options?.timeoutMs) ? Number(options.timeoutMs) : 3000;
    const timeoutMs = Math.max(300, initTimeoutMs);
    return createBridgeSender(token, timeoutMs);
  };
})();
