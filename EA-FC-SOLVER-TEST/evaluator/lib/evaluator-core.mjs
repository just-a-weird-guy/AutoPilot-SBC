import {
  compileConstraintSet,
  toNumber,
  normalizeString,
} from "./constraint-compiler.mjs";
import {
  normalizeSlotsForChemistry,
} from "./chemistry.mjs";

const ROUND_DECIMALS = 2;
const ROUND_THRESHOLD = 0.96;

const PENALTY_ORDER = [
  "ratingExcess",
  "maxRating",
  "highRatingScore",
  "highRatingCount",
  "identityBalancePenalty",
  "sumRating",
  "specialCount",
  "tradableCount",
  "scarcityPenalty",
];

const QUALITY_ORDER = { bronze: 1, silver: 2, gold: 3 };

const roundTo = (value, decimals) => {
  if (!Number.isFinite(value)) return 0;
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
};

const computeAverage = (ratings) => {
  const list = Array.isArray(ratings) ? ratings : [];
  if (!list.length) return 0;
  let total = 0;
  for (const rating of list) total += rating;
  return total / list.length;
};

const countByAttr = (players, attr) => {
  const counts = new Map();
  for (const player of players || []) {
    const value = player?.[attr];
    if (value == null) continue;
    counts.set(value, (counts.get(value) || 0) + 1);
  }
  return counts;
};

const countMatching = (players, predicate) =>
  (players || []).reduce(
    (total, player) => (predicate(player) ? total + 1 : total),
    0,
  );

const getDefinitionKey = (player) =>
  player?.definitionId ?? player?.defId ?? player?.id ?? null;

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

export const isTotwPlayer = (player) => {
  const rarity = normalizeString(player?.rarityName);
  if (rarity) {
    if (rarity.includes("team of the week")) return true;
    if (rarity.includes("totw")) return true;
    if (rarity.includes("inform")) return true;
  }
  return toNumber(player?.rarityId) === 3;
};

const isInformPlayer = (player) => isTotwPlayer(player);

const normalizePlayers = (players) => {
  const seen = new Set();
  const normalized = [];
  for (const item of players || []) {
    if (!item || item.id == null) continue;
    const id = String(item.id);
    if (seen.has(id)) continue;
    seen.add(id);

    const rating = toNumber(item.rating) ?? 0;
    const rarityName = item.rarityName ? String(item.rarityName) : null;
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
      id,
      definitionId:
        item.definitionId == null ? null : String(item.definitionId),
      rating,
      quality: getPlayerQuality(rating),
      rarityName,
      isStorage: Boolean(item.isStorage),
      isTradeable: Boolean(item.isTradeable),
      isUntradeable: Boolean(item.isUntradeable),
      isDuplicate: Boolean(item.isDuplicate),
      isSpecial,
      isTotw: isTotwPlayer(item),
      isEvolution,
      preferredPositionName:
        item.preferredPositionName == null
          ? null
          : String(item.preferredPositionName),
      alternativePositionNames: Array.isArray(item.alternativePositionNames)
        ? item.alternativePositionNames.map((value) => String(value))
        : [],
    });
  }
  return normalized;
};

const computeAdjustedAverage = (ratings) => {
  const list = Array.isArray(ratings) ? ratings : [];
  if (!list.length) return 0;
  const avg = computeAverage(list);
  let adjustedSum = 0;
  for (const rating of list) {
    adjustedSum += rating <= avg ? rating : 2 * rating - avg;
  }
  return adjustedSum / list.length;
};

export const getSquadAverageRating = (players) =>
  computeAverage((players || []).map((player) => toNumber(player?.rating) ?? 0));

export const getSquadAdjustedAverage = (players) =>
  computeAdjustedAverage(
    (players || []).map((player) => toNumber(player?.rating) ?? 0),
  );

export const getSquadRating = (players) => {
  const adjustedAverage = getSquadAdjustedAverage(players);
  const roundedAverage = roundTo(adjustedAverage, ROUND_DECIMALS);
  const decimal = roundedAverage - Math.floor(roundedAverage);
  const scaledDecimal = roundTo(decimal * 100, 2);
  const base = Math.floor(roundedAverage);
  if (scaledDecimal >= ROUND_THRESHOLD * 100) return base + 1;
  return base;
};

