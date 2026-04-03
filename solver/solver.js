import { compileConstraintSet } from "./constraint-compiler.js";
import {
  computeBestChemistryAssignment,
  normalizeSlotsForChemistry,
} from "./chemistry.js";

const ROUND_DECIMALS = 2;
const ROUND_THRESHOLD = 0.96;
const SOLVER_VERSION = "debug-3";
const DEFAULT_SQUAD_SIZE = 11;

const REQUIREMENT_KEYS = [
  "players_in_squad",
  "team_rating",
  "player_quality",
  "player_rarity",
  "player_rarity_group",
  "player_rarity_or_totw",
  "nation_id",
  "league_id",
  "club_id",
  "nation_count",
  "league_count",
  "club_count",
  "same_nation_count",
  "same_league_count",
  "same_club_count",
  "first_owner_players_count",
  "player_tradability",
  "player_exact_ovr",
  "player_min_ovr",
  "player_max_ovr",
  "player_inform",
  "loan_players",
  "player_level",
  "legend_count",
  "num_trophy_required",
  "chemistry_points",
  "all_players_chemistry_points",
];

const TYPE_ALIASES = {
  player_count: "players_in_squad",
  player_count_combined: "players_in_squad",
  num_players: "players_in_squad",
  players_required: "players_in_squad",
  team_star_rating: "team_rating",
  countries_in_squad: "nation_count",
  leagues_in_squad: "league_count",
  clubs_in_squad: "club_count",
  players_same_nation: "same_nation_count",
  players_same_league: "same_league_count",
  players_same_club: "same_club_count",
  total_chemistry: "chemistry_points",
  player_quality: "player_quality",
  player_rarity: "player_rarity",
  player_rarity_group: "player_rarity_group",
  player_rarity_or_totw: "player_rarity_or_totw",
  nation_id: "nation_id",
  league_id: "league_id",
  club_id: "club_id",
  nation_count: "nation_count",
  league_count: "league_count",
  club_count: "club_count",
  same_nation_count: "same_nation_count",
  same_league_count: "same_league_count",
  same_club_count: "same_club_count",
  first_owner_players_count: "first_owner_players_count",
  player_tradability: "player_tradability",
  player_exact_ovr: "player_exact_ovr",
  player_min_ovr: "player_min_ovr",
  player_max_ovr: "player_max_ovr",
  team_rating: "team_rating",
  players_in_squad: "players_in_squad",
  player_inform: "player_inform",
  loan_players: "loan_players",
  player_level: "player_level",
  legend_count: "legend_count",
  num_trophy_required: "num_trophy_required",
  chemistry_points: "chemistry_points",
  all_players_chemistry_points: "all_players_chemistry_points",
};

const ENUM_TO_TYPE = {
  TEAM_STAR_RATING: "team_rating",
  TEAM_RATING: "team_rating",
  PLAYER_COUNT: "players_in_squad",
  PLAYER_COUNT_COMBINED: "players_in_squad",
  PLAYERS_IN_SQUAD: "players_in_squad",
  PLAYER_QUALITY: "player_quality",
  PLAYER_RARITY: "player_rarity",
  PLAYER_RARITY_GROUP: "player_rarity_group",
  PLAYER_MIN_OVR: "player_min_ovr",
  PLAYER_MAX_OVR: "player_max_ovr",
  PLAYER_EXACT_OVR: "player_exact_ovr",
  NATION_ID: "nation_id",
  LEAGUE_ID: "league_id",
  CLUB_ID: "club_id",
  NATION_COUNT: "nation_count",
  LEAGUE_COUNT: "league_count",
  CLUB_COUNT: "club_count",
  SAME_NATION_COUNT: "same_nation_count",
  SAME_LEAGUE_COUNT: "same_league_count",
  SAME_CLUB_COUNT: "same_club_count",
  FIRST_OWNER_PLAYERS_COUNT: "first_owner_players_count",
  PLAYER_TRADABILITY: "player_tradability",
  PLAYER_LEVEL: "player_level",
  LEGEND_COUNT: "legend_count",
  NUM_TROPHY_REQUIRED: "num_trophy_required",
  CHEMISTRY_POINTS: "chemistry_points",
  ALL_PLAYERS_CHEMISTRY_POINTS: "all_players_chemistry_points",
};

const FILTER_PRIORITY = [
  "player_level",
  "player_quality",
  "player_inform",
  "nation_id",
  "league_id",
  "club_id",
  "same_nation_count",
  "same_league_count",
  "same_club_count",
  "player_rarity",
  "player_rarity_group",
  "player_rarity_or_totw",
  "first_owner_players_count",
  "player_tradability",
  "player_exact_ovr",
];

const toNumber = (value) => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
};

const readOptionalBoolean = (value) => {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (value === 1) return true;
    if (value === 0) return false;
    return null;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(normalized)) return true;
    if (["false", "0", "no", "off"].includes(normalized)) return false;
  }
  return null;
};

const toBooleanSetting = (value, fallback = false) => {
  const parsed = readOptionalBoolean(value);
  if (parsed == null) return Boolean(fallback);
  return parsed;
};

const normalizeString = (value) =>
  value == null ? null : String(value).trim().toLowerCase();

const isTotwPlayer = (player) => {
  const rarity = normalizeString(player?.rarityName);
  if (rarity) {
    if (rarity.includes("team of the week")) return true;
    if (rarity.includes("totw")) return true;
    if (rarity.includes("inform")) return true;
  }
  return toNumber(player?.rarityId) === 3;
};

const extractValues = (value) => {
  if (value == null) return [];
  if (Array.isArray(value)) return value.flatMap(extractValues);
  if (typeof value === "object") {
    if (Array.isArray(value.values)) return value.values.flatMap(extractValues);
    if (value._collection)
      return Object.values(value._collection).flatMap(extractValues);
    return Object.values(value).flatMap(extractValues);
  }
  return [value];
};

const normalizeValueItem = (value) => {
  const numeric = toNumber(value);
  if (numeric != null) return numeric;
  return normalizeString(value);
};

const normalizeRequirementType = (rule) => {
  if (!rule) return null;
  const rawType = normalizeString(rule.type);
  const keyName = normalizeString(rule.keyNameNormalized || rule.keyName);
  const enumType =
    ENUM_TO_TYPE[rule.keyName] || ENUM_TO_TYPE[rule.keyNameNormalized];
  const type =
    enumType ||
    TYPE_ALIASES[rawType] ||
    TYPE_ALIASES[keyName] ||
    rawType ||
    keyName;
  if (type) return type;
  const label = normalizeString(rule.label);
  if (!label) return null;
  if (label.includes("players in the squad")) return "players_in_squad";
  if (label.includes("team rating")) return "team_rating";
  if (label.includes("player quality")) return "player_quality";
  if (label.includes("rare")) return "player_rarity_group";
  if (label.includes("first owner")) return "first_owner_players_count";
  if (label.includes("untrade")) return "player_tradability";
  return null;
};

export const getRequirementFlags = (
  requirementsNormalized = [],
  overrides = {},
) => {
  const flags = Object.fromEntries(REQUIREMENT_KEYS.map((key) => [key, false]));
  const list = Array.isArray(requirementsNormalized)
    ? requirementsNormalized
    : [];
  const compiled = compileConstraintSet(list, {
    fallbackSquadSize: DEFAULT_SQUAD_SIZE,
  });
  for (const constraint of compiled.constraints) {
    const type = constraint?.type ?? null;
    if (!type) continue;
    if (Object.prototype.hasOwnProperty.call(flags, type)) {
      flags[type] = true;
    }
  }
  for (const [key, value] of Object.entries(overrides || {})) {
    if (Object.prototype.hasOwnProperty.call(flags, key)) {
      flags[key] = Boolean(value);
    }
  }
  return flags;
};

const getPlayerQuality = (rating) => {
  if (rating >= 75) return "gold";
  if (rating >= 65) return "silver";
  return "bronze";
};

const normalizeQualityValue = (value) => {
  if (value == null) return null;
  const text = normalizeString(value);
  if (text === "gold" || text === "silver" || text === "bronze") return text;
  const numeric = toNumber(value);
  if (numeric != null) {
    if (numeric <= 1) return "bronze";
    if (numeric === 2) return "silver";
    if (numeric >= 3) return "gold";
  }
  return text;
};

const QUALITY_ORDER = { bronze: 1, silver: 2, gold: 3 };

const normalizeQualityValues = (values) =>
  (values || [])
    .map(normalizeQualityValue)
    .filter(
      (value) =>
        value && Object.prototype.hasOwnProperty.call(QUALITY_ORDER, value),
    );

const buildQualityGatePredicate = (rule) => {
  if (!rule) return null;
  if (rule.type !== "player_quality" && rule.type !== "player_level")
    return null;
  const normalized = normalizeQualityValues(rule.values);
  if (!normalized.length) return null;

  // Exact: allow the listed qualities.
  if (rule.op === "exact") {
    const allowed = new Set(normalized);
    return (player) => allowed.has(player?.quality);
  }

  // Min/max apply an ordinal bound across the squad.
  const ranks = normalized
    .map((quality) => QUALITY_ORDER[quality])
    .filter((rank) => rank != null);
  if (!ranks.length) return null;
  if (rule.op === "min") {
    const threshold = Math.max(...ranks);
    return (player) => (QUALITY_ORDER[player?.quality] ?? 0) >= threshold;
  }
  if (rule.op === "max") {
    const threshold = Math.min(...ranks);
    return (player) => (QUALITY_ORDER[player?.quality] ?? 0) <= threshold;
  }

  return null;
};

const deriveValuesFromLabel = (rule, fallback = []) => {
  if (fallback.length) return fallback;
  const label = normalizeString(rule?.label || rule?.raw?.label);
  if (!label) return fallback;
  if (rule?.type === "player_quality") {
    if (label.includes("gold")) return ["gold"];
    if (label.includes("silver")) return ["silver"];
    if (label.includes("bronze")) return ["bronze"];
  }
  if (rule?.type === "player_rarity" || rule?.type === "player_rarity_group") {
    if (label.includes("rare")) return ["rare"];
    if (label.includes("common")) return ["common"];
  }
  return fallback;
};

const normalizePlayers = (players) => {
  const list = Array.isArray(players) ? players : [];
  const seen = new Set();
  const normalized = [];
  for (const item of list) {
    if (!item || item.id == null) continue;
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    const rating = toNumber(item.rating) ?? 0;
    const isSpecial =
      typeof item.isSpecial === "function"
        ? Boolean(item.isSpecial())
        : Boolean(item.isSpecial);
    const rarityName = item.rarityName ? String(item.rarityName) : null;
    const isTotw = isTotwPlayer({
      rarityName,
      rarityId: item?.rarityId ?? null,
    });
    const isEvolution =
      typeof item.isEvolution === "function"
        ? Boolean(item.isEvolution())
        : Boolean(item.isEvolution ?? item.upgrades);
    normalized.push({
      ...item,
      rating,
      quality: getPlayerQuality(rating),
      rarityName,
      isStorage: Boolean(item.isStorage),
      isUntradeable: Boolean(item.isUntradeable),
      isDuplicate: Boolean(item.isDuplicate),
      isSpecial,
      isTotw,
      isEvolution,
    });
  }
  return normalized;
};

const collectLockedPlayerIdsFromSlots = (slots) => {
  const list = Array.isArray(slots) ? slots : [];
  const lockedIds = new Set();
  for (const slot of list) {
    const item = slot?.item ?? null;
    if (!item || typeof item !== "object") continue;
    const concept =
      typeof item.isConcept === "function"
        ? item.isConcept()
        : Boolean(item?.concept);
    if (concept) continue;
    const id = item?.id ?? null;
    if (id == null) continue;
    const normalizedId = String(id);
    if (!normalizedId || normalizedId === "0") continue;
    lockedIds.add(normalizedId);
  }
  return lockedIds;
};

const roundTo = (value, decimals) => {
  if (!Number.isFinite(value)) return 0;
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
};

const computeAverage = (ratings) => {
  const list = Array.isArray(ratings) ? ratings : [];
  const n = list.length;
  if (!n) return 0;
  let total = 0;
  for (let i = 0; i < n; i += 1) {
    total += list[i];
  }
  return total / n;
};

const computeAdjustedAverage = (ratings) => {
  const list = Array.isArray(ratings) ? ratings : [];
  const n = list.length;
  if (!n) return 0;
  let sum = 0;
  for (let i = 0; i < n; i += 1) {
    sum += list[i];
  }
  const avg = sum / n;
  let adjustedSum = 0;
  for (let i = 0; i < n; i += 1) {
    const rating = list[i];
    adjustedSum += rating <= avg ? rating : 2 * rating - avg;
  }
  return adjustedSum / n;
};

const computeSquadRating = (ratings) => {
  if (!ratings.length) return 0;
  const adjustedAverage = computeAdjustedAverage(ratings);
  const roundedAverage = roundTo(adjustedAverage, ROUND_DECIMALS);
  const decimal = roundedAverage - Math.floor(roundedAverage);
  const scaledDecimal = roundTo(decimal * 100, 2);
  const base = Math.floor(roundedAverage);
  if (scaledDecimal >= ROUND_THRESHOLD * 100) return base + 1;
  return base;
};

export const buildSolverContext = ({
  players = [],
  requirementsNormalized = [],
  requirementOverrides = {},
  debug = false,
  solverDebug = false,
  filters = {},
  prioritize = {},
  optimize = {},
  requiredPlayers = null,
  squadSlots = null,
} = {}) => {
  const normalizedFilters = {
    ...(filters && typeof filters === "object" ? filters : {}),
    onlyStorage: toBooleanSetting(filters?.onlyStorage, false),
    onlyUntradeables: toBooleanSetting(filters?.onlyUntradeables, false),
    onlyDuplicates: toBooleanSetting(filters?.onlyDuplicates, false),
    excludeSpecial: toBooleanSetting(filters?.excludeSpecial, false),
    useTotwPlayers: toBooleanSetting(filters?.useTotwPlayers, true),
    useEvolutionPlayers: toBooleanSetting(filters?.useEvolutionPlayers, false),
    preserveOccupiedSlots: toBooleanSetting(
      filters?.preserveOccupiedSlots,
      false,
    ),
  };

  let normalizedPlayers = normalizePlayers(players);
  const lockedSlotPlayerIds = collectLockedPlayerIdsFromSlots(squadSlots);
  const excludedIds = new Set(
    (normalizedFilters?.excludedPlayerIds ?? [])
      .map((value) => (value == null ? null : String(value)))
      .filter(Boolean),
  );
  if (excludedIds.size) {
    normalizedPlayers = normalizedPlayers.filter((player) => {
      if (player?.id == null) return true;
      return !excludedIds.has(String(player.id));
    });
  }
  if (!normalizedFilters.useEvolutionPlayers) {
    normalizedPlayers = normalizedPlayers.filter((player) => {
      if (!player?.isEvolution) return true;
      if (player?.id == null) return false;
      return lockedSlotPlayerIds.has(String(player.id));
    });
  }
  if (normalizedFilters.onlyStorage) {
    normalizedPlayers = normalizedPlayers.filter((player) => player.isStorage);
  }
  if (normalizedFilters.onlyUntradeables) {
    normalizedPlayers = normalizedPlayers.filter(
      (player) => player.isUntradeable,
    );
  }
  if (normalizedFilters.onlyDuplicates) {
    normalizedPlayers = normalizedPlayers.filter(
      (player) => player.isDuplicate,
    );
  }
  if (!normalizedFilters.useTotwPlayers) {
    normalizedPlayers = normalizedPlayers.filter((player) => {
      if (!player?.isTotw) return true;
      if (player?.id == null) return false;
      return lockedSlotPlayerIds.has(String(player.id));
    });
  }
  if (normalizedFilters.excludeSpecial) {
    normalizedPlayers = normalizedPlayers.filter((player) => {
      if (!player?.isSpecial || player?.isTotw) return true;
      if (player?.id == null) return false;
      return lockedSlotPlayerIds.has(String(player.id));
    });
  }
  if (prioritize?.duplicates) {
    normalizedPlayers = normalizedPlayers
      .slice()
      .sort(
        (a, b) =>
          Number(Boolean(b.isDuplicate)) - Number(Boolean(a.isDuplicate)),
      );
  }
  if (prioritize?.untradeables) {
    normalizedPlayers = normalizedPlayers
      .slice()
      .sort(
        (a, b) =>
          Number(Boolean(b.isUntradeable)) - Number(Boolean(a.isUntradeable)),
      );
  }
  if (prioritize?.storage) {
    normalizedPlayers = normalizedPlayers
      .slice()
      .sort(
        (a, b) => Number(Boolean(b.isStorage)) - Number(Boolean(a.isStorage)),
      );
  }
  return {
    players: normalizedPlayers,
    requirementsNormalized,
    requirementFlags: getRequirementFlags(
      requirementsNormalized,
      requirementOverrides,
    ),
    debug: Boolean(debug || solverDebug),
    optimize,
    requiredPlayers: toNumber(requiredPlayers),
    squadSlots: Array.isArray(squadSlots) ? squadSlots : null,
    filters: normalizedFilters,
  };
};

const normalizeRules = (
  requirementsNormalized,
  requirementFlags,
  debugPush,
  precompiled = null,
) => {
  const list = Array.isArray(requirementsNormalized)
    ? requirementsNormalized
    : [];
  const compiled =
    precompiled ||
    compileConstraintSet(list, {
      fallbackSquadSize: DEFAULT_SQUAD_SIZE,
    });

  for (const unsupported of compiled.unsupportedRules || []) {
    debugPush?.({
      stage: "rule",
      action: "skip",
      reason: "unmapped",
      key: unsupported?.key ?? null,
      keyName: unsupported?.keyName ?? null,
      label: unsupported?.label ?? null,
    });
  }

  return (compiled.constraints || [])
    .map((constraint) => {
      const type = constraint?.type ?? null;
      const rawRule = constraint?.raw ?? null;
      if (!type || !rawRule) return null;
      if (
        requirementFlags &&
        Object.prototype.hasOwnProperty.call(requirementFlags, type) &&
        !requirementFlags[type]
      ) {
        debugPush?.({
          stage: "rule",
          action: "skip",
          reason: "flag_disabled",
          type,
          key: rawRule.key ?? null,
          keyName: rawRule.keyName ?? null,
          label: rawRule.label ?? null,
        });
        return null;
      }

      const normalized = {
        type,
        category: constraint.category ?? null,
        op: constraint.op ?? null,
        count: constraint.count ?? null,
        target: constraint.target ?? null,
        values: Array.isArray(constraint.values) ? constraint.values : [],
        raw: rawRule,
      };
      // Validity checks run these predicates many times during rating/chemistry optimization.
      // Precompute them once to avoid rebuilding closures in hot loops.
      normalized.predicate = buildPredicate(normalized);
      normalized.gatePredicate = buildQualityGatePredicate(normalized);

      debugPush?.({
        stage: "rule",
        action: "use",
        type: normalized.type,
        category: normalized.category,
        op: normalized.op,
        count: normalized.count,
        target: normalized.target,
        values: normalized.values,
        key: rawRule.key ?? null,
        keyName: rawRule.keyName ?? null,
        label: rawRule.label ?? null,
      });

      return normalized;
    })
    .filter(Boolean);
};

const FULL_SQUAD_EXACT_TYPES = new Set([
  "player_level",
  "player_quality",
  "player_rarity",
  "player_rarity_group",
  "player_tradability",
  "player_inform",
]);

const VALUE_TARGET_TYPES = new Set([
  "players_in_squad",
  "team_rating",
  "nation_count",
  "league_count",
  "club_count",
  "same_nation_count",
  "same_league_count",
  "same_club_count",
  "chemistry_points",
  "all_players_chemistry_points",
  "legend_count",
  "num_trophy_required",
]);

const getRuleCount = (rule, squadSize) => {
  if (!rule) return null;
  const count = toNumber(rule.count);
  if (count != null && count > 0) return count;
  const target = toNumber(rule.target);
  if (target != null && target > 0) return target;
  if (
    (count == null || count <= 0) &&
    rule.op === "exact" &&
    FULL_SQUAD_EXACT_TYPES.has(rule.type) &&
    squadSize != null &&
    squadSize > 0 &&
    Array.isArray(rule.values) &&
    rule.values.length
  ) {
    return squadSize;
  }
  if (rule.type === "players_in_squad") {
    const numeric = rule.values.map(toNumber).filter((v) => v != null);
    if (numeric.length) return numeric[0];
  }
  if (rule.type === "team_rating") {
    const numeric = rule.values.map(toNumber).filter((v) => v != null);
    if (numeric.length) return numeric[0];
  }
  if (count != null && count <= 0 && VALUE_TARGET_TYPES.has(rule.type)) {
    const numeric = rule.values.map(toNumber).filter((v) => v != null);
    if (numeric.length) return numeric[0];
  }
  return null;
};

const getSquadSize = (rules, fallback) => {
  const sizes = rules
    .filter((rule) => rule.type === "players_in_squad")
    .map((rule) => getRuleCount(rule))
    .filter((value) => value != null && value > 0);
  if (sizes.length) return Math.max(...sizes);
  return fallback;
};

const getTeamRatingTarget = (rules) => {
  const rule = rules.find((item) => item.type === "team_rating");
  if (!rule) return null;
  const target = getRuleCount(rule);
  if (target == null) return null;
  return { target, rule: rule.raw };
};

const getInformRequirementBounds = (rules, squadSize) => {
  let min = 0;
  let max = Infinity;
  for (const rule of rules || []) {
    if (!rule || rule.type !== "player_inform") continue;
    const required = getRuleCount(rule, squadSize);
    if (required == null) continue;
    if (rule.op === "min") {
      min = Math.max(min, required);
      continue;
    }
    if (rule.op === "max") {
      max = Math.min(max, required);
      continue;
    }
    if (rule.op === "exact") {
      min = Math.max(min, required);
      max = Math.min(max, required);
    }
  }
  if (!Number.isFinite(max)) max = Infinity;
  return { min, max };
};

const getUniqueCountRequirementBounds = (rules, type, squadSize) => {
  let min = 0;
  let max = Infinity;
  for (const rule of rules || []) {
    if (!rule || rule.type !== type) continue;
    const required = getRuleCount(rule, squadSize);
    if (required == null) continue;
    if (rule.op === "min") {
      min = Math.max(min, required);
      continue;
    }
    if (rule.op === "max") {
      max = Math.min(max, required);
      continue;
    }
    if (rule.op === "exact") {
      min = Math.max(min, required);
      max = Math.min(max, required);
    }
  }
  if (!Number.isFinite(max)) max = Infinity;
  return { min, max };
};

const getChemistryRequirementTargets = (rules, squadSize) => {
  let total = null;
  let minEach = null;
  for (const rule of rules || []) {
    if (!rule) continue;
    if (
      rule.type !== "chemistry_points" &&
      rule.type !== "all_players_chemistry_points"
    ) {
      continue;
    }
    const required = getRuleCount(rule, squadSize);
    if (required == null) continue;
    if (rule.type === "chemistry_points") {
      total = total == null ? required : Math.max(total, required);
    } else {
      minEach = minEach == null ? required : Math.max(minEach, required);
    }
  }
  return { total, minEach };
};

const getRarityHint = (rule) => {
  const label = normalizeString(rule?.raw?.label);
  if (label) {
    if (label.includes("rare")) return "rare";
    if (label.includes("common")) return "common";
  }
  const textValues = rule?.values?.map(normalizeString).filter(Boolean) || [];
  if (textValues.some((value) => value.includes("rare"))) return "rare";
  if (textValues.some((value) => value.includes("common"))) return "common";
  return null;
};

const isInformPlayer = (player) => {
  const rarity = normalizeString(player?.rarityName);
  if (rarity) {
    if (rarity.includes("team of the week")) return true;
    if (rarity.includes("totw")) return true;
    if (rarity.includes("inform")) return true;
  }
  if (toNumber(player?.rarityId) === 3) return true;
  return false;
};

const isChemistrySatisfied = (chemistry, targets) => {
  if (!targets) return true;
  const totalTarget = toNumber(targets.total);
  const minTarget = toNumber(targets.minEach);
  if (totalTarget == null && minTarget == null) return true;
  if (!chemistry) return false;
  if (totalTarget != null && (toNumber(chemistry.totalChem) ?? 0) < totalTarget)
    return false;
  if (minTarget != null && (toNumber(chemistry.minChem) ?? 0) < minTarget)
    return false;
  return true;
};

const getChemistryShortfall = (chemistry, targets) => {
  const totalTarget = toNumber(targets?.total);
  const minTarget = toNumber(targets?.minEach);
  const totalChem = toNumber(chemistry?.totalChem) ?? 0;
  const minChem = toNumber(chemistry?.minChem) ?? 0;
  const totalShort =
    totalTarget == null ? 0 : Math.max(0, totalTarget - totalChem);
  const minShort = minTarget == null ? 0 : Math.max(0, minTarget - minChem);
  return {
    totalShort,
    minShort,
    // Per-player minimum chemistry is usually harder to satisfy than +1 total chemistry.
    score: totalShort + minShort * 3,
  };
};

const buildPredicate = (rule) => {
  if (!rule) return null;
  const values = rule.values || [];
  const type = rule.type;
  if (type === "player_quality" || type === "player_level") {
    const normalized = values.map(normalizeQualityValue).filter(Boolean);
    if (!normalized.length) return null;
    return (player) => normalized.includes(player.quality);
  }
  if (
    type === "player_rarity" ||
    type === "player_rarity_group" ||
    type === "player_rarity_or_totw"
  ) {
    const numericValues = values.map(toNumber).filter((v) => v != null);
    const textValues = values.map(normalizeString).filter(Boolean);
    const hint = getRarityHint(rule);
    return (player) => {
      if (type === "player_rarity_or_totw") {
        const name = normalizeString(player.rarityName);
        const rareMatch = !player.isSpecial && ((player.rarityId != null ? player.rarityId >= 1 : false) || (name ? name.includes("rare") : false));
        return rareMatch || isTotwPlayer(player);
      }
      const name = normalizeString(player.rarityName);
      const numericMatch =
        numericValues.length && player.rarityId != null
          ? numericValues.includes(player.rarityId)
          : false;
      const textMatch =
        textValues.length && name
          ? textValues.some((value) => name.includes(value))
          : false;
      if (hint === "rare") {
        // EA treats "Rare" as the base rare/common flag, not "any special card".
        // Special items (TOTW, promos, etc.) should not satisfy generic "Rare: Min X" constraints.
        // This preserves specials and prevents false-positive eligibility when EA excludes specials.
        const isRare =
          numericMatch ||
          (player.rarityId != null ? player.rarityId >= 1 : false) ||
          (name ? name.includes("rare") : false) ||
          textMatch;
        return isRare && !player.isSpecial;
      }
      if (hint === "common") {
        return (
          numericMatch ||
          (player.rarityId != null ? player.rarityId === 0 : false) ||
          (name ? name.includes("common") : false) ||
          textMatch
        );
      }
      if (numericMatch || textMatch) return true;
      return false;
    };
  }
  if (type === "nation_id") {
    const ids = values.map(toNumber).filter((v) => v != null);
    if (!ids.length) return null;
    return (player) => ids.includes(player.nationId);
  }
  if (type === "league_id") {
    const ids = values.map(toNumber).filter((v) => v != null);
    if (!ids.length) return null;
    return (player) => ids.includes(player.leagueId);
  }
  if (type === "club_id") {
    const ids = values.map(toNumber).filter((v) => v != null);
    if (!ids.length) return null;
    return (player) => ids.includes(player.teamId);
  }
  if (type === "first_owner_players_count") {
    return (player) => {
      const owners = toNumber(player.owners);
      if (owners != null) return owners <= 1;
      return Boolean(player.isFirstOwner);
    };
  }
  if (type === "player_tradability") {
    const normalized = values.map(normalizeString).filter(Boolean);
    const numeric = values.map(toNumber).filter((v) => v != null);
    return (player) => {
      if (numeric.length) {
        if (numeric.includes(1)) return Boolean(player.isTradeable);
        if (numeric.includes(0)) return !player.isTradeable;
      }
      if (normalized.some((value) => value.includes("untrade"))) {
        return !player.isTradeable;
      }
      if (normalized.some((value) => value.includes("trade"))) {
        return Boolean(player.isTradeable);
      }
      return false;
    };
  }
  if (type === "player_exact_ovr") {
    const threshold = toNumber(values[0]);
    if (threshold == null) return null;
    return (player) => player.rating === threshold;
  }
  if (type === "player_min_ovr") {
    const threshold = toNumber(values[0]);
    if (threshold == null) return null;
    return (player) => player.rating >= threshold;
  }
  if (type === "player_max_ovr") {
    const threshold = toNumber(values[0]);
    if (threshold == null) return null;
    return (player) => player.rating <= threshold;
  }
  if (type === "player_inform") {
    return (player) => isInformPlayer(player);
  }
  if (type === "loan_players") {
    return (player) => Boolean(player.isLoaned || player.isLoan);
  }
  return null;
};

const countByAttr = (squad, attr) => {
  const counts = new Map();
  for (const player of squad) {
    const value = player?.[attr];
    if (value == null) continue;
    counts.set(value, (counts.get(value) || 0) + 1);
  }
  return counts;
};

const countMatching = (squad, predicate) =>
  squad.reduce((total, player) => (predicate(player) ? total + 1 : total), 0);

const getAvailablePlayers = (players, squad) => {
  const used = new Set(squad.map((player) => player.id));
  return players.filter((player) => !used.has(player.id));
};

const pickLowestRated = (players, lockedIds) => {
  let best = null;
  for (const player of players) {
    if (!player) continue;
    if (lockedIds?.has(player.id)) continue;
    if (!best || player.rating < best.rating) best = player;
  }
  return best;
};

const pickHighestRated = (players, lockedIds) => {
  let best = null;
  for (const player of players) {
    if (!player) continue;
    if (lockedIds?.has(player.id)) continue;
    if (!best || player.rating > best.rating) best = player;
  }
  return best;
};

const replacePlayer = (squad, outPlayer, inPlayer) => {
  const index = squad.findIndex((player) => player.id === outPlayer.id);
  if (index === -1) return false;
  squad[index] = inPlayer;
  return true;
};

const AXIS_TO_ATTR = {
  league: "leagueId",
  nation: "nationId",
  club: "teamId",
};

const getSeedPoolBiasScore = (player, seed) => {
  if (!seed || typeof seed?.poolBias !== "function") return 0;
  const score = toNumber(seed.poolBias(player));
  return score == null ? 0 : score;
};

const getPrefillBiasBoost = (prefillBias, attr, group) => {
  if (!prefillBias || typeof prefillBias !== "object") return 0;
  const biasAttr = AXIS_TO_ATTR[prefillBias.axis] ?? null;
  if (!biasAttr || biasAttr !== attr) return 0;
  if (group == null || prefillBias.groupId == null) return 0;
  if (String(group) !== String(prefillBias.groupId)) return 0;
  return Math.max(1, toNumber(prefillBias.strength) ?? 3) * 1000;
};

const selectGroupForSameCount = (players, attr, required, options = {}) => {
  const groups = new Map();
  for (const player of players) {
    const value = player?.[attr];
    if (value == null) continue;
    if (!groups.has(value)) groups.set(value, []);
    groups.get(value).push(player);
  }
  let bestGroup = null;
  let bestCount = 0;
  let bestAvg = Infinity;
  for (const [group, list] of groups.entries()) {
    if (required != null && list.length < required) continue;
    const avg = computeAverage(list.map((player) => player.rating));
    const biasBoost = getPrefillBiasBoost(options?.prefillBias, attr, group);
    const effectiveCount = list.length + biasBoost;
    if (
      effectiveCount > bestCount ||
      (effectiveCount === bestCount && avg < bestAvg)
    ) {
      bestGroup = group;
      bestCount = effectiveCount;
      bestAvg = avg;
    }
  }
  return bestGroup;
};

