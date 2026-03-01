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
  "player_rarity",
  "player_rarity_group",
  "nation_id",
  "league_id",
  "club_id",
  "same_nation_count",
  "same_league_count",
  "same_club_count",
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
    const isEvolution =
      typeof item.isEvolution === "function"
        ? Boolean(item.isEvolution())
        : Boolean(item.isEvolution ?? item.upgrades);
    normalized.push({
      ...item,
      rating,
      quality: getPlayerQuality(rating),
      rarityName: item.rarityName ? String(item.rarityName) : null,
      isStorage: Boolean(item.isStorage),
      isUntradeable: Boolean(item.isUntradeable),
      isDuplicate: Boolean(item.isDuplicate),
      isSpecial,
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
  if (!rarity) return false;
  if (rarity.includes("team of the week")) return true;
  if (rarity.includes("totw")) return true;
  if (rarity.includes("inform")) return true;
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

const buildPredicate = (rule) => {
  if (!rule) return null;
  const values = rule.values || [];
  const type = rule.type;
  if (type === "player_quality" || type === "player_level") {
    const normalized = values.map(normalizeQualityValue).filter(Boolean);
    if (!normalized.length) return null;
    return (player) => normalized.includes(player.quality);
  }
  if (type === "player_rarity" || type === "player_rarity_group") {
    const numericValues = values.map(toNumber).filter((v) => v != null);
    const textValues = values.map(normalizeString).filter(Boolean);
    const hint = getRarityHint(rule);
    return (player) => {
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

const selectGroupForSameCount = (players, attr, required) => {
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
    if (
      list.length > bestCount ||
      (list.length === bestCount && avg < bestAvg)
    ) {
      bestGroup = group;
      bestCount = list.length;
      bestAvg = avg;
    }
  }
  return bestGroup;
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
  const current = countMatching(squad, predicate);
  let needed = required - current;
  if (needed <= 0) return true;

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

  while (needed > 0) {
    let best = null;
    for (const candidate of candidates) {
      if (!candidate || candidate.id == null) continue;
      if (lockedIds.has(candidate.id)) continue;
      const check = canAddCandidate(candidate);
      if (!check.ok) continue;
      if (
        !best ||
        check.penalty < best.penalty ||
        (check.penalty === best.penalty &&
          candidate.rating < best.player.rating)
      ) {
        best = { player: candidate, penalty: check.penalty };
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
      .sort((a, b) => a.rating - b.rating);
    for (const candidate of fallback) {
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

const isSquadValid = (rules, squad, squadSize) => {
  for (const rule of rules || []) {
    if (!rule) continue;
    const failing = evaluateRule(rule, squad, squadSize);
    if (failing) return false;
  }
  return true;
};

const enforceUniqueDefinitions = (squad, pool, rules, squadSize, debugPush) => {
  const usedIds = new Set(
    (squad || []).map((player) => player?.id).filter((id) => id != null),
  );
  const seenDefs = new Set();
  let replaced = 0;

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
    for (const candidate of candidates) {
      const previous = squad[index];
      squad[index] = candidate;
      if (isSquadValid(rules, squad, squadSize)) {
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
        });
        break;
      }
      squad[index] = previous;
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

  const maxIterations = Math.max(10, toNumber(options?.maxIterations) ?? 60);
  const candidateLimit = Math.max(40, toNumber(options?.maxCandidates) ?? 160);
  const chemistryEscapeDepth = Math.max(
    1,
    toNumber(options?.chemistryEscapeDepth) ?? 3,
  );
  const chemistryEscapeBeamWidth = Math.max(
    8,
    toNumber(options?.chemistryEscapeBeamWidth) ?? 14,
  );
  const chemistryEscapeCandidateLimit = Math.max(
    20,
    toNumber(options?.chemistryEscapeCandidateLimit) ?? 70,
  );
  const chemistryEscapePenaltySlack = Math.max(
    0,
    toNumber(options?.chemistryEscapePenaltySlack) ?? 30,
  );

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

  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
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
      const outPlayer = squad[outIndex];
      if (!outPlayer) continue;
      if (hardLocked.has(outPlayer.id)) continue;

      const outDef = getDefinitionKey(outPlayer);

      for (const inPlayer of candidates) {
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
          for (let y = x + 1; y < worst.length; y += 1) {
            const outAIndex = worst[x];
            const outBIndex = worst[y];
            const outA = squad[outAIndex];
            const outB = squad[outBIndex];
            if (!outA || !outB) continue;

            const outADef = getDefinitionKey(outA);
            const outBDef = getDefinitionKey(outB);

            for (let a = 0; a < dualCandidates.length; a += 1) {
              for (let b = a + 1; b < dualCandidates.length; b += 1) {
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
          const nextBeam = [];
          for (const node of beam) {
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
              const outPlayer = nodeSquad[outIndex];
              if (!outPlayer) continue;
              if (hardLocked.has(outPlayer.id)) continue;

              const outDef = getDefinitionKey(outPlayer);

              for (const inPlayer of baseCandidates) {
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

export const solveSquad = (context) => {
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
  const normalizedPlayers = normalizePlayers(players);
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
  const ratingRequirement = getTeamRatingTarget(rules);
  const chemistryTargets = getChemistryRequirementTargets(rules, squadSize);
  const chemistryRequired =
    chemistryTargets?.total != null || chemistryTargets?.minEach != null;
  const informBounds = getInformRequirementBounds(rules, squadSize);
  const appliedFilters = [];
  const ignoredRequirements = [];

  const ratingFillHint =
    ratingRequirement &&
    !chemistryRequired &&
    toNumber(ratingRequirement.target) != null &&
    ratingRequirement.target >= 80
      ? {
          // Keep the initial fill closer to the needed rating so we don't start from bronzes
          // and then spend lots of time swapping up.
          pivot: Math.max(
            80,
            Math.floor(toNumber(ratingRequirement.target) ?? 0) - 1,
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
      const group = selectGroupForSameCount(pool, attr, required);
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
        const group = selectGroupForSameCount(pool, attr, required);
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
  const preferLowerExcessInformsDuringSolve = excludeSpecial;
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
          avoidInforms: excludeSpecial
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
            maxIterations: context?.optimize?.chemMaxIterations ?? 60,
            maxCandidates: context?.optimize?.chemMaxCandidates ?? 160,
            ratingTarget: ratingRequirement?.target ?? null,
            pivot: context?.optimize?.preservePivot ?? null,
            requiredInforms: informBounds?.min ?? 0,
            avoidInforms: excludeSpecial
              ? context?.optimize?.avoidInforms !== false
              : false,
            preferLowerExcessInforms: preferLowerExcessInformsDuringSolve,
          },
        );
        chemistry = computeChemistryEval(squad, slotsForChemistry, squadSize);
      }
    }
    timingsMs.chemistry = Date.now() - chemistryStart;
  }

  const evalCtx = {
    checkChemistry: chemistryRequired,
    chemistry,
  };

  const failingRequirements = [];
  for (const rule of rules) {
    const failing = evaluateRule(rule, squad, squadSize, evalCtx);
    if (failing) failingRequirements.push(failing);
  }

  const solved = failingRequirements.length === 0;

  // Chemistry can be extremely sensitive to which clubs are in the squad when club_count is bounded.
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
    const clubMax =
      Number.isFinite(clubBounds.max) && clubBounds.max < Infinity
        ? clubBounds.max
        : null;
    const clubSearchMax = Math.max(
      0,
      toNumber(context?.optimize?.chemClubSearchMaxClubs) ?? 6,
    );
    const canSearch =
      clubMax != null &&
      clubMax >= 2 &&
      clubMax <= clubSearchMax &&
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
      const baseClubs = new Set(
        squad.map((player) => player?.teamId).filter((v) => v != null),
      );
      if (baseClubs.size && baseClubs.size <= clubMax) {
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

          return solveSquad({
            ...context,
            players: restrictedPlayers,
            debug: Boolean(debug),
            optimize: {
              ...(context?.optimize || {}),
              chemClubSearch: false,
            },
          });
        };

        const debugWanted = Boolean(context?.debug);

        for (let step = 0; step < maxSteps; step += 1) {
          if (currentShortfall <= 0) break;

          let bestNeighbor = null;

          const outClubs = Array.from(currentClubs);
          const allowAdd = currentClubs.size < clubMax;

          const nextClubSets = [];

          // Replacement neighbors.
          for (const outClub of outClubs) {
            for (const inClub of candidateClubs) {
              if (currentClubs.has(inClub)) continue;
              const next = new Set(currentClubs);
              next.delete(outClub);
              next.add(inClub);
              if (next.size > clubMax) continue;
              nextClubSets.push(next);
            }
          }

          // Addition neighbors if we haven't hit the max unique clubs.
          if (allowAdd) {
            for (const inClub of candidateClubs) {
              if (currentClubs.has(inClub)) continue;
              const next = new Set(currentClubs);
              next.add(inClub);
              if (next.size > clubMax) continue;
              nextClubSets.push(next);
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
  };
};