const isRareNonSpecialPlayer = (player) => {
  if (!player || player.isSpecial) return false;
  const rarity = normalizeString(player?.rarityName);
  if (rarity?.includes("rare")) return true;
  const rarityId = toNumber(player?.rarityId);
  return rarityId != null ? rarityId >= 1 : false;
};

const buildCountsMap = (players, attr) => countByAttr(players, attr);

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

const getRuleCount = (rule, squadSize) => {
  if (!rule) return null;
  const count = toNumber(rule.count);
  if (count != null && count > 0) return count;
  const target = toNumber(rule.target);
  if (target != null && target > 0) return target;
  if (
    (count == null || count <= 0) &&
    rule.op === "exact" &&
    new Set([
      "player_level",
      "player_quality",
      "player_rarity",
      "player_rarity_group",
      "player_tradability",
      "player_inform",
    ]).has(rule.type) &&
    squadSize != null &&
    squadSize > 0 &&
    Array.isArray(rule.values) &&
    rule.values.length
  ) {
    return squadSize;
  }
  if (rule.type === "players_in_squad" || rule.type === "team_rating") {
    const numeric = (rule.values || []).map(toNumber).filter((value) => value != null);
    if (numeric.length) return numeric[0];
  }
  if (
    count != null &&
    count <= 0 &&
    new Set([
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
    ]).has(rule.type)
  ) {
    const numeric = (rule.values || []).map(toNumber).filter((value) => value != null);
    if (numeric.length) return numeric[0];
  }
  return null;
};

const getTeamRatingTarget = (rules) => {
  const rule = (rules || []).find((item) => item?.type === "team_rating");
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
    if (rule.op === "min") min = Math.max(min, required);
    if (rule.op === "max") max = Math.min(max, required);
    if (rule.op === "exact") {
      min = Math.max(min, required);
      max = Math.min(max, required);
    }
  }
  return { min, max: Number.isFinite(max) ? max : Infinity };
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

