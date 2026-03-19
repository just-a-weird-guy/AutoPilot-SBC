import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  applyLocalExclusionsToSettings,
  computeEffectiveExcludedIds,
  getDefaultLocalExclusionSettings,
  getLocalExclusionStateForKind,
  getSetLocalExclusionSettings,
  mergeLocalExclusionsIntoSettings,
  toggleLocalExclusionId,
  normalizeLocalExclusionSettings,
  normalizeSetLocalExclusionsStore,
  resolveLocalExclusionSettings,
} = require("./page/local-exclusions-shared.js");

const test = (name, fn) => {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
};

test("default local exclusion settings are empty arrays", () => {
  assert.deepEqual(getDefaultLocalExclusionSettings(), {
    allowedGlobalLeagueIds: [],
    allowedGlobalNationIds: [],
    extraExcludedLeagueIds: [],
    extraExcludedNationIds: [],
  });
});

test("normalizeLocalExclusionSettings deduplicates and stringifies ids", () => {
  assert.deepEqual(
    normalizeLocalExclusionSettings({
      allowedGlobalLeagueIds: [12, "12", " 44 ", null, ""],
      allowedGlobalNationIds: [77, 77, "88"],
      extraExcludedLeagueIds: [9, "10", 9],
      extraExcludedNationIds: [null, "5", " 5", 7],
    }),
    {
      allowedGlobalLeagueIds: ["12", "44"],
      allowedGlobalNationIds: ["77", "88"],
      extraExcludedLeagueIds: ["9", "10"],
      extraExcludedNationIds: ["5", "7"],
    },
  );
});

test("computeEffectiveExcludedIds removes allowed globals and appends local extras", () => {
  assert.deepEqual(
    computeEffectiveExcludedIds({
      globalExcludedIds: ["1", "2", "3"],
      allowedGlobalIds: ["2", "9"],
      extraExcludedIds: ["3", "5"],
    }),
    ["1", "3", "5"],
  );
});

test("resolveLocalExclusionSettings returns effective league and nation exclusions", () => {
  assert.deepEqual(
    resolveLocalExclusionSettings({
      globalExcludedLeagueIds: ["10", "20", "30"],
      globalExcludedNationIds: ["100", "200", "300"],
      localSettings: {
        allowedGlobalLeagueIds: ["20"],
        allowedGlobalNationIds: ["300"],
        extraExcludedLeagueIds: ["40"],
        extraExcludedNationIds: ["500"],
      },
    }),
    {
      allowedGlobalLeagueIds: ["20"],
      allowedGlobalNationIds: ["300"],
      extraExcludedLeagueIds: ["40"],
      extraExcludedNationIds: ["500"],
      excludedLeagueIds: ["10", "30", "40"],
      excludedNationIds: ["100", "200", "500"],
    },
  );
});

test("normalizeSetLocalExclusionsStore keeps only normalized per-set entries", () => {
  assert.deepEqual(
    normalizeSetLocalExclusionsStore({
      101: {
        allowedGlobalLeagueIds: [1, 1, 2],
        extraExcludedNationIds: [9, 9],
      },
      202: {
        allowedGlobalNationIds: [7],
        extraExcludedLeagueIds: [3],
      },
      bad: null,
    }),
    {
      "101": {
        allowedGlobalLeagueIds: ["1", "2"],
        allowedGlobalNationIds: [],
        extraExcludedLeagueIds: [],
        extraExcludedNationIds: ["9"],
      },
      "202": {
        allowedGlobalLeagueIds: [],
        allowedGlobalNationIds: ["7"],
        extraExcludedLeagueIds: ["3"],
        extraExcludedNationIds: [],
      },
    },
  );
});

test("getSetLocalExclusionSettings returns normalized settings for a set id", () => {
  const store = normalizeSetLocalExclusionsStore({
    77: {
      allowedGlobalLeagueIds: [4],
      extraExcludedNationIds: [8],
    },
  });

  assert.deepEqual(getSetLocalExclusionSettings(store, 77), {
    allowedGlobalLeagueIds: ["4"],
    allowedGlobalNationIds: [],
    extraExcludedLeagueIds: [],
    extraExcludedNationIds: ["8"],
  });

  assert.deepEqual(getSetLocalExclusionSettings(store, 999), {
    allowedGlobalLeagueIds: [],
    allowedGlobalNationIds: [],
    extraExcludedLeagueIds: [],
    extraExcludedNationIds: [],
  });
});

test("applyLocalExclusionsToSettings preserves legacy explicit exclusions when no local fields exist", () => {
  assert.deepEqual(
    applyLocalExclusionsToSettings({
      settings: {
        excludedLeagueIds: ["11", "22"],
        excludedNationIds: ["101", "202"],
      },
      globalSettings: {
        excludedLeagueIds: ["1", "2", "3"],
        excludedNationIds: ["4", "5", "6"],
      },
    }),
    {
      excludedLeagueIds: ["11", "22"],
      excludedNationIds: ["101", "202"],
    },
  );
});

test("applyLocalExclusionsToSettings recomputes effective exclusions when local fields exist", () => {
  assert.deepEqual(
    applyLocalExclusionsToSettings({
      settings: {
        allowedGlobalLeagueIds: ["2"],
        allowedGlobalNationIds: ["6"],
        extraExcludedLeagueIds: ["9"],
        extraExcludedNationIds: ["10"],
        excludedLeagueIds: ["stale"],
        excludedNationIds: ["stale"],
      },
      globalSettings: {
        excludedLeagueIds: ["1", "2", "3"],
        excludedNationIds: ["4", "5", "6"],
      },
    }),
    {
      allowedGlobalLeagueIds: ["2"],
      allowedGlobalNationIds: ["6"],
      extraExcludedLeagueIds: ["9"],
      extraExcludedNationIds: ["10"],
      excludedLeagueIds: ["1", "3", "9"],
      excludedNationIds: ["4", "5", "10"],
    },
  );
});

