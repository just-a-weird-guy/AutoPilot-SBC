const injectPageScript = (path, { type = "module" } = {}) =>
  new Promise((resolve, reject) => {
    const script = document.createElement("script");
    const src = chrome.runtime.getURL(path);
    script.src = src;
    if (type) script.type = type;
    script.onload = function () {
      script.parentNode?.removeChild(script);
      resolve({ path, type: type || "classic", src });
    };
    script.onerror = function (errorEvent) {
      script.parentNode?.removeChild(script);
      const error = new Error(
        `[EA Data] Failed to inject script: ${path} (${type || "classic"})`,
      );
      error.path = path;
      error.injectType = type || "classic";
      error.src = src;
      error.eventType = errorEvent?.type ?? null;
      reject(error);
    };
    (document.head || document.documentElement).appendChild(script);
  });

const BRIDGE_INJECT_REQUEST = "EA_PAGE_BRIDGE_INJECT";

const requestBackgroundBridgeInject = (path) =>
  new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage(
        {
          type: BRIDGE_INJECT_REQUEST,
          payload: { path },
        },
        (response) => {
          const runtimeError = chrome.runtime?.lastError;
          if (runtimeError) {
            reject(
              new Error(
                runtimeError.message || "Background bridge injection failed",
              ),
            );
            return;
          }
          if (response?.ok) {
            resolve(response?.data ?? { injected: true, path });
            return;
          }
          reject(
            new Error(
              response?.error?.message || "Background bridge injection failed",
            ),
          );
        },
      );
    } catch (error) {
      reject(error);
    }
  });

void (async () => {
  if (window !== window.top) return;
  const bridgePath = "page/ea-data-bridge.js";
  try {
    await injectPageScript(bridgePath, { type: "module" });
  } catch (error) {
    console.warn("[EA Data] Module script injection failed; retrying classic", {
      path: error?.path ?? bridgePath,
      type: error?.injectType ?? "module",
      src: error?.src ?? null,
      message: error?.message ?? String(error),
    });
    try {
      await injectPageScript(bridgePath, { type: null });
      console.warn("[EA Data] Classic script injection fallback succeeded", {
        path: bridgePath,
      });
    } catch (fallbackError) {
      try {
        await requestBackgroundBridgeInject(bridgePath);
        console.warn(
          "[EA Data] Background executeScript injection fallback succeeded",
          {
            path: bridgePath,
          },
        );
      } catch (backgroundError) {
        console.error("[EA Data] Script injection failed", {
          moduleError: {
            path: error?.path ?? bridgePath,
            type: error?.injectType ?? "module",
            src: error?.src ?? null,
            message: error?.message ?? String(error),
          },
          fallbackError: {
            path: fallbackError?.path ?? bridgePath,
            type: fallbackError?.injectType ?? "classic",
            src: fallbackError?.src ?? null,
            message: fallbackError?.message ?? String(fallbackError),
          },
          backgroundError: {
            path: bridgePath,
            message: backgroundError?.message ?? String(backgroundError),
          },
          href: location.href,
          frame: window === window.top ? "top" : "child",
          ua: navigator.userAgent,
          at: new Date().toISOString(),
        });
      }
    }
  }
})();

const CONTENT_SCRIPT_VERSION = "2026-03-03b";
console.log("[EA Data] Content script loaded", {
  version: CONTENT_SCRIPT_VERSION,
});

const SOLVER_BRIDGE_REQUEST = "EA_SOLVER_REQUEST";
const SOLVER_BRIDGE_RESPONSE = "EA_SOLVER_RESPONSE";
const SOLVER_BRIDGE_TRACE = "EA_SOLVER_TRACE";
const SOLVER_BRIDGE_PING = "EA_SOLVER_PING";
const SOLVER_BRIDGE_PONG = "EA_SOLVER_PONG";
const SOLVER_BRIDGE_SOURCE = "ea-data-bridge";
const WORKER_RESPONSE = "SOLVER_WORKER_RESPONSE";
const SOLVER_PORT_NAME = "EA_SOLVER_PORT";
const EA_DATA_LOG = "EA_DATA_LOG";

const PREF_BRIDGE_GET = "EA_DATA_PREF_GET";
const PREF_BRIDGE_SET = "EA_DATA_PREF_SET";
const PREF_BRIDGE_RES = "EA_DATA_PREF_RES";
const PREF_ALLOWED_KEYS = new Set(["eaData.preferences.v1"]);