const buildQualityGatePredicate = (rule) => {
  if (!rule) return null;
  if (rule.type !== "player_quality" && rule.type !== "player_level") {
    return null;
  }
  const normalized = (rule.values || [])
    .map(normalizeQualityValue)
    .filter(
      (value) =>
        value && Object.prototype.hasOwnProperty.call(QUALITY_ORDER, value),
    );
  if (!normalized.length) return null;
  if (rule.op === "exact") {
    const allowed = new Set(normalized);
    return (player) => allowed.has(player?.quality);
  }
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
    const numericValues = values.map(toNumber).filter((value) => value != null);
    const textValues = values.map(normalizeString).filter(Boolean);
    const hint = getRarityHint(rule);
    return (player) => {
      if (type === "player_rarity_or_totw") {
        const name = normalizeString(player.rarityName);
        const rareMatch =
          !player.isSpecial &&
          ((player.rarityId != null ? player.rarityId >= 1 : false) ||
            (name ? name.includes("rare") : false));
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

      return numericMatch || textMatch;
    };
  }
  if (type === "nation_id") {
    const ids = values.map(toNumber).filter((value) => value != null);
    if (!ids.length) return null;
    return (player) => ids.includes(player.nationId);
  }
  if (type === "league_id") {
    const ids = values.map(toNumber).filter((value) => value != null);
    if (!ids.length) return null;
    return (player) => ids.includes(player.leagueId);
  }
  if (type === "club_id") {
    const ids = values.map(toNumber).filter((value) => value != null);
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
    const numeric = values.map(toNumber).filter((value) => value != null);
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

const evaluateRule = (rule, squad, squadSize, evalCtx) => {
  if (!rule) return null;
  const required = getRuleCount(rule, squadSize);

  if (rule.type === "player_quality" || rule.type === "player_level") {
    if (required == null) {
      const gatePredicate = rule.gatePredicate || buildQualityGatePredicate(rule);
      if (gatePredicate && !(squad || []).every((player) => gatePredicate(player))) {
        return rule.raw;
      }
      return null;
    }
  }

  if (rule.type === "players_in_squad") {
    if ((squad || []).length !== squadSize) return rule.raw;
    return null;
  }
  if (rule.type === "team_rating") {
    if (required == null) return null;
    if (getSquadRating(squad) < required) return rule.raw;
    return null;
  }
  if (rule.type === "chemistry_points") {
    if (!evalCtx?.checkChemistry || required == null) return null;
    const totalChem = toNumber(evalCtx?.chemistry?.totalChem);
    if (totalChem == null || totalChem < required) return rule.raw;
    return null;
  }
  if (rule.type === "all_players_chemistry_points") {
    if (!evalCtx?.checkChemistry || required == null) return null;
    const minChem = toNumber(evalCtx?.chemistry?.minChem);
    if (minChem == null || minChem < required) return rule.raw;
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

  const predicate = rule.predicate || buildPredicate(rule);
  if (!predicate || required == null) return null;
  const count = countMatching(squad, predicate);
  if (rule.op === "min" && count < required) return rule.raw;
  if (rule.op === "max" && count > required) return rule.raw;
  if (rule.op === "exact" && count !== required) return rule.raw;
  return null;
};

const getPlayablePositionNames = (player) => {
  const alt = Array.isArray(player?.alternativePositionNames)
    ? player.alternativePositionNames
    : [];
  if (alt.length) return alt.map((name) => String(name));
  const preferred = player?.preferredPositionName ?? null;
  return preferred == null ? [] : [String(preferred)];
};

const chemistryPointsForCount = (count, t1, t2, t3) => {
  if (count >= t3) return 3;
  if (count >= t2) return 2;
  if (count >= t1) return 1;
  return 0;
};

const computeFixedChemistryAssignment = (orderedPlayers, squadSlots) => {
  const players = Array.isArray(orderedPlayers) ? orderedPlayers : [];
  const slots = Array.isArray(squadSlots) ? squadSlots : [];
  const n = Math.min(players.length, slots.length);
  if (n <= 0) {
    return {
      slotCount: 0,
      totalChem: 0,
      minChem: 0,
      onPositionCount: 0,
      slotToPlayerIndex: [],
      perSlotChem: [],
      onPosition: [],
      potentialByPlayer: [],
    };
  }

  const onPosition = new Array(n).fill(false);
  const includedPlayers = [];
  for (let index = 0; index < n; index += 1) {
    const player = players[index];
    const slot = slots[index];
    const slotName = slot?.positionName ?? slot?.position ?? null;
    const playable = slotName
      ? getPlayablePositionNames(player).includes(String(slotName))
      : false;
    onPosition[index] = playable;
    if (playable) includedPlayers.push(player);
  }

  const byClub = countByAttr(includedPlayers, "teamId");
  const byLeague = countByAttr(includedPlayers, "leagueId");
  const byNation = countByAttr(includedPlayers, "nationId");
  const perSlotChem = new Array(n).fill(0);
  let totalChem = 0;

  for (let index = 0; index < n; index += 1) {
    if (!onPosition[index]) continue;
    const player = players[index];
    const clubPts = chemistryPointsForCount(byClub.get(player?.teamId) || 0, 2, 4, 7);
    const leaguePts = chemistryPointsForCount(
      byLeague.get(player?.leagueId) || 0,
      3,
      5,
      8,
    );
    const nationPts = chemistryPointsForCount(
      byNation.get(player?.nationId) || 0,
      2,
      5,
      8,
    );
    const chem = Math.min(3, clubPts + leaguePts + nationPts);
    perSlotChem[index] = chem;
    totalChem += chem;
  }

  const minChem = perSlotChem.length
    ? perSlotChem.reduce((min, value) => Math.min(min, value), 3)
    : 0;

  return {
    slotCount: n,
    totalChem,
    minChem,
    onPositionCount: onPosition.reduce((sum, value) => sum + (value ? 1 : 0), 0),
    slotToPlayerIndex: Array.from({ length: n }, (_, index) => index),
    perSlotChem,
    onPosition,
    potentialByPlayer: perSlotChem.slice(),
  };
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
    signature.hasSameLeagueMin ||
      signature.hasSameNationMin ||
      signature.hasSameClubMin ||
      signature.requiredLeagueIds.length ||
      signature.requiredNationIds.length ||
      signature.requiredClubIds.length,
  );
  return signature;
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
    return score + diff * diff * diff;
  }, 0);
  const slack =
    ratingTarget != null ? getSquadRating(squad) - (toNumber(ratingTarget) ?? 0) : 0;

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

const getSolvedSquadValueMetrics = (squad, pool, ratingTarget, options = {}) => {
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
  const ratingExcess = target != null ? Math.max(0, squadRating - target) : 0;
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
      const matched = list.filter((player) => requiredLeagueIds.has(toNumber(player?.leagueId))).length;
      penalty += Math.max(0, requiredLeagueIds.size - matched) * 10;
    }
    if (requiredNationIds.size) {
      const matched = list.filter((player) => requiredNationIds.has(toNumber(player?.nationId))).length;
      penalty += Math.max(0, requiredNationIds.size - matched) * 10;
    }
    if (requiredClubIds.size) {
      const matched = list.filter((player) => requiredClubIds.has(toNumber(player?.teamId))).length;
      penalty += Math.max(0, requiredClubIds.size - matched) * 10;
    }
    if (signature.hasSameLeagueMin && signature.sameLeagueMin != null) {
      penalty += Math.max(
        0,
        signature.sameLeagueMin - (composition?.dominantLeagueCount ?? 0),
      ) * 4;
    }
    if (signature.hasSameNationMin && signature.sameNationMin != null) {
      penalty += Math.max(
        0,
        signature.sameNationMin - (composition?.dominantNationCount ?? 0),
      ) * 4;
    }
    if (signature.hasSameClubMin && signature.sameClubMin != null) {
      penalty += Math.max(
        0,
        signature.sameClubMin - (composition?.dominantClubCount ?? 0),
      ) * 4;
    }
    if (signature.sameLeagueMax != null && composition?.dominantLeagueCount != null) {
      penalty += Math.max(
        0,
        (composition?.dominantLeagueCount ?? 0) - signature.sameLeagueMax,
      ) * 4;
    }
    if (signature.sameNationMax != null && composition?.dominantNationCount != null) {
      penalty += Math.max(
        0,
        (composition?.dominantNationCount ?? 0) - signature.sameNationMax,
      ) * 4;
    }
    if (signature.sameClubMax != null && composition?.dominantClubCount != null) {
      penalty += Math.max(
        0,
        (composition?.dominantClubCount ?? 0) - signature.sameClubMax,
      ) * 4;
    }
    return penalty;
  })();

  return {
    ratingExcess,
    maxRating: preservation.maxRating,
    highRatingScore: preservation.highScore,
    highRatingCount: preservation.highCount,
    identityBalancePenalty,
    sumRating: preservation.sumRating,
    specialCount: preservation.specialCount,
    tradableCount,
    scarcityPenalty,
    preservation,
  };
};