const PREFILL_PREFERENCE_TYPES = new Set([
  "nation_id",
  "league_id",
  "club_id",
  "player_level",
  "player_quality",
  "player_rarity",
  "player_rarity_group",
  "player_tradability",
  "first_owner_players_count",
  "player_exact_ovr",
  "player_inform",
]);

const buildPrefillPreferencePredicates = (rules, squad, squadSize) => {
  const preferences = [];
  for (const rule of rules || []) {
    if (!rule || !PREFILL_PREFERENCE_TYPES.has(rule.type)) continue;
    if (rule.op !== "min" && rule.op !== "exact") continue;
    const required = getRuleCount(rule, squadSize);
    if (required == null || required <= 0) continue;
    const predicate = rule.predicate || buildPredicate(rule);
    if (typeof predicate !== "function") continue;
    const current = countMatching(squad, predicate);
    const deficit = required - current;
    if (deficit <= 0) continue;
    preferences.push({
      type: rule.type,
      predicate,
      weight: deficit,
    });
  }
  return preferences;
};

const prefillPlayers = (
  squad,
  pool,
  predicate,
  required,
  lockedIds,
  options = {},
) => {
  if (!predicate || required == null || required <= 0) return false;
  const squadSizeCap = toNumber(options?.squadSizeCap);
  const ratingHintPivot = toNumber(options?.ratingHint?.pivot);
  const useRatingHint =
    ratingHintPivot != null && Number.isFinite(ratingHintPivot);
  const preferencePredicates = Array.isArray(options?.preferencePredicates)
    ? options.preferencePredicates.filter(
        (entry) => entry && typeof entry.predicate === "function",
      )
    : [];
  const remainingCapacity =
    squadSizeCap != null && Array.isArray(squad)
      ? Math.max(0, squadSizeCap - squad.length)
      : null;
  if (remainingCapacity != null && remainingCapacity <= 0) return false;
  const current = countMatching(squad, predicate);
  let needed = required - current;
  if (needed <= 0) return true;
  if (remainingCapacity != null) {
    needed = Math.min(needed, remainingCapacity);
    if (needed <= 0) return true;
  }

  const uniqueMaxByAttr = options?.uniqueMaxByAttr;
  const sameMaxByAttr = options?.sameMaxByAttr;
  const predicateCaps = Array.isArray(options?.predicateCaps)
    ? options.predicateCaps
    : [];
  const uniqueEntries =
    uniqueMaxByAttr instanceof Map
      ? Array.from(uniqueMaxByAttr.entries())
      : uniqueMaxByAttr && typeof uniqueMaxByAttr === "object"
        ? Object.entries(uniqueMaxByAttr)
        : [];
  const uniqueState = uniqueEntries
    .map(([attr, max]) => ({ attr, max: toNumber(max), values: new Set() }))
    .filter((entry) => entry.attr && entry.max != null && entry.max > 0);
  for (const entry of uniqueState) {
    for (const player of squad || []) {
      const value = player?.[entry.attr];
      if (value == null) continue;
      entry.values.add(value);
    }
  }

  const sameEntries =
    sameMaxByAttr instanceof Map
      ? Array.from(sameMaxByAttr.entries())
      : sameMaxByAttr && typeof sameMaxByAttr === "object"
        ? Object.entries(sameMaxByAttr)
        : [];
  const sameState = sameEntries
    .map(([attr, max]) => ({ attr, max: toNumber(max), counts: new Map() }))
    .filter((entry) => entry.attr && entry.max != null && entry.max > 0);
  for (const entry of sameState) {
    for (const player of squad || []) {
      const value = player?.[entry.attr];
      if (value == null) continue;
      entry.counts.set(value, (entry.counts.get(value) || 0) + 1);
    }
  }

  const capState = predicateCaps
    .map((cap) => {
      const max = toNumber(cap?.max ?? cap?.required);
      const pred = cap?.predicate;
      if (max == null || max < 0) return null;
      if (typeof pred !== "function") return null;
      return { max, predicate: pred, count: 0 };
    })
    .filter(Boolean);
  for (const cap of capState) {
    cap.count = countMatching(squad, cap.predicate);
  }

  const candidates = (pool || [])
    .filter((player) => player && player.id != null)
    .filter((player) => !lockedIds.has(player.id))
    .filter(predicate);

  const canAddSameMax = (candidate) => {
    for (const entry of sameState) {
      const value = candidate?.[entry.attr];
      if (value == null) return false;
      const currentCount = entry.counts.get(value) || 0;
      if (currentCount >= entry.max) return false;
    }
    return true;
  };

  const canAddPredicateCaps = (candidate) => {
    for (const cap of capState) {
      if (cap.count >= cap.max && cap.predicate(candidate)) return false;
    }
    return true;
  };

  const canAddCandidate = (candidate) => {
    let penalty = 0;
    for (const entry of uniqueState) {
      const value = candidate?.[entry.attr];
      if (value == null) return { ok: false, penalty };
      if (entry.values.has(value)) continue;
      if (entry.values.size >= entry.max) return { ok: false, penalty };
      penalty += 1;
    }
    if (!canAddSameMax(candidate)) return { ok: false, penalty };
    if (!canAddPredicateCaps(candidate)) return { ok: false, penalty };
    return { ok: true, penalty };
  };

  const getPreferenceScore = (candidate) => {
    let score = 0;
    for (const entry of preferencePredicates) {
      if (entry.predicate(candidate)) {
        score += Math.max(1, toNumber(entry.weight) ?? 1);
      }
    }
    return score;
  };

  while (needed > 0) {
    if (remainingCapacity != null && squad.length >= squadSizeCap) break;
    let best = null;
    for (const candidate of candidates) {
      if (!candidate || candidate.id == null) continue;
      if (lockedIds.has(candidate.id)) continue;
      const check = canAddCandidate(candidate);
      if (!check.ok) continue;
      const preferenceScore = getPreferenceScore(candidate);
      const seedBiasScore = getSeedPoolBiasScore(candidate, options?.seed);
      const distance = useRatingHint
        ? Math.abs((toNumber(candidate?.rating) ?? 0) - ratingHintPivot)
        : null;
      if (
        !best ||
        check.penalty < best.penalty ||
        (check.penalty === best.penalty &&
          preferenceScore > best.preferenceScore) ||
        (check.penalty === best.penalty &&
          preferenceScore === best.preferenceScore &&
          seedBiasScore < best.seedBiasScore) ||
        (check.penalty === best.penalty &&
          preferenceScore === best.preferenceScore &&
          seedBiasScore === best.seedBiasScore &&
          (useRatingHint
            ? distance < best.distance ||
              (distance === best.distance &&
                candidate.rating < best.player.rating)
            : candidate.rating < best.player.rating))
      ) {
        best = {
          player: candidate,
          penalty: check.penalty,
          preferenceScore,
          seedBiasScore,
          distance: distance ?? 0,
        };
      }
    }
    if (!best) break;
    const picked = best.player;
    squad.push(picked);
    lockedIds.add(picked.id);
    for (const entry of uniqueState) {
      const value = picked?.[entry.attr];
      if (value == null) continue;
      entry.values.add(value);
    }
    for (const entry of sameState) {
      const value = picked?.[entry.attr];
      if (value == null) continue;
      entry.counts.set(value, (entry.counts.get(value) || 0) + 1);
    }
    for (const cap of capState) {
      if (cap.predicate(picked)) cap.count += 1;
    }
    needed -= 1;
  }

  if (needed > 0 && options?.relaxUniqueOnFail !== false) {
    const fallback = (pool || [])
      .filter((player) => player && player.id != null)
      .filter((player) => !lockedIds.has(player.id))
      .filter(predicate)
      .sort((a, b) => {
        const preferenceDiff = getPreferenceScore(b) - getPreferenceScore(a);
        if (preferenceDiff !== 0) return preferenceDiff;
        const seedBiasDiff =
          getSeedPoolBiasScore(a, options?.seed) -
          getSeedPoolBiasScore(b, options?.seed);
        if (seedBiasDiff !== 0) return seedBiasDiff;
        if (useRatingHint) {
          const aDistance = Math.abs((toNumber(a?.rating) ?? 0) - ratingHintPivot);
          const bDistance = Math.abs((toNumber(b?.rating) ?? 0) - ratingHintPivot);
          if (aDistance !== bDistance) return aDistance - bDistance;
        }
        return a.rating - b.rating;
      });
    for (const candidate of fallback) {
      if (remainingCapacity != null && squad.length >= squadSizeCap) break;
      if (needed <= 0) break;
      if (!candidate || candidate.id == null) continue;
      if (lockedIds.has(candidate.id)) continue;
      if (!canAddSameMax(candidate)) continue;
      if (!canAddPredicateCaps(candidate)) continue;
      squad.push(candidate);
      lockedIds.add(candidate.id);
      for (const entry of sameState) {
        const value = candidate?.[entry.attr];
        if (value == null) continue;
        entry.counts.set(value, (entry.counts.get(value) || 0) + 1);
      }
      for (const cap of capState) {
        if (cap.predicate(candidate)) cap.count += 1;
      }
      needed -= 1;
    }
  }

  return needed <= 0;
};

const rebuildLockedIdsFromSquad = (squad, lockedIds) => {
  if (!(lockedIds instanceof Set)) return new Set();
  lockedIds.clear();
  for (const player of Array.isArray(squad) ? squad : []) {
    const id = player?.id ?? null;
    if (id == null) continue;
    lockedIds.add(id);
  }
  return lockedIds;
};

const applyMinMaxFilters = (pool, rules) => {
  let min = null;
  let max = null;
  for (const rule of rules) {
    if (rule.type === "player_min_ovr") {
      const value = toNumber(rule.values[0]);
      if (value != null) min = min == null ? value : Math.max(min, value);
    }
    if (rule.type === "player_max_ovr") {
      const value = toNumber(rule.values[0]);
      if (value != null) max = max == null ? value : Math.min(max, value);
    }
  }
  let filtered = pool.slice();
  if (min != null) filtered = filtered.filter((player) => player.rating >= min);
  if (max != null) filtered = filtered.filter((player) => player.rating <= max);
  return { filtered, min, max };
};

const prefersNonSpecial = (player) =>
  !player?.isSpecial && !player?.isEvolution;

const preferNonSpecialPlayers = (pool, squad, squadSize, lockedIds) => {
  const preferred = (pool || [])
    .filter((player) => !lockedIds.has(player.id))
    .filter(prefersNonSpecial)
    .sort((a, b) => a.rating - b.rating);
  if (preferred.length >= squadSize - squad.length) {
    return { pool: preferred, applied: true };
  }
  return { pool, applied: false };
};

const fillSquad = (squad, pool, squadSize, lockedIds, options = {}) => {
  const target = toNumber(squadSize) ?? 0;
  if (target <= 0) return [];
  const working = Array.isArray(squad) ? squad.slice() : [];
  if (working.length >= target) return working.slice(0, target);

  const ratingHintPivot = toNumber(options?.ratingHint?.pivot);
  const useRatingHint =
    ratingHintPivot != null && Number.isFinite(ratingHintPivot);

  const uniqueMaxByAttr = options?.uniqueMaxByAttr;
  const sameMaxByAttr = options?.sameMaxByAttr;
  const predicateCaps = Array.isArray(options?.predicateCaps)
    ? options.predicateCaps
    : [];
  const uniqueEntries =
    uniqueMaxByAttr instanceof Map
      ? Array.from(uniqueMaxByAttr.entries())
      : uniqueMaxByAttr && typeof uniqueMaxByAttr === "object"
        ? Object.entries(uniqueMaxByAttr)
        : [];
  const uniqueState = uniqueEntries
    .map(([attr, max]) => ({ attr, max: toNumber(max), values: new Set() }))
    .filter((entry) => entry.attr && entry.max != null && entry.max > 0);
  for (const entry of uniqueState) {
    for (const player of working) {
      const value = player?.[entry.attr];
      if (value == null) continue;
      entry.values.add(value);
    }
  }

  const sameEntries =
    sameMaxByAttr instanceof Map
      ? Array.from(sameMaxByAttr.entries())
      : sameMaxByAttr && typeof sameMaxByAttr === "object"
        ? Object.entries(sameMaxByAttr)
        : [];
  const sameState = sameEntries
    .map(([attr, max]) => ({ attr, max: toNumber(max), counts: new Map() }))
    .filter((entry) => entry.attr && entry.max != null && entry.max > 0);
  for (const entry of sameState) {
    for (const player of working) {
      const value = player?.[entry.attr];
      if (value == null) continue;
      entry.counts.set(value, (entry.counts.get(value) || 0) + 1);
    }
  }

  const capState = predicateCaps
    .map((cap) => {
      const max = toNumber(cap?.max ?? cap?.required);
      const pred = cap?.predicate;
      if (max == null || max < 0) return null;
      if (typeof pred !== "function") return null;
      return { max, predicate: pred, count: 0 };
    })
    .filter(Boolean);
  for (const cap of capState) {
    cap.count = countMatching(working, cap.predicate);
  }

  const canAddSameMax = (candidate) => {
    for (const entry of sameState) {
      const value = candidate?.[entry.attr];
      if (value == null) return false;
      const currentCount = entry.counts.get(value) || 0;
      if (currentCount >= entry.max) return false;
    }
    return true;
  };

  const canAddPredicateCaps = (candidate) => {
    for (const cap of capState) {
      if (cap.count >= cap.max && cap.predicate(candidate)) return false;
    }
    return true;
  };

  const canAddCandidate = (candidate) => {
    let penalty = 0;
    for (const entry of uniqueState) {
      const value = candidate?.[entry.attr];
      if (value == null) return { ok: false, penalty };
      if (entry.values.has(value)) continue;
      if (entry.values.size >= entry.max) return { ok: false, penalty };
      penalty += 1;
    }
    if (!canAddSameMax(candidate)) return { ok: false, penalty };
    if (!canAddPredicateCaps(candidate)) return { ok: false, penalty };
    return { ok: true, penalty };
  };

  while (working.length < target) {
    let best = null;
    for (const candidate of pool || []) {
      if (!candidate || candidate.id == null) continue;
      if (lockedIds.has(candidate.id)) continue;
      const check = canAddCandidate(candidate);
      if (!check.ok) continue;
      const distance = useRatingHint
        ? Math.abs((toNumber(candidate?.rating) ?? 0) - ratingHintPivot)
        : null;
      if (
        !best ||
        check.penalty < best.penalty ||
        (check.penalty === best.penalty &&
          (useRatingHint
            ? distance < best.distance ||
              (distance === best.distance &&
                candidate.rating < best.player.rating)
            : candidate.rating < best.player.rating))
      ) {
        best = {
          player: candidate,
          penalty: check.penalty,
          distance: distance ?? 0,
        };
      }
    }
    if (!best) break;
    const picked = best.player;
    working.push(picked);
    lockedIds.add(picked.id);
    for (const entry of uniqueState) {
      const value = picked?.[entry.attr];
      if (value == null) continue;
      entry.values.add(value);
    }
    for (const entry of sameState) {
      const value = picked?.[entry.attr];
      if (value == null) continue;
      entry.counts.set(value, (entry.counts.get(value) || 0) + 1);
    }
    for (const cap of capState) {
      if (cap.predicate(picked)) cap.count += 1;
    }
  }

  if (working.length < target && options?.relaxUniqueOnFail !== false) {
    const remaining = (pool || [])
      .filter((player) => player && player.id != null)
      .filter((player) => !lockedIds.has(player.id))
      .slice()
      .sort((a, b) => a.rating - b.rating);
    for (const player of remaining) {
      if (working.length >= target) break;
      if (!player || player.id == null) continue;
      if (lockedIds.has(player.id)) continue;
      if (!canAddSameMax(player)) continue;
      if (!canAddPredicateCaps(player)) continue;
      working.push(player);
      lockedIds.add(player.id);
      for (const entry of sameState) {
        const value = player?.[entry.attr];
        if (value == null) continue;
        entry.counts.set(value, (entry.counts.get(value) || 0) + 1);
      }
      for (const cap of capState) {
        if (cap.predicate(player)) cap.count += 1;
      }
    }
  }

  return working.slice(0, target);
};

const improveRating = (squad, pool, target, lockedIds) => {
  if (target == null) return false;
  let rating = getSquadRating(squad);
  if (rating >= target) return true;
  const candidates = pool
    .filter((player) => !squad.some((member) => member.id === player.id))
    .sort((a, b) => b.rating - a.rating);
  for (const candidate of candidates) {
    const out = pickLowestRated(squad, lockedIds);
    if (!out || candidate.rating <= out.rating) continue;
    replacePlayer(squad, out, candidate);
    rating = getSquadRating(squad);
    if (rating >= target) return true;
  }
  return rating >= target;
};

const getSquadRoundedAdjustedAverage = (players) =>
  roundTo(getSquadAdjustedAverage(players), ROUND_DECIMALS);

const getAdjustedAverageThresholdForRating = (targetRating) => {
  const target = toNumber(targetRating);
  if (target == null) return null;
  // computeSquadRating bumps base+1 when decimal >= ROUND_THRESHOLD (e.g. 0.96 => rating 85 at 84.96).
  return target - (1 - ROUND_THRESHOLD);
};

const getRatingImproveMetrics = (
  squad,
  targetRating,
  pivot,
  requiredInforms,
) => {
  const roundedAdjustedAverage = getSquadRoundedAdjustedAverage(squad);
  const threshold = getAdjustedAverageThresholdForRating(targetRating) ?? 0;
  const shortfall = Math.max(0, threshold - roundedAdjustedAverage);
  return {
    shortfall,
    roundedAdjustedAverage,
    threshold,
    preservation: getSquadPreservationMetrics(
      squad,
      targetRating,
      pivot,
      requiredInforms,
    ),
  };
};

const isRatingImproveMetricsBetter = (candidate, current, options = {}) => {
  if (!candidate || !current) return false;
  const preferLowerExcessInforms = options?.preferLowerExcessInforms !== false;
  if (candidate.shortfall !== current.shortfall)
    return candidate.shortfall < current.shortfall;
  const c = candidate.preservation;
  const k = current.preservation;
  if (preferLowerExcessInforms && c.excessInforms !== k.excessInforms)
    return c.excessInforms < k.excessInforms;
  if (c.excessSpecials !== k.excessSpecials)
    return c.excessSpecials < k.excessSpecials;
  if (c.highScore !== k.highScore) return c.highScore < k.highScore;
  if (c.highCount !== k.highCount) return c.highCount < k.highCount;
  if (c.maxRating !== k.maxRating) return c.maxRating < k.maxRating;
  if (c.sumRating !== k.sumRating) return c.sumRating < k.sumRating;
  return false;
};

const isSquadValidIgnoringTeamRating = (rules, squad, squadSize) => {
  for (const rule of rules || []) {
    if (!rule) continue;
    if (rule.type === "team_rating") continue;
    const failing = evaluateRule(rule, squad, squadSize);
    if (failing) return false;
  }
  return true;
};

const improveRatingSmart = (
  squad,
  pool,
  rules,
  squadSize,
  targetRating,
  lockedIds,
  debugPush,
  options = {},
) => {
  const target = toNumber(targetRating);
  if (target == null) return false;
  if (!Array.isArray(squad) || squad.length < 1) return false;
  if (!Array.isArray(pool) || pool.length < 1) return false;

  const requiredInforms = Math.max(0, toNumber(options?.requiredInforms) ?? 0);
  const avoidInforms = options?.avoidInforms !== false;
  const preferLowerExcessInforms = options?.preferLowerExcessInforms !== false;

  const pivot =
    toNumber(options?.pivot) ??
    // Default: penalize ratings above the minimum needed to hit the squad rating.
    Math.max(80, Math.floor(target) - 1);
  const capOffset = toNumber(options?.capOffset) ?? 2;
  const pairShortfallThreshold = Math.max(
    0,
    toNumber(options?.pairShortfallThreshold) ?? 0.8,
  );
  const maxIterations = Math.max(10, toNumber(options?.maxIterations) ?? 80);

  const working = squad.slice(0, squadSize);
  const usedIds = new Set(
    working.map((player) => player?.id).filter((id) => id != null),
  );
  const availableAll = (pool || [])
    .filter((player) => player && player.id != null)
    .filter((player) => !usedIds.has(player.id));
  const maxPoolRatingAll =
    availableAll.reduce(
      (max, player) => Math.max(max, toNumber(player?.rating) ?? 0),
      0,
    ) || 0;

  let includeInformCandidates = true;
  if (avoidInforms) {
    const currentInformCount = working.reduce(
      (count, player) => (isInformPlayer(player) ? count + 1 : count),
      0,
    );
    if (currentInformCount >= requiredInforms) includeInformCandidates = false;
  }

  let available = includeInformCandidates
    ? availableAll
    : availableAll.filter((player) => !isInformPlayer(player));
  let maxPoolRating =
    available.reduce(
      (max, player) => Math.max(max, toNumber(player?.rating) ?? 0),
      0,
    ) || 0;

  let cap = Math.min(maxPoolRating, Math.max(0, pivot + capOffset));
  let bestMetrics = getRatingImproveMetrics(
    working,
    target,
    pivot,
    requiredInforms,
  );

  const buildCandidatesForCap = (capRating) => {
    const capNum = toNumber(capRating) ?? 0;
    const window = Math.max(2, toNumber(options?.window) ?? 8);
    const maxCandidates = Math.max(60, toNumber(options?.maxCandidates) ?? 240);

    const capLimited = available
      .filter((player) => (toNumber(player?.rating) ?? 0) <= capNum)
      .slice()
      .sort((a, b) => a.rating - b.rating);

    const near = capLimited
      .filter((player) => {
        const rating = toNumber(player?.rating);
        if (rating == null) return false;
        return Math.abs(rating - pivot) <= window;
      })
      .sort((a, b) => a.rating - b.rating);

    const high = capLimited
      .slice()
      .sort((a, b) => b.rating - a.rating)
      .slice(0, 60);

    const combined = [];
    const seen = new Set();
    for (const list of [high, near, capLimited]) {
      for (const player of list) {
        if (!player || player.id == null) continue;
        if (seen.has(player.id)) continue;
        seen.add(player.id);
        combined.push(player);
        if (combined.length >= maxCandidates) break;
      }
      if (combined.length >= maxCandidates) break;
    }
    return combined;
  };

  let iterations = 0;
  while (iterations < maxIterations) {
    iterations += 1;

    const currentRating = getSquadRating(working);
    if (currentRating >= target) break;

    const currentMetrics = getRatingImproveMetrics(
      working,
      target,
      pivot,
      requiredInforms,
    );

    let bestMove = null;
    let bestMoveKind = null;

    const candidates = buildCandidatesForCap(cap);

    // Single swaps first.
    for (let index = 0; index < working.length; index += 1) {
      const outPlayer = working[index];
      const outId = outPlayer?.id ?? null;
      if (outId != null && lockedIds?.has(outId)) continue;

      const seenDefs = new Set();
      for (let j = 0; j < working.length; j += 1) {
        if (j === index) continue;
        const defKey = getDefinitionKey(working[j]);
        if (defKey == null) continue;
        seenDefs.add(String(defKey));
      }

      for (const candidate of candidates) {
        if (!candidate || candidate.id == null) continue;
        if (usedIds.has(candidate.id)) continue;
        if (candidate.rating <= (toNumber(outPlayer?.rating) ?? 0)) continue;

        const candidateDef = getDefinitionKey(candidate);
        if (candidateDef != null && seenDefs.has(String(candidateDef)))
          continue;

        const previous = working[index];
        working[index] = candidate;

        const valid = isSquadValidIgnoringTeamRating(rules, working, squadSize);
        if (!valid) {
          working[index] = previous;
          continue;
        }

        const candidateMetrics = getRatingImproveMetrics(
          working,
          target,
          pivot,
          requiredInforms,
        );
        const improves = candidateMetrics.shortfall < currentMetrics.shortfall;
        if (
          improves &&
          isRatingImproveMetricsBetter(candidateMetrics, bestMetrics, {
            preferLowerExcessInforms,
          })
        ) {
          bestMetrics = candidateMetrics;
          bestMove = { index, outPlayer: previous, inPlayer: candidate };
          bestMoveKind = "single";
        }

        working[index] = previous;
      }
    }

    // If no single swap improves, attempt pair swaps within this cap.
    // Pair search is expensive; only try it when we're already close to the target.
    const shouldTryPairs =
      currentMetrics.shortfall <= pairShortfallThreshold ||
      currentRating >= target - 1;
    if (!bestMove && shouldTryPairs) {
      const pairCandidates = candidates
        .slice()
        .sort((a, b) => b.rating - a.rating)
        .slice(0, Math.max(40, toNumber(options?.pairCandidates) ?? 70));

      for (let i = 0; i < working.length; i += 1) {
        const outA = working[i];
        const outAId = outA?.id ?? null;
        if (outAId != null && lockedIds?.has(outAId)) continue;

        for (let j = i + 1; j < working.length; j += 1) {
          const outB = working[j];
          const outBId = outB?.id ?? null;
          if (outBId != null && lockedIds?.has(outBId)) continue;

          const seenDefs = new Set();
          for (let k = 0; k < working.length; k += 1) {
            if (k === i || k === j) continue;
            const defKey = getDefinitionKey(working[k]);
            if (defKey == null) continue;
            seenDefs.add(String(defKey));
          }

          for (let a = 0; a < pairCandidates.length; a += 1) {
            const inA = pairCandidates[a];
            if (!inA || inA.id == null) continue;
            if (usedIds.has(inA.id)) continue;
            if (
              inA.rating <= (toNumber(outA?.rating) ?? 0) &&
              inA.rating <= (toNumber(outB?.rating) ?? 0)
            ) {
              continue;
            }
            const inADef = getDefinitionKey(inA);
            if (inADef != null && seenDefs.has(String(inADef))) continue;

            for (let b = a + 1; b < pairCandidates.length; b += 1) {
              const inB = pairCandidates[b];
              if (!inB || inB.id == null) continue;
              if (usedIds.has(inB.id)) continue;
              if (inB.id === inA.id) continue;
              if (
                inB.rating <= (toNumber(outA?.rating) ?? 0) &&
                inB.rating <= (toNumber(outB?.rating) ?? 0)
              ) {
                continue;
              }

              const inBDef = getDefinitionKey(inB);
              if (inBDef != null && seenDefs.has(String(inBDef))) continue;
              if (
                inADef != null &&
                inBDef != null &&
                String(inADef) === String(inBDef)
              )
                continue;

              const prevA = working[i];
              const prevB = working[j];
              working[i] = inA;
              working[j] = inB;

              const valid = isSquadValidIgnoringTeamRating(
                rules,
                working,
                squadSize,
              );
              if (!valid) {
                working[i] = prevA;
                working[j] = prevB;
                continue;
              }

              const candidateMetrics = getRatingImproveMetrics(
                working,
                target,
                pivot,
                requiredInforms,
              );
              const improves =
                candidateMetrics.shortfall < currentMetrics.shortfall;
              if (
                improves &&
                isRatingImproveMetricsBetter(candidateMetrics, bestMetrics, {
                  preferLowerExcessInforms,
                })
              ) {
                bestMetrics = candidateMetrics;
                bestMove = { i, j, outA: prevA, outB: prevB, inA, inB };
                bestMoveKind = "pair";
              }

              working[i] = prevA;
              working[j] = prevB;
            }
          }
        }
      }
    }

    if (!bestMove) {
      if (!includeInformCandidates && availableAll.length > available.length) {
        includeInformCandidates = true;
        available = availableAll;
        maxPoolRating = Math.max(maxPoolRating, maxPoolRatingAll);
        cap = Math.min(maxPoolRating, Math.max(cap, pivot + capOffset));
        debugPush?.({
          stage: "rating",
          action: "allow_informs",
          cap,
          pivot,
          requiredInforms,
          currentRating: getSquadRating(working),
          metrics: currentMetrics,
        });
        continue;
      }
      if (cap >= maxPoolRating) break;
      cap = Math.min(maxPoolRating, cap + 1);
      debugPush?.({
        stage: "rating",
        action: "increase_cap",
        cap,
        pivot,
        currentRating: getSquadRating(working),
        metrics: currentMetrics,
      });
      continue;
    }

    if (bestMoveKind === "pair") {
      working[bestMove.i] = bestMove.inA;
      working[bestMove.j] = bestMove.inB;
      if (bestMove.outA?.id != null) usedIds.delete(bestMove.outA.id);
      if (bestMove.outB?.id != null) usedIds.delete(bestMove.outB.id);
      if (bestMove.inA?.id != null) usedIds.add(bestMove.inA.id);
      if (bestMove.inB?.id != null) usedIds.add(bestMove.inB.id);
      debugPush?.({
        stage: "rating",
        action: "swap_pair",
        cap,
        pivot,
        outAId: bestMove.outA?.id ?? null,
        outARating: bestMove.outA?.rating ?? null,
        outBId: bestMove.outB?.id ?? null,
        outBRating: bestMove.outB?.rating ?? null,
        inAId: bestMove.inA?.id ?? null,
        inARating: bestMove.inA?.rating ?? null,
        inBId: bestMove.inB?.id ?? null,
        inBRating: bestMove.inB?.rating ?? null,
        metrics: bestMetrics,
      });
    } else {
      const outId = bestMove.outPlayer?.id ?? null;
      const inId = bestMove.inPlayer?.id ?? null;
      working[bestMove.index] = bestMove.inPlayer;
      if (outId != null) usedIds.delete(outId);
      if (inId != null) usedIds.add(inId);
      debugPush?.({
        stage: "rating",
        action: "swap",
        cap,
        pivot,
        outId,
        outRating: bestMove.outPlayer?.rating ?? null,
        inId,
        inRating: bestMove.inPlayer?.rating ?? null,
        metrics: bestMetrics,
      });
    }
  }

  debugPush?.({
    stage: "rating",
    action: "summary",
    target,
    pivot,
    cap,
    iterations,
    requiredInforms,
    squadRating: getSquadRating(working),
    metrics: bestMetrics,
  });

  // Mutate the input squad to match previous improveRating behavior.
  squad.length = 0;
  squad.push(...working);
  return getSquadRating(squad) >= target;
};

const getSquadPreservationMetrics = (
  squad,
  ratingTarget,
  pivot,
  requiredInforms = 0,
  requiredSpecials = 0,
) => {
  const pivotNumber = toNumber(pivot) ?? 84;
  const requiredInformsNumber = Math.max(0, toNumber(requiredInforms) ?? 0);
  const requiredSpecialsNumber = Math.max(0, toNumber(requiredSpecials) ?? 0);
  const ratings = (squad || []).map((player) => toNumber(player?.rating) ?? 0);
  const maxRating = ratings.reduce((max, rating) => Math.max(max, rating), 0);
  const sumRating = ratings.reduce((sum, rating) => sum + rating, 0);
  const informCount = (squad || []).reduce(
    (count, player) => (isInformPlayer(player) ? count + 1 : count),
    0,
  );
  const specialCount = (squad || []).reduce(
    (count, player) => (player?.isSpecial ? count + 1 : count),
    0,
  );
  const excessInforms = Math.max(0, informCount - requiredInformsNumber);
  const excessSpecials = Math.max(0, specialCount - requiredSpecialsNumber);
  const highCount = ratings.reduce(
    (count, rating) => (rating > pivotNumber ? count + 1 : count),
    0,
  );
  const highScore = ratings.reduce((score, rating) => {
    const diff = rating - pivotNumber;
    if (diff <= 0) return score;
    // Cubic penalty biases heavily against "one very high card" anchors.
    return score + diff * diff * diff;
  }, 0);

  const slack =
    ratingTarget != null
      ? getSquadRating(squad) - (toNumber(ratingTarget) ?? 0)
      : 0;

  return {
    pivot: pivotNumber,
    requiredInforms: requiredInformsNumber,
    requiredSpecials: requiredSpecialsNumber,
    informCount,
    specialCount,
    excessInforms,
    excessSpecials,
    highScore,
    highCount,
    maxRating,
    sumRating,
    slack,
  };
};

