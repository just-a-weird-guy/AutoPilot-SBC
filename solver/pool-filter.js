const normalizeBooleanSetting = (value, fallback = false) => {
  if (typeof value === "boolean") return value;
  if (value === "true" || value === "1" || value === 1) return true;
  if (value === "false" || value === "0" || value === 0) return false;
  return Boolean(fallback);
};

const normalizeString = (value) =>
  typeof value === "string" ? value.trim().toLowerCase() : "";

export const isTotwPlayer = (player) => {
  const rarity = normalizeString(player?.rarityName);
  if (
    rarity.includes("team of the week") ||
    rarity.includes("totw") ||
    rarity.includes("inform")
  ) {
    return true;
  }
  return Number(player?.rarityId) === 3;
};

export const filterPlayersBySolverPoolSettings = (
  players,
  settings,
  { requiredIds = [] } = {},
) => {
  const excludeSpecial = normalizeBooleanSetting(settings?.excludeSpecial, false);
  const useTotwPlayers = normalizeBooleanSetting(settings?.useTotwPlayers, true);
  const required = new Set((Array.isArray(requiredIds) ? requiredIds : []).map(String));
  const source = Array.isArray(players) ? players : [];
  const filteredPlayers = source.filter((player) => {
    const id = player?.id == null ? null : String(player.id);
    if (id && required.has(id)) return true;
    const isTotw = isTotwPlayer(player);
    if (!useTotwPlayers && isTotw) return false;
    if (excludeSpecial && Boolean(player?.isSpecial) && !isTotw) return false;
    return true;
  });
  return {
    filteredPlayers,
    poolFilters: {
      excludeSpecial,
      useTotwPlayers,
    },
  };
};
