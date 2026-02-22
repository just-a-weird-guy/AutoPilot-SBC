const DEFAULT_FALLBACK_SQUAD_SIZE = 11;

export const REQUIREMENT_KEYS = [
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

const CATEGORY_BY_TYPE = {
  players_in_squad: "squad_size",
  team_rating: "team_metric",
  player_level: "player_tier_or_quality",
  player_quality: "player_tier_or_quality",
  player_rarity: "special_or_rarity",
  player_rarity_group: "special_or_rarity",
  player_inform: "special_or_rarity",
  legend_count: "special_or_rarity",
  num_trophy_required: "special_or_rarity",
  loan_players: "special_or_rarity",
  nation_id: "identity_quota",
  league_id: "identity_quota",
  club_id: "identity_quota",
  player_min_ovr: "player_ovr_gate",
  player_exact_ovr: "player_ovr_gate",
  player_max_ovr: "player_ovr_gate",
  nation_count: "squad_composition",
  league_count: "squad_composition",
  club_count: "squad_composition",
  same_nation_count: "squad_composition",
  same_league_count: "squad_composition",
  same_club_count: "squad_composition",
  first_owner_players_count: "ownership",
  player_tradability: "ownership",
  chemistry_points: "chemistry",
  all_players_chemistry_points: "chemistry",
};

const FULL_SQUAD_EXACT_TYPES = new Set([
  "player_level",
  "player_quality",
  "player_rarity",
  "player_rarity_group",
  "player_tradability",
  "player_inform",
]);

// Some requirement types encode their numeric target inside `value` with `count = -1`.
// Others (ex: `player_quality`) use numeric enum values, so `derivedCount` must be ignored.
const DERIVED_COUNT_ALLOWED_TYPES = new Set([
  "team_star_rating",
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

export const toNumber = (value) => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
};

export const normalizeString = (value) =>
  value == null ? null : String(value).trim().toLowerCase();

const extractValues = (value) => {
  if (value == null) return [];
  if (Array.isArray(value)) return value.flatMap(extractValues);
  if (typeof value === "object") {
    if (Array.isArray(value.values)) return value.values.flatMap(extractValues);
    if (value._collection) return Object.values(value._collection).flatMap(extractValues);
    return Object.values(value).flatMap(extractValues);
  }
  return [value];
};

const normalizeValueItem = (value) => {
  const numeric = toNumber(value);
  if (numeric != null) return numeric;
  return normalizeString(value);
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

const scopeNameToOp = (scopeName) => {
  if (!scopeName) return null;
  const normalized = String(scopeName).toUpperCase();
  if (normalized.includes("MIN")) return "min";
  if (normalized.includes("MAX")) return "max";
  if (normalized.includes("GREATER")) return "min";
  if (normalized.includes("LOWER")) return "max";
  if (normalized.includes("LESS")) return "max";
  if (normalized.includes("EXACT")) return "exact";
  if (normalized.includes("RANGE")) return "range";
  return null;
};

export const normalizeRequirementType = (rule) => {
  if (!rule) return null;
  const rawType = normalizeString(rule.type);
  const keyName = normalizeString(rule.keyNameNormalized || rule.keyName);
  const enumType = ENUM_TO_TYPE[rule.keyName] || ENUM_TO_TYPE[rule.keyNameNormalized];
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

const deriveValuesFromLabel = (rule, fallback = []) => {
  if (fallback.length) return fallback;
  const label = normalizeString(rule?.label || rule?.raw?.label);
  if (!label) return fallback;
  if (rule?.type === "player_quality" || rule?.type === "player_level") {
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

const categoryForType = (type) => CATEGORY_BY_TYPE[type] || "unknown";

const resolveConstraintTarget = (constraint, fallbackSquadSize) => {
  if (!constraint) return null;
  const count = toNumber(constraint.count);
  if (count != null && count > 0) return count;

  if (
    (count == null || count <= 0) &&
    constraint.op === "exact" &&
    FULL_SQUAD_EXACT_TYPES.has(constraint.type) &&
    fallbackSquadSize != null &&
    fallbackSquadSize > 0 &&
    Array.isArray(constraint.values) &&
    constraint.values.length
  ) {
    return fallbackSquadSize;
  }

  if (constraint.type === "players_in_squad" || constraint.type === "team_rating") {
    const numeric = (constraint.values || []).map(toNumber).filter((v) => v != null);
    if (numeric.length) return numeric[0];
  }

  if (constraint.type === "player_level" || constraint.type === "player_quality") {
    const normalized = (constraint.values || []).map(normalizeQualityValue).filter(Boolean);
    if (normalized.length && count != null && count > 0) return count;
  }

  return null;
};

export const compileConstraintSet = (requirementsNormalized = [], options = {}) => {
  const fallbackSquadSize =
    toNumber(options?.fallbackSquadSize) ?? DEFAULT_FALLBACK_SQUAD_SIZE;
  const list = Array.isArray(requirementsNormalized) ? requirementsNormalized : [];
  const constraints = [];
  const unsupportedRules = [];

  for (let index = 0; index < list.length; index += 1) {
    const raw = list[index];
    if (!raw) continue;

    const type = normalizeRequirementType(raw);
    if (!type) {
      unsupportedRules.push(raw);
      continue;
    }

    const rawValues = extractValues(raw.value)
      .map(normalizeValueItem)
      .filter((value) => value !== null && value !== undefined && value !== "");
    const values = deriveValuesFromLabel({ ...raw, type }, rawValues);
    const baseCount = toNumber(raw.count);
    const derivedCount = toNumber(raw.derivedCount);
    const count =
      derivedCount != null &&
      (baseCount == null || baseCount === -1) &&
      DERIVED_COUNT_ALLOWED_TYPES.has(type)
        ? derivedCount
        : baseCount;
    const op =
      raw.op ||
      scopeNameToOp(raw.scopeName) ||
      scopeNameToOp(raw.scope) ||
      (count != null ? "min" : null);
    const category = categoryForType(type);
    const target = resolveConstraintTarget(
      { type, op, count, values },
      fallbackSquadSize
    );

    constraints.push({
      id: `c_${index + 1}`,
      index,
      category,
      type,
      op,
      count,
      target,
      values,
      raw,
    });
  }

  const byType = {};
  const byCategory = {};
  for (const constraint of constraints) {
    byType[constraint.type] = (byType[constraint.type] || 0) + 1;
    byCategory[constraint.category] = (byCategory[constraint.category] || 0) + 1;
  }

  const squadSizeTarget = constraints
    .filter((constraint) => constraint.type === "players_in_squad")
    .map((constraint) => constraint.target)
    .filter((value) => value != null && value > 0)
    .reduce((max, current) => Math.max(max, current), null);

  const teamRatingTarget = constraints
    .filter((constraint) => constraint.type === "team_rating")
    .map((constraint) => constraint.target)
    .filter((value) => value != null)
    .reduce((max, current) => Math.max(max, current), null);

  return {
    constraints,
    unsupportedRules,
    summary: {
      ruleCount: list.length,
      compiledCount: constraints.length,
      unsupportedCount: unsupportedRules.length,
      byType,
      byCategory,
      squadSizeTarget,
      teamRatingTarget,
    },
  };
};