const isPreservationMetricsBetter = (candidate, current, options = {}) => {
  if (!candidate || !current) return false;
  const preferLowerExcessInforms = options?.preferLowerExcessInforms !== false;
  if (
    preferLowerExcessInforms &&
    candidate.excessInforms !== current.excessInforms
  ) {
    return candidate.excessInforms < current.excessInforms;
  }
  if (candidate.excessSpecials !== current.excessSpecials)
    return candidate.excessSpecials < current.excessSpecials;
  if (candidate.highScore !== current.highScore)
    return candidate.highScore < current.highScore;
  if (candidate.highCount !== current.highCount)
    return candidate.highCount < current.highCount;
  if (candidate.maxRating !== current.maxRating)
    return candidate.maxRating < current.maxRating;
  if (candidate.slack !== current.slack) return candidate.slack > current.slack;
  if (candidate.sumRating !== current.sumRating)
    return candidate.sumRating < current.sumRating;
  return false;
};

const buildRemainingSupplyPenalty = (remaining, emptyWeight, scaleWeight) => {
  const count = Math.max(0, toNumber(remaining) ?? 0);
  if (count <= 0) return emptyWeight;
  return Math.round((scaleWeight * 100) / (count + 1));
};

const buildSupplyMaps = (pool) => ({
  club: countByAttr(pool, "teamId"),
  league: countByAttr(pool, "leagueId"),
  nation: countByAttr(pool, "nationId"),
});

const getSolvedSquadValueMetrics = (
  squad,
  pool,
  ratingTarget,
  options = {},
) => {
  const list = Array.isArray(squad) ? squad : [];
  const target = toNumber(ratingTarget);
  const pivot =
    toNumber(options?.pivot) ??
    (target != null ? Math.max(80, Math.floor(target) - 1) : 84);
  const requiredInforms = Math.max(0, toNumber(options?.requiredInforms) ?? 0);
  const requiredSpecials = Math.max(0, toNumber(options?.requiredSpecials) ?? 0);
  const preservation = getSquadPreservationMetrics(
    list,
    target,
    pivot,
    requiredInforms,
    requiredSpecials,
  );
  const squadRating = getSquadRating(list);
  const ratingExcess =
    target != null ? Math.max(0, squadRating - target) : 0;
  const tradableCount = list.reduce(
    (count, player) => (!player?.isUntradeable ? count + 1 : count),
    0,
  );
  const signature = options?.signature ?? null;
  const composition = buildCompositionSnapshot(list, list.length);

  const supplyMaps = options?.supplyMaps || buildSupplyMaps(pool || []);
  const squadClubCounts = countByAttr(list, "teamId");
  const squadLeagueCounts = countByAttr(list, "leagueId");
  const squadNationCounts = countByAttr(list, "nationId");

  const scarcityPenalty = list.reduce((sum, player) => {
    if (!player) return sum;
    const teamId = player?.teamId ?? null;
    const leagueId = player?.leagueId ?? null;
    const nationId = player?.nationId ?? null;
    const remainingClub =
      teamId == null
        ? 0
        : (supplyMaps.club.get(teamId) || 0) - (squadClubCounts.get(teamId) || 0);
    const remainingLeague =
      leagueId == null
        ? 0
        : (supplyMaps.league.get(leagueId) || 0) -
          (squadLeagueCounts.get(leagueId) || 0);
    const remainingNation =
      nationId == null
        ? 0
        : (supplyMaps.nation.get(nationId) || 0) -
          (squadNationCounts.get(nationId) || 0);
    return (
      sum +
      buildRemainingSupplyPenalty(remainingClub, 500, 6) +
      buildRemainingSupplyPenalty(remainingLeague, 300, 4) +
      buildRemainingSupplyPenalty(remainingNation, 200, 3)
    );
  }, 0);
  const requiredLeagueIds = new Set(
    (signature?.requiredLeagueIds || [])
      .map((value) => toNumber(value))
      .filter((value) => value != null),
  );
  const requiredNationIds = new Set(
    (signature?.requiredNationIds || [])
      .map((value) => toNumber(value))
      .filter((value) => value != null),
  );
  const requiredClubIds = new Set(
    (signature?.requiredClubIds || [])
      .map((value) => toNumber(value))
      .filter((value) => value != null),
  );
  const identityBalancePenalty = (() => {
    if (!signature?.isCompositionPuzzle) return 0;
    let penalty = 0;
    if (requiredLeagueIds.size) {
      const count = list.reduce(
        (sum, player) => (requiredLeagueIds.has(player?.leagueId) ? sum + 1 : sum),
        0,
      );
      penalty += Math.max(0, list.length - count) * 45;
    }
    if (requiredNationIds.size) {
      const count = list.reduce(
        (sum, player) => (requiredNationIds.has(player?.nationId) ? sum + 1 : sum),
        0,
      );
      penalty += Math.max(0, list.length - count) * 36;
    }
    if (requiredClubIds.size) {
      const count = list.reduce(
        (sum, player) => (requiredClubIds.has(player?.teamId) ? sum + 1 : sum),
        0,
      );
      penalty += Math.max(0, list.length - count) * 32;
    }
    const dominantAxes = Array.isArray(signature?.dominantAxes)
      ? signature.dominantAxes
      : [];
    if (dominantAxes.includes("league")) {
      penalty += Math.max(0, (composition?.uniqueLeagues ?? 0) - 1) * 18;
      penalty += Math.max(
        0,
        list.length - (composition?.dominantLeagueCount ?? 0),
      ) * 8;
    }
    if (dominantAxes.includes("nation")) {
      penalty += Math.max(0, (composition?.uniqueNations ?? 0) - 1) * 12;
      penalty += Math.max(
        0,
        list.length - (composition?.dominantNationCount ?? 0),
      ) * 6;
    }
    if (dominantAxes.includes("club")) {
      penalty += Math.max(0, (composition?.uniqueClubs ?? 0) - 1) * 4;
      penalty += Math.max(
        0,
        list.length - (composition?.dominantClubCount ?? 0),
      ) * 2;
    }
    return penalty;
  })();

  return {
    ratingExcess,
    maxRating: preservation.maxRating,
    highRatingScore: preservation.highScore,
    highRatingCount: preservation.highCount,
    identityBalancePenalty,
    specialCount: preservation.specialCount,
    tradableCount,
    scarcityPenalty,
    sumRating: preservation.sumRating,
    squadRating,
    preservation,
  };
};

const isSolvedSquadValueBetter = (candidate, current) => {
  if (!candidate || !current) return false;
  if (candidate.ratingExcess !== current.ratingExcess)
    return candidate.ratingExcess < current.ratingExcess;
  if (candidate.maxRating !== current.maxRating)
    return candidate.maxRating < current.maxRating;
  if (candidate.highRatingScore !== current.highRatingScore)
    return candidate.highRatingScore < current.highRatingScore;
  if (candidate.highRatingCount !== current.highRatingCount)
    return candidate.highRatingCount < current.highRatingCount;
  if (candidate.identityBalancePenalty !== current.identityBalancePenalty)
    return candidate.identityBalancePenalty < current.identityBalancePenalty;
  if (candidate.sumRating !== current.sumRating)
    return candidate.sumRating < current.sumRating;
  if (candidate.specialCount !== current.specialCount)
    return candidate.specialCount < current.specialCount;
  if (candidate.tradableCount !== current.tradableCount)
    return candidate.tradableCount < current.tradableCount;
  if (candidate.scarcityPenalty !== current.scarcityPenalty)
    return candidate.scarcityPenalty < current.scarcityPenalty;
  return false;
};

const getBalancedRefineBand = (ratingTarget, pivot) => {
  const target = toNumber(ratingTarget);
  const pivotNumber =
    toNumber(pivot) ??
    (target != null ? Math.max(80, Math.floor(target) - 1) : 84);
  if (target == null) {
    return {
      minRating: Math.max(0, pivotNumber - 6),
      maxRating: pivotNumber + 1,
    };
  }
  return {
    minRating: Math.max(0, target - 8),
    maxRating: target + 1,
  };
};

const buildRefinementCandidatePool = (
  squad,
  pool,
  ratingTarget,
  options = {},
) => {
  const working = Array.isArray(squad) ? squad : [];
  const availablePool = Array.isArray(pool) ? pool : [];
  const target = toNumber(ratingTarget);
  const pivot =
    toNumber(options?.pivot) ??
    (target != null ? Math.max(80, Math.floor(target) - 1) : 84);
  const window = Math.max(1, toNumber(options?.window) ?? 6);
  const maxCandidates = Math.max(30, toNumber(options?.maxCandidates) ?? 140);
  const usedIds = new Set(
    working.map((player) => player?.id).filter((id) => id != null),
  );
  const supplyMaps = options?.supplyMaps || buildSupplyMaps(availablePool);
  const clubCounts = countByAttr(working, "teamId");
  const leagueCounts = countByAttr(working, "leagueId");
  const nationCounts = countByAttr(working, "nationId");

  const scoreScarcity = (player) => {
    if (!player) return 0;
    const teamId = player?.teamId ?? null;
    const leagueId = player?.leagueId ?? null;
    const nationId = player?.nationId ?? null;
    const clubRemaining =
      teamId == null ? 0 : (supplyMaps.club.get(teamId) || 0) - (clubCounts.get(teamId) || 0);
    const leagueRemaining =
      leagueId == null
        ? 0
        : (supplyMaps.league.get(leagueId) || 0) - (leagueCounts.get(leagueId) || 0);
    const nationRemaining =
      nationId == null
        ? 0
        : (supplyMaps.nation.get(nationId) || 0) - (nationCounts.get(nationId) || 0);
    return (
      buildRemainingSupplyPenalty(clubRemaining, 500, 6) +
      buildRemainingSupplyPenalty(leagueRemaining, 300, 4) +
      buildRemainingSupplyPenalty(nationRemaining, 200, 3)
    );
  };

  const scored = availablePool
    .filter((player) => player && player.id != null)
    .filter((player) => !usedIds.has(player.id))
    .map((player) => {
      const rating = toNumber(player?.rating) ?? 0;
      return {
        player,
        rating,
        withinWindow: Math.abs(rating - pivot) <= window,
        distance: Math.abs(rating - pivot),
        scarcityPenalty: scoreScarcity(player),
      };
    });

  const desirabilitySort = (a, b) => {
    if (a.withinWindow !== b.withinWindow) return a.withinWindow ? -1 : 1;
    if (a.rating !== b.rating) return a.rating - b.rating;
    if (Boolean(a.player?.isSpecial) !== Boolean(b.player?.isSpecial))
      return Boolean(a.player?.isSpecial) ? 1 : -1;
    if (Boolean(a.player?.isUntradeable) !== Boolean(b.player?.isUntradeable))
      return Boolean(a.player?.isUntradeable) ? -1 : 1;
    if (a.scarcityPenalty !== b.scarcityPenalty)
      return a.scarcityPenalty - b.scarcityPenalty;
    return 0;
  };

  const nearPivot = scored.slice().sort(desirabilitySort).slice(0, maxCandidates);
  const lowRated = scored
    .slice()
    .sort((a, b) => {
      if (a.rating !== b.rating) return a.rating - b.rating;
      return desirabilitySort(a, b);
    })
    .slice(0, Math.min(40, maxCandidates));
  const combined = [];
  const seen = new Set();
  for (const list of [nearPivot, lowRated]) {
    for (const entry of list) {
      const id = entry?.player?.id ?? null;
      if (id == null || seen.has(id)) continue;
      seen.add(id);
      combined.push(entry.player);
      if (combined.length >= maxCandidates) break;
    }
    if (combined.length >= maxCandidates) break;
  }
  return combined;
};

const shouldRunBalancedReshape = (metrics, ratingTarget, signature) => {
  if (!metrics) return false;
  const target = toNumber(ratingTarget) ?? 0;
  const compositionPuzzle = Boolean(signature?.isCompositionPuzzle);
  const maxRatingGap = Math.max(0, (metrics.maxRating ?? 0) - target);
  const highScore = metrics.highRatingScore ?? 0;
  const highCount = metrics.highRatingCount ?? 0;
  if (compositionPuzzle && maxRatingGap >= 3) return true;
  if (compositionPuzzle && highCount >= 4) return true;
  if (highScore >= 120) return true;
  return false;
};

const buildBalancedReplacementCandidates = (
  squad,
  pool,
  ratingTarget,
  signature,
  options = {},
) => {
  const working = Array.isArray(squad) ? squad : [];
  const availablePool = Array.isArray(pool) ? pool : [];
  const usedIds = new Set(
    working.map((player) => player?.id).filter((id) => id != null),
  );
  const target = toNumber(ratingTarget);
  const pivot =
    toNumber(options?.pivot) ??
    (target != null ? Math.max(80, Math.floor(target) - 1) : 84);
  const { minRating, maxRating } = getBalancedRefineBand(target, pivot);
  const dominantLeague = getDominantCountEntry(working, "leagueId");
  const dominantNation = getDominantCountEntry(working, "nationId");
  const dominantClub = getDominantCountEntry(working, "teamId");
  const requiredLeagueIds = new Set(
    (signature?.requiredLeagueIds || [])
      .map(toNumber)
      .filter((value) => value != null),
  );
  const requiredNationIds = new Set(
    (signature?.requiredNationIds || [])
      .map(toNumber)
      .filter((value) => value != null),
  );
  const requiredClubIds = new Set(
    (signature?.requiredClubIds || [])
      .map(toNumber)
      .filter((value) => value != null),
  );
  const maxCandidates = Math.max(20, toNumber(options?.maxCandidates) ?? 48);

  const scored = availablePool
    .filter((player) => player && player.id != null)
    .filter((player) => !usedIds.has(player.id))
    .filter((player) => {
      const rating = toNumber(player?.rating);
      if (rating == null) return false;
      return rating >= minRating && rating <= maxRating;
    })
    .map((player) => {
      const rating = toNumber(player?.rating) ?? 0;
      let identityScore = 0;
      if (
        requiredLeagueIds.size &&
        player?.leagueId != null &&
        requiredLeagueIds.has(player.leagueId)
      ) {
        identityScore += 8;
      }
      if (
        requiredNationIds.size &&
        player?.nationId != null &&
        requiredNationIds.has(player.nationId)
      ) {
        identityScore += 7;
      }
      if (
        requiredClubIds.size &&
        player?.teamId != null &&
        requiredClubIds.has(player.teamId)
      ) {
        identityScore += 7;
      }
      if (
        dominantLeague?.value != null &&
        String(player?.leagueId ?? "") === String(dominantLeague.value)
      ) {
        identityScore += 5;
      }
      if (
        dominantNation?.value != null &&
        String(player?.nationId ?? "") === String(dominantNation.value)
      ) {
        identityScore += 4;
      }
      if (
        dominantClub?.value != null &&
        String(player?.teamId ?? "") === String(dominantClub.value)
      ) {
        identityScore += 2;
      }
      return {
        player,
        rating,
        identityScore,
        distance: Math.abs(rating - pivot),
      };
    })
    .sort((a, b) => {
      if (b.identityScore !== a.identityScore)
        return b.identityScore - a.identityScore;
      if (a.distance !== b.distance) return a.distance - b.distance;
      if (a.rating !== b.rating) return a.rating - b.rating;
      if (Boolean(a.player?.isSpecial) !== Boolean(b.player?.isSpecial))
        return Boolean(a.player?.isSpecial) ? 1 : -1;
      if (Boolean(a.player?.isUntradeable) !== Boolean(b.player?.isUntradeable))
        return Boolean(a.player?.isUntradeable) ? -1 : 1;
      return 0;
    });

  const combined = [];
  const seen = new Set();
  const bestMatches = scored.slice(0, maxCandidates);
  const lowTail = scored
    .slice()
    .sort((a, b) => {
      if (a.rating !== b.rating) return a.rating - b.rating;
      return b.identityScore - a.identityScore;
    })
    .slice(0, Math.min(18, maxCandidates));
  for (const list of [bestMatches, lowTail]) {
    for (const entry of list) {
      const id = entry?.player?.id ?? null;
      if (id == null || seen.has(id)) continue;
      seen.add(id);
      combined.push(entry.player);
      if (combined.length >= maxCandidates) break;
    }
    if (combined.length >= maxCandidates) break;
  }
  return combined;
};

const refineSolvedSquadLocal = (
  squad,
  pool,
  rules,
  squadSize,
  lockedIds,
  debugPush,
  options = {},
) => {
  if (!Array.isArray(squad) || squad.length < squadSize) {
    return {
      squad,
      changed: false,
      ran: false,
      before: null,
      after: null,
      singleSwaps: 0,
      pairEscapes: 0,
      elapsedMs: 0,
      chemistry: options?.initialChemistry ?? null,
    };
  }
  const startedAt = Date.now();
  const timeBudgetMs = Math.max(0, toNumber(options?.timeBudgetMs) ?? 0);
  const deadlineAt = timeBudgetMs > 0 ? startedAt + timeBudgetMs : null;
  const isExpired = () => deadlineAt != null && Date.now() >= deadlineAt;
  const chemistryRequired = Boolean(options?.chemistryRequired);
  const slotsForChemistry = Array.isArray(options?.slotsForChemistry)
    ? options.slotsForChemistry
    : [];
  if (chemistryRequired && slotsForChemistry.length < squadSize) {
    return {
      squad,
      changed: false,
      ran: false,
      before: null,
      after: null,
      singleSwaps: 0,
      pairEscapes: 0,
      elapsedMs: 0,
      chemistry: options?.initialChemistry ?? null,
    };
  }

  const working = squad.slice(0, squadSize);
  const locked = lockedIds instanceof Set ? lockedIds : new Set(lockedIds || []);
  const usedIds = new Set(
    working.map((player) => player?.id).filter((id) => id != null),
  );
  const target = toNumber(options?.ratingTarget);
  const pivot =
    toNumber(options?.pivot) ??
    (target != null ? Math.max(80, Math.floor(target) - 1) : 84);
  const maxIterations = Math.max(
    1,
    toNumber(options?.maxSingleIterations) ?? 20,
  );
  const pairCandidateLimit = Math.max(
    4,
    toNumber(options?.pairCandidateLimit) ?? 16,
  );
  const supplyMaps = options?.supplyMaps || buildSupplyMaps(pool || []);

  const evaluateCandidate = (candidateSquad) => {
    let chemistry = chemistryRequired
      ? computeChemistryEval(candidateSquad, slotsForChemistry, squadSize)
      : null;
    const evalCtx = {
      checkChemistry: chemistryRequired,
      chemistry,
    };
    for (const rule of rules || []) {
      if (!rule) continue;
      const failing = evaluateRule(rule, candidateSquad, squadSize, evalCtx);
      if (failing) return null;
    }
    return {
      chemistry,
      value: getSolvedSquadValueMetrics(candidateSquad, pool, target, {
        pivot,
        requiredInforms: options?.requiredInforms ?? 0,
        requiredSpecials: options?.requiredSpecials ?? 0,
        supplyMaps,
        signature: options?.signature ?? null,
      }),
    };
  };

  const initialEval =
    evaluateCandidate(working) ||
    (() => {
      const chemistry = chemistryRequired ? options?.initialChemistry ?? null : null;
      return {
        chemistry,
        value: getSolvedSquadValueMetrics(working, pool, target, {
          pivot,
          requiredInforms: options?.requiredInforms ?? 0,
          requiredSpecials: options?.requiredSpecials ?? 0,
          supplyMaps,
          signature: options?.signature ?? null,
        }),
      };
    })();

  let bestEval = initialEval;
  let changed = false;
  let singleSwaps = 0;
  let pairEscapes = 0;
  const lowImpactMode =
    (initialEval?.value?.ratingExcess ?? 0) <= 0 &&
    (initialEval?.value?.highRatingCount ?? 0) <= 1 &&
    (initialEval?.value?.specialCount ?? 0) <=
      Math.max(0, toNumber(options?.requiredSpecials) ?? 0);
  const effectiveMaxIterations = lowImpactMode
    ? Math.min(maxIterations, 4)
    : maxIterations;
  const effectivePairSearchEnabled =
    options?.pairSearchEnabled !== false && !lowImpactMode;
  const effectiveMaxCandidates = lowImpactMode
    ? Math.min(toNumber(options?.maxCandidates) ?? 60, 36)
    : toNumber(options?.maxCandidates) ?? 60;

  const getWorstIndices = () =>
    Array.from({ length: working.length }, (_, index) => index)
      .filter((index) => !locked.has(working[index]?.id))
      .sort((a, b) => {
        const playerA = working[a];
        const playerB = working[b];
        const ratingA = toNumber(playerA?.rating) ?? 0;
        const ratingB = toNumber(playerB?.rating) ?? 0;
        if (ratingA !== ratingB) return ratingB - ratingA;
        if (Boolean(playerA?.isSpecial) !== Boolean(playerB?.isSpecial))
          return Boolean(playerA?.isSpecial) ? -1 : 1;
        if (Boolean(playerA?.isUntradeable) !== Boolean(playerB?.isUntradeable))
          return Boolean(playerA?.isUntradeable) ? 1 : -1;
        return 0;
      })
      .slice(0, 6);

  for (let iteration = 0; iteration < effectiveMaxIterations; iteration += 1) {
    if (isExpired()) break;
    const candidates = buildRefinementCandidatePool(working, pool, target, {
      pivot,
      window: options?.window,
      maxCandidates: effectiveMaxCandidates,
      supplyMaps,
    });
    let bestMove = null;

    for (let index = 0; index < working.length; index += 1) {
      if (isExpired()) break;
      const outPlayer = working[index];
      const outId = outPlayer?.id ?? null;
      if (outId != null && locked.has(outId)) continue;

      const seenDefs = new Set();
      for (let j = 0; j < working.length; j += 1) {
        if (j === index) continue;
        const defKey = getDefinitionKey(working[j]);
        if (defKey == null) continue;
        seenDefs.add(String(defKey));
      }

      for (const candidate of candidates) {
        if (isExpired()) break;
        if (!candidate || candidate.id == null) continue;
        if (usedIds.has(candidate.id)) continue;
        const candidateDef = getDefinitionKey(candidate);
        if (candidateDef != null && seenDefs.has(String(candidateDef))) continue;

        const nextSquad = working.slice();
        nextSquad[index] = candidate;
        const nextEval = evaluateCandidate(nextSquad);
        if (!nextEval) continue;
        if (!isSolvedSquadValueBetter(nextEval.value, bestEval.value)) continue;
        if (
          !bestMove ||
          isSolvedSquadValueBetter(nextEval.value, bestMove.eval.value)
        ) {
          bestMove = {
            kind: "single",
            index,
            outPlayer,
            inPlayer: candidate,
            eval: nextEval,
          };
        }
      }
    }

    if (!bestMove && effectivePairSearchEnabled && !isExpired()) {
      const worstIndices = getWorstIndices();
      const pairCandidates = candidates.slice(0, pairCandidateLimit);
      for (let a = 0; a < worstIndices.length && !isExpired(); a += 1) {
        for (
          let b = a + 1;
          b < worstIndices.length && !isExpired();
          b += 1
        ) {
          const outAIndex = worstIndices[a];
          const outBIndex = worstIndices[b];
          const outA = working[outAIndex];
          const outB = working[outBIndex];
          if (!outA || !outB) continue;

          const seenDefs = new Set();
          for (let k = 0; k < working.length; k += 1) {
            if (k === outAIndex || k === outBIndex) continue;
            const defKey = getDefinitionKey(working[k]);
            if (defKey == null) continue;
            seenDefs.add(String(defKey));
          }

          for (let i = 0; i < pairCandidates.length && !isExpired(); i += 1) {
            const inA = pairCandidates[i];
            if (!inA || inA.id == null || usedIds.has(inA.id)) continue;
            const inADef = getDefinitionKey(inA);
            if (inADef != null && seenDefs.has(String(inADef))) continue;

            for (
              let j = i + 1;
              j < pairCandidates.length && !isExpired();
              j += 1
            ) {
              const inB = pairCandidates[j];
              if (!inB || inB.id == null || usedIds.has(inB.id)) continue;
              if (inB.id === inA.id) continue;
              const inBDef = getDefinitionKey(inB);
              if (inBDef != null && seenDefs.has(String(inBDef))) continue;
              if (
                inADef != null &&
                inBDef != null &&
                String(inADef) === String(inBDef)
              ) {
                continue;
              }

              const nextSquad = working.slice();
              nextSquad[outAIndex] = inA;
              nextSquad[outBIndex] = inB;
              const nextEval = evaluateCandidate(nextSquad);
              if (!nextEval) continue;
              if (!isSolvedSquadValueBetter(nextEval.value, bestEval.value))
                continue;
              if (
                !bestMove ||
                isSolvedSquadValueBetter(nextEval.value, bestMove.eval.value)
              ) {
                bestMove = {
                  kind: "pair",
                  outAIndex,
                  outBIndex,
                  outA,
                  outB,
                  inA,
                  inB,
                  eval: nextEval,
                };
              }
            }
          }
        }
      }
    }

    if (!bestMove) break;

    if (bestMove.kind === "pair") {
      working[bestMove.outAIndex] = bestMove.inA;
      working[bestMove.outBIndex] = bestMove.inB;
      if (bestMove.outA?.id != null) usedIds.delete(bestMove.outA.id);
      if (bestMove.outB?.id != null) usedIds.delete(bestMove.outB.id);
      if (bestMove.inA?.id != null) usedIds.add(bestMove.inA.id);
      if (bestMove.inB?.id != null) usedIds.add(bestMove.inB.id);
      pairEscapes += 1;
      debugPush?.({
        stage: "refine",
        action: "swap_pair",
        outIds: [bestMove.outA?.id ?? null, bestMove.outB?.id ?? null],
        inIds: [bestMove.inA?.id ?? null, bestMove.inB?.id ?? null],
        metrics: bestMove.eval.value,
      });
    } else {
      working[bestMove.index] = bestMove.inPlayer;
      if (bestMove.outPlayer?.id != null) usedIds.delete(bestMove.outPlayer.id);
      if (bestMove.inPlayer?.id != null) usedIds.add(bestMove.inPlayer.id);
      singleSwaps += 1;
      debugPush?.({
        stage: "refine",
        action: "swap",
        outId: bestMove.outPlayer?.id ?? null,
        inId: bestMove.inPlayer?.id ?? null,
        metrics: bestMove.eval.value,
      });
    }

    bestEval = bestMove.eval;
    changed = true;
  }

  const elapsedMs = Date.now() - startedAt;
  debugPush?.({
    stage: "refine",
    action: "summary",
    ran: true,
    changed,
    singleSwaps,
    pairEscapes,
    elapsedMs,
    before: initialEval?.value ?? null,
    after: bestEval?.value ?? initialEval?.value ?? null,
  });

  return {
    squad: changed ? working : squad,
    changed,
    ran: true,
    before: initialEval?.value ?? null,
    after: bestEval?.value ?? initialEval?.value ?? null,
    singleSwaps,
    pairEscapes,
    elapsedMs,
    chemistry: bestEval?.chemistry ?? options?.initialChemistry ?? null,
  };
};

