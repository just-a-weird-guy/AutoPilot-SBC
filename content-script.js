const bridgeScript = document.createElement("script");
bridgeScript.src = chrome.runtime.getURL("page/ea-data-bridge.js");
bridgeScript.type = "module";

(document.head || document.documentElement).appendChild(bridgeScript);

bridgeScript.onload = function () {
  bridgeScript.parentNode.removeChild(bridgeScript);
};

const CONTENT_SCRIPT_VERSION = "2026-02-22b";
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

// Relay page-world log messages to the content-script console.
// The page script (ea-data-bridge.js) runs in the main world where EA overrides
// console. This listener runs in the isolated world with the native console.
window.addEventListener(
  "message",
  (event) => {
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

const postSolverTrace = (stage, requestId, details = null) => {
  const detail = { type: SOLVER_BRIDGE_TRACE, requestId, stage, details };
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
  };
  try {
    window.postMessage(detail, "*");
  } catch {}
  try {
    document.dispatchEvent(new CustomEvent(SOLVER_BRIDGE_PONG, { detail }));
  } catch {}
};

markListenerReady();

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
  const { type, requestId, payload, source } = data || {};
  if (type !== SOLVER_BRIDGE_REQUEST || !requestId) return;
  if (source && source !== SOLVER_BRIDGE_SOURCE) return;
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
  const { type, requestId, source, key, value } = data || {};
  if (type !== PREF_BRIDGE_GET && type !== PREF_BRIDGE_SET) return;
  if (!requestId) return;
  if (source && source !== SOLVER_BRIDGE_SOURCE) return;
  if (!key) {
    postPrefResponse(requestId, false, null, {
      code: "PREF_INVALID",
      message: "Missing preference key",
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
    handleSolverBridgeRequest(event.data);
  },
  true,
);

window.addEventListener(
  "message",
  (event) => {
    handlePrefBridgeRequest(event.data);
  },
  true,
);

document.addEventListener(SOLVER_BRIDGE_REQUEST, (event) => {
  handleSolverBridgeRequest(event.detail);
});

document.addEventListener(SOLVER_BRIDGE_PING, (event) => {
  const requestId = event?.detail?.requestId || createRequestId();
  postSolverTrace("ping-received", requestId, { channel: "event" });
  postSolverPong(requestId);
});

window.addEventListener(
  "message",
  (event) => {
    if (event?.data?.type !== SOLVER_BRIDGE_PING) return;
    const requestId = event?.data?.requestId || createRequestId();
    postSolverTrace("ping-received", requestId, { channel: "postMessage" });
    postSolverPong(requestId);
  },
  true,
);
