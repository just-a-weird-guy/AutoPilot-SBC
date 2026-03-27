import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const usage = `
Compile a Futbin challenge raw export into replay-compatible normalized records.

Usage:
  node scripts/compile-futbin-marquee.mjs --input <raw.json> [options]

Options:
  --input <file>         Futbin raw export JSON (required)
  --players <file>       Optional players JSON for entity name -> id resolution
  --aliases <file>       Optional alias map JSON
  --output <file>        Output path (default: data/futbin-challenges-compiled-<timestamp>.json)
  --help                 Show this help
`;

const toIsoFileStamp = () => new Date().toISOString().replace(/[:.]/g, "-");

const parseArgs = (argv) => {
  const args = {
    input: null,
    players: null,
    aliases: null,
    output: null,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help" || token === "-h") {
      args.help = true;
      continue;
    }
    if (token === "--input") {
      args.input = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (token === "--players") {
      args.players = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (token === "--aliases") {
      args.aliases = argv[index + 1] ?? null;
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

const inferSourceLabel = (inputPath, queryUrl) => {
  const combined = `${String(inputPath || "")} ${String(queryUrl || "")}`.toLowerCase();
  if (combined.includes("marquee")) return "futbin-marquee";
  return "futbin-challenges";
};

const normalizeString = (value) =>
  value == null ? "" : String(value).trim().toLowerCase();

const normalizeNameKey = (value) =>
  normalizeString(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .replace(/\(.*?\)/g, " ")
    .replace(/[.'’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const titleCase = (value) =>
  String(value || "")
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");

const toNumber = (value) => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
};

const extractPlayers = (raw) => {
  if (Array.isArray(raw)) return raw;
  if (!raw || typeof raw !== "object") return [];
  return []
    .concat(Array.isArray(raw.players) ? raw.players : [])
    .concat(Array.isArray(raw.clubPlayers) ? raw.clubPlayers : [])
    .concat(Array.isArray(raw.storagePlayers) ? raw.storagePlayers : [])
    .concat(Array.isArray(raw.data?.players) ? raw.data.players : [])
    .concat(Array.isArray(raw.data?.clubPlayers) ? raw.data.clubPlayers : [])
    .concat(Array.isArray(raw.data?.storagePlayers) ? raw.data.storagePlayers : []);
};

const makeRegistry = () => ({
  nations: new Map(),
  leagues: new Map(),
  clubs: new Map(),
});

const addNameMapping = (map, name, id, extraAliases = []) => {
  const numericId = toNumber(id);
  if (numericId == null) return;
  const candidates = [name, ...extraAliases]
    .map(normalizeNameKey)
    .filter(Boolean);
  for (const key of candidates) {
    if (!map.has(key)) map.set(key, numericId);
  }
};

const leagueNameVariants = (name) => {
  const raw = String(name || "");
  const variants = new Set([raw]);
  variants.add(raw.replace(/\(.*?\)/g, " ").trim());
  variants.add(raw.replace(/tim/gi, "").trim());
  variants.add(raw.replace(/enilive/gi, "").trim());
  return [...variants].filter(Boolean);
};

const clubNameVariants = (name) => {
  const raw = String(name || "");
  const variants = new Set([raw]);
  variants.add(raw.replace(/^fc\s+/i, "").trim());
  variants.add(raw.replace(/^ssc\s+/i, "").trim());
  variants.add(raw.replace(/^as\s+/i, "").trim());
  variants.add(raw.replace(/^ac\s+/i, "").trim());
  variants.add(raw.replace(/^manchester united$/i, "Manchester Utd"));
  variants.add(raw.replace(/^fc bayern munchen$/i, "FC Bayern München"));
  variants.add(raw.replace(/^fc bayern münchen$/i, "FC Bayern Munchen"));
  return [...variants].filter(Boolean);
};

const nationNameVariants = (name) => {
  const raw = String(name || "");
  const variants = new Set([raw]);
  variants.add(raw.replace(/^usa$/i, "United States"));
  variants.add(raw.replace(/^saudi ara\.$/i, "Saudi Arabia"));
  variants.add(raw.replace(/^switzerl\.$/i, "Switzerland"));
  variants.add(raw.replace(/^burk\. faso$/i, "Burkina Faso"));
  return [...variants].filter(Boolean);
};

const buildRegistryFromPlayers = (players) => {
  const registry = makeRegistry();
  for (const player of players) {
    if (!player || typeof player !== "object") continue;
    addNameMapping(
      registry.nations,
      player.nationName,
      player.nationId,
      nationNameVariants(player.nationName),
    );
    addNameMapping(
      registry.leagues,
      player.leagueName,
      player.leagueId,
      leagueNameVariants(player.leagueName),
    );
    addNameMapping(
      registry.clubs,
      player.teamName || player.clubName || player.name,
      player.teamId,
      [],
    );
  }
  return registry;
};

const mergeAliasRegistry = (registry, aliases) => {
  const next = registry || makeRegistry();
  const addBucket = (bucket, map) => {
    for (const [name, id] of Object.entries(map || {})) {
      addNameMapping(next[bucket], name, id, []);
    }
  };
  addBucket("nations", aliases?.nations || {});
  addBucket("leagues", aliases?.leagues || {});
  addBucket("clubs", aliases?.clubs || {});
  return next;
};

const resolveEntityIds = (names, bucket, registry) => {
  const map = registry?.[bucket];
  if (!(map instanceof Map)) return [];
  const resolved = [];
  for (const name of names) {
    const key = normalizeNameKey(name);
    if (!key || !map.has(key)) continue;
    const id = map.get(key);
    if (!resolved.includes(id)) resolved.push(id);
  }
  return resolved;
};

const parseRequirementNumericTarget = (text) => {
  const match = String(text || "").match(/\b(?:min|max|exactly)\s*\.?\s*(\d+)\b/i);
  if (match) return Number(match[1]);
  const trailing = String(text || "").match(/:\s*(\d+)\s*$/);
  return trailing ? Number(trailing[1]) : null;
};

const parseRequirementComparator = (text) => {
  const normalized = normalizeString(text);
  if (normalized.includes("exactly")) return "exact";
  if (normalized.includes("max")) return "max";
  if (normalized.includes("min")) return "min";
  return null;
};

const parseQualityLabel = (text) => {
  const normalized = normalizeString(text);
  if (normalized.includes("gold")) return "gold";
  if (normalized.includes("silver")) return "silver";
  if (normalized.includes("bronze")) return "bronze";
  return null;
};

const uniqueNumbers = (values) => {
  const unique = [];
  for (const value of values || []) {
    const numeric = toNumber(value);
    if (numeric == null) continue;
    if (!unique.includes(numeric)) unique.push(numeric);
  }
  return unique;
};

const parseEntityIdsFromImages = (images, entityType) => {
  const regexByType = {
    nation_id: /\/nation\/(\d+)\.png/i,
    league_id: /\/league\/(?:dark\/)?(\d+)\.png/i,
    club_id: /\/clubs\/(?:dark\/)?(\d+)\.png/i,
  };
  const regex = regexByType[entityType];
  if (!regex) return [];
  return uniqueNumbers(
    ensureArray(images).map((image) => {
      const src = String(image?.src || "");
      const match = src.match(regex);
      return match ? Number(match[1]) : null;
    }),
  );
};

const EA_KEY_BY_TYPE = Object.freeze({
  team_rating: { key: 19, keyName: "TEAM_RATING" },
  player_quality: { key: 3, keyName: "PLAYER_QUALITY" },
  player_rarity: { key: 18, keyName: "PLAYER_RARITY" },
  player_rarity_group: { key: 25, keyName: "PLAYER_RARITY_GROUP" },
  nation_id: { key: 10, keyName: "NATION_ID" },
  league_id: { key: 11, keyName: "LEAGUE_ID" },
  club_id: { key: 12, keyName: "CLUB_ID" },
  nation_count: { key: 7, keyName: "NATION_COUNT" },
  league_count: { key: 8, keyName: "LEAGUE_COUNT" },
  club_count: { key: 9, keyName: "CLUB_COUNT" },
  same_nation_count: { key: 4, keyName: "SAME_NATION_COUNT" },
  same_league_count: { key: 5, keyName: "SAME_LEAGUE_COUNT" },
  same_club_count: { key: 6, keyName: "SAME_CLUB_COUNT" },
  first_owner_players_count: { key: 30, keyName: "FIRST_OWNER_PLAYERS_COUNT" },
  player_tradability: { key: 33, keyName: "PLAYER_TRADABILITY" },
  player_exact_ovr: { key: 27, keyName: "PLAYER_EXACT_OVR" },
  player_min_ovr: { key: 26, keyName: "PLAYER_MIN_OVR" },
  player_max_ovr: { key: 28, keyName: "PLAYER_MAX_OVR" },
  player_level: { key: 17, keyName: "PLAYER_LEVEL" },
  legend_count: { key: 15, keyName: "LEGEND_COUNT" },
  num_trophy_required: { key: 16, keyName: "NUM_TROPHY_REQUIRED" },
  chemistry_points: { key: 35, keyName: "CHEMISTRY_POINTS" },
  all_players_chemistry_points: {
    key: 36,
    keyName: "ALL_PLAYERS_CHEMISTRY_POINTS",
  },
  players_in_squad: { key: -1, keyName: "PLAYERS_IN_SQUAD" },
});

const EA_SCOPE_BY_OP = Object.freeze({
  min: 0,
  max: 1,
  exact: 2,
});

const EA_VALUE_BY_TYPE = Object.freeze({
  player_level: {
    bronze: 1,
    silver: 2,
    gold: 3,
  },
  player_quality: {
    bronze: 1,
    silver: 2,
    gold: 3,
  },
  player_rarity_group: {
    rare: 4,
  },
});

const INFERRED_MAPPING_TYPES = new Set(["player_level"]);

const toArray = (value) => {
  if (Array.isArray(value)) return value;
  if (value == null) return [];
  return [value];
};

const mapRuleValueToEa = (rule) => {
  const values = toArray(rule?.value);
  const type = rule?.type ?? null;
  const categoricalMap = type ? EA_VALUE_BY_TYPE[type] : null;
  const mapped = values.map((value) => {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (!categoricalMap) return value;
    const key = normalizeString(value);
    return key && Object.hasOwn(categoricalMap, key) ? categoricalMap[key] : value;
  });

  if (!mapped.length) return null;
  return mapped.length === 1 ? mapped[0] : mapped;
};

const buildSyntheticEaRuleMetadata = (rule) => {
  const mapping = EA_KEY_BY_TYPE[rule?.type] || null;
  const scope = Object.hasOwn(EA_SCOPE_BY_OP, rule?.op) ? EA_SCOPE_BY_OP[rule.op] : null;
  const eaValue = mapRuleValueToEa(rule);
  const isSynthetic = Boolean(mapping) || scope != null || eaValue != null;
  if (!isSynthetic) return null;
  return {
    key: mapping?.key ?? null,
    keyName: mapping?.keyName ?? null,
    scope,
    eaValue,
    enumMappingSource: INFERRED_MAPPING_TYPES.has(rule?.type)
      ? "verified-webapp-with-inferred-tier-order"
      : "verified-webapp",
  };
};

const buildRequirementsRawEntry = (rule) => {
  const metadata = buildSyntheticEaRuleMetadata(rule);
  const key = metadata?.key ?? null;
  const scope = metadata?.scope ?? null;
  const eaValue = metadata?.eaValue;
  const values = toArray(eaValue);
  return {
    scope,
    count: rule?.count ?? null,
    isCombinedRequirement: false,
    label: rule?.label ?? null,
    kvPairs:
      key == null || !values.length
        ? {}
        : {
            [String(key)]: values,
          },
  };
};

const buildAutosbcRequirement = (rule) => {
  const metadata = buildSyntheticEaRuleMetadata(rule);
  if (!metadata?.keyName || metadata.scope == null) return null;
  if (rule?.type === "players_in_squad") return null;
  return {
    key: metadata.key,
    keyName: metadata.keyName,
    value: metadata.eaValue,
    count: typeof rule?.count === "number" && rule.count > 0 ? rule.count : 0,
    scope: metadata.scope,
  };
};

const enrichNormalizedRule = (rule) => {
  const metadata = buildSyntheticEaRuleMetadata(rule);
  if (!metadata) return rule;
  return {
    ...rule,
    key: metadata.key,
    keyName: metadata.keyName,
    scope: metadata.scope,
    eaValue: metadata.eaValue,
    enumMappingSource: metadata.enumMappingSource,
  };
};

const baseRule = ({
  type,
  op,
  count,
  value,
  label,
  scopeName,
  source = "futbin-text",
}) => ({
  type,
  key: null,
  keyName: null,
  keyNameNormalized: type,
  typeSource: source,
  op,
  count,
  derivedCount: null,
  value,
  scope: null,
  scopeName,
  label,
});

const makeCountRule = (type, label, numeric, comparator) => {
  const op = comparator;
  const value = numeric != null ? [numeric] : [];
  const count = type === "players_in_squad" && op === "exact" && numeric != null ? numeric : -1;
  const scopeName =
    op === "exact" ? "EXACT" : op === "max" ? "LOWER" : op === "min" ? "GREATER" : null;
  return baseRule({
    type,
    op,
    count,
    value,
    label,
    scopeName,
  });
};

const parseRequirementRow = (row, registry) => {
  const label = String(row?.text || "").replace(/\s+/g, " ").trim();
  if (!label) return { rules: [], unresolved: null };

  const comparator = parseRequirementComparator(label);
  const numeric = parseRequirementNumericTarget(label);
  const imageTitles = ensureArray(row?.images)
    .map((image) => image?.title)
    .filter(Boolean);

  if (/^# of players in squad:/i.test(label)) {
    return {
      rules: [makeCountRule("players_in_squad", label, numeric, "exact")],
      unresolved: null,
    };
  }
  if (/^team chemistry:/i.test(label) || /^total chemistry:/i.test(label)) {
    return {
      rules: [makeCountRule("chemistry_points", label, numeric, comparator)],
      unresolved: null,
    };
  }
  if (/^squad rating:/i.test(label) || /^team rating:/i.test(label)) {
    return {
      rules: [makeCountRule("team_rating", label, numeric, comparator)],
      unresolved: null,
    };
  }
  if (/^same league count:/i.test(label)) {
    return {
      rules: [makeCountRule("same_league_count", label, numeric, comparator)],
      unresolved: null,
    };
  }
  if (/^same nation count:/i.test(label)) {
    return {
      rules: [makeCountRule("same_nation_count", label, numeric, comparator)],
      unresolved: null,
    };
  }
  if (/^same club count:/i.test(label)) {
    return {
      rules: [makeCountRule("same_club_count", label, numeric, comparator)],
      unresolved: null,
    };
  }
  if (/^leagues:/i.test(label)) {
    return {
      rules: [makeCountRule("league_count", label, numeric, comparator)],
      unresolved: null,
    };
  }
  if (/^clubs:/i.test(label)) {
    return {
      rules: [makeCountRule("club_count", label, numeric, comparator)],
      unresolved: null,
    };
  }
  if (/^(nations|nationalities|countries):/i.test(label)) {
    return {
      rules: [makeCountRule("nation_count", label, numeric, comparator)],
      unresolved: null,
    };
  }
  if (/^(gold|silver|bronze) players:/i.test(label)) {
    const quality = parseQualityLabel(label);
    return {
      rules: [
        baseRule({
          type: "player_level",
          op: comparator,
          count: numeric ?? -1,
          value: quality ? [quality] : [],
          label,
          scopeName: comparator === "max" ? "LOWER" : comparator === "exact" ? "EXACT" : "GREATER",
        }),
      ],
      unresolved: quality ? null : label,
    };
  }
  if (/^player level:/i.test(label) || /^player quality:/i.test(label)) {
    const quality = parseQualityLabel(label);
    const type = /^player quality:/i.test(label) ? "player_quality" : "player_level";
    return {
      rules: [
        baseRule({
          type,
          op: comparator,
          count: numeric != null ? numeric : -1,
          value: quality ? [quality] : [],
          label,
          scopeName: comparator === "exact" ? "EXACT" : comparator === "max" ? "LOWER" : "GREATER",
        }),
      ],
      unresolved: quality ? null : label,
    };
  }
  if (/^rare:/i.test(label)) {
    return {
      rules: [
        baseRule({
          type: "player_rarity_group",
          op: comparator,
          count: numeric ?? -1,
          value: ["rare"],
          label,
          scopeName: comparator === "max" ? "LOWER" : comparator === "exact" ? "EXACT" : "GREATER",
        }),
      ],
      unresolved: null,
    };
  }
  if (/^team of the week(?: players?)?:/i.test(label)) {
    return {
      rules: [
        baseRule({
          type: "player_rarity",
          op: comparator,
          count: numeric ?? -1,
          value: [3],
          label,
          scopeName: comparator === "max" ? "LOWER" : comparator === "exact" ? "EXACT" : "GREATER",
        }),
      ],
      unresolved: null,
    };
  }
  if (/rare players:/i.test(label) && !/totw|team of the week/i.test(label)) {
    return {
      rules: [
        baseRule({
          type: "player_rarity_group",
          op: comparator,
          count: numeric ?? -1,
          value: ["rare"],
          label,
          scopeName: comparator === "max" ? "LOWER" : comparator === "exact" ? "EXACT" : "GREATER",
        }),
      ],
      unresolved: null,
    };
  }
  if (/^rare or totw:/i.test(label)) {
    return {
      rules: [
        baseRule({
          type: "player_rarity_group",
          op: comparator,
          count: numeric ?? -1,
          value: ["rare"],
          label,
          scopeName: comparator === "max" ? "LOWER" : comparator === "exact" ? "EXACT" : "GREATER",
          source: "futbin-text-rare-compat",
        }),
      ],
      unresolved: null,
    };
  }

  const quotaMatch = label.match(/^# of players from (.+?):\s*(Min|Max|Exactly)\s*(\d+)/i);
  if (quotaMatch) {
    const entityLabel = quotaMatch[1].trim();
    const op = parseRequirementComparator(quotaMatch[2]);
    const count = Number(quotaMatch[3]);
    const names = imageTitles.length ? imageTitles : entityLabel.split(/\s+or\s+/i).map((part) => part.trim());
    const entityType = (() => {
      if (ensureArray(row?.images).some((image) => /nation/i.test(image?.alt || ""))) return "nation_id";
      if (ensureArray(row?.images).some((image) => /league/i.test(image?.alt || ""))) return "league_id";
      if (ensureArray(row?.images).some((image) => /club/i.test(image?.alt || ""))) return "club_id";
      return null;
    })();
    const bucket = entityType === "nation_id" ? "nations" : entityType === "league_id" ? "leagues" : entityType === "club_id" ? "clubs" : null;
    const resolved = uniqueNumbers(
      (bucket ? resolveEntityIds(names, bucket, registry) : []).concat(
        parseEntityIdsFromImages(row?.images, entityType),
      ),
    );
    if (entityType && resolved.length) {
      return {
        rules: [
          baseRule({
            type: entityType,
            op,
            count,
            value: resolved,
            label,
            scopeName: op === "max" ? "LOWER" : op === "exact" ? "EXACT" : "GREATER",
          }),
        ],
        unresolved: null,
      };
    }
  }

  return { rules: [], unresolved: label };
};

const compileRawGroup = (group, registry) => {
  const challenges = ensureArray(group?.challenges).map((challenge) => {
    const parsedRows = ensureArray(challenge?.requirementsDetailed).map((row) =>
      parseRequirementRow(row, registry),
    );
    const requirements = parsedRows.flatMap((entry) => entry.rules).map(enrichNormalizedRule);
    const unresolvedRequirements = parsedRows
      .map((entry) => entry.unresolved)
      .filter(Boolean);
    const squadSizeRule = requirements.find((rule) => rule.type === "players_in_squad");
    const squadSize =
      squadSizeRule && Array.isArray(squadSizeRule.value) && squadSizeRule.value.length
        ? toNumber(squadSizeRule.value[0])
        : 11;

    return {
      source: "futbin",
      fidelity: unresolvedRequirements.length ? "parsed-text-partial" : "parsed-text",
      challengeId: challenge?.eaChallengeId ?? null,
      setId: group?.futbinGroupId ?? null,
      setIdSource: "futbin_group",
      setName: group?.groupName ?? null,
      challengeName: challenge?.challengeName ?? null,
      openedAt: null,
      challengeStatus: "UNKNOWN",
      squadSize: squadSize ?? 11,
      formationName: challenge?.formationName ?? null,
      formationCode: challenge?.formationCode ?? null,
      slotSource: challenge?.formationSource ?? null,
      squadSlots: ensureArray(challenge?.squadSlots)
        .map((slot, slotIndex) => ({
          slotId: slot?.slotId ?? null,
          slotIndex: toNumber(slot?.slotIndex) ?? slotIndex,
          positionName: String(slot?.positionName ?? "").trim() || null,
        }))
        .filter((slot) => slot.positionName),
      requirementsText: ensureArray(challenge?.requirementsText),
      requirementsRaw: requirements.map(buildRequirementsRawEntry),
      requirements: requirements.map((rule) => ({
        scope: rule.scope ?? null,
        count: rule.count ?? null,
        isCombined: Boolean(rule.combinedPredicate),
        label: rule.label ?? null,
        kvPairs: rule?.key != null ? [{ key: rule.key }] : [],
      })),
      requirementsNormalized: requirements,
      autosbcRequirements: requirements
        .map(buildAutosbcRequirement)
        .filter(Boolean),
      unresolvedRequirements,
      challengeUrl: challenge?.challengeUrl ?? null,
      groupUrl: group?.groupUrl ?? null,
    };
  });

  return challenges;
};

export const buildFutbinCompileReport = ({
  raw,
  inputPath = null,
  playersJson = null,
  aliasesJson = null,
} = {}) => {
  const sourceLabel = inferSourceLabel(inputPath, raw?.queryUrl);

  let registry = makeRegistry();
  if (playersJson) {
    registry = buildRegistryFromPlayers(extractPlayers(playersJson));
  }
  if (aliasesJson) {
    registry = mergeAliasRegistry(registry, aliasesJson);
  }

  const groups = ensureArray(raw?.groups);
  const records = groups.flatMap((group) => compileRawGroup(group, registry));
  const unresolvedCount = records.reduce(
    (sum, record) => sum + ensureArray(record.unresolvedRequirements).length,
    0,
  );

  return {
    exportedAt: new Date().toISOString(),
    recorderVersion: "futbin-compiled-0.2.0",
    source: "futbin",
    sourceLabel,
    inputPath,
    queryUrl: raw?.queryUrl ?? null,
    summary: {
      totalRecords: records.length,
      uniqueChallenges: new Set(records.map((record) => record.challengeId).filter(Boolean)).size,
      unresolvedRequirements: unresolvedCount,
      partialRecords: records.filter((record) => record.fidelity === "parsed-text-partial").length,
      totalGroups: groups.length,
      totalListingPages: raw?.totalListingPages ?? null,
    },
    records,
  };
};

const run = async () => {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage.trim());
    return;
  }
  if (!args.input) throw new Error("Missing --input <file>");

  const inputPath = path.resolve(args.input);
  const raw = await readJson(inputPath);
  let playersJson = null;
  if (args.players) {
    playersJson = await readJson(path.resolve(args.players));
  }
  let aliasesJson = null;
  if (args.aliases) {
    aliasesJson = await readJson(path.resolve(args.aliases));
  }

  const report = buildFutbinCompileReport({
    raw,
    inputPath,
    playersJson,
    aliasesJson,
  });

  const outputPath = args.output
    ? path.resolve(args.output)
    : path.resolve(`data/${sourceLabel}-compiled-${toIsoFileStamp()}.json`);
  await fs.writeFile(outputPath, JSON.stringify(report, null, 2), "utf8");

  console.log("[Futbin Compile] Wrote:", outputPath);
  console.log(
    `[Futbin Compile] Records: ${report.summary.totalRecords}, Groups: ${report.summary.totalGroups}, Pages: ${report.summary.totalListingPages ?? "n/a"}, Partial: ${report.summary.partialRecords}, Unresolved lines: ${report.summary.unresolvedRequirements}`,
  );
};

const isMainModule = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (isMainModule) {
  run().catch((error) => {
    console.error("[Futbin Compile] Failed:", error?.message || error);
    process.exitCode = 1;
  });
}
