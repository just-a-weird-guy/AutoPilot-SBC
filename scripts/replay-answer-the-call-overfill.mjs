import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { buildSolverContext, solveSquad } from "../solver/solver.js";

const rootDir = process.cwd();
const playersPath = path.resolve(rootDir, "data/players.json");

const playersJson = JSON.parse(await fs.readFile(playersPath, "utf8"));
const players = []
  .concat(Array.isArray(playersJson?.players) ? playersJson.players : [])
  .concat(Array.isArray(playersJson?.clubPlayers) ? playersJson.clubPlayers : [])
  .concat(Array.isArray(playersJson?.storagePlayers) ? playersJson.storagePlayers : [])
  .concat(Array.isArray(playersJson?.data?.players) ? playersJson.data.players : [])
  .concat(
    Array.isArray(playersJson?.data?.clubPlayers)
      ? playersJson.data.clubPlayers
      : [],
  )
  .concat(
    Array.isArray(playersJson?.data?.storagePlayers)
      ? playersJson.data.storagePlayers
      : [],
  );

assert.ok(players.length > 0, "players fixture should contain club players");

const requirementsNormalized = [
  {
    type: "nation_count",
    key: 7,
    keyName: "NATION_COUNT",
    keyNameNormalized: "nation_count",
    typeSource: "enum",
    op: "max",
    count: -1,
    derivedCount: null,
    value: [5],
    scope: 1,
    scopeName: "LOWER",
    label: "Nationalities in Squad: Max. 5",
  },
  {
    type: "same_league_count",
    key: 5,
    keyName: "SAME_LEAGUE_COUNT",
    keyNameNormalized: "same_league_count",
    typeSource: "enum",
    op: "min",
    count: -1,
    derivedCount: null,
    value: [6],
    scope: 0,
    scopeName: "GREATER",
    label: "Players from the same League: Min. 6",
  },
  {
    type: "player_rarity_group",
    key: 18,
    keyName: "PLAYER_RARITY_GROUP",
    keyNameNormalized: "player_rarity_group",
    typeSource: "enum",
    op: "min",
    count: 9,
    derivedCount: null,
    value: [1],
    scope: 0,
    scopeName: "GREATER",
    label: "Rare: Min. 9 Players",
  },
  {
    type: "player_level",
    key: 17,
    keyName: "PLAYER_LEVEL",
    keyNameNormalized: "player_level",
    typeSource: "enum",
    op: "min",
    count: 2,
    derivedCount: null,
    value: [1],
    scope: 0,
    scopeName: "GREATER",
    label: "Gold: Min. 2 Players",
  },
  {
    type: "team_rating",
    key: 19,
    keyName: "TEAM_RATING",
    keyNameNormalized: "team_rating",
    typeSource: "enum",
    op: "min",
    count: -1,
    derivedCount: null,
    value: [74],
    scope: 0,
    scopeName: "GREATER",
    label: "Team Rating: Min. 74",
  },
  {
    type: "chemistry_points",
    key: 35,
    keyName: "CHEMISTRY_POINTS",
    keyNameNormalized: "chemistry_points",
    typeSource: "enum",
    op: "min",
    count: -1,
    derivedCount: null,
    value: [22],
    scope: 0,
    scopeName: "GREATER",
    label: "Total Chemistry: Min. 22",
  },
  {
    type: "players_in_squad",
    key: -1,
    keyName: "PLAYERS_IN_SQUAD",
    keyNameNormalized: "players_in_squad",
    typeSource: "enum",
    op: "exact",
    count: 11,
    derivedCount: null,
    value: [11],
    scope: 2,
    scopeName: "EXACT",
    label: "Number of Players in the Squad: 11",
  },
];

