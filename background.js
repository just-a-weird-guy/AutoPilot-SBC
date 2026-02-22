const SOLVER_BRIDGE_REQUEST = "EA_SOLVER_REQUEST";
const SOLVER_PORT_NAME = "EA_SOLVER_PORT";
const WORKER_RESPONSE = "SOLVER_WORKER_RESPONSE";
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

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
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
