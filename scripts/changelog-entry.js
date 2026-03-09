const fs = require("fs");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..");
const manifestPath = path.join(repoRoot, "manifest.json");
const changelogPath = path.join(repoRoot, "data", "changelog.json");
const args = new Set(process.argv.slice(2));

const readJson = (filePath) => JSON.parse(fs.readFileSync(filePath, "utf8"));
const writeJson = (filePath, value) => {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
};

const manifest = readJson(manifestPath);
const changelog = readJson(changelogPath);
const currentVersion = String(manifest?.version ?? "").trim();

if (!currentVersion) {
  throw new Error("Manifest version is missing.");
}
if (!changelog || typeof changelog !== "object" || Array.isArray(changelog)) {
  throw new Error("Changelog root must be an object.");
}
const schemaVersion = Number(changelog.version);
if (!Number.isInteger(schemaVersion) || schemaVersion < 1) {
  throw new Error("Changelog root version must be a positive integer.");
}
if (!Array.isArray(changelog.releases)) {
  throw new Error("Changelog must contain a releases array.");
}

const seenVersions = new Set();
for (const [index, release] of changelog.releases.entries()) {
  if (!release || typeof release !== "object" || Array.isArray(release)) {
    throw new Error(`Release at index ${index} must be an object.`);
  }
  const version = String(release.version ?? "").trim();
  const date = String(release.date ?? "").trim();
  const headline = String(release.headline ?? "").trim();
  const summary = String(release.summary ?? "").trim();
  const details = Array.isArray(release.details) ? release.details : null;
  if (!version) throw new Error(`Release at index ${index} is missing version.`);
  if (seenVersions.has(version)) {
    throw new Error(`Duplicate changelog version found: ${version}`);
  }
  seenVersions.add(version);
  if (!date) throw new Error(`Release ${version} is missing date.`);
  if (!headline) throw new Error(`Release ${version} is missing headline.`);
  if (!summary) throw new Error(`Release ${version} is missing summary.`);
  if (!details) throw new Error(`Release ${version} must contain details[].`);
}

if (args.has("--validate")) {
  console.log(`Changelog valid. ${changelog.releases.length} release entries found.`);
  process.exit(0);
}

const today = new Date().toISOString().slice(0, 10);
const existing = changelog.releases.find(
  (release) => String(release?.version ?? "").trim() === currentVersion,
);

if (existing) {
  console.log(`Changelog entry already exists for version ${currentVersion}.`);
  process.exit(0);
}

const stub = {
  version: currentVersion,
  date: today,
  headline: "Add release headline",
  summary: "Add a short one-line summary for this update.",
  details: [
    "Add the main change here.",
    "Add another user-facing improvement here.",
  ],
};

changelog.releases.unshift(stub);
writeJson(changelogPath, changelog);
console.log(`Scaffolded changelog entry for version ${currentVersion} in ${changelogPath}`);