const squadSlots = [
  "GK",
  "CB",
  "CB",
  "CB",
  "CDM",
  "CDM",
  "RM",
  "LM",
  "CAM",
  "ST",
  "ST",
].map((positionName, slotIndex) => ({
  slotIndex,
  positionName,
  isLocked: null,
  isEditable: null,
  isBrick: false,
  isValid: false,
  item: {
    id: 0,
    definitionId: 0,
    concept: false,
  },
}));

const runReplay = (overrides = {}) =>
  solveSquad(
    buildSolverContext({
      players,
      requirementsNormalized,
      debug: true,
      requiredPlayers: 11,
      squadSlots,
      filters: {
        preserveOccupiedSlots: true,
        excludeSpecial: true,
        useTotwPlayers: true,
        ...(overrides?.filters && typeof overrides.filters === "object"
          ? overrides.filters
          : {}),
      },
      ...(overrides && typeof overrides === "object" ? overrides : {}),
    }),
  );

const result = runReplay();
const debugLog = Array.isArray(result?.stats?.debugLog) ? result.stats.debugLog : [];
const prefillEntries = debugLog.filter(
  (entry) => entry?.stage === "filter" && entry?.method === "prefill",
);
const sameLeaguePrefill =
  prefillEntries.find((entry) => entry?.type === "same_league_count") ?? null;
const fillEntry = debugLog.find((entry) => entry?.stage === "fill") ?? null;
const maxPrefillSquadSize = Math.max(
  0,
  ...prefillEntries.map((entry) => Number(entry?.squadSize ?? 0)),
);

assert.equal(
  result?.stats?.solved,
  true,
  "fixture should now solve with the local player pool",
);
assert.ok(prefillEntries.length >= 3, "fixture should include overlapping prefill stages");
assert.ok(
  maxPrefillSquadSize <= 11,
  `prefill should stay within squad size, got ${maxPrefillSquadSize}`,
);
assert.equal(fillEntry?.squadSize, 11, "fill should clamp the working squad back to 11");
assert.ok(
  Number(fillEntry?.lockedCount ?? 0) <= Number(fillEntry?.squadSize ?? 0),
  "lockedCount should not exceed the final squad size",
);
assert.equal(
  sameLeaguePrefill?.filled,
  true,
  "same league prefill should still be able to reserve a valid group",
);
assert.ok(
  Number(sameLeaguePrefill?.squadSize ?? 0) < 11,
  `same league prefill should run before the squad is already full, got ${sameLeaguePrefill?.squadSize}`,
);
assert.ok(
  (result?.stats?.squadRating ?? 0) >= 74,
  `solved replay should reach the target rating, got ${result?.stats?.squadRating}`,
);
assert.ok(
  (result?.stats?.chemistry?.totalChem ?? 0) >= 22,
  `solved replay should reach the chemistry target, got ${result?.stats?.chemistry?.totalChem}`,
);
assert.deepEqual(
  Array.isArray(result?.failingRequirements)
    ? result.failingRequirements.map((entry) => entry?.type ?? null)
    : [],
  [],
  "solved replay should not leave failing requirements",
);

console.log(
  JSON.stringify(
    {
      filters: {
        preserveOccupiedSlots: true,
        excludeSpecial: true,
        useTotwPlayers: true,
      },
      solved: result?.stats?.solved,
      squadRating: result?.stats?.squadRating,
      chemistry: result?.stats?.chemistry ?? null,
      failingTypes: Array.isArray(result?.failingRequirements)
        ? result.failingRequirements.map((entry) => entry?.type ?? null)
        : [],
      prefill: prefillEntries.map((entry) => ({
        type: entry?.type ?? null,
        required: entry?.required ?? null,
        originalRequired: entry?.originalRequired ?? null,
        slotSatisfied: entry?.slotSatisfied ?? null,
        squadSize: entry?.squadSize ?? null,
        filled: entry?.filled ?? null,
      })),
      fill: {
        squadSize: fillEntry?.squadSize ?? null,
        lockedCount: fillEntry?.lockedCount ?? null,
      },
      maxPrefillSquadSize,
    },
    null,
    2,
  ),
);
