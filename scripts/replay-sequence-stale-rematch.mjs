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
  const bodyStart = source.indexOf("{", startIndex);
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
    Date,
    sequenceSolveOverlayState: {
      discovery: {
        sets: [],
        allSets: [],
      },
    },
  });

  const names = [
    "readNumeric",
    "sanitizeDisplayText",
    "SEQUENCE_TARGET_KIND_SINGLE",
    "SEQUENCE_TARGET_KIND_SET_SCOPE",
    "SEQUENCE_SET_SHAPE_SINGLE",
    "SEQUENCE_SET_SHAPE_SET",
    "SEQUENCE_LOOP_COUNT_MIN",
    "SEQUENCE_LOOP_COUNT_MAX",
    "getSequenceSetShape",
    "getSequenceSetShapeFromCount",
    "getSequenceRequiredSetShapeForKind",
    "clampInt",
    "clampSequenceLoopCount",
    "normalizeSequenceMatchText",
    "normalizeSequenceChallengeNames",
    "areSequenceStringListsEqual",
    "normalizeSequenceRequirementsFingerprint",
    "buildSequenceRequirementRuleFingerprint",
    "buildSequenceRequirementsFingerprint",
    "createDefaultSequenceTarget",
    "normalizeSequenceTarget",
    "scoreSequenceRematchCandidate",
    "findSequenceRematchCandidate",
    "syncSequenceTargetMetadataFromSetEntry",
    "ensurePlanSelections",
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

  context.ensureDiscoveryState = () => context.sequenceSolveOverlayState.discovery;
  context.refreshSequenceDiscovery = async () =>
    context.sequenceSolveOverlayState.discovery.sets;
  context.prefetchSetChallengeInfo = async () => ({
    challenges: [],
    requirementsByChallengeId: new Map(),
  });
  context.getCompatibleSetsForKind = (kind) => {
    const requiredShape = context.getSequenceRequiredSetShapeForKind(kind);
    return context.sequenceSolveOverlayState.discovery.sets.filter(
      (entry) => context.getSequenceSetShape(entry?.setShape) === requiredShape,
    );
  };

  return context;
};

const main = async () => {
  const source = await readSource();
  const harness = createHarness(source);
  const { normalizeSequenceTarget, ensurePlanSelections, sequenceSolveOverlayState } =
    harness;

  const preservedTarget = normalizeSequenceTarget({
    kind: "set_scope",
    setId: 101,
    setName: "Daily Bronze Upgrade",
    setShape: "set",
    challengesCount: 2,
    challengeNames: ["Bronze Squad 1", "Bronze Squad 2"],
    requirementsFingerprint: "bronze-1|bronze-2",
  });

  assert.deepEqual(
    preservedTarget.challengeNames,
    ["Bronze Squad 1", "Bronze Squad 2"],
    "normalizeSequenceTarget should preserve challenge names for stale rematching",
  );
  assert.equal(
    preservedTarget.requirementsFingerprint,
    "bronze-1|bronze-2",
    "normalizeSequenceTarget should preserve requirement fingerprints for stale rematching",
  );

  sequenceSolveOverlayState.discovery.sets = [
    {
      id: 202,
      name: "Daily Bronze Upgrade",
      setShape: "set",
      challengesCount: 2,
      isCompletable: true,
      challengeNames: ["Bronze Squad 1", "Bronze Squad 2"],
      requirementsFingerprint: "bronze-1|bronze-2",
    },
    {
      id: 303,
      name: "Daily Bronze Upgrade",
      setShape: "set",
      challengesCount: 2,
      isCompletable: true,
      challengeNames: ["Mixed Squad 1", "Mixed Squad 2"],
      requirementsFingerprint: "mixed-1|mixed-2",
    },
  ];
  sequenceSolveOverlayState.discovery.allSets =
    sequenceSolveOverlayState.discovery.sets.slice();

  const remapPlan = {
    steps: [
      {
        id: "step-1",
        target: preservedTarget,
        loopCount: 1,
      },
    ],
  };

  const remapped = await ensurePlanSelections(remapPlan, {
    forceChallenges: false,
  });

  assert.equal(
    remapped,
    true,
    "ensurePlanSelections should report a change when a stale target remaps",
  );
  assert.equal(
    remapPlan.steps[0].target.setId,
    202,
    "ensurePlanSelections should remap stale targets to the unique matching set",
  );

  sequenceSolveOverlayState.discovery.sets = [
    {
      id: 202,
      name: "Daily Bronze Upgrade",
      setShape: "set",
      challengesCount: 2,
      isCompletable: true,
      challengeNames: ["Bronze Squad 1", "Bronze Squad 2"],
      requirementsFingerprint: "bronze-1|bronze-2",
    },
    {
      id: 303,
      name: "Daily Bronze Upgrade",
      setShape: "set",
      challengesCount: 2,
      isCompletable: true,
      challengeNames: ["Bronze Squad 1", "Bronze Squad 2"],
      requirementsFingerprint: "bronze-1|bronze-2",
    },
  ];
  sequenceSolveOverlayState.discovery.allSets =
    sequenceSolveOverlayState.discovery.sets.slice();

  const ambiguousPlan = {
    steps: [
      {
        id: "step-2",
        target: normalizeSequenceTarget({
          kind: "set_scope",
          setId: 101,
          setName: "Daily Bronze Upgrade",
          setShape: "set",
          challengesCount: 2,
          challengeNames: ["Bronze Squad 1", "Bronze Squad 2"],
          requirementsFingerprint: "bronze-1|bronze-2",
        }),
        loopCount: 1,
      },
    ],
  };

  const ambiguousChanged = await ensurePlanSelections(ambiguousPlan, {
    forceChallenges: false,
  });

  assert.equal(
    ambiguousChanged,
    false,
    "ensurePlanSelections should leave ambiguous stale targets unresolved",
  );
  assert.equal(
    ambiguousPlan.steps[0].target.setId,
    101,
    "ambiguous stale targets should keep their saved set id until the user reselects",
  );

  console.log("sequence stale rematch replay: ok");
};

await main();
