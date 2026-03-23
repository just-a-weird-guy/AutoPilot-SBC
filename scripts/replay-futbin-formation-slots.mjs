import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { buildSolverContext, solveSquad } from "../solver/solver.js";

const execFile = promisify(execFileCallback);

const rootDir = process.cwd();
const rawPath = path.resolve(rootDir, "data/futbin-challenges-sample-raw.json");
const playersPath = path.resolve(rootDir, "data/players.json");
const compiledPath = path.join(
  os.tmpdir(),
  `futbin-challenges-sample-compiled-${Date.now()}.json`,
);

const rawJson = JSON.parse(await fs.readFile(rawPath, "utf8"));
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

assert.ok(players.length > 0, "players fixture should contain players");

const rawChallenge = rawJson?.groups?.[0]?.challenges?.find(
  (entry) => entry?.eaChallengeId === 900001,
);
assert.ok(rawChallenge, "raw fixture should include challenge 900001");
assert.equal(rawChallenge.formationName, "3-5-2");
assert.equal(rawChallenge.formationCode, "352");
assert.equal(rawChallenge.squadSlots?.length, 11);
assert.deepEqual(
  rawChallenge.squadSlots.map((slot) => slot.positionName),
  ["GK", "CB", "CB", "CB", "CDM", "CDM", "LM", "RM", "CAM", "ST", "ST"],
  "raw fixture should preserve ordered Futbin slot positions",
);

await execFile(
  "node",
  [
    "scripts/compile-futbin-marquee.mjs",
    "--input",
    rawPath,
    "--players",
    playersPath,
    "--output",
    compiledPath,
  ],
  { cwd: rootDir },
);

const compiledJson = JSON.parse(await fs.readFile(compiledPath, "utf8"));

const compiledRecord = compiledJson?.records?.find(
  (entry) => entry?.challengeId === 900001,
);
assert.ok(compiledRecord, "compiled fixture should include challenge 900001");
assert.equal(compiledRecord.formationName, "3-5-2");
assert.equal(compiledRecord.formationCode, "352");
assert.equal(compiledRecord.slotSource, "challenge-react-data");
assert.equal(compiledRecord.squadSlots?.length, 11);

const result = solveSquad(
  buildSolverContext({
    players,
    requirementsNormalized: compiledRecord.requirementsNormalized,
    requiredPlayers: compiledRecord.squadSlots?.length ?? 11,
    squadSlots: compiledRecord.squadSlots,
    filters: {
      useEvolutionPlayers: false,
    },
    debug: true,
  }),
);

assert.equal(result?.stats?.solved, true, "challenge should solve with Futbin slots");
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
      challengeId: compiledRecord.challengeId,
      formationName: compiledRecord.formationName,
      formationCode: compiledRecord.formationCode,
      slotSource: compiledRecord.slotSource,
      solved: result?.stats?.solved,
      chemistry: result?.stats?.chemistry ?? null,
    },
    null,
    2,
  ),
);

await fs.rm(compiledPath, { force: true });
