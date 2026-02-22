import { buildSolverContext, solveSquad } from "./solver.js";

const WORKER_RESPONSE = "SOLVER_WORKER_RESPONSE";

const reply = (requestId, ok, data, error) => {
  self.postMessage({ type: WORKER_RESPONSE, requestId, ok, data, error });
};

self.addEventListener("message", async (event) => {
  const { type, requestId, payload } = event.data || {};
  if (!type || !requestId) return;

  if (type === "INIT") {
    return reply(requestId, true, { ready: true, mode: "content-worker" });
  }

  if (type === "SOLVE") {
    try {
      const context = buildSolverContext(payload || {});
      const result = solveSquad(context);
      return reply(requestId, true, result);
    } catch (error) {
      return reply(requestId, false, null, {
        code: "SOLVER_FAILED",
        message: error?.message || "Solver failed",
      });
    }
  }

  return reply(requestId, true, { ok: true });
});
