import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSolverContext, solveSquad } from "../../solver/solver.js";
import { flattenPlayerPool } from "../evaluator/lib/player-pool.mjs";
import {
  buildBenchmarkSummary,
  evaluateChallengeSolution,
  PENALTY_METRIC_ORDER,
} from "../evaluator/lib/evaluator-core.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(packageRoot, "..");

const readJson = async (filePath) => {
  const content = await fs.readFile(filePath, "utf8");
  return JSON.parse(content);
};

const writeJson = async (filePath, value) => {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
};

const writeText = async (filePath, value) => {
  await fs.writeFile(filePath, value, "utf8");
};

const relativeRepoPath = (targetPath) => path.relative(repoRoot, targetPath).replace(/\\/g, "/");

const buildDocs = ({ challengeCount, playerCount }) => ({
  readme: `# EA-FC-SOLVER-TEST

EA-FC-SOLVER-TEST is a frozen benchmark kit for EA FC SBC solver generation.

It has two distinct surfaces:
- \`model-kit/\`: the exact package you hand to a model that must build a solver
- \`evaluator/\`: the official runner, validator, scorer, and frozen baseline outputs

If you are generating a solver, start at \`model-kit/PROMPT.md\`.
If you are benchmarking a solver, start at \`evaluator/README.md\`.

## Official v1 corpus

- Challenges: \`${challengeCount}\`
- Players in flattened official pool: \`${playerCount}\`
- Challenge source: \`model-kit/datasets/challenges-v1.json\`
- Player source: \`model-kit/datasets/players-v1-flat.json\`
`,
  modelReadme: `# Model Kit

Start with \`PROMPT.md\`. That file is the entry point and gives the reading order.

Read next:
- \`solver-interface.md\`
- \`challenge-schema.md\`
- \`reference/player-schema.md\`
- \`reference/ea-fc-sbc-rules.md\`
- \`reference/constraint-normalization.md\`

Official dataset files:
- \`datasets/players-v1-flat.json\`
- \`datasets/challenges-v1.json\`
`,
  prompt: `# Solver Build Prompt

You are given a frozen EA FC SBC benchmark pack. Build a Node.js solver module that reads one challenge plus the official player pool and returns one candidate squad.

## Deliverable

- Create \`candidate/solver.js\`
- Export \`async function solveChallenge(input)\`
- Input and output are defined in \`solver-interface.md\`
- The solver runs locally and offline against the files in this package

## Read In This Order

1. \`solver-interface.md\`
2. \`challenge-schema.md\`
3. \`reference/player-schema.md\`
4. \`reference/ea-fc-sbc-rules.md\`
5. \`reference/constraint-normalization.md\`
6. \`datasets/challenges-v1.json\`
7. \`datasets/players-v1-flat.json\`
8. \`candidate-template/solver.js\`

## What To Optimize

1. Solve as many challenges as possible
2. On solved challenges, prefer lower submitted average rating
3. Avoid wasteful squads such as unnecessary special cards, informs, tradables, high-rating anchors, and scarce items

## Important Implementation Facts

- \`requirementsNormalized\` is the structured source of truth for requirements
- \`requirementsText\` is only a human-readable explanation
- \`challenge.squadSize\` is the required number of selected players; not every challenge is a full 11-player squad
- some challenges in this corpus require 6, 7, or 8 players instead of 11
- \`challenge.squadSlots\` defines the official slot positions used for chemistry and position checks
- if a challenge requires fewer than 11 players, only the first \`challenge.squadSize\` official slots are part of the submission
- Position eligibility is player-specific: use \`alternativePositionNames\`, falling back to \`preferredPositionName\`
- submitted player ids must be unique
- duplicate \`definitionId\` values in the same squad are invalid
- chemistry is tied to slot placement, not just player selection
- when a challenge has a chemistry rule, your solver must return explicit slot assignments for the submitted players

## Suggested Build Approach

1. Pre-index the player pool by rating, league, nation, club, rarity, tradability, and eligible positions
2. Parse each challenge's \`requirementsNormalized\` into hard constraints and optimization preferences
3. Search for a legal set of \`challenge.squadSize\` players
4. When chemistry is required, search over slot placement as part of the solve
5. Return only \`playerIds\` for non-chemistry challenges, or return \`playerIds\` plus \`slotAssignments\` for chemistry challenges
6. Verify squad rating, chemistry, and identity constraints before returning

## Files That Matter Most

- \`datasets/challenges-v1.json\`
- \`datasets/players-v1-flat.json\`
- \`solver-interface.md\`
- \`challenge-schema.md\`
- \`reference/ea-fc-sbc-rules.md\`
`,
  solverInterface: `# Solver Interface

Candidate file:
- \`candidate/solver.js\`

Required export:

\`\`\`js
export async function solveChallenge(input) {}
\`\`\`

The default export may also be the solver function.

## Input

\`\`\`ts
type SolverInput = {
  version: "ea-fc-solver-test-v1";
  challenge: ChallengeRecord;
  players: Player[];
  metadata: {
    challengeIndex: number;
    challengeCount: number;
  };
};
\`\`\`

See \`challenge-schema.md\` and \`reference/player-schema.md\` for the important field definitions.

## Output

Return either:
- an array of player ids
- or an object with this shape

\`\`\`ts
type SolverOutput = {
  playerIds?: Array<string | number>;
  slotAssignments?: Array<string | number> | Array<{ slotIndex: number; playerId: string | number }>;
  meta?: Record<string, unknown>;
};
\`\`\`

Notes:
- \`playerIds\` must contain exactly the selected squad members
- use \`challenge.squadSize\` as the required squad length
- if \`challenge.squadSlots\` contains more slots than \`challenge.squadSize\`, only the first \`challenge.squadSize\` official slots matter
- \`slotAssignments\` is required when the challenge includes a chemistry rule
- \`slotAssignments\` may be omitted only when chemistry is not relevant to the challenge
- ordered \`slotAssignments\` are interpreted by slot index from \`0\` to \`challenge.squadSize - 1\`
- If \`slotAssignments\` is provided, it must match the same selected squad exactly
- The evaluator ignores any self-reported validity or scoring fields
`,
  challengeSchema: `# Challenge Schema

Each entry in \`datasets/challenges-v1.json\` is one SBC challenge record.

Fields that matter for solving:
- \`challengeId\`: stable challenge identifier
- \`setName\`, \`challengeName\`: descriptive names only
- \`squadSize\`: required number of selected players; some challenges are smaller than 11
- \`formationName\`, \`formationCode\`: descriptive formation metadata
- \`squadSlots\`: official slot positions used for chemistry and position checks
- \`requirementsText\`: human-readable requirement lines
- \`requirementsNormalized\`: machine-readable requirement rules used by the evaluator

\`squadSlots\` entries look like:

\`\`\`ts
type SquadSlot = {
  slotIndex: number;
  positionName: string;
  slotId?: string;
};
\`\`\`

Important slot rule:
- use only the first \`challenge.squadSize\` official slots for assignment and chemistry
- \`squadSize\` is authoritative for submission size
- when chemistry matters, slot placement over those official slots matters too

\`requirementsNormalized\` entries look like:

\`\`\`ts
type NormalizedRule = {
  type: string;
  op: "min" | "max" | "exact";
  count: number | null;
  value: Array<string | number>;
  label: string;
};
\`\`\`

Practical reading rule:
- \`type\` tells you what is being constrained
- \`op\` tells you whether the bound is minimum, maximum, or exact
- \`count\` is usually the player count for player-specific rules
- \`value[0]\` usually carries the numeric threshold or the target identity id
- \`label\` is a readable fallback if you need to log or debug the rule
`,
  playerSchema: `# Player Schema

Official evaluation uses \`datasets/players-v1-flat.json\`.

Core fields for solving:
- \`id\`: unique owned-card id used in solver output
- \`definitionId\`: item definition id; duplicate definitions in one squad are invalid
- \`rating\`: face rating used for squad rating and average-rating comparison
- \`leagueId\`, \`nationId\`, \`teamId\`: chemistry and identity constraints
- \`rarityName\`, \`isSpecial\`, \`isTotw\`, \`isEvolution\`: rarity and special-card logic
- \`isTradeable\`, \`isUntradeable\`: tradability rules and penalty behavior
- \`owners\`: available for ownership-based rules
- \`preferredPositionName\`, \`alternativePositionNames\`: official position eligibility source

Position legality rule:
- Use \`alternativePositionNames\` when present
- Otherwise fall back to \`preferredPositionName\`
- There is no separate global position mapping table in this benchmark

Available but usually lower priority:
- \`name\`: display only
- \`pile\`, \`isStorage\`, \`isDuplicate\`: inventory state
- \`playStyle\`, \`upgrades\`, \`isEnrolledInAcademy\`: extra card metadata
`,
  normalization: `# Interpreting requirementsNormalized

The challenge corpus already ships precompiled \`requirementsNormalized\` rules.

Each rule already has the information a solver usually needs:
- \`type\`
- \`op\`
- \`count\`
- \`value\`
- \`label\`

Rule types that actually appear in this v1 corpus:
- \`players_in_squad\`: exact squad size; usually matches \`challenge.squadSize\`
- \`team_rating\`: minimum squad rating target in \`value[0]\`
- \`chemistry_points\`: minimum total squad chemistry in \`value[0]\`; this makes slot assignment part of legality
- \`player_level\`: minimum count of bronze, silver, or gold cards; \`count\` is the required amount and \`value[0]\` is the level string
- \`player_rarity_group\`: rarity-group requirement; in this corpus it is used for rare-card style rules
- \`nation_count\`, \`league_count\`, \`club_count\`: distinct-identity count constraints
- \`same_nation_count\`, \`same_league_count\`, \`same_club_count\`: at least one identity bucket must reach the stated repetition count
- \`nation_id\`, \`league_id\`, \`club_id\`: count players whose identity id is in \`value\`

Interpretation notes:
- For \`nation_id\`, \`league_id\`, and \`club_id\`, \`value\` may contain more than one accepted id
- For count-style identity rules, \`op\` controls whether the bound is minimum or maximum
- \`label\` is useful for debugging, but your solver should primarily rely on \`type\`, \`op\`, \`count\`, and \`value\`
`,
  rules: `# EA FC SBC Rules

## Squad rating

The evaluator uses the same adjusted-average rating formula as the current solver.

For ratings \`r1 ... rn\`:
- plain average: \`A = (r1 + ... + rn) / n\`
- adjusted rating for each card:
  - if \`ri <= A\`, keep \`ri\`
  - if \`ri > A\`, use \`2 * ri - A\`
- adjusted average: \`B = (adjusted_1 + ... + adjusted_n) / n\`
- round \`B\` to 2 decimals
- final squad rating:
  - let \`base = floor(B)\`
  - if the decimal part of rounded \`B\` is at least \`0.96\`, squad rating is \`base + 1\`
  - otherwise squad rating is \`base\`

## Chemistry

The evaluator uses the same FC chemistry thresholds as the current solver:
- Club contribution thresholds: 2 / 4 / 7
- League contribution thresholds: 3 / 5 / 8
- Nation contribution thresholds: 2 / 5 / 8
- Each player chemistry is capped at 3

Position behavior:
- official challenge \`squadSlots\` are authoritative
- only the first \`challenge.squadSize\` official slots matter
- a player is on-position only if the slot position appears in the player's \`alternativePositionNames\`, or in \`preferredPositionName\` when no alternatives exist
- out-of-position players contribute 0 chemistry
- out-of-position players do not count toward chemistry thresholds for other players

Practical solver rule:
- when a challenge includes \`chemistry_points\`, solving means picking players and placing them into slots
- a set of players can satisfy all non-chemistry rules and still fail because the slot placement is wrong
- for chemistry challenges, the benchmark expects the solver to return the slot placement it is submitting

## Rarity semantics

- Generic \`Rare\` means base rare/non-special, not any special item
- \`Rare or TOTW\` is satisfied by:
  - rare non-special cards
  - TOTW / inform cards

## Penalty metrics

For solved squads, the evaluator computes the same unwanted-behavior metrics used by the benchmark:
- \`ratingExcess\`
- \`maxRating\`
- \`highRatingScore\`
- \`highRatingCount\`
- \`identityBalancePenalty\`
- \`sumRating\`
- \`specialCount\`
- \`tradableCount\`
- \`scarcityPenalty\`

Additional preservation fields are also reported:
- \`informCount\`
- \`excessInforms\`
- \`excessSpecials\`

Interpretation for solver design:
- legal is not enough; lower-rating and lower-waste squads rank better
- unnecessary special cards, informs, tradables, scarce items, and high-rating anchors are all negative behavior in benchmark scoring
`,
  evaluatorReadme: `# Evaluator

Scripts:
- \`run-benchmark.mjs\`: runs a candidate solver over the full corpus
- \`validate-solution.mjs\`: validates one solution against one challenge
- \`score-solution.mjs\`: emits legality plus solved-squad metrics for one solution

The evaluator is authoritative:
- candidate self-reported validity is ignored
- duplicate player ids are rejected
- duplicate \`definitionId\` values in a squad are rejected
- the official challenge \`squadSlots\` are used for chemistry and position checks
- chemistry challenges require candidate-provided \`slotAssignments\`
`,
});

