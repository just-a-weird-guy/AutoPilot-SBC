import fs from "node:fs/promises";
import path from "node:path";
import { buildSolverContext, solveSquad } from "../solver/solver.js";
import { compileConstraintSet } from "../solver/constraint-compiler.js";

const usage = `
Replay recorded EA SBC challenge requirements against a player pool.

Usage:
  node scripts/replay-recorded-challenges.mjs --requirements <file> --players <file> [options]

Options:
  --requirements <file>   Path to recorder export JSON (required)
  --players <file>        Path to players JSON (required unless --compile-only)
  --slots <file>          Optional slot plan JSON for chemistry solving
  --ignore-chemistry      Disable chemistry constraints during replay
  --use-evolution-players <bool>  Allow evolution players in solve pool (default: false)
  --report <file>         Output report path (default: replay-report-<timestamp>.json)
  --all-records           Replay all opens (default dedupes by setId+challengeId)
  --top <number>          Number of unsolved rows to print (default: 10)
  --compile-only          Skip solve, only compile constraints and signatures
  --help                  Show this help

Players JSON accepted shapes:
  - [Player, ...]
  - { "players": [Player, ...] }
  - { "clubPlayers": [...], "storagePlayers": [...] }
  - { "data": { "players": [...] } }
`;

const toIsoFileStamp = () => new Date().toISOString().replace(/[:.]/g, "-");

const DEFAULT_CHEMISTRY_SLOT_PLAN = [
  "GK",
  "RB",
  "CB",
  "CB",
  "LB",
  "CDM",
  "CDM",
  "RM",
  "CAM",
  "LM",
  "ST",
];

const parseBoolArg = (value, fallback = false) => {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  return fallback;
};