const normalizeSlotAssignments = (slotAssignments, squadSize) => {
  if (!Array.isArray(slotAssignments) || !slotAssignments.length) return null;
  if (slotAssignments.every((entry) => typeof entry !== "object" || entry == null)) {
    const ids = slotAssignments.map((value) => (value == null ? null : String(value)));
    return ids.length === squadSize ? ids : null;
  }

  const ordered = new Array(squadSize).fill(null);
  for (const entry of slotAssignments) {
    if (!entry || typeof entry !== "object") return null;
    const slotIndex = toNumber(entry.slotIndex ?? entry.index);
    const playerId = entry.playerId ?? entry.id ?? null;
    if (slotIndex == null || slotIndex < 0 || slotIndex >= squadSize) return null;
    if (playerId == null) return null;
    ordered[slotIndex] = String(playerId);
  }
  return ordered.every((value) => value != null) ? ordered : null;
};

const normalizeCandidateSolution = (solution, squadSize) => {
  if (Array.isArray(solution)) {
    return {
      playerIds: solution.map((value) => (value == null ? null : String(value))),
      slotAssignments: null,
      meta: null,
      raw: solution,
    };
  }

  if (!solution || typeof solution !== "object") {
    return {
      playerIds: [],
      slotAssignments: null,
      meta: null,
      raw: solution,
    };
  }

  const slotAssignments = normalizeSlotAssignments(
    solution.slotAssignments ??
      solution.fieldSlotToPlayerId ??
      solution.slotPlayerIds ??
      null,
    squadSize,
  );

  const sourceIds =
    solution.playerIds ??
    solution.solutionIds ??
    solution.players ??
    solution.solution ??
    slotAssignments ??
    [];

  const playerIds = Array.isArray(sourceIds)
    ? sourceIds.map((entry) => {
        if (entry == null) return null;
        if (typeof entry === "object") return entry.id == null ? null : String(entry.id);
        return String(entry);
      })
    : [];

  return {
    playerIds,
    slotAssignments,
    meta: solution.meta ?? null,
    raw: solution,
  };
};

