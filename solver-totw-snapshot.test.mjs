import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { filterPlayersBySolverPoolSettings } from "./solver/pool-filter.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const fixturePath = path.join(__dirname, "data", "players-totw-snapshot.json");
const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
const players = Array.isArray(fixture?.players) ? fixture.players : [];

const test = (name, fn) => {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
};

const ids = (filteredPlayers) => filteredPlayers.map((player) => player.id);

test("snapshot fixture contains TOTW, non-TOTW special, and regular players", () => {
  assert.equal(players.length, 5);
  assert.equal(players.filter((player) => Number(player.rarityId) === 3).length, 2);
  assert.equal(players.filter((player) => player.isSpecial && Number(player.rarityId) !== 3).length, 1);
  assert.equal(players.filter((player) => !player.isSpecial).length, 2);
});

test("snapshot combinations keep TOTW separate from other special cards", () => {
  const scenarios = [
    {
      name: "all enabled",
      settings: { excludeSpecial: false, useTotwPlayers: true },
      expected: [769736146992, 763651525742, 769736146990, 765493455676, 769736210674],
    },
    {
      name: "exclude specials only",
      settings: { excludeSpecial: true, useTotwPlayers: true },
      expected: [769736146992, 763651525742, 765493455676, 769736210674],
    },
    {
      name: "exclude TOTW only",
      settings: { excludeSpecial: false, useTotwPlayers: false },
      expected: [769736146990, 765493455676, 769736210674],
    },
    {
      name: "exclude both",
      settings: { excludeSpecial: true, useTotwPlayers: false },
      expected: [765493455676, 769736210674],
    },
  ];

  for (const scenario of scenarios) {
    const result = filterPlayersBySolverPoolSettings(players, scenario.settings);
    assert.deepEqual(ids(result.filteredPlayers), scenario.expected, scenario.name);
  }
});

test("required snapshot players still bypass pool exclusions", () => {
  const result = filterPlayersBySolverPoolSettings(
    players,
    { excludeSpecial: true, useTotwPlayers: false },
    { requiredIds: [769736146992, 769736146990] },
  );

  assert.deepEqual(ids(result.filteredPlayers), [769736146992, 769736146990, 765493455676, 769736210674]);
});