const refineSolvedSquadBalancedReshape = (
  squad,
  pool,
  rules,
  squadSize,
  lockedIds,
  debugPush,
  options = {},
) => {
  if (!Array.isArray(squad) || squad.length < squadSize) {
    return {
      squad,
      changed: false,
      ran: false,
      triggerReason: null,
      before: null,
      after: null,
      candidatesEvaluated: 0,
      elapsedMs: 0,
      chemistry: options?.initialChemistry ?? null,
    };
  }
  const startedAt = Date.now();
  const timeBudgetMs = Math.max(0, toNumber(options?.timeBudgetMs) ?? 0);
  const deadlineAt = timeBudgetMs > 0 ? startedAt + timeBudgetMs : null;
  const isExpired = () => deadlineAt != null && Date.now() >= deadlineAt;
  const chemistryRequired = Boolean(options?.chemistryRequired);
  const slotsForChemistry = Array.isArray(options?.slotsForChemistry)
    ? options.slotsForChemistry
    : [];
  if (chemistryRequired && slotsForChemistry.length < squadSize) {
    return {
      squad,
      changed: false,
      ran: false,
      triggerReason: null,
      before: null,
      after: null,
      candidatesEvaluated: 0,
      elapsedMs: 0,
      chemistry: options?.initialChemistry ?? null,
    };
  }

  const working = squad.slice(0, squadSize);
  const locked = lockedIds instanceof Set ? lockedIds : new Set(lockedIds || []);
  const target = toNumber(options?.ratingTarget);
  const pivot =
    toNumber(options?.pivot) ??
    (target != null ? Math.max(80, Math.floor(target) - 1) : 84);
  const signature = options?.signature ?? null;
  const supplyMaps = options?.supplyMaps || buildSupplyMaps(pool || []);

  const evaluateCandidate = (candidateSquad) => {
    const chemistry = chemistryRequired
      ? computeChemistryEval(candidateSquad, slotsForChemistry, squadSize)
      : null;
    const evalCtx = {
      checkChemistry: chemistryRequired,
      chemistry,
    };
    for (const rule of rules || []) {
      if (!rule) continue;
      const failing = evaluateRule(rule, candidateSquad, squadSize, evalCtx);
      if (failing) return null;
    }
    return {
      chemistry,
      value: getSolvedSquadValueMetrics(candidateSquad, pool, target, {
        pivot,
        requiredInforms: options?.requiredInforms ?? 0,
        requiredSpecials: options?.requiredSpecials ?? 0,
        supplyMaps,
        signature: options?.signature ?? null,
      }),
    };
  };

  const initialEval =
    evaluateCandidate(working) ||
    (() => ({
      chemistry: chemistryRequired ? options?.initialChemistry ?? null : null,
      value: getSolvedSquadValueMetrics(working, pool, target, {
        pivot,
        requiredInforms: options?.requiredInforms ?? 0,
        requiredSpecials: options?.requiredSpecials ?? 0,
        supplyMaps,
        signature: options?.signature ?? null,
      }),
    }))();

  const triggerReason = shouldRunBalancedReshape(
    initialEval?.value,
    target,
    signature,
  )
    ? "anchor_heavy"
    : null;
  if (!triggerReason) {
    return {
      squad,
      changed: false,
      ran: false,
      triggerReason: null,
      before: initialEval?.value ?? null,
      after: initialEval?.value ?? null,
      candidatesEvaluated: 0,
      elapsedMs: 0,
      chemistry: initialEval?.chemistry ?? options?.initialChemistry ?? null,
    };
  }

  const candidatePool = buildBalancedReplacementCandidates(
    working,
    pool,
    target,
    signature,
    {
      pivot,
      maxCandidates: options?.maxCandidates ?? 72,
    },
  );
  if (!candidatePool.length) {
    return {
      squad,
      changed: false,
      ran: true,
      triggerReason,
      before: initialEval?.value ?? null,
      after: initialEval?.value ?? null,
      candidatesEvaluated: 0,
      elapsedMs: Date.now() - startedAt,
      chemistry: initialEval?.chemistry ?? options?.initialChemistry ?? null,
    };
  }

  const getPlayerPosNames = (player) => {
    const alt = Array.isArray(player?.alternativePositionNames)
      ? player.alternativePositionNames
      : [];
    if (alt.length) return alt.map((name) => String(name));
    const preferred = player?.preferredPositionName ?? null;
    return preferred == null ? [] : [String(preferred)];
  };
  const getSlotPosName = (index) => {
    const slot = slotsForChemistry[index] ?? null;
    const name = slot?.positionName ?? slot?.position ?? null;
    return name == null ? null : String(name);
  };
  const isPlayableAtIndex = (player, index) => {
    if (!chemistryRequired) return true;
    const slotName = getSlotPosName(index);
    if (!slotName) return true;
    const posNames = getPlayerPosNames(player);
    return posNames.includes(slotName);
  };
  const composition = buildCompositionSnapshot(working, squadSize);
  const requiredLeagueIds = new Set(
    (signature?.requiredLeagueIds || [])
      .map((value) => toNumber(value))
      .filter((value) => value != null),
  );
  const requiredNationIds = new Set(
    (signature?.requiredNationIds || [])
      .map((value) => toNumber(value))
      .filter((value) => value != null),
  );
  const requiredClubIds = new Set(
    (signature?.requiredClubIds || [])
      .map((value) => toNumber(value))
      .filter((value) => value != null),
  );
  const dominantAxes = new Set(
    Array.isArray(signature?.dominantAxes) ? signature.dominantAxes : [],
  );
  const perPlayerChem = Array.isArray(initialEval?.chemistry?.perPlayerChem)
    ? initialEval.chemistry.perPlayerChem
    : [];
  const potentialByPlayer = Array.isArray(initialEval?.chemistry?.potentialByPlayer)
    ? initialEval.chemistry.potentialByPlayer
    : [];
  const rateReplaceable = (index) => {
    const player = working[index];
    if (!player) return -Infinity;
    const rating = toNumber(player?.rating) ?? 0;
    const effectiveTarget =
      target != null ? target : toNumber(initialEval?.value?.squadRating) ?? pivot;
    let score = rating * 8;
    score += Math.max(0, rating - effectiveTarget) * 35;
    if (Boolean(player?.isSpecial)) score += 28;
    if (!player?.isUntradeable) score += 18;
    if (!isPlayableAtIndex(player, index)) score += 45;
    const chemAtIndex = toNumber(perPlayerChem[index]) ?? 0;
    score += Math.max(0, 3 - chemAtIndex) * 12;
    const potentialAtIndex = toNumber(potentialByPlayer[index]) ?? 0;
    score += Math.max(0, 2 - potentialAtIndex) * 6;
    if (requiredLeagueIds.size && !requiredLeagueIds.has(player?.leagueId)) score += 42;
    if (requiredNationIds.size && !requiredNationIds.has(player?.nationId)) score += 36;
    if (requiredClubIds.size && !requiredClubIds.has(player?.teamId)) score += 36;
    if (
      dominantAxes.has("league") &&
      composition?.dominantLeague != null &&
      player?.leagueId !== composition.dominantLeague
    ) {
      score += 22;
    }
    if (
      dominantAxes.has("nation") &&
      composition?.dominantNation != null &&
      player?.nationId !== composition.dominantNation
    ) {
      score += 18;
    }
    if (
      dominantAxes.has("club") &&
      composition?.dominantClub != null &&
      player?.teamId !== composition.dominantClub
    ) {
      score += 14;
    }
    return score;
  };

  const scoredReplaceables = Array.from(
    { length: working.length },
    (_, index) => index,
  )
    .filter((index) => !locked.has(working[index]?.id))
    .map((index) => ({
      index,
      score: rateReplaceable(index),
      rating: toNumber(working[index]?.rating) ?? 0,
    }))
    .sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score;
      return b.rating - a.rating;
    });
  const lowRatedReplaceables = scoredReplaceables
    .slice()
    .sort((a, b) => a.rating - b.rating)
    .slice(0, 3);
  const replacementPool = [];
  const replacementSeen = new Set();
  for (const entry of [...scoredReplaceables.slice(0, 6), ...lowRatedReplaceables]) {
    if (!entry || replacementSeen.has(entry.index)) continue;
    replacementSeen.add(entry.index);
    replacementPool.push(entry.index);
  }

  const replacementSets = [];
  const replacementSetKeys = new Set();
  const pushReplacementSet = (indices) => {
    if (!Array.isArray(indices) || indices.length < 3) return;
    const normalized = indices.slice().sort((a, b) => a - b);
    const key = normalized.join(",");
    if (replacementSetKeys.has(key)) return;
    replacementSetKeys.add(key);
    replacementSets.push(normalized);
  };
  const buildReplacementCombos = (
    sourceIndices,
    size,
    start = 0,
    acc = [],
    limit = 18,
  ) => {
    if (replacementSets.length >= limit) return;
    if (acc.length >= size) {
      pushReplacementSet(acc);
      return;
    }
    for (let i = start; i < sourceIndices.length; i += 1) {
      acc.push(sourceIndices[i]);
      buildReplacementCombos(sourceIndices, size, i + 1, acc, limit);
      acc.pop();
      if (replacementSets.length >= limit) return;
    }
  };
  for (const size of [3, 4]) {
    if (replacementPool.length >= size) {
      buildReplacementCombos(replacementPool, size);
    }
  }
  if (replacementPool.length >= 5) {
    pushReplacementSet(replacementPool.slice(0, 5));
  }

  let bestEval = initialEval;
  let bestSquad = working;
  let candidatesEvaluated = 0;
  const maxEvaluations = Math.max(
    40,
    toNumber(options?.maxEvaluations) ?? 220,
  );

  for (const replaceIndices of replacementSets) {
    if (isExpired()) break;
    const perSlotLimit =
      replaceIndices.length >= 5 ? 3 : replaceIndices.length === 4 ? 4 : 6;
    const slotCandidates = replaceIndices.map((index) => {
      const outPlayer = working[index];
      const seenDefs = new Set();
      for (let j = 0; j < working.length; j += 1) {
        if (j === index) continue;
        const defKey = getDefinitionKey(working[j]);
        if (defKey == null) continue;
        seenDefs.add(String(defKey));
      }
      const filtered = candidatePool
        .filter((candidate) => {
          if (!candidate || candidate.id == null) return false;
          if (candidate.id === outPlayer?.id) return false;
          const defKey = getDefinitionKey(candidate);
          if (defKey != null && seenDefs.has(String(defKey))) return false;
          return true;
        });
      const playable = filtered.filter((candidate) =>
        isPlayableAtIndex(candidate, index),
      );
      return (playable.length ? playable : filtered).slice(0, perSlotLimit);
    });

    const trial = working.slice();
    const usedIds = new Set(
      working
        .map((player) => player?.id)
        .filter((id) => id != null),
    );
    const usedDefs = new Set(
      working
        .map((player) => getDefinitionKey(player))
        .filter((value) => value != null)
        .map((value) => String(value)),
    );
    for (const index of replaceIndices) {
      usedIds.delete(trial[index]?.id);
      const defKey = getDefinitionKey(trial[index]);
      if (defKey != null) usedDefs.delete(String(defKey));
    }

    const assignReplacement = (depth = 0) => {
      if (isExpired()) return;
      if (candidatesEvaluated >= maxEvaluations) return;
      if (depth >= replaceIndices.length) {
        candidatesEvaluated += 1;
        const nextEval = evaluateCandidate(trial);
        if (!nextEval) return;
        if (isSolvedSquadValueBetter(nextEval.value, bestEval.value)) {
          bestEval = nextEval;
          bestSquad = trial.slice();
        }
        return;
      }

      const slotIndex = replaceIndices[depth];
      const previous = trial[slotIndex];
      for (const candidate of slotCandidates[depth]) {
        if (isExpired()) return;
        if (!candidate || candidate.id == null) continue;
        if (usedIds.has(candidate.id)) continue;
        const defKey = getDefinitionKey(candidate);
        if (defKey != null && usedDefs.has(String(defKey))) continue;

        trial[slotIndex] = candidate;
        usedIds.add(candidate.id);
        if (defKey != null) usedDefs.add(String(defKey));
        assignReplacement(depth + 1);
        usedIds.delete(candidate.id);
        if (defKey != null) usedDefs.delete(String(defKey));
        trial[slotIndex] = previous;

        if (candidatesEvaluated >= maxEvaluations) return;
      }
    };

    assignReplacement(0);
  }

  const changed =
    bestSquad !== working &&
    isSolvedSquadValueBetter(bestEval?.value, initialEval?.value);
  const elapsedMs = Date.now() - startedAt;
  debugPush?.({
    stage: "refine",
    action: "balanced_reshape_summary",
    ran: true,
    triggerReason,
    changed,
    candidatesEvaluated,
    elapsedMs,
    before: initialEval?.value ?? null,
    after: bestEval?.value ?? initialEval?.value ?? null,
  });

  return {
    squad: changed ? bestSquad : squad,
    changed,
    ran: true,
    triggerReason,
    before: initialEval?.value ?? null,
    after: bestEval?.value ?? initialEval?.value ?? null,
    candidatesEvaluated,
    elapsedMs,
    chemistry: bestEval?.chemistry ?? options?.initialChemistry ?? null,
  };
};

const refineSolvedSquad = (
  squad,
  pool,
  rules,
  squadSize,
  lockedIds,
  debugPush,
  options = {},
) => {
  const localBudget = Math.max(
    0,
    toNumber(options?.localTimeBudgetMs) ??
      Math.floor((toNumber(options?.timeBudgetMs) ?? 0) * 0.45),
  );
  const reshapeBudget = Math.max(
    0,
    toNumber(options?.reshapeTimeBudgetMs) ??
      Math.floor((toNumber(options?.timeBudgetMs) ?? 0) * 0.55),
  );
  const reshapeEnabled = options?.balancedReshapeEnabled === true;
  const local = refineSolvedSquadLocal(
    squad,
    pool,
    rules,
    squadSize,
    lockedIds,
    debugPush,
    {
      ...options,
      timeBudgetMs: localBudget,
    },
  );
  const baseSquad = local?.changed ? local.squad : squad;
  const baseChemistry =
    local?.changed
      ? local?.chemistry ?? options?.initialChemistry ?? null
      : options?.initialChemistry ?? null;
  const reshape = reshapeEnabled
    ? refineSolvedSquadBalancedReshape(
        baseSquad,
        pool,
        rules,
        squadSize,
        lockedIds,
        debugPush,
        {
          ...options,
          initialChemistry: baseChemistry,
          timeBudgetMs: reshapeBudget,
        },
      )
    : {
        squad: baseSquad,
        changed: false,
        ran: false,
        triggerReason: null,
        before: null,
        after: null,
        candidatesEvaluated: 0,
        elapsedMs: 0,
        chemistry: baseChemistry,
      };
  const changed = Boolean(local?.changed) || Boolean(reshape?.changed);
  const finalSquad = reshape?.changed
    ? reshape.squad
    : local?.changed
      ? local.squad
      : squad;
  const finalChemistry =
    reshape?.changed
      ? reshape?.chemistry ?? baseChemistry
      : local?.changed
        ? local?.chemistry ?? options?.initialChemistry ?? null
        : options?.initialChemistry ?? null;
  return {
    squad: finalSquad,
    changed,
    ran: Boolean(local?.ran) || Boolean(reshape?.ran),
    before: local?.before ?? null,
    after:
      (reshape?.ran ? reshape?.after : null) ??
      (local?.ran ? local?.after : null) ??
      null,
    singleSwaps: local?.singleSwaps ?? 0,
    pairEscapes: local?.pairEscapes ?? 0,
    reshapeTriggered: Boolean(reshape?.ran && reshape?.triggerReason),
    reshapeReason: reshape?.triggerReason ?? null,
    reshapeChanged: Boolean(reshape?.changed),
    reshapeCandidatesEvaluated: reshape?.candidatesEvaluated ?? 0,
    elapsedMs: (local?.elapsedMs ?? 0) + (reshape?.elapsedMs ?? 0),
    chemistry: finalChemistry,
  };
};

const optimizeSquadForPreservation = (
  squad,
  pool,
  rules,
  squadSize,
  ratingTarget,
  lockedIds,
  debugPush,
  options = {},
) => {
  if (!Array.isArray(squad) || !squad.length) return { squad, changed: false };
  if (!Array.isArray(pool) || !pool.length) return { squad, changed: false };
  const target = toNumber(ratingTarget);
  if (target == null) return { squad, changed: false };

  const requiredInforms = Math.max(0, toNumber(options?.requiredInforms) ?? 0);
  const preferLowerExcessInforms = options?.preferLowerExcessInforms !== false;
  const pivot =
    toNumber(options?.pivot) ??
    // Default: penalize ratings above the minimum needed to hit the squad rating.
    Math.max(80, Math.floor(target) - 1);
  const maxIterations = Math.max(1, toNumber(options?.maxIterations) ?? 30);
  const pairSearchEnabled = options?.pairSearch !== false;
  const pairOutlierThreshold = Math.max(
    0,
    toNumber(options?.pairOutlierThreshold) ?? 4,
  );
  const pairCandidateLimit = toNumber(options?.pairCandidates);

  let changed = false;
  const working = squad.slice(0, squadSize);
  const usedIds = new Set(
    working.map((player) => player?.id).filter((id) => id != null),
  );

  const metricsBefore = getSquadPreservationMetrics(
    working,
    target,
    pivot,
    requiredInforms,
  );

  const buildOptimizationCandidates = () => {
    const window = Math.max(1, toNumber(options?.window) ?? 6);
    const maxCandidates = Math.max(40, toNumber(options?.maxCandidates) ?? 220);
    const minRating = pivot - window;
    const maxRating = pivot + window;

    const available = (pool || [])
      .filter((player) => player && player.id != null)
      .filter((player) => !usedIds.has(player.id));

    const windowed = available
      .filter((player) => {
        const rating = toNumber(player?.rating);
        if (rating == null) return false;
        return rating >= minRating && rating <= maxRating;
      })
      .sort((a, b) => a.rating - b.rating);

    const low = available
      .slice()
      .sort((a, b) => a.rating - b.rating)
      .slice(0, 40);
    const high = available
      .slice()
      .sort((a, b) => b.rating - a.rating)
      .slice(0, 40);

    const combined = [];
    const seen = new Set();
    for (const list of [windowed, low, high]) {
      for (const player of list) {
        if (!player || player.id == null) continue;
        if (seen.has(player.id)) continue;
        seen.add(player.id);
        combined.push(player);
        if (combined.length >= maxCandidates) break;
      }
      if (combined.length >= maxCandidates) break;
    }
    return combined;
  };

  let bestMetrics = metricsBefore;
  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    let bestMove = null;
    let bestMoveKind = null;

    const candidates = buildOptimizationCandidates();

    for (let index = 0; index < working.length; index += 1) {
      const outPlayer = working[index];
      const outId = outPlayer?.id ?? null;
      if (outId != null && lockedIds?.has(outId)) continue;

      const seenDefs = new Set();
      for (let j = 0; j < working.length; j += 1) {
        if (j === index) continue;
        const defKey = getDefinitionKey(working[j]);
        if (defKey == null) continue;
        seenDefs.add(String(defKey));
      }

      for (const candidate of candidates) {
        if (!candidate) continue;
        const inId = candidate.id ?? null;
        if (inId == null) continue;
        if (usedIds.has(inId)) continue;

        const candidateDef = getDefinitionKey(candidate);
        if (candidateDef != null && seenDefs.has(String(candidateDef)))
          continue;

        const previous = working[index];
        working[index] = candidate;

        const valid = isSquadValid(rules, working, squadSize);
        if (!valid) {
          working[index] = previous;
          continue;
        }

        const candidateMetrics = getSquadPreservationMetrics(
          working,
          target,
          pivot,
          requiredInforms,
        );
        if (
          isPreservationMetricsBetter(candidateMetrics, bestMetrics, {
            preferLowerExcessInforms,
          })
        ) {
          bestMetrics = candidateMetrics;
          bestMove = {
            index,
            outPlayer: previous,
            inPlayer: candidate,
          };
          bestMoveKind = "single";
        }

        working[index] = previous;
      }
    }

    if (!bestMove) {
      // Attempt pair swaps (high+low smoothing) when single swaps cannot improve.
      const currentMax = working.reduce(
        (max, player) => Math.max(max, toNumber(player?.rating) ?? 0),
        0,
      );
      const shouldTryPairs =
        pairSearchEnabled && currentMax - pivot >= pairOutlierThreshold;
      if (!shouldTryPairs) break;

      const pairCandidates =
        pairCandidateLimit != null
          ? candidates
              .slice()
              .sort((a, b) => {
                const aRating = toNumber(a?.rating) ?? 0;
                const bRating = toNumber(b?.rating) ?? 0;
                const aDist = Math.abs(aRating - pivot);
                const bDist = Math.abs(bRating - pivot);
                if (aDist !== bDist) return aDist - bDist;
                return aRating - bRating;
              })
              .slice(0, Math.max(2, Math.floor(pairCandidateLimit)))
          : candidates;
      for (let i = 0; i < working.length; i += 1) {
        const outA = working[i];
        const outAId = outA?.id ?? null;
        if (outAId != null && lockedIds?.has(outAId)) continue;

        for (let j = i + 1; j < working.length; j += 1) {
          const outB = working[j];
          const outBId = outB?.id ?? null;
          if (outBId != null && lockedIds?.has(outBId)) continue;

          const seenDefs = new Set();
          for (let k = 0; k < working.length; k += 1) {
            if (k === i || k === j) continue;
            const defKey = getDefinitionKey(working[k]);
            if (defKey == null) continue;
            seenDefs.add(String(defKey));
          }

          for (let a = 0; a < pairCandidates.length; a += 1) {
            const inA = pairCandidates[a];
            if (!inA || inA.id == null) continue;
            if (usedIds.has(inA.id)) continue;
            const inADef = getDefinitionKey(inA);
            if (inADef != null && seenDefs.has(String(inADef))) continue;

            for (let b = a + 1; b < pairCandidates.length; b += 1) {
              const inB = pairCandidates[b];
              if (!inB || inB.id == null) continue;
              if (usedIds.has(inB.id)) continue;
              if (inB.id === inA.id) continue;

              const inBDef = getDefinitionKey(inB);
              if (inBDef != null && seenDefs.has(String(inBDef))) continue;
              if (
                inADef != null &&
                inBDef != null &&
                String(inADef) === String(inBDef)
              ) {
                continue;
              }

              const prevA = working[i];
              const prevB = working[j];
              working[i] = inA;
              working[j] = inB;

              const valid = isSquadValid(rules, working, squadSize);
              if (!valid) {
                working[i] = prevA;
                working[j] = prevB;
                continue;
              }

              const candidateMetrics = getSquadPreservationMetrics(
                working,
                target,
                pivot,
                requiredInforms,
              );
              if (
                isPreservationMetricsBetter(candidateMetrics, bestMetrics, {
                  preferLowerExcessInforms,
                })
              ) {
                bestMetrics = candidateMetrics;
                bestMove = {
                  i,
                  j,
                  outA: prevA,
                  outB: prevB,
                  inA,
                  inB,
                };
                bestMoveKind = "pair";
              }

              working[i] = prevA;
              working[j] = prevB;
            }
          }
        }
      }
    }

    if (!bestMove) break;

    if (bestMoveKind === "pair") {
      working[bestMove.i] = bestMove.inA;
      working[bestMove.j] = bestMove.inB;
      if (bestMove.outA?.id != null) usedIds.delete(bestMove.outA.id);
      if (bestMove.outB?.id != null) usedIds.delete(bestMove.outB.id);
      if (bestMove.inA?.id != null) usedIds.add(bestMove.inA.id);
      if (bestMove.inB?.id != null) usedIds.add(bestMove.inB.id);
      changed = true;
      debugPush?.({
        stage: "preserve",
        action: "swap_pair",
        pivot,
        requiredInforms,
        outAId: bestMove.outA?.id ?? null,
        outARating: bestMove.outA?.rating ?? null,
        outBId: bestMove.outB?.id ?? null,
        outBRating: bestMove.outB?.rating ?? null,
        inAId: bestMove.inA?.id ?? null,
        inARating: bestMove.inA?.rating ?? null,
        inBId: bestMove.inB?.id ?? null,
        inBRating: bestMove.inB?.rating ?? null,
        metrics: bestMetrics,
      });
    } else {
      const outId = bestMove.outPlayer?.id ?? null;
      const inId = bestMove.inPlayer?.id ?? null;
      working[bestMove.index] = bestMove.inPlayer;
      if (outId != null) usedIds.delete(outId);
      if (inId != null) usedIds.add(inId);
      changed = true;
      debugPush?.({
        stage: "preserve",
        action: "swap",
        pivot,
        requiredInforms,
        outId,
        outRating: bestMove.outPlayer?.rating ?? null,
        inId,
        inRating: bestMove.inPlayer?.rating ?? null,
        metrics: bestMetrics,
      });
    }
  }

  const metricsAfter = changed
    ? getSquadPreservationMetrics(working, target, pivot, requiredInforms)
    : metricsBefore;

  debugPush?.({
    stage: "preserve",
    action: "summary",
    changed,
    pivot,
    requiredInforms,
    before: metricsBefore,
    after: metricsAfter,
  });

  return {
    squad: working,
    changed,
    before: metricsBefore,
    after: metricsAfter,
  };
};

const getDefinitionKey = (player) =>
  player?.definitionId ?? player?.defId ?? player?.id ?? null;

const getDuplicateDefinitionKeys = (squad, squadSize = null) => {
  const n = Math.min(
    toNumber(squadSize) ?? squad?.length ?? 0,
    squad?.length ?? 0,
  );
  const counts = new Map();
  for (let index = 0; index < n; index += 1) {
    const defKey = getDefinitionKey(squad?.[index]);
    if (defKey == null) continue;
    const normalized = String(defKey);
    counts.set(normalized, (counts.get(normalized) || 0) + 1);
  }
  return Array.from(counts.entries())
    .filter(([, count]) => count > 1)
    .map(([key]) => key);
};

const hasDuplicateDefinitions = (squad, squadSize = null) =>
  getDuplicateDefinitionKeys(squad, squadSize).length > 0;

const isSquadValid = (rules, squad, squadSize) => {
  for (const rule of rules || []) {
    if (!rule) continue;
    const failing = evaluateRule(rule, squad, squadSize);
    if (failing) return false;
  }
  return true;
};

const enforceUniqueDefinitions = (
  squad,
  pool,
  rules,
  squadSize,
  debugPush,
  options = {},
) => {
  const usedIds = new Set(
    (squad || []).map((player) => player?.id).filter((id) => id != null),
  );
  const seenDefs = new Set();
  let replaced = 0;
  const chemistryRequired = Boolean(options?.chemistryRequired);
  const slotsForChemistry = Array.isArray(options?.slotsForChemistry)
    ? options.slotsForChemistry
    : null;
  const chemistryTargets = options?.chemistryTargets ?? null;
  const currentChemistry = options?.currentChemistry ?? null;
  const chemistryIsRelevant =
    chemistryRequired &&
    Array.isArray(slotsForChemistry) &&
    slotsForChemistry.length >= squadSize &&
    chemistryTargets;
  const requireChemistrySatisfied =
    chemistryIsRelevant &&
    isChemistrySatisfied(currentChemistry, chemistryTargets);

  for (let index = 0; index < (squad || []).length; index += 1) {
    const player = squad[index];
    if (!player) continue;
    const defKey = getDefinitionKey(player);
    if (defKey == null) continue;
    if (!seenDefs.has(defKey)) {
      seenDefs.add(defKey);
      continue;
    }

    const candidates = (pool || [])
      .filter((candidate) => candidate && candidate.id != null)
      .filter((candidate) => !usedIds.has(candidate.id))
      .filter((candidate) => {
        const candidateDef = getDefinitionKey(candidate);
        if (candidateDef == null) return true;
        return !seenDefs.has(candidateDef);
      })
      .sort((a, b) => a.rating - b.rating);

    let replacedThis = false;
    let bestReplacement = null;
    for (const candidate of candidates) {
      const previous = squad[index];
      squad[index] = candidate;
      if (isSquadValid(rules, squad, squadSize)) {
        const nextChem = chemistryIsRelevant
          ? computeChemistryEval(squad, slotsForChemistry, squadSize)
          : null;
        const nextChemSatisfied = chemistryIsRelevant
          ? isChemistrySatisfied(nextChem, chemistryTargets)
          : true;
        const nextShortfall = chemistryIsRelevant
          ? getChemistryShortfall(nextChem, chemistryTargets).score
          : 0;
        const replacementScore = {
          keepsChemistry:
            requireChemistrySatisfied ? Number(nextChemSatisfied) : 0,
          chemistryShortfall: nextShortfall,
          rating: toNumber(candidate?.rating) ?? 0,
        };
        if (
          !bestReplacement ||
          replacementScore.keepsChemistry > bestReplacement.score.keepsChemistry ||
          (replacementScore.keepsChemistry ===
            bestReplacement.score.keepsChemistry &&
            replacementScore.chemistryShortfall <
              bestReplacement.score.chemistryShortfall) ||
          (replacementScore.keepsChemistry ===
            bestReplacement.score.keepsChemistry &&
            replacementScore.chemistryShortfall ===
              bestReplacement.score.chemistryShortfall &&
            replacementScore.rating < bestReplacement.score.rating)
        ) {
          bestReplacement = {
            candidate,
            previous,
            chemistry: nextChem,
            score: replacementScore,
          };
        }
      }
      squad[index] = previous;
    }

    if (
      bestReplacement &&
      (!requireChemistrySatisfied || bestReplacement.score.keepsChemistry > 0)
    ) {
      const { candidate, previous, chemistry: replacementChemistry } =
        bestReplacement;
      squad[index] = candidate;
      const candidateDef = getDefinitionKey(candidate);
      usedIds.delete(previous?.id ?? null);
      usedIds.add(candidate.id);
      if (candidateDef != null) seenDefs.add(candidateDef);
      replaced += 1;
      replacedThis = true;
      debugPush?.({
        stage: "dedupe",
        action: "replace",
        outId: previous?.id ?? null,
        outDefinitionId: getDefinitionKey(previous),
        inId: candidate.id,
        inDefinitionId: candidateDef ?? null,
        chemistryShortfall: chemistryIsRelevant
          ? bestReplacement.score.chemistryShortfall
          : null,
        chemistrySatisfied: chemistryIsRelevant
          ? isChemistrySatisfied(replacementChemistry, chemistryTargets)
          : null,
      });
    }

    if (!replacedThis) {
      debugPush?.({
        stage: "dedupe",
        action: "skip",
        reason: "no_valid_replacement",
        id: player?.id ?? null,
        definitionId: defKey,
      });
    }
  }

  return replaced;
};

const isSquadValidWithIgnoredTypes = (
  rules,
  squad,
  squadSize,
  ignoredTypes,
) => {
  const ignored =
    ignoredTypes instanceof Set ? ignoredTypes : new Set(ignoredTypes || []);
  for (const rule of rules || []) {
    if (!rule) continue;
    if (ignored.has(rule.type)) continue;
    const failing = evaluateRule(rule, squad, squadSize);
    if (failing) return false;
  }
  return true;
};