const buildReportSchema = () => ({
  type: "object",
  required: ["generatedAt", "benchmark", "summary", "results"],
  properties: {
    generatedAt: { type: "string" },
    benchmark: { type: "object" },
    summary: {
      type: "object",
      properties: {
        challengeCount: { type: "number" },
        solvedCount: { type: "number" },
        unsolvedCount: { type: "number" },
        solveRatePct: { type: ["number", "null"] },
        mutualSolvedCountWithBaseline: { type: "number" },
        meanAverageRatingDeltaVsBaseline: { type: ["number", "null"] },
        penaltyDeltaMeans: {
          type: "object",
          properties: Object.fromEntries(
            PENALTY_METRIC_ORDER.map((key) => [key, { type: ["number", "null"] }]),
          ),
        },
      },
    },
    results: { type: "array" },
  },
});

const run = async () => {
  const rawPlayersPath = path.resolve(repoRoot, "data", "players.json");
  const rawChallengesPath = path.resolve(
    repoRoot,
    "data",
    "futbin-challenges-compiled-with-slots.json",
  );
  const rawPlayers = await readJson(rawPlayersPath);
  const rawChallenges = await readJson(rawChallengesPath);
  const flatPlayers = flattenPlayerPool(rawPlayers);
  const challenges = Array.isArray(rawChallenges?.records) ? rawChallenges.records : [];

  const playersFlatPath = path.resolve(packageRoot, "model-kit", "datasets", "players-v1-flat.json");
  const playersRawPath = path.resolve(packageRoot, "model-kit", "datasets", "players-raw.json");
  const challengesPath = path.resolve(packageRoot, "model-kit", "datasets", "challenges-v1.json");
  const sampleDir = path.resolve(packageRoot, "model-kit", "datasets", "challenge-samples");
  const examplesDir = path.resolve(packageRoot, "model-kit", "examples");
  const referenceDir = path.resolve(packageRoot, "model-kit", "reference");

  await fs.mkdir(sampleDir, { recursive: true });
  await fs.mkdir(examplesDir, { recursive: true });
  await fs.mkdir(referenceDir, { recursive: true });

  await writeJson(playersRawPath, rawPlayers);
  await writeJson(playersFlatPath, flatPlayers);
  await writeJson(challengesPath, {
    version: "ea-fc-solver-test-v1",
    source: "futbin-challenges-compiled-with-slots",
    challengeCount: challenges.length,
    challenges,
  });

  for (let index = 0; index < Math.min(3, challenges.length); index += 1) {
    await writeJson(
      path.resolve(sampleDir, `challenge-sample-${String(index + 1).padStart(2, "0")}.json`),
      challenges[index],
    );
  }

  await writeJson(path.resolve(examplesDir, "challenge-input.sample.json"), {
    version: "ea-fc-solver-test-v1",
    challenge: challenges[0],
    players: flatPlayers.slice(0, 8),
    metadata: {
      challengeIndex: 0,
      challengeCount: challenges.length,
      note: "players array truncated for readability",
    },
  });

  await writeJson(path.resolve(examplesDir, "solver-output.sample.json"), {
    playerIds: flatPlayers.slice(0, Math.min(11, flatPlayers.length)).map((player) => player.id),
    meta: {
      note: "example shape only; not guaranteed to solve the sample challenge",
    },
  });

  const docs = buildDocs({
    challengeCount: challenges.length,
    playerCount: flatPlayers.length,
  });
  await writeJson(path.resolve(packageRoot, "package.json"), {
    name: "ea-fc-solver-test",
    private: true,
    type: "module",
  });
  await writeText(path.resolve(packageRoot, "README.md"), docs.readme);
  await writeText(path.resolve(packageRoot, "model-kit", "README.md"), docs.modelReadme);
  await writeText(path.resolve(packageRoot, "model-kit", "PROMPT.md"), docs.prompt);
  await writeText(
    path.resolve(packageRoot, "model-kit", "solver-interface.md"),
    docs.solverInterface,
  );
  await writeText(
    path.resolve(packageRoot, "model-kit", "challenge-schema.md"),
    docs.challengeSchema,
  );
  await writeText(
    path.resolve(packageRoot, "model-kit", "reference", "player-schema.md"),
    docs.playerSchema,
  );
  await writeText(
    path.resolve(packageRoot, "model-kit", "reference", "constraint-normalization.md"),
    docs.normalization,
  );
  await writeText(
    path.resolve(packageRoot, "model-kit", "reference", "ea-fc-sbc-rules.md"),
    docs.rules,
  );
  await writeText(path.resolve(packageRoot, "evaluator", "README.md"), docs.evaluatorReadme);

  await writeText(
    path.resolve(packageRoot, "model-kit", "candidate-template", "solver.js"),
    `export async function solveChallenge(input) {
  const squadSize =
    input?.challenge?.squadSize ??
    input?.challenge?.squadSlots?.length ??
    11;

  return {
    playerIds: (input?.players || []).slice(0, squadSize).map((player) => player.id),
    meta: {
      strategy: "replace this stub with a real solver",
    },
  };
}

export default solveChallenge;
`,
  );

  const baselineRows = [];
  for (const challenge of challenges) {
    const startedAt = Date.now();
    const result = solveSquad(
      buildSolverContext({
        players: flatPlayers,
        requirementsNormalized: challenge.requirementsNormalized,
        requiredPlayers: challenge.squadSlots?.length ?? challenge.squadSize ?? 11,
        squadSlots: challenge.squadSlots,
      }),
    );
    const evaluated = evaluateChallengeSolution({
      challenge,
      playerPool: flatPlayers,
      candidateOutput: {
        playerIds: Array.isArray(result?.solutions?.[0]) ? result.solutions[0] : [],
        slotAssignments:
          Array.isArray(result?.solutionSlots?.[0]?.fieldSlotToPlayerId)
            ? result.solutionSlots[0].fieldSlotToPlayerId
            : null,
      },
    });
    baselineRows.push({
      ...evaluated,
      runtime: {
        elapsedMs: Date.now() - startedAt,
      },
      sourceSolverStats: result?.stats ?? null,
    });
  }

  const baselineIndex = new Map();
  const baselineSummary = buildBenchmarkSummary(baselineRows, baselineIndex);
  const baselinePerChallenge = {
    generatedAt: new Date().toISOString(),
    results: baselineRows,
  };
  const baselineFullReport = {
    generatedAt: new Date().toISOString(),
    benchmark: {
      version: "ea-fc-solver-test-v1",
      source: "current-extension-solver",
      challengeCount: challenges.length,
      playersCount: flatPlayers.length,
    },
    summary: baselineSummary,
    results: baselineRows,
  };

  await writeJson(
    path.resolve(packageRoot, "evaluator", "baseline-per-challenge.json"),
    baselinePerChallenge,
  );
  await writeJson(
    path.resolve(packageRoot, "evaluator", "baseline-full-report.json"),
    baselineFullReport,
  );
  await writeJson(
    path.resolve(packageRoot, "evaluator", "report-schema.json"),
    buildReportSchema(),
  );

  console.log(
    JSON.stringify(
      {
        challengeCount: challenges.length,
        playerCount: flatPlayers.length,
        baselineSolvedCount: baselineRows.filter((row) => row.solved).length,
      },
      null,
      2,
    ),
  );
};

run().catch((error) => {
  console.error(error?.message || error);
  process.exitCode = 1;
});
