import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  buildBenchmarkSummary,
  buildComparisonRows,
  buildEvaluatorContext,
  createBaselineIndex,
  evaluateChallengeSolution,
} from "./lib/evaluator-core.mjs";

const usage = `
Run the EA-FC-SOLVER-TEST benchmark against a Node.js candidate solver.

Usage:
  node evaluator/run-benchmark.mjs --candidate <file> [--report <file>]
`;

const parseArgs = (argv) => {
  const args = { candidate: null, report: null, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help" || token === "-h") {
      args.help = true;
      continue;
    }
    if (token === "--candidate") {
      args.candidate = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (token === "--report") {
      args.report = argv[index + 1] ?? null;
      index += 1;
    }
  }
  return args;
};

const readJson = async (filePath) => {
  const content = await fs.readFile(filePath, "utf8");
  return JSON.parse(content);
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const localPath = (...segments) =>
  path.resolve(__dirname, ...segments);

const getSolverFunction = async (candidatePath) => {
  const candidateModule = await import(pathToFileURL(path.resolve(candidatePath)).href);
  return (
    candidateModule.solveChallenge ??
    candidateModule.default?.solveChallenge ??
    candidateModule.default
  );
};

const run = async () => {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage.trim());
    return;
  }
  if (!args.candidate) throw new Error("Missing --candidate <file>");

  const playersPath = localPath("..", "model-kit", "datasets", "players-v1-flat.json");
  const challengesPath = localPath("..", "model-kit", "datasets", "challenges-v1.json");
  const baselinePath = localPath("baseline-per-challenge.json");
  const rawPlayers = await readJson(playersPath);
  const rawChallenges = await readJson(challengesPath);
  const baselineReport = await readJson(baselinePath);
  const baselineIndex = createBaselineIndex(baselineReport);

  const { players, challenges } = buildEvaluatorContext({
    rawPlayers,
    rawChallenges,
  });
  const solveChallenge = await getSolverFunction(args.candidate);
  if (typeof solveChallenge !== "function") {
    throw new Error("Candidate module must export solveChallenge(input) or a default function");
  }

  const rows = [];
  for (let index = 0; index < challenges.length; index += 1) {
    const challenge = challenges[index];
    const startedAt = Date.now();
    let candidateOutput = null;
    let runtimeError = null;
    try {
      candidateOutput = await solveChallenge({
        version: "ea-fc-solver-test-v1",
        challenge,
        players,
        metadata: {
          challengeIndex: index,
          challengeCount: challenges.length,
        },
      });
    } catch (error) {
      runtimeError = error?.message || String(error);
    }

    const row = evaluateChallengeSolution({
      challenge,
      playerPool: players,
      candidateOutput,
    });
    rows.push({
      ...row,
      runtime: {
        elapsedMs: Date.now() - startedAt,
        error: runtimeError,
      },
    });
  }

  const results = buildComparisonRows(rows, baselineIndex);
  const summary = buildBenchmarkSummary(rows, baselineIndex);
  const report = {
    generatedAt: new Date().toISOString(),
    benchmark: {
      version: "ea-fc-solver-test-v1",
      candidatePath: path.resolve(args.candidate),
      challengeCount: challenges.length,
      playersCount: players.length,
    },
    summary,
    results,
  };

  if (args.report) {
    await fs.writeFile(path.resolve(args.report), JSON.stringify(report, null, 2), "utf8");
  }

  console.log(JSON.stringify(report, null, 2));
};

run().catch((error) => {
  console.error(error?.message || error);
  process.exitCode = 1;
});