// Relay page-world log messages to the content-script console.
// The page script (ea-data-bridge.js) runs in the main world where EA overrides
// console. This listener runs in the isolated world with the native console.
window.addEventListener(
  "message",
  (event) => {
    if (window !== window.top) return;
    if (!isTrustedPageMessageEvent(event)) return;
    if (event?.data?.type !== EA_DATA_LOG) return;
    const args = event.data.args;
    if (!Array.isArray(args)) return;
    console.log(...args);
  },
  true,
);

const solverBridgeSeen = new Set();

let solverWorkerInitPromise = null;
const solverWorkerRequests = new Map();
let solverPort = null;

const delayMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const createRequestId = () => {
  if (crypto?.randomUUID) return crypto.randomUUID();
  return `ea-data-${Date.now()}-${Math.random().toString(16).slice(2)}`;
};

const isTrustedPageMessageEvent = (event) => {
  if (!event) return false;
  if (event.source !== window) return false;
  try {
    const expectedOrigin = window.location?.origin ?? "";
    const origin = event.origin;
    if (origin && origin !== "null" && expectedOrigin && origin !== expectedOrigin) {
      return false;
    }
  } catch {}
  return true;
};

const postSolverTrace = (stage, requestId, details = null) => {
  const detail = { type: SOLVER_BRIDGE_TRACE, requestId, stage, details, source: SOLVER_BRIDGE_SOURCE };
  try {
    window.postMessage(detail, "*");
  } catch {}
  try {
    document.dispatchEvent(new CustomEvent(SOLVER_BRIDGE_TRACE, { detail }));
  } catch {}
};

const markListenerReady = () => {
  try {
    document.documentElement.dataset.eaSolverBridge = "ready";
    document.documentElement.dataset.eaSolverBridgeAt = String(Date.now());
  } catch {}
  postSolverTrace("listener-ready", "content-script", {
    href: location.href,
    frame: window === window.top ? "top" : "child",
  });
};

const postSolverPong = (requestId) => {
  const detail = {
    type: SOLVER_BRIDGE_PONG,
    requestId,
    frame: window === window.top ? "top" : "child",
    href: location.href,
    source: SOLVER_BRIDGE_SOURCE,
  };
  try {
    window.postMessage(detail, "*");
  } catch {}
  try {
    document.dispatchEvent(new CustomEvent(SOLVER_BRIDGE_PONG, { detail }));
  } catch {}
};

if (window === window.top) markListenerReady();

const ensureSolverPort = () => {
  if (solverPort) return solverPort;
  try {
    solverPort = chrome.runtime.connect({ name: SOLVER_PORT_NAME });
  } catch (error) {
    solverPort = null;
    throw error;
  }

  solverPort.onMessage.addListener((msg) => {
    if (!msg || msg.type !== WORKER_RESPONSE) return;
    const requestId = msg.requestId;
    if (!requestId) return;
    const pending = solverWorkerRequests.get(requestId);
    if (!pending) return;
    solverWorkerRequests.delete(requestId);
    try {
      clearTimeout(pending.timerId);
    } catch {}
    if (msg.ok) pending.resolve(msg.data);
    else pending.reject(msg.error || new Error("Solver failed"));
  });

  solverPort.onDisconnect.addListener(() => {
    solverPort = null;
    try {
      solverWorkerInitPromise = null;
    } catch {}
    // Fail any in-flight calls quickly.
    for (const [requestId, pending] of solverWorkerRequests.entries()) {
      try {
        clearTimeout(pending.timerId);
      } catch {}
      try {
        pending.reject(new Error("Solver port disconnected"));
      } catch {}
      solverWorkerRequests.delete(requestId);
    }
  });

  return solverPort;
};

const initSolverWorker = () => {
  if (solverWorkerInitPromise) return solverWorkerInitPromise;
  // The background solver is stateless; INIT is purely a bridge readiness check.
  // Avoid sending extra background messages that can race with MV3 service worker shutdown.
  solverWorkerInitPromise = Promise.resolve({ ready: true, mode: "bridge" });
  return solverWorkerInitPromise;
};