const parseArgs = (argv) => {
  const args = {
    requirements: null,
    players: null,
    slots: null,
    ignoreChemistry: false,
    useEvolutionPlayers: false,
    report: null,
    allRecords: false,
    top: 10,
    compileOnly: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help" || token === "-h") {
      args.help = true;
      continue;
    }
    if (token === "--all-records") {
      args.allRecords = true;
      continue;
    }
    if (token === "--compile-only") {
      args.compileOnly = true;
      continue;
    }
    if (token === "--ignore-chemistry") {
      args.ignoreChemistry = true;
      continue;
    }
    if (token === "--requirements") {
      args.requirements = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (token === "--players") {
      args.players = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (token === "--slots") {
      args.slots = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (token === "--use-evolution-players") {
      args.useEvolutionPlayers = parseBoolArg(argv[index + 1], false);
      index += 1;
      continue;
    }
    if (token === "--report") {
      args.report = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (token === "--top") {
      const value = Number.parseInt(argv[index + 1] ?? "10", 10);
      if (Number.isFinite(value) && value > 0) args.top = value;
      index += 1;
      continue;
    }
  }

  return args;
};

const readJson = async (filePath) => {
  const content = await fs.readFile(filePath, "utf8");
  return JSON.parse(content);
};

const extractPlayers = (raw) => {
  if (Array.isArray(raw)) return raw;
  if (!raw || typeof raw !== "object") return [];

  const direct = Array.isArray(raw.players) ? raw.players : [];
  const club = Array.isArray(raw.clubPlayers) ? raw.clubPlayers : [];
  const storage = Array.isArray(raw.storagePlayers) ? raw.storagePlayers : [];
  const dataPlayers = Array.isArray(raw.data?.players) ? raw.data.players : [];
  const dataClub = Array.isArray(raw.data?.clubPlayers) ? raw.data.clubPlayers : [];
  const dataStorage = Array.isArray(raw.data?.storagePlayers)
    ? raw.data.storagePlayers
    : [];

  return direct.concat(club, storage, dataPlayers, dataClub, dataStorage);
};

const dedupePlayersById = (players) => {
  const seen = new Set();
  const deduped = [];
  for (const player of players || []) {
    if (!player || player.id == null) continue;
    if (seen.has(player.id)) continue;
    seen.add(player.id);
    deduped.push(player);
  }
  return deduped;
};

const extractRecords = (raw) => {
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw?.records)) return raw.records;
  return [];
};

const dedupeRecordsByChallenge = (records) => {
  const byChallenge = new Map();
  for (const record of records) {
    if (!record) continue;
    const challengeId = record.challengeId ?? "unknown";
    const setId = record.setId ?? "unknown";
    const key = `${setId}:${challengeId}`;
    const existing = byChallenge.get(key);
    if (!existing) {
      byChallenge.set(key, record);
      continue;
    }
    const existingAt = Date.parse(existing.openedAt || "") || 0;
    const currentAt = Date.parse(record.openedAt || "") || 0;
    if (currentAt >= existingAt) byChallenge.set(key, record);
  }
  return Array.from(byChallenge.values());
};

const countBy = (items, keyFn) => {
  const map = new Map();
  for (const item of items) {
    const key = keyFn(item);
    map.set(key, (map.get(key) || 0) + 1);
  }
  return Object.fromEntries(
    Array.from(map.entries()).sort((left, right) => right[1] - left[1])
  );
};

const toChallengeSignature = (constraints) =>
  (constraints || [])
    .map((constraint) => {
      const values = JSON.stringify(constraint.values || []);
      const target = constraint.target ?? "null";
      return `${constraint.type}|${constraint.op ?? "null"}|${target}|${values}`;
    })
    .sort()
    .join(" || ");

const ensureArray = (value) => (Array.isArray(value) ? value : []);

const asNumber = (value) => (Number.isFinite(Number(value)) ? Number(value) : null);

const IDENTITY_PLAYER_FIELDS = {
  club_id: "teamId",
  nation_id: "nationId",
  league_id: "leagueId",
};

const buildDefaultSlotPlan = (requiredPlayers) => {
  const size = Number(requiredPlayers) || 11;
  const positionNames = DEFAULT_CHEMISTRY_SLOT_PLAN.slice(0, size);
  if (positionNames.length < size) return null;
  return {
    requiredPlayers: size,
    squadSlots: positionNames.map((positionName, slotIndex) => ({
      slotIndex,
      positionName,
    })),
    source: "default-chemistry-fallback",
  };
};

const buildRecordedSlotPlan = (record, requiredPlayers) => {
  const squadSlots = ensureArray(record?.squadSlots)
    .map((slot, slotIndex) => ({
      slotId: slot?.slotId ?? null,
      slotIndex: asNumber(slot?.slotIndex) ?? slotIndex,
      positionName: String(slot?.positionName ?? "").trim() || null,
    }))
    .filter((slot) => slot.positionName);
  const size = asNumber(requiredPlayers) || squadSlots.length;
  if (!squadSlots.length) return null;
  if (size > 0 && squadSlots.length < size) return null;
  return {
    requiredPlayers: size || squadSlots.length,
    squadSlots: size > 0 ? squadSlots.slice(0, size) : squadSlots,
    source: record?.slotSource || "recorded-slots",
  };
};

const buildIdentityCoverageIndex = (players) => {
  const index = {
    club_id: new Map(),
    nation_id: new Map(),
    league_id: new Map(),
  };

  for (const player of players || []) {
    if (!player || typeof player !== "object") continue;
    for (const [constraintType, playerField] of Object.entries(IDENTITY_PLAYER_FIELDS)) {
      const numericValue = asNumber(player?.[playerField]);
      if (numericValue == null) continue;
      const bucket = index[constraintType];
      bucket.set(numericValue, (bucket.get(numericValue) || 0) + 1);
    }
  }

  return index;
};

const analyzeIdentityCoverage = (constraints, identityCoverageIndex) => {
  const identityConstraints = ensureArray(constraints)
    .filter((constraint) => IDENTITY_PLAYER_FIELDS[constraint?.type])
    .map((constraint) => {
      const valueCoverage = ensureArray(constraint?.values)
        .map((value) => asNumber(value))
        .filter((value) => value != null)
        .map((value) => ({
          value,
          matchingPlayers:
            identityCoverageIndex?.[constraint.type]?.get(value) || 0,
        }));
      const totalMatchingPlayers = valueCoverage.reduce(
        (sum, entry) => sum + entry.matchingPlayers,
        0,
      );
      const target = asNumber(constraint?.target);
      const poolShortageLikely =
        (constraint?.op === "min" || constraint?.op === "exact") &&
        target != null &&
        totalMatchingPlayers < target;

      return {
        type: constraint?.type ?? null,
        op: constraint?.op ?? null,
        target,
        values: valueCoverage.map((entry) => entry.value),
        matchedValueIds: valueCoverage
          .filter((entry) => entry.matchingPlayers > 0)
          .map((entry) => entry.value),
        missingValueIds: valueCoverage
          .filter((entry) => entry.matchingPlayers === 0)
          .map((entry) => entry.value),
        totalMatchingPlayers,
        perValueMatchingPlayers: valueCoverage,
        poolShortageLikely,
      };
    });

  return {
    identityConstraints,
    likelyMissingCoverage: identityConstraints.some(
      (constraint) => constraint.poolShortageLikely,
    ),
  };
};

const scopeNameToOp = (scopeName) => {
  if (!scopeName) return null;
  const normalized = String(scopeName).toUpperCase();
  if (normalized.includes("MIN")) return "min";
  if (normalized.includes("MAX")) return "max";
  if (normalized.includes("GREATER")) return "min";
  if (normalized.includes("LOWER")) return "max";
  if (normalized.includes("LESS")) return "max";
  if (normalized.includes("EXACT")) return "exact";
  if (normalized.includes("RANGE")) return "range";
  return null;
};

const normalizeRecordedRequirements = (rules) =>
  ensureArray(rules).map((rule) => {
    if (!rule || typeof rule !== "object") return rule;
    const normalized = { ...rule };
    if (!normalized.op) {
      normalized.op = scopeNameToOp(normalized.scopeName) ?? normalized.op ?? null;
    }
    if (normalized.derivedCount == null && normalized.count === -1) {
      const value = normalized.value;
      if (typeof value === "number") normalized.derivedCount = value;
      else if (Array.isArray(value) && value.length === 1 && typeof value[0] === "number") {
        normalized.derivedCount = value[0];
      }
    }
    return normalized;
  });

const run = async () => {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage.trim());
    return;
  }

  if (!args.requirements) {
    throw new Error("Missing --requirements <file>");
  }
  if (!args.compileOnly && !args.players) {
    throw new Error("Missing --players <file> (or use --compile-only)");
  }

  const requirementsPath = path.resolve(args.requirements);
  const requirementsJson = await readJson(requirementsPath);
  let records = extractRecords(requirementsJson);
  records = args.allRecords ? records : dedupeRecordsByChallenge(records);
  records = records
    .filter(Boolean)
    .sort((left, right) => {
      const leftAt = Date.parse(left?.openedAt || "") || 0;
      const rightAt = Date.parse(right?.openedAt || "") || 0;
      return leftAt - rightAt;
    });

  let playersPath = null;
  let players = [];
  let identityCoverageIndex = null;
  if (!args.compileOnly) {
    playersPath = path.resolve(args.players);
    const playersJson = await readJson(playersPath);
    players = dedupePlayersById(extractPlayers(playersJson));
    if (!players.length) {
      throw new Error("No players parsed from --players file");
    }
    identityCoverageIndex = buildIdentityCoverageIndex(players);
  }

  let slotPlan = null;
  if (args.slots) {
    const slotsPath = path.resolve(args.slots);
    const rawSlots = await readJson(slotsPath);
    const requiredPlayers = Number(rawSlots?.requiredPlayers ?? rawSlots?.squadSize ?? 11);
    const squadSlots = Array.isArray(rawSlots?.squadSlots)
      ? rawSlots.squadSlots
      : Array.isArray(rawSlots?.slots)
      ? rawSlots.slots
      : Array.isArray(rawSlots)
      ? rawSlots
      : [];
    slotPlan = {
      requiredPlayers,
      squadSlots,
    };
  }

  const rows = [];
  for (const record of records) {
    const requirements = normalizeRecordedRequirements(record?.requirementsNormalized);
    const fallbackSquadSize = asNumber(record?.squadSize) || 11;
    const chemistryNeeded = requirements.some(
      (rule) =>
        rule?.type === "chemistry_points" ||
        rule?.type === "all_players_chemistry_points",
    );
    const recordedSlotPlan = buildRecordedSlotPlan(record, fallbackSquadSize);
    const effectiveSlotPlan =
      slotPlan || recordedSlotPlan || (chemistryNeeded ? buildDefaultSlotPlan(fallbackSquadSize) : null);
    const compiled = compileConstraintSet(requirements, {
      fallbackSquadSize,
    });
    const signature = toChallengeSignature(compiled.constraints);
    const playerPoolCoverage = args.compileOnly
      ? null
      : analyzeIdentityCoverage(compiled.constraints, identityCoverageIndex);

    let solveResult = null;
    let solved = null;
    let evoUsedCount = null;
    let failingCompiled = { constraints: [], summary: {} };
    if (!args.compileOnly) {
      const context = buildSolverContext({
        players,
        requirementsNormalized: requirements,
        requirementOverrides: args.ignoreChemistry
          ? {
              chemistry_points: false,
              all_players_chemistry_points: false,
            }
          : {},
        debug: false,
        filters: {
          useEvolutionPlayers: args.useEvolutionPlayers,
        },
        requiredPlayers: effectiveSlotPlan?.requiredPlayers ?? null,
        squadSlots: effectiveSlotPlan?.squadSlots ?? null,
      });
      solveResult = solveSquad(context);
      const failingRequirements = ensureArray(solveResult?.failingRequirements);
      failingCompiled = compileConstraintSet(failingRequirements, {
        fallbackSquadSize:
          compiled.summary.squadSizeTarget || fallbackSquadSize,
      });
      solved =
        ensureArray(solveResult?.solutions).length > 0 &&
        failingRequirements.length === 0;
      const solutionPlayers = ensureArray(solveResult?.solutions).flatMap(
        (solution) => ensureArray(solution?.players)
      );
      const evoIds = new Set(
        solutionPlayers
          .filter((player) => Boolean(player?.isEvolution ?? player?.upgrades))
          .map((player) => (player?.id == null ? null : String(player.id)))
          .filter(Boolean)
      );
      evoUsedCount = evoIds.size;
    }

    const failingTypes = Array.from(
      new Set((failingCompiled.constraints || []).map((constraint) => constraint.type))
    );
    const failingLabels = Array.from(
      new Set(
        ensureArray(solveResult?.failingRequirements)
          .map((rule) => rule?.label || null)
          .filter(Boolean)
      )
    );

    rows.push({
      challengeId: record?.challengeId ?? null,
      setId: record?.setId ?? null,
      challengeName: record?.challengeName ?? null,
      openedAt: record?.openedAt ?? null,
      formationName: record?.formationName ?? null,
      formationCode: record?.formationCode ?? null,
      slotPlanSource: effectiveSlotPlan?.source || (slotPlan ? "input-slots" : null),
      signature,
      constraintCount: compiled.summary.compiledCount || 0,
      constraintTypes: Array.from(
        new Set((compiled.constraints || []).map((constraint) => constraint.type))
      ),
      constraintCategories: Object.keys(compiled.summary.byCategory || {}),
      squadSizeTarget: compiled.summary.squadSizeTarget ?? null,
      teamRatingTarget: compiled.summary.teamRatingTarget ?? null,
      solved,
      failingTypes,
      failingLabels,
      solveStats: solveResult?.stats ?? null,
      evoUsedCount,
      playerPoolCoverage,
    });
  }

  const solvedRows = rows.filter((row) => row.solved === true);
  const unsolvedRows = rows.filter((row) => row.solved === false);
  const constrainedRows = rows.filter((row) => row.constraintCount > 0);
  const solveRatePct =
    args.compileOnly || !rows.length
      ? null
      : Math.round((solvedRows.length / rows.length) * 10000) / 100;

  const report = {
    generatedAt: new Date().toISOString(),
    mode: args.compileOnly ? "compile-only" : "replay",
    inputs: {
      requirementsPath,
      playersPath,
      challengeRecords: rows.length,
      players: players.length,
      dedupedChallenges: !args.allRecords,
      useEvolutionPlayers: args.useEvolutionPlayers,
      ignoreChemistry: args.ignoreChemistry,
      providedSlots: Boolean(slotPlan),
    },
    summary: {
      solved: solvedRows.length,
      unsolved: unsolvedRows.length,
      solveRatePct,
      withConstraints: constrainedRows.length,
      signatures: countBy(rows, (row) => row.signature || "none"),
      constraintTypes: countBy(
        rows.flatMap((row) => row.constraintTypes || []),
        (type) => type || "unknown"
      ),
      constraintCategories: countBy(
        rows.flatMap((row) => row.constraintCategories || []),
        (category) => category || "unknown"
      ),
      unsolvedTypes: countBy(
        unsolvedRows.flatMap((row) => row.failingTypes || []),
        (type) => type || "unknown"
      ),
      slotPlanSources: countBy(
        rows.map((row) => row.slotPlanSource || "none"),
        (source) => source || "none"
      ),
      likelyMissingCoverage: unsolvedRows.filter(
        (row) => row.playerPoolCoverage?.likelyMissingCoverage,
      ).length,
      evoUsedAcrossSolved: solvedRows.reduce(
        (total, row) => total + (Number(row.evoUsedCount) || 0),
        0
      ),
    },
    results: rows,
  };

  const defaultReport = path.resolve(
    `replay-report-${toIsoFileStamp()}.json`
  );
  const reportPath = args.report ? path.resolve(args.report) : defaultReport;
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");

  console.log("[Replay] Report written:", reportPath);
  console.log(
    `[Replay] Challenges: ${rows.length}, Solved: ${solvedRows.length}, Unsolved: ${unsolvedRows.length}`
  );
  if (!args.compileOnly) {
    console.log(`[Replay] Solve rate: ${solveRatePct}%`);
  }

  if (unsolvedRows.length) {
    console.log(`[Replay] Top ${Math.min(args.top, unsolvedRows.length)} unsolved:`);
    for (const row of unsolvedRows.slice(0, args.top)) {
      console.log(
        `- [set:${row.setId} id:${row.challengeId}] ${row.challengeName || "Unknown"} | failing=${(row.failingTypes || []).join(", ") || "n/a"} | coverage=${row.playerPoolCoverage?.likelyMissingCoverage ? "likely-missing" : "ok"}`
      );
    }
  }
};

run().catch((error) => {
  console.error("[Replay] Failed:", error?.message || error);
  process.exitCode = 1;
});
