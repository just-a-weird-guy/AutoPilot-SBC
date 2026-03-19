import fs from "node:fs/promises";
import path from "node:path";
import { buildSolverContext, solveSquad } from "../solver/solver.js";
import { compileConstraintSet } from "../solver/constraint-compiler.js";

const rootDir = process.cwd();
const requirementsPath = path.resolve(
  rootDir,
  "data/ea-sbc-requirements-2026-02-13T19-27-15-155Z.json",
);
const playersPath = path.resolve(rootDir, "data/players.json");

const ensureArray = (value) => (Array.isArray(value) ? value : []);

const parseBoolArg = (value, fallback = false) => {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  return fallback;
};

const readJson = async (filePath) => JSON.parse(await fs.readFile(filePath, "utf8"));

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
      else if (
        Array.isArray(value) &&
        value.length === 1 &&
        typeof value[0] === "number"
      ) {
        normalized.derivedCount = value[0];
      }
    }
    return normalized;
  });

const toChallengeSignature = (constraints) =>
  (constraints || [])
    .map((constraint) => {
      const values = JSON.stringify(constraint.values || []);
      const target = constraint.target ?? "null";
      return `${constraint.type}|${constraint.op ?? "null"}|${target}|${values}`;
    })
    .sort()
    .join(" || ");

const isTotwPlayer = (player) => {
  const rarity = String(player?.rarityName ?? "").trim().toLowerCase();
  if (
    rarity.includes("team of the week") ||
    rarity.includes("totw") ||
    rarity.includes("inform")
  ) {
    return true;
  }
  return Number(player?.rarityId) === 3;
};

const countPoolTypes = (players) => {
  let totw = 0;
  let otherSpecial = 0;
  let regular = 0;
  for (const player of players) {
    if (isTotwPlayer(player)) totw += 1;
    else if (player?.isSpecial) otherSpecial += 1;
    else regular += 1;
  }
  return { total: players.length, totw, otherSpecial, regular };
};

const summarizeContextPlayers = (players, filters) =>
  countPoolTypes(buildSolverContext({ players, filters }).players);

const toStamp = () => new Date().toISOString().replace(/[:.]/g, "-");