const meanOrNull = (values) => {
  const list = (values || []).filter((value) => Number.isFinite(value));
  if (!list.length) return null;
  return roundTo(list.reduce((sum, value) => sum + value, 0) / list.length, 6);
};

const buildSummaryCounts = (rows, key) => {
  const counts = new Map();
  for (const row of rows || []) {
    for (const value of row?.[key] || []) {
      const normalized = value ?? "unknown";
      counts.set(normalized, (counts.get(normalized) || 0) + 1);
    }
  }
  return Object.fromEntries(
    Array.from(counts.entries()).sort((left, right) => right[1] - left[1]),
  );
};

export const evaluateChallengeSolution = ({
  challenge,
  playerPool,
  candidateOutput,
}) => {
  const challengeRecord = challenge && typeof challenge === "object" ? challenge : {};
  const officialPool = normalizePlayers(playerPool || []);
  const playerById = new Map(officialPool.map((player) => [String(player.id), player]));
  const compiled = compileConstraintSet(challengeRecord.requirementsNormalized || [], {
    fallbackSquadSize: toNumber(challengeRecord.squadSize) ?? 11,
  });
  const rules = (compiled.constraints || []).map((constraint) => ({
    ...constraint,
    predicate: buildPredicate(constraint),
    gatePredicate: buildQualityGatePredicate(constraint),
  }));

  const squadSize =
    compiled.summary.squadSizeTarget ??
    toNumber(challengeRecord.squadSize) ??
    normalizeSlotsForChemistry(challengeRecord.squadSlots || []).length ??
    11;
  const officialSlots = normalizeSlotsForChemistry(
    challengeRecord.squadSlots || [],
    squadSize,
  );
  const chemistryTargets = getChemistryRequirementTargets(rules, squadSize);
  const chemistryRequired =
    chemistryTargets?.total != null || chemistryTargets?.minEach != null;

  const normalizedSolution = normalizeCandidateSolution(candidateOutput, squadSize);
  const issues = [];
  const seenIds = new Set();
  const playerIds = [];
  for (const id of normalizedSolution.playerIds || []) {
    if (!id) continue;
    if (seenIds.has(id)) {
      issues.push("duplicate_player_id");
      continue;
    }
    seenIds.add(id);
    playerIds.push(id);
  }
  if (playerIds.length === 0) {
    issues.push("no_solution_returned");
  } else if (playerIds.length !== squadSize) {
    issues.push("wrong_squad_size");
  }

  const selectedPlayers = [];
  for (const id of playerIds) {
    const player = playerById.get(String(id)) || null;
    if (!player) {
      issues.push("unknown_player_id");
      continue;
    }
    selectedPlayers.push(player);
  }

  const definitionIds = new Set();
  for (const player of selectedPlayers) {
    const definitionKey = getDefinitionKey(player);
    if (definitionKey == null) continue;
    const key = String(definitionKey);
    if (definitionIds.has(key)) {
      issues.push("duplicate_definition_id");
      break;
    }
    definitionIds.add(key);
  }

  let chemistry = null;
  let slotPlayerIds = null;
  if (selectedPlayers.length === squadSize) {
    if (officialSlots.length >= squadSize) {
      if (normalizedSolution.slotAssignments) {
        slotPlayerIds = normalizedSolution.slotAssignments.slice(0, squadSize);
        const assignedSet = new Set(slotPlayerIds.filter(Boolean));
        if (
          assignedSet.size !== selectedPlayers.length ||
          slotPlayerIds.some((id) => !seenIds.has(String(id)))
        ) {
          issues.push("slot_assignment_mismatch");
        } else {
          const orderedPlayers = slotPlayerIds
            .map((id) => playerById.get(String(id)) || null)
            .filter(Boolean);
          chemistry = computeFixedChemistryAssignment(orderedPlayers, officialSlots);
        }
      } else if (chemistryRequired) {
        issues.push("missing_slot_assignments");
      }
    } else if (chemistryRequired) {
      issues.push("missing_official_slots");
    }
  }

  const evalCtx = {
    checkChemistry: chemistryRequired,
    chemistry,
  };
  const failingRequirements = [];
  for (const rule of rules) {
    const failedRule = evaluateRule(rule, selectedPlayers, squadSize, evalCtx);
    if (failedRule) failingRequirements.push(failedRule);
  }

  const ratingTarget = getTeamRatingTarget(rules)?.target ?? null;
  const informBounds = getInformRequirementBounds(rules, squadSize);
  const signature = buildChallengeSignature(rules, squadSize);
  const solved =
    issues.length === 0 &&
    selectedPlayers.length === squadSize &&
    failingRequirements.length === 0;
  const solvedValue = solved
    ? getSolvedSquadValueMetrics(selectedPlayers, officialPool, ratingTarget, {
        requiredInforms: informBounds?.min ?? 0,
        requiredSpecials: 0,
        signature,
      })
    : null;

  return {
    challengeId: challengeRecord.challengeId ?? null,
    setId: challengeRecord.setId ?? null,
    challengeName: challengeRecord.challengeName ?? null,
    formationName: challengeRecord.formationName ?? null,
    formationCode: challengeRecord.formationCode ?? null,
    squadSize,
    solved,
    issues: Array.from(new Set(issues)),
    failingTypes: Array.from(
      new Set(
        failingRequirements
          .map(
            (rule) =>
              rule?.type ??
              rule?.keyNameNormalized ??
              rule?.keyName ??
              null,
          )
          .filter(Boolean),
      ),
    ),
    failingLabels: Array.from(
      new Set(
        failingRequirements.map((rule) => rule?.label ?? null).filter(Boolean),
      ),
    ),
    selectedPlayerIds: playerIds,
    slotPlayerIds,
    stats: {
      averageRating: roundTo(getSquadAverageRating(selectedPlayers), 2),
      adjustedAverage: roundTo(getSquadAdjustedAverage(selectedPlayers), 2),
      squadRating: getSquadRating(selectedPlayers),
      ratingTarget,
      chemistryTargets: chemistryRequired ? chemistryTargets : null,
      chemistry: chemistryRequired
        ? {
            totalChem: chemistry?.totalChem ?? null,
            minChem: chemistry?.minChem ?? null,
            onPositionCount: chemistry?.onPositionCount ?? null,
          }
        : null,
      solvedValue,
      compositionSnapshot: buildCompositionSnapshot(selectedPlayers, squadSize),
      constraintSummary: compiled.summary,
    },
  };
};

