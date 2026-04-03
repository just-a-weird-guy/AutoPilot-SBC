import fs from "node:fs/promises";
import path from "node:path";
import { evaluateChallengeSolution } from "./lib/evaluator-core.mjs";

const usage = `
Score one solver output against one challenge and the official player pool.

Usage:
  node evaluator/score-solution.mjs --challenge <file> --players <file> --solution <file>
`;

const parseArgs = (argv) => {
  const args = { challenge: null, players: null, solution: null, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help" || token === "-h") {
      args.help = true;
      continue;
    }
    if (token === "--challenge") {
      args.challenge = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (token === "--players") {
      args.players = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (token === "--solution") {
      args.solution = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
  }
  return args;
};

const readJson = async (filePath) => {
  const content = await fs.readFile(path.resolve(filePath), "utf8");
  return JSON.parse(content);
};

const run = async () => {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage.trim());
    return;
  }
  if (!args.challenge || !args.players || !args.solution) {
    throw new Error("Missing required arguments");
  }

  const challenge = await readJson(args.challenge);
  const players = await readJson(args.players);
  const solution = await readJson(args.solution);
  const result = evaluateChallengeSolution({
    challenge,
    playerPool: players,
    candidateOutput: solution,
  });
  console.log(
    JSON.stringify(
      {
        solved: result.solved,
        issues: result.issues,
        failingTypes: result.failingTypes,
        stats: result.stats,
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

