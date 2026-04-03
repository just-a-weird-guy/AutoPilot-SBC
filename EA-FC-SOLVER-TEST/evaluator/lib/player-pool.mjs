export const extractPlayers = (raw) => {
  if (Array.isArray(raw)) return raw;
  if (!raw || typeof raw !== "object") return [];

  const direct = Array.isArray(raw.players) ? raw.players : [];
  const club = Array.isArray(raw.clubPlayers) ? raw.clubPlayers : [];
  const storage = Array.isArray(raw.storagePlayers) ? raw.storagePlayers : [];
  const dataPlayers = Array.isArray(raw.data?.players) ? raw.data.players : [];
  const dataClub = Array.isArray(raw.data?.clubPlayers) ? raw.data.clubPlayers : [];
  const dataStorage = Array.isArray(raw.data?.storagePlayers)
    ? raw.data.storagePlayers
    : [];

  return direct.concat(club, storage, dataPlayers, dataClub, dataStorage);
};

export const dedupePlayersById = (players) => {
  const seen = new Set();
  const deduped = [];
  for (const player of players || []) {
    if (!player || player.id == null) continue;
    const key = String(player.id);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(player);
  }
  return deduped;
};

export const flattenPlayerPool = (raw) => dedupePlayersById(extractPlayers(raw));
