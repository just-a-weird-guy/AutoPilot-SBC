const toNumber = (value) => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
};

const popcount = (mask) => {
  let count = 0;
  let n = mask >>> 0;
  while (n) {
    n &= n - 1;
    count += 1;
  }
  return count;
};

const pointsForCount = (count, t1, t2, t3) => {
  if (count >= t3) return 3;
  if (count >= t2) return 2;
  if (count >= t1) return 1;
  return 0;
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

const getPlayablePositionNames = (player) => {
  const alt = Array.isArray(player?.alternativePositionNames)
    ? player.alternativePositionNames
    : [];
  if (alt.length) {
    return alt.map((name) => String(name));
  }
  const preferred = player?.preferredPositionName ?? null;
  if (preferred) return [String(preferred)];
  return [];
};

const computeChemistryFromMask = (players, mask) => {
  const list = Array.isArray(players) ? players : [];
  const n = list.length;

  const included = [];
  for (let i = 0; i < n; i += 1) {
    if (mask & (1 << i)) included.push(list[i]);
  }

  const byClub = countByAttr(included, "teamId");
  const byLeague = countByAttr(included, "leagueId");
  const byNation = countByAttr(included, "nationId");

  // FC24/25 SBC chemistry thresholds (0-3 per dimension, sum capped at 3).
  const perPlayerChem = new Array(n).fill(0);
  let totalChem = 0;
  let minChem = 3;

  for (let i = 0; i < n; i += 1) {
    if (!(mask & (1 << i))) continue;
    const player = list[i];
    const clubCount = byClub.get(player?.teamId) || 0;
    const leagueCount = byLeague.get(player?.leagueId) || 0;
    const nationCount = byNation.get(player?.nationId) || 0;

    const clubPts = pointsForCount(clubCount, 2, 4, 7);
    const leaguePts = pointsForCount(leagueCount, 3, 5, 8);
    const nationPts = pointsForCount(nationCount, 2, 5, 8);
    const chem = Math.min(3, clubPts + leaguePts + nationPts);
    perPlayerChem[i] = chem;
    totalChem += chem;
    minChem = Math.min(minChem, chem);
  }

  if (mask === 0) minChem = 0;
  return { totalChem, minChem, perPlayerChem };
};

export const computeBestChemistryAssignment = (players, slots) => {
  const squad = Array.isArray(players) ? players : [];
  const slotList = Array.isArray(slots) ? slots : [];
  const n = Math.min(squad.length, slotList.length);
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

  const workingPlayers = squad.slice(0, n);
  const workingSlots = slotList.slice(0, n);

  const positionSets = workingPlayers.map((player) => new Set(getPlayablePositionNames(player)));
  const slotPosNames = workingSlots.map((slot) => {
    const slotPos = slot?.positionName ?? slot?.position ?? null;
    return slotPos == null ? null : String(slotPos);
  });

  // Build edges: player -> slots they can play.
  const edges = new Array(n).fill(null).map(() => []);
  for (let playerIndex = 0; playerIndex < n; playerIndex += 1) {
    for (let slotIndex = 0; slotIndex < n; slotIndex += 1) {
      const slotPosName = slotPosNames[slotIndex];
      if (!slotPosName) continue;
      if (positionSets[playerIndex]?.has(slotPosName)) {
        edges[playerIndex].push(slotIndex);
      }
    }
  }

  // In SBC, players out of position contribute 0 chem and do not count towards chemistry
  // thresholds for other players. So chemistry counts are computed from the subset of
  // players that are on-position in the final assignment.
  const tryMatch = (playerIndex, seen, matchToPlayer, allowedMask) => {
    for (const slotIndex of edges[playerIndex] || []) {
      if (seen[slotIndex]) continue;
      seen[slotIndex] = true;
      const other = matchToPlayer[slotIndex];
      if (other === -1) {
        matchToPlayer[slotIndex] = playerIndex;
        return true;
      }
      if ((allowedMask & (1 << other)) && tryMatch(other, seen, matchToPlayer, allowedMask)) {
        matchToPlayer[slotIndex] = playerIndex;
        return true;
      }
    }
    return false;
  };

  const findMatchingForMask = (allowedMask) => {
    const matchToPlayer = new Array(n).fill(-1); // slot -> player
    let sizeMatched = 0;
    for (let playerIndex = 0; playerIndex < n; playerIndex += 1) {
      if (!(allowedMask & (1 << playerIndex))) continue;
      const seen = new Array(n).fill(false);
      if (tryMatch(playerIndex, seen, matchToPlayer, allowedMask)) {
        sizeMatched += 1;
      }
    }
    return { matchToPlayer, sizeMatched };
  };

  // Determine the maximum number of players that can be placed on-position.
  const fullMask = (1 << n) - 1;
  const { sizeMatched: maxOnPos } = findMatchingForMask(fullMask);

  // Search for the best on-position subset of size maxOnPos that yields the highest
  // total chemistry when only on-position players are counted.
  let bestAllowedMask = 0;
  let bestMatchToPlayer = new Array(n).fill(-1);
  let bestTotalChem = -1;
  let bestMinChem = -1;

  for (let mask = 0; mask <= fullMask; mask += 1) {
    if (popcount(mask) !== maxOnPos) continue;

    const { matchToPlayer, sizeMatched } = findMatchingForMask(mask);
    if (sizeMatched !== maxOnPos) continue;

    const chemEval = computeChemistryFromMask(workingPlayers, mask);
    const totalChem = chemEval.totalChem;
    const minChem = chemEval.minChem;

    const better =
      totalChem > bestTotalChem ||
      (totalChem === bestTotalChem && maxOnPos > popcount(bestAllowedMask)) ||
      (totalChem === bestTotalChem && maxOnPos === popcount(bestAllowedMask) && minChem > bestMinChem);

    if (!better) continue;
    bestAllowedMask = mask;
    bestMatchToPlayer = matchToPlayer;
    bestTotalChem = totalChem;
    bestMinChem = minChem;
  }

  // If we couldn't find any subset (shouldn't happen), fall back to no on-position players.
  if (bestTotalChem < 0) {
    bestAllowedMask = 0;
    bestMatchToPlayer = new Array(n).fill(-1);
    bestTotalChem = 0;
    bestMinChem = 0;
  }

  // Build a full slot assignment from the best maximum matching.
  const slotToPlayerIndex = new Array(n).fill(-1);
  const usedPlayers = new Set();
  for (let slotIndex = 0; slotIndex < n; slotIndex += 1) {
    const playerIndex = bestMatchToPlayer[slotIndex];
    if (playerIndex == null || playerIndex < 0) continue;
    slotToPlayerIndex[slotIndex] = playerIndex;
    usedPlayers.add(playerIndex);
  }

  const remainingPlayers = [];
  for (let playerIndex = 0; playerIndex < n; playerIndex += 1) {
    if (!usedPlayers.has(playerIndex)) remainingPlayers.push(playerIndex);
  }
  const remainingSlots = [];
  for (let slotIndex = 0; slotIndex < n; slotIndex += 1) {
    if (slotToPlayerIndex[slotIndex] < 0) remainingSlots.push(slotIndex);
  }
  for (let i = 0; i < remainingSlots.length; i += 1) {
    slotToPlayerIndex[remainingSlots[i]] = remainingPlayers[i] ?? -1;
  }

  const onPosition = new Array(n).fill(false);
  const perSlotChem = new Array(n).fill(0);

  // Determine which players are actually on-position in the constructed assignment.
  let onPosMask = 0;
  for (let slotIndex = 0; slotIndex < n; slotIndex += 1) {
    const playerIndex = slotToPlayerIndex[slotIndex];
    const slotPosName = slotPosNames[slotIndex];
    const onPos =
      playerIndex >= 0 && slotPosName
        ? positionSets[playerIndex]?.has(slotPosName) ?? false
        : false;
    onPosition[slotIndex] = onPos;
    if (onPos && playerIndex >= 0) onPosMask |= 1 << playerIndex;
  }

  const chemEval = computeChemistryFromMask(workingPlayers, onPosMask);
  let totalChem = 0;
  for (let slotIndex = 0; slotIndex < n; slotIndex += 1) {
    const playerIndex = slotToPlayerIndex[slotIndex];
    const onPos = onPosition[slotIndex];
    const chem = onPos && playerIndex >= 0 ? chemEval.perPlayerChem[playerIndex] : 0;
    perSlotChem[slotIndex] = chem;
    totalChem += chem;
  }
  const minChem = perSlotChem.length > 0 ? perSlotChem.reduce((min, v) => Math.min(min, v), 3) : 0;

  return {
    slotCount: n,
    totalChem,
    minChem,
    onPositionCount: onPosition.reduce((sum, v) => sum + (v ? 1 : 0), 0),
    slotToPlayerIndex,
    perSlotChem,
    onPosition,
    // The best-case chem each player can contribute in the chosen assignment (0 if off-position).
    potentialByPlayer: chemEval.perPlayerChem,
  };
};

export const normalizeSlotsForChemistry = (squadSlots, requiredPlayers = null) => {
  const list = Array.isArray(squadSlots) ? squadSlots : [];
  const required = toNumber(requiredPlayers);
  const filtered = list
    .map((slot, index) => {
      if (!slot || typeof slot !== "object") return null;
      const slotIndex = toNumber(slot.slotIndex ?? slot.index ?? index);
      const positionName = slot.positionName ?? slot.positionTypeName ?? slot.position ?? null;
      return {
        slotIndex: slotIndex == null ? index : slotIndex,
        positionName: positionName == null ? null : String(positionName),
      };
    })
    .filter((slot) => slot && slot.positionName);
  if (required != null && required > 0) return filtered.slice(0, required);
  return filtered;
};
