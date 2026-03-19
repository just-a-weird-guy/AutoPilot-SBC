const SOLVER_BRIDGE_REQUEST = "EA_SOLVER_REQUEST";
const SOLVER_PORT_NAME = "EA_SOLVER_PORT";
const WORKER_RESPONSE = "SOLVER_WORKER_RESPONSE";
const BRIDGE_INJECT_REQUEST = "EA_PAGE_BRIDGE_INJECT";
const ALLOWED_BRIDGE_INJECT_PATHS = new Set(["page/ea-data-bridge.js"]);
const EA_WEBAPP_URL_RE =
  /^https:\/\/www\.ea\.com(?:\/[^/?#]+)?\/ea-sports-fc\/ultimate-team\/web-app(?:\/|$)/i;
import {
  buildSolverContext,
  solveSquad,
} from "./solver/solver.js?v=2026-02-22d";

console.log("[EA Data] Background loaded", {
  mode: "direct",
  workerAvailable: typeof Worker !== "undefined",
});

// Help diagnose MV3 service worker terminations/crashes.
try {
  self.addEventListener("unhandledrejection", (event) => {
    console.log("[EA Data] Background unhandledrejection", {
      reason: String(event?.reason?.message || event?.reason || ""),
    });
  });
  self.addEventListener("error", (event) => {
    console.log("[EA Data] Background error", {
      message: String(event?.message || ""),
      filename: event?.filename || null,
      lineno: event?.lineno || null,
      colno: event?.colno || null,
    });
  });
} catch {}

const handleSolverRequest = async (message, sendResponse) => {
  const payload = message?.payload || null;
  const workerType = payload?.type ?? "SOLVE";
  const workerPayload = payload?.payload ?? payload ?? null;
  try {
    if (workerType === "INIT") {
      sendResponse({ ok: true, data: { ready: true, mode: "direct" } });
      return;
    }
    if (workerType === "SOLVE") {
      const context = buildSolverContext(workerPayload || {});
      const result = solveSquad(context);
      sendResponse({ ok: true, data: result });
      return;
    }
    sendResponse({ ok: true, data: { ok: true } });
  } catch (error) {
    sendResponse({
      ok: false,
      error: {
        code: "SOLVER_BRIDGE_FAILED",
        message: error?.message || "Solver bridge failed",
      },
    });
  }
};

const handleBridgeInjectRequest = async (message, sender, sendResponse) => {
  const path = message?.payload?.path || "page/ea-data-bridge.js";
  const tabId = sender?.tab?.id;
  const frameId =
    Number.isInteger(sender?.frameId) && sender.frameId >= 0
      ? sender.frameId
      : 0;
  const senderUrl = String(
    sender?.tab?.url || sender?.url || message?.payload?.href || "",
  );

  try {
    if (tabId == null) {
      throw new Error("Missing sender tab id");
    }
    if (!ALLOWED_BRIDGE_INJECT_PATHS.has(path)) {
      throw new Error("Bridge path not allowed");
    }
    if (frameId !== 0) {
      throw new Error("Bridge injection only allowed in top frame");
    }
    if (!EA_WEBAPP_URL_RE.test(senderUrl)) {
      throw new Error("Bridge injection not allowed for this page");
    }
    if (!chrome?.scripting?.executeScript) {
      throw new Error("chrome.scripting.executeScript is unavailable");
    }
    await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      files: [path],
      world: "MAIN",
    });
    sendResponse({
      ok: true,
      data: {
        injected: true,
        path,
        tabId,
        frameId: 0,
        senderUrl: senderUrl || null,
      },
    });
  } catch (error) {
    sendResponse({
      ok: false,
      error: {
        code: "PAGE_BRIDGE_INJECT_FAILED",
        message: error?.message || String(error),
        path,
        tabId: tabId ?? null,
        frameId,
        senderUrl: senderUrl || null,
      },
    });
  }
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === BRIDGE_INJECT_REQUEST) {
    handleBridgeInjectRequest(message, sender, sendResponse);
    return true;
  }
  if (!message || message.type !== SOLVER_BRIDGE_REQUEST) return false;
  console.log("[EA Data] Background request", {
    type: message?.payload?.type ?? null,
    debug: message?.payload?.payload?.debug ?? null,
  });
  handleSolverRequest(message, sendResponse);
  return true;
});

chrome.runtime.onConnect.addListener((port) => {
  if (!port || port.name !== SOLVER_PORT_NAME) return;

  port.onMessage.addListener((msg) => {
    if (!msg || msg.type !== WORKER_RESPONSE) return;
    const requestId = msg.requestId ?? null;
    const workerType = msg.workerType ?? "SOLVE";
    const workerPayload = msg.payload ?? null;
    if (!requestId) return;

    handleSolverRequest(
      { payload: { type: workerType, payload: workerPayload } },
      (response) => {
        try {
          port.postMessage({
            type: WORKER_RESPONSE,
            requestId,
            ...(response || {}),
          });
        } catch {}
      },
    );
  });
});