export const compareAgainstBaseline = (row, baselineRow) => {
  const mutualSolved = Boolean(row?.solved && baselineRow?.solved);
  const averageRatingDeltaVsBaseline = mutualSolved
    ? roundTo(
        (toNumber(row?.stats?.averageRating) ?? 0) -
          (toNumber(baselineRow?.stats?.averageRating) ?? 0),
        6,
      )
    : null;

  const penaltyDeltaVsBaseline = {};
  for (const key of PENALTY_ORDER) {
    penaltyDeltaVsBaseline[key] = mutualSolved
      ? roundTo(
          (toNumber(row?.stats?.solvedValue?.[key]) ?? 0) -
            (toNumber(baselineRow?.stats?.solvedValue?.[key]) ?? 0),
          6,
        )
      : null;
  }

  return {
    mutualSolved,
    averageRatingDeltaVsBaseline,
    penaltyDeltaVsBaseline,
  };
};

export const buildBenchmarkSummary = (rows, baselineRowsByChallengeId = new Map()) => {
  const solvedRows = (rows || []).filter((row) => row.solved);
  const comparisonRows = (rows || []).map((row) => {
    const baselineRow =
      row?.challengeId == null
        ? null
        : baselineRowsByChallengeId.get(String(row.challengeId)) || null;
    return {
      comparison: compareAgainstBaseline(row, baselineRow),
    };
  });
  const mutualSolvedRows = comparisonRows.filter(
    (entry) => entry.comparison.mutualSolved,
  );
  const averageRatingDeltas = mutualSolvedRows.map(
    (entry) => entry.comparison.averageRatingDeltaVsBaseline,
  );

  const penaltyDeltaMeans = Object.fromEntries(
    PENALTY_ORDER.map((key) => [
      key,
      meanOrNull(
        mutualSolvedRows.map(
          (entry) => entry.comparison.penaltyDeltaVsBaseline[key],
        ),
      ),
    ]),
  );

  return {
    challengeCount: (rows || []).length,
    solvedCount: solvedRows.length,
    unsolvedCount: (rows || []).length - solvedRows.length,
    solveRatePct:
      rows && rows.length ? roundTo((solvedRows.length / rows.length) * 100, 2) : null,
    mutualSolvedCountWithBaseline: mutualSolvedRows.length,
    meanAverageRatingDeltaVsBaseline: meanOrNull(averageRatingDeltas),
    penaltyDeltaMeans,
    rankKey: {
      solvedCount: solvedRows.length,
      mutualSolvedCountWithBaseline: mutualSolvedRows.length,
      meanAverageRatingDeltaVsBaseline: meanOrNull(averageRatingDeltas),
      penaltyDeltaMeans,
    },
    issueCounts: buildSummaryCounts(rows, "issues"),
    failingTypeCounts: buildSummaryCounts(rows, "failingTypes"),
  };
};