const reduceUniqueAttrCount = (
  squad,
  pool,
  rules,
  squadSize,
  attr,
  maxUnique,
  lockedIds,
  debugPush,
  options = {},
) => {
  const max = toNumber(maxUnique);
  if (max == null) return false;
  const n = Math.min(toNumber(squadSize) ?? 0, squad?.length ?? 0);
  if (!Array.isArray(squad) || n <= 0) return false;
  const working = squad.slice(0, n);
  const usedIds = new Set(
    working.map((player) => player?.id).filter((id) => id != null),
  );
  const locked =
    lockedIds instanceof Set ? lockedIds : new Set(lockedIds || []);
  const maxIterations = Math.max(10, toNumber(options?.maxIterations) ?? 120);
  const allowedAttrs = Array.isArray(options?.allowedAttrs)
    ? options.allowedAttrs
    : [];

  const ignoredTypes = new Set(options?.ignoredTypes || []);
  ignoredTypes.add("team_rating");
  ignoredTypes.add("chemistry_points");
  ignoredTypes.add("all_players_chemistry_points");

  const maxReseed = Math.max(0, toNumber(options?.maxReseed) ?? 2);
  const reseedSlack = Math.max(0, toNumber(options?.reseedSlack) ?? 2);
  const maxUniqueCap = max + reseedSlack;
  let reseedCount = 0;
  // When we "reseed" a new group to gain supply, treat it as sticky so we don't immediately
  // eliminate it on the next iteration.
  const protectedValues = new Set();

  let iterations = 0;
  while (iterations < maxIterations) {
    iterations += 1;
    const counts = countByAttr(working, attr);
    const uniqueCount = counts.size;
    if (uniqueCount <= max) break;

    const existingValues = new Set(counts.keys());
    const allowedSets = allowedAttrs.map((name) => ({
      name,
      values: new Set(countByAttr(working, name).keys()),
    }));

    const available = (pool || [])
      .filter((player) => player && player.id != null)
      .filter((player) => !usedIds.has(player.id))
      .slice();
    const supply = countByAttr(available, attr);
    available.sort((a, b) => {
      const aSupply = supply.get(a?.[attr]) || 0;
      const bSupply = supply.get(b?.[attr]) || 0;
      if (bSupply !== aSupply) return bSupply - aSupply;
      return a.rating - b.rating;
    });

    let bestMove = null;
    const seenDefsByIndex = new Map();
    const getSeenDefs = (outIndex) => {
      if (seenDefsByIndex.has(outIndex)) return seenDefsByIndex.get(outIndex);
      const seen = new Set();
      for (let j = 0; j < working.length; j += 1) {
        if (j === outIndex) continue;
        const defKey = getDefinitionKey(working[j]);
        if (defKey == null) continue;
        seen.add(String(defKey));
      }
      seenDefsByIndex.set(outIndex, seen);
      return seen;
    };

    const tryPickMove = (outIndices, mode) => {
      let best = null;
      for (const outIndex of outIndices) {
        const outPlayer = working[outIndex];
        const outValue = outPlayer?.[attr] ?? null;
        if (outValue == null) continue;

        const outCount = counts.get(outValue) || 0;
        if (mode === "eliminate" && outCount !== 1) continue;
        if (mode === "setup" && outCount <= 1) continue;

        const seenDefs = getSeenDefs(outIndex);

        for (const candidate of available) {
          if (!candidate) continue;
          const value = candidate?.[attr];
          if (value == null) continue;
          let allowed = true;
          for (const extra of allowedSets) {
            const extraValue = candidate?.[extra.name];
            if (extraValue == null || !extra.values.has(extraValue)) {
              allowed = false;
              break;
            }
          }
          if (!allowed) continue;
          // Only swap in players from *existing* groups so the unique count never increases.
          if (!existingValues.has(value)) continue;
          // Must be a different group to reduce the out-group count.
          if (value === outValue) continue;

          const candidateDef = getDefinitionKey(candidate);
          if (candidateDef != null && seenDefs.has(String(candidateDef)))
            continue;

          const previous = working[outIndex];
          working[outIndex] = candidate;
          const nextUnique = countByAttr(working, attr).size;
          const validUnique =
            mode === "eliminate"
              ? nextUnique < uniqueCount
              : // Setup moves should not increase unique counts.
                nextUnique <= uniqueCount;
          const valid =
            validUnique &&
            isSquadValidWithIgnoredTypes(rules, working, n, ignoredTypes);
          working[outIndex] = previous;

          if (!valid) continue;

          const valueSupply = supply.get(value) || 0;
          const becomesSingleton = outCount - 1 === 1;
          // Prefer swapping into groups with large remaining supply to make future reductions easier.
          // For setup moves, strongly prefer turning a count=2 group into a singleton so it can be
          // eliminated on the next iteration.
          const key = {
            becomesSingleton: becomesSingleton ? 1 : 0,
            outCount,
            valueSupply,
            inRating: candidate.rating,
          };
          const isBetter = (a, b) => {
            if (!b) return true;
            if (mode === "setup") {
              if (a.becomesSingleton !== b.becomesSingleton) {
                return a.becomesSingleton > b.becomesSingleton;
              }
              if (a.outCount !== b.outCount) return a.outCount < b.outCount;
            }
            if (a.valueSupply !== b.valueSupply)
              return a.valueSupply > b.valueSupply;
            // Prefer lower-rated candidates to preserve club value. Rating improvement happens later.
            return a.inRating < b.inRating;
          };

          if (!best || isBetter(key, best.key)) {
            best = {
              outIndex,
              outPlayer: previous,
              inPlayer: candidate,
              nextUnique,
              valueSupply,
              mode,
              key,
            };
          }

          // For elimination moves, the candidate list is supply+rating sorted, so we can't do better
          // for this outIndex after the first valid hit.
          if (mode === "eliminate") break;
        }
      }
      return best;
    };

    const outIndicesEliminate = [];
    for (let index = 0; index < working.length; index += 1) {
      const player = working[index];
      if (!player) continue;
      if (locked.has(player.id)) continue;
      const value = player?.[attr];
      if (value == null) continue;
      const count = counts.get(value) || 0;
      if (count === 1 && !protectedValues.has(value))
        outIndicesEliminate.push(index);
    }

    bestMove = tryPickMove(outIndicesEliminate, "eliminate");

    if (!bestMove) {
      // No valid singleton elimination exists. This can happen when the only singletons are
      // structurally required by other constraints (e.g. "Napoli OR Roma: Min 2" with one each).
      // In that case, perform a "setup" swap that reduces a count>1 group down towards 1, without
      // increasing unique counts. This enables a later singleton elimination.
      const outIndicesSetup = [];
      for (let index = 0; index < working.length; index += 1) {
        const player = working[index];
        if (!player) continue;
        if (locked.has(player.id)) continue;
        const value = player?.[attr];
        if (value == null) continue;
        if (protectedValues.has(value)) continue;
        const count = counts.get(value) || 0;
        if (count > 1) outIndicesSetup.push(index);
      }
      bestMove = tryPickMove(outIndicesSetup, "setup");
    }

    if (!bestMove) {
      // If we still can't find a move, we may have exhausted the supply of every existing group
      // (i.e. no unused players remain from any of them). In that case, allow a limited "reseed"
      // move that introduces a new group with high supply, then eliminate multiple old groups to
      // reach the max.
      if (reseedCount >= maxReseed || uniqueCount >= maxUniqueCap) break;

      const outIndicesReseed = [];
      for (let index = 0; index < working.length; index += 1) {
        const player = working[index];
        if (!player) continue;
        if (locked.has(player.id)) continue;
        const outValue = player?.[attr];
        if (outValue == null) continue;
        if (protectedValues.has(outValue)) continue;
        const outCount = counts.get(outValue) || 0;
        if (outCount <= 1) continue; // don't replace singletons (usually required)
        outIndicesReseed.push(index);
      }
      outIndicesReseed.sort((a, b) => {
        const aValue = working[a]?.[attr];
        const bValue = working[b]?.[attr];
        const aCount =
          aValue == null ? Infinity : counts.get(aValue) || Infinity;
        const bCount =
          bValue == null ? Infinity : counts.get(bValue) || Infinity;
        if (aCount !== bCount) return aCount - bCount;
        const aRating = working[a]?.rating ?? 0;
        const bRating = working[b]?.rating ?? 0;
        return aRating - bRating;
      });

      const newCandidates = available
        .filter((candidate) => {
          const value = candidate?.[attr];
          const valueSupply = value == null ? 0 : supply.get(value) || 0;
          return (
            value != null && !existingValues.has(value) && valueSupply >= 2
          );
        })
        .slice();

      let reseedMove = null;
      for (const outIndex of outIndicesReseed) {
        const outPlayer = working[outIndex];
        const outValue = outPlayer?.[attr] ?? null;
        if (outValue == null) continue;

        const seenDefs = getSeenDefs(outIndex);

        for (const candidate of newCandidates) {
          const value = candidate?.[attr];
          if (value == null) continue;

          let allowed = true;
          for (const extra of allowedSets) {
            const extraValue = candidate?.[extra.name];
            if (extraValue == null || !extra.values.has(extraValue)) {
              allowed = false;
              break;
            }
          }
          if (!allowed) continue;

          const candidateDef = getDefinitionKey(candidate);
          if (candidateDef != null && seenDefs.has(String(candidateDef)))
            continue;

          const previous = working[outIndex];
          working[outIndex] = candidate;
          const nextUnique = countByAttr(working, attr).size;
          const valid =
            nextUnique <= maxUniqueCap &&
            isSquadValidWithIgnoredTypes(rules, working, n, ignoredTypes);
          working[outIndex] = previous;
          if (!valid) continue;

          reseedMove = {
            outIndex,
            outPlayer: previous,
            inPlayer: candidate,
            nextUnique,
            valueSupply: supply.get(value) || 0,
            mode: "reseed",
          };
          break;
        }

        if (reseedMove) break;
      }

      if (!reseedMove) break;
      reseedCount += 1;
      bestMove = reseedMove;
    }

    const prev = working[bestMove.outIndex];
    working[bestMove.outIndex] = bestMove.inPlayer;
    usedIds.delete(prev?.id ?? null);
    usedIds.add(bestMove.inPlayer.id);
    if (bestMove.mode === "reseed") {
      protectedValues.clear();
      const protectedValue = bestMove.inPlayer?.[attr];
      if (protectedValue != null) protectedValues.add(protectedValue);
    }

    debugPush?.({
      stage: "unique",
      action: "swap",
      mode: bestMove.mode ?? "eliminate",
      attr,
      maxUnique: max,
      outId: bestMove.outPlayer?.id ?? null,
      outRating: bestMove.outPlayer?.rating ?? null,
      inId: bestMove.inPlayer?.id ?? null,
      inRating: bestMove.inPlayer?.rating ?? null,
      uniqueCount: countByAttr(working, attr).size,
    });
  }

  // Mutate input squad.
  squad.length = 0;
  squad.push(...working);

  return countByAttr(working, attr).size <= max;
};

const evaluateRule = (rule, squad, squadSize, evalCtx) => {
  if (!rule) return null;
  const required = getRuleCount(rule, squadSize);
  if (rule.type === "player_quality" || rule.type === "player_level") {
    // EA sometimes encodes quality/level constraints as squad-wide gates (ex: "Max Silver")
    // without providing a player-count target. In that case, every player must satisfy
    // the ordinal bound.
    if (required == null) {
      const gatePredicate =
        rule.gatePredicate || buildQualityGatePredicate(rule);
      if (gatePredicate) {
        const ok = (squad || []).every((player) => gatePredicate(player));
        if (!ok) return rule.raw;
        return null;
      }
    }
  }
  if (rule.type === "players_in_squad") {
    if (squad.length !== squadSize) return rule.raw;
    return null;
  }
  if (rule.type === "team_rating") {
    if (required == null) return null;
    const rating = getSquadRating(squad);
    if (rating < required) return rule.raw;
    return null;
  }
  if (rule.type === "chemistry_points") {
    if (!evalCtx?.checkChemistry) return null;
    if (required == null) return null;
    const totalChem = toNumber(evalCtx?.chemistry?.totalChem);
    if (totalChem == null) return rule.raw;
    if (totalChem < required) return rule.raw;
    return null;
  }
  if (rule.type === "all_players_chemistry_points") {
    if (!evalCtx?.checkChemistry) return null;
    if (required == null) return null;
    const minChem = toNumber(evalCtx?.chemistry?.minChem);
    if (minChem == null) return rule.raw;
    if (minChem < required) return rule.raw;
    return null;
  }
  if (rule.type === "nation_count") {
    const count = countByAttr(squad, "nationId").size;
    if (rule.op === "min" && count < required) return rule.raw;
    if (rule.op === "max" && count > required) return rule.raw;
    if (rule.op === "exact" && count !== required) return rule.raw;
    return null;
  }
  if (rule.type === "league_count") {
    const count = countByAttr(squad, "leagueId").size;
    if (rule.op === "min" && count < required) return rule.raw;
    if (rule.op === "max" && count > required) return rule.raw;
    if (rule.op === "exact" && count !== required) return rule.raw;
    return null;
  }
  if (rule.type === "club_count") {
    const count = countByAttr(squad, "teamId").size;
    if (rule.op === "min" && count < required) return rule.raw;
    if (rule.op === "max" && count > required) return rule.raw;
    if (rule.op === "exact" && count !== required) return rule.raw;
    return null;
  }
  if (rule.type === "same_nation_count") {
    const max = Math.max(0, ...countByAttr(squad, "nationId").values());
    if (rule.op === "min" && max < required) return rule.raw;
    if (rule.op === "max" && max > required) return rule.raw;
    if (rule.op === "exact" && max !== required) return rule.raw;
    return null;
  }
  if (rule.type === "same_league_count") {
    const max = Math.max(0, ...countByAttr(squad, "leagueId").values());
    if (rule.op === "min" && max < required) return rule.raw;
    if (rule.op === "max" && max > required) return rule.raw;
    if (rule.op === "exact" && max !== required) return rule.raw;
    return null;
  }
  if (rule.type === "same_club_count") {
    const max = Math.max(0, ...countByAttr(squad, "teamId").values());
    if (rule.op === "min" && max < required) return rule.raw;
    if (rule.op === "max" && max > required) return rule.raw;
    if (rule.op === "exact" && max !== required) return rule.raw;
    return null;
  }
  if (
    rule.type === "nation_id" ||
    rule.type === "league_id" ||
    rule.type === "club_id" ||
    rule.type === "player_level" ||
    rule.type === "player_quality" ||
    rule.type === "player_rarity" ||
    rule.type === "player_rarity_group" ||
    rule.type === "player_rarity_or_totw" ||
    rule.type === "player_tradability" ||
    rule.type === "first_owner_players_count" ||
    rule.type === "player_exact_ovr" ||
    rule.type === "player_inform"
  ) {
    const predicate = rule.predicate || buildPredicate(rule);
    if (!predicate || required == null) return null;
    const count = countMatching(squad, predicate);
    if (rule.op === "min" && count < required) return rule.raw;
    if (rule.op === "max" && count > required) return rule.raw;
    if (rule.op === "exact" && count !== required) return rule.raw;
    return null;
  }
  return null;
};

const computeChemistryEval = (squad, slots, squadSize) => {
  const list = Array.isArray(squad) ? squad : [];
  const slotList = Array.isArray(slots) ? slots : [];
  const n = Math.min(
    toNumber(squadSize) ?? list.length ?? 0,
    list.length,
    slotList.length,
  );
  if (n <= 0) return null;
  return computeBestChemistryAssignment(list.slice(0, n), slotList.slice(0, n));
};

const improveChemistrySmart = (
  squad,
  pool,
  rules,
  squadSize,
  slots,
  targets,
  hardLockedIds,
  debugPush,
  options = {},
) => {
  const slotList = Array.isArray(slots) ? slots : [];
  if (!slotList.length) return false;
  const n = Math.min(toNumber(squadSize) ?? 0, slotList.length, squad.length);
  if (n <= 0) return false;

  const totalTarget = toNumber(targets?.total);
  const minTarget = toNumber(targets?.minEach);
  const checkTotal = totalTarget != null;
  const checkMin = minTarget != null;

  let maxIterations = Math.max(10, toNumber(options?.maxIterations) ?? 60);
  let candidateLimit = Math.max(40, toNumber(options?.maxCandidates) ?? 160);
  let chemistryEscapeDepth = Math.max(
    1,
    toNumber(options?.chemistryEscapeDepth) ?? 3,
  );
  let chemistryEscapeBeamWidth = Math.max(
    8,
    toNumber(options?.chemistryEscapeBeamWidth) ?? 14,
  );
  let chemistryEscapeCandidateLimit = Math.max(
    20,
    toNumber(options?.chemistryEscapeCandidateLimit) ?? 70,
  );
  let chemistryEscapePenaltySlack = Math.max(
    0,
    toNumber(options?.chemistryEscapePenaltySlack) ?? 30,
  );
  const adaptiveNearTarget = options?.adaptiveNearTarget !== false;
  const nearTargetShortfallThreshold = Math.max(
    0,
    toNumber(options?.nearTargetShortfallThreshold) ?? 2,
  );
  const timeBudgetMs = Math.max(0, toNumber(options?.timeBudgetMs) ?? 0);
  const deadlineAt = timeBudgetMs > 0 ? Date.now() + timeBudgetMs : null;
  const isExpired = () => deadlineAt != null && Date.now() >= deadlineAt;

  const requiredInforms = Math.max(0, toNumber(options?.requiredInforms) ?? 0);
  const avoidInforms = options?.avoidInforms !== false && requiredInforms <= 0;
  const preferLowerExcessInforms = options?.preferLowerExcessInforms !== false;
  const ratingTarget = toNumber(options?.ratingTarget) ?? null;
  const pivot =
    toNumber(options?.pivot) ??
    (ratingTarget != null ? Math.max(80, Math.floor(ratingTarget) - 1) : 84);

  const hardLocked = hardLockedIds instanceof Set ? hardLockedIds : new Set();

  const slotPositionSet = new Set(
    slotList
      .slice(0, n)
      .map((slot) => slot?.positionName ?? null)
      .filter(Boolean)
      .map((value) => String(value)),
  );
  const slotPositions = slotList
    .slice(0, n)
    .map((slot) => slot?.positionName ?? null)
    .map((value) => (value == null ? null : String(value)));
  const getPlayerPosNames = (player) => {
    const alt = Array.isArray(player?.alternativePositionNames)
      ? player.alternativePositionNames
      : [];
    if (alt.length) return alt.map((name) => String(name));
    const preferred = player?.preferredPositionName ?? null;
    return preferred == null ? [] : [String(preferred)];
  };

  const computePenalty = (chem) => {
    if (!chem) return Infinity;
    const totalShort = checkTotal
      ? Math.max(0, totalTarget - chem.totalChem)
      : 0;
    const minShort = checkMin ? Math.max(0, minTarget - chem.minChem) : 0;
    // Strongly prioritize satisfying the per-player minimum if present.
    return minShort * 1000 + totalShort * 10;
  };

  const sumPotential = (chem) =>
    (chem?.potentialByPlayer || []).reduce(
      (sum, value) => sum + (toNumber(value) ?? 0),
      0,
    );

  const buildKey = (chem, penalty, preserve) => ({
    penalty: toNumber(penalty) ?? Infinity,
    totalChem: toNumber(chem?.totalChem) ?? 0,
    onPos: toNumber(chem?.onPositionCount) ?? 0,
    potentialSum: sumPotential(chem),
    preserve,
  });

  const isKeyBetter = (candidate, current) => {
    if (!candidate || !current) return false;
    if (candidate.penalty !== current.penalty)
      return candidate.penalty < current.penalty;
    if (candidate.totalChem !== current.totalChem)
      return candidate.totalChem > current.totalChem;
    if (candidate.onPos !== current.onPos)
      return candidate.onPos > current.onPos;
    if (candidate.potentialSum !== current.potentialSum) {
      return candidate.potentialSum > current.potentialSum;
    }
    return isPreservationMetricsBetter(candidate.preserve, current.preserve, {
      preferLowerExcessInforms,
    });
  };
  const compareStateKeys = (a, b) => {
    if (!a && !b) return 0;
    if (!a) return 1;
    if (!b) return -1;
    if (a.penalty !== b.penalty) return a.penalty - b.penalty;
    if (a.totalChem !== b.totalChem) return b.totalChem - a.totalChem;
    if (a.onPos !== b.onPos) return b.onPos - a.onPos;
    if (a.potentialSum !== b.potentialSum) return b.potentialSum - a.potentialSum;
    if (
      isPreservationMetricsBetter(a.preserve, b.preserve, {
        preferLowerExcessInforms,
      })
    ) {
      return -1;
    }
    if (
      isPreservationMetricsBetter(b.preserve, a.preserve, {
        preferLowerExcessInforms,
      })
    ) {
      return 1;
    }
    return 0;
  };
  const buildSquadStateKey = (list) =>
    (list || [])
      .slice(0, n)
      .map((player) => String(player?.id ?? 0))
      .sort()
      .join(",");

  const buildCandidatePool = (workingSquad, currentChem) => {
    const usedIds = new Set(
      (workingSquad || [])
        .map((player) => player?.id)
        .filter((id) => id != null),
    );
    const counts = {
      club: countByAttr(workingSquad, "teamId"),
      league: countByAttr(workingSquad, "leagueId"),
      nation: countByAttr(workingSquad, "nationId"),
    };

    const available = (pool || [])
      .filter((player) => player && player.id != null)
      .filter((player) => !usedIds.has(player.id))
      .filter((player) => (avoidInforms ? !isInformPlayer(player) : true));

    const scoreCandidate = (player, posNames) => {
      const posMatches = posNames.reduce(
        (sum, name) => (slotPositionSet.has(name) ? sum + 1 : sum),
        0,
      );
      const club = counts.club.get(player.teamId) || 0;
      const league = counts.league.get(player.leagueId) || 0;
      const nation = counts.nation.get(player.nationId) || 0;
      const synergy = club + league + nation;
      return { posMatches, synergy };
    };

    const scored = available.map((player) => {
      const posNames = getPlayerPosNames(player);
      const score = scoreCandidate(player, posNames);
      return {
        player,
        posNames,
        posSet: new Set(posNames),
        posMatches: score.posMatches,
        synergy: score.synergy,
      };
    });

    scored.sort((a, b) => {
      if (b.posMatches !== a.posMatches) return b.posMatches - a.posMatches;
      if (b.synergy !== a.synergy) return b.synergy - a.synergy;
      return a.player.rating - b.player.rating;
    });

    const positionCoveragePerSlot = Math.max(
      4,
      toNumber(options?.positionCoveragePerSlot) ?? 10,
    );
    const candidateHardCap = Math.max(
      candidateLimit,
      Math.min(320, slotPositionSet.size * positionCoveragePerSlot),
    );
    const neededPositions = new Set(slotPositionSet);
    if (
      Array.isArray(currentChem?.onPosition) &&
      currentChem.onPosition.length >= n
    ) {
      for (let slotIndex = 0; slotIndex < n; slotIndex += 1) {
        if (currentChem.onPosition[slotIndex]) continue;
        const position = slotPositions[slotIndex];
        if (position) neededPositions.add(position);
      }
    }

    const selectedById = new Map();
    const pushCandidate = (entry) => {
      const id = entry?.player?.id;
      if (id == null || selectedById.has(id)) return false;
      selectedById.set(id, entry.player);
      return true;
    };

    // Ensure every required position gets representation in the candidate set,
    // so chemistry recovery can replace off-position players (e.g., missing GK).
    for (const position of neededPositions) {
      let addedForPosition = 0;
      for (const entry of scored) {
        if (selectedById.size >= candidateHardCap) break;
        if (addedForPosition >= positionCoveragePerSlot) break;
        if (!entry.posSet.has(position)) continue;
        if (pushCandidate(entry)) {
          addedForPosition += 1;
        }
      }
    }

    for (const entry of scored) {
      if (selectedById.size >= candidateHardCap) break;
      pushCandidate(entry);
    }

    return Array.from(selectedById.values());
  };

  let bestChem = computeChemistryEval(squad, slotList, n);
  let bestPenalty = computePenalty(bestChem);
  const initialShortfall = getChemistryShortfall(bestChem, {
    total: totalTarget,
    minEach: minTarget,
  });
  if (
    adaptiveNearTarget &&
    initialShortfall.score > 0 &&
    initialShortfall.score <= nearTargetShortfallThreshold
  ) {
    maxIterations = Math.max(
      maxIterations,
      toNumber(options?.nearTargetMaxIterations) ?? 110,
    );
    candidateLimit = Math.max(
      candidateLimit,
      toNumber(options?.nearTargetMaxCandidates) ?? 240,
    );
    chemistryEscapeDepth = Math.max(
      chemistryEscapeDepth,
      toNumber(options?.nearTargetEscapeDepth) ?? 5,
    );
    chemistryEscapeBeamWidth = Math.max(
      chemistryEscapeBeamWidth,
      toNumber(options?.nearTargetEscapeBeamWidth) ?? 24,
    );
    chemistryEscapeCandidateLimit = Math.max(
      chemistryEscapeCandidateLimit,
      toNumber(options?.nearTargetEscapeCandidateLimit) ?? 140,
    );
    chemistryEscapePenaltySlack = Math.max(
      chemistryEscapePenaltySlack,
      toNumber(options?.nearTargetEscapePenaltySlack) ?? 45,
    );
  }

  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    if (isExpired()) {
      debugPush?.({
        stage: "chemistry",
        action: "budget_exhausted",
        iteration,
        totalChem: bestChem?.totalChem ?? null,
        minChem: bestChem?.minChem ?? null,
        penalty: bestPenalty,
      });
      break;
    }
    if (bestPenalty <= 0 && isChemistrySatisfied(bestChem, targets)) {
      debugPush?.({
        stage: "chemistry",
        action: "done",
        iteration,
        totalTarget: totalTarget ?? null,
        minTarget: minTarget ?? null,
        totalChem: bestChem?.totalChem ?? null,
        minChem: bestChem?.minChem ?? null,
      });
      return true;
    }

    const candidates = buildCandidatePool(squad, bestChem);
    if (!candidates.length) break;

    const currentPreserve = getSquadPreservationMetrics(
      squad.slice(0, n),
      ratingTarget,
      pivot,
      requiredInforms,
    );
    const currentKey = buildKey(bestChem, bestPenalty, currentPreserve);

    const usedDefs = new Set(
      squad
        .slice(0, n)
        .map((player) => getDefinitionKey(player))
        .filter((value) => value != null)
        .map((value) => String(value)),
    );

    let move = null;
    let moveKey = null;
    for (let outIndex = 0; outIndex < n; outIndex += 1) {
      if (isExpired()) break;
      const outPlayer = squad[outIndex];
      if (!outPlayer) continue;
      if (hardLocked.has(outPlayer.id)) continue;

      const outDef = getDefinitionKey(outPlayer);

      for (const inPlayer of candidates) {
        if (isExpired()) break;
        if (!inPlayer) continue;
        if (inPlayer.id === outPlayer.id) continue;

        const inDef = getDefinitionKey(inPlayer);
        if (inDef != null) {
          const key = String(inDef);
          if (key !== String(outDef) && usedDefs.has(key)) continue;
        }

        const nextSquad = squad.slice();
        nextSquad[outIndex] = inPlayer;
        if (!isSquadValid(rules, nextSquad, n)) continue;

        const nextChem = computeChemistryEval(nextSquad, slotList, n);
        const nextPenalty = computePenalty(nextChem);
        if (nextPenalty > bestPenalty) continue;

        const nextPreserve = getSquadPreservationMetrics(
          nextSquad.slice(0, n),
          ratingTarget,
          pivot,
          requiredInforms,
        );
        const nextKey = buildKey(nextChem, nextPenalty, nextPreserve);
        if (!isKeyBetter(nextKey, currentKey)) continue;
        if (!moveKey || isKeyBetter(nextKey, moveKey)) {
          move = {
            outIndex,
            outPlayer,
            inPlayer,
            chem: nextChem,
            penalty: nextPenalty,
            preserve: nextPreserve,
          };
          moveKey = nextKey;
        }
      }
    }

    if (!move) {
      // If chemistry requires crossing count thresholds, a single swap may not help.
      // Try a small two-swap search focused on the lowest-chem contributors.
      const tryDualSwap = () => {
        if (isExpired()) return null;
        const currentChem = bestChem;
        const playerChem = new Array(n).fill(0);
        if (currentChem?.slotToPlayerIndex?.length === n) {
          for (let slotIndex = 0; slotIndex < n; slotIndex += 1) {
            const playerIndex = currentChem.slotToPlayerIndex[slotIndex];
            if (playerIndex == null || playerIndex < 0 || playerIndex >= n)
              continue;
            playerChem[playerIndex] = currentChem.perSlotChem?.[slotIndex] ?? 0;
          }
        }

        const worst = Array.from({ length: n }, (_, idx) => idx)
          .filter((idx) => !hardLocked.has(squad[idx]?.id))
          .sort((a, b) => playerChem[a] - playerChem[b])
          .slice(0, 6);

        const dualCandidates = candidates.slice(
          0,
          Math.min(candidates.length, 60),
        );
        if (worst.length < 2 || dualCandidates.length < 2) return null;

        const baseDefs = new Set(
          squad
            .slice(0, n)
            .map((player) => getDefinitionKey(player))
            .filter((value) => value != null)
            .map((value) => String(value)),
        );

        let best = null;
        for (let x = 0; x < worst.length; x += 1) {
          if (isExpired()) return best;
          for (let y = x + 1; y < worst.length; y += 1) {
            if (isExpired()) return best;
            const outAIndex = worst[x];
            const outBIndex = worst[y];
            const outA = squad[outAIndex];
            const outB = squad[outBIndex];
            if (!outA || !outB) continue;

            const outADef = getDefinitionKey(outA);
            const outBDef = getDefinitionKey(outB);

            for (let a = 0; a < dualCandidates.length; a += 1) {
              if (isExpired()) return best;
              for (let b = a + 1; b < dualCandidates.length; b += 1) {
                if (isExpired()) return best;
                const inA = dualCandidates[a];
                const inB = dualCandidates[b];
                if (!inA || !inB) continue;
                if (inA.id === inB.id) continue;

                const inADef = getDefinitionKey(inA);
                const inBDef = getDefinitionKey(inB);
                if (
                  inADef != null &&
                  inBDef != null &&
                  String(inADef) === String(inBDef)
                ) {
                  continue;
                }

                // Enforce unique definitions (the base squad is already deduped).
                if (
                  inADef != null &&
                  baseDefs.has(String(inADef)) &&
                  String(inADef) !== String(outADef) &&
                  String(inADef) !== String(outBDef)
                ) {
                  continue;
                }
                if (
                  inBDef != null &&
                  baseDefs.has(String(inBDef)) &&
                  String(inBDef) !== String(outADef) &&
                  String(inBDef) !== String(outBDef)
                ) {
                  continue;
                }

                const nextSquad = squad.slice();
                nextSquad[outAIndex] = inA;
                nextSquad[outBIndex] = inB;
                if (!isSquadValid(rules, nextSquad, n)) continue;

                const nextChem = computeChemistryEval(nextSquad, slotList, n);
                const nextPenalty = computePenalty(nextChem);
                if (nextPenalty > bestPenalty) continue;

                const nextPreserve = getSquadPreservationMetrics(
                  nextSquad.slice(0, n),
                  ratingTarget,
                  pivot,
                  requiredInforms,
                );
                const nextKey = buildKey(nextChem, nextPenalty, nextPreserve);
                if (!isKeyBetter(nextKey, currentKey)) continue;

                if (!best || !best.key || isKeyBetter(nextKey, best.key)) {
                  best = {
                    key: nextKey,
                    outAIndex,
                    outBIndex,
                    outA,
                    outB,
                    inA,
                    inB,
                    chem: nextChem,
                    penalty: nextPenalty,
                    preserve: nextPreserve,
                  };
                }
              }
            }
          }
        }

        return best;
      };

      const dual = tryDualSwap();
      if (dual) {
        squad[dual.outAIndex] = dual.inA;
        squad[dual.outBIndex] = dual.inB;
        bestChem = dual.chem;
        bestPenalty = dual.penalty;
        debugPush?.({
          stage: "chemistry",
          action: "swap2",
          iteration,
          outIds: [dual.outA?.id ?? null, dual.outB?.id ?? null],
          inIds: [dual.inA?.id ?? null, dual.inB?.id ?? null],
          totalChem: bestChem?.totalChem ?? null,
          minChem: bestChem?.minChem ?? null,
          penalty: bestPenalty,
        });
        continue;
      }

      const tryChemistryEscape = () => {
        if (isExpired()) return null;
        const baseCandidates = buildCandidatePool(squad, bestChem)
          .slice(0, chemistryEscapeCandidateLimit)
          .filter(Boolean);
        if (!baseCandidates.length) return null;

        const makeNode = (nextSquad, depth) => {
          const chem = computeChemistryEval(nextSquad, slotList, n);
          const penalty = computePenalty(chem);
          const preserve = getSquadPreservationMetrics(
            nextSquad.slice(0, n),
            ratingTarget,
            pivot,
            requiredInforms,
          );
          const key = buildKey(chem, penalty, preserve);
          return {
            squad: nextSquad,
            chem,
            penalty,
            preserve,
            key,
            depth,
          };
        };

        const startNode = {
          squad: squad.slice(),
          chem: bestChem,
          penalty: bestPenalty,
          preserve: currentPreserve,
          key: currentKey,
          depth: 0,
        };
        let beam = [startNode];
        const visited = new Set([buildSquadStateKey(startNode.squad)]);
        let bestFallback = null;

        for (let depth = 0; depth < chemistryEscapeDepth; depth += 1) {
          if (isExpired()) break;
          const nextBeam = [];
          for (const node of beam) {
            if (isExpired()) break;
            const nodeSquad = node.squad;
            const usedIds = new Set(
              nodeSquad
                .slice(0, n)
                .map((player) => player?.id)
                .filter((id) => id != null),
            );
            const usedDefs = new Set(
              nodeSquad
                .slice(0, n)
                .map((player) => getDefinitionKey(player))
                .filter((value) => value != null)
                .map((value) => String(value)),
            );

            for (let outIndex = 0; outIndex < n; outIndex += 1) {
              if (isExpired()) break;
              const outPlayer = nodeSquad[outIndex];
              if (!outPlayer) continue;
              if (hardLocked.has(outPlayer.id)) continue;

              const outDef = getDefinitionKey(outPlayer);

              for (const inPlayer of baseCandidates) {
                if (isExpired()) break;
                if (!inPlayer) continue;
                if (inPlayer.id === outPlayer.id) continue;
                if (usedIds.has(inPlayer.id) && inPlayer.id !== outPlayer.id)
                  continue;

                const inDef = getDefinitionKey(inPlayer);
                if (inDef != null) {
                  const key = String(inDef);
                  if (key !== String(outDef) && usedDefs.has(key)) continue;
                }

                const nextSquad = nodeSquad.slice();
                nextSquad[outIndex] = inPlayer;
                const stateKey = buildSquadStateKey(nextSquad);
                if (visited.has(stateKey)) continue;
                visited.add(stateKey);

                if (!isSquadValid(rules, nextSquad, n)) continue;
                const nextNode = makeNode(nextSquad, depth + 1);
                if (
                  nextNode.penalty >
                  bestPenalty + chemistryEscapePenaltySlack
                ) {
                  continue;
                }

                if (
                  nextNode.penalty <= 0 &&
                  isChemistrySatisfied(nextNode.chem, targets)
                ) {
                  return {
                    solved: true,
                    node: nextNode,
                  };
                }

                if (!bestFallback || isKeyBetter(nextNode.key, bestFallback.key))
                  bestFallback = nextNode;
                nextBeam.push(nextNode);
              }
            }
          }

          if (!nextBeam.length) break;
          nextBeam.sort((a, b) => compareStateKeys(a.key, b.key));
          beam = nextBeam.slice(0, chemistryEscapeBeamWidth);
        }

        if (bestFallback && isKeyBetter(bestFallback.key, currentKey)) {
          return {
            solved: false,
            node: bestFallback,
          };
        }
        return null;
      };
      const escaped = tryChemistryEscape();
      if (escaped?.node) {
        squad.splice(0, squad.length, ...escaped.node.squad);
        bestChem = escaped.node.chem;
        bestPenalty = escaped.node.penalty;
        debugPush?.({
          stage: "chemistry",
          action: escaped.solved ? "escape_solved" : "escape",
          iteration,
          depth: escaped.node.depth,
          totalChem: bestChem?.totalChem ?? null,
          minChem: bestChem?.minChem ?? null,
          penalty: bestPenalty,
        });
        if (escaped.solved) return true;
        continue;
      }

      debugPush?.({
        stage: "chemistry",
        action: "stuck",
        iteration,
        totalTarget: totalTarget ?? null,
        minTarget: minTarget ?? null,
        totalChem: bestChem?.totalChem ?? null,
        minChem: bestChem?.minChem ?? null,
        penalty: bestPenalty,
      });
      break;
    }

    squad[move.outIndex] = move.inPlayer;
    bestChem = move.chem;
    bestPenalty = move.penalty;
    debugPush?.({
      stage: "chemistry",
      action: "swap",
      iteration,
      outId: move.outPlayer?.id ?? null,
      outRating: move.outPlayer?.rating ?? null,
      inId: move.inPlayer?.id ?? null,
      inRating: move.inPlayer?.rating ?? null,
      totalChem: bestChem?.totalChem ?? null,
      minChem: bestChem?.minChem ?? null,
      penalty: bestPenalty,
    });
  }

  return isChemistrySatisfied(bestChem, targets);
};