const isRetryableSolverError = (error) => {
  const message = String(error?.message || error || "");
  if (!message) return false;
  if (message.includes("disconnected")) return true;
  if (message.includes("Receiving end does not exist")) return true;
  if (message.includes("Could not establish connection")) return true;
  if (message.includes("message port closed")) return true;
  if (message.includes("Attempting to use a disconnected port object"))
    return true;
  if (message.includes("Extension context invalidated")) return true;
  return false;
};

const callSolverWorkerOnce = (type, payload, timeoutMs) =>
  new Promise((resolve, reject) => {
    let port;
    try {
      port = ensureSolverPort();
    } catch (error) {
      reject(error);
      return;
    }

    const requestId = createRequestId();
    const timerId = setTimeout(
      () => {
        solverWorkerRequests.delete(requestId);
        reject(new Error("Solver timeout"));
      },
      Math.max(1000, Number(timeoutMs) || 65000),
    );

    solverWorkerRequests.set(requestId, { resolve, reject, timerId });
    try {
      port.postMessage({
        type: WORKER_RESPONSE,
        requestId,
        workerType: type,
        payload,
      });
    } catch (error) {
      solverWorkerRequests.delete(requestId);
      try {
        clearTimeout(timerId);
      } catch {}
      reject(error);
    }
  });

const callSolverWorker = async (
  type,
  payload,
  timeoutMs,
  { retries = 1 } = {},
) => {
  try {
    return await callSolverWorkerOnce(type, payload, timeoutMs);
  } catch (error) {
    if (!retries || !isRetryableSolverError(error)) throw error;
    // Force a clean reconnect and retry once for MV3 service worker restarts.
    try {
      solverPort?.disconnect?.();
    } catch {}
    solverPort = null;
    try {
      solverWorkerInitPromise = null;
    } catch {}
    await delayMs(60);
    return callSolverWorker(type, payload, timeoutMs, { retries: retries - 1 });
  }
};

const handleSolverError = (error) => {
  const message = error?.message || "Solver bridge failed";
  if (message.includes("Receiving end does not exist")) {
    return {
      code: "BACKGROUND_UNAVAILABLE",
      message:
        "Extension background unavailable. Reload the extension and retry.",
    };
  }
  if (message.includes("disconnected")) {
    return {
      code: "BACKGROUND_UNAVAILABLE",
      message: "Solver disconnected. Retry the solve.",
    };
  }
  return error;
};

const handleSolverBridgeRequest = async (data) => {
  if (window !== window.top) return;
  const { type, requestId, payload, source } = data || {};
  if (type !== SOLVER_BRIDGE_REQUEST || !requestId) return;
  if (source !== SOLVER_BRIDGE_SOURCE) return;
  if (solverBridgeSeen.has(requestId)) return;
  solverBridgeSeen.add(requestId);
  // Prevent unbounded growth if the user runs many solves in a single session.
  if (solverBridgeSeen.size > 3000) solverBridgeSeen.clear();

  const shouldDebugLog = Boolean(
    payload?.debug === true || payload?.payload?.debug === true,
  );
  if (shouldDebugLog) {
    console.log("[EA Data] Solver bridge request", {
      requestId,
      workerType: payload?.type,
      debug: true,
      pageDebug: Boolean(payload?.debug),
      solverDebug: Boolean(payload?.payload?.debug),
    });
  }
  postSolverTrace("received", requestId, {
    workerType: payload?.type ?? "SOLVE",
  });

  try {
    const workerType = payload?.type ?? "SOLVE";
    const workerPayload = payload?.payload ?? payload ?? null;
    let result;
    if (workerType === "INIT") {
      result = await initSolverWorker();
    } else {
      result = await callSolverWorker(workerType, workerPayload, 65000);
    }
    const responsePayload = {
      type: SOLVER_BRIDGE_RESPONSE,
      requestId,
      ok: true,
      data: result,
      source: SOLVER_BRIDGE_SOURCE,
    };
    postSolverTrace("responded", requestId, { ok: true });
    window.postMessage(responsePayload, "*");
    document.dispatchEvent(
      new CustomEvent(SOLVER_BRIDGE_RESPONSE, { detail: responsePayload }),
    );
  } catch (error) {
    const normalized = handleSolverError(error);
    const responsePayload = {
      type: SOLVER_BRIDGE_RESPONSE,
      requestId,
      ok: false,
      source: SOLVER_BRIDGE_SOURCE,
      error: normalized?.code
        ? normalized
        : {
            code: "SOLVER_BRIDGE_FAILED",
            message: error?.message || "Solver bridge failed",
          },
    };
    postSolverTrace("responded", requestId, {
      ok: false,
      message: error?.message || "Solver bridge failed",
    });
    window.postMessage(responsePayload, "*");
    document.dispatchEvent(
      new CustomEvent(SOLVER_BRIDGE_RESPONSE, { detail: responsePayload }),
    );
  }
};

