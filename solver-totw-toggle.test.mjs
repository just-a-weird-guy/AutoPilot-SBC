import assert from "node:assert/strict";
import { filterPlayersBySolverPoolSettings } from "./solver/pool-filter.js";

const test = (name, fn) => {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
};

const makePlayer = ({
  id,
  rarityId = 0,
  rarityName = null,
  isSpecial = false,
} = {}) => ({
  id,
  rarityId,
  rarityName,
  isSpecial,
});

test("Exclude Special removes promo specials but keeps TOTW when TOTW toggle is on", () => {
  const players = [
    makePlayer({ id: 1, rarityId: 3, rarityName: "Team of the Week", isSpecial: true }),
    makePlayer({ id: 2, rarityId: 42, rarityName: "Fantasy FC", isSpecial: true }),
    makePlayer({ id: 3, rarityId: 0, rarityName: "Common", isSpecial: false }),
  ];

  const filtered = filterPlayersBySolverPoolSettings(players, {
    excludeSpecial: true,
    useTotwPlayers: true,
  }).filteredPlayers;

  assert.deepEqual(
    filtered.map((player) => player.id),
    [1, 3],
  );
});

test("Use TOTW Players off removes TOTW but keeps non-TOTW specials when Exclude Special is off", () => {
  const players = [
    makePlayer({ id: 1, rarityId: 3, rarityName: "Inform", isSpecial: true }),
    makePlayer({ id: 2, rarityId: 18, rarityName: "RTTK", isSpecial: true }),
    makePlayer({ id: 3, rarityId: 0, rarityName: "Common", isSpecial: false }),
  ];

  const filtered = filterPlayersBySolverPoolSettings(players, {
    excludeSpecial: false,
    useTotwPlayers: false,
  }).filteredPlayers;

  assert.deepEqual(
    filtered.map((player) => player.id),
    [2, 3],
  );
});

test("TOTW can still be recognized through rarity id fallback", () => {
  const players = [
    makePlayer({ id: 1, rarityId: 3, rarityName: null, isSpecial: true }),
    makePlayer({ id: 2, rarityId: 7, rarityName: null, isSpecial: true }),
  ];

  const filtered = filterPlayersBySolverPoolSettings(players, {
    excludeSpecial: true,
    useTotwPlayers: true,
  }).filteredPlayers;

  assert.deepEqual(
    filtered.map((player) => player.id),
    [1],
  );
});

test("required players bypass both TOTW and special exclusions", () => {
  const players = [
    makePlayer({ id: 1, rarityId: 3, rarityName: "TOTW", isSpecial: true }),
    makePlayer({ id: 2, rarityId: 25, rarityName: "Promo", isSpecial: true }),
  ];

  const filtered = filterPlayersBySolverPoolSettings(
    players,
    {
      excludeSpecial: true,
      useTotwPlayers: false,
    },
    { requiredIds: [1, 2] },
  ).filteredPlayers;

  assert.deepEqual(
    filtered.map((player) => player.id),
    [1, 2],
  );
});

test("Use TOTW Players off blocks TOTW while Exclude Special still blocks other specials", () => {
  const players = [
    makePlayer({ id: 1, rarityId: 3, rarityName: "Team of the Week", isSpecial: true }),
    makePlayer({ id: 2, rarityId: 27, rarityName: "Fantasy FC", isSpecial: true }),
    makePlayer({ id: 3, rarityId: 0, rarityName: "Common", isSpecial: false }),
  ];

  const filtered = filterPlayersBySolverPoolSettings(players, {
    excludeSpecial: true,
    useTotwPlayers: false,
  }).filteredPlayers;

  assert.deepEqual(
    filtered.map((player) => player.id),
    [3],
  );
});