const extractRequiredPositionSet = (slots, squadSize) => {
  const list = Array.isArray(slots) ? slots : [];
  const n = Math.max(0, toNumber(squadSize) ?? list.length ?? 0);
  const set = new Set();
  for (const slot of list.slice(0, n)) {
    const name = slot?.positionName ?? slot?.position ?? null;
    if (!name) continue;
    set.add(String(name));
  }
  return set;
};

const buildClubStats = (players, requiredPositions, requiredNationIds) => {
  const posSet =
    requiredPositions instanceof Set ? requiredPositions : new Set();
  const nationSet =
    requiredNationIds instanceof Set ? requiredNationIds : new Set();
  const stats = new Map();

  for (const player of players || []) {
    if (!player) continue;
    const clubId = player.teamId ?? null;
    if (clubId == null) continue;

    if (!stats.has(clubId)) {
      stats.set(clubId, {
        clubId,
        count: 0,
        sumRating: 0,
        requiredNationCount: 0,
        positions: new Set(),
      });
    }

    const entry = stats.get(clubId);
    entry.count += 1;
    entry.sumRating += toNumber(player.rating) ?? 0;
    if (nationSet.size && nationSet.has(player.nationId)) {
      entry.requiredNationCount += 1;
    }

    const posNames = Array.isArray(player?.alternativePositionNames)
      ? player.alternativePositionNames
      : player?.preferredPositionName
        ? [player.preferredPositionName]
        : [];
    for (const name of posNames) {
      const normalized = name == null ? null : String(name);
      if (!normalized) continue;
      if (!posSet.size || posSet.has(normalized))
        entry.positions.add(normalized);
    }
  }

  return stats;
};

const getClubCandidateList = (clubStats, options = {}) => {
  const stats = clubStats instanceof Map ? clubStats : new Map();
  const maxCandidates = Math.max(10, toNumber(options?.maxCandidates) ?? 70);
  const includeClubIds = new Set(
    (options?.includeClubIds || []).map(toNumber).filter((v) => v != null),
  );

  const list = Array.from(stats.values()).map((entry) => {
    const avgRating = entry.count ? entry.sumRating / entry.count : 0;
    const posCount = entry.positions?.size ?? 0;
    const requiredNationCount = entry.requiredNationCount ?? 0;
    const count = entry.count ?? 0;

    // Score clubs that:
    // - cover many required positions (avoid off-position chem=0),
    // - have enough players to form a club core,
    // - supply required nations (e.g. Italy min 3),
    // - and are generally low-rated (preservation).
    const score =
      posCount * 3 +
      Math.min(5, count) +
      (count >= 3 ? 3 : count >= 2 ? 1 : 0) +
      Math.min(5, requiredNationCount) * 4 -
      avgRating / 100;

    return {
      clubId: entry.clubId,
      count,
      avgRating,
      posCount,
      requiredNationCount,
      score,
    };
  });

  list.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.requiredNationCount !== a.requiredNationCount) {
      return b.requiredNationCount - a.requiredNationCount;
    }
    if (b.posCount !== a.posCount) return b.posCount - a.posCount;
    if (b.count !== a.count) return b.count - a.count;
    return a.avgRating - b.avgRating;
  });

  const picked = [];
  const seen = new Set();

  for (const clubId of includeClubIds) {
    if (clubId == null) continue;
    if (seen.has(clubId)) continue;
    seen.add(clubId);
    picked.push(clubId);
  }

  for (const item of list) {
    if (!item) continue;
    const clubId = toNumber(item.clubId);
    if (clubId == null) continue;
    if (seen.has(clubId)) continue;
    // Clubs with <2 players are usually bad chemistry anchors and rarely help with max-club constraints.
    if ((toNumber(item.count) ?? 0) < 2) continue;
    seen.add(clubId);
    picked.push(clubId);
    if (picked.length >= maxCandidates) break;
  }

  return picked;
};

const isOnlyChemistryFailing = (failingRequirements) => {
  const failing = Array.isArray(failingRequirements) ? failingRequirements : [];
  for (const rule of failing) {
    const type = rule?.keyNameNormalized ?? rule?.type ?? null;
    if (!type) continue;
    if (type === "chemistry_points" || type === "all_players_chemistry_points")
      continue;
    return false;
  }
  return failing.length > 0;
};

const DEFAULT_RESTART_TIME_BUDGET_MS = 8000;
const WINNING_SEED_CACHE = new Map();

export const getSquadAverageRating = (players) => {
  const list = Array.isArray(players) ? players : [];
  let sum = 0;
  let count = 0;
  for (let i = 0; i < list.length; i += 1) {
    const rating = toNumber(list[i]?.rating);
    if (rating == null) continue;
    sum += rating;
    count += 1;
  }
  return count ? sum / count : 0;
};

export const getSquadAdjustedAverage = (players) => {
  const list = Array.isArray(players) ? players : [];
  let sum = 0;
  let count = 0;
  for (let i = 0; i < list.length; i += 1) {
    const rating = toNumber(list[i]?.rating);
    if (rating == null) continue;
    sum += rating;
    count += 1;
  }
  if (!count) return 0;
  const avg = sum / count;
  let adjustedSum = 0;
  for (let i = 0; i < list.length; i += 1) {
    const rating = toNumber(list[i]?.rating);
    if (rating == null) continue;
    adjustedSum += rating <= avg ? rating : 2 * rating - avg;
  }
  return adjustedSum / count;
};

export const getSquadRating = (players) => {
  const adjustedAverage = getSquadAdjustedAverage(players);
  const roundedAverage = roundTo(adjustedAverage, ROUND_DECIMALS);
  const decimal = roundedAverage - Math.floor(roundedAverage);
  const scaledDecimal = roundTo(decimal * 100, 2);
  const base = Math.floor(roundedAverage);
  if (scaledDecimal >= ROUND_THRESHOLD * 100) return base + 1;
  return base;
};

const buildCountsMap = (players, attr) => {
  const map = new Map();
  for (const player of players || []) {
    const value = player?.[attr];
    if (value == null) continue;
    map.set(value, (map.get(value) || 0) + 1);
  }
  return map;
};

const getDominantCountEntry = (players, attr) => {
  const counts = buildCountsMap(players, attr);
  let value = null;
  let count = 0;
  for (const [nextValue, nextCount] of counts.entries()) {
    if (nextCount > count) {
      value = nextValue;
      count = nextCount;
    }
  }
  return { value, count, counts };
};

const isRareNonSpecialPlayer = (player) => {
  if (!player || player.isSpecial) return false;
  const rarity = normalizeString(player?.rarityName);
  if (rarity?.includes("rare")) return true;
  const rarityId = toNumber(player?.rarityId);
  return rarityId != null ? rarityId >= 1 : false;
};

const buildCompositionSnapshot = (players, squadSize = null) => {
  const list = Array.isArray(players) ? players : [];
  const n = Math.max(0, toNumber(squadSize) ?? list.length);
  const squad = list.slice(0, n || list.length);
  const leagues = getDominantCountEntry(squad, "leagueId");
  const nations = getDominantCountEntry(squad, "nationId");
  const clubs = getDominantCountEntry(squad, "teamId");
  return {
    size: squad.length,
    uniqueLeagues: leagues.counts.size,
    uniqueNations: nations.counts.size,
    uniqueClubs: clubs.counts.size,
    dominantLeague: leagues.value,
    dominantLeagueCount: leagues.count,
    dominantNation: nations.value,
    dominantNationCount: nations.count,
    dominantClub: clubs.value,
    dominantClubCount: clubs.count,
    specialCount: squad.filter((player) => Boolean(player?.isSpecial)).length,
    rareCount: squad.filter((player) => isRareNonSpecialPlayer(player)).length,
  };
};

const buildChallengeSignature = (rules, squadSize) => {
  const list = Array.isArray(rules) ? rules : [];
  const chemistryTargets = getChemistryRequirementTargets(list, squadSize);
  const ratingRequirement = getTeamRatingTarget(list);
  const signature = {
    hasChemistry:
      chemistryTargets?.total != null || chemistryTargets?.minEach != null,
    totalChemistryTarget: chemistryTargets?.total ?? null,
    minPlayerChemistryTarget: chemistryTargets?.minEach ?? null,
    ratingTarget: ratingRequirement?.target ?? null,
    hasSameLeagueMin: false,
    hasSameNationMin: false,
    hasSameClubMin: false,
    sameLeagueMin: null,
    sameNationMin: null,
    sameClubMin: null,
    sameLeagueMax: null,
    sameNationMax: null,
    sameClubMax: null,
    requiredLeagueIds: [],
    requiredNationIds: [],
    requiredClubIds: [],
    hasRareRequirement: false,
    rareTarget: null,
    hasInformRequirement: false,
    isCompositionPuzzle: false,
    dominantAxes: [],
  };
  const requiredLeagueIds = new Set();
  const requiredNationIds = new Set();
  const requiredClubIds = new Set();
  for (const rule of list) {
    if (!rule) continue;
    const required = getRuleCount(rule, squadSize);
    if (rule.type === "same_league_count") {
      if (rule.op === "min" || rule.op === "exact") {
        signature.hasSameLeagueMin = true;
        if (required != null) {
          signature.sameLeagueMin = Math.max(signature.sameLeagueMin ?? 0, required);
        }
      }
      if ((rule.op === "max" || rule.op === "exact") && required != null) {
        signature.sameLeagueMax =
          signature.sameLeagueMax == null
            ? required
            : Math.min(signature.sameLeagueMax, required);
      }
      continue;
    }
    if (rule.type === "same_nation_count") {
      if (rule.op === "min" || rule.op === "exact") {
        signature.hasSameNationMin = true;
        if (required != null) {
          signature.sameNationMin = Math.max(signature.sameNationMin ?? 0, required);
        }
      }
      if ((rule.op === "max" || rule.op === "exact") && required != null) {
        signature.sameNationMax =
          signature.sameNationMax == null
            ? required
            : Math.min(signature.sameNationMax, required);
      }
      continue;
    }
    if (rule.type === "same_club_count") {
      if (rule.op === "min" || rule.op === "exact") {
        signature.hasSameClubMin = true;
        if (required != null) {
          signature.sameClubMin = Math.max(signature.sameClubMin ?? 0, required);
        }
      }
      if ((rule.op === "max" || rule.op === "exact") && required != null) {
        signature.sameClubMax =
          signature.sameClubMax == null
            ? required
            : Math.min(signature.sameClubMax, required);
      }
      continue;
    }
    if (rule.type === "league_id" && (rule.op === "min" || rule.op === "exact")) {
      for (const value of rule.values || []) {
        const numeric = toNumber(value);
        if (numeric != null) requiredLeagueIds.add(numeric);
      }
      continue;
    }
    if (rule.type === "nation_id" && (rule.op === "min" || rule.op === "exact")) {
      for (const value of rule.values || []) {
        const numeric = toNumber(value);
        if (numeric != null) requiredNationIds.add(numeric);
      }
      continue;
    }
    if (rule.type === "club_id" && (rule.op === "min" || rule.op === "exact")) {
      for (const value of rule.values || []) {
        const numeric = toNumber(value);
        if (numeric != null) requiredClubIds.add(numeric);
      }
      continue;
    }
    if (
      rule.type === "player_rarity" ||
      rule.type === "player_rarity_group" ||
      rule.type === "player_rarity_or_totw"
    ) {
      signature.hasRareRequirement = true;
      if (required != null) {
        signature.rareTarget = Math.max(signature.rareTarget ?? 0, required);
      }
      continue;
    }
    if (rule.type === "player_inform") {
      signature.hasInformRequirement = true;
    }
  }
  signature.requiredLeagueIds = Array.from(requiredLeagueIds);
  signature.requiredNationIds = Array.from(requiredNationIds);
  signature.requiredClubIds = Array.from(requiredClubIds);
  if (signature.hasSameLeagueMin || signature.requiredLeagueIds.length) {
    signature.dominantAxes.push("league");
  }
  if (signature.hasSameNationMin || signature.requiredNationIds.length) {
    signature.dominantAxes.push("nation");
  }
  if (signature.hasSameClubMin || signature.requiredClubIds.length) {
    signature.dominantAxes.push("club");
  }
  signature.isCompositionPuzzle = Boolean(
    signature.hasChemistry &&
      (
        signature.hasSameLeagueMin ||
        signature.hasSameNationMin ||
        signature.hasSameClubMin ||
        signature.requiredLeagueIds.length ||
        signature.requiredNationIds.length ||
        signature.requiredClubIds.length ||
        signature.sameClubMax != null ||
        signature.sameLeagueMax != null ||
        signature.sameNationMax != null ||
        (signature.totalChemistryTarget != null &&
          signature.totalChemistryTarget >=
            Math.max(22, Math.floor((toNumber(squadSize) ?? 11) * 2)))
      ),
  );
  signature.fingerprint = JSON.stringify({
    chemistry: [
      signature.totalChemistryTarget,
      signature.minPlayerChemistryTarget,
    ],
    ratingTarget: signature.ratingTarget,
    sameLeagueMin: signature.sameLeagueMin,
    sameNationMin: signature.sameNationMin,
    sameClubMin: signature.sameClubMin,
    sameLeagueMax: signature.sameLeagueMax,
    sameNationMax: signature.sameNationMax,
    sameClubMax: signature.sameClubMax,
    requiredLeagueIds: signature.requiredLeagueIds.slice().sort((a, b) => a - b),
    requiredNationIds: signature.requiredNationIds.slice().sort((a, b) => a - b),
    requiredClubIds: signature.requiredClubIds.slice().sort((a, b) => a - b),
    hasRareRequirement: signature.hasRareRequirement,
    rareTarget: signature.rareTarget,
    hasInformRequirement: signature.hasInformRequirement,
    dominantAxes: signature.dominantAxes,
  });
  return signature;
};

const getBaselinePhaseConfig = (baseConfig = {}) => {
  const base = baseConfig && typeof baseConfig === "object" ? baseConfig : {};
  return {
    id: "baseline",
    optimize: {
      ...base,
      refineBalancedReshape: false,
    },
  };
};

const getPhaseConfig = (signature, baseConfig = {}) => {
  const base = baseConfig && typeof baseConfig === "object" ? baseConfig : {};
  if (!signature?.isCompositionPuzzle) {
    return {
      id: "default",
      optimize: {
        ...base,
        refineSolvedSquad: false,
        refineBalancedReshape: false,
      },
    };
  }
  return {
    id: "composition",
    optimize: {
      ...base,
      preserveHighCards: false,
      preserveMaxIterations: Math.min(
        toNumber(base.preserveMaxIterations) ?? 30,
        0,
      ),
      chemMaxIterations: Math.max(toNumber(base.chemMaxIterations) ?? 60, 75),
      chemExtendedMaxIterations: Math.max(
        toNumber(base.chemExtendedMaxIterations) ?? 120,
        140,
      ),
      chemEscapeDepth: Math.max(toNumber(base.chemEscapeDepth) ?? 3, 4),
      chemTimeBudgetMs: Math.max(toNumber(base.chemTimeBudgetMs) ?? 0, 1500),
      chemExtendedShortfallThreshold: Math.max(
        toNumber(base.chemExtendedShortfallThreshold) ?? 2,
        4,
      ),
      refineSolvedSquad: false,
      refineBalancedReshape: false,
    },
  };
};

const buildSeedKey = (seed) =>
  JSON.stringify({
    type: seed?.type ?? "baseline",
    axis: seed?.axis ?? null,
    groupId: seed?.groupId ?? null,
    tier: seed?.tier ?? 0,
    filter: Boolean(seed?.poolFilter),
  });

const createSeedDescriptor = ({
  type = "baseline",
  axis = null,
  groupId = null,
  label = "Baseline",
  strength = 3,
  poolFilter = null,
  tier = 0,
}) => {
  const attr = axis ? AXIS_TO_ATTR[axis] ?? null : null;
  const biasMagnitude = Math.max(1, toNumber(strength) ?? 3) * 100;
  return {
    type,
    axis,
    groupId,
    label,
    tier,
    poolBias:
      attr && groupId != null
        ? (player) =>
            String(player?.[attr] ?? "") === String(groupId)
              ? -biasMagnitude
              : 0
        : null,
    prefillBias:
      attr && groupId != null
        ? { axis, groupId, strength: Math.max(1, toNumber(strength) ?? 3) }
        : null,
    poolFilter: typeof poolFilter === "function" ? poolFilter : null,
  };
};

const dedupeSeeds = (seeds) => {
  const seen = new Set();
  const list = [];
  for (const seed of seeds || []) {
    const key = buildSeedKey(seed);
    if (seen.has(key)) continue;
    seen.add(key);
    list.push(seed);
  }
  return list;
};

const scoreGroupSeed = (
  players,
  axis,
  groupId,
  signature,
  context,
  squadSize,
  mode = "default",
) => {
  const attr = AXIS_TO_ATTR[axis] ?? null;
  if (!attr || groupId == null) return null;
  const groupPlayers = (players || []).filter(
    (player) => String(player?.[attr] ?? "") === String(groupId),
  );
  if (!groupPlayers.length) return null;
  const positions = new Set();
  const requiredPositions = extractRequiredPositionSet(context?.squadSlots, squadSize);
  for (const player of groupPlayers) {
    const posNames = Array.isArray(player?.alternativePositionNames)
      ? player.alternativePositionNames
      : player?.preferredPositionName
        ? [player.preferredPositionName]
        : [];
    for (const name of posNames) {
      const normalized = name == null ? null : String(name);
      if (!normalized) continue;
      if (!requiredPositions.size || requiredPositions.has(normalized)) {
        positions.add(normalized);
      }
    }
  }
  const clubs = buildCountsMap(groupPlayers, "teamId").size;
  const rareCount = groupPlayers.filter((player) => isRareNonSpecialPlayer(player)).length;
  const avgRating = computeAverage(groupPlayers.map((player) => player?.rating));
  const requiredMatch =
    axis === "league"
      ? signature?.requiredLeagueIds?.includes?.(toNumber(groupId)) ?? false
      : axis === "nation"
        ? signature?.requiredNationIds?.includes?.(toNumber(groupId)) ?? false
        : signature?.requiredClubIds?.includes?.(toNumber(groupId)) ?? false;
  const defaultScore =
    groupPlayers.length * 12 +
    positions.size * 7 +
    rareCount * 2 +
    clubs * (axis === "club" ? 0 : 2) +
    (requiredMatch ? 30 : 0) -
    avgRating;
  const chemistryTarget = toNumber(signature?.totalChemistryTarget) ?? 0;
  const ratingTarget = toNumber(signature?.ratingTarget) ?? 0;
  const chemistryRatingScore =
    groupPlayers.length * 6 +
    positions.size * 9 +
    rareCount * 2 +
    clubs * (axis === "club" ? 0 : 2) +
    avgRating * 4 +
    chemistryTarget * 2 +
    ratingTarget * 3 +
    (requiredMatch ? 30 : 0);
  const cappedCount = Math.min(groupPlayers.length, Math.max(6, toNumber(squadSize) ?? 11));
  const ratingHeavyScore =
    cappedCount * 8 +
    positions.size * 15 +
    rareCount * 2 +
    clubs * (axis === "club" ? 0 : 2) +
    avgRating * 25 +
    chemistryTarget * 2 +
    ratingTarget * 4 +
    (requiredMatch ? 30 : 0);
  const score =
    mode === "chemistry_rating"
      ? chemistryRatingScore
      : mode === "rating_heavy"
        ? ratingHeavyScore
        : defaultScore;
  return { axis, groupId, score };
};

const generateBaselineSeeds = (signature, players, squadSize, context) => {
  const baselineSeed = createSeedDescriptor({
    type: "baseline",
    label: "Baseline",
  });
  const hasUsefulSeedSignals = Boolean(
    (signature?.requiredLeagueIds || []).length ||
      (signature?.requiredNationIds || []).length ||
      (signature?.requiredClubIds || []).length ||
      signature?.hasSameLeagueMin ||
      signature?.hasSameNationMin ||
      signature?.hasSameClubMin ||
      signature?.sameLeagueMax != null ||
      signature?.sameNationMax != null ||
      signature?.sameClubMax != null ||
      (signature?.dominantAxes || []).length,
  );
  if (!hasUsefulSeedSignals) return [baselineSeed];
  const requiredSeeds = [];
  const exploratorySeeds = [];
  const chemistryExplorationWanted = Boolean(
    signature?.hasChemistry &&
      (
        (toNumber(signature?.totalChemistryTarget) ?? 0) >=
          Math.max(22, Math.floor((toNumber(squadSize) ?? 11) * 2)) ||
        signature?.sameLeagueMax != null ||
        signature?.sameNationMax != null ||
        signature?.sameClubMax != null ||
        toNumber(signature?.ratingTarget) >= 74
      ),
  );
  const ratingExplorationWanted = Boolean(
    signature?.hasChemistry &&
      (toNumber(signature?.ratingTarget) ?? 0) >= 74,
  );
  for (const groupId of signature.requiredLeagueIds || []) {
    requiredSeeds.push(
      createSeedDescriptor({
        type: "required_identity",
        axis: "league",
        groupId,
        label: `Required league ${groupId}`,
        strength: 5,
      }),
    );
  }
  for (const groupId of signature.requiredNationIds || []) {
    requiredSeeds.push(
      createSeedDescriptor({
        type: "required_identity",
        axis: "nation",
        groupId,
        label: `Required nation ${groupId}`,
        strength: 5,
      }),
    );
  }
  for (const groupId of signature.requiredClubIds || []) {
    requiredSeeds.push(
      createSeedDescriptor({
        type: "required_identity",
        axis: "club",
        groupId,
        label: `Required club ${groupId}`,
        strength: 5,
      }),
    );
  }
  if (
    signature?.hasSameLeagueMin ||
    (signature?.requiredLeagueIds || []).length ||
    (signature?.dominantAxes || []).includes("league") ||
    chemistryExplorationWanted
  ) {
    const defaultLeagueSeedCount =
      chemistryExplorationWanted || ratingExplorationWanted ? 1 : 2;
    const leagues = Array.from(buildCountsMap(players, "leagueId").keys())
      .map((groupId) =>
        scoreGroupSeed(players, "league", groupId, signature, context, squadSize),
      )
      .filter(Boolean)
      .sort((a, b) => b.score - a.score)
      .slice(0, defaultLeagueSeedCount);
    for (const entry of leagues) {
      exploratorySeeds.push(
        createSeedDescriptor({
          type: "dominant_league",
          axis: "league",
          groupId: entry.groupId,
          label: `League ${entry.groupId}`,
          strength: 4,
        }),
      );
    }
    if (chemistryExplorationWanted) {
      const chemistryLeague = Array.from(buildCountsMap(players, "leagueId").keys())
        .map((groupId) =>
          scoreGroupSeed(
            players,
            "league",
            groupId,
            signature,
            context,
            squadSize,
            "chemistry_rating",
          ),
        )
        .filter(Boolean)
        .sort((a, b) => b.score - a.score)
        .slice(0, 1);
      for (const entry of chemistryLeague) {
        exploratorySeeds.push(
          createSeedDescriptor({
            type: "chemistry_league",
            axis: "league",
            groupId: entry.groupId,
            label: `Chem league ${entry.groupId}`,
            strength: 5,
          }),
        );
      }
    }
    if (ratingExplorationWanted) {
      const ratingLeague = Array.from(buildCountsMap(players, "leagueId").keys())
        .map((groupId) =>
          scoreGroupSeed(
            players,
            "league",
            groupId,
            signature,
            context,
            squadSize,
            "rating_heavy",
          ),
        )
        .filter(Boolean)
        .sort((a, b) => b.score - a.score)
        .slice(0, 1);
      for (const entry of ratingLeague) {
        exploratorySeeds.push(
          createSeedDescriptor({
            type: "rating_league",
            axis: "league",
            groupId: entry.groupId,
            label: `Rating league ${entry.groupId}`,
            strength: 5,
          }),
        );
      }
    }
  }
  if (
    signature?.hasSameNationMin ||
    (signature?.requiredNationIds || []).length ||
    (signature?.dominantAxes || []).includes("nation") ||
    chemistryExplorationWanted
  ) {
    const defaultNationSeedCount =
      chemistryExplorationWanted || ratingExplorationWanted ? 1 : 2;
    const nations = Array.from(buildCountsMap(players, "nationId").keys())
      .map((groupId) =>
        scoreGroupSeed(players, "nation", groupId, signature, context, squadSize),
      )
      .filter(Boolean)
      .sort((a, b) => b.score - a.score)
      .slice(0, defaultNationSeedCount);
    for (const entry of nations) {
      exploratorySeeds.push(
        createSeedDescriptor({
          type: "dominant_nation",
          axis: "nation",
          groupId: entry.groupId,
          label: `Nation ${entry.groupId}`,
          strength: 4,
        }),
      );
    }
    if (chemistryExplorationWanted) {
      const chemistryNation = Array.from(buildCountsMap(players, "nationId").keys())
        .map((groupId) =>
          scoreGroupSeed(
            players,
            "nation",
            groupId,
            signature,
            context,
            squadSize,
            "chemistry_rating",
          ),
        )
        .filter(Boolean)
        .sort((a, b) => b.score - a.score)
        .slice(0, 1);
      for (const entry of chemistryNation) {
        exploratorySeeds.push(
          createSeedDescriptor({
            type: "chemistry_nation",
            axis: "nation",
            groupId: entry.groupId,
            label: `Chem nation ${entry.groupId}`,
            strength: 5,
          }),
        );
      }
    }
    if (ratingExplorationWanted) {
      const ratingNation = Array.from(buildCountsMap(players, "nationId").keys())
        .map((groupId) =>
          scoreGroupSeed(
            players,
            "nation",
            groupId,
            signature,
            context,
            squadSize,
            "rating_heavy",
          ),
        )
        .filter(Boolean)
        .sort((a, b) => b.score - a.score)
        .slice(0, 1);
      for (const entry of ratingNation) {
        exploratorySeeds.push(
          createSeedDescriptor({
            type: "rating_nation",
            axis: "nation",
            groupId: entry.groupId,
            label: `Rating nation ${entry.groupId}`,
            strength: 5,
          }),
        );
      }
    }
  }
  return dedupeSeeds([baselineSeed, ...requiredSeeds, ...exploratorySeeds]).slice(
    0,
    chemistryExplorationWanted || ratingExplorationWanted ? 8 : 4,
  );
};

const buildFiltersFingerprint = (filters = {}) =>
  JSON.stringify({
    excludeSpecial: toBooleanSetting(filters?.excludeSpecial, false),
    useTotwPlayers: toBooleanSetting(filters?.useTotwPlayers, true),
    useEvolutionPlayers: toBooleanSetting(filters?.useEvolutionPlayers, false),
    onlyStorage: toBooleanSetting(filters?.onlyStorage, false),
    onlyUntradeables: toBooleanSetting(filters?.onlyUntradeables, false),
    onlyDuplicates: toBooleanSetting(filters?.onlyDuplicates, false),
    ratingMin: toNumber(filters?.ratingMin) ?? null,
    ratingMax: toNumber(filters?.ratingMax) ?? null,
    excludedLeagueIds: (filters?.excludedLeagueIds || []).map(String).sort(),
    excludedNationIds: (filters?.excludedNationIds || []).map(String).sort(),
  });

const buildWinningSeedCacheKey = (context, signature) =>
  JSON.stringify({
    signature: signature?.fingerprint ?? null,
    revision:
      toNumber(context?._cacheRevision) ??
      toNumber(context?.snapshotRevision) ??
      null,
    filters: buildFiltersFingerprint(context?.filters || {}),
  });

const summarizeFailure = (result, seed, signature, phaseConfig) => {
  const failingRequirements = Array.isArray(result?.failingRequirements)
    ? result.failingRequirements
    : [];
  const chemistryShortfall =
    result?.stats?.chemistryTargets?.total != null ||
    result?.stats?.chemistryTargets?.minEach != null
      ? getChemistryShortfall(
          {
            totalChem: toNumber(result?.stats?.chemistry?.totalChem) ?? 0,
            minChem: toNumber(result?.stats?.chemistry?.minChem) ?? 0,
          },
          result?.stats?.chemistryTargets,
        )
      : { score: Infinity };
  const snapshot = result?.compositionSnapshot ?? {
    uniqueLeagues: Infinity,
    uniqueNations: Infinity,
    uniqueClubs: Infinity,
    dominantLeague: null,
    dominantLeagueCount: 0,
    dominantNation: null,
    dominantNationCount: 0,
    dominantClub: null,
    dominantClubCount: 0,
    specialCount: 0,
    rareCount: 0,
  };
  return {
    seedType: seed?.type ?? "baseline",
    axis: seed?.axis ?? null,
    groupId: seed?.groupId ?? null,
    rating: toNumber(result?.stats?.squadRating) ?? null,
    totalChem: toNumber(result?.stats?.chemistry?.totalChem) ?? null,
    chemShortfall: toNumber(chemistryShortfall?.score) ?? Infinity,
    failingTypes: Array.from(
      new Set(
        failingRequirements
          .map((entry) => normalizeRequirementType(entry))
          .filter(Boolean),
      ),
    ),
    uniqueLeagues: snapshot.uniqueLeagues,
    uniqueNations: snapshot.uniqueNations,
    uniqueClubs: snapshot.uniqueClubs,
    dominantLeague: snapshot.dominantLeague,
    dominantLeagueCount: snapshot.dominantLeagueCount,
    dominantNation: snapshot.dominantNation,
    dominantNationCount: snapshot.dominantNationCount,
    dominantClub: snapshot.dominantClub,
    dominantClubCount: snapshot.dominantClubCount,
    specialCount: snapshot.specialCount,
    rareCount: snapshot.rareCount,
    phaseConfigId: phaseConfig?.id ?? null,
  };
};

const compareFailureSummaries = (a, b) => {
  const hardFailA = a?.failingTypes?.length ?? Infinity;
  const hardFailB = b?.failingTypes?.length ?? Infinity;
  if (hardFailA !== hardFailB) return hardFailA - hardFailB;
  const chemA = toNumber(a?.chemShortfall) ?? Infinity;
  const chemB = toNumber(b?.chemShortfall) ?? Infinity;
  if (chemA !== chemB) return chemA - chemB;
  const spreadA =
    (toNumber(a?.uniqueLeagues) ?? 99) +
    (toNumber(a?.uniqueNations) ?? 99) +
    (toNumber(a?.uniqueClubs) ?? 99);
  const spreadB =
    (toNumber(b?.uniqueLeagues) ?? 99) +
    (toNumber(b?.uniqueNations) ?? 99) +
    (toNumber(b?.uniqueClubs) ?? 99);
  if (spreadA !== spreadB) return spreadA - spreadB;
  return 0;
};

const compareSolverResults = (a, b) => {
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  const solvedA = Boolean(a?.stats?.solved);
  const solvedB = Boolean(b?.stats?.solved);
  if (solvedA !== solvedB) return solvedA ? -1 : 1;
  if (solvedA && solvedB) {
    const valueA =
      a?.stats?.solvedValue ??
      a?.stats?.refinement?.after ??
      a?.stats?.refinement?.before ??
      null;
    const valueB =
      b?.stats?.solvedValue ??
      b?.stats?.refinement?.after ??
      b?.stats?.refinement?.before ??
      null;
    if (valueA && valueB) {
      if (isSolvedSquadValueBetter(valueA, valueB)) return -1;
      if (isSolvedSquadValueBetter(valueB, valueA)) return 1;
    }
  }
  return compareFailureSummaries(
    summarizeFailure(a, a?.seed, a?.signature, a?.phaseConfig),
    summarizeFailure(b, b?.seed, b?.signature, b?.phaseConfig),
  );
};

