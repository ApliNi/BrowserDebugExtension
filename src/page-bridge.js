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
  const eventListeners = new Map();

  const EVENT_REMOVE_ACTIONS = new Set(["removeEventListener", "unlistenEvent", "removeEvent"]);

  const NULL_BODY_STATUS = new Set([204, 205, 304]);

  function hasOwn(value, key) {
    return value != null && Object.prototype.hasOwnProperty.call(value, key);
  }

  function cloneArrayBuffer(buffer) {
    if (!(buffer instanceof ArrayBuffer)) {
      throw new Error("Expected ArrayBuffer body data");
    }
    return buffer.slice(0);
  }

  function viewToArrayBuffer(view) {
    return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
  }

  function serializeHeaders(headers) {
    if (headers == null) return [];
    try {
      return Array.from(new Headers(headers).entries());
    } catch (error) {
      throw new Error("Failed to serialize fetch headers: " + (error?.message || error));
    }
  }

  async function serializeBlobLike(value, kind) {
    const body = await value.arrayBuffer();
    const result = {
      kind,
      type: value.type || "",
      body,
    };
    if (kind === "file") {
      result.name = value.name || "blob";
      result.lastModified = Number.isFinite(value.lastModified) ? value.lastModified : Date.now();
    }
    return result;
  }

  async function serializeFormData(formData) {
    const entries = [];
    for (const [name, value] of formData.entries()) {
      if (typeof value === "string") {
        entries.push([name, { kind: "string", value }]);
        continue;
      }

      if (typeof File !== "undefined" && value instanceof File) {
        entries.push([name, await serializeBlobLike(value, "file")]);
        continue;
      }

      if (typeof Blob !== "undefined" && value instanceof Blob) {
        entries.push([name, await serializeBlobLike(value, "blob")]);
        continue;
      }

      throw new Error("Unsupported FormData value type for field: " + name);
    }
    return { kind: "formData", entries };
  }

  async function serializeBody(body) {
    if (body == null) return null;
    if (typeof body === "string") return { kind: "string", value: body };
    if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) {
      return { kind: "urlSearchParams", value: body.toString() };
    }
    if (typeof FormData !== "undefined" && body instanceof FormData) {
      return serializeFormData(body);
    }
    if (typeof File !== "undefined" && body instanceof File) {
      return serializeBlobLike(body, "file");
    }
    if (typeof Blob !== "undefined" && body instanceof Blob) {
      return serializeBlobLike(body, "blob");
    }
    if (body instanceof ArrayBuffer) {
      return { kind: "arrayBuffer", body: cloneArrayBuffer(body) };
    }
    if (ArrayBuffer.isView(body)) {
      return { kind: "arrayBuffer", body: viewToArrayBuffer(body) };
    }
    if (typeof ReadableStream !== "undefined" && body instanceof ReadableStream) {
      if (body.locked) {
        throw new Error("Cannot serialize fetch body: ReadableStream is locked");
      }
      return { kind: "arrayBuffer", body: await new Response(body).arrayBuffer() };
    }

    throw new Error("Unsupported fetch body type");
  }

  function copySerializableInit(init, target) {
    if (!init) return;
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
      "signal",
    ];
    for (const field of fields) {
      if (hasOwn(init, field) && field !== "signal") {
        target[field] = init[field];
      }
    }
  }

  function copyRequestInit(request, target) {
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
    ];
    for (const field of fields) {
      if (typeof request[field] !== "undefined") {
        target[field] = request[field];
      }
    }
  }

  async function serializeFetchRequest(input, init = {}) {
    const requestInit = {};
    const isRequest = typeof Request !== "undefined" && input instanceof Request;
    let url;
    let bodySource;

    if (isRequest) {
      if (input.bodyUsed) {
        throw new Error("Cannot serialize Request: body is already disturbed");
      }
      if (input.body?.locked) {
        throw new Error("Cannot serialize Request: body stream is locked");
      }
      url = input.url;
      requestInit.headers = serializeHeaders(input.headers);
      copyRequestInit(input, requestInit);
      if (input.body) {
        bodySource = input.clone().body;
      }
    } else {
      url = String(input || "");
    }

    if (init) {
      copySerializableInit(init, requestInit);
      if (hasOwn(init, "headers")) {
        requestInit.headers = serializeHeaders(init.headers);
      }
      if (hasOwn(init, "body")) {
        bodySource = init.body;
      }
    }

    if (!url) {
      throw new Error("fetch input URL is required");
    }

    requestInit.headers = requestInit.headers || [];
    requestInit.body = await serializeBody(bodySource);
    return { url, init: requestInit };
  }

  async function normalizeFetchPayload(payload) {
    if (hasOwn(payload, "request")) {
      throw new Error("fetch request is an internal serialized field; use input/url and init instead");
    }
    const input = hasOwn(payload, "input") ? payload.input : payload?.url;
    const normalized = {
      action: "fetch",
      request: await serializeFetchRequest(input, payload?.init || {}),
    };
    if (hasOwn(payload, "timeoutMs")) {
      normalized.timeoutMs = payload.timeoutMs;
    }
    return normalized;
  }

  function defineResponseProperty(response, key, value) {
    try {
      Object.defineProperty(response, key, { configurable: true, enumerable: true, value });
    } catch (_error) {
      // Best effort only; body/status/header behavior must remain usable.
    }
  }

  function rebuildFetchResponse(result) {
    if (!result?.ok) {
      throw new Error(result?.error || "Background fetch failed");
    }
    if (!result?.fetch || !result.response) {
      throw new Error("Invalid background fetch response");
    }

    const source = result.response;
    const status = Number(source.status);
    const body = NULL_BODY_STATUS.has(status) ? null : (source.body ?? null);
    const response = new Response(body, {
      status,
      statusText: source.statusText || "",
      headers: source.headers || [],
    });

    defineResponseProperty(response, "url", source.url || "");
    defineResponseProperty(response, "redirected", Boolean(source.redirected));
    defineResponseProperty(response, "type", source.type || "default");
    return response;
  }

  function normalizeEventName(name) {
    const normalizedName = String(name || "").trim();
    if (!normalizedName) {
      throw new Error("Missing event name");
    }
    return normalizedName;
  }

  function createEventListenerId() {
    return "evt_" + Date.now() + "_" + (++seq) + "_" + Math.random().toString(16).slice(2);
  }

  function isRemoveEventAction(action) {
    return EVENT_REMOVE_ACTIONS.has(action);
  }

  function getEventListenerId(payload) {
    const listenerId = payload?.listenerId ?? payload?.id;
    const normalizedId = String(listenerId || "").trim();
    if (!normalizedId) {
      throw new Error("Missing event listenerId");
    }
    return normalizedId;
  }

  function assertEventActionOk(result) {
    if (!result?.ok) {
      throw new Error(result?.error || "Debug event action failed");
    }
    return result;
  }

  function setEventDeliveryAck(detail, handled, error, extra = {}) {
    if (detail?.ack && typeof detail.ack === "object") {
      detail.ack.handled = handled;
      if (error) {
        detail.ack.error = error;
      }
      Object.assign(detail.ack, extra);
    }
  }

  function handleEventDelivery(detail) {
    const listenerId = String(detail?.listenerId || "").trim();
    if (!listenerId) {
      setEventDeliveryAck(detail, false, "Missing event listenerId");
      return;
    }

    const listener = eventListeners.get(listenerId);
    if (!listener) {
      setEventDeliveryAck(detail, false, "Unknown event listenerId: " + listenerId);
      return;
    }

    if (listener.name !== detail.name) {
      const error = "Debug event delivery name mismatch: expected " + listener.name + ", got " + String(detail.name || "");
      setEventDeliveryAck(detail, false, error);
      console.error(error, { listenerId, expected: listener.name, actual: detail.name });
      return;
    }

    setEventDeliveryAck(detail, true);

    if (listener.once) {
      eventListeners.delete(listenerId);
      if (listener.timer) {
        nativeClearTimeout.call(window, listener.timer);
      }
    }

    try {
      if (listener.once) {
        listener.resolve(detail.data);
      } else {
        listener.callback(detail.data);
      }
    } catch (error) {
      if (listener.once) {
        listener.reject(error);
      } else {
        console.error("Debug event listener callback failed", error);
      }
      setEventDeliveryAck(detail, true, null, { callbackError: String(error?.message || error) });
    }
  }

  function ensureTokenListener(token) {
    if (listeningTokens.has(token)) {
      return;
    }

    nativeAddEventListener.call(bridgeTarget, token, (event) => {
      const { kind, requestId, ok, result, error } = event.detail || {};
      if (kind === "debug-event-delivery") {
        handleEventDelivery(event.detail || {});
        return;
      }

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
    return async (payload) => {
      const action = payload?.action || payload?.type;

      if (action === "listenEvent") {
        const name = normalizeEventName(payload?.name);
        if (typeof payload?.callback !== "function") {
          throw new Error("listenEvent callback must be a function");
        }

        const listenerId = createEventListenerId();
        eventListeners.set(listenerId, { name, callback: payload.callback, once: false });
        try {
          assertEventActionOk(await sendRaw(token, { action: "listenEvent", name, listenerId }));
          return listenerId;
        } catch (error) {
          eventListeners.delete(listenerId);
          throw error;
        }
      }

      if (action === "awaitEvent") {
        const name = normalizeEventName(payload?.name);
        const listenerId = createEventListenerId();
        const timeoutMs = Number.isFinite(payload?.timeoutMs) ? Number(payload.timeoutMs) : 0;

        return new Promise((resolve, reject) => {
          const listener = { name, once: true, resolve, reject, timer: null };
          eventListeners.set(listenerId, listener);

          sendRaw(token, { action: "awaitEvent", name, listenerId }).then((result) => {
            assertEventActionOk(result);
            if (!eventListeners.has(listenerId)) {
              sendRaw(token, { action: "removeEventListener", listenerId }).catch((error) => {
                console.error("Failed to unregister completed awaitEvent listener", error);
              });
              return;
            }

            if (timeoutMs > 0) {
              listener.timer = nativeSetTimeout.call(window, () => {
                eventListeners.delete(listenerId);
                sendRaw(token, { action: "removeEventListener", listenerId }).catch((error) => {
                  console.error("Failed to unregister timed out awaitEvent listener", error);
                });
                reject(new Error("awaitEvent timeout after " + timeoutMs + "ms"));
              }, timeoutMs);
            }
          }).catch((error) => {
            eventListeners.delete(listenerId);
            if (listener.timer) {
              nativeClearTimeout.call(window, listener.timer);
            }
            reject(error);
          });
        });
      }

      if (action === "newEvent") {
        const name = normalizeEventName(payload?.name);
        return assertEventActionOk(await sendRaw(token, { action: "newEvent", name, data: payload?.data }));
      }

      if (isRemoveEventAction(action)) {
        const listenerId = getEventListenerId(payload);
        const listener = eventListeners.get(listenerId);
        try {
          const result = assertEventActionOk(await sendRaw(token, { action: "removeEventListener", listenerId }));
          if (listener) {
            eventListeners.delete(listenerId);
            if (listener.timer) {
              nativeClearTimeout.call(window, listener.timer);
            }
          }
          return { ...result, localHadListener: Boolean(listener) };
        } catch (error) {
          if (listener && String(error?.message || error).includes("Unknown event listenerId")) {
            eventListeners.delete(listenerId);
            if (listener.timer) {
              nativeClearTimeout.call(window, listener.timer);
            }
            return { ok: true, listenerId, localHadListener: true, remoteRemoved: false, remoteMissing: true };
          }
          throw error;
        }
      }

      const isFetchAction = payload?.action === "fetch" || payload?.type === "fetch";
      let messagePayload = payload;

      if (isFetchAction) {
        messagePayload = await normalizeFetchPayload(payload);
      }

      const timeoutMs = Number.isFinite(messagePayload?.timeoutMs)
        ? Number(messagePayload.timeoutMs) + 5000
        : (isFetchAction ? 0 : 35000);

      if (messagePayload?.action === "waitUrlMatch" && messagePayload.pattern instanceof RegExp) {
        messagePayload = {
          ...messagePayload,
          pattern: messagePayload.pattern.source,
          flags: messagePayload.flags ?? messagePayload.pattern.flags,
        };
      }

      const requestId = "req_" + Date.now() + "_" + (++seq);

      const result = await new Promise((resolve, reject) => {
        ensureTokenListener(token);

        const timer = timeoutMs > 0
          ? nativeSetTimeout.call(window, () => {
            pending.delete(requestId);
            reject(new Error("Bridge request timeout after " + timeoutMs + "ms"));
          }, timeoutMs)
          : null;

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

      return isFetchAction ? rebuildFetchResponse(result) : result;
    };
  }

  async function sendRaw(token, payload) {
    const requestId = "req_" + Date.now() + "_" + (++seq);
    const timeoutMs = Number.isFinite(payload?.timeoutMs) ? Number(payload.timeoutMs) + 5000 : 35000;

    return new Promise((resolve, reject) => {
      ensureTokenListener(token);

      const timer = timeoutMs > 0
        ? nativeSetTimeout.call(window, () => {
          pending.delete(requestId);
          reject(new Error("Bridge request timeout after " + timeoutMs + "ms"));
        }, timeoutMs)
        : null;

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
            payload,
          },
        })
      );
    });
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
    send.fetch = (input, init) => send({ action: "fetch", input, init });
    readySenders.set(providedToken, send);
    return send;
  }

  window.ApliNiBrowserDebuggingExtension = async (token, options = {}) => {
    const initTimeoutMs = Number.isFinite(options?.timeoutMs) ? Number(options.timeoutMs) : 3000;
    const timeoutMs = Math.max(300, initTimeoutMs);
    return createBridgeSender(token, timeoutMs);
  };
})();