const scenarioOutputPath = (name) =>
  path.resolve(rootDir, `data/replay-totw-${name}-${toStamp()}.json`);

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const main = async () => {
  const argv = process.argv.slice(2);
  const writeReports = !argv.includes("--no-write");
  const printRows = parseBoolArg(
    argv.includes("--print-rows") ? argv[argv.indexOf("--print-rows") + 1] : false,
    false,
  );

  const requirementsJson = await readJson(requirementsPath);
  const playersJson = await readJson(playersPath);
  const players = dedupePlayersById(extractPlayers(playersJson));
  const records = dedupeRecordsByChallenge(extractRecords(requirementsJson)).sort(
    (left, right) => (Date.parse(left?.openedAt || "") || 0) - (Date.parse(right?.openedAt || "") || 0),
  );

  const baselineCounts = summarizeContextPlayers(players, {
    excludeSpecial: false,
    useTotwPlayers: true,
  });
  const scenarios = [
    {
      name: "all-on",
      filters: { excludeSpecial: false, useTotwPlayers: true },
      expectedFilteredCount: baselineCounts.total,
    },
    {
      name: "exclude-special-on",
      filters: { excludeSpecial: true, useTotwPlayers: true },
      expectedFilteredCount: baselineCounts.total - baselineCounts.otherSpecial,
    },
    {
      name: "totw-off",
      filters: { excludeSpecial: false, useTotwPlayers: false },
      expectedFilteredCount: baselineCounts.total - baselineCounts.totw,
    },
    {
      name: "exclude-special-on-totw-off",
      filters: { excludeSpecial: true, useTotwPlayers: false },
      expectedFilteredCount: baselineCounts.regular,
    },
  ];

  const reports = [];
  for (const scenario of scenarios) {
    const rows = [];
    let observedFilteredCount = null;
    for (const record of records) {
      const requirements = normalizeRecordedRequirements(record?.requirementsNormalized);
      const fallbackSquadSize = Number(record?.squadSize) || 11;
      const compiled = compileConstraintSet(requirements, {
        fallbackSquadSize,
      });
      const signature = toChallengeSignature(compiled.constraints);
      const context = buildSolverContext({
        players,
        requirementsNormalized: requirements,
        debug: false,
        filters: scenario.filters,
      });
      const contextFilteredCount = Array.isArray(context?.players)
        ? context.players.length
        : 0;
      const solveResult = solveSquad(context);
      const failingRequirements = ensureArray(solveResult?.failingRequirements);
      const solved =
        ensureArray(solveResult?.solutions).length > 0 && failingRequirements.length === 0;
      const stats = solveResult?.stats ?? null;
      if (observedFilteredCount == null) {
        observedFilteredCount = contextFilteredCount;
      }
      rows.push({
        challengeId: record?.challengeId ?? null,
        setId: record?.setId ?? null,
        challengeName: record?.challengeName ?? null,
        signature,
        solved,
        contextFilteredCount,
        filteredPlayerCount: Number(stats?.filteredPlayerCount) || 0,
        failingTypes: Array.from(
          new Set(
            compileConstraintSet(failingRequirements, {
              fallbackSquadSize: compiled.summary.squadSizeTarget || fallbackSquadSize,
            }).constraints.map((constraint) => constraint.type),
          ),
        ),
        requiresSpecialRarity: (compiled.constraints || []).some(
          (constraint) =>
            constraint.type === "player_rarity" || constraint.type === "player_inform",
        ),
      });
    }

    assert(
      observedFilteredCount === scenario.expectedFilteredCount,
      `${scenario.name} expected filtered count ${scenario.expectedFilteredCount} but got ${observedFilteredCount}`,
    );

    const solvedRows = rows.filter((row) => row.solved === true);
    const specialRows = rows.filter((row) => row.requiresSpecialRarity);
    if (scenario.name === "all-on") {
      assert(
        specialRows.every((row) => row.solved),
        "all-on should solve every recorded TOTW-required challenge",
      );
    }
    if (scenario.name === "totw-off" || scenario.name === "exclude-special-on-totw-off") {
      assert(
        specialRows.every(
          (row) =>
            !row.solved &&
            row.failingTypes.includes("player_rarity"),
        ),
        `${scenario.name} should fail every recorded TOTW-required challenge on rarity constraints`,
      );
    }
    if (scenario.name === "exclude-special-on") {
      assert(
        specialRows.every(
          (row) =>
            row.solved || !row.failingTypes.includes("player_rarity"),
        ),
        "exclude-special-on must not fail recorded TOTW-required challenges because TOTW was removed",
      );
      const ratingOnlyRow = specialRows.find(
        (row) => String(row.challengeId) === "1545",
      );
      assert(
        ratingOnlyRow &&
          ratingOnlyRow.solved === false &&
          ratingOnlyRow.failingTypes.length === 1 &&
          ratingOnlyRow.failingTypes[0] === "team_rating",
        "exclude-special-on should only miss challenge 1545 on rating, not on TOTW rarity",
      );
    }

    const report = {
      generatedAt: new Date().toISOString(),
      mode: "replay",
      inputs: {
        requirementsPath,
        playersPath,
        challengeRecords: rows.length,
        players: players.length,
        dedupedChallenges: true,
        excludeSpecial: scenario.filters.excludeSpecial,
        useTotwPlayers: scenario.filters.useTotwPlayers,
      },
      poolCounts: baselineCounts,
      summary: {
        solved: solvedRows.length,
        unsolved: rows.length - solvedRows.length,
        solveRatePct: rows.length
          ? Math.round((solvedRows.length / rows.length) * 10000) / 100
          : 0,
        filteredPlayerCount: observedFilteredCount,
        specialRequirementSolved: specialRows.filter((row) => row.solved).length,
        specialRequirementTotal: specialRows.length,
      },
      results: rows,
    };

    if (writeReports) {
      const outputPath = scenarioOutputPath(scenario.name);
      await fs.writeFile(outputPath, JSON.stringify(report, null, 2), "utf8");
      report.outputPath = outputPath;
    }
    reports.push(report);
  }

  console.log(JSON.stringify(
    reports.map((report) => ({
      name: `${report.inputs.excludeSpecial ? "exclude-special-on" : "exclude-special-off"}/${report.inputs.useTotwPlayers ? "totw-on" : "totw-off"}`,
      filteredPlayerCount: report.summary.filteredPlayerCount,
      solved: report.summary.solved,
      unsolved: report.summary.unsolved,
      solveRatePct: report.summary.solveRatePct,
      specialRequirementSolved: report.summary.specialRequirementSolved,
      specialRequirementTotal: report.summary.specialRequirementTotal,
      outputPath: report.outputPath ?? null,
    })),
    null,
    2,
  ));

  if (printRows) {
    for (const report of reports) {
      console.log(`\n[${report.inputs.excludeSpecial ? "exclude-special-on" : "exclude-special-off"}/${report.inputs.useTotwPlayers ? "totw-on" : "totw-off"}]`);
      for (const row of report.results.filter((entry) => entry.requiresSpecialRarity)) {
        console.log(
          `- set:${row.setId} challenge:${row.challengeId} solved:${row.solved} name:${row.challengeName}`,
        );
      }
    }
  }
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