const generateRescueSeeds = (
  signature,
  failureMemory,
  players,
  squadSize,
  context,
  triedSeedKeys = new Set(),
) => {
  const sortedFailures = (failureMemory || []).slice().sort(compareFailureSummaries);
  const bestFailure = sortedFailures[0] ?? null;
  if (!bestFailure) return { tier1: [], tier3: [] };
  const tier1 = [];
  const tier3 = [];
  const pushSeed = (list, seed) => {
    if (!seed) return;
    const key = buildSeedKey(seed);
    if (triedSeedKeys.has(key)) return;
    triedSeedKeys.add(key);
    list.push(seed);
  };
  if (
    bestFailure.dominantLeague != null &&
    toNumber(bestFailure.dominantLeagueCount) >=
      Math.max(3, Math.floor((squadSize || 11) / 3))
  ) {
    pushSeed(
      tier1,
      createSeedDescriptor({
        type: "rescue_full_dominant_league",
        axis: "league",
        groupId: bestFailure.dominantLeague,
        label: `Rescue league ${bestFailure.dominantLeague}`,
        strength: 6,
        tier: 1,
      }),
    );
    pushSeed(
      tier3,
      createSeedDescriptor({
        type: "rescue_full_dominant_league",
        axis: "league",
        groupId: bestFailure.dominantLeague,
        label: `Rescue hard league ${bestFailure.dominantLeague}`,
        strength: 7,
        tier: 3,
        poolFilter: (player) =>
          String(player?.leagueId ?? "") === String(bestFailure.dominantLeague),
      }),
    );
  }
  if (
    bestFailure.dominantNation != null &&
    toNumber(bestFailure.dominantNationCount) >=
      Math.max(3, Math.floor((squadSize || 11) / 3))
  ) {
    pushSeed(
      tier1,
      createSeedDescriptor({
        type: "rescue_full_dominant_nation",
        axis: "nation",
        groupId: bestFailure.dominantNation,
        label: `Rescue nation ${bestFailure.dominantNation}`,
        strength: 6,
        tier: 1,
      }),
    );
  }
  for (const groupId of signature?.requiredLeagueIds || []) {
    pushSeed(
      tier1,
      createSeedDescriptor({
        type: "rescue_required_identity_not_tried",
        axis: "league",
        groupId,
        label: `Rescue required league ${groupId}`,
        strength: 6,
        tier: 1,
      }),
    );
  }
  return { tier1: dedupeSeeds(tier1), tier3: dedupeSeeds(tier3) };
};

const compareSolverResult = (validSquad, solverResult) => ({
  chemistryDelta:
    (toNumber(computeChemistryEval(validSquad || [], [], validSquad?.length ?? 0)?.totalChem) ?? 0) -
    (toNumber(solverResult?.stats?.chemistry?.totalChem) ?? 0),
  ratingDelta:
    (toNumber(getSquadRating(validSquad || [])) ?? 0) -
    (toNumber(solverResult?.stats?.squadRating) ?? 0),
  validSnapshot: buildCompositionSnapshot(validSquad || []),
  solverSnapshot: solverResult?.compositionSnapshot ?? null,
  failingRequirements: solverResult?.failingRequirements ?? [],
});

const attachOrchestrationSummary = (
  result,
  orchestration,
  restartTimeBudgetMs,
  timedOut = false,
) => {
  if (!result || typeof result !== "object") return result;
  const stats = result?.stats ?? {};
  const debugEnabled = Boolean(stats?.debugEnabled);
  const existingDebugLog = Array.isArray(stats?.debugLog) ? stats.debugLog : [];
  const debugLog = debugEnabled
    ? existingDebugLog.concat([
        {
          stage: "orchestration",
          action: "summary",
          restartTimeBudgetMs,
          timedOut,
          baselineSeedCount: orchestration?.baselineSeeds?.length ?? 0,
          rescueSeedCount: orchestration?.rescueSeeds?.length ?? 0,
          winningSeed: orchestration?.winningSeed ?? null,
          perSeed: orchestration?.perSeed ?? [],
        },
      ])
    : existingDebugLog;
  return {
    ...result,
    stats: {
      ...stats,
      debugLog,
      orchestration,
    },
  };
};

const tryChemistryAnchorRewrite = (
  squad,
  pool,
  rules,
  squadSize,
  slots,
  targets,
  hardLockedIds,
  signature,
  debugPush,
  options = {},
) => {
  const slotList = Array.isArray(slots) ? slots : [];
  const n = Math.min(toNumber(squadSize) ?? 0, slotList.length, squad.length);
  if (n <= 0) return { changed: false };
  const baseChem = computeChemistryEval(squad, slotList, n);
  if (!baseChem || isChemistrySatisfied(baseChem, targets)) {
    return { changed: false };
  }
  const hardLocked = hardLockedIds instanceof Set ? hardLockedIds : new Set();
  const playerChem = new Array(n).fill(0);
  if (Array.isArray(baseChem.slotToPlayerIndex)) {
    for (let slotIndex = 0; slotIndex < Math.min(n, baseChem.slotToPlayerIndex.length); slotIndex += 1) {
      const playerIndex = baseChem.slotToPlayerIndex[slotIndex];
      if (playerIndex == null || playerIndex < 0 || playerIndex >= n) continue;
      playerChem[playerIndex] = baseChem.perSlotChem?.[slotIndex] ?? 0;
    }
  }
  const worstIndices = Array.from({ length: n }, (_, index) => index)
    .filter((index) => !hardLocked.has(squad[index]?.id))
    .sort((a, b) => playerChem[a] - playerChem[b]);
  if (!worstIndices.length) return { changed: false };
  const dominantLeague = getDominantCountEntry(squad.slice(0, n), "leagueId");
  const dominantNation = getDominantCountEntry(squad.slice(0, n), "nationId");
  const anchors = [];
  for (const groupId of signature?.requiredLeagueIds || []) {
    anchors.push({ axis: "league", groupId });
  }
  for (const groupId of signature?.requiredNationIds || []) {
    anchors.push({ axis: "nation", groupId });
  }
  if (dominantLeague.value != null) {
    anchors.push({ axis: "league", groupId: dominantLeague.value });
  }
  if (dominantNation.value != null) {
    anchors.push({ axis: "nation", groupId: dominantNation.value });
  }
  const seenAnchors = new Set();
  const uniqueAnchors = anchors.filter((entry) => {
    const key = `${entry.axis}:${entry.groupId}`;
    if (seenAnchors.has(key)) return false;
    seenAnchors.add(key);
    return true;
  });
  const rewriteSizes = Array.isArray(options?.rewriteSizes)
    ? options.rewriteSizes
    : [3, 4, 5];
  const currentShortfall = getChemistryShortfall(baseChem, targets);
  let best = null;
  for (const anchor of uniqueAnchors) {
    const attr = AXIS_TO_ATTR[anchor.axis] ?? null;
    if (!attr) continue;
    const candidates = (pool || [])
      .filter((player) => player && player.id != null)
      .filter((player) => String(player?.[attr] ?? "") === String(anchor.groupId))
      .sort((a, b) => a.rating - b.rating);
    if (!candidates.length) continue;
    for (const size of rewriteSizes) {
      const replaceIndices = worstIndices.slice(0, Math.min(worstIndices.length, size));
      if (!replaceIndices.length) continue;
      const nextSquad = squad.slice();
      const usedIds = new Set(
        nextSquad.map((player) => player?.id).filter((id) => id != null),
      );
      const usedDefs = new Set(
        nextSquad
          .map((player) => getDefinitionKey(player))
          .filter((value) => value != null)
          .map((value) => String(value)),
      );
      for (const index of replaceIndices) {
        usedIds.delete(nextSquad[index]?.id);
        const previousDef = getDefinitionKey(nextSquad[index]);
        if (previousDef != null) usedDefs.delete(String(previousDef));
      }
      let replaced = 0;
      for (const index of replaceIndices) {
        const replacement = candidates.find((candidate) => {
          if (!candidate || candidate.id == null) return false;
          if (usedIds.has(candidate.id)) return false;
          const defKey = getDefinitionKey(candidate);
          if (defKey != null && usedDefs.has(String(defKey))) return false;
          const trial = nextSquad.slice();
          trial[index] = candidate;
          return isSquadValid(rules, trial, n);
        });
        if (!replacement) break;
        nextSquad[index] = replacement;
        usedIds.add(replacement.id);
        const defKey = getDefinitionKey(replacement);
        if (defKey != null) usedDefs.add(String(defKey));
        replaced += 1;
      }
      if (replaced !== replaceIndices.length) continue;
      if (!isSquadValid(rules, nextSquad, n)) continue;
      const nextChem = computeChemistryEval(nextSquad, slotList, n);
      const nextShortfall = getChemistryShortfall(nextChem, targets);
      if (nextShortfall.score >= currentShortfall.score) continue;
      if (
        !best ||
        nextShortfall.score < best.shortfall.score ||
        (nextShortfall.score === best.shortfall.score &&
          (nextChem?.totalChem ?? 0) > (best.chem?.totalChem ?? 0))
      ) {
        best = {
          squad: nextSquad,
          chem: nextChem,
          shortfall: nextShortfall,
          axis: anchor.axis,
          groupId: anchor.groupId,
          replaced,
        };
      }
    }
  }
  if (!best) return { changed: false };
  squad.splice(0, squad.length, ...best.squad);
  debugPush?.({
    stage: "chemistry",
    action: "anchor_rewrite",
    axis: best.axis,
    groupId: best.groupId,
    replaced: best.replaced,
    totalChem: best.chem?.totalChem ?? null,
    minChem: best.chem?.minChem ?? null,
    shortfall: best.shortfall?.score ?? null,
  });
  return {
    changed: true,
    chemistry: best.chem,
  };
};

