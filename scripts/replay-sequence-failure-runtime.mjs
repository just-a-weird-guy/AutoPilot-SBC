import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";

const rootDir = process.cwd();
const bridgePath = path.resolve(rootDir, "page/ea-data-bridge.js");

const readSource = async () => fs.readFile(bridgePath, "utf8");

const findStatementEnd = (source, startIndex) => {
  let depthParen = 0;
  let depthBrace = 0;
  let depthBracket = 0;
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let index = startIndex; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    const prev = source[index - 1];

    if (inLineComment) {
      if (char === "\n") inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (prev === "*" && char === "/") inBlockComment = false;
      continue;
    }
    if (inSingle) {
      if (char === "'" && prev !== "\\") inSingle = false;
      continue;
    }
    if (inDouble) {
      if (char === '"' && prev !== "\\") inDouble = false;
      continue;
    }
    if (inTemplate) {
      if (char === "`" && prev !== "\\") inTemplate = false;
      continue;
    }

    if (char === "/" && next === "/") {
      inLineComment = true;
      index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      inBlockComment = true;
      index += 1;
      continue;
    }
    if (char === "'") {
      inSingle = true;
      continue;
    }
    if (char === '"') {
      inDouble = true;
      continue;
    }
    if (char === "`") {
      inTemplate = true;
      continue;
    }

    if (char === "(") depthParen += 1;
    else if (char === ")") depthParen -= 1;
    else if (char === "{") depthBrace += 1;
    else if (char === "}") depthBrace -= 1;
    else if (char === "[") depthBracket += 1;
    else if (char === "]") depthBracket -= 1;
    else if (
      char === ";" &&
      depthParen === 0 &&
      depthBrace === 0 &&
      depthBracket === 0
    ) {
      return index + 1;
    }
  }

  throw new Error(`Could not find statement end from index ${startIndex}`);
};

const extractConstStatement = (source, name) => {
  const marker = `const ${name} =`;
  const startIndex = source.indexOf(marker);
  if (startIndex === -1) {
    return null;
  }
  const endIndex = findStatementEnd(source, startIndex);
  return source.slice(startIndex, endIndex);
};

const extractFunctionStatement = (source, name) => {
  const marker = `function ${name}(`;
  const startIndex = source.indexOf(marker);
  if (startIndex === -1) return null;
  let paramDepth = 0;
  let bodyStart = -1;
  for (let index = startIndex; index < source.length; index += 1) {
    const char = source[index];
    if (char === "(") {
      paramDepth += 1;
      continue;
    }
    if (char === ")") {
      paramDepth = Math.max(0, paramDepth - 1);
      continue;
    }
    if (char === "{" && paramDepth === 0) {
      bodyStart = index;
      break;
    }
  }
  if (bodyStart === -1) return null;
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let index = bodyStart; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    const prev = source[index - 1];

    if (inLineComment) {
      if (char === "\n") inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (prev === "*" && char === "/") inBlockComment = false;
      continue;
    }
    if (inSingle) {
      if (char === "'" && prev !== "\\") inSingle = false;
      continue;
    }
    if (inDouble) {
      if (char === '"' && prev !== "\\") inDouble = false;
      continue;
    }
    if (inTemplate) {
      if (char === "`" && prev !== "\\") inTemplate = false;
      continue;
    }

    if (char === "/" && next === "/") {
      inLineComment = true;
      index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      inBlockComment = true;
      index += 1;
      continue;
    }
    if (char === "'") {
      inSingle = true;
      continue;
    }
    if (char === '"') {
      inDouble = true;
      continue;
    }
    if (char === "`") {
      inTemplate = true;
      continue;
    }

    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(startIndex, index + 1);
      }
    }
  }

  return null;
};

const extractStatement = (source, name) =>
  extractConstStatement(source, name) ?? extractFunctionStatement(source, name);

const createHarness = (source) => {
  const context = vm.createContext({
    console,
    Math,
    Number,
    String,
    Boolean,
    Object,
    Array,
    Map,
    Set,
    JSON,
  });

  const names = [
    "readNumeric",
    "sanitizeDisplayText",
    "SEQUENCE_LOOP_COUNT_MIN",
    "SEQUENCE_LOOP_COUNT_MAX",
    "SEQUENCE_PROGRESS_PHASE_UNIT_COUNT",
    "clampInt",
    "clampSequenceLoopCount",
    "SEQUENCE_TARGET_KIND_SINGLE",
    "SEQUENCE_TARGET_KIND_SET_SCOPE",
    "getTargetKindLabel",
    "formatLoopCountLabel",
    "normalizeRunStatusKey",
    "normalizeSequenceRuntimeCopy",
    "isSequenceUserStopReason",
    "getFailureSourceMeta",
    "getSequenceFailureSourceMeta",
    "getSequenceProgressPhaseRank",
    "buildSequenceProgressAttemptKey",
    "markRunProgressPhase",
    "createSequenceRuntimeFailureContext",
    "buildSequenceSolverFailureReason",
    "recordSequenceRuntimeFailure",
    "buildSequenceFailureSummary",
    "resolveSequenceTerminalState",
    "buildSequenceRuntimePrimaryMessage",
  ];

  for (const name of names) {
    const statement = extractStatement(source, name);
    if (!statement) {
      throw new Error(`Missing required statement: ${name}`);
    }
    vm.runInContext(`${statement}\nthis.${name} = ${name};`, context, {
      filename: "ea-data-bridge.js",
    });
  }

  context.sequenceSolveOverlayState = {
    runState: {
      latestFailureContext: null,
      firstError: null,
    },
  };

  return context;
};

