import fs from "node:fs/promises";
import path from "node:path";

const usage = `
Merge authoritative EA requirement exports with Futbin-derived compiled records.

Usage:
  node scripts/merge-sbc-datasets.mjs --ea <ea.json> --futbin <compiled.json> [options]

Options:
  --ea <file>         Authoritative EA recorder export JSON (required)
  --futbin <file>     Futbin compiled JSON (required)
  --output <file>     Output path (default: data/sbc-requirements-combined-<timestamp>.json)
  --help              Show this help
`;

const toIsoFileStamp = () => new Date().toISOString().replace(/[:.]/g, "-");

const parseArgs = (argv) => {
  const args = { ea: null, futbin: null, output: null, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help" || token === "-h") {
      args.help = true;
      continue;
    }
    if (token === "--ea") {
      args.ea = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (token === "--futbin") {
      args.futbin = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (token === "--output") {
      args.output = argv[index + 1] ?? null;
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

const ensureArray = (value) => (Array.isArray(value) ? value : []);

const extractRecords = (raw) => {
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw?.records)) return raw.records;
  return [];
};

const extractSummaryChallenges = (raw) => ensureArray(raw?.summary?.challenges);

const makeChallengeKey = (record) => {
  const challengeId = record?.challengeId ?? null;
  if (challengeId == null) return null;
  return String(challengeId);
};

const dedupeChallengesSummary = (challenges) => {
  const map = new Map();
  for (const challenge of challenges) {
    if (!challenge) continue;
    const challengeId = challenge.challengeId ?? null;
    if (challengeId == null) continue;
    const existing = map.get(challengeId);
    if (!existing) {
      map.set(challengeId, challenge);
      continue;
    }
    const existingOpens = Number(existing.opens) || 0;
    const currentOpens = Number(challenge.opens) || 0;
    if (currentOpens >= existingOpens) map.set(challengeId, challenge);
  }
  return Array.from(map.values()).sort((left, right) => (left.challengeId || 0) - (right.challengeId || 0));
};

const buildSyntheticChallengeSummary = (record) => ({
  challengeId: record?.challengeId ?? null,
  setId: record?.setId ?? null,
  challengeName: record?.challengeName ?? null,
  opens: 1,
  firstOpenedAt: null,
  lastOpenedAt: null,
  source: record?.source ?? "futbin",
});

const run = async () => {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage.trim());
    return;
  }
  if (!args.ea) throw new Error("Missing --ea <file>");
  if (!args.futbin) throw new Error("Missing --futbin <file>");

  const eaPath = path.resolve(args.ea);
  const futbinPath = path.resolve(args.futbin);
  const eaJson = await readJson(eaPath);
  const futbinJson = await readJson(futbinPath);

  const eaRecords = extractRecords(eaJson);
  const futbinRecords = extractRecords(futbinJson);

  const mergedByChallenge = new Map();
  for (const record of eaRecords) {
    const key = makeChallengeKey(record);
    if (!key) continue;
    mergedByChallenge.set(key, { ...record, source: record?.source ?? "ea" });
  }

  const adoptedFutbin = [];
  const duplicateFutbin = [];
  for (const record of futbinRecords) {
    const key = makeChallengeKey(record);
    if (!key) continue;
    if (mergedByChallenge.has(key)) {
      duplicateFutbin.push(record.challengeId);
      continue;
    }
    mergedByChallenge.set(key, record);
    adoptedFutbin.push(record.challengeId);
  }

  const mergedRecords = Array.from(mergedByChallenge.values()).sort((left, right) => {
    const leftAt = Date.parse(left?.openedAt || "") || 0;
    const rightAt = Date.parse(right?.openedAt || "") || 0;
    if (leftAt !== rightAt) return leftAt - rightAt;
    return (left?.challengeId || 0) - (right?.challengeId || 0);
  });

  const mergedChallenges = dedupeChallengesSummary(
    extractSummaryChallenges(eaJson).concat(
      futbinRecords
        .filter((record) => adoptedFutbin.includes(record.challengeId))
        .map(buildSyntheticChallengeSummary),
    ),
  );

  const merged = {
    exportedAt: new Date().toISOString(),
    recorderVersion: "merged-ea-futbin-0.1.0",
    summary: {
      totalRecords: mergedRecords.length,
      uniqueChallenges: new Set(mergedRecords.map((record) => record.challengeId).filter(Boolean)).size,
      challenges: mergedChallenges,
      mergeSources: {
        authoritativeEaRecords: eaRecords.length,
        futbinCompiledRecords: futbinRecords.length,
        adoptedFutbinRecords: adoptedFutbin.length,
        duplicateFutbinRecords: duplicateFutbin.length,
      },
    },
    records: mergedRecords,
  };

  const outputPath = args.output
    ? path.resolve(args.output)
    : path.resolve(`data/sbc-requirements-combined-${toIsoFileStamp()}.json`);
  await fs.writeFile(outputPath, JSON.stringify(merged, null, 2), "utf8");

  console.log("[SBC Merge] Wrote:", outputPath);
  console.log(
    `[SBC Merge] EA records: ${eaRecords.length}, Futbin records: ${futbinRecords.length}, Adopted Futbin: ${adoptedFutbin.length}, Duplicates skipped: ${duplicateFutbin.length}`,
  );
};

run().catch((error) => {
  console.error("[SBC Merge] Failed:", error?.message || error);
  process.exitCode = 1;
});