const runPipeline = (inputContext, seed = null, phaseConfig = null) => {
  const context = {
    ...(inputContext || {}),
    optimize: {
      ...((inputContext && inputContext.optimize) || {}),
      ...((phaseConfig && phaseConfig.optimize) || {}),
    },
    seed,
    phaseConfig,
  };
  const contextSeed = seed && typeof seed === "object" ? seed : null;
  const players = context?.players || [];
  const requirementFlags =
    context?.requirementFlags ||
    getRequirementFlags(context?.requirementsNormalized || []);
  const fallbackSquadSize = (() => {
    const fromContext = toNumber(context?.requiredPlayers);
    if (fromContext != null && fromContext > 0) return fromContext;
    const list = Array.isArray(context?.requirementsNormalized)
      ? context.requirementsNormalized
      : [];
    for (const rule of list) {
      if (!rule) continue;
      if (normalizeString(rule.type) !== "players_in_squad") continue;
      const direct = toNumber(rule.count);
      if (direct != null && direct > 0) return direct;
      const derived = toNumber(rule.derivedCount);
      if (derived != null && derived > 0) return derived;
      const numeric = extractValues(rule.value)
        .map(toNumber)
        .filter((v) => v != null && v > 0);
      if (numeric.length) return numeric[0];
    }
    return DEFAULT_SQUAD_SIZE;
  })();
  const startedAt = Date.now();
  const timingsMs = {};
  const debugEnabled = Boolean(context?.debug);
  const debugLog = [];
  const debugPush = debugEnabled
    ? (entry) => {
        debugLog.push({
          at: Date.now(),
          ...entry,
        });
      }
    : null;
  const normalizePlayersStart = Date.now();
  const normalizedPool = normalizePlayers(players);
  const normalizedPlayers =
    contextSeed && typeof contextSeed.poolFilter === "function"
      ? normalizedPool.filter((player) => contextSeed.poolFilter(player))
      : normalizedPool;
  timingsMs.normalizePlayers = Date.now() - normalizePlayersStart;

  const compileConstraintsStart = Date.now();
  const compiledConstraints = compileConstraintSet(
    context?.requirementsNormalized || [],
    { fallbackSquadSize },
  );
  timingsMs.compileConstraints = Date.now() - compileConstraintsStart;

  const normalizeRulesStart = Date.now();
  const rules = normalizeRules(
    context?.requirementsNormalized || [],
    requirementFlags,
    debugPush,
    compiledConstraints,
  );
  timingsMs.normalizeRules = Date.now() - normalizeRulesStart;
  const squadSize = Math.min(
    getSquadSize(rules, fallbackSquadSize),
    normalizedPlayers.length,
  );
  const signature =
    context?.signature || buildChallengeSignature(rules, squadSize);
  const ratingRequirement = getTeamRatingTarget(rules);
  const chemistryTargets = getChemistryRequirementTargets(rules, squadSize);
  const chemistryRequired =
    chemistryTargets?.total != null || chemistryTargets?.minEach != null;
  const informBounds = getInformRequirementBounds(rules, squadSize);
  const appliedFilters = [];
  const ignoredRequirements = [];

  const ratingTargetValue = toNumber(ratingRequirement?.target);
  const shouldUseRatingFillHint = Boolean(
    ratingTargetValue != null &&
      ((!chemistryRequired && ratingTargetValue >= 80) ||
        (chemistryRequired && ratingTargetValue >= 78)),
  );
  const ratingFillHint = shouldUseRatingFillHint
    ? {
        // Keep the initial fill closer to the needed rating so chemistry-heavy
        // composition puzzles do not lock into a cheap low-rating shell.
        pivot: Math.max(
          chemistryRequired ? 76 : 80,
          Math.floor(ratingTargetValue ?? 0) - 1,
        ),
      }
    : null;

  const uniqueMaxByAttr = new Map();
  const preferUniqueFill = context?.optimize?.preferUniqueFill === true;
  if (preferUniqueFill) {
    const nationBounds = getUniqueCountRequirementBounds(
      rules,
      "nation_count",
      squadSize,
    );
    const leagueBounds = getUniqueCountRequirementBounds(
      rules,
      "league_count",
      squadSize,
    );
    const clubBounds = getUniqueCountRequirementBounds(
      rules,
      "club_count",
      squadSize,
    );
    if (Number.isFinite(nationBounds.max) && nationBounds.max < Infinity) {
      uniqueMaxByAttr.set("nationId", nationBounds.max);
    }
    if (Number.isFinite(leagueBounds.max) && leagueBounds.max < Infinity) {
      uniqueMaxByAttr.set("leagueId", leagueBounds.max);
    }
    if (Number.isFinite(clubBounds.max) && clubBounds.max < Infinity) {
      uniqueMaxByAttr.set("teamId", clubBounds.max);
    }
  }

  const buildSquadStart = Date.now();
  let pool = normalizedPlayers.slice();
  let squad = [];
  const lockedIds = new Set();
  const preservedSeedIds = new Set();

  // Build player-by-id lookup from normalized pool for slot resolution and special fallback.
  const playerById = new Map(
    normalizedPlayers
      .filter((p) => p?.id != null)
      .map((p) => [String(p.id), p]),
  );

  // Pre-seed squad from occupied field slots so solve/apply stay consistent.
  // The page layer preserves valid slot items during apply (single-solve flow),
  // so treating valid occupied slots as pre-seeded avoids overfilling (11 + preserved).
  const slotDiag = [];
  for (const slot of context?.squadSlots || []) {
    const item = slot?.item ?? null;
    const hasItem = item && typeof item === "object";
    const concept = hasItem
      ? typeof item.isConcept === "function"
        ? item.isConcept()
        : Boolean(item?.concept)
      : false;
    const id = hasItem ? (item?.id ?? null) : null;
    const idKey = id != null ? String(id) : null;
    const isLocked = slot?.isLocked ?? null;
    const isEditable = slot?.isEditable ?? null;
    const isBrick = slot?.isBrick ?? null;
    const isValid = slot?.isValid ?? null;
    slotDiag.push({
      slotIndex: slot?.slotIndex ?? null,
      isLocked,
      isEditable,
      isBrick,
      isValid,
      hasItem: Boolean(hasItem && !concept && idKey),
      itemId: idKey,
      concept,
    });
    // Keep any occupied valid slot, plus explicit lock/brick/non-editable flags.
    const keep =
      isValid === true ||
      isBrick === true ||
      isLocked === true ||
      isEditable === false;
    if (!keep) continue;
    if (!hasItem || concept) continue;
    if (!idKey || idKey === "0") continue;
    const player = playerById.get(idKey);
    if (!player) continue;
    squad.push(player);
    lockedIds.add(player.id);
    preservedSeedIds.add(player.id);
  }
  debugPush?.({ stage: "preseed", slotDiag, preseeded: squad.length });

  // Resolve slot items to normalized players so we can count how many slot
  // items already satisfy each prefill predicate (e.g. TOTW already in a slot).
  // The page layer preserves valid slot items during apply, so the solver
  // should reduce its own prefill quotas to avoid wasteful duplicates.
  const slotPlayers = [];
  for (const slot of context?.squadSlots || []) {
    const item = slot?.item ?? null;
    if (!item || typeof item !== "object") continue;
    const concept =
      typeof item.isConcept === "function"
        ? item.isConcept()
        : Boolean(item?.concept);
    if (concept) continue;
    const id = item?.id ?? null;
    if (id == null) continue;
    const idKey = String(id);
    if (!idKey || idKey === "0") continue;
    const player = playerById.get(idKey);
    if (player) slotPlayers.push(player);
  }

  const rulesByType = new Map();
  for (const rule of rules) {
    if (!rule?.type) continue;
    if (!rulesByType.has(rule.type)) {
      rulesByType.set(rule.type, []);
    }
    rulesByType.get(rule.type).push(rule);
  }

  const prefillPreferencePredicates = buildPrefillPreferencePredicates(
    rules,
    squad,
    squadSize,
  );

  // Enforce "Players from the same X: Max N" during prefill/fill so we don't build an invalid squad
  // and only discover it at final evaluation.
  const sameMaxByAttr = new Map();
  for (const rule of rules) {
    if (!rule) continue;
    if (
      rule.type !== "same_nation_count" &&
      rule.type !== "same_league_count" &&
      rule.type !== "same_club_count"
    ) {
      continue;
    }
    const required = getRuleCount(rule, squadSize);
    if (required == null || required <= 0) continue;
    if (rule.op !== "max" && rule.op !== "exact") continue;
    const attr =
      rule.type === "same_nation_count"
        ? "nationId"
        : rule.type === "same_league_count"
          ? "leagueId"
          : "teamId";
    const prev = sameMaxByAttr.get(attr);
    sameMaxByAttr.set(attr, prev == null ? required : Math.min(prev, required));
  }

  // Build predicate caps for "max" and "exact" rules so fill/prefill can enforce upper bounds.
  const predicateCaps = [];
  for (const rule of rules) {
    if (!rule) continue;
    if (rule.op !== "max" && rule.op !== "exact") continue;
    const required = getRuleCount(rule, squadSize);
    if (required == null || required < 0) continue;
    const predicate = rule.predicate || buildPredicate(rule);
    if (!predicate) continue;
    predicateCaps.push({
      type: rule.type,
      op: rule.op,
      max: required,
      required,
      predicate,
    });
  }

  const hardFilteredRules = new Set();

  // Apply quality/level "gate" rules (ex: "Player Quality: Max. Silver") even when EA encodes them
  // without a count/target. These are "all players must satisfy" constraints, not quota counts.
  for (const rule of rules) {
    if (!rule) continue;
    if (rule.type !== "player_quality" && rule.type !== "player_level")
      continue;
    const required = getRuleCount(rule, squadSize);
    if (required != null) continue; // Quota-style quality/level rules are handled elsewhere.
    const gatePredicate = rule.gatePredicate || buildQualityGatePredicate(rule);
    if (!gatePredicate) continue;

    pool = pool.filter(gatePredicate);
    appliedFilters.push({
      type: rule.type,
      method: "quality_gate",
      op: rule.op,
      values: rule.values,
      filled: true,
    });
    debugPush?.({
      stage: "filter",
      action: "apply",
      method: "quality_gate",
      type: rule.type,
      op: rule.op,
      values: rule.values,
      poolSize: pool.length,
      hard: true,
    });
    hardFilteredRules.add(rule);
  }

  // Apply hard "all players must match" filters before any prefill so we never prefill illegal cards.
  for (const rule of rules) {
    if (!rule) continue;
    const required = getRuleCount(rule, squadSize);
    if (required == null || required <= 0) continue;
    if (required < squadSize) continue;
    if (rule.op !== "min" && rule.op !== "exact") continue;

    if (
      rule.type === "same_nation_count" ||
      rule.type === "same_league_count" ||
      rule.type === "same_club_count"
    ) {
      const attr =
        rule.type === "same_nation_count"
          ? "nationId"
          : rule.type === "same_league_count"
            ? "leagueId"
            : "teamId";
      const group = selectGroupForSameCount(pool, attr, required, {
        prefillBias: contextSeed?.prefillBias ?? null,
      });
      if (group == null) {
        ignoredRequirements.push(rule.raw);
        debugPush?.({
          stage: "filter",
          action: "skip",
          reason: "group_not_found",
          type: rule.type,
          required,
          key: rule.raw?.key ?? null,
          label: rule.raw?.label ?? null,
        });
        continue;
      }
      const groupPredicate = (player) => player?.[attr] === group;
      pool = pool.filter(groupPredicate);
      appliedFilters.push({
        type: rule.type,
        method: "filter",
        required,
        group,
      });
      debugPush?.({
        stage: "filter",
        action: "apply",
        method: "filter",
        type: rule.type,
        required,
        group,
        poolSize: pool.length,
        hard: true,
      });
      hardFilteredRules.add(rule);
      continue;
    }

    const predicate = rule.predicate || buildPredicate(rule);
    if (!predicate) continue;
    pool = pool.filter(predicate);
    appliedFilters.push({ type: rule.type, method: "filter", required });
    debugPush?.({
      stage: "filter",
      action: "apply",
      method: "filter",
      type: rule.type,
      required,
      poolSize: pool.length,
      hard: true,
    });
    hardFilteredRules.add(rule);
  }

  for (const type of FILTER_PRIORITY) {
    const rulesForType = rulesByType.get(type) || [];
    for (const rule of rulesForType) {
      if (hardFilteredRules.has(rule)) continue;
      const required = getRuleCount(rule, squadSize);
      if (required == null || required <= 0) {
        ignoredRequirements.push(rule.raw);
        debugPush?.({
          stage: "filter",
          action: "skip",
          reason: "required_missing",
          type,
          key: rule.raw?.key ?? null,
          label: rule.raw?.label ?? null,
        });
        continue;
      }

      if (
        type === "same_nation_count" ||
        type === "same_league_count" ||
        type === "same_club_count"
      ) {
        // Max-only rules are enforced via `sameMaxByAttr` in prefill/fill.
        if (rule.op === "max") continue;
        const attr =
          type === "same_nation_count"
            ? "nationId"
            : type === "same_league_count"
              ? "leagueId"
              : "teamId";
        const group = selectGroupForSameCount(pool, attr, required, {
          prefillBias: contextSeed?.prefillBias ?? null,
        });
        if (group == null) {
          ignoredRequirements.push(rule.raw);
          debugPush?.({
            stage: "filter",
            action: "skip",
            reason: "group_not_found",
            type,
            required,
            key: rule.raw?.key ?? null,
            label: rule.raw?.label ?? null,
          });
          continue;
        }
        const groupPredicate = (player) => player?.[attr] === group;
        const filled = prefillPlayers(
          squad,
          pool,
          groupPredicate,
          required,
          lockedIds,
          {
            uniqueMaxByAttr,
            sameMaxByAttr,
            predicateCaps,
            squadSizeCap: squadSize,
            ratingHint: ratingFillHint,
            preferencePredicates: prefillPreferencePredicates,
            seed: contextSeed,
          },
        );
        appliedFilters.push({
          type,
          method: "prefill",
          required,
          group,
          filled,
        });
        debugPush?.({
          stage: "filter",
          action: "apply",
          method: "prefill",
          type,
          required,
          group,
          filled,
          squadSize: squad.length,
        });
        continue;
      }

      const predicate = rule.predicate || buildPredicate(rule);
      if (!predicate) {
        ignoredRequirements.push(rule.raw);
        debugPush?.({
          stage: "filter",
          action: "skip",
          reason: "predicate_missing",
          type,
          key: rule.raw?.key ?? null,
          label: rule.raw?.label ?? null,
        });
        continue;
      }

      // "max" rules are enforced via predicate caps in prefill/fill.
      if (rule.op === "max") continue;

      // Reduce required count by how many slot items already satisfy this
      // predicate. The page preserves valid slot items during apply, so the
      // solver should not add duplicates the user has already placed.
      const slotSatisfied = slotPlayers.reduce(
        (count, player) => (predicate(player) ? count + 1 : count),
        0,
      );
      const effectiveRequired = Math.max(0, required - slotSatisfied);

      const filled = prefillPlayers(
        squad,
        pool,
        predicate,
        effectiveRequired,
        lockedIds,
        {
          uniqueMaxByAttr,
          sameMaxByAttr,
          predicateCaps,
          squadSizeCap: squadSize,
          ratingHint: ratingFillHint,
          preferencePredicates: prefillPreferencePredicates,
          seed: contextSeed,
        },
      );
      appliedFilters.push({
        type,
        method: "prefill",
        required: effectiveRequired,
        filled,
        slotSatisfied,
      });
      debugPush?.({
        stage: "filter",
        action: "apply",
        method: "prefill",
        type,
        required: effectiveRequired,
        originalRequired: required,
        slotSatisfied,
        filled,
        squadSize: squad.length,
      });
    }
  }

  const specialRule = rules.find((rule) => rule.type === "player_inform");
  const excludeSpecial = toBooleanSetting(
    context?.filters?.excludeSpecial,
    false,
  );
  const useTotwPlayers = toBooleanSetting(
    context?.filters?.useTotwPlayers,
    true,
  );
  const preferLowerExcessInformsDuringSolve = !useTotwPlayers;
  const allowsNonSpecialPreference =
    excludeSpecial &&
    (!specialRule ||
      specialRule.op === "max" ||
      toNumber(specialRule.count) === 0);

  const minMax = applyMinMaxFilters(
    pool,
    rules.filter(
      (rule) =>
        rule.type === "player_min_ovr" || rule.type === "player_max_ovr",
    ),
  );
  pool = minMax.filtered;
  debugPush?.({
    stage: "filter",
    action: "apply",
    method: "min_max",
    min: minMax.min ?? null,
    max: minMax.max ?? null,
    poolSize: pool.length,
  });

  if (allowsNonSpecialPreference) {
    const preferResult = preferNonSpecialPlayers(
      pool,
      squad,
      squadSize,
      lockedIds,
    );
    if (preferResult.applied) {
      pool = preferResult.pool;
      debugPush?.({
        stage: "filter",
        action: "apply",
        method: "prefer_non_special",
        poolSize: pool.length,
      });
    }
  }

  // Soft-discourage specials: at equal rating, non-specials come first in pool ordering.
  // This passively makes fill/swap prefer non-specials without blocking specials.
  pool.sort((a, b) => {
    const seedBiasDiff =
      getSeedPoolBiasScore(a, contextSeed) -
      getSeedPoolBiasScore(b, contextSeed);
    if (seedBiasDiff !== 0) return seedBiasDiff;
    const ra = toNumber(a?.rating) ?? 0;
    const rb = toNumber(b?.rating) ?? 0;
    if (ra !== rb) return ra - rb;
    return (a?.isSpecial ? 1 : 0) - (b?.isSpecial ? 1 : 0);
  });

  squad = fillSquad(squad, pool, squadSize, lockedIds, {
    uniqueMaxByAttr,
    sameMaxByAttr,
    predicateCaps,
    ratingHint: ratingFillHint,
  });
  rebuildLockedIdsFromSquad(squad, lockedIds);
  debugPush?.({
    stage: "fill",
    squadSize: squad.length,
    lockedCount: lockedIds.size,
  });

  const dedupeReplaced = enforceUniqueDefinitions(
    squad,
    pool,
    rules,
    squadSize,
    debugPush,
  );
  if (dedupeReplaced > 0) {
    debugPush?.({
      stage: "dedupe",
      action: "summary",
      replaced: dedupeReplaced,
    });
  }

  // Prefill uses `lockedIds` to avoid selecting the same item twice.
  // Once we have a full squad, clear transient fill locks. Optionally keep
  // preseeded occupied slot players locked for the full solve lifecycle.
  lockedIds.clear();
  const preserveOccupiedSlots = toBooleanSetting(
    context?.filters?.preserveOccupiedSlots,
    false,
  );
  if (preserveOccupiedSlots && preservedSeedIds.size) {
    for (const id of preservedSeedIds) lockedIds.add(id);
    debugPush?.({
      stage: "preseed",
      action: "lock_reapply",
      preserveOccupiedSlots,
      lockedCount: lockedIds.size,
    });
  }

  // Enforce unique-count constraints (e.g. "Clubs in Squad: Max. 5") before rating improvement.
  // Rating improvement requires intermediate squads to be valid, so we must satisfy these early.
  const uniqueCountConfig = [
    { type: "nation_count", attr: "nationId" },
    { type: "league_count", attr: "leagueId" },
    { type: "club_count", attr: "teamId" },
  ];
  const uniqueBoundsByType = new Map(
    uniqueCountConfig.map(({ type }) => [
      type,
      getUniqueCountRequirementBounds(rules, type, squadSize),
    ]),
  );
  const boundedUniqueTypes = uniqueCountConfig
    .filter(({ type }) => {
      const bounds = uniqueBoundsByType.get(type);
      return bounds && Number.isFinite(bounds.max) && bounds.max < Infinity;
    })
    .sort(
      (a, b) =>
        (uniqueBoundsByType.get(a.type)?.max ?? Infinity) -
        (uniqueBoundsByType.get(b.type)?.max ?? Infinity),
    );
  if (boundedUniqueTypes.length) {
    const ignoredUniqueTypes = boundedUniqueTypes.map(({ type }) => type);
    for (const { type, attr } of boundedUniqueTypes) {
      const maxUnique = uniqueBoundsByType.get(type)?.max ?? null;
      const before = countByAttr(squad, attr).size;
      const ok = reduceUniqueAttrCount(
        squad,
        pool,
        rules,
        squadSize,
        attr,
        maxUnique,
        lockedIds,
        debugPush,
        {
          ignoredTypes: ignoredUniqueTypes,
          allowedAttrs: boundedUniqueTypes
            .filter((entry) => entry.attr !== attr)
            .map((entry) => entry.attr),
          maxIterations: context?.optimize?.uniqueMaxIterations ?? 160,
        },
      );
      const after = countByAttr(squad, attr).size;
      debugPush?.({
        stage: "unique",
        action: "summary",
        type,
        attr,
        maxUnique: maxUnique ?? null,
        before,
        after,
        ok,
      });
    }
  }

  timingsMs.buildSquad = Date.now() - buildSquadStart;

  if (ratingRequirement) {
    const SIMPLE_RATING_TYPES = new Set([
      "players_in_squad",
      "team_rating",
      "player_inform",
      "player_quality",
      "player_level",
      "player_rarity",
      "player_rarity_group",
      "player_min_ovr",
      "player_max_ovr",
      "player_exact_ovr",
      "player_tradability",
    ]);
    const isSimpleRatingSbc =
      !chemistryRequired &&
      (rules || []).every((rule) => rule && SIMPLE_RATING_TYPES.has(rule.type));

    const ratingImproveStart = Date.now();
    const smartImproveEnabled = context?.optimize?.smartImproveRating !== false;
    if (smartImproveEnabled) {
      improveRatingSmart(
        squad,
        pool,
        rules,
        squadSize,
        ratingRequirement.target,
        lockedIds,
        debugPush,
        {
          pivot: context?.optimize?.preservePivot ?? null,
          maxIterations: context?.optimize?.ratingMaxIterations ?? 80,
          capOffset: context?.optimize?.ratingCapOffset ?? 2,
          requiredInforms: informBounds?.min ?? 0,
          avoidInforms: !useTotwPlayers
            ? context?.optimize?.avoidInforms !== false
            : false,
          preferLowerExcessInforms: preferLowerExcessInformsDuringSolve,
          // For simple "upgrade" SBCs (rating + inform), keep the candidate windows tight to avoid
          // burning time scanning thousands of unnecessary swaps.
          window: isSimpleRatingSbc ? 10 : undefined,
          maxCandidates: isSimpleRatingSbc ? 160 : undefined,
          pairCandidates: isSimpleRatingSbc ? 55 : undefined,
          pairShortfallThreshold: isSimpleRatingSbc ? 0.9 : undefined,
        },
      );
    } else {
      improveRating(squad, pool, ratingRequirement.target, lockedIds);
    }
    timingsMs.ratingImprove = Date.now() - ratingImproveStart;
    debugPush?.({
      stage: "rating",
      target: ratingRequirement.target,
      squadRating: getSquadRating(squad),
    });

    const preserveEnabled = context?.optimize?.preserveHighCards !== false;
    if (preserveEnabled) {
      const preserveStart = Date.now();
      const preserveMaxIterations =
        context?.optimize?.preserveMaxIterations ?? 30;
      const preserve = optimizeSquadForPreservation(
        squad,
        normalizedPlayers,
        rules,
        squadSize,
        ratingRequirement.target,
        lockedIds,
        debugPush,
        {
          pivot: context?.optimize?.preservePivot ?? null,
          maxIterations: isSimpleRatingSbc
            ? Math.min(toNumber(preserveMaxIterations) ?? 30, 12)
            : preserveMaxIterations,
          requiredInforms: informBounds?.min ?? 0,
          preferLowerExcessInforms: true,
          window: isSimpleRatingSbc ? 4 : undefined,
          maxCandidates: isSimpleRatingSbc ? 120 : undefined,
          pairCandidates: isSimpleRatingSbc ? 70 : undefined,
          pairOutlierThreshold: isSimpleRatingSbc ? 4 : undefined,
        },
      );
      timingsMs.preserve = Date.now() - preserveStart;
      if (preserve?.changed) {
        squad = preserve.squad;
      }
    }
  }

  const slotsForChemistry = chemistryRequired
    ? normalizeSlotsForChemistry(
        context?.squadSlots,
        toNumber(context?.requiredPlayers) ?? squadSize,
      )
    : [];

  const hardLockedIds = new Set();

  let chemistry = null;
  if (chemistryRequired) {
    const chemistryStart = Date.now();
    if (slotsForChemistry.length < squadSize) {
      debugPush?.({
        stage: "chemistry",
        action: "skip",
        reason: "slots_unavailable",
        slotCount: slotsForChemistry.length,
        squadSize,
      });
    } else {
      chemistry = computeChemistryEval(squad, slotsForChemistry, squadSize);
      if (!isChemistrySatisfied(chemistry, chemistryTargets)) {
        const baseChemMaxIterations = Math.max(
          10,
          toNumber(context?.optimize?.chemMaxIterations) ?? 60,
        );
        const baseChemMaxCandidates = Math.max(
          40,
          toNumber(context?.optimize?.chemMaxCandidates) ?? 160,
        );
        const baseChemEscapeDepth = Math.max(
          1,
          toNumber(context?.optimize?.chemEscapeDepth) ?? 3,
        );
        const baseChemEscapeBeamWidth = Math.max(
          8,
          toNumber(context?.optimize?.chemEscapeBeamWidth) ?? 14,
        );
        const baseChemEscapeCandidateLimit = Math.max(
          20,
          toNumber(context?.optimize?.chemEscapeCandidateLimit) ?? 70,
        );
        const baseChemEscapePenaltySlack = Math.max(
          0,
          toNumber(context?.optimize?.chemEscapePenaltySlack) ?? 30,
        );
        const baseChemOptions = {
          maxIterations: baseChemMaxIterations,
          maxCandidates: baseChemMaxCandidates,
          chemistryEscapeDepth: baseChemEscapeDepth,
          chemistryEscapeBeamWidth: baseChemEscapeBeamWidth,
          chemistryEscapeCandidateLimit: baseChemEscapeCandidateLimit,
          chemistryEscapePenaltySlack: baseChemEscapePenaltySlack,
          ratingTarget: ratingRequirement?.target ?? null,
          pivot: context?.optimize?.preservePivot ?? null,
          requiredInforms: informBounds?.min ?? 0,
          avoidInforms: !useTotwPlayers
            ? context?.optimize?.avoidInforms !== false
            : false,
          preferLowerExcessInforms: preferLowerExcessInformsDuringSolve,
          timeBudgetMs: context?.optimize?.chemTimeBudgetMs ?? null,
        };

        improveChemistrySmart(
          squad,
          pool,
          rules,
          squadSize,
          slotsForChemistry,
          chemistryTargets,
          hardLockedIds,
          debugPush,
          baseChemOptions,
        );
        chemistry = computeChemistryEval(squad, slotsForChemistry, squadSize);

        if (!isChemistrySatisfied(chemistry, chemistryTargets)) {
          const nonChemistryFailures = [];
          for (const rule of rules) {
            if (!rule) continue;
            if (
              rule.type === "chemistry_points" ||
              rule.type === "all_players_chemistry_points"
            ) {
              continue;
            }
            const failing = evaluateRule(rule, squad, squadSize, {
              checkChemistry: chemistryRequired,
              chemistry,
            });
            if (failing) nonChemistryFailures.push(failing);
          }
          if (
            signature?.isCompositionPuzzle &&
            nonChemistryFailures.length === 0
          ) {
            const rewrite = tryChemistryAnchorRewrite(
              squad,
              pool,
              rules,
              squadSize,
              slotsForChemistry,
              chemistryTargets,
              hardLockedIds,
              signature,
              debugPush,
            );
            if (rewrite?.changed) {
              chemistry =
                rewrite?.chemistry ??
                computeChemistryEval(squad, slotsForChemistry, squadSize);
            }
          }

          if (!isChemistrySatisfied(chemistry, chemistryTargets)) {
          const shortfall = getChemistryShortfall(chemistry, chemistryTargets);
          const extendedShortfallThreshold = Math.max(
            1,
            toNumber(context?.optimize?.chemExtendedShortfallThreshold) ?? 2,
          );
          if (
            shortfall.score > 0 &&
            shortfall.score <= extendedShortfallThreshold
          ) {
            debugPush?.({
              stage: "chemistry",
              action: "retry_extended",
              shortfall: shortfall.score,
              totalShort: shortfall.totalShort,
              minShort: shortfall.minShort,
              totalChem: chemistry?.totalChem ?? null,
              minChem: chemistry?.minChem ?? null,
            });

            improveChemistrySmart(
              squad,
              pool,
              rules,
              squadSize,
              slotsForChemistry,
              chemistryTargets,
              hardLockedIds,
              debugPush,
              {
                ...baseChemOptions,
                maxIterations: Math.max(
                  baseChemMaxIterations,
                  toNumber(context?.optimize?.chemExtendedMaxIterations) ??
                    120,
                ),
                maxCandidates: Math.max(
                  baseChemMaxCandidates,
                  toNumber(context?.optimize?.chemExtendedMaxCandidates) ??
                    280,
                ),
                chemistryEscapeDepth: Math.max(
                  baseChemEscapeDepth,
                  toNumber(context?.optimize?.chemExtendedEscapeDepth) ?? 5,
                ),
                chemistryEscapeBeamWidth: Math.max(
                  baseChemEscapeBeamWidth,
                  toNumber(context?.optimize?.chemExtendedEscapeBeamWidth) ??
                    24,
                ),
                chemistryEscapeCandidateLimit: Math.max(
                  baseChemEscapeCandidateLimit,
                  toNumber(
                    context?.optimize?.chemExtendedEscapeCandidateLimit,
                  ) ?? 150,
                ),
                chemistryEscapePenaltySlack: Math.max(
                  baseChemEscapePenaltySlack,
                  toNumber(context?.optimize?.chemExtendedEscapePenaltySlack) ??
                    50,
                ),
                positionCoveragePerSlot: Math.max(
                  8,
                  toNumber(context?.optimize?.chemExtendedPositionCoverage) ??
                    14,
                ),
                adaptiveNearTarget:
                  context?.optimize?.chemAdaptiveNearTarget !== false,
                nearTargetShortfallThreshold: Math.max(
                  1,
                  toNumber(context?.optimize?.chemNearTargetShortfall) ?? 2,
                ),
                timeBudgetMs: Math.max(
                  toNumber(baseChemOptions.timeBudgetMs) ?? 0,
                  toNumber(context?.optimize?.chemExtendedTimeBudgetMs) ?? 3000,
                ),
              },
            );
            chemistry = computeChemistryEval(squad, slotsForChemistry, squadSize);
          }
        }
        }
      }
    }
    timingsMs.chemistry = Date.now() - chemistryStart;
  }

  const buildFailingRequirements = (workingSquad, currentChemistry) => {
    const evalCtx = {
      checkChemistry: chemistryRequired,
      chemistry: currentChemistry,
    };
    const failing = [];
    for (const rule of rules) {
      const failedRule = evaluateRule(rule, workingSquad, squadSize, evalCtx);
      if (failedRule) failing.push(failedRule);
    }
    return failing;
  };

  let finalDedupeReplaced = 0;
  if (hasDuplicateDefinitions(squad, squadSize)) {
    finalDedupeReplaced = enforceUniqueDefinitions(
      squad,
      pool,
      rules,
      squadSize,
      debugPush,
      {
        chemistryRequired,
        slotsForChemistry,
        chemistryTargets,
        currentChemistry: chemistry,
      },
    );
    if (finalDedupeReplaced > 0) {
      if (chemistryRequired) {
        chemistry = computeChemistryEval(squad, slotsForChemistry, squadSize);
      }
      debugPush?.({
        stage: "dedupe",
        action: "final_summary",
        replaced: finalDedupeReplaced,
        remainingDefinitionIds: getDuplicateDefinitionKeys(squad, squadSize),
      });
    }
  }

  let failingRequirements = buildFailingRequirements(squad, chemistry);
  let solved = failingRequirements.length === 0;
  let refinement = {
    ran: false,
    changed: false,
    before: null,
    after: null,
    singleSwaps: 0,
    pairEscapes: 0,
    reshapeTriggered: false,
    reshapeReason: null,
    reshapeChanged: false,
    reshapeCandidatesEvaluated: 0,
    elapsedMs: 0,
  };

  if (solved && context?.optimize?.refineSolvedSquad !== false) {
    const refineStart = Date.now();
    const refineTimeBudgetMs =
      toNumber(context?.optimize?.refineTimeBudgetMs) ??
      (signature?.isCompositionPuzzle || chemistryRequired ? 250 : 120);
    const refineResult = refineSolvedSquad(
      squad,
      normalizedPlayers,
      rules,
      squadSize,
      lockedIds,
      debugPush,
      {
        ratingTarget: ratingRequirement?.target ?? null,
        pivot: context?.optimize?.preservePivot ?? null,
        requiredInforms: informBounds?.min ?? 0,
        requiredSpecials: 0,
        chemistryRequired,
        slotsForChemistry,
        chemistryTargets,
        initialChemistry: chemistry,
        signature,
        timeBudgetMs: refineTimeBudgetMs,
        maxSingleIterations:
          context?.optimize?.refineMaxSingleIterations ?? 6,
        pairSearchEnabled:
          context?.optimize?.refinePairSearchEnabled !== false,
        pairCandidateLimit:
          context?.optimize?.refinePairCandidateLimit ?? 16,
        window: context?.optimize?.refineWindow ?? 6,
        balancedReshapeEnabled:
          context?.optimize?.refineBalancedReshape === true,
        maxCandidates:
          context?.optimize?.refineMaxCandidates ??
          (signature?.isCompositionPuzzle ? 60 : 60),
        maxEvaluations:
          context?.optimize?.refineMaxEvaluations ??
          (signature?.isCompositionPuzzle ? 220 : 220),
      },
    );
    timingsMs.refine = Date.now() - refineStart;
    refinement = {
      ran: Boolean(refineResult?.ran),
      changed: Boolean(refineResult?.changed),
      before: refineResult?.before ?? null,
      after: refineResult?.after ?? null,
      singleSwaps: refineResult?.singleSwaps ?? 0,
      pairEscapes: refineResult?.pairEscapes ?? 0,
      reshapeTriggered: Boolean(refineResult?.reshapeTriggered),
      reshapeReason: refineResult?.reshapeReason ?? null,
      reshapeChanged: Boolean(refineResult?.reshapeChanged),
      reshapeCandidatesEvaluated:
        refineResult?.reshapeCandidatesEvaluated ?? 0,
      elapsedMs: refineResult?.elapsedMs ?? timingsMs.refine,
    };
    if (refineResult?.changed) {
      squad = refineResult.squad;
      chemistry = chemistryRequired
        ? refineResult?.chemistry ??
          computeChemistryEval(squad, slotsForChemistry, squadSize)
        : null;
      failingRequirements = buildFailingRequirements(squad, chemistry);
      solved = failingRequirements.length === 0;
    }
  }

  // Chemistry can be extremely sensitive to which clubs are in the squad.
  // If our local chemistry swap pass gets stuck, do a small "club set" search by swapping one club
  // in/out and re-running the solver on a restricted player pool. This helps escape local minima.
  if (
    !solved &&
    chemistryRequired &&
    chemistryTargets?.total != null &&
    isOnlyChemistryFailing(failingRequirements) &&
    context?.optimize?.chemClubSearch !== false
  ) {
    const clubBounds = getUniqueCountRequirementBounds(
      rules,
      "club_count",
      squadSize,
    );
    const finiteClubMax =
      Number.isFinite(clubBounds.max) && clubBounds.max < Infinity
        ? clubBounds.max
        : null;
    const baseClubs = new Set(
      squad.map((player) => player?.teamId).filter((v) => v != null),
    );
    const baseClubCount = baseClubs.size;
    const openSearchMaxClubs = Math.max(
      2,
      toNumber(context?.optimize?.chemClubSearchOpenMaxClubs) ?? 8,
    );
    const openSearchMaxExtraClubs = Math.max(
      0,
      toNumber(context?.optimize?.chemClubSearchMaxExtraClubs) ?? 1,
    );
    const openClubCap = Math.min(
      Math.max(baseClubCount, openSearchMaxClubs),
      baseClubCount + openSearchMaxExtraClubs,
    );
    const clubSetCap = finiteClubMax ?? openClubCap;
    const clubSearchMax = Math.max(
      2,
      toNumber(context?.optimize?.chemClubSearchMaxClubs) ?? 8,
    );
    const canSearch =
      baseClubCount >= 1 &&
      clubSetCap >= 2 &&
      clubSetCap <= clubSearchMax &&
      Array.isArray(slotsForChemistry) &&
      slotsForChemistry.length >= squadSize;

    if (canSearch) {
      const requiredPositions = extractRequiredPositionSet(
        slotsForChemistry,
        squadSize,
      );
      const requiredNationIds = new Set(
        rules
          .filter((rule) => rule?.type === "nation_id" && rule.op === "min")
          .flatMap((rule) => rule.values || [])
          .map(toNumber)
          .filter((v) => v != null),
      );
      const requiredClubIds = new Set(
        rules
          .filter((rule) => rule?.type === "club_id" && rule.op === "min")
          .flatMap((rule) => rule.values || [])
          .map(toNumber)
          .filter((v) => v != null),
      );

      const clubStats = buildClubStats(
        normalizedPlayers,
        requiredPositions,
        requiredNationIds,
      );
      const candidateClubs = getClubCandidateList(clubStats, {
        maxCandidates: context?.optimize?.chemClubSearchClubCandidates ?? 70,
        includeClubIds: Array.from(requiredClubIds),
      });

      const chemTarget = toNumber(chemistryTargets.total) ?? null;
      const getChemShortfall = (result) => {
        if (chemTarget == null) return Infinity;
        const totalChem = toNumber(result?.stats?.chemistry?.totalChem) ?? 0;
        return Math.max(0, chemTarget - totalChem);
      };

      const baseShortfall = getChemShortfall({
        stats: { chemistry: { totalChem: chemistry?.totalChem ?? 0 } },
      });
      if (baseClubs.size && baseClubs.size <= clubSetCap) {
        const maxSteps = Math.max(
          1,
          toNumber(context?.optimize?.chemClubSearchSteps) ?? 8,
        );
        let currentClubs = new Set(baseClubs);
        let currentShortfall = baseShortfall;

        let bestFound = null;

        const runRestrictedSolve = (clubSet, debug) => {
          const allowed = clubSet instanceof Set ? clubSet : new Set();
          const restrictedPlayers = (normalizedPlayers || []).filter(
            (player) => {
              const clubId = player?.teamId ?? null;
              if (clubId == null) return false;
              return allowed.has(clubId);
            },
          );
          if (restrictedPlayers.length < squadSize) return null;

          return runPipeline(
            {
              ...context,
              players: restrictedPlayers,
              debug: Boolean(debug),
              optimize: {
                ...(context?.optimize || {}),
                chemClubSearch: false,
              },
            },
            contextSeed,
            context?.phaseConfig ?? null,
          );
        };

        const debugWanted = Boolean(context?.debug);

        for (let step = 0; step < maxSteps; step += 1) {
          if (currentShortfall <= 0) break;

          let bestNeighbor = null;

          const outClubs = Array.from(currentClubs);
          const allowAdd = currentClubs.size < clubSetCap;

          const nextClubSets = [];
          const nextClubSetKeys = new Set();
          const pushNextClubSet = (set) => {
            if (!(set instanceof Set)) return;
            const key = Array.from(set).sort((a, b) => a - b).join(",");
            if (!key || nextClubSetKeys.has(key)) return;
            nextClubSetKeys.add(key);
            nextClubSets.push(set);
          };

          // Replacement neighbors.
          for (const outClub of outClubs) {
            for (const inClub of candidateClubs) {
              if (currentClubs.has(inClub)) continue;
              const next = new Set(currentClubs);
              next.delete(outClub);
              next.add(inClub);
              if (next.size > clubSetCap) continue;
              pushNextClubSet(next);
            }
          }

          // Addition neighbors if we haven't hit the max unique clubs.
          if (allowAdd) {
            for (const inClub of candidateClubs) {
              if (currentClubs.has(inClub)) continue;
              const next = new Set(currentClubs);
              next.add(inClub);
              if (next.size > clubSetCap) continue;
              pushNextClubSet(next);
            }
          }

          // Evaluate neighbors. Keep only those that fail chemistry only.
          for (const nextClubs of nextClubSets) {
            const res = runRestrictedSolve(nextClubs, false);
            if (!res) continue;
            const failing = Array.isArray(res.failingRequirements)
              ? res.failingRequirements
              : [];
            if (failing.length && !isOnlyChemistryFailing(failing)) continue;

            if (res?.stats?.solved) {
              bestFound = debugWanted
                ? runRestrictedSolve(nextClubs, true)
                : res;
              break;
            }

            const shortfall = getChemShortfall(res);
            if (shortfall >= currentShortfall) continue;
            if (!bestNeighbor || shortfall < bestNeighbor.shortfall) {
              bestNeighbor = { clubs: nextClubs, shortfall };
            }
          }

          if (bestFound?.stats?.solved) break;
          if (!bestNeighbor) break;

          currentClubs = bestNeighbor.clubs;
          currentShortfall = bestNeighbor.shortfall;
        }

        if (bestFound?.stats?.solved) {
          return bestFound;
        }
      }
    }
  }

  if (hasDuplicateDefinitions(squad, squadSize)) {
    const finalCleanupReplaced = enforceUniqueDefinitions(
      squad,
      pool,
      rules,
      squadSize,
      debugPush,
      {
        chemistryRequired,
        slotsForChemistry,
        chemistryTargets,
        currentChemistry: chemistry,
      },
    );
    if (finalCleanupReplaced > 0) {
      if (chemistryRequired) {
        chemistry = computeChemistryEval(squad, slotsForChemistry, squadSize);
      }
      failingRequirements = buildFailingRequirements(squad, chemistry);
      solved =
        failingRequirements.length === 0 &&
        !hasDuplicateDefinitions(squad, squadSize);
      debugPush?.({
        stage: "dedupe",
        action: "post_optimize_summary",
        replaced: finalCleanupReplaced,
        remainingDefinitionIds: getDuplicateDefinitionKeys(squad, squadSize),
      });
    } else {
      solved = false;
    }
  }

  solved =
    failingRequirements.length === 0 &&
    !hasDuplicateDefinitions(squad, squadSize);

  const slotSolution =
    chemistryRequired && chemistry && slotsForChemistry.length >= squadSize
      ? (() => {
          const fieldSlotIndices = slotsForChemistry
            .slice(0, squadSize)
            .map((slot) => slot.slotIndex);
          const fieldSlotToPlayerId = (chemistry.slotToPlayerIndex || []).map(
            (index) => {
              const player = squad[index] ?? null;
              return player?.id ?? null;
            },
          );
          return {
            fieldSlotIndices,
            fieldSlotToPlayerId,
            totalChem: chemistry.totalChem,
            minChem: chemistry.minChem,
            perPlayerChem: chemistry.perSlotChem,
            onPosition: chemistry.onPosition,
          };
        })()
      : null;

  timingsMs.total = Date.now() - startedAt;
  const solvedValue = solved
    ? getSolvedSquadValueMetrics(
        squad,
        pool,
        ratingRequirement?.target ?? null,
        {
          pivot: context?.optimize?.preservePivot ?? null,
          requiredInforms: informBounds?.min ?? 0,
          requiredSpecials: 0,
          signature,
        },
      )
    : null;

  return {
    solutions: solved
      ? [
          slotSolution?.fieldSlotToPlayerId?.filter((id) => id != null)
            .length === squadSize
            ? slotSolution.fieldSlotToPlayerId
            : squad.map((player) => player.id),
        ]
      : [],
    solutionSlots: slotSolution ? [slotSolution] : [],
    failingRequirements,
    stats: {
      solverVersion: SOLVER_VERSION,
      playerCount: normalizedPlayers.length,
      filteredPlayerCount: pool.length,
      squadSize,
      solved,
      averageRating: roundTo(getSquadAverageRating(squad), 2),
      adjustedAverage: roundTo(getSquadAdjustedAverage(squad), 2),
      squadRating: getSquadRating(squad),
      ratingTarget: ratingRequirement?.target ?? null,
      timingsMs,
      chemistryTargets: chemistryRequired ? chemistryTargets : null,
      chemistry: chemistryRequired
        ? {
            totalChem: chemistry?.totalChem ?? null,
            minChem: chemistry?.minChem ?? null,
            onPositionCount: chemistry?.onPositionCount ?? null,
          }
        : null,
      appliedFilters,
      debugEnabled,
      debugLog,
      refinement,
      solvedValue,
      debugSquad: debugEnabled
        ? squad.map((player) => ({
            id: player?.id ?? null,
            definitionId: player?.definitionId ?? null,
            rating: player?.rating ?? null,
            nationId: player?.nationId ?? null,
            leagueId: player?.leagueId ?? null,
            teamId: player?.teamId ?? null,
            rarityName: player?.rarityName ?? null,
            alternativePositionNames: player?.alternativePositionNames ?? null,
          }))
        : null,
      ignoredRequirementCount: ignoredRequirements.length,
      requirementFlags,
      constraintSummary: compiledConstraints.summary,
    },
    seed: contextSeed,
    signature,
    phaseConfig: context?.phaseConfig ?? null,
    compositionSnapshot: buildCompositionSnapshot(squad, squadSize),
  };
};

export const solveSquad = (context) => {
  const baseContext = context && typeof context === "object" ? context : {};
  const players = Array.isArray(baseContext?.players) ? baseContext.players : [];
  if (!players.length) {
    return runPipeline(baseContext, null, null);
  }

  const requirementFlags =
    baseContext?.requirementFlags ||
    getRequirementFlags(baseContext?.requirementsNormalized || []);
  const fallbackSquadSize = (() => {
    const fromContext = toNumber(baseContext?.requiredPlayers);
    if (fromContext != null && fromContext > 0) return fromContext;
    return DEFAULT_SQUAD_SIZE;
  })();
  const compiledConstraints = compileConstraintSet(
    baseContext?.requirementsNormalized || [],
    { fallbackSquadSize },
  );
  const rules = normalizeRules(
    baseContext?.requirementsNormalized || [],
    requirementFlags,
    null,
    compiledConstraints,
  );
  const normalizedPlayers = normalizePlayers(players);
  const squadSize = Math.min(
    getSquadSize(rules, fallbackSquadSize),
    normalizedPlayers.length,
  );
  const signature = buildChallengeSignature(rules, squadSize);
  const baselinePhaseConfig = getBaselinePhaseConfig(
    baseContext?.optimize || {},
  );
  const fallbackPhaseConfig = getPhaseConfig(
    signature,
    baseContext?.optimize || {},
  );
  const restartTimeBudgetMs = Math.max(
    1000,
    toNumber(baseContext?.optimize?.restartTimeBudgetMs) ??
      DEFAULT_RESTART_TIME_BUDGET_MS,
  );
  const fallbackTimeBudgetMs = Math.max(
    0,
    toNumber(baseContext?.optimize?.fallbackTimeBudgetMs) ??
      (signature?.isCompositionPuzzle ? 3000 : 1500),
  );

  const cacheKey = buildWinningSeedCacheKey(baseContext, signature);
  const cachedSeedKey = cacheKey ? WINNING_SEED_CACHE.get(cacheKey) ?? null : null;

  const failureMemory = [];
  const triedSeedKeys = new Set();
  const orchestration = {
    signature,
    phaseConfig: baselinePhaseConfig,
    fallbackPhaseConfig,
    baselineSeeds: [],
    rescueSeeds: [],
    winningSeed: null,
    perSeed: [],
  };
  const deadlineAt = Date.now() + restartTimeBudgetMs;
  let activeDeadlineAt = deadlineAt;
  let bestResult = null;
  let bestSolvedSeedKey = null;

  const runSeed = (seed, activePhaseConfig) => {
    const key = buildSeedKey(seed);
    if (triedSeedKeys.has(key)) return null;
    triedSeedKeys.add(key);
    const result = runPipeline(
      {
        ...baseContext,
        requirementFlags,
        signature,
      },
      seed,
      activePhaseConfig,
    );
    const failureSummary = summarizeFailure(
      result,
      seed,
      signature,
      activePhaseConfig,
    );
    if (!result?.stats?.solved) {
      failureMemory.push(failureSummary);
    }
    orchestration.perSeed.push({
      seed: {
        type: seed?.type ?? "baseline",
        axis: seed?.axis ?? null,
        groupId: seed?.groupId ?? null,
        tier: seed?.tier ?? 0,
      },
      solved: Boolean(result?.stats?.solved),
      failureSummary,
    });
    const seedSummary = {
      type: seed?.type ?? "baseline",
      axis: seed?.axis ?? null,
      groupId: seed?.groupId ?? null,
      tier: seed?.tier ?? 0,
    };
    if (!bestResult || compareSolverResults(result, bestResult) < 0) {
      bestResult = result;
      if (result?.stats?.solved) {
        bestSolvedSeedKey = key;
        orchestration.winningSeed = seedSummary;
      }
    }
    return result;
  };

  const baselineResult = runSeed(null, baselinePhaseConfig);
  if (baselineResult?.stats?.solved) {
    return attachOrchestrationSummary(
      bestResult,
      orchestration,
      restartTimeBudgetMs,
    );
  }
  if (fallbackTimeBudgetMs > 0) {
    activeDeadlineAt = Math.max(deadlineAt, Date.now() + fallbackTimeBudgetMs);
  }
  if (Date.now() >= activeDeadlineAt) {
    return attachOrchestrationSummary(
      bestResult,
      orchestration,
      restartTimeBudgetMs,
      Date.now() >= activeDeadlineAt,
    );
  }

  orchestration.phaseConfig = fallbackPhaseConfig;
  let seeds = generateBaselineSeeds(
    signature,
    normalizedPlayers,
    squadSize,
    baseContext,
  ).filter(
    (seed) =>
      !(
        seed?.type === "baseline" &&
        seed?.axis == null &&
        seed?.groupId == null &&
        (seed?.tier ?? 0) === 0
      ),
  );
  if (cachedSeedKey) {
    seeds = seeds.sort((a, b) => {
      const aCached = buildSeedKey(a) === cachedSeedKey;
      const bCached = buildSeedKey(b) === cachedSeedKey;
      if (aCached === bCached) return 0;
      return aCached ? -1 : 1;
    });
  }
  orchestration.baselineSeeds = seeds.map((seed) => ({
    type: seed?.type ?? "baseline",
    axis: seed?.axis ?? null,
    groupId: seed?.groupId ?? null,
    tier: seed?.tier ?? 0,
    label: seed?.label ?? null,
  }));

  for (const seed of seeds) {
    if (Date.now() >= activeDeadlineAt) {
      return attachOrchestrationSummary(
        bestResult,
        orchestration,
        restartTimeBudgetMs,
        true,
      );
    }
    const result = runSeed(seed, fallbackPhaseConfig);
    if (result?.stats?.solved) {
      if (
        cacheKey &&
        bestSolvedSeedKey &&
        orchestration?.winningSeed?.type !== "baseline"
      ) {
        WINNING_SEED_CACHE.set(cacheKey, bestSolvedSeedKey);
      }
      return attachOrchestrationSummary(
        bestResult,
        orchestration,
        restartTimeBudgetMs,
      );
    }
  }

  const rescueSeeds = generateRescueSeeds(
    signature,
    failureMemory,
    normalizedPlayers,
    squadSize,
    baseContext,
    triedSeedKeys,
  );
  orchestration.rescueSeeds = [
    ...(rescueSeeds?.tier1 || []),
    ...(rescueSeeds?.tier3 || []),
  ].map((seed) => ({
    type: seed?.type ?? "baseline",
    axis: seed?.axis ?? null,
    groupId: seed?.groupId ?? null,
    tier: seed?.tier ?? 0,
    label: seed?.label ?? null,
  }));

  for (const tierSeed of rescueSeeds?.tier1 || []) {
    if (Date.now() >= activeDeadlineAt) break;
    const result = runSeed(tierSeed, fallbackPhaseConfig);
    if (result?.stats?.solved) {
      if (
        cacheKey &&
        bestSolvedSeedKey &&
        orchestration?.winningSeed?.type !== "baseline"
      ) {
        WINNING_SEED_CACHE.set(cacheKey, bestSolvedSeedKey);
      }
      return attachOrchestrationSummary(
        bestResult,
        orchestration,
        restartTimeBudgetMs,
      );
    }
  }

  for (const tierSeed of rescueSeeds?.tier3 || []) {
    if (Date.now() >= activeDeadlineAt) break;
    const result = runSeed(tierSeed, fallbackPhaseConfig);
    if (result?.stats?.solved) {
      if (
        cacheKey &&
        bestSolvedSeedKey &&
        orchestration?.winningSeed?.type !== "baseline"
      ) {
        WINNING_SEED_CACHE.set(cacheKey, bestSolvedSeedKey);
      }
      return attachOrchestrationSummary(
        bestResult,
        orchestration,
        restartTimeBudgetMs,
      );
    }
  }

  if (
    cacheKey &&
    bestSolvedSeedKey &&
    orchestration?.winningSeed?.type !== "baseline"
  ) {
    WINNING_SEED_CACHE.set(cacheKey, bestSolvedSeedKey);
  }
  return attachOrchestrationSummary(
    bestResult,
    orchestration,
    restartTimeBudgetMs,
    Date.now() >= activeDeadlineAt,
  );
};