export const createBaselineIndex = (baselineReport) => {
  const results = Array.isArray(baselineReport?.results)
    ? baselineReport.results
    : Array.isArray(baselineReport)
      ? baselineReport
      : [];
  return new Map(
    results
      .filter((row) => row?.challengeId != null)
      .map((row) => [String(row.challengeId), row]),
  );
};

export const buildComparisonRows = (rows, baselineRowsByChallengeId = new Map()) =>
  (rows || []).map((row) => {
    const baselineRow =
      row?.challengeId == null
        ? null
        : baselineRowsByChallengeId.get(String(row.challengeId)) || null;
    return {
      ...row,
      comparison: compareAgainstBaseline(row, baselineRow),
      baseline: baselineRow
        ? {
            solved: baselineRow.solved,
            averageRating: baselineRow?.stats?.averageRating ?? null,
            squadRating: baselineRow?.stats?.squadRating ?? null,
            solvedValue: baselineRow?.stats?.solvedValue ?? null,
          }
        : null,
    };
  });

export const PENALTY_METRIC_ORDER = PENALTY_ORDER.slice();

export const buildEvaluatorContext = ({
  rawPlayers,
  rawChallenges,
}) => {
  const players = normalizePlayers(rawPlayers || []);
  const challenges = Array.isArray(rawChallenges?.challenges)
    ? rawChallenges.challenges
    : Array.isArray(rawChallenges?.records)
      ? rawChallenges.records
      : Array.isArray(rawChallenges)
        ? rawChallenges
        : [];
  return { players, challenges };
};