const main = async () => {
  const source = await readSource();
  assert.equal(
    source.includes("ea-data-sequence-failure-card"),
    true,
    "sequence runtime should keep failure recognition in a dedicated failure card",
  );
  assert.equal(
    source.includes("ea-data-sequence-failure-item"),
    false,
    "sequence failure card should avoid nested mini-cards and keep the information in one compact block",
  );
  const runActivePlanStart = source.indexOf("const runActivePlan = async () => {");
  const primeRunIndex = source.indexOf(
    "sequenceSolveOverlayState.running = true;",
    runActivePlanStart,
  );
  const ensureSelectionsIndex = source.indexOf(
    "await ensurePlanSelections(activePlan, { forceChallenges: true });",
    runActivePlanStart,
  );
  assert.equal(
    primeRunIndex > -1 &&
      ensureSelectionsIndex > -1 &&
      primeRunIndex < ensureSelectionsIndex,
    true,
    "sequence start should flip into the running UI state before waiting on preflight selection refresh",
  );
  const harness = createHarness(source);
  const {
    createSequenceRuntimeFailureContext,
    buildSequenceSolverFailureReason,
    buildSequenceProgressAttemptKey,
    markRunProgressPhase,
    getSequenceProgressPhaseRank,
    SEQUENCE_PROGRESS_PHASE_UNIT_COUNT,
    recordSequenceRuntimeFailure,
    buildSequenceFailureSummary,
    resolveSequenceTerminalState,
    buildSequenceRuntimePrimaryMessage,
    sequenceSolveOverlayState,
  } = harness;

  const stepLabel =
    "Step 2: Single Challenge · FOF: Answer The Call Crafting Upgrade · 50x loops";

  const failureContext = createSequenceRuntimeFailureContext({
    source: "submit",
    reason: "Submit failed (512).",
    challengeName: "FOF: Answer The Call Crafting Upgrade",
    stepId: "step-2",
    stepLabel,
    phase: "submitting",
  });

  assert.equal(
    buildSequenceSolverFailureReason([
      {
        label: "Player Quality: Exactly Gold",
      },
    ]),
    "Couldn't satisfy the Player Quality: Exactly Gold requirement.",
    "solver failure reasons should read like user-facing blockers instead of raw rule labels",
  );

  assert.equal(
    SEQUENCE_PROGRESS_PHASE_UNIT_COUNT,
    5,
    "sequence phase progress should use five per-challenge milestones",
  );
  assert.equal(
    getSequenceProgressPhaseRank("refreshing"),
    1,
    "refreshing should count as the first progress phase",
  );
  assert.equal(
    getSequenceProgressPhaseRank("submitting"),
    4,
    "submitting should advance progress before terminal completion",
  );
  const phaseRunState = {
    completedProgressUnits: 0,
    progressPhaseByAttempt: {},
  };
  const attemptKey = buildSequenceProgressAttemptKey({
    planPass: 1,
    stepId: "step-2",
    stepLoopPass: 3,
    descriptor: {
      challengeId: 44,
      challengeName: "FOF: Answer The Call Crafting Upgrade",
    },
  });
  markRunProgressPhase(phaseRunState, attemptKey, "refreshing");
  markRunProgressPhase(phaseRunState, attemptKey, "solving");
  markRunProgressPhase(phaseRunState, attemptKey, "submitting");
  markRunProgressPhase(phaseRunState, attemptKey, "submitting");
  assert.equal(
    phaseRunState.completedProgressUnits,
    4,
    "phase progress should advance during challenge phases without double-counting repeated phase updates",
  );
  markRunProgressPhase(phaseRunState, attemptKey, "skipped");
  assert.equal(
    phaseRunState.completedProgressUnits,
    5,
    "terminal challenge states should finish the remaining progress for that attempt",
  );

  assert.equal(
    failureContext.source,
    "submit",
    "failure context should preserve the explicit failure source",
  );
  assert.equal(
    failureContext.stepLabel,
    stepLabel,
    "failure context should preserve the step label",
  );

  recordSequenceRuntimeFailure(failureContext, {
    setFirstError: true,
  });

  assert.equal(
    sequenceSolveOverlayState.runState.latestFailureContext?.challengeName,
    "FOF: Answer The Call Crafting Upgrade",
    "recordSequenceRuntimeFailure should keep the latest failure context on run state",
  );
  assert.equal(
    sequenceSolveOverlayState.runState.firstError?.message,
    "Submit failed (512).",
    "recordSequenceRuntimeFailure should seed firstError when requested",
  );

  const failureSummary = buildSequenceFailureSummary(
    sequenceSolveOverlayState.runState.latestFailureContext,
  );

  assert.equal(
    failureSummary,
    "Stopped at FOF: Answer The Call Crafting Upgrade • Submit Error • Submit failed (512).",
    "failure summary should include challenge, source label, and reason",
  );

  const failedMessage = buildSequenceRuntimePrimaryMessage({
    statusKey: "failed",
    runtimeStatusText: "Submitting FOF: Answer The Call Crafting Upgrade...",
    stopReason: "Submit failed (512).",
    firstErrorMessage: "Submit failed (512).",
    latestFailureContext: sequenceSolveOverlayState.runState.latestFailureContext,
  });

  assert.equal(
    failedMessage,
    "Sequence failed. See latest issue below.",
    "failed runtime banner should keep the detailed error in the dedicated failure card",
  );

  const stoppedMessage = buildSequenceRuntimePrimaryMessage({
    statusKey: "stopped",
    runtimeStatusText: "Submitting FOF: Answer The Call Crafting Upgrade...",
    stopReason: "Stopped by user at a safe boundary.",
    firstErrorMessage: "Submit failed (512).",
    latestFailureContext: sequenceSolveOverlayState.runState.latestFailureContext,
  });

  assert.equal(
    stoppedMessage,
    "Stopped by user at a safe boundary.",
    "stopped runtime banner should prefer the explicit stop reason for user-initiated stops",
  );

  const manualStopMessage = buildSequenceRuntimePrimaryMessage({
    statusKey: "stopped",
    runtimeStatusText: "Solving FOF: Answer The Call Crafting Upgrade...",
    stopReason: "Stopped by user at a safe boundary.",
    firstErrorMessage: null,
    latestFailureContext: sequenceSolveOverlayState.runState.latestFailureContext,
  });

  assert.equal(
    manualStopMessage,
    "Stopped by user at a safe boundary.",
    "manual stops should prefer the explicit stop reason over stale failure context",
  );

  const runningMessage = buildSequenceRuntimePrimaryMessage({
    statusKey: "submitting",
    runtimeStatusText: "Submitting FOF: Answer The Call Crafting Upgrade...",
    stopReason: null,
    firstErrorMessage: null,
    latestFailureContext: null,
  });

  assert.equal(
    runningMessage,
    "Submitting FOF: Answer The Call Crafting Upgrade...",
    "running runtime banner should still show live phase copy",
  );

  const partialTerminalState = resolveSequenceTerminalState(
    {
      status: "running",
      latestFailureContext: sequenceSolveOverlayState.runState.latestFailureContext,
      hadSoftFailures: true,
      counters: {
        solved: 3,
        skipped: 2,
        failed: 0,
      },
    },
    {
      abortRequested: false,
      noWorkStopReason: "No remaining work after plan pass 1.",
    },
  );

  assert.equal(
    partialTerminalState.status,
    "partial",
    "runs with meaningful skipped challenges should not be marked completed",
  );
  assert.equal(
    partialTerminalState.stopReason,
    "Last blocker: FOF: Answer The Call Crafting Upgrade • Submit Error • Submit failed (512).",
    "partial terminal state should keep the latest actionable failure summary",
  );

  const partialMessage = buildSequenceRuntimePrimaryMessage({
    statusKey: "partial",
    runtimeStatusText: "Submitting FOF: Answer The Call Crafting Upgrade...",
    stopReason: partialTerminalState.stopReason,
    firstErrorMessage: null,
    latestFailureContext: sequenceSolveOverlayState.runState.latestFailureContext,
  });

  assert.equal(
    partialMessage,
    "Partial run. See latest issue below.",
    "partial runtime banner should keep the detailed blocker in the dedicated failure card",
  );

  const cleanTerminalState = resolveSequenceTerminalState(
    {
      status: "running",
      latestFailureContext: null,
      hadSoftFailures: false,
      counters: {
        solved: 3,
        skipped: 0,
        failed: 0,
      },
    },
    {
      abortRequested: false,
      noWorkStopReason: "No remaining work after plan pass 1.",
    },
  );

  assert.equal(
    cleanTerminalState.status,
    "completed",
    "clean runs should still resolve to completed",
  );

  console.log("sequence failure runtime replay: ok");
};

await main();