test("getLocalExclusionStateForKind derives allowed and extra lists for leagues", () => {
  assert.deepEqual(
    getLocalExclusionStateForKind({
      kind: "league",
      settings: {
        allowedGlobalLeagueIds: ["2"],
        extraExcludedLeagueIds: ["9"],
      },
      globalExcludedIds: ["1", "2", "3"],
    }),
    {
      allowedField: "allowedGlobalLeagueIds",
      extraField: "extraExcludedLeagueIds",
      globalExcludedIds: ["1", "2", "3"],
      allowedGlobalIds: ["2"],
      extraExcludedIds: ["9"],
      effectiveExcludedIds: ["1", "3", "9"],
    },
  );
});

test("toggleLocalExclusionId adds and removes allowed-back ids using global membership", () => {
  const start = getDefaultLocalExclusionSettings();
  const afterAdd = toggleLocalExclusionId({
    kind: "league",
    mode: "toggle",
    id: "22",
    settings: start,
    globalExcludedIds: ["22", "33"],
  });
  assert.deepEqual(afterAdd, {
    allowedGlobalLeagueIds: ["22"],
    allowedGlobalNationIds: [],
    extraExcludedLeagueIds: [],
    extraExcludedNationIds: [],
  });

  const afterRemove = toggleLocalExclusionId({
    kind: "league",
    mode: "toggle",
    id: "22",
    settings: afterAdd,
    globalExcludedIds: ["22", "33"],
  });
  assert.deepEqual(afterRemove, start);
});

test("toggleLocalExclusionId adds and removes extra local ids when not globally excluded", () => {
  const start = getDefaultLocalExclusionSettings();
  const afterAdd = toggleLocalExclusionId({
    kind: "nation",
    mode: "toggle",
    id: "77",
    settings: start,
    globalExcludedIds: ["10"],
  });
  assert.deepEqual(afterAdd, {
    allowedGlobalLeagueIds: [],
    allowedGlobalNationIds: [],
    extraExcludedLeagueIds: [],
    extraExcludedNationIds: ["77"],
  });

  const afterRemove = toggleLocalExclusionId({
    kind: "nation",
    mode: "toggle",
    id: "77",
    settings: afterAdd,
    globalExcludedIds: ["10"],
  });
  assert.deepEqual(afterRemove, start);
});

test("toggleLocalExclusionId clears the opposite bucket when moving an id between modes", () => {
  const updated = toggleLocalExclusionId({
    kind: "league",
    mode: "extra",
    id: "55",
    settings: {
      allowedGlobalLeagueIds: ["55"],
      allowedGlobalNationIds: [],
      extraExcludedLeagueIds: [],
      extraExcludedNationIds: [],
    },
    globalExcludedIds: ["55"],
  });

  assert.deepEqual(updated, {
    allowedGlobalLeagueIds: [],
    allowedGlobalNationIds: [],
    extraExcludedLeagueIds: ["55"],
    extraExcludedNationIds: [],
  });
});

test("toggleLocalExclusionId clears a specific mode bucket", () => {
  assert.deepEqual(
    toggleLocalExclusionId({
      kind: "nation",
      mode: "clear_allowed",
      settings: {
        allowedGlobalLeagueIds: [],
        allowedGlobalNationIds: ["88", "99"],
        extraExcludedLeagueIds: [],
        extraExcludedNationIds: ["7"],
      },
    }),
    {
      allowedGlobalLeagueIds: [],
      allowedGlobalNationIds: [],
      extraExcludedLeagueIds: [],
      extraExcludedNationIds: ["7"],
    },
  );
});

test("mergeLocalExclusionsIntoSettings can force recompute from global defaults when local settings are empty", () => {
  assert.deepEqual(
    mergeLocalExclusionsIntoSettings({
      settings: {
        excludedLeagueIds: ["stale-league"],
        excludedNationIds: ["stale-nation"],
      },
      globalSettings: {
        excludedLeagueIds: ["10", "20"],
        excludedNationIds: ["100", "200"],
      },
      localSettings: getDefaultLocalExclusionSettings(),
      force: true,
    }),
    {
      allowedGlobalLeagueIds: [],
      allowedGlobalNationIds: [],
      extraExcludedLeagueIds: [],
      extraExcludedNationIds: [],
      excludedLeagueIds: ["10", "20"],
      excludedNationIds: ["100", "200"],
    },
  );
});

test("mergeLocalExclusionsIntoSettings overrides base local fields with explicit local settings", () => {
  assert.deepEqual(
    mergeLocalExclusionsIntoSettings({
      settings: {
        allowedGlobalLeagueIds: ["999"],
        excludedLeagueIds: ["stale-league"],
        excludedNationIds: ["stale-nation"],
      },
      globalSettings: {
        excludedLeagueIds: ["10", "20", "30"],
        excludedNationIds: ["100", "200"],
      },
      localSettings: {
        allowedGlobalLeagueIds: ["20"],
        extraExcludedLeagueIds: ["44"],
        extraExcludedNationIds: ["300"],
      },
      force: true,
    }),
    {
      allowedGlobalLeagueIds: ["20"],
      allowedGlobalNationIds: [],
      extraExcludedLeagueIds: ["44"],
      extraExcludedNationIds: ["300"],
      excludedLeagueIds: ["10", "30", "44"],
      excludedNationIds: ["100", "200", "300"],
    },
  );
});