const storageLocalGet = (key) =>
  new Promise((resolve, reject) => {
    try {
      if (!chrome?.storage?.local?.get) {
        reject(new Error("chrome.storage.local unavailable"));
        return;
      }
      chrome.storage.local.get([key], (items) => {
        const err = chrome?.runtime?.lastError;
        if (err) {
          reject(new Error(err.message || "storage get failed"));
          return;
        }
        resolve(items ? items[key] : null);
      });
    } catch (error) {
      reject(error);
    }
  });

const storageLocalSet = (key, value) =>
  new Promise((resolve, reject) => {
    try {
      if (!chrome?.storage?.local?.set) {
        reject(new Error("chrome.storage.local unavailable"));
        return;
      }
      chrome.storage.local.set({ [key]: value }, () => {
        const err = chrome?.runtime?.lastError;
        if (err) {
          reject(new Error(err.message || "storage set failed"));
          return;
        }
        resolve(true);
      });
    } catch (error) {
      reject(error);
    }
  });

const postPrefResponse = (requestId, ok, data, error) => {
  const detail = {
    type: PREF_BRIDGE_RES,
    requestId,
    ok: Boolean(ok),
    data,
    error,
    source: SOLVER_BRIDGE_SOURCE,
  };
  try {
    window.postMessage(detail, "*");
  } catch {}
};

const handlePrefBridgeRequest = async (data) => {
  if (window !== window.top) return;
  const { type, requestId, source, key, value } = data || {};
  if (type !== PREF_BRIDGE_GET && type !== PREF_BRIDGE_SET) return;
  if (!requestId) return;
  if (source !== SOLVER_BRIDGE_SOURCE) return;
  if (!key) {
    postPrefResponse(requestId, false, null, {
      code: "PREF_INVALID",
      message: "Missing preference key",
    });
    return;
  }
  if (!PREF_ALLOWED_KEYS.has(String(key))) {
    postPrefResponse(requestId, false, null, {
      code: "PREF_FORBIDDEN_KEY",
      message: "Preference key not allowed",
    });
    return;
  }

  try {
    if (type === PREF_BRIDGE_GET) {
      const result = await storageLocalGet(key);
      postPrefResponse(requestId, true, result, null);
      return;
    }
    await storageLocalSet(key, value);
    postPrefResponse(requestId, true, true, null);
  } catch (error) {
    postPrefResponse(requestId, false, null, {
      code: "PREF_FAILED",
      message: error?.message || "Preference request failed",
    });
  }
};

window.addEventListener(
  "message",
  (event) => {
    if (window !== window.top) return;
    if (!isTrustedPageMessageEvent(event)) return;
    handleSolverBridgeRequest(event.data);
  },
  true,
);

window.addEventListener(
  "message",
  (event) => {
    if (window !== window.top) return;
    if (!isTrustedPageMessageEvent(event)) return;
    handlePrefBridgeRequest(event.data);
  },
  true,
);

document.addEventListener(SOLVER_BRIDGE_REQUEST, (event) => {
  if (window !== window.top) return;
  handleSolverBridgeRequest(event.detail);
});

document.addEventListener(SOLVER_BRIDGE_PING, (event) => {
  if (window !== window.top) return;
  if (event?.detail?.source !== SOLVER_BRIDGE_SOURCE) return;
  const requestId = event?.detail?.requestId || createRequestId();
  postSolverTrace("ping-received", requestId, { channel: "event" });
  postSolverPong(requestId);
});

window.addEventListener(
  "message",
  (event) => {
    if (window !== window.top) return;
    if (!isTrustedPageMessageEvent(event)) return;
    if (event?.data?.source !== SOLVER_BRIDGE_SOURCE) return;
    if (event?.data?.type !== SOLVER_BRIDGE_PING) return;
    const requestId = event?.data?.requestId || createRequestId();
    postSolverTrace("ping-received", requestId, { channel: "postMessage" });
    postSolverPong(requestId);
  },
  true,
);
