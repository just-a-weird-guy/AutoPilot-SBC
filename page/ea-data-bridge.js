(async function () {
  const REQ = {
    CLUB: "EA_DATA_GET_CLUB_PLAYERS",
    STORAGE: "EA_DATA_GET_STORAGE_PLAYERS",
    CHALLENGES: "EA_DATA_GET_SBC_CHALLENGES",
    SETS: "EA_DATA_GET_SBC_SETS",
  };
  const RES = "EA_DATA_RESPONSE";

  const isReady = () =>
    typeof window.services !== "undefined" &&
    services?.Club &&
    services?.Item &&
    services?.SBC;

  const delay = (seconds) =>
    new Promise((resolve) => setTimeout(resolve, seconds * 1000));
  const delayMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // SBC automation can trigger FUT rate limits if we save/submit too quickly.
  // We only pace/retry calls while an automation flow is active (ex: multi-submit).
  const SBC_AUTOMATION_MIN_GAP_MS = 950;
  const SBC_AUTOMATION_SUBMIT_MIN_GAP_MS = 2200;
  const SBC_AUTOMATION_JITTER_PCT = 0.25;
  const SBC_AUTOMATION_BACKOFF_BASE_MS = 2500;
  const SBC_AUTOMATION_BACKOFF_MAX_MS = 20000;
  let sbcAutomationDepth = 0;
  let sbcApiLastStartAt = 0;
  let sbcApiQueue = Promise.resolve();

  const enterSbcAutomation = () => {
    sbcAutomationDepth += 1;
  };
  const exitSbcAutomation = () => {
    sbcAutomationDepth = Math.max(0, sbcAutomationDepth - 1);
  };
  const isSbcAutomationActive = () => sbcAutomationDepth > 0;

  const jitterMs = (ms, pct = SBC_AUTOMATION_JITTER_PCT) => {
    const base = Number(ms);
    if (!Number.isFinite(base) || base <= 0) return 0;
    const p = Number(pct);
    const usePct = Number.isFinite(p) ? Math.max(0, Math.min(0.9, p)) : 0;
    const r = (Math.random() * 2 - 1) * usePct; // [-pct, +pct]
    return Math.max(0, Math.round(base * (1 + r)));
  };

  const parseStatusNumber = (value) => {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  };

  const isRetryableSbcStatus = (statusNum) => {
    if (statusNum == null) return false;
    // EA uses non-standard 475 in some cases; treat as temporary.
    if (statusNum === 429 || statusNum === 475) return true;
    if (statusNum >= 500 && statusNum < 600) return true;
    return false;
  };

  const enqueueSbcApi = (fn) => {
    const run = sbcApiQueue.then(fn, fn);
    sbcApiQueue = run.catch(() => {});
    return run;
  };

  const paceSbcApi = async (minGapMs = SBC_AUTOMATION_MIN_GAP_MS) => {
    const now = Date.now();
    const targetGap = jitterMs(minGapMs);
    const waitMs = sbcApiLastStartAt + targetGap - now;
    if (waitMs > 0) await delayMs(waitMs);
    sbcApiLastStartAt = Date.now();
  };

  const sbcApiCall = async (
    label,
    fn,
    {
      minGapMs = SBC_AUTOMATION_MIN_GAP_MS,
      maxAttempts = 1,
      backoffBaseMs = SBC_AUTOMATION_BACKOFF_BASE_MS,
      backoffMaxMs = SBC_AUTOMATION_BACKOFF_MAX_MS,
    } = {},
  ) =>
    enqueueSbcApi(async () => {
      if (!isSbcAutomationActive()) return fn();

      const attempts = Math.max(1, Number(maxAttempts) || 1);
      let last = null;

      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        await paceSbcApi(minGapMs);
        try {
          const res = await fn();
          last = res;
          if (res?.success === true) return res;

          const statusNum = parseStatusNumber(res?.status);
          const errorNum = parseStatusNumber(res?.error);
          const retryable =
            isRetryableSbcStatus(statusNum) ||
            isRetryableSbcStatus(errorNum) ||
            /rate|limit|thrott|timeout|busy|tempor/i.test(
              String(res?.error ?? ""),
            );
          if (!retryable || attempt >= attempts) return res;
        } catch (error) {
          last = {
            success: false,
            error: error?.code ?? "EXCEPTION",
            status: error?.status ?? null,
            data: null,
          };
          if (attempt >= attempts) return last;
        }

        const backoffMs = jitterMs(
          Math.min(backoffMaxMs, backoffBaseMs * 2 ** (attempt - 1)),
          0.2,
        );
        await delayMs(backoffMs);
      }

      return last;
    });

  const waitForEaReady = async (timeoutMs = 30000, intervalMs = 250) => {
    const start = Date.now();
    while (!isReady()) {
      if (Date.now() - start > timeoutMs) return false;
      await delayMs(intervalMs);
    }
    return true;
  };

  const observableToPromise = (observable) =>
    new Promise((resolve) => {
      observable.observe(
        this,
        (observer, { data, error, response, status, success }) => {
          observer.unobserve(this);
          resolve({
            data: response ?? data,
            error: error?.code,
            status,
            success,
          });
        },
      );
    });

  const searchClub = (criteria) =>
    observableToPromise(services.Club.search(criteria));
  const searchStorage = (criteria) =>
    observableToPromise(services.Item.searchStorageItems(criteria));

  const fetchAllPages = async (searchFn, criteria, delaySeconds = 0) => {
    const items = [];
    let offset = criteria.offset ?? 0;
    let endOfList = false;

    while (!endOfList) {
      criteria.offset = offset;
      let result = null;
      const maxAttempts = isSbcAutomationActive() ? 4 : 2;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        result = await searchFn(criteria);
        const ok = result?.success === true || result?.success == null;
        const statusLike =
          parseStatusNumber(result?.status) ?? parseStatusNumber(result?.error);
        const retryable =
          isRetryableSbcStatus(statusLike) ||
          /rate|limit|thrott|timeout|busy|tempor/i.test(
            String(result?.error ?? ""),
          );
        if (ok && result?.data) break;
        if (!retryable || attempt >= maxAttempts) break;
        const waitMs = jitterMs(
          Math.min(15000, 1200 * 2 ** (attempt - 1)),
          0.2,
        );
        await delayMs(waitMs);
      }

      const data = result?.data;
      const pageItems = data?.items ?? [];
      items.push(...pageItems);
      endOfList = data
        ? "endOfList" in data
          ? data.endOfList
          : data.retrievedAll
        : true;
      offset += criteria.count ?? pageItems.length ?? 0;
      if (delaySeconds) await delay(delaySeconds);
      if (!pageItems.length) break;
    }

    return items;
  };

  const updateSearchCriteria = async (criteria, options) => {
    if (options.playerId) criteria.defId = [options.playerId];
    if (options.onlyUntradables || options.onlyTradables) {
      criteria.untradeables = options.onlyUntradables ? "true" : "false";
    }
    if (options.excludeActiveSquad) {
      const activeIds = await getActiveSquadPlayerIds();
      criteria.excludeDefIds = activeIds;
    }
    criteria.count = 90;
  };

  const dedupeById = (items) => {
    const seen = new Set();
    return items.filter((item) => {
      const id = item?.id;
      if (id == null) return true;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  };

  const sanitizeDisplayText = (value) => {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  };

  const normalizeRatingValue = (value) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    const rounded = Math.round(n);
    if (rounded < 0 || rounded > 99) return null;
    return rounded;
  };

  const resolveEntityRarityName = (entity) => {
    if (!entity || typeof entity !== "object") return null;
    const direct = sanitizeDisplayText(
      entity?.rarityName ??
        entity?.rarity?.name ??
        entity?._staticData?.rarityName ??
        null,
    );
    if (direct) return direct;
    const rarityId =
      entity?.rarityId ??
      entity?.rareflag ??
      entity?.rarity ??
      entity?._staticData?.rarityId ??
      null;
    return sanitizeDisplayText(getRarityName(rarityId));
  };

  const resolveEntityLeagueName = (entity) => {
    if (!entity || typeof entity !== "object") return null;
    const direct = sanitizeDisplayText(
      entity?.leagueName ??
        entity?.league?.name ??
        entity?._staticData?.leagueName ??
        null,
    );
    if (direct) return direct;
    const leagueId =
      entity?.leagueId ??
      entity?.league?.id ??
      entity?._staticData?.leagueId ??
      null;
    return sanitizeDisplayText(getLeagueName(leagueId));
  };

  const resolveEntityNationName = (entity) => {
    if (!entity || typeof entity !== "object") return null;
    const direct = sanitizeDisplayText(
      entity?.nationName ??
        entity?.nation?.name ??
        entity?._staticData?.nationName ??
        entity?._staticData?.nationalityName ??
        null,
    );
    if (direct) return direct;
    const nationId =
      entity?.nationId ??
      entity?.countryId ??
      entity?.nation?.id ??
      entity?.nationality ??
      entity?._staticData?.nationId ??
      entity?._staticData?.countryId ??
      entity?._staticData?.nationality ??
      null;
    return sanitizeDisplayText(getNationName(nationId));
  };

  const EXCLUDED_PLAYER_META_STORAGE_KEY = "eaData.excludedPlayerMeta.v1";
  const EXCLUDED_PLAYER_META_STORAGE_LIMIT = 4000;
  const EXCLUDED_PLAYER_META_PERSIST_DEBOUNCE_MS = 250;
  const LEAGUE_META_STORAGE_KEY = "eaData.leagueMeta.v1";
  const LEAGUE_META_STORAGE_LIMIT = 2500;
  const LEAGUE_META_PERSIST_DEBOUNCE_MS = 250;
  const NATION_META_STORAGE_KEY = "eaData.nationMeta.v1";
  const NATION_META_STORAGE_LIMIT = 500;
  const NATION_META_PERSIST_DEBOUNCE_MS = 250;

  const loadLeagueMetaCache = () => {
    if (leagueMetaLoaded) return;
    leagueMetaLoaded = true;
    let parsed = null;
    try {
      const raw = window?.localStorage?.getItem?.(LEAGUE_META_STORAGE_KEY);
      if (raw) parsed = JSON.parse(raw);
    } catch {}
    if (!parsed || typeof parsed !== "object") return;
    for (const [idRaw, value] of Object.entries(parsed)) {
      const id = normalizeLeagueId(idRaw);
      if (!id || !value || typeof value !== "object") continue;
      const name = sanitizeDisplayText(value?.name) ?? null;
      leagueMetaCache.set(id, { name });
    }
  };

  const persistLeagueMetaCache = () => {
    if (!leagueMetaLoaded) return;
    try {
      const entries = Array.from(leagueMetaCache.entries());
      const limited =
        entries.length > LEAGUE_META_STORAGE_LIMIT
          ? entries.slice(entries.length - LEAGUE_META_STORAGE_LIMIT)
          : entries;
      const out = {};
      for (const [id, meta] of limited) {
        if (!id || !meta || typeof meta !== "object") continue;
        out[id] = {
          name: sanitizeDisplayText(meta?.name) ?? null,
        };
      }
      window?.localStorage?.setItem?.(
        LEAGUE_META_STORAGE_KEY,
        JSON.stringify(out),
      );
    } catch {}
  };

  const schedulePersistLeagueMetaCache = () => {
    if (!leagueMetaLoaded) return;
    try {
      clearTimeout(leagueMetaPersistTimer);
    } catch {}
    leagueMetaPersistTimer = setTimeout(() => {
      leagueMetaPersistTimer = null;
      persistLeagueMetaCache();
    }, LEAGUE_META_PERSIST_DEBOUNCE_MS);
  };

  const upsertLeagueMeta = (leagueId, partial = {}) => {
    loadLeagueMetaCache();
    const id = normalizeLeagueId(leagueId);
    if (!id) return null;
    const cached = leagueMetaCache.get(id);
    const prev = cached && typeof cached === "object" ? cached : {};
    const name = sanitizeDisplayText(partial?.name) ?? prev?.name ?? null;
    const next = { name };
    if (prev?.name !== next.name) {
      leagueMetaCache.set(id, next);
      schedulePersistLeagueMetaCache();
    }
    return next;
  };

  const cacheLeagueMetaFromPlayers = (players = []) => {
    for (const player of Array.isArray(players) ? players : []) {
      if (!player || typeof player !== "object") continue;
      const leagueId = normalizeLeagueId(player?.leagueId);
      if (!leagueId) continue;
      upsertLeagueMeta(leagueId, {
        name: resolveEntityLeagueName(player),
      });
    }
  };

  const getLeagueOptionsFromMetaCache = () => {
    loadLeagueMetaCache();
    const options = [];
    for (const [id, meta] of leagueMetaCache.entries()) {
      const normalizedId = normalizeLeagueId(id);
      if (!normalizedId) continue;
      const name = sanitizeDisplayText(meta?.name) ?? `League ${normalizedId}`;
      options.push({ id: String(normalizedId), name });
    }
    options.sort((a, b) => {
      const nameCmp = String(a.name).localeCompare(String(b.name));
      if (nameCmp !== 0) return nameCmp;
      return String(a.id).localeCompare(String(b.id));
    });
    return options;
  };

  const loadNationMetaCache = () => {
    if (nationMetaLoaded) return;
    nationMetaLoaded = true;
    let parsed = null;
    try {
      const raw = window?.localStorage?.getItem?.(NATION_META_STORAGE_KEY);
      if (raw) parsed = JSON.parse(raw);
    } catch {}
    if (!parsed || typeof parsed !== "object") return;
    for (const [idRaw, value] of Object.entries(parsed)) {
      const id = normalizeNationId(idRaw);
      if (!id || !value || typeof value !== "object") continue;
      const name = sanitizeDisplayText(value?.name) ?? null;
      nationMetaCache.set(id, { name });
    }
  };

  const persistNationMetaCache = () => {
    if (!nationMetaLoaded) return;
    try {
      const entries = Array.from(nationMetaCache.entries());
      const limited =
        entries.length > NATION_META_STORAGE_LIMIT
          ? entries.slice(entries.length - NATION_META_STORAGE_LIMIT)
          : entries;
      const out = {};
      for (const [id, meta] of limited) {
        if (!id || !meta || typeof meta !== "object") continue;
        out[id] = {
          name: sanitizeDisplayText(meta?.name) ?? null,
        };
      }
      window?.localStorage?.setItem?.(
        NATION_META_STORAGE_KEY,
        JSON.stringify(out),
      );
    } catch {}
  };

  const schedulePersistNationMetaCache = () => {
    if (!nationMetaLoaded) return;
    try {
      clearTimeout(nationMetaPersistTimer);
    } catch {}
    nationMetaPersistTimer = setTimeout(() => {
      nationMetaPersistTimer = null;
      persistNationMetaCache();
    }, NATION_META_PERSIST_DEBOUNCE_MS);
  };

  const upsertNationMeta = (nationId, partial = {}) => {
    loadNationMetaCache();
    const id = normalizeNationId(nationId);
    if (!id) return null;
    const cached = nationMetaCache.get(id);
    const prev = cached && typeof cached === "object" ? cached : {};
    const name = sanitizeDisplayText(partial?.name) ?? prev?.name ?? null;
    const next = { name };
    if (prev?.name !== next.name) {
      nationMetaCache.set(id, next);
      schedulePersistNationMetaCache();
    }
    return next;
  };

  const cacheNationMetaFromPlayers = (players = []) => {
    for (const player of Array.isArray(players) ? players : []) {
      if (!player || typeof player !== "object") continue;
      const nationId = normalizeNationId(player?.nationId);
      if (!nationId) continue;
      upsertNationMeta(nationId, {
        name: resolveEntityNationName(player),
      });
    }
  };

  const getNationOptionsFromMetaCache = () => {
    loadNationMetaCache();
    const options = [];
    for (const [id, meta] of nationMetaCache.entries()) {
      const normalizedId = normalizeNationId(id);
      if (!normalizedId) continue;
      const name = sanitizeDisplayText(meta?.name) ?? `Nation ${normalizedId}`;
      options.push({ id: String(normalizedId), name });
    }
    options.sort((a, b) => {
      const nameCmp = String(a.name).localeCompare(String(b.name));
      if (nameCmp !== 0) return nameCmp;
      return String(a.id).localeCompare(String(b.id));
    });
    return options;
  };

  const loadExcludedPlayerMetaCache = () => {
    if (excludedPlayerMetaLoaded) return;
    excludedPlayerMetaLoaded = true;
    let parsed = null;
    try {
      const raw = window?.localStorage?.getItem?.(
        EXCLUDED_PLAYER_META_STORAGE_KEY,
      );
      if (raw) parsed = JSON.parse(raw);
    } catch {}
    if (!parsed || typeof parsed !== "object") return;
    for (const [idRaw, value] of Object.entries(parsed)) {
      const id = idRaw == null ? null : String(idRaw).trim();
      if (!id || !value || typeof value !== "object") continue;
      const name = sanitizeDisplayText(value?.name);
      const rating = normalizeRatingValue(value?.rating);
      const rarityName = sanitizeDisplayText(value?.rarityName);
      excludedPlayerMetaCache.set(id, { name, rating, rarityName });
    }
  };

  const persistExcludedPlayerMetaCache = () => {
    if (!excludedPlayerMetaLoaded) return;
    try {
      const entries = Array.from(excludedPlayerMetaCache.entries());
      const limited =
        entries.length > EXCLUDED_PLAYER_META_STORAGE_LIMIT
          ? entries.slice(entries.length - EXCLUDED_PLAYER_META_STORAGE_LIMIT)
          : entries;
      const out = {};
      for (const [id, meta] of limited) {
        if (!id || !meta || typeof meta !== "object") continue;
        out[id] = {
          name: sanitizeDisplayText(meta?.name) ?? null,
          rating: normalizeRatingValue(meta?.rating),
          rarityName: sanitizeDisplayText(meta?.rarityName) ?? null,
        };
      }
      window?.localStorage?.setItem?.(
        EXCLUDED_PLAYER_META_STORAGE_KEY,
        JSON.stringify(out),
      );
    } catch {}
  };

  const schedulePersistExcludedPlayerMetaCache = () => {
    if (!excludedPlayerMetaLoaded) return;
    try {
      clearTimeout(excludedPlayerMetaPersistTimer);
    } catch {}
    excludedPlayerMetaPersistTimer = setTimeout(() => {
      excludedPlayerMetaPersistTimer = null;
      persistExcludedPlayerMetaCache();
    }, EXCLUDED_PLAYER_META_PERSIST_DEBOUNCE_MS);
  };

  const upsertExcludedPlayerMeta = (id, partial = {}) => {
    loadExcludedPlayerMetaCache();
    const key = id == null ? null : String(id).trim();
    if (!key) return null;
    const cached = excludedPlayerMetaCache.get(key);
    const prev = cached && typeof cached === "object" ? cached : {};
    const name = sanitizeDisplayText(partial?.name) ?? prev?.name ?? null;
    const rating =
      normalizeRatingValue(partial?.rating) ??
      normalizeRatingValue(prev?.rating);
    const rarityName =
      sanitizeDisplayText(partial?.rarityName) ?? prev?.rarityName ?? null;
    const next = { name, rating, rarityName };
    const changed =
      prev?.name !== next.name ||
      prev?.rating !== next.rating ||
      prev?.rarityName !== next.rarityName;
    if (changed) {
      excludedPlayerMetaCache.set(key, next);
      schedulePersistExcludedPlayerMetaCache();
    }
    return next;
  };

  const cacheExcludedPlayerNames = (players = []) => {
    for (const player of Array.isArray(players) ? players : []) {
      if (!player || typeof player !== "object") continue;
      const id = player?.id;
      upsertExcludedPlayerMeta(id, {
        name:
          sanitizeDisplayText(
            player?.name ??
              player?.commonName ??
              player?.displayName ??
              player?.shortName ??
              null,
          ) ?? null,
        rating: player?.rating ?? null,
        rarityName: resolveEntityRarityName(player),
      });
    }
  };

  const formSearchCriteria = (options = {}) => {
    const criteria = new UTSearchCriteriaDTO();
    criteria.type = SearchType.PLAYER;
    criteria.defId = options.playerIds ?? [];
    criteria.sort = options.sort ?? criteria.sort;
    criteria.count = options.count ?? criteria.count;
    criteria.offset = options.offset ?? 0;
    criteria.category = SearchCategory.ANY;
    return criteria;
  };

  const ACTIVE_SQUAD_TTL_MS = 60 * 1000;
  let activeSquadDefIdsCache = null; // { at: number, defIds: number[] }
  let activeSquadDefIdsInFlight = null;

  const getActiveSquadPlayerIds = async () => {
    const cached = activeSquadDefIdsCache;
    if (cached && Date.now() - cached.at < ACTIVE_SQUAD_TTL_MS) {
      return cached.defIds;
    }
    if (activeSquadDefIdsInFlight) return activeSquadDefIdsInFlight;

    activeSquadDefIdsInFlight = (async () => {
      const vm = new UTBucketedItemSearchViewModel();
      const { data } = await observableToPromise(vm.requestActiveSquadDefIds());
      const defIds = (data?.defIds ?? []).filter(Boolean);
      activeSquadDefIdsCache = { at: Date.now(), defIds };
      return defIds;
    })()
      .catch((error) => {
        activeSquadDefIdsCache = null;
        throw error;
      })
      .finally(() => {
        activeSquadDefIdsInFlight = null;
      });

    return activeSquadDefIdsInFlight;
  };

  const getClubPlayers = async (opts = {}) => {
    const {
      ignoreLoaned = true,
      onlyFemales = false,
      excludeActiveSquad = false,
      onlyUntradables,
      onlyTradables,
      playerId,
      dedupe = true,
      skipStats = true,
      duplicateDefIds,
    } = opts;

    if (!skipStats && services.Club?.clubDao?.resetStatsCache) {
      services.Club.clubDao.resetStatsCache();
    }

    const { searchCriteria } = new UTBucketedItemSearchViewModel();
    await updateSearchCriteria(searchCriteria, {
      ignoreLoaned,
      onlyFemales,
      excludeActiveSquad,
      onlyUntradables,
      onlyTradables,
      playerId,
    });

    // Small delay between pages helps avoid FUT rate limits on large clubs.
    let players = await fetchAllPages(searchClub, searchCriteria, 0.25);
    if (dedupe) players = dedupeById(players);
    if (ignoreLoaned) players = players.filter((p) => !p.isLimitedUse?.());
    if (onlyFemales)
      players = players.filter((p) => p.gender === GrammaticalGender.FEMININE);
    return players.map((player) =>
      toPlainPlayer(player, { duplicateDefIds, source: "club" }),
    );
  };

  const getClubItems = async (opts = {}) => {
    const {
      ignoreLoaned = true,
      onlyFemales = false,
      excludeActiveSquad = false,
      onlyUntradables,
      onlyTradables,
      playerId,
      dedupe = true,
      skipStats = true,
    } = opts;

    if (!skipStats && services.Club?.clubDao?.resetStatsCache) {
      services.Club.clubDao.resetStatsCache();
    }

    const { searchCriteria } = new UTBucketedItemSearchViewModel();
    await updateSearchCriteria(searchCriteria, {
      ignoreLoaned,
      onlyFemales,
      excludeActiveSquad,
      onlyUntradables,
      onlyTradables,
      playerId,
    });

    // Small delay between pages helps avoid FUT rate limits on large clubs.
    let players = await fetchAllPages(searchClub, searchCriteria, 0.25);
    if (dedupe) players = dedupeById(players);
    if (ignoreLoaned) players = players.filter((p) => !p.isLimitedUse?.());
    if (onlyFemales)
      players = players.filter((p) => p.gender === GrammaticalGender.FEMININE);
    return players;
  };

  const getStorageItems = async () => {
    const criteria = formSearchCriteria();
    return fetchAllPages(searchStorage, criteria, 0.25);
  };

  const buildExcludedStorageIds = (players, extraDefIds) => {
    const list = Array.isArray(players) ? players : [];
    const groups = new Map();
    for (const player of list) {
      const defId = player?.definitionId ?? null;
      if (defId == null) continue;
      if (!groups.has(defId))
        groups.set(defId, { hasClub: false, storageIds: [] });
      const entry = groups.get(defId);
      if (player?.isStorage) entry.storageIds.push(player.id);
      else entry.hasClub = true;
    }
    if (extraDefIds?.size) {
      for (const defId of extraDefIds) {
        if (defId == null) continue;
        if (!groups.has(defId))
          groups.set(defId, { hasClub: true, storageIds: [] });
        else groups.get(defId).hasClub = true;
      }
    }
    const excluded = new Set();
    for (const entry of groups.values()) {
      if (!entry.hasClub) continue;
      for (const id of entry.storageIds) {
        if (id == null) continue;
        excluded.add(id);
        excluded.add(String(id));
      }
    }
    return Array.from(excluded);
  };

  const getChallengeSquadDefinitionIds = (challenge) => {
    const squad =
      challenge?.squad ??
      challenge?.getSquad?.() ??
      challenge?.data?.squad ??
      null;
    const slots = squad?.getPlayers?.() ?? [];
    const ids = new Set();
    for (const slot of slots) {
      const item = slot?.item ?? slot ?? null;
      const defId = item?.definitionId ?? null;
      if (defId == null || defId === 0) continue;
      ids.add(defId);
      ids.add(String(defId));
    }
    return ids;
  };

  const getTransferListItems = async () => {
    const service = services?.Item ?? services?.Club ?? null;
    const lookup =
      service?.getTransferListItemsByGroup ??
      service?.getTransferListItems ??
      services?.TransferMarket?.getTransferListItemsByGroup ??
      null;
    if (!lookup) return { unSoldItems: [], availableItems: [] };
    const result = await observableToPromise(lookup(true));
    return result?.data ?? { unSoldItems: [], availableItems: [] };
  };

  const getUnassignedItems = async () => {
    const lookup = services?.Item?.getUnassignedItems ?? null;
    if (!lookup) return [];
    const result = await observableToPromise(lookup(false));
    return result?.data?.items ?? [];
  };

  const getDuplicatedDefIds = async (includeTransfer = false) => {
    const unassigned = await getUnassignedItems();
    let extra = [];
    if (includeTransfer) {
      const { unSoldItems, availableItems } = await getTransferListItems();
      extra = (unSoldItems ?? []).concat(availableItems ?? []);
    }
    const all = (unassigned ?? []).concat(extra ?? []);
    return new Set(
      all
        .filter((item) => item?.isDuplicate?.())
        .map((item) => item?.definitionId)
        .filter((value) => value != null),
    );
  };

  const PLAYERS_FETCH_TTL_MS = 60 * 1000;
  const playersFetchInFlightByKey = new Map();
  const playersFetchCacheByKey = new Map(); // key -> { at, data }

  const normalizePlayersFetchOptions = (options = {}) => ({
    ignoreLoaned: options?.ignoreLoaned !== false,
    onlyFemales: options?.onlyFemales === true,
    excludeActiveSquad: options?.excludeActiveSquad !== false,
    onlyUntradables: options?.onlyUntradables === true,
    onlyTradables: options?.onlyTradables === true,
    playerId: options?.playerId ?? null,
    dedupe: options?.dedupe !== false,
    skipStats: options?.skipStats !== false,
  });

  const getPlayersFetchKey = (options = {}) => {
    const normalized = normalizePlayersFetchOptions(options);
    return JSON.stringify(normalized);
  };

  const fetchPlayersSnapshot = async (options = {}) => {
    const normalized = normalizePlayersFetchOptions(options);
    const duplicateDefIds = await getDuplicatedDefIds(true);
    const [clubPlayers, storagePlayers] = await Promise.all([
      getClubPlayers({ ...normalized, duplicateDefIds }),
      getStoragePlayers(duplicateDefIds),
    ]);
    cacheExcludedPlayerNames(clubPlayers);
    cacheExcludedPlayerNames(storagePlayers);
    cacheLeagueMetaFromPlayers(clubPlayers);
    cacheLeagueMetaFromPlayers(storagePlayers);
    cacheNationMetaFromPlayers(clubPlayers);
    cacheNationMetaFromPlayers(storagePlayers);
    return {
      clubPlayers,
      storagePlayers,
      duplicateDefIds,
      fetchedAt: new Date().toISOString(),
    };
  };

  const ensurePlayersSnapshot = async (
    options = {},
    { force = false, ttlMs = PLAYERS_FETCH_TTL_MS } = {},
  ) => {
    const key = getPlayersFetchKey(options);

    if (!force) {
      const cached = playersFetchCacheByKey.get(key) ?? null;
      if (cached && Date.now() - cached.at < ttlMs) return cached.data;

      const inFlight = playersFetchInFlightByKey.get(key) ?? null;
      if (inFlight) return inFlight;
    }

    const promise = (async () => {
      const data = await fetchPlayersSnapshot(options);
      playersFetchCacheByKey.set(key, { at: Date.now(), data });
      return data;
    })().finally(() => {
      playersFetchInFlightByKey.delete(key);
    });

    playersFetchInFlightByKey.set(key, promise);
    return promise;
  };

  const clearPlayersSnapshotCache = () => {
    playersFetchInFlightByKey.clear();
    playersFetchCacheByKey.clear();
    activeSquadDefIdsCache = null;
  };

  const getPlayersSnapshotStatus = (options = {}) => {
    const key = getPlayersFetchKey(options);
    const cached = playersFetchCacheByKey.get(key) ?? null;
    return {
      key,
      inFlight: playersFetchInFlightByKey.has(key),
      cachedAt: cached ? new Date(cached.at).toISOString() : null,
      cachedAgeMs: cached ? Date.now() - cached.at : null,
    };
  };

  const moveItemsToClub = async (items) => {
    if (!items?.length) return 0;
    const ItemPile =
      services?.Item?.UTItemPileEnum ?? window?.UTItemPileEnum ?? {};
    const clubPile = ItemPile.CLUB ?? 7;
    const storagePile = ItemPile.STORAGE ?? 10;
    const movable = items.filter((item) => item?.pile === storagePile);
    if (!movable.length) return 0;
    await observableToPromise(services.Item.move(movable, clubPile));
    await delay(0.5);
    return movable.length;
  };

  const getStoragePlayers = async (duplicateDefIds) => {
    const players = await getStorageItems();
    return players
      .filter((player) => !player?.isEnrolledInAcademy?.())
      .map((player) =>
        toPlainPlayer(player, { duplicateDefIds, source: "storage" }),
      );
  };

  const getSbcSets = async () => {
    const { data } = await observableToPromise(services.SBC.requestSets());
    return (data?.sets ?? []).map((s) => ({ id: s.id, name: s.name }));
  };

  const addLookupEntry = (lookup, key, player) => {
    if (key == null) return;
    lookup.set(key, player);
    if (typeof key === "number" && Number.isFinite(key)) {
      lookup.set(String(key), player);
      return;
    }
    if (typeof key === "string") {
      const numeric = parseInt(key, 10);
      if (Number.isFinite(numeric)) lookup.set(numeric, player);
    }
  };

  const addPlayerToLookup = (lookup, key, player) => {
    if (!player) return;
    addLookupEntry(lookup, key, player);
    addLookupEntry(lookup, player.id, player);
    addLookupEntry(lookup, player.definitionId, player);
  };

  const getSquadLookupForSbc = async (key = "id", options = {}) => {
    const { raw = false, ...lookupOptions } = options ?? {};
    const [clubPlayers, storagePlayers] = await Promise.all([
      raw ? getClubItems(lookupOptions) : getClubPlayers(lookupOptions),
      raw ? getStorageItems() : getStoragePlayers(),
    ]);
    const lookup = new Map();
    for (const player of clubPlayers) {
      if (!player) continue;
      if (player?.isEnrolledInAcademy?.()) continue;
      const id = player[key] ?? player.id;
      addPlayerToLookup(lookup, id, player);
    }
    for (const player of storagePlayers) {
      if (!player) continue;
      if (player?.isEnrolledInAcademy?.()) continue;
      const id = player[key] ?? player.id;
      addPlayerToLookup(lookup, id, player);
    }
    return lookup;
  };

  const createSquadPlayers = (ids, lookup) =>
    (ids || []).map((id) => {
      if (id == null) return null;
      const match = lookup?.get(id) ?? lookup?.get(String(id)) ?? null;
      if (match && typeof match === "object") return match;
      const item = new UTItemEntity();
      item.id = match?.id ?? id;
      item.definitionId = match?.definitionId ?? id;
      item.concept = !match;
      item.stackCount = 1;
      return item;
    });

  const resolveSlotLocked = (slot) => {
    if (!slot) return null;
    if (typeof slot.isLocked === "function") return slot.isLocked();
    if (typeof slot.getIsLocked === "function") return slot.getIsLocked();
    if (typeof slot.isSlotLocked === "function") return slot.isSlotLocked();
    if (typeof slot.locked === "boolean") return slot.locked;
    if (typeof slot.isLocked === "boolean") return slot.isLocked;
    if (typeof slot.isEditable === "function") return !slot.isEditable();
    return null;
  };

  const resolveSlotValid = (slot, item) => {
    if (!slot && !item) return false;
    if (typeof slot?.isValid === "function") return slot.isValid();
    if (typeof slot?.getIsValid === "function") return slot.getIsValid();
    if (typeof slot?.valid === "boolean") return slot.valid;
    const concept =
      typeof item?.isConcept === "function"
        ? item.isConcept()
        : Boolean(item?.concept);
    return Boolean(item && item.id && item.id !== 0 && !concept);
  };

  const resolveSlotBrick = (slot) => {
    if (!slot) return false;
    if (typeof slot.isBrick === "function") return slot.isBrick();
    if (typeof slot.getIsBrick === "function") return slot.getIsBrick();
    if (typeof slot.isBrick === "boolean") return slot.isBrick;
    if (typeof slot.brick === "boolean") return slot.brick;
    return false;
  };

  const resolveSlotItem = (slot) => slot?.getItem?.() ?? slot?.item ?? null;

  const buildPreservedSlotList = (
    squadEntity,
    ids,
    lookup,
    slotSolution = null,
    preserveExistingValid = true,
  ) => {
    const slots = squadEntity?.getPlayers?.() ?? [];
    if (!Array.isArray(slots) || !slots.length) {
      return createSquadPlayers(ids, lookup);
    }
    const list = new Array(slots.length).fill(null);
    const usedIds = new Set();
    const usedDefIds = new Set();
    const poolByDefinition = new Map();
    const uniqueItems = new Map();
    for (const item of lookup?.values?.() ?? []) {
      if (!item || item.id == null) continue;
      if (!uniqueItems.has(item.id)) uniqueItems.set(item.id, item);
    }
    const storagePile = services?.Item?.UTItemPileEnum?.STORAGE ?? 10;
    for (const item of uniqueItems.values()) {
      const defId = item?.definitionId ?? null;
      if (defId == null) continue;
      if (!poolByDefinition.has(defId)) {
        poolByDefinition.set(defId, { club: [], storage: [], other: [] });
      }
      const pool = poolByDefinition.get(defId);
      if (item?.isStorage) pool.storage.push(item);
      else if (item?.pile === storagePile) pool.storage.push(item);
      else if (item?.pile === (services?.Item?.UTItemPileEnum?.CLUB ?? 7))
        pool.club.push(item);
      else pool.other.push(item);
    }
    const isItemTradeable = (item) => {
      if (!item) return false;
      if (typeof item.isTradeable === "function")
        return Boolean(item.isTradeable());
      if (typeof item.isTradeable === "boolean") return item.isTradeable;
      return Boolean(item.isTradeable);
    };
    const comparePoolItems = (a, b) => {
      const aClub =
        a?.pile === (services?.Item?.UTItemPileEnum?.CLUB ?? 7) ? 0 : 1;
      const bClub =
        b?.pile === (services?.Item?.UTItemPileEnum?.CLUB ?? 7) ? 0 : 1;
      if (aClub !== bClub) return aClub - bClub;
      const aStorage = a?.pile === storagePile ? 1 : 0;
      const bStorage = b?.pile === storagePile ? 1 : 0;
      if (aStorage !== bStorage) return aStorage - bStorage;
      const aTradeable = isItemTradeable(a) ? 1 : 0;
      const bTradeable = isItemTradeable(b) ? 1 : 0;
      if (aTradeable !== bTradeable) return aTradeable - bTradeable;
      return 0;
    };
    const markUsed = (item) => {
      const id = item?.id ?? null;
      const defId = item?.definitionId ?? null;
      if (id != null) {
        usedIds.add(id);
        usedIds.add(String(id));
      }
      if (defId != null) {
        usedDefIds.add(defId);
        usedDefIds.add(String(defId));
      }
    };

    const resolveIdToItem = (id) => {
      if (id == null) return null;
      let match = lookup?.get(id) ?? lookup?.get(String(id)) ?? null;
      if (match?.definitionId != null && usedDefIds.has(match.definitionId)) {
        const defKey = match.definitionId;
        const pool = poolByDefinition.get(defKey) ?? null;
        if (pool) {
          const candidates = pool.club
            .concat(pool.other)
            .concat(pool.storage)
            .filter((item) => item && !usedIds.has(item.id));
          if (candidates.length) {
            candidates.sort(comparePoolItems);
            match = candidates[0];
          }
        }
      }
      const item = match && typeof match === "object" ? match : null;
      if (item) return item;
      return createSquadPlayers([id], lookup)[0] ?? null;
    };

    for (let index = 0; index < slots.length; index += 1) {
      const slot = squadEntity?.getSlot?.(index) ?? slots[index];
      const item = resolveSlotItem(slot);
      const isBrick = resolveSlotBrick(slot);
      const isValid = resolveSlotValid(slot, item);
      const isLocked = resolveSlotLocked(slot);
      const keep =
        isBrick || isLocked === true || (preserveExistingValid && isValid);
      if (keep) {
        list[index] = item ?? null;
        markUsed(item);
      }
    }

    const slotIndices = slotSolution?.fieldSlotIndices;
    const slotIds = slotSolution?.fieldSlotToPlayerId;
    const slotDirected =
      Array.isArray(slotIndices) &&
      Array.isArray(slotIds) &&
      slotIndices.length &&
      slotIndices.length === slotIds.length;

    if (slotDirected) {
      const placements = [];
      for (let i = 0; i < slotIndices.length; i += 1) {
        const rawIndex = slotIndices[i];
        const rawId = slotIds[i];
        if (rawIndex == null || rawId == null) continue;
        const slotIndex =
          typeof rawIndex === "string" ? parseInt(rawIndex, 10) : rawIndex;
        if (!Number.isFinite(slotIndex)) continue;
        if (slotIndex < 0 || slotIndex >= list.length) continue;
        placements.push([slotIndex, rawId]);
      }

      placements.sort((a, b) => a[0] - b[0]);
      for (const [slotIndex, id] of placements) {
        if (list[slotIndex]) continue;
        if (usedIds.has(id) || usedIds.has(String(id))) continue;
        const item = resolveIdToItem(id);
        if (item) {
          list[slotIndex] = item;
          markUsed(item);
        }
      }
    }

    const desiredIds = slotDirected ? slotIds : ids;
    const remainingIds = (desiredIds || []).filter(
      (id) => !usedIds.has(id) && !usedIds.has(String(id)),
    );
    let cursor = 0;
    for (let index = 0; index < list.length; index += 1) {
      if (list[index]) continue;
      if (cursor >= remainingIds.length) break;
      const id = remainingIds[cursor];
      const item = resolveIdToItem(id);
      list[index] = item;
      markUsed(item);
      cursor += 1;
    }

    return list;
  };

  const resolveSlotPosition = (slot) =>
    slot?.position ??
    slot?.positionId ??
    slot?.pos ??
    slot?.positionName ??
    null;

  const buildSlotPlan = (playerSlots, challengeId) => {
    const slots = Array.isArray(playerSlots) ? playerSlots : [];
    const availableIndices = [];
    const lockedIndices = [];
    const positionIndices = [];
    for (let index = 0; index < slots.length; index += 1) {
      const slot = slots[index];
      const position = resolveSlotPosition(slot);
      const hasPosition = Boolean(position);
      const isLocked = resolveSlotLocked(slot);
      if (hasPosition) positionIndices.push(index);
      const available =
        hasPosition && (isLocked === null || isLocked === false);
      if (available) availableIndices.push(index);
      else if (isLocked === true) lockedIndices.push(index);
    }
    const plan = {
      challengeId,
      slotCount: slots.length,
      availableIndices,
      lockedIndices,
      positionIndices,
    };
    log("debug", "[EA Data] Solver slot plan", {
      challengeId,
      slotCount: plan.slotCount,
      availableCount: availableIndices.length,
      lockedCount: lockedIndices.length,
      positionCount: positionIndices.length,
    });
    return plan;
  };

  const getSlotPlanForChallenge = (challenge, loaded) => {
    if (!challenge) return null;
    if (currentSlotPlan?.challengeId === challenge.id) return currentSlotPlan;
    const slots =
      loaded?.data?.squad?.getPlayers?.() ??
      loaded?.squad?.getPlayers?.() ??
      challenge?.squad?.getPlayers?.() ??
      [];
    currentSlotPlan = buildSlotPlan(slots, challenge.id ?? null);
    return currentSlotPlan;
  };

  const saveChallenge = (challenge) =>
    sbcApiCall(
      "saveChallenge",
      () => observableToPromise(services.SBC.saveChallenge(challenge)),
      { minGapMs: SBC_AUTOMATION_MIN_GAP_MS, maxAttempts: 3 },
    );

  const applySolutionToChallenge = async (challenge, ids, options = {}) => {
    if (!challenge?.squad) return [];
    const lookupKey = options.lookupKey ?? "id";
    const playerById = options?.playerById ?? null;
    const getPlayerFromIdMap = (id) => {
      if (!playerById || id == null) return null;
      const key = String(id);
      try {
        if (typeof playerById.get === "function") {
          return playerById.get(key) ?? playerById.get(id) ?? null;
        }
      } catch {}
      try {
        if (typeof playerById === "object") {
          return playerById[key] ?? playerById[id] ?? null;
        }
      } catch {}
      return null;
    };
    const squadItemById = new Map();
    const squadItemsByDefinitionId = new Map(); // defId -> UTItemEntity[]
    try {
      for (const slot of challenge?.squad?.getPlayers?.() ?? []) {
        const item = resolveSlotItem(slot);
        if (!item) continue;
        const concept =
          typeof item?.isConcept === "function"
            ? item.isConcept()
            : Boolean(item?.concept);
        if (concept) continue;
        const id = item?.id ?? null;
        if (id == null || id === 0) continue;
        squadItemById.set(id, item);
        squadItemById.set(String(id), item);
        const defId = item?.definitionId ?? null;
        if (defId != null && defId !== 0) {
          if (!squadItemsByDefinitionId.has(defId)) {
            squadItemsByDefinitionId.set(defId, []);
            squadItemsByDefinitionId.set(
              String(defId),
              squadItemsByDefinitionId.get(defId),
            );
          }
          squadItemsByDefinitionId.get(defId).push(item);
        }
      }
    } catch {}
    const lookup = await getSquadLookupForSbc(lookupKey, {
      ignoreLoaned: true,
      excludeActiveSquad: true,
      raw: true,
      skipStats: true,
    });
    const ItemPile =
      services?.Item?.UTItemPileEnum ?? window?.UTItemPileEnum ?? {};
    const clubPile = ItemPile.CLUB ?? 7;
    const storagePile = ItemPile.STORAGE ?? 10;
    const uniqueItems = new Map();
    for (const item of lookup.values()) {
      if (!item || item.id == null) continue;
      if (!uniqueItems.has(item.id)) uniqueItems.set(item.id, item);
    }
    const poolByDefinition = new Map();
    for (const item of uniqueItems.values()) {
      const defId = item?.definitionId ?? null;
      if (defId == null) continue;
      if (!poolByDefinition.has(defId)) {
        poolByDefinition.set(defId, { club: [], storage: [], other: [] });
      }
      const pool = poolByDefinition.get(defId);
      if (item.pile === clubPile) pool.club.push(item);
      else if (item.pile === storagePile) pool.storage.push(item);
      else pool.other.push(item);
    }
    const usedIds = new Set();
    const markUsed = (item) => {
      if (!item) return;
      const id = item?.id ?? null;
      const defId = item?.definitionId ?? null;
      if (id != null) {
        usedIds.add(id);
        usedIds.add(String(id));
      }
      if (defId != null) {
        usedIds.add(defId);
        usedIds.add(String(defId));
      }
    };
    const isItemTradeable = (item) => {
      if (!item) return false;
      if (typeof item.isTradeable === "function")
        return Boolean(item.isTradeable());
      if (typeof item.isTradeable === "boolean") return item.isTradeable;
      return Boolean(item.isTradeable);
    };
    const comparePoolItems = (a, b) => {
      const aClub = a?.pile === clubPile ? 0 : 1;
      const bClub = b?.pile === clubPile ? 0 : 1;
      if (aClub !== bClub) return aClub - bClub;
      const aStorage = a?.pile === storagePile ? 1 : 0;
      const bStorage = b?.pile === storagePile ? 1 : 0;
      if (aStorage !== bStorage) return aStorage - bStorage;
      const aTradeable = isItemTradeable(a) ? 1 : 0;
      const bTradeable = isItemTradeable(b) ? 1 : 0;
      if (aTradeable !== bTradeable) return aTradeable - bTradeable;
      return 0;
    };
    const pickFromPool = (pool, preferClubOnly = false) => {
      if (!pool) return null;
      const ordered = preferClubOnly
        ? pool.club
        : [...pool.club, ...pool.other, ...pool.storage];
      const candidates = ordered.filter(
        (item) => item && !usedIds.has(item.id),
      );
      if (!candidates.length) return null;
      candidates.sort(comparePoolItems);
      return candidates[0] ?? null;
    };
    const requiredDefIds = new Set();
    for (const slot of challenge?.squad?.getPlayers?.() ?? []) {
      const item = resolveSlotItem(slot);
      const defId = item?.definitionId ?? null;
      if (defId == null || defId === 0) continue;
      requiredDefIds.add(defId);
      requiredDefIds.add(String(defId));
    }
    const pickItemForId = (id) => {
      const match = lookup?.get(id) ?? lookup?.get(String(id)) ?? null;
      if (!match) {
        // If the player is already placed in this SBC squad, prefer using that exact item.
        const inSquad =
          squadItemById.get(id) ?? squadItemById.get(String(id)) ?? null;
        if (inSquad?.id != null && !usedIds.has(inSquad.id)) return inSquad;

        // If the exact item id is missing from the lookup (stale snapshot, moved pile, etc),
        // try using the definitionId from the solver payload map and pick any available copy.
        const fallback = getPlayerFromIdMap(id);
        const fallbackDefId = readNumeric(fallback?.definitionId);
        if (fallbackDefId != null) {
          const pool =
            poolByDefinition.get(fallbackDefId) ??
            poolByDefinition.get(String(fallbackDefId)) ??
            null;
          const preferred = pickFromPool(pool);
          if (preferred) return preferred;

          // As a last resort, try using an already-placed item with the same definitionId.
          const squadPool =
            squadItemsByDefinitionId.get(fallbackDefId) ??
            squadItemsByDefinitionId.get(String(fallbackDefId)) ??
            null;
          if (Array.isArray(squadPool) && squadPool.length) {
            const candidate = squadPool.find(
              (item) => item?.id != null && !usedIds.has(item.id),
            );
            if (candidate) return candidate;
          }
        }
        return null;
      }
      const defId = match?.definitionId ?? null;
      const pool = defId != null ? poolByDefinition.get(defId) : null;
      if (match.pile === clubPile) {
        const preferred = pickFromPool(pool, true) ?? pickFromPool(pool);
        if (preferred) return preferred;
        return match;
      }
      if (requiredDefIds.has(defId) && pool?.club?.length) {
        const preferred = pickFromPool(pool, true) ?? pickFromPool(pool);
        if (preferred) return preferred;
      }
      if (match.pile === storagePile && pool?.club?.length) {
        const preferred = pickFromPool(pool, true) ?? pickFromPool(pool);
        if (preferred) return preferred;
      }
      if (match.id != null && !usedIds.has(match.id)) return match;
      return pickFromPool(pool);
    };
    const filteredIds = (ids || []).filter(
      (id) => !usedIds.has(id) && !usedIds.has(String(id)),
    );
    const chosenItems = filteredIds.map((id) => {
      const picked = pickItemForId(id);
      if (picked) markUsed(picked);
      return picked;
    });
    let applyIds = filteredIds.map((id, index) => chosenItems[index]?.id ?? id);
    const applyLookup = new Map();
    for (const item of chosenItems) {
      if (!item || item.id == null) continue;
      applyLookup.set(item.id, item);
      applyLookup.set(String(item.id), item);
    }
    const effectiveLookup = applyLookup.size ? applyLookup : lookup;
    const loadBeforeApply = await loadChallenge(challenge, true, {
      force: true,
    });
    const squadEntity =
      challenge?.squad ??
      loadBeforeApply?.data?.squad ??
      loadBeforeApply?.squad ??
      null;
    if (!squadEntity?.setPlayers) return [];
    const remapStorageDuplicates = (idsToRemap, lookupMap) => {
      const existingItems = squadEntity?.getPlayers?.() ?? [];
      const existingIds = new Set();
      const existingDefIds = new Set();
      for (const slot of existingItems) {
        const item = resolveSlotItem(slot);
        if (!item) continue;
        const id = item?.id ?? null;
        const defId = item?.definitionId ?? null;
        if (id != null) {
          existingIds.add(id);
          existingIds.add(String(id));
        }
        if (defId != null) {
          existingDefIds.add(defId);
          existingDefIds.add(String(defId));
        }
      }
      const used = new Set(existingIds);
      const remapped = [];
      for (const id of idsToRemap || []) {
        if (id == null) {
          remapped.push(id);
          continue;
        }
        const match = lookupMap?.get(id) ?? lookupMap?.get(String(id)) ?? null;
        if (!match) {
          remapped.push(id);
          continue;
        }
        const matchId = match?.id ?? id;
        const defId = match?.definitionId ?? null;
        const isStorage = match?.pile === storagePile;
        const hasExistingDef =
          defId != null &&
          (existingDefIds.has(defId) || existingDefIds.has(String(defId)));
        const alreadyUsed =
          matchId != null && (used.has(matchId) || used.has(String(matchId)));
        const needsRemap = alreadyUsed || (isStorage && hasExistingDef);
        if (!needsRemap) {
          remapped.push(matchId);
          if (matchId != null) {
            used.add(matchId);
            used.add(String(matchId));
          }
          continue;
        }
        const pool = defId != null ? poolByDefinition.get(defId) : null;
        const candidateLists = [
          pool?.club ?? [],
          pool?.other ?? [],
          pool?.storage ?? [],
        ];
        let replacement = null;
        for (const list of candidateLists) {
          for (const item of list) {
            if (!item || item.id == null) continue;
            if (used.has(item.id) || used.has(String(item.id))) continue;
            replacement = item;
            break;
          }
          if (replacement) break;
        }
        const chosenId = replacement?.id ?? matchId;
        remapped.push(chosenId);
        if (chosenId != null) {
          used.add(chosenId);
          used.add(String(chosenId));
        }
      }
      return remapped;
    };
    applyIds = remapStorageDuplicates(applyIds, effectiveLookup);
    const baseSlotSolution = options?.slotSolution ?? null;
    const effectiveSlotSolution =
      baseSlotSolution &&
      Array.isArray(baseSlotSolution.fieldSlotIndices) &&
      Array.isArray(baseSlotSolution.fieldSlotToPlayerId) &&
      baseSlotSolution.fieldSlotToPlayerId.length === applyIds.length
        ? { ...baseSlotSolution, fieldSlotToPlayerId: applyIds.slice() }
        : baseSlotSolution;
    const summarizeSquad = (
      playerSlots,
      label = "apply",
      expectedIds = applyIds,
    ) => {
      const slots = Array.isArray(playerSlots) ? playerSlots : [];
      const slotSummary = slots.map((slot, index) => {
        const item = slot?.item ?? slot ?? null;
        const id = item?.id ?? null;
        const definitionId = item?.definitionId ?? null;
        const position = resolveSlotPosition(slot);
        const isLocked = resolveSlotLocked(slot);
        const isEmpty = id == null || id === 0;
        const isEditable = isLocked == null ? true : !isLocked;
        return {
          index,
          position,
          id,
          definitionId,
          isLocked,
          isEmpty,
          isEditable,
        };
      });
      const appliedItems = slots
        .map((slot) => slot?.item ?? slot ?? null)
        .filter(
          (item) =>
            item &&
            ((item.id != null && item.id !== 0) ||
              (item.definitionId != null && item.definitionId !== 0)),
        );
      const appliedIds = appliedItems
        .map((item) => item?.id ?? null)
        .filter((value) => value != null && value !== 0);
      const appliedDefinitionIds = appliedItems
        .map((item) => item?.definitionId ?? null)
        .filter((value) => value != null && value !== 0);
      const appliedIdSet = new Set([
        ...appliedIds,
        ...appliedDefinitionIds,
        ...appliedIds.map((value) => String(value)),
        ...appliedDefinitionIds.map((value) => String(value)),
      ]);
      const missingAfterApply = (expectedIds || []).filter(
        (id) => !appliedIdSet.has(id) && !appliedIdSet.has(String(id)),
      );
      const missingDetails = missingAfterApply.map((id) => {
        const match = lookup?.get(id) ?? lookup?.get(String(id)) ?? null;
        return {
          id,
          matchId: match?.id ?? null,
          definitionId: match?.definitionId ?? null,
          pile: match?.pile ?? null,
          isTradeable: match?.isTradeable ?? null,
          isSpecial: match?.isSpecial ?? null,
          isEnrolledInAcademy: match?.isEnrolledInAcademy ?? null,
          owners: match?.owners ?? null,
          rarityId: match?.rarityId ?? null,
          rarityName: match?.rarityName ?? null,
          rating: match?.rating ?? null,
        };
      });
      const missingByDefinition = missingDetails.filter((detail) => {
        const defId = detail?.definitionId ?? null;
        if (defId == null) return false;
        return appliedIdSet.has(defId) || appliedIdSet.has(String(defId));
      });
      const conceptCount = appliedItems.reduce((total, item) => {
        const concept =
          typeof item?.isConcept === "function"
            ? item.isConcept()
            : Boolean(item?.concept);
        return concept ? total + 1 : total;
      }, 0);
      log("debug", "[EA Data] Solver apply result", {
        label,
        requested: expectedIds?.length ?? 0,
        applied: appliedItems.length,
        slotCount: slots.length,
        conceptCount,
        missingAfterApply,
        missingDetails,
        missingByDefinition,
        slotSummary: slotSummary.filter(
          (entry) => entry.id != null || entry.definitionId != null,
        ),
        slotEmptyCount: slotSummary.filter(
          (entry) => entry.id == null || entry.id === 0,
        ).length,
      });
      return { missingAfterApply, slotSummary };
    };
    const resolved = [];
    const unresolvedIds = [];
    for (const id of applyIds || []) {
      if (id == null) continue;
      const match =
        effectiveLookup?.get(id) ?? effectiveLookup?.get(String(id)) ?? null;
      if (!match) {
        unresolvedIds.push(id);
        continue;
      }
      resolved.push({
        id,
        matchId: match.id ?? null,
        definitionId: match.definitionId ?? null,
        pile: match.pile ?? null,
      });
    }
    log("debug", "[EA Data] Solver apply lookup", {
      lookupKey,
      requested: applyIds?.length ?? 0,
      resolved: resolved.length,
      unresolvedIds,
      resolvedPiles: resolved.reduce((acc, item) => {
        const key = item.pile ?? "unknown";
        acc[key] = (acc[key] || 0) + 1;
        return acc;
      }, {}),
    });
    const resolvedItems = (applyIds || [])
      .map(
        (id) =>
          effectiveLookup?.get(id) ?? effectiveLookup?.get(String(id)) ?? null,
      )
      .filter(Boolean);
    const moveCandidates = resolvedItems.filter(
      (item) => item?.pile === storagePile,
    );
    const movedCount = await moveItemsToClub(moveCandidates);
    if (movedCount > 0) {
      const refreshedLookup = await getSquadLookupForSbc(lookupKey, {
        ignoreLoaned: true,
        excludeActiveSquad: true,
        raw: true,
        skipStats: true,
      });
      applyLookup.clear();
      for (const id of applyIds || []) {
        const match =
          refreshedLookup?.get(id) ?? refreshedLookup?.get(String(id)) ?? null;
        if (!match || match.id == null) continue;
        applyLookup.set(match.id, match);
        applyLookup.set(String(match.id), match);
      }
    }
    const preserveExistingValid = options?.preserveExistingValid !== false;
    const playersToApply = buildPreservedSlotList(
      squadEntity,
      applyIds,
      applyLookup.size ? applyLookup : effectiveLookup,
      effectiveSlotSolution,
      preserveExistingValid,
    );

    // Never apply concept players (EA rejects save/submit with 475 and shows "Ineligible Squad").
    const conceptItems = playersToApply.filter((item) => {
      if (!item) return false;
      try {
        if (typeof item?.isConcept === "function")
          return Boolean(item.isConcept());
      } catch {}
      return Boolean(item?.concept);
    });
    if (conceptItems.length) {
      throw new Error(
        `Cannot apply squad: ${conceptItems.length} player(s) missing from club/storage (concept cards).`,
      );
    }
    squadEntity.removeAllItems?.();
    squadEntity.setPlayers(playersToApply, true);
    const saveRes = await saveChallenge(challenge);
    if (isSbcAutomationActive() && saveRes?.success !== true) {
      throw new Error(
        `saveChallenge failed (status ${saveRes?.status ?? "?"}, error ${saveRes?.error ?? "?"})`,
      );
    }

    // FC Enhancer pattern: hydrate applied items from DAO load, then push them
    // into the original challenge squad instance to keep UI interactions intact.
    const resolveLoadedSquadEntity = (loaded) =>
      loaded?.data?.squad ?? loaded?.squad ?? null;
    const lastLoaded = await loadChallenge(challenge, true, { force: true });
    let canonicalSquadEntity =
      resolveLoadedSquadEntity(lastLoaded) ?? squadEntity ?? null;
    let attemptSlots =
      canonicalSquadEntity?.getPlayers?.() ??
      lastLoaded?.data?.squad?.getPlayers?.() ??
      squadEntity?.getPlayers?.() ??
      lastLoaded?.data?.squad ??
      squadEntity ??
      [];
    const attemptSummary = summarizeSquad(attemptSlots, "apply");
    if (attemptSummary?.missingAfterApply?.length) {
      const refreshedLookup = await getSquadLookupForSbc(lookupKey, {
        ignoreLoaned: true,
        excludeActiveSquad: true,
        raw: true,
        skipStats: true,
      });
      const missingItems = attemptSummary.missingAfterApply
        .map(
          (id) =>
            refreshedLookup?.get(id) ??
            refreshedLookup?.get(String(id)) ??
            null,
        )
        .filter(Boolean);
      const movedMissing = await moveItemsToClub(missingItems);
      if (movedMissing > 0) {
        const updatedLookup = await getSquadLookupForSbc(lookupKey, {
          ignoreLoaned: true,
          excludeActiveSquad: true,
          raw: true,
          skipStats: true,
        });
        applyLookup.clear();
        for (const id of applyIds || []) {
          const match =
            updatedLookup?.get(id) ?? updatedLookup?.get(String(id)) ?? null;
          if (!match || match.id == null) continue;
          applyLookup.set(match.id, match);
          applyLookup.set(String(match.id), match);
        }
      }
      const retryPlayersToApply = buildPreservedSlotList(
        squadEntity,
        applyIds,
        applyLookup.size ? applyLookup : refreshedLookup,
        effectiveSlotSolution,
        preserveExistingValid,
      );
      const retryConceptItems = retryPlayersToApply.filter((item) => {
        if (!item) return false;
        try {
          if (typeof item?.isConcept === "function")
            return Boolean(item.isConcept());
        } catch {}
        return Boolean(item?.concept);
      });
      if (retryConceptItems.length) {
        throw new Error(
          `Cannot apply squad: ${retryConceptItems.length} player(s) missing from club/storage (concept cards).`,
        );
      }
      squadEntity.removeAllItems?.();
      squadEntity.setPlayers(retryPlayersToApply, true);
      await delay(0.5);
      const saveRetryRes = await saveChallenge(challenge);
      if (isSbcAutomationActive() && saveRetryRes?.success !== true) {
        throw new Error(
          `saveChallenge failed (status ${saveRetryRes?.status ?? "?"}, error ${saveRetryRes?.error ?? "?"})`,
        );
      }
      const retryLoaded = await loadChallenge(challenge, true, {
        force: true,
      });
      canonicalSquadEntity =
        resolveLoadedSquadEntity(retryLoaded) ??
        canonicalSquadEntity ??
        squadEntity ??
        null;
      attemptSlots =
        canonicalSquadEntity?.getPlayers?.() ??
        retryLoaded?.data?.squad?.getPlayers?.() ??
        squadEntity?.getPlayers?.() ??
        retryLoaded?.data?.squad ??
        squadEntity ??
        [];
      summarizeSquad(attemptSlots, "apply-retry");
    }

    const finalItems = Array.isArray(attemptSlots)
      ? attemptSlots.map((slot) => resolveSlotItem(slot) ?? slot ?? null)
      : [];

    // Keep using the original squad object (panel/interaction bindings usually
    // live on this instance), then notify challenge data change.
    const finalSquadForUi = squadEntity ?? canonicalSquadEntity ?? null;
    if (finalSquadForUi && typeof finalSquadForUi?.setPlayers === "function") {
      finalSquadForUi.setPlayers(finalItems, true);
    }
    try {
      challenge.squad = finalSquadForUi;
    } catch {}
    const notifyPayload = { squad: finalSquadForUi ?? null };
    try {
      challenge?.onDataChange?.notify?.(notifyPayload);
    } catch {}

    // Applying a squad can move items from storage -> club; invalidate cached snapshots
    // so the next solve/fetch reflects the updated piles.
    try {
      clearPlayersSnapshotCache();
    } catch {}
    return finalItems;
  };

  const getChallengesBySetIdsRaw = async (setIds) => {
    const ids = Array.isArray(setIds) ? new Set(setIds) : setIds;
    const { data } = await observableToPromise(services.SBC.requestSets());
    const sets = (data?.sets ?? []).filter((s) => ids.has(s.id));

    for (const set of sets) {
      if (!set.isComplete?.()) {
        await observableToPromise(services.SBC.requestChallengesForSet(set));
        await delay(2.5);
      }
    }

    const challenges = sets.flatMap((s) => s.getChallenges?.() ?? []);
    return challenges.filter((c) => !c.isCompleted?.());
  };

  const getChallengesBySetIds = async (setIds) => {
    const raw = await getChallengesBySetIdsRaw(setIds);
    return raw.map(toPlainChallenge);
  };

  const sortSetChallengesForSolver = (list) => {
    const challenges = Array.isArray(list) ? list.filter(Boolean) : [];
    const incomplete = challenges.filter(
      (c) => c?.status !== "COMPLETED" && !Boolean(c?.isCompleted?.()),
    );
    return incomplete.sort((a, b) => {
      const an = String(a?.name ?? "");
      const bn = String(b?.name ?? "");
      const cmp = an.localeCompare(bn);
      if (cmp) return cmp;
      return (readNumeric(a?.id) ?? 0) - (readNumeric(b?.id) ?? 0);
    });
  };

  const SET_CHALLENGE_INFO_PREFETCH_TTL_MS = 45 * 1000;
  const setChallengeInfoPrefetchCacheBySetId = new Map();
  const setChallengeInfoPrefetchInFlightBySetId = new Map();

  const normalizeSetIdKey = (setId) => {
    const numeric = readNumeric(setId);
    return numeric == null ? null : String(numeric);
  };

  const getSetChallengeInfoPrefetchEntry = (
    setId,
    { ttlMs = SET_CHALLENGE_INFO_PREFETCH_TTL_MS } = {},
  ) => {
    const key = normalizeSetIdKey(setId);
    if (!key) return null;
    const cached = setChallengeInfoPrefetchCacheBySetId.get(key) ?? null;
    if (!cached) return null;
    if (Date.now() - (cached.at ?? 0) > Math.max(1000, ttlMs)) return null;
    return cached;
  };

  const getPrefetchedSetChallenges = (
    setId,
    { ttlMs = SET_CHALLENGE_INFO_PREFETCH_TTL_MS } = {},
  ) => {
    const entry = getSetChallengeInfoPrefetchEntry(setId, { ttlMs });
    return Array.isArray(entry?.challenges) ? entry.challenges : null;
  };

  const getPrefetchedSetRequirementsByChallengeId = (
    setId,
    { ttlMs = SET_CHALLENGE_INFO_PREFETCH_TTL_MS } = {},
  ) => {
    const entry = getSetChallengeInfoPrefetchEntry(setId, { ttlMs });
    return entry?.requirementsByChallengeId instanceof Map
      ? entry.requirementsByChallengeId
      : null;
  };

  const clearSetChallengeInfoPrefetchCache = (setId = null) => {
    const key = normalizeSetIdKey(setId);
    if (key) {
      setChallengeInfoPrefetchCacheBySetId.delete(key);
      setChallengeInfoPrefetchInFlightBySetId.delete(key);
      return;
    }
    setChallengeInfoPrefetchCacheBySetId.clear();
    setChallengeInfoPrefetchInFlightBySetId.clear();
  };

  const upsertPrefetchedSetChallenges = (setId, challenges) => {
    const key = normalizeSetIdKey(setId);
    const normalizedSetId = readNumeric(setId);
    if (!key || normalizedSetId == null) return;
    const existing = setChallengeInfoPrefetchCacheBySetId.get(key) ?? null;
    const nextChallenges = Array.isArray(challenges) ? challenges : [];
    const requirementsByChallengeId =
      existing?.requirementsByChallengeId instanceof Map
        ? existing.requirementsByChallengeId
        : new Map();
    setChallengeInfoPrefetchCacheBySetId.set(key, {
      at: Date.now(),
      reason: existing?.reason ?? "upsert",
      setId: normalizedSetId,
      challenges: nextChallenges,
      requirementsByChallengeId,
    });
  };

  const upsertPrefetchedSetRequirement = (setId, challengeId, value) => {
    const key = normalizeSetIdKey(setId);
    const normalizedSetId = readNumeric(setId);
    const challengeKey = challengeId == null ? null : String(challengeId);
    if (!key || normalizedSetId == null || !challengeKey) return;
    const existing = setChallengeInfoPrefetchCacheBySetId.get(key) ?? null;
    const requirementsByChallengeId =
      existing?.requirementsByChallengeId instanceof Map
        ? new Map(existing.requirementsByChallengeId)
        : new Map();
    requirementsByChallengeId.set(challengeKey, value);
    setChallengeInfoPrefetchCacheBySetId.set(key, {
      at: Date.now(),
      reason: existing?.reason ?? "upsert",
      setId: normalizedSetId,
      challenges: Array.isArray(existing?.challenges) ? existing.challenges : [],
      requirementsByChallengeId,
    });
  };

  const prefetchSetChallengeInfo = async (
    setId,
    { reason = "unknown", force = false } = {},
  ) => {
    const key = normalizeSetIdKey(setId);
    const normalizedSetId = readNumeric(setId);
    if (!key || normalizedSetId == null) {
      return {
        setId: null,
        challenges: [],
        requirementsByChallengeId: new Map(),
        fromCache: false,
      };
    }

    if (!force) {
      const cached = getSetChallengeInfoPrefetchEntry(normalizedSetId);
      if (cached) {
        return {
          setId: normalizedSetId,
          challenges: Array.isArray(cached?.challenges) ? cached.challenges : [],
          requirementsByChallengeId:
            cached?.requirementsByChallengeId instanceof Map
              ? cached.requirementsByChallengeId
              : new Map(),
          fromCache: true,
        };
      }
      const inFlight = setChallengeInfoPrefetchInFlightBySetId.get(key) ?? null;
      if (inFlight) return inFlight;
    }

    const promise = (async () => {
      const rawChallenges = await getChallengesBySetIdsRaw([normalizedSetId]);
      const challenges = sortSetChallengesForSolver(rawChallenges);
      upsertPrefetchedSetChallenges(normalizedSetId, challenges);
      const requirementsByChallengeId = new Map();

      for (const challenge of challenges) {
        const challengeId = challenge?.id == null ? null : String(challenge.id);
        if (!challengeId) continue;
        const challengeName =
          challenge?.name ?? challenge?.title ?? `Challenge ${challengeId}`;
        let snapshot = buildRequirementsSnapshot(challenge, null);
        let source = "snapshot-local";
        try {
          const loaded = await loadChallenge(challenge, true, { force: true });
          snapshot = buildRequirementsSnapshot(challenge, loaded?.data ?? loaded);
          source = "snapshot-loaded";
        } catch {}
        requirementsByChallengeId.set(challengeId, {
          challengeId,
          challengeName,
          snapshot,
          source,
          status: "ready",
          updatedAt: Date.now(),
          errorMessage: null,
        });
        upsertPrefetchedSetRequirement(normalizedSetId, challengeId, {
          challengeId,
          challengeName,
          snapshot,
          source,
          status: "ready",
          updatedAt: Date.now(),
          errorMessage: null,
        });
      }

      const cacheEntry = {
        at: Date.now(),
        reason,
        setId: normalizedSetId,
        challenges,
        requirementsByChallengeId,
      };
      setChallengeInfoPrefetchCacheBySetId.set(key, cacheEntry);
      return {
        setId: normalizedSetId,
        challenges,
        requirementsByChallengeId,
        fromCache: false,
      };
    })().finally(() => {
      setChallengeInfoPrefetchInFlightBySetId.delete(key);
    });

    setChallengeInfoPrefetchInFlightBySetId.set(key, promise);
    return promise;
  };

  // Fetches a single challenge entity by ID for submission purposes.
  // Unlike getChallengesBySetIdsRaw this always forces a server refresh
  // and never filters by completion status, so repeatable-set challenges
  // are always returned even when the set momentarily appears complete
  // between repeat cycles.
  // Falls back to name matching if the ID is not found (EA may
  // re-instantiate repeat-cycle challenges with new IDs).
  const getChallengeEntityForSubmission = async (
    setId,
    challengeId,
    challengeName = null,
  ) => {
    const { data } = await sbcApiCall(
      "requestSets",
      () => observableToPromise(services.SBC.requestSets()),
      { minGapMs: SBC_AUTOMATION_MIN_GAP_MS, maxAttempts: 2 },
    );
    const sets = (data?.sets ?? []).filter((s) => s.id === setId);
    for (const set of sets) {
      await sbcApiCall(
        "requestChallengesForSet",
        () => observableToPromise(services.SBC.requestChallengesForSet(set)),
        { minGapMs: SBC_AUTOMATION_MIN_GAP_MS, maxAttempts: 2 },
      );
    }
    const challenges = sets.flatMap((s) => s.getChallenges?.() ?? []);
    // Prefer exact ID match.
    const byId =
      challenges.find((c) => String(c?.id) === String(challengeId)) ?? null;
    if (byId) return byId;
    // Fallback: match by name (EA may re-instantiate repeatable challenges
    // with fresh IDs between cycles).
    if (challengeName) {
      const byName =
        challenges.find(
          (c) => (c?.name ?? c?.title) === challengeName && !c.isCompleted?.(),
        ) ?? null;
      if (byName) return byName;
    }
    return null;
  };

  const toChallengePayload = (challenge) => {
    if (!challenge) return null;
    return {
      id: challenge.id,
      setId: challenge.setId,
      name: challenge.name ?? challenge.title ?? null,
      status: challenge.status ?? null,
    };
  };

  const extractRequirements = (source, depth = 0) => {
    if (!source || depth > 2) return null;
    if (Array.isArray(source)) return source;

    const direct =
      source?.eligibilityRequirements ??
      source?.requirements ??
      source?.requirementsList ??
      (typeof source?.getRequirements === "function"
        ? source.getRequirements()
        : null);
    if (Array.isArray(direct)) return direct;

    const candidates = [
      source?.challenge,
      source?.sbcChallenge,
      source?.data?.challenge,
      source?.data?.sbcChallenge,
    ];

    for (const candidate of candidates) {
      const extracted = extractRequirements(candidate, depth + 1);
      if (extracted) return extracted;
    }

    return null;
  };

  const readKvPairs = (req) => {
    const kv = req?.kvPairs;
    if (!kv) return [];
    const parseKey = (key) =>
      typeof key === "string" ? parseInt(key, 10) : key;
    if (Array.isArray(kv)) {
      const pairs = [];
      for (const entry of kv) {
        if (!entry) continue;
        if (Array.isArray(entry) && entry.length >= 2) {
          pairs.push({ key: parseKey(entry[0]), value: entry[1] });
        } else if (typeof entry === "object" && "key" in entry) {
          pairs.push({ key: parseKey(entry.key), value: entry.value });
        }
      }
      if (pairs.length) return pairs;
    }
    try {
      const rawCollection =
        kv._collection ?? (typeof kv === "object" ? kv : null);
      const keys =
        typeof kv.keys === "function"
          ? Array.from(kv.keys())
          : rawCollection
            ? Object.keys(rawCollection)
            : [];
      return keys.map((key) => {
        const value =
          typeof kv.get === "function" ? kv.get(key) : rawCollection?.[key];
        return { key: parseKey(key), value };
      });
    } catch {
      try {
        const rawCollection = kv?._collection ?? kv;
        if (!rawCollection || typeof rawCollection !== "object") return [];
        return Object.keys(rawCollection).map((key) => {
          return { key: parseKey(key), value: rawCollection[key] };
        });
      } catch {
        return [];
      }
    }
  };

  const getEligibilityScopeName = (scope) => {
    if (typeof SBCEligibilityScope !== "undefined") {
      const name = SBCEligibilityScope[scope];
      if (name) return name;
    }
    if (scope === 0) return "MIN";
    if (scope === 1) return "MAX";
    if (scope === 2) return "EXACT";
    if (scope === 3) return "RANGE";
    return null;
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

  const LOCAL_SBC_ELIGIBILITY_KEY_ENUM = {
    0: "TEAM_STAR_RATING",
    2: "PLAYER_COUNT",
    3: "PLAYER_QUALITY",
    4: "SAME_NATION_COUNT",
    5: "SAME_LEAGUE_COUNT",
    6: "SAME_CLUB_COUNT",
    7: "NATION_COUNT",
    8: "LEAGUE_COUNT",
    9: "CLUB_COUNT",
    10: "NATION_ID",
    11: "LEAGUE_ID",
    12: "CLUB_ID",
    13: "SCOPE",
    15: "LEGEND_COUNT",
    16: "NUM_TROPHY_REQUIRED",
    17: "PLAYER_LEVEL",
    18: "PLAYER_RARITY",
    19: "TEAM_RATING",
    21: "PLAYER_COUNT_COMBINED",
    25: "PLAYER_RARITY_GROUP",
    26: "PLAYER_MIN_OVR",
    27: "PLAYER_EXACT_OVR",
    28: "PLAYER_MAX_OVR",
    30: "FIRST_OWNER_PLAYERS_COUNT",
    33: "PLAYER_TRADABILITY",
    35: "CHEMISTRY_POINTS",
    36: "ALL_PLAYERS_CHEMISTRY_POINTS",
  };

  const resolveEligibilityKeyEnum = () => {
    if (typeof SBCEligibilityKeyEnum !== "undefined")
      return SBCEligibilityKeyEnum;
    if (window?.SBCEligibilityKeyEnum) return window.SBCEligibilityKeyEnum;
    if (services?.SBC?.SBCEligibilityKeyEnum)
      return services.SBC.SBCEligibilityKeyEnum;
    if (services?.SBC?.eligibilityKeyEnum)
      return services.SBC.eligibilityKeyEnum;
    return LOCAL_SBC_ELIGIBILITY_KEY_ENUM;
  };

  const getEligibilityKeyName = (key) => {
    if (key === -1) return "PLAYERS_IN_SQUAD";
    const enumRef = resolveEligibilityKeyEnum();
    if (!enumRef) return null;
    if (enumRef[key]) return enumRef[key];
    if (typeof key === "string" && enumRef[parseInt(key, 10)]) {
      return enumRef[parseInt(key, 10)];
    }
    return null;
  };

  const normalizeKeyName = (name) => {
    if (!name) return null;
    return String(name)
      .replace(/([a-z])([A-Z])/g, "$1_$2")
      .replace(/[^a-zA-Z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .toLowerCase();
  };

  const deriveTypeFromLabel = (label) => {
    if (!label) return null;
    const text = String(label).toLowerCase();
    if (text.includes("number of players in the squad"))
      return "players_in_squad";
    if (text.includes("team rating")) return "team_rating";
    if (text.includes("total chemistry") || text.includes("team chemistry"))
      return "total_chemistry";
    if (text.includes("clubs in squad")) return "clubs_in_squad";
    if (text.includes("leagues in squad")) return "leagues_in_squad";
    if (
      text.includes("countries/regions in squad") ||
      text.includes("countries in squad") ||
      text.includes("nations in squad")
    ) {
      return "countries_in_squad";
    }
    if (text.includes("players from the same league"))
      return "players_same_league";
    if (text.includes("players from the same club")) return "players_same_club";
    if (
      text.includes("players from the same countries") ||
      text.includes("players from the same country") ||
      text.includes("players from the same nations")
    ) {
      return "players_same_nation";
    }
    if (text.includes("player quality")) return "player_quality";
    if (text.includes("player level")) return "player_level";
    if (text.includes("rare")) return "player_rarity";
    if (
      text.includes("totw") ||
      text.includes("team of the week") ||
      text.includes("inform")
    ) {
      return "player_inform";
    }
    if (text.includes("loan")) return "loan_players";
    return null;
  };

  const normalizeKvValue = (value) => {
    if (Array.isArray(value))
      return value.map((item) => readNumeric(item) ?? item);
    if (value && typeof value === "object") {
      if (Array.isArray(value.values)) return value.values;
      if (value._collection) return value._collection;
    }
    return readNumeric(value) ?? value ?? null;
  };

  const readNumeric = (value) => {
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (typeof value === "string") {
      const parsed = parseInt(value, 10);
      return Number.isFinite(parsed) ? parsed : null;
    }
    if (value && typeof value.getValue === "function")
      return readNumeric(value.getValue());
    return null;
  };

  const findNumericField = (obj, keys) => {
    if (!obj) return null;
    for (const key of keys) {
      if (!Object.prototype.hasOwnProperty.call(obj, key)) continue;
      const numeric = readNumeric(obj[key]);
      if (numeric != null) return numeric;
    }
    return null;
  };

  const findNumericFieldDeep = (obj, keys, depth = 0, visited = new Set()) => {
    if (!obj || typeof obj !== "object" || depth > 2) return null;
    if (visited.has(obj)) return null;
    visited.add(obj);

    const direct = findNumericField(obj, keys);
    if (direct != null) return direct;

    for (const key of Object.getOwnPropertyNames(obj)) {
      let value;
      try {
        value = obj[key];
      } catch {
        continue;
      }
      if (!value || typeof value !== "object") continue;
      const nested = findNumericFieldDeep(value, keys, depth + 1, visited);
      if (nested != null) return nested;
    }

    return null;
  };

  const collectNumericCandidates = (
    obj,
    depth = 0,
    path = "",
    visited = new Set(),
  ) => {
    const results = [];
    if (!obj || typeof obj !== "object" || depth > 2) return results;
    if (visited.has(obj)) return results;
    visited.add(obj);

    for (const key of Object.getOwnPropertyNames(obj)) {
      let value;
      try {
        value = obj[key];
      } catch {
        continue;
      }
      const nextPath = path ? `${path}.${key}` : key;
      if (typeof value === "number" && Number.isFinite(value)) {
        if (/squad|player|size|count|num|min|max|required/i.test(key)) {
          results.push({ path: nextPath, value });
        }
        continue;
      }
      if (value && typeof value === "object") {
        results.push(
          ...collectNumericCandidates(value, depth + 1, nextPath, visited),
        );
      }
    }

    return results;
  };

  const getSquadSizeRequirement = (sources) => {
    const keys = [
      "squadSize",
      "squadSizeRequirement",
      "squadSizeMin",
      "minSquadSize",
      "playersInSquadRequirement",
      "minSquadPlayers",
      "squadRequirement",
      "numOfRequiredPlayers",
      "requiredPlayers",
      "requiredPlayerCount",
      "minPlayers",
      "playersInSquad",
      "numPlayers",
      "numPlayersRequired",
      "playersRequired",
    ];
    for (const source of sources) {
      if (source && typeof source.getNumOfRequiredPlayers === "function") {
        const value = readNumeric(source.getNumOfRequiredPlayers());
        if (value != null && value > 0) return value;
      }
      if (source && typeof source.getSquadSize === "function") {
        const value = readNumeric(source.getSquadSize());
        if (value != null && value > 0) return value;
      }
      if (source && typeof source.getRequiredPlayers === "function") {
        const value = readNumeric(source.getRequiredPlayers());
        if (value != null && value > 0) return value;
      }
      if (source && typeof source.getRequiredPlayerCount === "function") {
        const value = readNumeric(source.getRequiredPlayerCount());
        if (value != null && value > 0) return value;
      }
      if (source && typeof source.getMinPlayers === "function") {
        const value = readNumeric(source.getMinPlayers());
        if (value != null && value > 0) return value;
      }
      const numeric =
        findNumericField(source, keys) ?? findNumericFieldDeep(source, keys);
      if (numeric != null && numeric > 0) return numeric;
    }
    return null;
  };

  const normalizeRequirement = (req) => {
    if (!req) return null;
    const scope =
      req.scope ?? (typeof req.getScope === "function" ? req.getScope() : null);
    const count =
      req.count ?? (typeof req.getCount === "function" ? req.getCount() : null);
    const isCombined =
      typeof req.isCombinedRequirement === "function"
        ? req.isCombinedRequirement()
        : typeof req.isCombinedRequirement === "boolean"
          ? req.isCombinedRequirement
          : typeof req.isCombined === "boolean"
            ? req.isCombined
            : null;
    const label =
      typeof req.buildString === "function"
        ? req.buildString()
        : (req.buildString ??
          req.label ??
          (typeof req.getLabel === "function" ? req.getLabel() : null));

    return {
      scope,
      count,
      isCombined,
      label,
      kvPairs: readKvPairs(req),
    };
  };

  const isPlayersInSquadRequirement = (req) => {
    if (!req) return false;
    const kvPairs = readKvPairs(req);
    for (const { key } of kvPairs) {
      const keyNumber = typeof key === "string" ? parseInt(key, 10) : key;
      if (keyNumber === -1 || keyNumber === 2 || keyNumber === 21) return true;
      const keyName = getEligibilityKeyName(keyNumber);
      if (keyName && /PLAYER_COUNT|PLAYERS_IN_SQUAD/i.test(keyName))
        return true;
    }
    const label =
      typeof req.buildString === "function"
        ? req.buildString()
        : (req.label ?? req.buildString ?? null);
    if (!label) return false;
    return /players? in (the )?squad/i.test(label);
  };

  const dedupeSquadSizeRequirements = (requirements) => {
    const list = Array.isArray(requirements) ? requirements : [];
    const candidates = list.filter(isPlayersInSquadRequirement);
    if (candidates.length <= 1) return list;
    const countFor = (req) =>
      req?.count ??
      (typeof req?.getCount === "function" ? req.getCount() : null);
    let preferred = candidates.find((req) => {
      const count = countFor(req);
      return count != null && count > 0;
    });
    if (!preferred) {
      preferred = candidates.find((req) =>
        readKvPairs(req).some(({ key }) => Number(key) === -1),
      );
    }
    if (!preferred) preferred = candidates[0];
    return list.filter(
      (req) => !isPlayersInSquadRequirement(req) || req === preferred,
    );
  };

  const serializeRequirementForSolver = (req) => {
    if (!req || typeof req !== "object") return req;
    const kvPairs = Array.isArray(req.kvPairs) ? req.kvPairs : readKvPairs(req);
    const kvPlain = Object.fromEntries(
      (kvPairs || []).map(({ key, value }) => [key, value]),
    );
    return {
      scope:
        req.scope ??
        (typeof req.getScope === "function" ? req.getScope() : null),
      count:
        req.count ??
        (typeof req.getCount === "function" ? req.getCount() : null),
      isCombinedRequirement:
        typeof req.isCombinedRequirement === "function"
          ? req.isCombinedRequirement()
          : (req.isCombinedRequirement ?? req.isCombined ?? null),
      label:
        typeof req.buildString === "function"
          ? req.buildString()
          : (req.buildString ?? req.label ?? null),
      kvPairs: kvPlain,
    };
  };

  const serializeNormalizedRequirementForSolver = (rule) => {
    if (!rule || typeof rule !== "object") return rule;
    return {
      type: rule.type ?? null,
      key: rule.key ?? null,
      keyName: rule.keyName ?? null,
      keyNameNormalized: rule.keyNameNormalized ?? null,
      typeSource: rule.typeSource ?? null,
      op: rule.op ?? null,
      count: rule.count ?? null,
      derivedCount: rule.derivedCount ?? null,
      value: rule.value ?? null,
      scope: rule.scope ?? null,
      scopeName: rule.scopeName ?? null,
      label: rule.label ?? null,
    };
  };

  const appendSquadSizeRequirement = (requirements, count) => {
    const list = Array.isArray(requirements) ? requirements : [];
    if (!count || list.some(isPlayersInSquadRequirement)) return list;
    const exactScope =
      typeof SBCEligibilityScope !== "undefined"
        ? SBCEligibilityScope.EXACT
        : null;
    return list.concat({
      scope: exactScope,
      count,
      isCombinedRequirement: false,
      label: `Number of Players in the Squad: ${count}`,
      kvPairs: [{ key: -1, value: [count] }],
      __eaDataSynthetic: true,
    });
  };

  const normalizeRequirements = (source) => {
    const raw = Array.isArray(source) ? source : extractRequirements(source);
    if (!raw || !Array.isArray(raw)) return [];
    return raw.map(normalizeRequirement).filter(Boolean);
  };

  const missingEligibilityKeyLog = new Set();
  // Some SBC requirement types encode their numeric target inside `value` with `count = -1`.
  // Others (ex: `player_quality`) use numeric enum values, so we must NOT treat `value` as a count.
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

  const normalizeRequirementsToRulesFromList = (requirements) => {
    const raw = Array.isArray(requirements) ? requirements : [];
    if (!raw.length) return [];

    return raw.flatMap((req) => {
      if (!req) return [];
      const scope =
        req.scope ??
        (typeof req.getScope === "function" ? req.getScope() : null);
      const scopeName = getEligibilityScopeName(scope);
      const op = scopeNameToOp(scopeName);
      const count =
        req.count ??
        (typeof req.getCount === "function" ? req.getCount() : null);
      const label =
        typeof req.buildString === "function"
          ? req.buildString()
          : (req.buildString ?? req.label ?? null);

      const kvPairs = readKvPairs(req);
      if (!kvPairs.length) {
        return [
          {
            type: null,
            key: null,
            keyName: null,
            keyNameNormalized: null,
            op,
            count,
            value: null,
            scope,
            scopeName,
            label,
          },
        ];
      }

      return kvPairs.map(({ key, value }) => {
        const keyNumber = typeof key === "string" ? parseInt(key, 10) : key;
        const keyName = getEligibilityKeyName(keyNumber);
        const keyNameNormalized =
          normalizeKeyName(keyName) ?? `key_${keyNumber}`;
        const labelType = deriveTypeFromLabel(label);
        const type =
          keyNumber === -1
            ? "players_in_squad"
            : keyNameNormalized.startsWith("key_") && labelType
              ? labelType
              : keyNameNormalized;
        const normalizedValue = normalizeKvValue(value);
        const derivedCount = (() => {
          if (count !== -1) return null;
          if (!DERIVED_COUNT_ALLOWED_TYPES.has(type)) return null;
          if (typeof normalizedValue === "number") return normalizedValue;
          if (
            Array.isArray(normalizedValue) &&
            normalizedValue.length === 1 &&
            typeof normalizedValue[0] === "number"
          ) {
            return normalizedValue[0];
          }
          return null;
        })();

        if (!keyName && keyNumber !== -1) {
          const signature = `${keyNumber}:${label ?? ""}`;
          if (!missingEligibilityKeyLog.has(signature)) {
            missingEligibilityKeyLog.add(signature);
            console.log("[EA Data] SBC unknown eligibility key", {
              key: keyNumber,
              label,
              scope,
              scopeName,
              value: normalizedValue,
            });
          }
        }

        return {
          type,
          key: keyNumber,
          keyName,
          keyNameNormalized,
          typeSource: keyName ? "enum" : labelType ? "label" : "key",
          op,
          count,
          derivedCount,
          value: normalizedValue,
          scope,
          scopeName,
          label,
        };
      });
    });
  };

  const normalizeRequirementsToRules = (source) => {
    const raw = Array.isArray(source) ? source : extractRequirements(source);
    return normalizeRequirementsToRulesFromList(raw);
  };

  const loadChallenge = async (challenge, useDao = false, options = {}) => {
    if (!challenge) return { data: null };
    const force = options?.force === true;
    let result;
    if (useDao && services.SBC?.sbcDAO?.loadChallenge && challenge?.id) {
      if (!force && challenge.id === lastOpenedChallengeId) {
        return { data: null, skipped: true };
      }
      const inProgress = challenge.isInProgress?.() ?? false;
      result = await sbcApiCall(
        "loadChallenge.dao",
        () =>
          observableToPromise(
            services.SBC.sbcDAO.loadChallenge(challenge.id, inProgress),
          ),
        { minGapMs: SBC_AUTOMATION_MIN_GAP_MS, maxAttempts: 2 },
      );
    } else {
      result = await sbcApiCall(
        "loadChallenge",
        () => observableToPromise(services.SBC.loadChallenge(challenge)),
        { minGapMs: SBC_AUTOMATION_MIN_GAP_MS, maxAttempts: 2 },
      );
    }

    const requirements = extractRequirements(result?.data ?? result);
    if (!requirements && services.SBC?.loadChallenge) {
      const fallback = await sbcApiCall(
        "loadChallenge.fallback",
        () => observableToPromise(services.SBC.loadChallenge(challenge)),
        { minGapMs: SBC_AUTOMATION_MIN_GAP_MS, maxAttempts: 2 },
      );
      if (fallback?.data && !result?.data) result = fallback;
      if (fallback?.data?.squad && !challenge.squad) {
        challenge.squad = fallback.data.squad;
      }
    }

    if (result?.data?.squad && !challenge.squad) {
      challenge.squad = result.data.squad;
    }
    return result;
  };

  const buildRequirementsSnapshot = (challenge, loadedData) => {
    const fromLoaded = extractRequirements(loadedData);
    const fromChallenge = extractRequirements(challenge);
    const base = fromLoaded ?? fromChallenge ?? [];
    const sources = [
      loadedData,
      loadedData?.data,
      loadedData?.challenge,
      loadedData?.sbcChallenge,
      challenge,
      challenge?.getSquad?.(),
      challenge?.squad,
      challenge?.squad?.squad,
      challenge?.squad?.squadInfo,
      loadedData?.data?.squad,
      loadedData?.squad,
    ];
    const squadSize = getSquadSizeRequirement(sources);
    const synthetic = appendSquadSizeRequirement(base, squadSize);
    const deduped = dedupeSquadSizeRequirements(synthetic);
    const requirements = normalizeRequirements(deduped);
    const requirementsParsed = requirements;
    const requirementsNormalized =
      normalizeRequirementsToRulesFromList(requirements);
    return {
      requirements,
      requirementsParsed,
      requirementsNormalized,
      squadSize,
    };
  };

  const buildChallengeSlotsForSolver = (challenge, loadedData) => {
    const squad =
      challenge?.squad ??
      loadedData?.data?.squad ??
      loadedData?.squad ??
      (typeof challenge?.getSquad === "function" ? challenge.getSquad() : null);
    if (!squad) {
      return {
        formationName: null,
        requiredPlayers: null,
        slotCount: 0,
        squadSlots: [],
        slotIndexToPositionName: new Map(),
      };
    }
    const formationName =
      squad?.getFormation?.()?.name ?? squad?.formation?.name ?? null;
    const requiredPlayers =
      typeof squad?.getNumOfRequiredPlayers === "function"
        ? squad.getNumOfRequiredPlayers()
        : null;
    const slots = squad?.getPlayers?.() ?? [];
    const slotCount = Array.isArray(slots) ? slots.length : 0;

    const normalizeSlotForSolver = (slot, index) => {
      const item = resolveSlotItem(slot);
      const concept =
        typeof item?.isConcept === "function"
          ? item.isConcept()
          : Boolean(item?.concept);
      const positionObj = slot?.position ?? null;
      const positionTypeName =
        positionObj?.typeName ??
        positionObj?.name ??
        positionObj?.label ??
        null;
      const resolved = resolveSlotPosition(slot);
      const resolvedName =
        typeof resolved === "string"
          ? resolved
          : typeof resolved === "object"
            ? (resolved?.typeName ?? resolved?.name ?? resolved?.label ?? null)
            : null;
      const positionName = positionTypeName ?? resolvedName ?? null;
      return {
        slotIndex: index,
        positionName,
        isLocked: resolveSlotLocked(slot),
        isEditable:
          typeof slot?.isEditable === "function"
            ? slot.isEditable()
            : typeof slot?.isEditable === "boolean"
              ? slot.isEditable
              : null,
        isBrick: resolveSlotBrick(slot),
        isValid: resolveSlotValid(slot, item),
        item: item
          ? {
              id: item?.id ?? null,
              definitionId: item?.definitionId ?? null,
              concept,
            }
          : null,
      };
    };

    const normalizedSlots = Array.isArray(slots)
      ? slots.map(normalizeSlotForSolver)
      : [];
    const fieldSlots = normalizedSlots.filter((slot) =>
      Boolean(slot?.positionName),
    );
    const take =
      typeof requiredPlayers === "number" && requiredPlayers > 0
        ? requiredPlayers
        : 11;
    const squadSlots = fieldSlots.slice(0, take).map((slot) => ({
      slotIndex: slot.slotIndex,
      positionName: slot.positionName,
      isLocked: slot.isLocked,
      isEditable: slot.isEditable,
      isBrick: slot.isBrick,
      isValid: slot.isValid,
      item: slot.item,
    }));
    const slotIndexToPositionName = new Map(
      squadSlots.map((slot) => [Number(slot.slotIndex), slot.positionName]),
    );
    return {
      formationName,
      requiredPlayers,
      slotCount,
      squadSlots,
      slotIndexToPositionName,
    };
  };

  let sbcPanelHooked = false;
  let sbcOverviewHooked = false;
  let sbcChallengesHooked = false;
  let gameRewardsHooked = false;
  let itemDetailsControllerHooked = false;
  let slotActionPanelHooked = false;
  let appSettingsHooked = false;
  let appSettingsControllerHooked = false;
  let currencyNavBarHooked = false;
  let currentChallenge = null;
  let lastOpenedChallengeId = null;
  let lastOpenedSetId = null;
  let debugEnabled = false;
  const DEBUG_ENABLED_STATE_KEY = "__eaDataDebugEnabled";
  const DEBUG_ENABLED_STORAGE_KEY = "ea-data-debug-enabled";
  let localizationCache = null;
  let rarityLookupCache = null;
  let leagueLookupCache = null;
  let nationLookupCache = null;
  let positionLookupCache = null;
  let solveButtonStyleInjected = false;
  let solverBridgeReady = false;
  let solverBridgeInitPromise = null;
  let solverBridgeError = null;
  let currentSlotPlan = null;
  let currentSbcOverviewView = null;
  let currentSbcDetailView = null;
  let currentSbcChallengesView = null;
  let currentSbcSet = null;
  let exclusionControlSeq = 0;
  let activeItemDetailsPanel = null;
  let activeSlotActionPanel = null;
  const excludedPlayerMetaCache = new Map(); // itemId(string) -> {name, rating, rarityName}
  let excludedPlayerMetaLoaded = false;
  let excludedPlayerMetaPersistTimer = null;
  let excludedPlayerIdsCache = null;
  let excludedPlayerIdsCacheInFlight = null;
  let excludedPlayerIdsCacheLoaded = false;
  const leagueMetaCache = new Map(); // leagueId(string) -> {name}
  let leagueMetaLoaded = false;
  let leagueMetaPersistTimer = null;
  const nationMetaCache = new Map(); // nationId(string) -> {name}
  let nationMetaLoaded = false;
  let nationMetaPersistTimer = null;
  let excludedLeagueIdsCache = null;
  let excludedLeagueIdsCacheInFlight = null;
  let excludedLeagueIdsCacheLoaded = false;
  let excludedNationIdsCache = null;
  let excludedNationIdsCacheInFlight = null;
  let excludedNationIdsCacheLoaded = false;
  const exclusionControlPanels = new Set();
  const globalSettingsStateRegistry = new Set();
  const rewardActionButtonRoots = new Set();
  const topbarSupportWrapperByView = new WeakMap();
  const solverBridgeRequests = new Map();
  const prefBridgeRequests = new Map();
  // Solve can occasionally take longer (large clubs / chemistry local search).
  // Keep init short, but allow solve to run longer before timing out.
  const SOLVER_BRIDGE_TIMEOUT_MS = 60000;
  const SOLVER_BRIDGE_INIT_TIMEOUT_MS = 10000;
  const SOLVER_BRIDGE_REQUEST = "EA_SOLVER_REQUEST";
  const SOLVER_BRIDGE_RESPONSE = "EA_SOLVER_RESPONSE";
  const SOLVER_BRIDGE_TRACE = "EA_SOLVER_TRACE";
  const SOLVER_BRIDGE_PING = "EA_SOLVER_PING";
  const SOLVER_BRIDGE_PONG = "EA_SOLVER_PONG";
  const SOLVER_BRIDGE_SOURCE = "ea-data-bridge";
  const PREF_BRIDGE_GET = "EA_DATA_PREF_GET";
  const PREF_BRIDGE_SET = "EA_DATA_PREF_SET";
  const PREF_BRIDGE_RES = "EA_DATA_PREF_RES";
  const PREF_STORAGE_KEY = "eaData.preferences.v1";
  const PREF_BRIDGE_TIMEOUT_MS = 3500;
  const PREF_CACHE_TTL_MS = 10 * 1000;
  const EA_DATA_SUPPORT_URL = "https://ko-fi.com/P5P5YOUU7";
  const EA_DATA_TOPBAR_SUPPORT_WRAP_CLASS = "ea-data-topbar-support-wrap";
  const EA_DATA_TOPBAR_SUPPORT_BUTTON_CLASS = "ea-data-topbar-support-btn";
  const EA_DATA_TOPBAR_SUPPORT_SELECTOR = `.${EA_DATA_TOPBAR_SUPPORT_WRAP_CLASS}`;
  const EA_DATA_TOPBAR_SUPPORT_TOOLTIP_CLASS = "ea-data-topbar-support-tip";
  const EA_DATA_TOPBAR_SUPPORT_TOOLTIP_ID = "ea-data-topbar-support-tip";
  const EA_DATA_TOPBAR_SUPPORT_TOOLTIP_VISIBLE_CLASS = "is-visible";
  const EA_DATA_TOPBAR_SUPPORT_TOOLTIP_TEXT =
    "If you’re enjoying AutopilotSBC, supporting the project helps me keep improving it and keep offering it for completely free!";
  const EA_DATA_TOPBAR_SUPPORT_HOVER_DELAY_MS = 650;
  const EA_DATA_TOPBAR_SUPPORT_FOCUS_DELAY_MS = 350;
  let preferencesCache = null; // { at: number, value: object }
  let preferencesInFlight = null;
  let topbarSupportObserver = null;
  let topbarSupportObserverStarted = false;
  let topbarSupportObserverRoot = null;
  let topbarSupportDocumentObserver = null;
  let topbarSupportDocumentObserverStarted = false;
  let topbarSupportResizeHooked = false;
  let topbarSupportReflowToken = 0;
  let topbarSupportReflowRafId = null;
  let topbarSupportTooltip = null;
  let topbarSupportTooltipAnchorButton = null;
  let topbarSupportTooltipTimer = null;
  let topbarSupportTooltipHideTimer = null;
  let topbarSupportTooltipViewportListenersAttached = false;
  let loadingOverlayCount = 0;

  const ensureSolveButtonStyles = () => {
    if (solveButtonStyleInjected) return;
    const style = document.createElement("style");
    style.id = "ea-data-solve-btn-style";
    style.textContent = `
.ea-data-settings-button,
.ea-data-multisolve-button,
.ea-data-app-settings-btn,
.ea-data-app-settings-group,
.ea-data-btn,
.ea-data-range__number,
.ea-data-preview-sort-select,
.ea-data-preview-nav-btn,
.ea-data-times-stepper__btn,
.ea-data-times-stepper__input,
.ea-data-topbar-support-btn {
  font-family: "Segoe UI", Arial, sans-serif !important;
}
.ea-data-range__number::-webkit-inner-spin-button,
.ea-data-range__number::-webkit-outer-spin-button,
.ea-data-times-stepper__input::-webkit-inner-spin-button,
.ea-data-times-stepper__input::-webkit-outer-spin-button {
  -webkit-appearance: none;
  margin: 0;
}
.ea-data-range__number,
.ea-data-times-stepper__input {
  -moz-appearance: textfield;
}
.ea-data-solve-button {
  background: #d53b3b !important;
  border-color: #d53b3b !important;
  color: #fff !important;
  cursor: pointer !important;
  flex: 1 1 auto;
  min-width: 0;
  transition: background 0.15s, border-color 0.15s, box-shadow 0.15s, transform 0.12s;
}
.ea-data-solve-button:hover {
  background: #c23232 !important;
  border-color: #c23232 !important;
  box-shadow: 0 2px 8px rgba(213, 59, 59, 0.35);
  transform: translateY(-1px);
}
.ea-data-solve-button:focus-visible {
  background: #c23232 !important;
  border-color: #c23232 !important;
  box-shadow: 0 0 0 2px rgba(213, 59, 59, 0.55);
}
.ea-data-solve-button:active {
  background: #a62828 !important;
  border-color: #a62828 !important;
  box-shadow: none;
  transform: translateY(0);
}
.ea-data-solve-wrapper {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  align-items: center;
  gap: 8px;
  padding: 10px;
  width: 100%;
  box-sizing: border-box;
}
.ea-data-solve-wrapper .ea-data-solve-button {
  flex: 1 0 100%;
}
.ea-data-solve-wrapper__secondary {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  justify-content: center;
}
.ea-data-settings-button {
  width: 42px;
  height: 40px;
  min-width: 42px;
  border: 1px solid rgba(255, 255, 255, 0.22);
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.06);
  color: rgba(255, 255, 255, 0.92);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  transition: background 0.15s, border-color 0.15s, transform 0.12s;
}
.ea-data-settings-button:hover {
  background: rgba(255, 255, 255, 0.12);
  border-color: rgba(100, 180, 255, 0.40);
  transform: translateY(-1px);
}
.ea-data-settings-button:focus-visible {
  background: rgba(255, 255, 255, 0.12);
  border-color: rgba(100, 180, 255, 0.40);
  box-shadow: 0 0 0 2px rgba(100, 180, 255, 0.50);
}
.ea-data-settings-button:active {
  transform: translateY(0);
}
.ea-data-settings-button svg {
  width: 18px;
  height: 18px;
  display: block;
  fill: currentColor;
  transition: transform 0.3s ease;
}
.ea-data-settings-button:hover svg {
  transform: rotate(60deg);
}
@media (prefers-reduced-motion: reduce) {
  .ea-data-settings-button { transition: none !important; }
  .ea-data-settings-button svg { transition: none !important; }
  .ea-data-settings-button:hover svg { transform: none !important; }
}
.ea-data-multisolve-button {
  height: 40px;
  min-width: 72px;
  padding: 0 16px;
  border: 1px solid rgba(100, 180, 255, 0.35);
  border-radius: 6px;
  background: rgba(80, 160, 255, 0.10);
  color: rgba(200, 225, 255, 0.95);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  font-weight: 800;
  letter-spacing: 0.2px;
  font-size: 12px;
  white-space: nowrap;
  flex-shrink: 0;
  flex: 1 1 auto;
  transition: background 0.15s, border-color 0.15s, transform 0.12s;
}
.ea-data-multisolve-button:not(:disabled):hover {
  background: rgba(80, 160, 255, 0.18);
  border-color: rgba(100, 180, 255, 0.55);
  transform: translateY(-1px);
}
.ea-data-multisolve-button:not(:disabled):focus-visible {
  background: rgba(80, 160, 255, 0.18);
  border-color: rgba(100, 180, 255, 0.55);
  transform: translateY(-1px);
  box-shadow: 0 0 0 2px rgba(100, 180, 255, 0.50);
}
.ea-data-multisolve-button:not(:disabled):active {
  transform: translateY(0);
}
.ea-data-multisolve-button:disabled {
  opacity: 0.40;
  cursor: not-allowed;
}
.ea-data-multisolve-button__icon {
  display: inline-flex;
  width: 14px;
  height: 14px;
  flex-shrink: 0;
  transition: transform 0.35s ease;
}
.ea-data-multisolve-button:not(:disabled):hover .ea-data-multisolve-button__icon,
.ea-data-multisolve-button:not(:disabled):focus-visible .ea-data-multisolve-button__icon {
  transform: rotate(180deg);
}
@media (prefers-reduced-motion: reduce) {
  .ea-data-multisolve-button { transition: none !important; }
  .ea-data-multisolve-button__icon { transition: none !important; }
  .ea-data-multisolve-button:not(:disabled):hover .ea-data-multisolve-button__icon,
  .ea-data-multisolve-button:not(:disabled):focus-visible .ea-data-multisolve-button__icon {
    transform: none !important;
  }
}
.ea-data-topbar-support-wrap {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  position: relative;
  margin-left: 0;
  margin-right: 0;
  flex: 0 0 auto;
}
.ea-data-topbar-support-wrap--anchored {
  position: fixed;
  margin: 0 !important;
  z-index: 4;
}
.ea-data-topbar-support-wrap--inline {
  position: relative !important;
  margin: 0 !important;
  left: auto !important;
  top: auto !important;
  transform: none !important;
  z-index: auto;
}
.ea-data-topbar-title--with-support {
  display: inline-flex !important;
  align-items: center;
  gap: 24px;
  white-space: nowrap;
}
.ea-data-topbar-support-btn {
  height: 30px;
  min-width: 118px;
  padding: 0 14px;
  border: 1px solid rgba(255, 94, 91, 0.3);
  border-radius: 999px;
  background: rgba(255, 94, 91, 0.1);
  color: rgba(255, 235, 235, 0.95);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.15px;
  line-height: 1;
  white-space: nowrap;
  text-transform: none;
  box-shadow: none;
  transition: background 0.15s, border-color 0.15s, color 0.15s;
}
.ea-data-topbar-support-btn::before {
  content: "\\2665";
  width: auto;
  height: auto;
  margin-right: 7px;
  color: #ff5e5b;
  font-size: 11px;
  line-height: 1;
  display: inline-block;
}
.ea-data-topbar-support-btn:not(:disabled):hover {
  background: rgba(255, 94, 91, 0.2);
  border-color: #ff5e5b;
  color: #ffdede;
  box-shadow: 0 0 10px rgba(255, 94, 91, 0.2);
}
.ea-data-topbar-support-btn:not(:disabled):focus-visible {
  background: rgba(255, 94, 91, 0.2);
  border-color: #ff5e5b;
  color: #ffffff;
  box-shadow: 0 0 0 2px rgba(255, 94, 91, 0.25);
}
.ea-data-topbar-support-btn:not(:disabled):active {
  background: rgba(255, 94, 91, 0.16);
}
.ea-data-topbar-support-tip {
  position: fixed;
  left: 0;
  top: 0;
  transform: translate(-50%, -4px);
  min-width: 230px;
  max-width: 320px;
  padding: 10px 12px 11px;
  border-radius: 11px;
  border: 1px solid rgba(255, 138, 138, 0.22);
  background: linear-gradient(
    180deg,
    rgba(23, 26, 38, 0.94) 0%,
    rgba(14, 16, 25, 0.94) 100%
  );
  color: rgba(255, 243, 243, 0.92);
  font-family: "Segoe UI", Arial, sans-serif !important;
  font-size: 12px;
  font-weight: 500;
  line-height: 1.34;
  text-align: center;
  white-space: normal;
  letter-spacing: 0.02px;
  text-wrap: balance;
  -webkit-font-smoothing: antialiased;
  text-rendering: geometricPrecision;
  backdrop-filter: blur(2px);
  box-shadow:
    0 8px 20px rgba(0, 0, 0, 0.32),
    inset 0 0 0 1px rgba(255, 255, 255, 0.03);
  opacity: 0;
  visibility: hidden;
  pointer-events: none;
  z-index: 12000;
  transition:
    opacity 0.16s ease,
    transform 0.16s ease,
    visibility 0.16s linear;
}
.ea-data-topbar-support-tip__text {
  display: block;
  font-size: 12.35px;
  font-weight: 490;
  letter-spacing: 0.03px;
  color: rgba(255, 245, 245, 0.92);
}
.ea-data-topbar-support-tip::before {
  content: "";
  position: absolute;
  left: 50%;
  top: -6px;
  width: 10px;
  height: 10px;
  border-top: 1px solid rgba(255, 138, 138, 0.22);
  border-left: 1px solid rgba(255, 138, 138, 0.22);
  background: rgba(20, 23, 34, 0.94);
  transform: translateX(-50%) rotate(45deg);
}
.ea-data-topbar-support-tip.is-visible {
  opacity: 1;
  visibility: visible;
  transform: translate(-50%, 0);
}
@media (prefers-reduced-motion: reduce) {
  .ea-data-topbar-support-btn { transition: none !important; }
  .ea-data-topbar-support-tip { transition: none !important; }
}
.ea-data-setsolve-button {
  height: 40px;
  min-width: 72px;
  padding: 0 12px;
  border: 1px solid rgba(255, 255, 255, 0.22);
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.06);
  color: rgba(255, 255, 255, 0.92);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-weight: 800;
  letter-spacing: 0.2px;
  font-size: 12px;
}
.ea-data-setsolve-button:not(:disabled):hover {
  background: rgba(255, 255, 255, 0.10);
  border-color: rgba(255, 255, 255, 0.30);
}
.ea-data-setsolve-button:not(:disabled):active {
  transform: translateY(1px);
}
.ea-data-setsolve-button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.ea-data-setsolve-chooser-wrap {
  width: 100%;
  margin-top: 10px;
  display: flex;
  justify-content: center;
  align-items: center;
}
.ea-data-setsolve-button--chooser {
  width: auto;
  min-width: 240px;
  min-height: 44px;
  padding: 0 20px;
  border-color: #d53b3b;
  background: #d53b3b;
  color: #fff;
  justify-content: center;
  font-size: 13px;
  font-weight: 900;
  letter-spacing: 0.25px;
}
.ea-data-setsolve-button--chooser:not(:disabled):hover {
  background: #b92f2f;
  border-color: #b92f2f;
}
.ea-data-setsolve-button--chooser:not(:disabled):active {
  background: #a62828;
  border-color: #a62828;
}
.ea-data-app-settings-group {
  margin-top: 12px;
  border: 1px solid rgba(11, 150, 255, 0.55);
  border-radius: 10px;
  background: rgba(7, 10, 20, 0.82);
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.ea-data-app-settings-divider {
  margin: 0 0 2px;
  display: flex;
  align-items: center;
  gap: 10px;
}
.ea-data-app-settings-divider::before,
.ea-data-app-settings-divider::after {
  content: "";
  height: 1px;
  background: rgba(255, 255, 255, 0.18);
  flex: 1 1 auto;
}
.ea-data-app-settings-divider > span {
  color: #0B96FF;
  font-size: 13px;
  font-weight: 900;
  letter-spacing: 0.45px;
  text-transform: uppercase;
}
.ea-data-app-settings-subtitle {
  color: rgba(255, 255, 255, 0.72);
  font-size: 12px;
  line-height: 1.4;
}
.ea-data-challenge-picker {
  display: flex;
  gap: 12px;
  overflow-x: auto;
  padding: 8px 4px 12px 4px;
  margin-top: 8px;
  scrollbar-width: thin;
  scrollbar-color: rgba(255, 255, 255, 0.2) transparent;
}
.ea-data-challenge-picker::-webkit-scrollbar {
  height: 6px;
}
.ea-data-challenge-picker::-webkit-scrollbar-thumb {
  background-color: rgba(255, 255, 255, 0.2);
  border-radius: 4px;
}
.ea-data-challenge-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 10px;
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  background: rgba(0, 0, 0, 0.3);
  cursor: pointer;
  transition: all 0.2s ease;
  min-width: 90px;
  flex-shrink: 0;
  user-select: none;
}
.ea-data-challenge-card:hover {
  background: rgba(255, 255, 255, 0.05);
}
.ea-data-challenge-card--selected {
  border-color: #0df;
  background: rgba(0, 221, 255, 0.08);
  box-shadow: 0 0 10px rgba(0, 221, 255, 0.15);
  opacity: 1;
}
.ea-data-challenge-card--deselected {
  opacity: 0.4;
  filter: grayscale(100%);
}
.ea-data-challenge-card__icon {
  width: 50px;
  height: 50px;
  object-fit: contain;
  margin-bottom: 6px;
}
.ea-data-challenge-card__label {
  font-size: 11px;
  text-align: center;
  color: rgba(255, 255, 255, 0.9);
  max-width: 100px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-weight: 600;
}
.ea-data-app-settings-actions {
  margin-top: 8px;
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  flex-wrap: wrap;
}
.ea-data-app-settings-btn {
  min-height: 40px;
  min-width: 122px;
  padding: 0 14px;
  border-radius: 6px;
  border: 1px solid #d53b3b !important;
  background: #d53b3b !important;
  color: #fff !important;
  font-weight: 800;
  letter-spacing: 0.2px;
  font-size: 13px;
  cursor: pointer;
  width: auto !important;
}
.ea-data-app-settings-btn:hover {
  background: #b92f2f !important;
  border-color: #b92f2f !important;
}
.ea-data-app-settings-btn:active {
  background: #a62828 !important;
  border-color: #a62828 !important;
}
.ea-data-app-settings-btn--reset {
  background: rgba(213, 59, 59, 0.16) !important;
  border-color: rgba(213, 59, 59, 0.85) !important;
}
.ea-data-app-settings-btn--reset:hover {
  background: rgba(213, 59, 59, 0.28) !important;
  border-color: #d53b3b !important;
}
.ea-data-app-settings-group .ea-data-range {
  width: 100%;
}
.ea-data-app-settings-group .ea-data-range__input {
  display: block !important;
  visibility: visible !important;
  opacity: 1 !important;
  width: 100% !important;
  height: 30px !important;
}
.ea-data-app-settings-group .ea-data-range__fields {
  margin-top: 8px;
}
.ea-data-app-settings-group .ea-data-range__number {
  background: #293142;
  border-color: #15d4ff;
  color: #6ef6ff;
}
.ea-data-toggle-list {
  margin-top: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.ea-data-toggle-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  color: rgba(255, 255, 255, 0.9);
  font-size: 13px;
  padding: 8px 12px;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 8px;
  cursor: pointer;
  transition: background 0.2s, border-color 0.2s;
}
.ea-data-toggle-row:hover {
  background: rgba(255, 255, 255, 0.07);
  border-color: rgba(255, 255, 255, 0.16);
}
.ea-data-toggle-text {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  min-width: 0;
}
.ea-data-toggle-title {
  color: rgba(255, 255, 255, 0.96);
  font-weight: 700;
  white-space: nowrap;
}
.ea-data-toggle-icon-wrap {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  color: rgba(11, 150, 255, 0.7);
}
.ea-data-toggle-icon-wrap:hover {
  color: #0B96FF;
}
.ea-data-toggle-tooltip {
  position: absolute;
  bottom: 160%;
  left: 50%;
  transform: translateX(-50%) translateY(4px);
  background: rgba(10, 15, 26, 0.96);
  border: 1px solid rgba(11, 150, 255, 0.4);
  color: rgba(255, 255, 255, 0.95);
  padding: 8px 12px;
  border-radius: 6px;
  font-size: 11px;
  line-height: 1.4;
  white-space: normal;
  width: max-content;
  max-width: 220px;
  pointer-events: none;
  opacity: 0;
  visibility: hidden;
  transition: opacity 0.2s, transform 0.2s, visibility 0.2s;
  z-index: 1000;
  box-shadow: 0 4px 16px rgba(0,0,0,0.6);
  backdrop-filter: blur(4px);
  font-weight: 600;
  text-align: center;
  letter-spacing: 0.15px;
}
.ea-data-toggle-tooltip::after {
  content: "";
  position: absolute;
  top: 100%;
  left: 50%;
  margin-left: -5px;
  border-width: 5px;
  border-style: solid;
  border-color: rgba(11, 150, 255, 0.4) transparent transparent transparent;
}
.ea-data-toggle-icon-wrap:hover .ea-data-toggle-tooltip {
  opacity: 1;
  visibility: visible;
  transform: translateX(-50%) translateY(0);
}
.ea-data-toggle-switch {
  position: relative;
  width: 36px;
  height: 20px;
  flex-shrink: 0;
}
.ea-data-toggle-switch input {
  opacity: 0;
  width: 0;
  height: 0;
  position: absolute;
}
.ea-data-toggle-slider {
  position: absolute;
  cursor: pointer;
  top: 0; left: 0; right: 0; bottom: 0;
  background-color: rgba(255, 255, 255, 0.16);
  transition: .3s cubic-bezier(0.4, 0.0, 0.2, 1);
  border-radius: 20px;
}
.ea-data-toggle-slider:before {
  position: absolute;
  content: "";
  height: 14px;
  width: 14px;
  left: 3px;
  bottom: 3px;
  background-color: #fff;
  transition: .3s cubic-bezier(0.4, 0.0, 0.2, 1);
  border-radius: 50%;
  box-shadow: 0 2px 4px rgba(0,0,0,0.3);
}
.ea-data-toggle-switch input:checked + .ea-data-toggle-slider {
  background-color: #0B96FF;
  box-shadow: 0 0 8px rgba(11, 150, 255, 0.4);
}
.ea-data-toggle-switch input:checked + .ea-data-toggle-slider:before {
  transform: translateX(16px);
}
.ea-data-toggle-switch.ea-data-toggle-switch--instant .ea-data-toggle-slider,
.ea-data-toggle-switch.ea-data-toggle-switch--instant .ea-data-toggle-slider:before {
  transition: none !important;
}
.ea-data-app-settings-group .ea-data-toggle-list {
  margin-top: 6px;
}
.ea-data-item-panel-exclude-wrap {
  margin-top: 8px;
  width: 100%;
}
.ea-data-item-panel-exclude-wrap .ea-data-toggle-row {
  padding: 8px 10px;
  border-radius: 6px;
}
.ea-data-item-panel-exclude-state {
  display: block;
  margin-top: 3px;
  color: rgba(255, 255, 255, 0.66);
  font-size: 11px;
  font-weight: 500;
  line-height: 1.2;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ea-data-item-panel-exclude-wrap .ea-data-toggle-switch input:disabled + .ea-data-toggle-slider {
  opacity: 0.55;
  cursor: not-allowed;
}
.ea-data-excluded-wrap {
  margin-top: 8px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.03);
  padding: 8px;
}
.ea-data-excluded-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 8px;
}
.ea-data-excluded-count {
  color: rgba(255, 255, 255, 0.75);
  font-size: 12px;
  font-weight: 700;
}
.ea-data-excluded-clear {
  border: 1px solid rgba(213, 59, 59, 0.85);
  border-radius: 6px;
  background: rgba(213, 59, 59, 0.16);
  color: #fff;
  min-height: 28px;
  padding: 0 10px;
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;
}
.ea-data-excluded-clear:hover {
  background: rgba(213, 59, 59, 0.28);
}
.ea-data-excluded-clear:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.ea-data-excluded-list {
  max-height: 180px;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.ea-data-excluded-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 6px 8px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.04);
}
.ea-data-excluded-item-main {
  min-width: 0;
  flex: 1 1 auto;
}
.ea-data-excluded-item-name {
  color: rgba(255, 255, 255, 0.95);
  font-size: 12px;
  font-weight: 700;
  line-height: 1.2;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ea-data-excluded-item-meta {
  color: rgba(255, 255, 255, 0.66);
  font-size: 11px;
  font-weight: 500;
  line-height: 1.2;
  margin-top: 2px;
}
.ea-data-excluded-remove {
  border: 1px solid rgba(255, 255, 255, 0.16);
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.06);
  color: #fff;
  min-height: 26px;
  padding: 0 8px;
  font-size: 11px;
  font-weight: 700;
  cursor: pointer;
  flex: 0 0 auto;
}
.ea-data-excluded-remove:hover {
  background: rgba(255, 255, 255, 0.12);
}
.ea-data-excluded-remove:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.ea-data-excluded-empty {
  color: rgba(255, 255, 255, 0.62);
  font-size: 12px;
  font-weight: 600;
  padding: 8px 6px;
  text-align: center;
}
.ea-data-excluded-leagues-wrap {
  margin-top: 8px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.03);
  padding: 8px;
}
.ea-data-excluded-leagues-search {
  width: 100%;
  min-height: 32px;
  border: 1px solid rgba(255, 255, 255, 0.18);
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.06);
  color: rgba(255, 255, 255, 0.95);
  padding: 0 10px;
  outline: none;
  font-size: 12px;
  font-weight: 600;
}
.ea-data-excluded-leagues-search::placeholder {
  color: rgba(255, 255, 255, 0.5);
}
.ea-data-excluded-leagues-search:focus {
  border-color: rgba(11, 150, 255, 0.9);
  box-shadow: 0 0 0 2px rgba(11, 150, 255, 0.2);
}
.ea-data-excluded-leagues-selected {
  margin-top: 8px;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  max-height: 120px;
  overflow: auto;
}
.ea-data-excluded-league-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 1px solid rgba(11, 150, 255, 0.42);
  background: rgba(11, 150, 255, 0.12);
  color: rgba(255, 255, 255, 0.95);
  border-radius: 999px;
  padding: 3px 8px;
  font-size: 11px;
  font-weight: 700;
}
.ea-data-excluded-league-chip-remove {
  border: none;
  background: transparent;
  color: rgba(255, 255, 255, 0.75);
  font-size: 13px;
  line-height: 1;
  cursor: pointer;
  padding: 0;
}
.ea-data-excluded-league-chip-remove:hover {
  color: #fff;
}
.ea-data-excluded-leagues-list {
  margin-top: 8px;
  max-height: 180px;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.ea-data-excluded-leagues-option {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.04);
  padding: 6px 8px;
  cursor: pointer;
}
.ea-data-excluded-leagues-option[data-selected="true"] {
  border-color: rgba(11, 150, 255, 0.7);
  background: rgba(11, 150, 255, 0.14);
}
.ea-data-excluded-leagues-option-main {
  min-width: 0;
  flex: 1 1 auto;
}
.ea-data-excluded-leagues-option-name {
  font-size: 12px;
  font-weight: 700;
  color: rgba(255, 255, 255, 0.95);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ea-data-excluded-leagues-option-id {
  margin-top: 2px;
  font-size: 11px;
  font-weight: 500;
  color: rgba(255, 255, 255, 0.62);
}
.ea-data-excluded-leagues-option-check {
  font-size: 12px;
  font-weight: 800;
  color: rgba(11, 150, 255, 0.95);
  min-width: 18px;
  text-align: right;
}
.ea-data-excluded-leagues-muted {
  color: rgba(255, 255, 255, 0.62);
  font-size: 11px;
  font-weight: 600;
  margin-top: 6px;
}

#ea-data-settings-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.88);
  display: none;
  align-items: center;
  justify-content: center;
  z-index: 1000002;
  font-family: "Segoe UI", Arial, sans-serif;
}
#ea-data-settings-overlay[aria-hidden="false"] {
  display: flex;
}
.ea-data-settings-modal {
  width: min(520px, calc(100vw - 24px));
  background: #0b0b0b;
  border: 2px solid #0B96FF;
  border-radius: 10px;
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.65);
  padding: 14px 14px 12px;
  color: #fff;
}
.ea-data-settings-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 10px;
}
.ea-data-settings-title {
  color: #0B96FF;
  font-weight: 800;
  font-size: 15px;
  letter-spacing: 0.2px;
}
.ea-data-settings-close {
  border: none;
  background: transparent;
  cursor: pointer;
  padding: 0;
  width: 28px;
  height: 28px;
  display: grid;
  place-items: center;
  color: rgba(255, 255, 255, 0.70);
  font-size: 18px;
  line-height: 1;
  border-radius: 6px;
}
.ea-data-settings-close:hover {
  color: rgba(255, 255, 255, 0.95);
  background: rgba(255, 255, 255, 0.06);
}
.ea-data-settings-close:active {
  transform: translateY(1px);
}
.ea-data-settings-section-label {
  color: rgba(255, 255, 255, 0.80);
  font-weight: 700;
  font-size: 12px;
  letter-spacing: 0.2px;
}
.ea-data-collapsible-heading {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 10px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.04);
  color: rgba(255, 255, 255, 0.92);
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.2px;
  text-align: left;
  cursor: pointer;
}
.ea-data-collapsible-heading:hover {
  background: rgba(255, 255, 255, 0.07);
  border-color: rgba(255, 255, 255, 0.18);
}
.ea-data-collapsible-heading:focus-visible {
  outline: 2px solid rgba(11, 150, 255, 0.65);
  outline-offset: 1px;
}
.ea-data-collapsible-chevron {
  color: rgba(255, 255, 255, 0.72);
  font-size: 12px;
  transition: transform 0.18s ease;
}
.ea-data-collapsible-heading[aria-expanded="true"] .ea-data-collapsible-chevron {
  transform: rotate(180deg);
}
.ea-data-collapsible-section {
  margin-top: 12px;
  border: 1px solid rgba(255, 255, 255, 0.10);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.03);
  overflow: hidden;
}
.ea-data-collapsible-section .ea-data-collapsible-heading {
  border: none;
  border-radius: 0;
  background: transparent;
}
.ea-data-collapsible-section .ea-data-collapsible-heading:hover {
  background: rgba(255, 255, 255, 0.05);
  border-color: transparent;
}
.ea-data-collapsible-section .ea-data-collapsible-heading[aria-expanded="true"] {
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}
.ea-data-collapsible-section .ea-data-excluded-leagues-wrap {
  margin-top: 0;
  border: none;
  border-radius: 0;
  background: transparent;
}
.ea-data-range {
  position: relative;
  height: 30px;
  margin-top: 10px;
  --min-pct: 0%;
  --max-pct: 100%;
}
.ea-data-range--locked {
  pointer-events: none;
}
.ea-data-range__track {
  position: absolute;
  left: 0;
  right: 0;
  top: 50%;
  transform: translateY(-50%);
  height: 6px;
  border-radius: 999px;
  background: linear-gradient(
    to right,
    rgba(255, 255, 255, 0.18) 0%,
    rgba(255, 255, 255, 0.18) var(--min-pct),
    #0B96FF var(--min-pct),
    #0B96FF var(--max-pct),
    rgba(255, 255, 255, 0.18) var(--max-pct),
    rgba(255, 255, 255, 0.18) 100%
  );
}
.ea-data-range__input {
  position: absolute;
  left: 0;
  right: 0;
  top: 0;
  bottom: 0;
  width: 100%;
  margin: 0;
  background: transparent;
  pointer-events: none;
  -webkit-appearance: none;
  appearance: none;
}
input.ea-data-range__input::-webkit-slider-runnable-track {
  background: transparent;
  border: none;
}
.ea-data-range__input:disabled {
  opacity: 1;
}
input.ea-data-range__input:disabled::-webkit-slider-runnable-track {
  background: transparent;
  border: none;
}
input.ea-data-range__input::-webkit-slider-thumb {
  pointer-events: auto;
  -webkit-appearance: none;
  appearance: none;
  width: 18px;
  height: 18px;
  border-radius: 999px;
  background: #ffffff;
  border: 2px solid #0B96FF;
  box-shadow: 0 8px 20px rgba(0, 0, 0, 0.55);
}
input.ea-data-range__input:disabled::-webkit-slider-thumb {
  background: #ffffff;
  border: 2px solid #0B96FF;
}
input.ea-data-range__input::-moz-range-thumb {
  pointer-events: auto;
  width: 18px;
  height: 18px;
  border-radius: 999px;
  background: #ffffff;
  border: 2px solid #0B96FF;
  box-shadow: 0 8px 20px rgba(0, 0, 0, 0.55);
}
input.ea-data-range__input:disabled::-moz-range-thumb {
  background: #ffffff;
  border: 2px solid #0B96FF;
}
input.ea-data-range__input::-moz-range-track {
  background: transparent;
  border: none;
}
input.ea-data-range__input:disabled::-moz-range-track {
  background: transparent;
  border: none;
}
input.ea-data-range__input::-moz-range-progress {
  background: transparent;
  border: none;
}
input.ea-data-range__input:disabled::-moz-range-progress {
  background: transparent;
  border: none;
}
.ea-data-range__input--min {
  z-index: 3;
}
.ea-data-range__input--max {
  z-index: 4;
}
.ea-data-range__fields {
  display: flex;
  gap: 12px;
  margin-top: 10px;
}
.ea-data-range__field {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.ea-data-range__label {
  font-size: 11px;
  color: rgba(255, 255, 255, 0.65);
}
.ea-data-range__number {
  width: 100%;
  background: #111111;
  color: #ffffff;
  border: 1px solid rgba(255, 255, 255, 0.18);
  border-radius: 8px;
  padding: 10px 10px;
  font-size: 13px;
  outline: none;
}
.ea-data-range__number:focus {
  border-color: #0B96FF;
  box-shadow: 0 0 0 2px rgba(11, 150, 255, 0.25);
}
.ea-data-times-stepper {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
}
.ea-data-times-stepper__input {
  max-width: 110px;
  text-align: center;
}
.ea-data-times-stepper__btn {
  width: 38px;
  height: 38px;
  border-radius: 10px;
  border: 1px solid rgba(255, 255, 255, 0.18);
  background: rgba(255, 255, 255, 0.04);
  color: rgba(255, 255, 255, 0.92);
  cursor: pointer;
  font-weight: 900;
  line-height: 1;
  display: grid;
  place-items: center;
  user-select: none;
}
.ea-data-times-stepper__btn:not(:disabled):hover {
  background: rgba(255, 255, 255, 0.08);
}
.ea-data-times-stepper__btn:not(:disabled):active {
  transform: translateY(1px);
}
.ea-data-times-stepper__btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.ea-data-settings-actions {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 10px;
  margin-top: 14px;
}
.ea-data-btn {
  border-radius: 8px;
  padding: 9px 12px;
  font-size: 13px;
  font-weight: 800;
  letter-spacing: 0.2px;
  cursor: pointer;
  border: 1px solid rgba(255, 255, 255, 0.18);
}
.ea-data-btn:disabled {
  opacity: 0.55;
  filter: grayscale(0.35);
  cursor: not-allowed;
}
.ea-data-btn--ghost {
  background: transparent;
  color: rgba(255, 255, 255, 0.86);
}
.ea-data-btn--ghost:not(:disabled):hover {
  background: rgba(255, 255, 255, 0.06);
}
.ea-data-btn--primary {
  background: #0B96FF;
  border-color: #0B96FF;
  color: #000000;
}
.ea-data-btn--primary:not(:disabled):hover {
  background: #037fdc;
  border-color: #037fdc;
}
.ea-data-btn--info {
  background: transparent;
  border-color: rgba(11, 150, 255, 0.75);
  color: #0B96FF;
}
.ea-data-btn--info:not(:disabled):hover {
  background: rgba(11, 150, 255, 0.10);
  border-color: #0B96FF;
}
.ea-data-btn--danger {
  background: #F24520;
  border-color: #F24520;
  color: #000000;
}
.ea-data-btn--danger:not(:disabled):hover {
  background: #cf3516;
  border-color: #cf3516;
}
.ea-data-btn--success {
  background: #07F468;
  border-color: #07F468;
  color: #000000;
}
.ea-data-btn--success:not(:disabled):hover {
  background: #04d960;
  border-color: #04d960;
}
.ea-data-btn:active {
  transform: translateY(1px);
}

#ea-data-multisolve-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.88);
  display: none;
  align-items: center;
  justify-content: center;
  z-index: 1000002;
  font-family: "Segoe UI", Arial, sans-serif;
}
#ea-data-multisolve-overlay[aria-hidden="false"] {
  display: flex;
}
.ea-data-multisolve-modal {
  width: min(720px, calc(100vw - 24px));
  max-height: 85vh;
  overflow-y: auto;
  overflow-x: hidden;
  background: #0b0b0b;
  border: 2px solid #0B96FF;
  border-radius: 10px;
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.65);
  padding: 14px 14px 12px;
  color: #fff;
}
.ea-data-multisolve-grid {
  display: flex;
  flex-direction: column;
  gap: 10px;
  align-items: center;
  justify-content: center;
  margin-top: 12px;
}
.ea-data-multisolve-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 160px;
}
.ea-data-multisolve-field--times {
  align-items: center;
  min-width: 190px;
  width: 100%;
  max-width: 340px;
}
.ea-data-multisolve-field--times .ea-data-range__label {
  width: 100%;
  text-align: center;
}
.ea-data-multisolve-grid [data-action="generate"] {
  width: 100%;
  max-width: 220px;
}
.ea-data-multisolve-status {
  margin-top: 10px;
  color: rgba(255, 255, 255, 0.75);
  font-size: 12px;
  min-height: 16px;
}
#ea-data-setsolve-overlay #ea-data-setsolve-times-wrap {
  margin-left: auto;
  margin-right: auto;
}
#ea-data-setsolve-overlay #ea-data-setsolve-cycle-meta {
  text-align: center;
}
#ea-data-setsolve-overlay .ea-data-multisolve-modal {
  width: min(1080px, calc(100vw - 24px));
  display: flex;
  flex-direction: row;
  align-items: flex-start;
  gap: 14px;
  overflow: hidden;
}
#ea-data-setsolve-overlay #ea-data-setsolve-left-column {
  flex: 1 1 auto;
  min-width: 0;
  max-height: calc(85vh - 28px);
  overflow-y: auto;
  overflow-x: hidden;
  padding-right: 2px;
}
#ea-data-setsolve-overlay #ea-data-setsolve-right-panel {
  width: min(340px, 34vw);
  min-width: 280px;
  max-height: calc(85vh - 28px);
  overflow-y: auto;
  overflow-x: hidden;
  position: sticky;
  top: 0;
  align-self: flex-start;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.03);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.05);
  padding: 10px;
}
#ea-data-setsolve-overlay .ea-data-setsolve-info-title {
  font-size: 13px;
  font-weight: 900;
  letter-spacing: 0.25px;
  color: #0b96ff;
  margin-bottom: 10px;
}
#ea-data-setsolve-overlay .ea-data-setsolve-info-section {
  border: 1px solid rgba(255, 255, 255, 0.10);
  border-radius: 9px;
  background: rgba(0, 0, 0, 0.28);
  padding: 9px 10px;
  margin-top: 8px;
}
#ea-data-setsolve-overlay .ea-data-setsolve-info-section:first-of-type {
  margin-top: 0;
}
#ea-data-setsolve-overlay .ea-data-setsolve-info-section-title {
  font-size: 11px;
  font-weight: 900;
  letter-spacing: 0.3px;
  text-transform: uppercase;
  color: rgba(255, 255, 255, 0.86);
  margin-bottom: 7px;
}
#ea-data-setsolve-overlay .ea-data-setsolve-info-row {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  margin-top: 5px;
}
#ea-data-setsolve-overlay .ea-data-setsolve-info-row:first-of-type {
  margin-top: 0;
}
#ea-data-setsolve-overlay .ea-data-setsolve-info-label {
  color: rgba(255, 255, 255, 0.65);
  font-size: 11px;
  font-weight: 700;
}
#ea-data-setsolve-overlay .ea-data-setsolve-info-value {
  color: rgba(255, 255, 255, 0.94);
  font-size: 11px;
  font-weight: 800;
  text-align: right;
}
#ea-data-setsolve-overlay .ea-data-setsolve-req-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
#ea-data-setsolve-overlay .ea-data-setsolve-req-card {
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.02);
  padding: 8px 9px;
}
#ea-data-setsolve-overlay .ea-data-setsolve-req-card--solved {
  border-color: rgba(7, 244, 104, 0.5);
  background: rgba(7, 244, 104, 0.1);
  box-shadow: inset 0 0 0 1px rgba(7, 244, 104, 0.15);
}
#ea-data-setsolve-overlay .ea-data-setsolve-req-card--failed {
  border-color: rgba(242, 69, 32, 0.5);
  background: rgba(242, 69, 32, 0.1);
  box-shadow: inset 0 0 0 1px rgba(242, 69, 32, 0.18);
}
#ea-data-setsolve-overlay .ea-data-setsolve-req-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
#ea-data-setsolve-overlay .ea-data-setsolve-req-head-right {
  display: inline-flex;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
}
#ea-data-setsolve-overlay .ea-data-setsolve-req-name {
  font-size: 11px;
  font-weight: 800;
  color: rgba(255, 255, 255, 0.95);
  line-height: 1.25;
}
#ea-data-setsolve-overlay .ea-data-setsolve-req-status {
  font-size: 10px;
  font-weight: 800;
  border-radius: 999px;
  border: 1px solid rgba(255, 255, 255, 0.24);
  padding: 2px 7px;
  white-space: nowrap;
}
#ea-data-setsolve-overlay .ea-data-setsolve-req-status--loading {
  color: #9ecfff;
  border-color: rgba(11, 150, 255, 0.42);
  background: rgba(11, 150, 255, 0.14);
}
#ea-data-setsolve-overlay .ea-data-setsolve-req-status--ready {
  color: #a0ffc9;
  border-color: rgba(7, 244, 104, 0.42);
  background: rgba(7, 244, 104, 0.14);
}
#ea-data-setsolve-overlay .ea-data-setsolve-req-status--error {
  color: #ffb1b1;
  border-color: rgba(242, 69, 32, 0.45);
  background: rgba(242, 69, 32, 0.14);
}
#ea-data-setsolve-overlay .ea-data-setsolve-req-lines {
  margin: 7px 0 0;
  padding-left: 15px;
  color: rgba(255, 255, 255, 0.88);
  font-size: 11px;
  font-weight: 700;
}
#ea-data-setsolve-overlay .ea-data-setsolve-req-lines li {
  margin-top: 3px;
  line-height: 1.28;
}
#ea-data-setsolve-overlay .ea-data-setsolve-req-lines li:first-child {
  margin-top: 0;
}
#ea-data-setsolve-overlay .ea-data-setsolve-req-lines li.ea-data-setsolve-req-line--blocked {
  color: #ffd3d3;
  background: rgba(242, 69, 32, 0.16);
  border: 1px solid rgba(242, 69, 32, 0.42);
  border-radius: 6px;
  padding: 2px 5px;
}
#ea-data-setsolve-overlay .ea-data-setsolve-req-badge {
  font-size: 10px;
  font-weight: 900;
  line-height: 1;
  border-radius: 999px;
  border: 1px solid rgba(255, 255, 255, 0.2);
  padding: 3px 7px;
  white-space: nowrap;
}
#ea-data-setsolve-overlay .ea-data-setsolve-req-badge--solver {
  color: #ffd6a0;
  border-color: rgba(255, 162, 0, 0.45);
  background: rgba(255, 162, 0, 0.16);
}
#ea-data-setsolve-overlay .ea-data-setsolve-req-badge--pool {
  color: #ffb8c6;
  border-color: rgba(255, 62, 108, 0.48);
  background: rgba(255, 62, 108, 0.16);
}
#ea-data-setsolve-overlay .ea-data-setsolve-req-badge--system {
  color: #d4d8ff;
  border-color: rgba(149, 157, 255, 0.45);
  background: rgba(149, 157, 255, 0.16);
}
#ea-data-setsolve-overlay .ea-data-setsolve-req-badge--solved {
  color: #b7ffce;
  border-color: rgba(7, 244, 104, 0.5);
  background: rgba(7, 244, 104, 0.16);
}
#ea-data-setsolve-overlay .ea-data-setsolve-failure-reason {
  margin-top: 7px;
  font-size: 11px;
  font-weight: 700;
  color: rgba(255, 212, 212, 0.95);
  line-height: 1.3;
}
#ea-data-setsolve-overlay .ea-data-setsolve-hint {
  margin-top: 6px;
  font-size: 10px;
  font-weight: 700;
  color: rgba(255, 255, 255, 0.56);
}
#ea-data-setsolve-overlay .ea-data-setsolve-empty {
  color: rgba(255, 255, 255, 0.7);
  font-size: 11px;
  font-weight: 700;
  line-height: 1.3;
}
#ea-data-setsolve-overlay .ea-data-setsolve-skeleton {
  margin-top: 7px;
}
#ea-data-setsolve-overlay .ea-data-setsolve-skeleton-line {
  height: 7px;
  border-radius: 999px;
  margin-top: 6px;
  background: linear-gradient(
    90deg,
    rgba(255, 255, 255, 0.06) 0%,
    rgba(255, 255, 255, 0.18) 45%,
    rgba(255, 255, 255, 0.06) 100%
  );
  background-size: 220% 100%;
  animation: ea-data-setsolve-shimmer 1.2s ease-in-out infinite;
}
#ea-data-setsolve-overlay .ea-data-setsolve-skeleton-line:nth-child(1) {
  width: 88%;
}
#ea-data-setsolve-overlay .ea-data-setsolve-skeleton-line:nth-child(2) {
  width: 70%;
}
#ea-data-setsolve-overlay .ea-data-setsolve-skeleton-line:nth-child(3) {
  width: 80%;
}
@keyframes ea-data-setsolve-shimmer {
  0% {
    background-position: 0% 50%;
  }
  100% {
    background-position: 100% 50%;
  }
}
.ea-data-progress {
  margin-top: 8px;
  height: 6px;
  border-radius: 999px;
  overflow: hidden;
  background: rgba(255, 255, 255, 0.10);
  border: 1px solid rgba(255, 255, 255, 0.10);
}
.ea-data-progress__bar {
  height: 100%;
  width: 0%;
  background: #0B96FF;
  border-radius: 999px;
  transition: width 120ms linear;
}
.ea-data-solutions-list {
  margin-top: 10px;
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 10px;
  overflow: hidden;
}
.ea-data-solution-row {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  padding: 10px 12px;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
}
.ea-data-solution-row:first-child {
  border-top: none;
}
.ea-data-solution-title {
  font-weight: 800;
  color: #0B96FF;
  font-size: 13px;
}
.ea-data-solution-meta {
  margin-top: 3px;
  color: rgba(255, 255, 255, 0.70);
  font-weight: 700;
  font-size: 12px;
}
.ea-data-solution-right {
  color: rgba(255, 255, 255, 0.70);
  font-weight: 800;
  font-size: 12px;
  white-space: nowrap;
}
.ea-data-solutions-empty {
  padding: 14px 12px;
  color: rgba(255, 255, 255, 0.65);
  font-weight: 700;
  font-size: 12px;
}
.ea-data-preview-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 10px 12px;
  background: rgba(255, 255, 255, 0.02);
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}
.ea-data-preview-header-right {
  display: flex;
  align-items: center;
  gap: 12px;
}
.ea-data-preview-nav {
  display: flex;
  align-items: center;
  gap: 8px;
}
.ea-data-preview-sort {
  display: flex;
  align-items: center;
  gap: 8px;
}
.ea-data-preview-sort-label {
  font-size: 11px;
  color: rgba(255, 255, 255, 0.62);
  font-weight: 900;
  letter-spacing: 0.2px;
}
.ea-data-preview-sort-select {
  background: rgba(255, 255, 255, 0.06);
  color: rgba(255, 255, 255, 0.90);
  border: 1px solid rgba(255, 255, 255, 0.16);
  border-radius: 8px;
  padding: 6px 10px;
  font-weight: 900;
  font-size: 12px;
  outline: none;
  cursor: pointer;
}
.ea-data-preview-sort-select:hover {
  background: rgba(255, 255, 255, 0.10);
  border-color: rgba(255, 255, 255, 0.30);
}
.ea-data-preview-sort-select:focus {
  border-color: #0B96FF;
  box-shadow: 0 0 0 2px rgba(11, 150, 255, 0.25);
}
.ea-data-preview-sort-select:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.ea-data-preview-nav-btn {
  border: 1px solid rgba(255, 255, 255, 0.16);
  background: rgba(255, 255, 255, 0.06);
  color: rgba(255, 255, 255, 0.90);
  border-radius: 8px;
  padding: 6px 10px;
  font-weight: 900;
  font-size: 12px;
  cursor: pointer;
}
.ea-data-preview-nav-btn:hover {
  background: rgba(255, 255, 255, 0.10);
  border-color: rgba(255, 255, 255, 0.30);
}
.ea-data-preview-nav-btn:active {
  transform: translateY(1px);
}
.ea-data-preview-nav-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.ea-data-preview-page {
  color: rgba(255, 255, 255, 0.70);
  font-weight: 900;
  font-size: 12px;
  min-width: 68px;
  text-align: center;
}
.ea-data-preview-meta {
  padding: 8px 12px;
  color: rgba(255, 255, 255, 0.72);
  font-weight: 800;
  font-size: 12px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}
.ea-data-preview-players {
  max-height: 280px;
  overflow-y: auto;
}
.ea-data-used-summary {
  padding: 10px 12px;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
  background: rgba(255, 255, 255, 0.02);
}
.ea-data-used-summary-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.ea-data-used-summary-title {
  font-size: 11px;
  font-weight: 900;
  letter-spacing: 0.25px;
  color: rgba(255, 255, 255, 0.62);
  text-transform: uppercase;
}
.ea-data-used-summary-pills {
  margin-top: 8px;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  max-height: 78px;
  overflow-y: auto;
  padding-right: 4px;
}
.ea-data-pill--rating {
  border-color: rgba(11, 150, 255, 0.40);
  color: rgba(11, 150, 255, 0.95);
  background: rgba(11, 150, 255, 0.08);
}
.ea-data-preview-row {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  padding: 10px 12px;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
}
.ea-data-preview-row:hover {
  background: rgba(11, 150, 255, 0.06);
}
.ea-data-preview-row:first-child {
  border-top: none;
}
.ea-data-preview-pos {
  width: 62px;
  flex: 0 0 auto;
  font-weight: 900;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.78);
  letter-spacing: 0.2px;
}
.ea-data-preview-main {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.ea-data-preview-left {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}
.ea-data-preview-rating {
  font-weight: 900;
  font-size: 13px;
  color: #ffffff;
}
.ea-data-preview-name {
  font-weight: 800;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.9);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 190px;
  flex: 1 1 auto;
  min-width: 0;
}
.ea-data-preview-rarity {
  font-weight: 800;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.65);
}
.ea-data-preview-right {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  flex-wrap: wrap;
}
.ea-data-preview-id {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px;
  color: rgba(255, 255, 255, 0.55);
}
.ea-data-pill {
  border: 1px solid rgba(255, 255, 255, 0.16);
  background: rgba(255, 255, 255, 0.04);
  color: rgba(255, 255, 255, 0.82);
  border-radius: 999px;
  padding: 2px 8px;
  font-weight: 900;
  font-size: 11px;
  letter-spacing: 0.2px;
}
.ea-data-pill--special {
  border-color: rgba(7, 244, 104, 0.55);
  color: #07F468;
  background: rgba(7, 244, 104, 0.08);
}
.ea-data-pill--warn {
  border-color: rgba(242, 69, 32, 0.55);
  color: #F24520;
  background: rgba(242, 69, 32, 0.08);
}
.ea-data-pill--ok {
  border-color: rgba(7, 244, 104, 0.55);
  color: #07F468;
  background: rgba(7, 244, 104, 0.08);
}
.ea-data-pill--fail {
  border-color: rgba(242, 69, 32, 0.55);
  color: #F24520;
  background: rgba(242, 69, 32, 0.08);
}
.ea-data-multisolve-actions {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
  margin-top: 14px;
  flex-wrap: wrap;
}
.ea-data-multisolve-actions-right {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 10px;
}
#ea-data-loading-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.88);
  display: none;
  align-items: center;
  justify-content: center;
  z-index: 999999;
  color: #fff;
  font-family: "Segoe UI", Arial, sans-serif;
}
#ea-data-loading-overlay .ea-data-loading-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
}
#ea-data-loading-overlay .ea-data-spinner {
  width: 52px;
  height: 52px;
  border: 4px solid rgba(255, 255, 255, 0.2);
  border-top-color: #fff;
  border-radius: 50%;
  animation: ea-data-spin 0.9s linear infinite;
}
#ea-data-loading-overlay .ea-data-loading-text {
  font-size: 14px;
  letter-spacing: 0.4px;
}
@keyframes ea-data-spin {
  to {
    transform: rotate(360deg);
  }
}

#ea-data-toast-host {
  position: fixed;
  top: calc(max(12px, env(safe-area-inset-top)) + 44px);
  right: max(12px, env(safe-area-inset-right));
  z-index: 2147483647; /* Stay above any EA modal */
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 10px;
  pointer-events: none;
}
@media (max-width: 520px) {
  #ea-data-toast-host {
    left: max(12px, env(safe-area-inset-left));
    align-items: stretch;
  }
}
.ea-data-toast {
  --ea-toast-accent: #0B96FF;
  pointer-events: auto;
  display: inline-flex;
  width: auto;
  max-width: min(360px, calc(100vw - 24px));
  background: #0b0b0b;
  border: 2px solid var(--ea-toast-accent);
  border-radius: 6px;
  box-shadow: 0 10px 24px rgba(0, 0, 0, 0.55);
  padding: 10px 12px;
  align-items: center;
  gap: 10px;
  font-family: "Segoe UI", Arial, sans-serif;
  will-change: transform, opacity;
  animation: ea-data-toast-in 240ms cubic-bezier(0.2, 0.8, 0.2, 1) both;
}
@media (max-width: 520px) {
  .ea-data-toast {
    display: flex;
    width: 100%;
    max-width: none;
  }
}
.ea-data-toast[data-type="error"] {
  --ea-toast-accent: #F24520;
}
.ea-data-toast[data-type="success"] {
  --ea-toast-accent: #07F468;
}
.ea-data-toast.ea-data-toast--leaving {
  animation: ea-data-toast-out 200ms cubic-bezier(0.2, 0.8, 0.2, 1) both;
}
.ea-data-toast__icon {
  width: 22px;
  height: 22px;
  border-radius: 999px;
  background: var(--ea-toast-accent);
  color: #000000;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 800;
  font-size: 13px;
  line-height: 1;
  flex: 0 0 auto;
  font-family: "Segoe UI Symbol", "Segoe UI", Arial, sans-serif;
}
.ea-data-toast__text {
  flex: 1;
  min-width: 0;
  color: var(--ea-toast-accent);
  font-weight: 700;
  font-size: 14px;
  line-height: 1.15;
}
.ea-data-toast__message {
  margin-top: 2px;
  font-weight: 600;
  font-size: 13px;
  line-height: 1.15;
  color: var(--ea-toast-accent);
}
.ea-data-toast__close {
  border: none;
  background: transparent;
  cursor: pointer;
  padding: 0;
  width: 22px;
  height: 22px;
  display: grid;
  place-items: center;
  color: rgba(255, 255, 255, 0.65);
  font-size: 16px;
  line-height: 1;
  flex: 0 0 auto;
}
.ea-data-toast__close:hover {
  color: rgba(255, 255, 255, 0.95);
}
.ea-data-toast__close:active {
  transform: translateY(1px);
}
@keyframes ea-data-toast-in {
  from {
    opacity: 0;
    transform: translate3d(18px, -12px, 0) scale(0.985);
  }
  to {
    opacity: 1;
    transform: translate3d(0, 0, 0) scale(1);
  }
}
@keyframes ea-data-toast-out {
  to {
    opacity: 0;
    transform: translate3d(14px, -10px, 0) scale(0.985);
  }
}
`;
    (document.head || document.documentElement).appendChild(style);
    solveButtonStyleInjected = true;
  };

  const ensureLoadingOverlay = () => {
    ensureSolveButtonStyles();
    if (document.getElementById("ea-data-loading-overlay")) return;
    const overlay = document.createElement("div");
    overlay.id = "ea-data-loading-overlay";
    overlay.setAttribute("aria-hidden", "true");
    overlay.innerHTML = `
      <div class="ea-data-loading-card">
        <div class="ea-data-spinner"></div>
        <div class="ea-data-loading-text">Solving squad...</div>
      </div>
    `;
    document.body.appendChild(overlay);
  };

  const setLoadingOverlayVisible = (visible, label) => {
    ensureLoadingOverlay();
    const overlay = document.getElementById("ea-data-loading-overlay");
    if (!overlay) return;
    if (label != null) {
      const text = overlay.querySelector(".ea-data-loading-text");
      if (text) text.textContent = label;
    }
    overlay.style.display = visible ? "flex" : "none";
    overlay.style.pointerEvents = visible ? "auto" : "none";
    overlay.setAttribute("aria-hidden", visible ? "false" : "true");
  };

  const showLoadingOverlay = (label) => {
    loadingOverlayCount += 1;
    setLoadingOverlayVisible(true, label);
  };

  const updateLoadingOverlay = (label) => {
    if (loadingOverlayCount <= 0) return;
    setLoadingOverlayVisible(true, label);
  };

  const hideLoadingOverlay = () => {
    loadingOverlayCount = Math.max(0, loadingOverlayCount - 1);
    if (loadingOverlayCount === 0) {
      setLoadingOverlayVisible(false);
    }
  };

  let activeProgressToast = null;

  const ensureToastHost = () => {
    ensureSolveButtonStyles();
    let host = document.getElementById("ea-data-toast-host");
    if (host) return host;
    host = document.createElement("div");
    host.id = "ea-data-toast-host";
    host.setAttribute("aria-live", "polite");
    host.setAttribute("aria-relevant", "additions");
    host.setAttribute("aria-atomic", "false");
    document.body.appendChild(host);
    return host;
  };

  const dismissToast = (toast) => {
    if (!toast) return;
    try {
      clearTimeout(toast.__eaDataToastTimerId);
    } catch {}
    try {
      toast.classList.add("ea-data-toast--leaving");
    } catch {}
    try {
      setTimeout(() => toast.remove(), 220);
    } catch {
      try {
        toast.remove();
      } catch {}
    }
  };

  const showToast = (options = {}) => {
    const host = ensureToastHost();
    const type =
      options.type === "error" ||
      options.type === "success" ||
      options.type === "info"
        ? options.type
        : "info";
    const title = options.title != null ? String(options.title) : "";
    const message = options.message != null ? String(options.message) : "";

    // Toast durations should be short to avoid cluttering the UI.
    // Allow `timeoutMs: 0` for persistent "progress" toasts.
    const requestedTimeoutMs = readNumeric(options.timeoutMs);
    const defaultTimeoutMs =
      type === "success" ? 1800 : type === "error" ? 2800 : 2200;
    const capTimeoutMs =
      type === "success" ? 2500 : type === "error" ? 4000 : 3000;
    let timeoutMs = Math.max(0, requestedTimeoutMs ?? defaultTimeoutMs);
    if (timeoutMs > 0) timeoutMs = Math.min(timeoutMs, capTimeoutMs);

    // Cap concurrent toasts.
    try {
      while (host.children.length >= 3) host.removeChild(host.firstChild);
    } catch {}

    const toast = document.createElement("div");
    toast.className = "ea-data-toast";
    toast.dataset.type = type;
    toast.setAttribute("role", type === "error" ? "alert" : "status");
    toast.tabIndex = 0;

    const icon = document.createElement("div");
    icon.className = "ea-data-toast__icon";
    icon.textContent =
      type === "error" ? "\u2715" : type === "success" ? "\u2713" : "i";

    const textWrap = document.createElement("div");
    textWrap.className = "ea-data-toast__text";
    textWrap.textContent = title;

    if (message) {
      const msgEl = document.createElement("div");
      msgEl.className = "ea-data-toast__message";
      msgEl.textContent = message;
      textWrap.append(msgEl);
    }

    const close = document.createElement("button");
    close.type = "button";
    close.className = "ea-data-toast__close";
    close.textContent = "\u00D7";
    close.setAttribute("aria-label", "Dismiss notification");
    close.addEventListener("click", (event) => {
      try {
        event.stopPropagation();
      } catch {}
      dismissToast(toast);
    });

    toast.addEventListener("click", () => dismissToast(toast));
    toast.addEventListener("keydown", (event) => {
      const key = event?.key;
      if (key === "Enter" || key === " " || key === "Escape") {
        try {
          event.preventDefault();
        } catch {}
        dismissToast(toast);
      }
    });

    toast.append(icon);
    toast.append(textWrap);
    toast.append(close);
    host.append(toast);

    if (timeoutMs > 0) {
      toast.__eaDataToastTimerId = setTimeout(
        () => dismissToast(toast),
        timeoutMs,
      );
    }

    return toast;
  };

  // Settings (preferences) overlay
  let settingsOverlayState = null;
  let settingsOverlayKeyHandlerBound = false;

  const closeSettingsOverlay = () => {
    const overlay = document.getElementById("ea-data-settings-overlay");
    if (!overlay) return;
    overlay.setAttribute("aria-hidden", "true");
    try {
      overlay.style.pointerEvents = "none";
    } catch {}
  };

  const ensureSettingsOverlay = () => {
    ensureSolveButtonStyles();
    const existing = document.getElementById("ea-data-settings-overlay");
    if (existing && settingsOverlayState) return existing;

    const overlay = existing || document.createElement("div");
    overlay.id = "ea-data-settings-overlay";
    overlay.setAttribute("aria-hidden", "true");
    overlay.innerHTML = `
      <div class="ea-data-settings-modal" role="dialog" aria-modal="true" aria-labelledby="ea-data-settings-title">
        <div class="ea-data-settings-header">
          <div class="ea-data-settings-title" id="ea-data-settings-title">Solver Settings</div>
          <button type="button" class="ea-data-settings-close" aria-label="Close settings" data-action="close">×</button>
        </div>

        <div class="ea-data-settings-section-label">Player Rating Range</div>
        <div class="ea-data-range" id="ea-data-rating-range">
          <div class="ea-data-range__track"></div>
          <input
            class="ea-data-range__input ea-data-range__input--min"
            id="ea-data-rating-min"
            type="range"
            min="0"
            max="99"
            step="1"
            value="0"
          />
          <input
            class="ea-data-range__input ea-data-range__input--max"
            id="ea-data-rating-max"
            type="range"
            min="0"
            max="99"
            step="1"
            value="99"
          />
        </div>

        <div class="ea-data-range__fields">
          <div class="ea-data-range__field">
            <div class="ea-data-range__label">Min</div>
            <input
              class="ea-data-range__number"
              id="ea-data-rating-min-input"
              type="number"
              min="0"
              max="99"
              step="1"
              value="0"
              inputmode="numeric"
            />
          </div>
          <div class="ea-data-range__field">
            <div class="ea-data-range__label">Max</div>
            <input
              class="ea-data-range__number"
              id="ea-data-rating-max-input"
              type="number"
              min="0"
              max="99"
              step="1"
              value="99"
              inputmode="numeric"
            />
          </div>
        </div>

        <div class="ea-data-settings-section-label" style="margin-top:12px">Player Pool Options</div>
        <div class="ea-data-toggle-list">
          ${renderSolverToggleFields({ scope: "challenge", idPrefix: "ea-data-setting-" })}
        </div>

        <div class="ea-data-settings-actions">
          <button type="button" class="ea-data-btn ea-data-btn--ghost" data-action="cancel">Cancel</button>
          <button type="button" class="ea-data-btn ea-data-btn--primary" data-action="save">Save</button>
        </div>
      </div>
    `;

    if (!existing) document.body.appendChild(overlay);

    const modal = overlay.querySelector(".ea-data-settings-modal");
    const rangeRoot = overlay.querySelector("#ea-data-rating-range");
    const minRange = overlay.querySelector("#ea-data-rating-min");
    const maxRange = overlay.querySelector("#ea-data-rating-max");
    const minInput = overlay.querySelector("#ea-data-rating-min-input");
    const maxInput = overlay.querySelector("#ea-data-rating-max-input");
    const closeBtn = overlay.querySelector('[data-action="close"]');
    const cancelBtn = overlay.querySelector('[data-action="cancel"]');
    const saveBtn = overlay.querySelector('[data-action="save"]');
    const toggleBinder = createSolverToggleBinder({
      root: overlay,
      scope: "challenge",
      idPrefix: "ea-data-setting-",
    });

    const sync = (settings, { source } = {}) => {
      const previous =
        settingsOverlayState?.current &&
        typeof settingsOverlayState.current === "object"
          ? settingsOverlayState.current
          : getDefaultSolverSettings();
      const raw = settings && typeof settings === "object" ? settings : {};
      const rangeSource =
        raw?.ratingRange && typeof raw.ratingRange === "object"
          ? raw.ratingRange
          : raw;
      let ratingMin = clampInt(
        rangeSource.ratingMin ??
          rangeSource.min ??
          rangeSource.minRating ??
          rangeSource.min_rating,
        0,
        99,
      );
      let ratingMax = clampInt(
        rangeSource.ratingMax ??
          rangeSource.max ??
          rangeSource.maxRating ??
          rangeSource.max_rating,
        0,
        99,
      );
      if (ratingMin == null) {
        ratingMin =
          clampInt(
            previous?.ratingRange?.ratingMin ?? previous?.ratingMin,
            0,
            99,
          ) ?? 0;
      }
      if (ratingMax == null) {
        ratingMax =
          clampInt(
            previous?.ratingRange?.ratingMax ?? previous?.ratingMax,
            0,
            99,
          ) ?? 99;
      }

      if (ratingMin > ratingMax) {
        if (source === "min")
          ratingMin = ratingMax; // clamp min (don't move max)
        else if (source === "max")
          ratingMax = ratingMin; // clamp max (don't move min)
        else {
          const tmp = ratingMin;
          ratingMin = ratingMax;
          ratingMax = tmp;
        }
      }

      try {
        minRange.value = String(ratingMin);
        maxRange.value = String(ratingMax);
      } catch {}
      try {
        minInput.value = String(ratingMin);
        maxInput.value = String(ratingMax);
      } catch {}

      // When handles overlap (ex: min == max), bring the active handle above the other
      // so it remains draggable.
      try {
        if (ratingMin === ratingMax) {
          if (source === "min") {
            minRange.style.zIndex = "6";
            maxRange.style.zIndex = "5";
          } else if (source === "max") {
            maxRange.style.zIndex = "6";
            minRange.style.zIndex = "5";
          }
        } else {
          minRange.style.zIndex = "";
          maxRange.style.zIndex = "";
        }
      } catch {}

      const minPct = (ratingMin / 99) * 100;
      const maxPct = (ratingMax / 99) * 100;
      try {
        rangeRoot?.style?.setProperty("--min-pct", `${minPct}%`);
        rangeRoot?.style?.setProperty("--max-pct", `${maxPct}%`);
      } catch {}

      const poolSettings = toggleBinder.setValues(raw, previous);

      settingsOverlayState.current = {
        ratingRange: { ratingMin, ratingMax },
        ...poolSettings,
      };
    };

    settingsOverlayState = {
      overlay,
      rangeRoot,
      minRange,
      maxRange,
      minInput,
      maxInput,
      closeBtn,
      cancelBtn,
      saveBtn,
      toggleBinder,
      sync,
      current: getDefaultSolverSettings(),
      challengeId: null,
    };

    overlay.addEventListener("click", (event) => {
      if (event.target !== overlay) return;
      closeSettingsOverlay();
    });

    closeBtn?.addEventListener("click", (event) => {
      try {
        event.stopPropagation();
      } catch {}
      closeSettingsOverlay();
    });
    cancelBtn?.addEventListener("click", (event) => {
      try {
        event.stopPropagation();
      } catch {}
      closeSettingsOverlay();
    });

    minRange?.addEventListener("input", () =>
      sync(
        { ratingMin: minRange.value, ratingMax: maxRange.value },
        { source: "min" },
      ),
    );
    maxRange?.addEventListener("input", () =>
      sync(
        { ratingMin: minRange.value, ratingMax: maxRange.value },
        { source: "max" },
      ),
    );
    minInput?.addEventListener("input", () =>
      sync(
        { ratingMin: minInput.value, ratingMax: maxInput.value },
        { source: "min" },
      ),
    );
    maxInput?.addEventListener("input", () =>
      sync(
        { ratingMin: minInput.value, ratingMax: maxInput.value },
        { source: "max" },
      ),
    );

    saveBtn?.addEventListener("click", async (event) => {
      try {
        event.stopPropagation();
      } catch {}

      const current =
        settingsOverlayState?.current &&
        typeof settingsOverlayState.current === "object"
          ? settingsOverlayState.current
          : getDefaultSolverSettings();
      const next = {
        ratingRange: normalizeRatingRange(current.ratingRange),
        ...toggleBinder.getValues(current),
      };
      try {
        const challengeId =
          settingsOverlayState?.challengeId ?? currentChallenge?.id ?? null;
        if (challengeId == null) throw new Error("Missing challengeId");
        await setChallengeSolverSettings(challengeId, next);
        closeSettingsOverlay();
        showToast({
          type: "success",
          title: "Settings Saved",
          message: "",
          timeoutMs: 3500,
        });
      } catch (error) {
        log("debug", "[EA Data] Settings save failed", error);
        showToast({
          type: "error",
          title: "Settings Error",
          message: "Failed to save settings.",
          timeoutMs: 9000,
        });
      }
    });

    if (!settingsOverlayKeyHandlerBound) {
      settingsOverlayKeyHandlerBound = true;
      document.addEventListener(
        "keydown",
        (event) => {
          if (event?.key !== "Escape") return;
          const open =
            document
              .getElementById("ea-data-settings-overlay")
              ?.getAttribute("aria-hidden") === "false";
          if (!open) return;
          try {
            event.preventDefault();
          } catch {}
          closeSettingsOverlay();
        },
        true,
      );
    }

    sync(getDefaultSolverSettings(), { source: "init" });
    return overlay;
  };

  const openSettingsOverlay = async () => {
    const challengeId = currentChallenge?.id ?? null;
    if (challengeId == null) {
      showToast({
        type: "error",
        title: "Settings Unavailable",
        message: "Open an SBC challenge first.",
        timeoutMs: 6500,
      });
      return;
    }

    const overlay = ensureSettingsOverlay();
    overlay.setAttribute("aria-hidden", "false");
    try {
      overlay.style.pointerEvents = "auto";
    } catch {}
    try {
      settingsOverlayState.challengeId = challengeId;
    } catch {}

    let settings = null;
    try {
      settings = await getSolverSettingsForChallenge(challengeId);
    } catch {
      settings = getDefaultSolverSettings();
    }
    try {
      settingsOverlayState?.sync?.(settings, { source: "open" });
    } catch {}
    try {
      const minInput = overlay.querySelector("#ea-data-rating-min-input");
      minInput?.focus?.();
      minInput?.select?.();
    } catch {}
  };

  const resolveAppSettingsActionsRoot = (view) => {
    if (!view) return null;
    const roots = [
      view?.getRootElement?.(),
      view?._root,
      view?.root,
      view?.__root,
    ];
    for (const root of roots) {
      if (!root || typeof root.querySelector !== "function") continue;
      const actions = root.querySelector(".ut-app-settings-actions");
      if (actions && typeof actions.appendChild === "function") return actions;
    }
    return null;
  };

  const cleanupGlobalSettingsSection = (view) => {
    if (!view) return;
    const state = view?.__eaDataGlobalSettingsState ?? null;
    try {
      if (state) globalSettingsStateRegistry.delete(state);
    } catch {}
    try {
      for (const off of state?.listeners ?? []) {
        try {
          off?.();
        } catch {}
      }
    } catch {}
    try {
      state?.section?.remove?.();
    } catch {}
    try {
      view.__eaDataGlobalSettingsSection = null;
      view.__eaDataGlobalSettingsState = null;
    } catch {}
  };

  const refreshGlobalSettingsSection = async (view) => {
    const state = view?.__eaDataGlobalSettingsState ?? null;
    if (!state?.sync) return;
    let settings = null;
    try {
      settings = await getSolverSettingsForChallenge(null);
    } catch {
      settings = null;
    }
    if (!settings) settings = getDefaultSolverSettings();
    try {
      state.sync(settings, { source: "load" });
    } catch {}
  };

  const refreshAllGlobalSettingsSections = async () => {
    if (!globalSettingsStateRegistry.size) return;
    let settings = null;
    try {
      settings = await getSolverSettingsForChallenge(null);
    } catch {
      settings = null;
    }
    if (!settings) settings = getDefaultSolverSettings();
    for (const state of Array.from(globalSettingsStateRegistry)) {
      if (!state?.sync) continue;
      try {
        state.sync(settings, { source: "external" });
      } catch {}
    }
  };

  const ensureGlobalSettingsSection = (view) => {
    if (!view) return null;
    try {
      ensureSolveButtonStyles();
    } catch {}
    const actionsRoot = resolveAppSettingsActionsRoot(view);
    if (!actionsRoot) return null;

    const existing = view?.__eaDataGlobalSettingsSection ?? null;
    if (existing && existing.isConnected) {
      void refreshGlobalSettingsSection(view);
      return existing;
    }

    const section = document.createElement("div");
    section.className = "ea-data-app-settings-group";
    section.innerHTML = `
      <div class="ea-data-app-settings-divider"><span>SBC Solver</span></div>
      <div class="ea-data-app-settings-subtitle">Global defaults for all solvers. Challenge-local and session settings override these values.</div>
      <div class="ea-data-settings-section-label">Global Player Rating Range</div>
      <div class="ea-data-range" id="ea-data-app-settings-global-range">
        <div class="ea-data-range__track"></div>
        <input class="ea-data-range__input ea-data-range__input--min" id="ea-data-app-settings-global-min" type="range" min="0" max="99" step="1" value="0" />
        <input class="ea-data-range__input ea-data-range__input--max" id="ea-data-app-settings-global-max" type="range" min="0" max="99" step="1" value="99" />
      </div>
      <div class="ea-data-range__fields">
        <div class="ea-data-range__field">
          <div class="ea-data-range__label">Min</div>
          <input class="ea-data-range__number" id="ea-data-app-settings-global-min-input" type="number" min="0" max="99" step="1" value="0" inputmode="numeric" />
        </div>
        <div class="ea-data-range__field">
          <div class="ea-data-range__label">Max</div>
          <input class="ea-data-range__number" id="ea-data-app-settings-global-max-input" type="number" min="0" max="99" step="1" value="99" inputmode="numeric" />
        </div>
      </div>
      <div class="ea-data-settings-section-label" style="margin-top:12px">Global Player Pool Options</div>
      <div class="ea-data-toggle-list">
        ${renderSolverToggleFields({ scope: "global", idPrefix: "ea-data-app-setting-" })}
      </div>
      <div class="ea-data-settings-section-label" style="margin-top:12px">Excluded Players</div>
      <div class="ea-data-excluded-wrap">
        <div class="ea-data-excluded-meta">
          <span class="ea-data-excluded-count" id="ea-data-app-settings-excluded-count">0 excluded</span>
          <button type="button" class="ea-data-excluded-clear" data-action="clear-excluded">Clear All</button>
        </div>
        <div class="ea-data-excluded-list" id="ea-data-app-settings-excluded-list">
          <div class="ea-data-excluded-empty">No excluded players.</div>
        </div>
      </div>
      <div class="ea-data-collapsible-section">
        <button type="button" class="ea-data-collapsible-heading" id="ea-data-app-settings-excluded-leagues-toggle" data-action="toggle-excluded-leagues" aria-expanded="false" aria-controls="ea-data-app-settings-excluded-leagues-panel">
          <span>Excluded Leagues</span>
          <span class="ea-data-collapsible-chevron" aria-hidden="true">&#9662;</span>
        </button>
        <div class="ea-data-excluded-leagues-wrap" id="ea-data-app-settings-excluded-leagues-panel" aria-hidden="true" hidden>
          <div class="ea-data-excluded-meta">
            <span class="ea-data-excluded-count" id="ea-data-app-settings-excluded-league-count">0 excluded</span>
            <button type="button" class="ea-data-excluded-clear" data-action="clear-excluded-leagues">Clear All</button>
          </div>
          <input
            class="ea-data-excluded-leagues-search"
            id="ea-data-app-settings-excluded-leagues-search"
            type="search"
            spellcheck="false"
            autocomplete="off"
            placeholder="Search leagues by name or ID..."
          />
          <div class="ea-data-excluded-leagues-selected" id="ea-data-app-settings-excluded-leagues-selected">
            <div class="ea-data-excluded-empty">No excluded leagues.</div>
          </div>
          <div class="ea-data-excluded-leagues-list" id="ea-data-app-settings-excluded-leagues-list">
            <div class="ea-data-excluded-empty">Loading leagues...</div>
          </div>
          <div class="ea-data-excluded-leagues-muted">Excluded leagues could cause conflicts with league-specific challenge requirements.</div>
        </div>
      </div>
      <div class="ea-data-collapsible-section">
        <button type="button" class="ea-data-collapsible-heading" id="ea-data-app-settings-excluded-nations-toggle" data-action="toggle-excluded-nations" aria-expanded="false" aria-controls="ea-data-app-settings-excluded-nations-panel">
          <span>Excluded Nations</span>
          <span class="ea-data-collapsible-chevron" aria-hidden="true">&#9662;</span>
        </button>
        <div class="ea-data-excluded-leagues-wrap" id="ea-data-app-settings-excluded-nations-panel" aria-hidden="true" hidden>
          <div class="ea-data-excluded-meta">
            <span class="ea-data-excluded-count" id="ea-data-app-settings-excluded-nation-count">0 excluded</span>
            <button type="button" class="ea-data-excluded-clear" data-action="clear-excluded-nations">Clear All</button>
          </div>
          <input
            class="ea-data-excluded-leagues-search"
            id="ea-data-app-settings-excluded-nations-search"
            type="search"
            spellcheck="false"
            autocomplete="off"
            placeholder="Search nations by name or ID..."
          />
          <div class="ea-data-excluded-leagues-selected" id="ea-data-app-settings-excluded-nations-selected">
            <div class="ea-data-excluded-empty">No excluded nations.</div>
          </div>
          <div class="ea-data-excluded-leagues-list" id="ea-data-app-settings-excluded-nations-list">
            <div class="ea-data-excluded-empty">Loading nations...</div>
          </div>
          <div class="ea-data-excluded-leagues-muted">Excluded nations could cause conflicts with nation-specific challenge requirements.</div>
        </div>
      </div>
      <div class="ea-data-app-settings-actions">
        <button type="button" class="ea-data-app-settings-btn ea-data-app-settings-btn--reset" data-action="reset-global">Reset Global</button>
        <button type="button" class="ea-data-app-settings-btn" data-action="save-global">Save Global</button>
      </div>
    `;
    actionsRoot.append(section);

    const rangeRoot = section.querySelector(
      "#ea-data-app-settings-global-range",
    );
    const minRange = section.querySelector("#ea-data-app-settings-global-min");
    const maxRange = section.querySelector("#ea-data-app-settings-global-max");
    const minInput = section.querySelector(
      "#ea-data-app-settings-global-min-input",
    );
    const maxInput = section.querySelector(
      "#ea-data-app-settings-global-max-input",
    );
    const toggleBinder = createSolverToggleBinder({
      root: section,
      scope: "global",
      idPrefix: "ea-data-app-setting-",
    });
    const excludedCountEl = section.querySelector(
      "#ea-data-app-settings-excluded-count",
    );
    const excludedListEl = section.querySelector(
      "#ea-data-app-settings-excluded-list",
    );
    const clearExcludedBtn = section.querySelector(
      '[data-action="clear-excluded"]',
    );
    const excludedLeagueCountEl = section.querySelector(
      "#ea-data-app-settings-excluded-league-count",
    );
    const excludedLeagueSearchInput = section.querySelector(
      "#ea-data-app-settings-excluded-leagues-search",
    );
    const excludedLeagueSelectedEl = section.querySelector(
      "#ea-data-app-settings-excluded-leagues-selected",
    );
    const excludedLeagueListEl = section.querySelector(
      "#ea-data-app-settings-excluded-leagues-list",
    );
    const clearExcludedLeaguesBtn = section.querySelector(
      '[data-action="clear-excluded-leagues"]',
    );
    const toggleExcludedLeaguesBtn = section.querySelector(
      '[data-action="toggle-excluded-leagues"]',
    );
    const excludedLeaguesPanel = section.querySelector(
      "#ea-data-app-settings-excluded-leagues-panel",
    );
    const excludedNationCountEl = section.querySelector(
      "#ea-data-app-settings-excluded-nation-count",
    );
    const excludedNationSearchInput = section.querySelector(
      "#ea-data-app-settings-excluded-nations-search",
    );
    const excludedNationSelectedEl = section.querySelector(
      "#ea-data-app-settings-excluded-nations-selected",
    );
    const excludedNationListEl = section.querySelector(
      "#ea-data-app-settings-excluded-nations-list",
    );
    const clearExcludedNationsBtn = section.querySelector(
      '[data-action="clear-excluded-nations"]',
    );
    const toggleExcludedNationsBtn = section.querySelector(
      '[data-action="toggle-excluded-nations"]',
    );
    const excludedNationsPanel = section.querySelector(
      "#ea-data-app-settings-excluded-nations-panel",
    );
    const resetBtn = section.querySelector('[data-action="reset-global"]');
    const saveBtn = section.querySelector('[data-action="save-global"]');
    const listeners = [];
    let exclusionActionInFlight = false;
    let excludedLeagueActionInFlight = false;
    let excludedNationActionInFlight = false;
    let lastExcludedSignature = "";
    let lastExcludedLeagueSignature = "";
    let lastExcludedNationSignature = "";
    let excludedLeagueSearchValue = "";
    let excludedLeagueOptions = [];
    let excludedLeagueOptionsHydrated = false;
    let excludedLeagueHydrateToken = 0;
    let excludedNationSearchValue = "";
    let excludedNationOptions = [];
    let excludedNationOptionsHydrated = false;
    let excludedNationHydrateToken = 0;

    const on = (target, type, fn) => {
      if (!target || typeof target.addEventListener !== "function") return;
      target.addEventListener(type, fn);
      listeners.push(() => {
        try {
          target.removeEventListener(type, fn);
        } catch {}
      });
    };

    const setCollapsibleExpanded = (buttonEl, panelEl, expanded) => {
      const nextExpanded = Boolean(expanded);
      try {
        buttonEl?.setAttribute?.(
          "aria-expanded",
          nextExpanded ? "true" : "false",
        );
      } catch {}
      try {
        if (panelEl) {
          panelEl.hidden = !nextExpanded;
          panelEl.setAttribute("aria-hidden", nextExpanded ? "false" : "true");
        }
      } catch {}
    };

    const toggleCollapsible = (buttonEl, panelEl) => {
      const expanded =
        String(buttonEl?.getAttribute?.("aria-expanded") ?? "false") === "true";
      setCollapsibleExpanded(buttonEl, panelEl, !expanded);
    };

    const renderExcludedPlayersList = (excludedIds = []) => {
      if (!excludedCountEl || !excludedListEl) return;
      loadExcludedPlayerMetaCache();
      const normalized = normalizePlayerIdList(excludedIds, []);
      const count = normalized.length;
      try {
        excludedCountEl.textContent = `${count} excluded`;
      } catch {}
      try {
        clearExcludedBtn.disabled = exclusionActionInFlight || count === 0;
      } catch {}

      try {
        while (excludedListEl.firstChild) {
          excludedListEl.removeChild(excludedListEl.firstChild);
        }
      } catch {
        try {
          excludedListEl.innerHTML = "";
        } catch {}
      }

      if (!count) {
        const empty = document.createElement("div");
        empty.className = "ea-data-excluded-empty";
        empty.textContent = "No excluded players.";
        excludedListEl.append(empty);
        return;
      }

      for (const id of normalized) {
        const row = document.createElement("div");
        row.className = "ea-data-excluded-item";

        const main = document.createElement("div");
        main.className = "ea-data-excluded-item-main";

        const nameEl = document.createElement("div");
        nameEl.className = "ea-data-excluded-item-name";
        const cachedMeta = excludedPlayerMetaCache.get(String(id));
        const meta =
          cachedMeta && typeof cachedMeta === "object" ? cachedMeta : null;
        nameEl.textContent = meta?.name ?? `Player ${id}`;

        const metaEl = document.createElement("div");
        metaEl.className = "ea-data-excluded-item-meta";
        const metaBits = [];
        if (meta?.rating != null) {
          metaBits.push(`${meta.rating} OVR`);
        }
        if (meta?.rarityName) {
          metaBits.push(meta.rarityName);
        }
        metaEl.textContent = metaBits.length
          ? metaBits.join(" \u2022 ")
          : "Player card";

        main.append(nameEl);
        main.append(metaEl);

        const removeBtn = document.createElement("button");
        removeBtn.type = "button";
        removeBtn.className = "ea-data-excluded-remove";
        removeBtn.setAttribute("data-action", "remove-excluded");
        removeBtn.setAttribute("data-id", String(id));
        removeBtn.textContent = "Remove";
        removeBtn.disabled = exclusionActionInFlight;

        row.append(main);
        row.append(removeBtn);
        excludedListEl.append(row);
      }
    };

    const hydrateExcludedNames = async (excludedIds = []) => {
      loadExcludedPlayerMetaCache();
      const normalized = normalizePlayerIdList(excludedIds, []);
      if (!normalized.length) return;
      const missing = normalized.filter((id) => {
        const meta = excludedPlayerMetaCache.get(String(id));
        if (!meta || typeof meta !== "object") return true;
        return meta.rating == null || !meta.rarityName;
      });
      if (!missing.length) return;
      try {
        const snapshot = await ensurePlayersSnapshot({ ignoreLoaned: true });
        cacheExcludedPlayerNames(snapshot?.clubPlayers ?? []);
        cacheExcludedPlayerNames(snapshot?.storagePlayers ?? []);
        renderExcludedPlayersList(normalized);
      } catch {}
    };

    const getLeagueLabel = (leagueId) => {
      const id = normalizeLeagueId(leagueId);
      if (!id) return null;
      const cached = leagueMetaCache.get(String(id));
      const cachedName = sanitizeDisplayText(cached?.name);
      if (cachedName) return cachedName;
      const lookupName = sanitizeDisplayText(getLeagueName(id));
      if (lookupName) {
        upsertLeagueMeta(id, { name: lookupName });
        return lookupName;
      }
      return `League ${id}`;
    };

    const renderExcludedLeagueChips = (excludedLeagueIds = []) => {
      if (!excludedLeagueCountEl || !excludedLeagueSelectedEl) return;
      const normalized = normalizeLeagueIdList(excludedLeagueIds, []);
      const count = normalized.length;
      try {
        excludedLeagueCountEl.textContent = `${count} excluded`;
      } catch {}
      try {
        clearExcludedLeaguesBtn.disabled =
          excludedLeagueActionInFlight || count === 0;
      } catch {}

      try {
        while (excludedLeagueSelectedEl.firstChild) {
          excludedLeagueSelectedEl.removeChild(
            excludedLeagueSelectedEl.firstChild,
          );
        }
      } catch {
        try {
          excludedLeagueSelectedEl.innerHTML = "";
        } catch {}
      }

      if (!count) {
        const empty = document.createElement("div");
        empty.className = "ea-data-excluded-empty";
        empty.textContent = "No excluded leagues.";
        excludedLeagueSelectedEl.append(empty);
        return;
      }

      for (const id of normalized) {
        const chip = document.createElement("div");
        chip.className = "ea-data-excluded-league-chip";

        const label = document.createElement("span");
        label.textContent = getLeagueLabel(id) ?? `League ${id}`;

        const removeBtn = document.createElement("button");
        removeBtn.type = "button";
        removeBtn.className = "ea-data-excluded-league-chip-remove";
        removeBtn.setAttribute("data-action", "remove-excluded-league");
        removeBtn.setAttribute("data-id", String(id));
        removeBtn.textContent = "\u00D7";
        removeBtn.disabled = excludedLeagueActionInFlight;

        chip.append(label);
        chip.append(removeBtn);
        excludedLeagueSelectedEl.append(chip);
      }
    };

    const renderExcludedLeagueOptions = (excludedLeagueIds = []) => {
      if (!excludedLeagueListEl) return;
      const normalizedExcluded = normalizeLeagueIdList(excludedLeagueIds, []);
      const excludedSet = new Set(normalizedExcluded.map(String));
      const search = String(excludedLeagueSearchValue ?? "")
        .trim()
        .toLowerCase();
      const options = Array.isArray(excludedLeagueOptions)
        ? excludedLeagueOptions
        : [];
      const filtered = options.filter((entry) => {
        const idText = String(entry?.id ?? "").toLowerCase();
        const nameText = String(entry?.name ?? "").toLowerCase();
        if (!search) return true;
        return idText.includes(search) || nameText.includes(search);
      });

      try {
        while (excludedLeagueListEl.firstChild) {
          excludedLeagueListEl.removeChild(excludedLeagueListEl.firstChild);
        }
      } catch {
        try {
          excludedLeagueListEl.innerHTML = "";
        } catch {}
      }

      if (!filtered.length) {
        const empty = document.createElement("div");
        empty.className = "ea-data-excluded-empty";
        empty.textContent = excludedLeagueOptionsHydrated
          ? "No leagues match the current search."
          : "Loading leagues...";
        excludedLeagueListEl.append(empty);
        return;
      }

      for (const entry of filtered) {
        const leagueId = normalizeLeagueId(entry?.id);
        if (!leagueId) continue;
        const leagueName =
          sanitizeDisplayText(entry?.name) ??
          getLeagueLabel(leagueId) ??
          `League ${leagueId}`;
        const selected = excludedSet.has(String(leagueId));

        const row = document.createElement("div");
        row.className = "ea-data-excluded-leagues-option";
        row.setAttribute("data-id", String(leagueId));
        row.setAttribute("data-selected", selected ? "true" : "false");

        const main = document.createElement("div");
        main.className = "ea-data-excluded-leagues-option-main";
        const nameEl = document.createElement("div");
        nameEl.className = "ea-data-excluded-leagues-option-name";
        nameEl.textContent = leagueName;
        const idEl = document.createElement("div");
        idEl.className = "ea-data-excluded-leagues-option-id";
        idEl.textContent = `League ID ${leagueId}`;
        main.append(nameEl);
        main.append(idEl);

        const check = document.createElement("div");
        check.className = "ea-data-excluded-leagues-option-check";
        check.textContent = selected ? "\u2713" : "";

        row.append(main);
        row.append(check);
        excludedLeagueListEl.append(row);
      }
    };

    const hydrateExcludedLeagueOptions = async ({ force = false } = {}) => {
      const token = ++excludedLeagueHydrateToken;
      try {
        const options = await getAvailableLeaguesForExclusion({ force });
        if (token !== excludedLeagueHydrateToken) return;
        excludedLeagueOptions = Array.isArray(options) ? options : [];
        excludedLeagueOptionsHydrated = true;
      } catch {
        if (token !== excludedLeagueHydrateToken) return;
        excludedLeagueOptions = getLeagueOptionsFromMetaCache();
        excludedLeagueOptionsHydrated = true;
      }
      renderExcludedLeagueOptions(currentSettings?.excludedLeagueIds ?? []);
      renderExcludedLeagueChips(currentSettings?.excludedLeagueIds ?? []);
    };

    const getNationLabel = (nationId) => {
      const id = normalizeNationId(nationId);
      if (!id) return null;
      const cached = nationMetaCache.get(String(id));
      const cachedName = sanitizeDisplayText(cached?.name);
      if (cachedName) return cachedName;
      const lookupName = sanitizeDisplayText(getNationName(id));
      if (lookupName) {
        upsertNationMeta(id, { name: lookupName });
        return lookupName;
      }
      return `Nation ${id}`;
    };

    const renderExcludedNationChips = (excludedNationIds = []) => {
      if (!excludedNationCountEl || !excludedNationSelectedEl) return;
      const normalized = normalizeNationIdList(excludedNationIds, []);
      const count = normalized.length;
      try {
        excludedNationCountEl.textContent = `${count} excluded`;
      } catch {}
      try {
        clearExcludedNationsBtn.disabled =
          excludedNationActionInFlight || count === 0;
      } catch {}

      try {
        while (excludedNationSelectedEl.firstChild) {
          excludedNationSelectedEl.removeChild(
            excludedNationSelectedEl.firstChild,
          );
        }
      } catch {
        try {
          excludedNationSelectedEl.innerHTML = "";
        } catch {}
      }

      if (!count) {
        const empty = document.createElement("div");
        empty.className = "ea-data-excluded-empty";
        empty.textContent = "No excluded nations.";
        excludedNationSelectedEl.append(empty);
        return;
      }

      for (const id of normalized) {
        const chip = document.createElement("div");
        chip.className = "ea-data-excluded-league-chip";

        const label = document.createElement("span");
        label.textContent = getNationLabel(id) ?? `Nation ${id}`;

        const removeBtn = document.createElement("button");
        removeBtn.type = "button";
        removeBtn.className = "ea-data-excluded-league-chip-remove";
        removeBtn.setAttribute("data-action", "remove-excluded-nation");
        removeBtn.setAttribute("data-id", String(id));
        removeBtn.textContent = "×";
        removeBtn.disabled = excludedNationActionInFlight;

        chip.append(label);
        chip.append(removeBtn);
        excludedNationSelectedEl.append(chip);
      }
    };

    const renderExcludedNationOptions = (excludedNationIds = []) => {
      if (!excludedNationListEl) return;
      const normalizedExcluded = normalizeNationIdList(excludedNationIds, []);
      const excludedSet = new Set(normalizedExcluded.map(String));
      const search = String(excludedNationSearchValue ?? "")
        .trim()
        .toLowerCase();
      const options = Array.isArray(excludedNationOptions)
        ? excludedNationOptions
        : [];
      const filtered = options.filter((entry) => {
        const idText = String(entry?.id ?? "").toLowerCase();
        const nameText = String(entry?.name ?? "").toLowerCase();
        if (!search) return true;
        return idText.includes(search) || nameText.includes(search);
      });

      try {
        while (excludedNationListEl.firstChild) {
          excludedNationListEl.removeChild(excludedNationListEl.firstChild);
        }
      } catch {
        try {
          excludedNationListEl.innerHTML = "";
        } catch {}
      }

      if (!filtered.length) {
        const empty = document.createElement("div");
        empty.className = "ea-data-excluded-empty";
        empty.textContent = excludedNationOptionsHydrated
          ? "No nations match the current search."
          : "Loading nations...";
        excludedNationListEl.append(empty);
        return;
      }

      for (const entry of filtered) {
        const nationId = normalizeNationId(entry?.id);
        if (!nationId) continue;
        const nationName =
          sanitizeDisplayText(entry?.name) ??
          getNationLabel(nationId) ??
          `Nation ${nationId}`;
        const selected = excludedSet.has(String(nationId));

        const row = document.createElement("div");
        row.className = "ea-data-excluded-leagues-option";
        row.setAttribute("data-id", String(nationId));
        row.setAttribute("data-selected", selected ? "true" : "false");

        const main = document.createElement("div");
        main.className = "ea-data-excluded-leagues-option-main";
        const nameEl = document.createElement("div");
        nameEl.className = "ea-data-excluded-leagues-option-name";
        nameEl.textContent = nationName;
        const idEl = document.createElement("div");
        idEl.className = "ea-data-excluded-leagues-option-id";
        idEl.textContent = `Nation ID ${nationId}`;
        main.append(nameEl);
        main.append(idEl);

        const check = document.createElement("div");
        check.className = "ea-data-excluded-leagues-option-check";
        check.textContent = selected ? "✓" : "";

        row.append(main);
        row.append(check);
        excludedNationListEl.append(row);
      }
    };

    const hydrateExcludedNationOptions = async ({ force = false } = {}) => {
      const token = ++excludedNationHydrateToken;
      try {
        const options = await getAvailableNationsForExclusion({ force });
        if (token !== excludedNationHydrateToken) return;
        excludedNationOptions = Array.isArray(options) ? options : [];
        excludedNationOptionsHydrated = true;
      } catch {
        if (token !== excludedNationHydrateToken) return;
        excludedNationOptions = getNationOptionsFromMetaCache();
        excludedNationOptionsHydrated = true;
      }
      renderExcludedNationOptions(currentSettings?.excludedNationIds ?? []);
      renderExcludedNationChips(currentSettings?.excludedNationIds ?? []);
    };

    let currentSettings = getDefaultSolverSettings();
    const sync = (settings, { source } = {}) => {
      const previous =
        currentSettings && typeof currentSettings === "object"
          ? currentSettings
          : getDefaultSolverSettings();
      const raw = settings && typeof settings === "object" ? settings : {};
      const rangeSource =
        raw?.ratingRange && typeof raw.ratingRange === "object"
          ? raw.ratingRange
          : raw;
      let ratingMin = clampInt(
        rangeSource.ratingMin ??
          rangeSource.min ??
          rangeSource.minRating ??
          rangeSource.min_rating,
        0,
        99,
      );
      let ratingMax = clampInt(
        rangeSource.ratingMax ??
          rangeSource.max ??
          rangeSource.maxRating ??
          rangeSource.max_rating,
        0,
        99,
      );
      if (ratingMin == null) {
        ratingMin =
          clampInt(
            previous?.ratingRange?.ratingMin ?? previous?.ratingMin,
            0,
            99,
          ) ?? 0;
      }
      if (ratingMax == null) {
        ratingMax =
          clampInt(
            previous?.ratingRange?.ratingMax ?? previous?.ratingMax,
            0,
            99,
          ) ?? 99;
      }
      if (ratingMin > ratingMax) {
        if (source === "min") ratingMin = ratingMax;
        else if (source === "max") ratingMax = ratingMin;
        else {
          const tmp = ratingMin;
          ratingMin = ratingMax;
          ratingMax = tmp;
        }
      }

      try {
        minRange.value = String(ratingMin);
        maxRange.value = String(ratingMax);
      } catch {}
      try {
        minInput.value = String(ratingMin);
        maxInput.value = String(ratingMax);
      } catch {}

      try {
        if (ratingMin === ratingMax) {
          if (source === "min") {
            minRange.style.zIndex = "6";
            maxRange.style.zIndex = "5";
          } else if (source === "max") {
            maxRange.style.zIndex = "6";
            minRange.style.zIndex = "5";
          }
        } else {
          minRange.style.zIndex = "";
          maxRange.style.zIndex = "";
        }
      } catch {}

      const minPct = (ratingMin / 99) * 100;
      const maxPct = (ratingMax / 99) * 100;
      try {
        rangeRoot?.style?.setProperty("--min-pct", `${minPct}%`);
        rangeRoot?.style?.setProperty("--max-pct", `${maxPct}%`);
      } catch {}

      const poolSettings = toggleBinder.setValues(raw, previous);
      const excludedPlayerIds = normalizePlayerIdList(
        raw?.excludedPlayerIds,
        previous?.excludedPlayerIds ??
          getSettingDefault(SETTINGS_PATHS.SOLVER_EXCLUDED_PLAYER_IDS),
      );
      const excludedSignature = excludedPlayerIds.join(",");
      const excludedLeagueIds = normalizeLeagueIdList(
        raw?.excludedLeagueIds,
        previous?.excludedLeagueIds ??
          getSettingDefault(SETTINGS_PATHS.SOLVER_EXCLUDED_LEAGUE_IDS),
      );
      const excludedLeagueSignature = excludedLeagueIds.join(",");
      const excludedNationIds = normalizeNationIdList(
        raw?.excludedNationIds ?? raw?.excludedNations,
        previous?.excludedNationIds ??
          getSettingDefault(SETTINGS_PATHS.SOLVER_EXCLUDED_NATION_IDS),
      );
      const excludedNationSignature = excludedNationIds.join(",");
      renderExcludedPlayersList(excludedPlayerIds);
      if (excludedSignature !== lastExcludedSignature) {
        lastExcludedSignature = excludedSignature;
        void hydrateExcludedNames(excludedPlayerIds);
      }
      renderExcludedLeagueChips(excludedLeagueIds);
      renderExcludedLeagueOptions(excludedLeagueIds);
      if (
        excludedLeagueSignature !== lastExcludedLeagueSignature ||
        !excludedLeagueOptionsHydrated
      ) {
        lastExcludedLeagueSignature = excludedLeagueSignature;
        void hydrateExcludedLeagueOptions();
      }
      renderExcludedNationChips(excludedNationIds);
      renderExcludedNationOptions(excludedNationIds);
      if (
        excludedNationSignature !== lastExcludedNationSignature ||
        !excludedNationOptionsHydrated
      ) {
        lastExcludedNationSignature = excludedNationSignature;
        void hydrateExcludedNationOptions();
      }

      currentSettings = {
        ratingRange: { ratingMin, ratingMax },
        ...poolSettings,
        excludedPlayerIds,
        excludedLeagueIds,
        excludedNationIds,
      };
    };

    on(minRange, "input", () =>
      sync(
        { ratingMin: minRange.value, ratingMax: maxRange.value },
        {
          source: "min",
        },
      ),
    );
    on(maxRange, "input", () =>
      sync(
        { ratingMin: minRange.value, ratingMax: maxRange.value },
        {
          source: "max",
        },
      ),
    );
    on(minInput, "input", () =>
      sync(
        { ratingMin: minInput.value, ratingMax: maxInput.value },
        {
          source: "min",
        },
      ),
    );
    on(maxInput, "input", () =>
      sync(
        { ratingMin: minInput.value, ratingMax: maxInput.value },
        {
          source: "max",
        },
      ),
    );
    setCollapsibleExpanded(
      toggleExcludedLeaguesBtn,
      excludedLeaguesPanel,
      false,
    );
    setCollapsibleExpanded(
      toggleExcludedNationsBtn,
      excludedNationsPanel,
      false,
    );
    on(toggleExcludedLeaguesBtn, "click", (event) => {
      try {
        event?.stopPropagation?.();
      } catch {}
      toggleCollapsible(toggleExcludedLeaguesBtn, excludedLeaguesPanel);
    });
    on(toggleExcludedNationsBtn, "click", (event) => {
      try {
        event?.stopPropagation?.();
      } catch {}
      toggleCollapsible(toggleExcludedNationsBtn, excludedNationsPanel);
    });
    on(saveBtn, "click", async (event) => {
      try {
        event?.stopPropagation?.();
      } catch {}
      try {
        const next = {
          ratingRange: normalizeRatingRange(currentSettings?.ratingRange),
          ...toggleBinder.getValues(currentSettings),
          excludedPlayerIds: normalizePlayerIdList(
            currentSettings?.excludedPlayerIds,
            getSettingDefault(SETTINGS_PATHS.SOLVER_EXCLUDED_PLAYER_IDS),
          ),
          excludedLeagueIds: normalizeLeagueIdList(
            currentSettings?.excludedLeagueIds,
            getSettingDefault(SETTINGS_PATHS.SOLVER_EXCLUDED_LEAGUE_IDS),
          ),
          excludedNationIds: normalizeNationIdList(
            currentSettings?.excludedNationIds,
            getSettingDefault(SETTINGS_PATHS.SOLVER_EXCLUDED_NATION_IDS),
          ),
        };
        await setGlobalSolverSettings(next);
        currentSettings = next;
        await refreshAllGlobalSettingsSections();
        showToast({
          type: "success",
          title: "Global Settings Saved",
          message: "",
          timeoutMs: 2600,
        });
      } catch (error) {
        log("debug", "[EA Data] Global settings save failed", error);
        showToast({
          type: "error",
          title: "Settings Error",
          message: "Failed to save global settings.",
          timeoutMs: 6000,
        });
      }
    });
    on(resetBtn, "click", async (event) => {
      try {
        event?.stopPropagation?.();
      } catch {}
      try {
        await resetGlobalSolverSettings();
        const defaults = getDefaultSolverSettings();
        sync(defaults, { source: "reset" });
        await refreshAllGlobalSettingsSections();
        showToast({
          type: "info",
          title: "Global Settings Reset",
          message: "",
          timeoutMs: 2600,
        });
      } catch (error) {
        log("debug", "[EA Data] Global settings reset failed", error);
        showToast({
          type: "error",
          title: "Settings Error",
          message: "Failed to reset global settings.",
          timeoutMs: 6000,
        });
      }
    });
    on(clearExcludedBtn, "click", async (event) => {
      try {
        event?.stopPropagation?.();
      } catch {}
      if (exclusionActionInFlight) return;
      exclusionActionInFlight = true;
      renderExcludedPlayersList(currentSettings?.excludedPlayerIds ?? []);
      try {
        const excludedPlayerIds = await clearGlobalExcludedPlayerIds();
        currentSettings = {
          ...currentSettings,
          excludedPlayerIds,
        };
        renderExcludedPlayersList(excludedPlayerIds);
        await refreshAllGlobalSettingsSections();
        showToast({
          type: "success",
          title: "Excluded Players Cleared",
          message: "",
          timeoutMs: 2600,
        });
      } catch (error) {
        log("debug", "[EA Data] Clear excluded players failed", error);
        showToast({
          type: "error",
          title: "Settings Error",
          message: "Failed to clear excluded players.",
          timeoutMs: 6000,
        });
      } finally {
        exclusionActionInFlight = false;
        renderExcludedPlayersList(currentSettings?.excludedPlayerIds ?? []);
      }
    });
    on(excludedListEl, "click", async (event) => {
      const target = event?.target ?? null;
      const removeBtn =
        target?.closest?.('button[data-action="remove-excluded"]') ?? null;
      if (!removeBtn || exclusionActionInFlight) return;
      const id = normalizePlayerId(removeBtn.getAttribute("data-id"));
      if (!id) return;
      exclusionActionInFlight = true;
      renderExcludedPlayersList(currentSettings?.excludedPlayerIds ?? []);
      try {
        const nextIds = normalizePlayerIdList(
          (currentSettings?.excludedPlayerIds ?? []).filter(
            (entry) => String(entry) !== String(id),
          ),
          [],
        );
        const excludedPlayerIds = await setGlobalExcludedPlayerIds(nextIds);
        currentSettings = {
          ...currentSettings,
          excludedPlayerIds,
        };
        renderExcludedPlayersList(excludedPlayerIds);
        await refreshAllGlobalSettingsSections();
      } catch (error) {
        log("debug", "[EA Data] Remove excluded player failed", error);
        showToast({
          type: "error",
          title: "Settings Error",
          message: "Failed to update excluded players.",
          timeoutMs: 6000,
        });
      } finally {
        exclusionActionInFlight = false;
        renderExcludedPlayersList(currentSettings?.excludedPlayerIds ?? []);
      }
    });
    on(excludedLeagueSearchInput, "input", () => {
      excludedLeagueSearchValue = String(
        excludedLeagueSearchInput?.value ?? "",
      );
      renderExcludedLeagueOptions(currentSettings?.excludedLeagueIds ?? []);
    });
    on(clearExcludedLeaguesBtn, "click", async (event) => {
      try {
        event?.stopPropagation?.();
      } catch {}
      if (excludedLeagueActionInFlight) return;
      excludedLeagueActionInFlight = true;
      renderExcludedLeagueChips(currentSettings?.excludedLeagueIds ?? []);
      renderExcludedLeagueOptions(currentSettings?.excludedLeagueIds ?? []);
      try {
        const excludedLeagueIds = await clearGlobalExcludedLeagueIds();
        currentSettings = {
          ...currentSettings,
          excludedLeagueIds,
        };
        renderExcludedLeagueChips(excludedLeagueIds);
        renderExcludedLeagueOptions(excludedLeagueIds);
        await refreshAllGlobalSettingsSections();
        showToast({
          type: "success",
          title: "Excluded Leagues Cleared",
          message: "",
          timeoutMs: 2600,
        });
      } catch (error) {
        log("debug", "[EA Data] Clear excluded leagues failed", error);
        showToast({
          type: "error",
          title: "Settings Error",
          message: "Failed to clear excluded leagues.",
          timeoutMs: 6000,
        });
      } finally {
        excludedLeagueActionInFlight = false;
        renderExcludedLeagueChips(currentSettings?.excludedLeagueIds ?? []);
        renderExcludedLeagueOptions(currentSettings?.excludedLeagueIds ?? []);
      }
    });
    on(excludedLeagueSelectedEl, "click", async (event) => {
      const target = event?.target ?? null;
      const removeBtn =
        target?.closest?.('button[data-action="remove-excluded-league"]') ??
        null;
      if (!removeBtn || excludedLeagueActionInFlight) return;
      const leagueId = normalizeLeagueId(removeBtn.getAttribute("data-id"));
      if (!leagueId) return;
      excludedLeagueActionInFlight = true;
      renderExcludedLeagueChips(currentSettings?.excludedLeagueIds ?? []);
      try {
        const nextIds = normalizeLeagueIdList(
          (currentSettings?.excludedLeagueIds ?? []).filter(
            (entry) => String(entry) !== String(leagueId),
          ),
          [],
        );
        const excludedLeagueIds = await setGlobalExcludedLeagueIds(nextIds);
        currentSettings = {
          ...currentSettings,
          excludedLeagueIds,
        };
        renderExcludedLeagueChips(excludedLeagueIds);
        renderExcludedLeagueOptions(excludedLeagueIds);
        await refreshAllGlobalSettingsSections();
      } catch (error) {
        log("debug", "[EA Data] Remove excluded league failed", error);
        showToast({
          type: "error",
          title: "Settings Error",
          message: "Failed to update excluded leagues.",
          timeoutMs: 6000,
        });
      } finally {
        excludedLeagueActionInFlight = false;
        renderExcludedLeagueChips(currentSettings?.excludedLeagueIds ?? []);
        renderExcludedLeagueOptions(currentSettings?.excludedLeagueIds ?? []);
      }
    });
    on(excludedLeagueListEl, "click", async (event) => {
      const target = event?.target ?? null;
      const row =
        target?.closest?.(".ea-data-excluded-leagues-option[data-id]") ?? null;
      if (!row || excludedLeagueActionInFlight) return;
      const leagueId = normalizeLeagueId(row.getAttribute("data-id"));
      if (!leagueId) return;

      const excludedSet = new Set(
        normalizeLeagueIdList(currentSettings?.excludedLeagueIds ?? [], []),
      );
      const currentlyExcluded = excludedSet.has(String(leagueId));
      if (currentlyExcluded) excludedSet.delete(String(leagueId));
      else excludedSet.add(String(leagueId));

      excludedLeagueActionInFlight = true;
      renderExcludedLeagueOptions(currentSettings?.excludedLeagueIds ?? []);
      try {
        const excludedLeagueIds = await setGlobalExcludedLeagueIds(
          Array.from(excludedSet),
        );
        currentSettings = {
          ...currentSettings,
          excludedLeagueIds,
        };
        renderExcludedLeagueChips(excludedLeagueIds);
        renderExcludedLeagueOptions(excludedLeagueIds);
        await refreshAllGlobalSettingsSections();
      } catch (error) {
        log("debug", "[EA Data] Toggle excluded league failed", error);
        showToast({
          type: "error",
          title: "Settings Error",
          message: "Failed to update excluded leagues.",
          timeoutMs: 6000,
        });
      } finally {
        excludedLeagueActionInFlight = false;
        renderExcludedLeagueChips(currentSettings?.excludedLeagueIds ?? []);
        renderExcludedLeagueOptions(currentSettings?.excludedLeagueIds ?? []);
      }
    });
    on(excludedNationSearchInput, "input", () => {
      excludedNationSearchValue = String(
        excludedNationSearchInput?.value ?? "",
      );
      renderExcludedNationOptions(currentSettings?.excludedNationIds ?? []);
    });
    on(clearExcludedNationsBtn, "click", async (event) => {
      try {
        event?.stopPropagation?.();
      } catch {}
      if (excludedNationActionInFlight) return;
      excludedNationActionInFlight = true;
      renderExcludedNationChips(currentSettings?.excludedNationIds ?? []);
      renderExcludedNationOptions(currentSettings?.excludedNationIds ?? []);
      try {
        const excludedNationIds = await clearGlobalExcludedNationIds();
        currentSettings = {
          ...currentSettings,
          excludedNationIds,
        };
        renderExcludedNationChips(excludedNationIds);
        renderExcludedNationOptions(excludedNationIds);
        await refreshAllGlobalSettingsSections();
        showToast({
          type: "success",
          title: "Excluded Nations Cleared",
          message: "",
          timeoutMs: 2600,
        });
      } catch (error) {
        log("debug", "[EA Data] Clear excluded nations failed", error);
        showToast({
          type: "error",
          title: "Settings Error",
          message: "Failed to clear excluded nations.",
          timeoutMs: 6000,
        });
      } finally {
        excludedNationActionInFlight = false;
        renderExcludedNationChips(currentSettings?.excludedNationIds ?? []);
        renderExcludedNationOptions(currentSettings?.excludedNationIds ?? []);
      }
    });
    on(excludedNationSelectedEl, "click", async (event) => {
      const target = event?.target ?? null;
      const removeBtn =
        target?.closest?.('button[data-action="remove-excluded-nation"]') ??
        null;
      if (!removeBtn || excludedNationActionInFlight) return;
      const nationId = normalizeNationId(removeBtn.getAttribute("data-id"));
      if (!nationId) return;
      excludedNationActionInFlight = true;
      renderExcludedNationChips(currentSettings?.excludedNationIds ?? []);
      try {
        const nextIds = normalizeNationIdList(
          (currentSettings?.excludedNationIds ?? []).filter(
            (entry) => String(entry) !== String(nationId),
          ),
          [],
        );
        const excludedNationIds = await setGlobalExcludedNationIds(nextIds);
        currentSettings = {
          ...currentSettings,
          excludedNationIds,
        };
        renderExcludedNationChips(excludedNationIds);
        renderExcludedNationOptions(excludedNationIds);
        await refreshAllGlobalSettingsSections();
      } catch (error) {
        log("debug", "[EA Data] Remove excluded nation failed", error);
        showToast({
          type: "error",
          title: "Settings Error",
          message: "Failed to update excluded nations.",
          timeoutMs: 6000,
        });
      } finally {
        excludedNationActionInFlight = false;
        renderExcludedNationChips(currentSettings?.excludedNationIds ?? []);
        renderExcludedNationOptions(currentSettings?.excludedNationIds ?? []);
      }
    });
    on(excludedNationListEl, "click", async (event) => {
      const target = event?.target ?? null;
      const row =
        target?.closest?.(".ea-data-excluded-leagues-option[data-id]") ?? null;
      if (!row || excludedNationActionInFlight) return;
      const nationId = normalizeNationId(row.getAttribute("data-id"));
      if (!nationId) return;

      const excludedSet = new Set(
        normalizeNationIdList(currentSettings?.excludedNationIds ?? [], []),
      );
      const currentlyExcluded = excludedSet.has(String(nationId));
      if (currentlyExcluded) excludedSet.delete(String(nationId));
      else excludedSet.add(String(nationId));

      excludedNationActionInFlight = true;
      renderExcludedNationOptions(currentSettings?.excludedNationIds ?? []);
      try {
        const excludedNationIds = await setGlobalExcludedNationIds(
          Array.from(excludedSet),
        );
        currentSettings = {
          ...currentSettings,
          excludedNationIds,
        };
        renderExcludedNationChips(excludedNationIds);
        renderExcludedNationOptions(excludedNationIds);
        await refreshAllGlobalSettingsSections();
      } catch (error) {
        log("debug", "[EA Data] Toggle excluded nation failed", error);
        showToast({
          type: "error",
          title: "Settings Error",
          message: "Failed to update excluded nations.",
          timeoutMs: 6000,
        });
      } finally {
        excludedNationActionInFlight = false;
        renderExcludedNationChips(currentSettings?.excludedNationIds ?? []);
        renderExcludedNationOptions(currentSettings?.excludedNationIds ?? []);
      }
    });

    try {
      view.__eaDataGlobalSettingsSection = section;
      view.__eaDataGlobalSettingsState = {
        section,
        listeners,
        sync,
      };
      globalSettingsStateRegistry.add(view.__eaDataGlobalSettingsState);
    } catch {}

    sync(getDefaultSolverSettings(), {
      source: "init",
    });
    void refreshGlobalSettingsSection(view);
    return section;
  };

  // Multi-solve overlay (repeatable SBC)
  let multiSolveOverlayState = null;
  let multiSolveOverlayKeyHandlerBound = false;
  // Set-solve overlay (group SBC set)
  let setSolveOverlayState = {
    selectedChallengeIds: null,
    availableChallenges: [],
    requestedSetCyclesInput: 1,
    requirementsByChallengeId: new Map(),
    requirementsLoadToken: 0,
    requirementsInFlight: new Set(),
    rightPanelInitialized: false,
    rightPanelLastSetId: null,
    failureByChallengeId: new Map(),
    latestFailureContext: null,
    generationStopReason: null,
  };
  let setSolveOverlayKeyHandlerBound = false;

  const closeMultiSolveOverlay = () => {
    const overlay = document.getElementById("ea-data-multisolve-overlay");
    if (!overlay) return;
    overlay.setAttribute("aria-hidden", "true");
    try {
      overlay.style.pointerEvents = "none";
    } catch {}
  };

  const closeSetSolveOverlay = () => {
    const overlay = document.getElementById("ea-data-setsolve-overlay");
    if (!overlay) return;
    overlay.setAttribute("aria-hidden", "true");
    try {
      overlay.style.pointerEvents = "none";
    } catch {}
    try {
      overlay.style.display = "none";
    } catch {}
  };

  const isRepeatableChallenge = (challenge) => {
    if (!challenge) return false;
    if (typeof challenge?.isRepeatable === "function") {
      try {
        return Boolean(challenge.isRepeatable());
      } catch {}
    }
    if (typeof challenge?.hasUnlimitedRepetitions === "function") {
      try {
        return Boolean(challenge.hasUnlimitedRepetitions());
      } catch {}
    }
    return Boolean(challenge?.repeatable);
  };

  const getSbcSetById = (setId) => {
    if (setId == null) return null;
    try {
      const repo = services?.SBC?.repository ?? null;
      if (repo && typeof repo.getSetById === "function") {
        const setEntity = repo.getSetById(setId);
        if (setEntity) return setEntity;
      }
    } catch {}
    // Fallback: EA's web app commonly stores sets under `repository.sets._collection`.
    try {
      const repo = services?.SBC?.repository ?? null;
      const col = repo?.sets?._collection ?? null;
      if (!col) return null;
      if (typeof col.get === "function") {
        return col.get(setId) ?? col.get(String(setId)) ?? null;
      }
      return col[setId] ?? col[String(setId)] ?? null;
    } catch {}
    return null;
  };

  const ensureSbcSetById = async (setId) => {
    if (setId == null) return null;
    const existing = getSbcSetById(setId);
    if (existing) return existing;
    if (!services?.SBC?.requestSets) return null;
    try {
      const res = await sbcApiCall(
        "requestSets",
        () => observableToPromise(services.SBC.requestSets()),
        { minGapMs: SBC_AUTOMATION_MIN_GAP_MS, maxAttempts: 2 },
      );
      const sets = res?.data?.sets ?? res?.sets ?? null;
      if (Array.isArray(sets)) {
        const numericId = readNumeric(setId) ?? setId;
        const direct = sets.find((s) => s?.id === setId || s?.id === numericId);
        if (direct) return direct;
      }
    } catch {}
    return getSbcSetById(setId);
  };

  // EA already fetches SBC set data in memory; use it to determine repeatability.
  // Preferred source (per EA's internal model): services.SBC.repository.sets._collection[setId]
  const getSbcSetMetaById = (setId) => {
    if (setId == null) return null;
    try {
      const repo = services?.SBC?.repository ?? null;
      const col = repo?.sets?._collection ?? null;
      if (!col) return null;
      if (typeof col.get === "function") {
        return col.get(setId) ?? col.get(String(setId)) ?? null;
      }
      return col[setId] ?? col[String(setId)] ?? null;
    } catch {}
    return null;
  };

  const getSbcSetRepeatabilityInfo = (
    setId,
    { unlimitedDefault = 50, clampMax = 50 } = {},
  ) => {
    const meta = getSbcSetMetaById(setId) ?? getSbcSetById(setId) ?? null;
    const base = {
      mode: null,
      repeats: null,
      timesCompleted: null,
      remaining: null,
      challengesCount: null,
      recommended: null,
      max: clampMax,
    };
    if (!meta) return base;

    const modeRaw = meta?.repeatabilityMode ?? null;
    const mode = modeRaw == null ? null : String(modeRaw).toUpperCase();
    const challengesCount = readNumeric(meta?.challengesCount);

    if (mode === "UNLIMITED") {
      const rec = clampInt(unlimitedDefault, 1, clampMax) ?? clampMax;
      return {
        ...base,
        mode: "UNLIMITED",
        challengesCount,
        recommended: rec,
        max: clampMax,
      };
    }

    const repeats = readNumeric(meta?.repeats);
    const timesCompleted = readNumeric(meta?.timesCompleted) ?? 0;
    const remaining =
      repeats == null
        ? null
        : Math.max(0, Math.floor(repeats - timesCompleted));
    const capped = remaining == null ? null : Math.min(clampMax, remaining);
    const max = capped == null ? clampMax : Math.max(1, capped);
    const recommended = capped == null ? null : Math.max(1, capped);

    return {
      ...base,
      mode: mode ?? "FINITE",
      repeats,
      timesCompleted,
      remaining,
      challengesCount,
      recommended,
      max,
    };
  };

  const isGroupSbcChallenge = (challenge) => {
    if (!challenge?.setId) return false;
    try {
      const info = getSbcSetRepeatabilityInfo(challenge.setId, {
        unlimitedDefault: 50,
        clampMax: 50,
      });
      const count = readNumeric(info?.challengesCount);
      return count != null && count > 1;
    } catch {}
    return false;
  };

  const isGroupSbcSet = (setLike) => {
    const setId =
      typeof setLike === "object" && setLike
        ? (setLike.id ?? null)
        : (setLike ?? null);
    if (setId == null) return false;
    const directCount =
      typeof setLike === "object" && setLike
        ? readNumeric(setLike?.challengesCount)
        : null;
    if (directCount != null) return directCount > 1;
    try {
      const info = getSbcSetRepeatabilityInfo(setId, {
        unlimitedDefault: 50,
        clampMax: 50,
      });
      const count = readNumeric(info?.challengesCount);
      return count != null && count > 1;
    } catch {}
    return false;
  };

  const isDomElementVisible = (el) => {
    if (!el) return false;
    try {
      if (
        el.closest(
          "#ea-data-multisolve-overlay, #ea-data-setsolve-overlay, #ea-data-settings-overlay, #ea-data-toast-host",
        )
      ) {
        return false;
      }
    } catch {}
    try {
      const style = window.getComputedStyle(el);
      if (!style) return false;
      if (style.display === "none") return false;
      if (style.visibility === "hidden") return false;
      if (style.opacity === "0") return false;
    } catch {}
    try {
      const rect = el.getBoundingClientRect?.();
      if (!rect) return false;
      if (rect.width < 2 || rect.height < 2) return false;
      if (rect.bottom < 0 || rect.right < 0) return false;
      if (rect.top > window.innerHeight || rect.left > window.innerWidth)
        return false;
    } catch {}
    return true;
  };

  const safeClick = (el) => {
    if (!el || typeof el.click !== "function") return false;
    try {
      el.dispatchEvent(
        new MouseEvent("mousedown", {
          bubbles: true,
          cancelable: true,
          view: window,
        }),
      );
      el.dispatchEvent(
        new MouseEvent("mouseup", {
          bubbles: true,
          cancelable: true,
          view: window,
        }),
      );
      el.click();
      return true;
    } catch {
      try {
        el.click();
        return true;
      } catch {}
    }
    return false;
  };

  const waitForChallengeToClose = async (
    expectedChallengeId,
    { timeoutMs = 6000 } = {},
  ) => {
    const expected = expectedChallengeId ?? null;
    if (expected == null) return true;
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const curId = currentChallenge?.id ?? null;
      if (!curId || curId !== expected) return true;
      await delayMs(100);
    }
    return false;
  };

  const tryExitSbcChallengeView = async (expectedChallengeId) => {
    const expected = expectedChallengeId ?? null;
    if (expected == null) return false;

    // DOM-driven: click a likely "Back" control in the UI.
    try {
      const selectors = [
        'button[aria-label*="back" i]',
        'button[title*="back" i]',
        'a[aria-label*="back" i]',
        'a[title*="back" i]',
        ".ut-navigation-bar-view .ut-navigation-button-control",
        "button.ut-navigation-button-control",
        ".ut-navigation-button-control",
      ];
      const seen = new Set();
      const candidates = [];
      for (const sel of selectors) {
        const nodes = Array.from(document.querySelectorAll(sel) ?? []);
        for (const node of nodes) {
          if (!node) continue;
          if (seen.has(node)) continue;
          seen.add(node);
          if (!isDomElementVisible(node)) continue;
          candidates.push(node);
        }
      }

      const score = (el) => {
        let s = 0;
        const label = String(el.getAttribute?.("aria-label") ?? "");
        const title = String(el.getAttribute?.("title") ?? "");
        const text = String(el.textContent ?? "").trim();
        const cls = String(el.className ?? "");
        const all = `${label} ${title} ${text} ${cls}`.toLowerCase();
        if (label.toLowerCase().includes("back")) s += 120;
        if (title.toLowerCase().includes("back")) s += 90;
        if (
          text.toLowerCase() === "back" ||
          text.toLowerCase().includes("back")
        )
          s += 60;
        if (all.includes("back")) s += 30;
        if (cls.toLowerCase().includes("back")) s += 40;
        try {
          if (el.closest(".ut-navigation-bar-view")) s += 25;
          if (el.closest("section.ut-navigation-container-view")) s += 10;
        } catch {}
        try {
          const rect = el.getBoundingClientRect?.();
          if (rect) {
            if (rect.top < 130) s += 10;
            if (rect.left < 220) s += 10;
          }
        } catch {}
        return s;
      };

      candidates.sort((a, b) => score(b) - score(a));

      for (const el of candidates) {
        // Avoid clicking arbitrary buttons unless they look "back-like".
        if (score(el) < 55) continue;
        if (!safeClick(el)) continue;
        if (await waitForChallengeToClose(expected, { timeoutMs: 3000 }))
          return true;
      }
    } catch {}

    return false;
  };

  const waitForSetViewToClose = async (
    expectedSetId,
    { timeoutMs = 6000 } = {},
  ) => {
    const expected = expectedSetId == null ? null : String(expectedSetId);
    if (expected == null) return true;
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const curSetId = currentSbcSet?.id ?? null;
      if (!curSetId || String(curSetId) !== expected) return true;
      await delayMs(100);
    }
    return false;
  };

  const tryExitSbcSetView = async (expectedSetId) => {
    const expected = expectedSetId ?? null;
    if (expected == null) return false;

    try {
      const selectors = [
        'button[aria-label*="back" i]',
        'button[title*="back" i]',
        'a[aria-label*="back" i]',
        'a[title*="back" i]',
        ".ut-navigation-bar-view .ut-navigation-button-control",
        "button.ut-navigation-button-control",
        ".ut-navigation-button-control",
      ];
      const seen = new Set();
      const candidates = [];
      for (const sel of selectors) {
        const nodes = Array.from(document.querySelectorAll(sel) ?? []);
        for (const node of nodes) {
          if (!node || seen.has(node)) continue;
          seen.add(node);
          if (!isDomElementVisible(node)) continue;
          candidates.push(node);
        }
      }

      const score = (el) => {
        let s = 0;
        const label = String(el.getAttribute?.("aria-label") ?? "");
        const title = String(el.getAttribute?.("title") ?? "");
        const text = String(el.textContent ?? "").trim();
        const cls = String(el.className ?? "");
        const all = `${label} ${title} ${text} ${cls}`.toLowerCase();
        if (label.toLowerCase().includes("back")) s += 120;
        if (title.toLowerCase().includes("back")) s += 90;
        if (
          text.toLowerCase() === "back" ||
          text.toLowerCase().includes("back")
        )
          s += 60;
        if (all.includes("back")) s += 30;
        if (cls.toLowerCase().includes("back")) s += 40;
        try {
          if (el.closest(".ut-navigation-bar-view")) s += 25;
          if (el.closest("section.ut-navigation-container-view")) s += 10;
        } catch {}
        return s;
      };

      candidates.sort((a, b) => score(b) - score(a));
      for (const el of candidates) {
        if (score(el) < 55) continue;
        if (!safeClick(el)) continue;
        if (await waitForSetViewToClose(expected, { timeoutMs: 3000 }))
          return true;
      }
    } catch {}

    return false;
  };

  const refreshSbcSetChallengesSnapshot = async (setId, setEntity) => {
    const normalizedSetId = readNumeric(setId) ?? null;
    let resolvedSet = setEntity ?? null;
    if (!resolvedSet && normalizedSetId != null) {
      resolvedSet = await ensureSbcSetById(normalizedSetId);
    }

    if (resolvedSet && services?.SBC?.requestChallengesForSet) {
      try {
        await sbcApiCall(
          "requestChallengesForSet",
          () =>
            observableToPromise(
              services.SBC.requestChallengesForSet(resolvedSet),
            ),
          { minGapMs: SBC_AUTOMATION_MIN_GAP_MS, maxAttempts: 2 },
        );
      } catch {}
    }

    if (normalizedSetId != null) {
      const fromRepo = await ensureSbcSetById(normalizedSetId);
      if (fromRepo) resolvedSet = fromRepo;
    }

    const challenges = Array.isArray(resolvedSet?.getChallenges?.())
      ? resolvedSet.getChallenges()
      : [];
    const completedCount = challenges.filter(
      (challenge) =>
        challenge?.status === "COMPLETED" ||
        Boolean(challenge?.isCompleted?.()),
    ).length;
    const challengesTotal = challenges.length;
    const allCompleted =
      challengesTotal > 0 && completedCount >= challengesTotal;
    const setComplete = Boolean(resolvedSet?.isComplete?.()) || allCompleted;

    const repeatability = getSbcSetRepeatabilityInfo(normalizedSetId, {
      unlimitedDefault: 50,
      clampMax: 50,
    });
    const remaining = readNumeric(repeatability?.remaining);
    const finiteMode = String(repeatability?.mode ?? "FINITE") !== "UNLIMITED";
    const noRepeatsLeft =
      finiteMode && (remaining != null ? remaining <= 0 : setComplete);

    return {
      setId: normalizedSetId,
      setEntity: resolvedSet ?? null,
      challengesTotal,
      completedCount,
      allCompleted,
      setComplete,
      repeatability,
      noRepeatsLeft,
      shouldExitSetView: noRepeatsLeft,
    };
  };

  const refreshSbcSetChooserView = (setEntity) => {
    if (!setEntity) return;
    const view = currentSbcChallengesView ?? null;
    if (!view || typeof view?.setSBCSet !== "function") return;

    const expectedSetId = setEntity?.id ?? null;
    const args = Array.isArray(view?.__eaDataLastSetSBCSetArgs)
      ? view.__eaDataLastSetSBCSetArgs
      : [];

    const run = () => {
      try {
        view.setSBCSet(setEntity, ...args);
      } catch {}
    };

    try {
      requestAnimationFrame(run);
      setTimeout(() => {
        if (expectedSetId != null) {
          const currentSetId = currentSbcSet?.id ?? null;
          if (
            currentSetId != null &&
            Number(currentSetId) !== Number(expectedSetId)
          ) {
            return;
          }
        }
        run();
      }, 250);
    } catch {
      run();
    }
  };

  const detectAndConfirmRewardPopup = async ({
    maxAttempts = 2,
    intervalMs = 350,
  } = {}) => {
    const attempts = Math.max(1, readNumeric(maxAttempts) ?? 2);
    const waitMs = Math.max(120, readNumeric(intervalMs) ?? 350);
    const popupRootSelectors = [
      '[role="dialog"]',
      ".ui-dialog",
      ".view-popup-container",
      ".ut-content-dialog-view",
      ".ut-click-shield-container",
      ".ut-game-rewards-view",
      ".popup",
      ".dialog",
      ".modal",
    ];
    const actionSelectors = ["button", '[role="button"]', "a"];
    const directSelectors = [
      ".key-claim-btn",
      ".key-confirm-btn",
      ".key-continue-btn",
      ".ut-game-rewards-view .btn-standard.call-to-action",
      ".ut-game-rewards-view button.call-to-action",
      ".ut-game-rewards-view .button-container .btn-standard",
    ];
    const scoreText = (text) => {
      const value = String(text ?? "")
        .trim()
        .toLowerCase();
      if (!value) return 0;
      let s = 0;
      if (value.includes("claim")) s += 140;
      if (value.includes("collect")) s += 120;
      if (value.includes("redeem")) s += 120;
      if (value.includes("continue")) s += 95;
      if (value.includes("confirm")) s += 90;
      if (value === "ok" || value.includes(" ok")) s += 75;
      return s;
    };

    const gatherCandidates = () => {
      const candidates = [];
      const seen = new Set();
      const pushCandidate = (node, score = 0) => {
        if (!node || seen.has(node)) return;
        seen.add(node);
        if (!isDomElementVisible(node)) return;
        candidates.push({ node, score });
      };

      // FC Enhancer reference: reward claim is driven by UTGameRewardsView._actionBtn root.
      // Reuse captured action roots first for deterministic claim/confirm clicks.
      for (const node of Array.from(rewardActionButtonRoots)) {
        if (!node || !node.isConnected) {
          rewardActionButtonRoots.delete(node);
          continue;
        }
        pushCandidate(node, 240);
      }

      // Explicit CTA selectors (including FC Enhancer shortcut classes when present).
      for (const sel of directSelectors) {
        for (const node of Array.from(document.querySelectorAll(sel) ?? [])) {
          pushCandidate(node, 200);
        }
      }

      const roots = [];
      for (const sel of popupRootSelectors) {
        for (const node of Array.from(document.querySelectorAll(sel) ?? [])) {
          if (!node || seen.has(node)) continue;
          seen.add(node);
          if (!isDomElementVisible(node)) continue;
          roots.push(node);
        }
      }
      if (!roots.length) return candidates;

      for (const root of roots) {
        const nodes = Array.from(
          root.querySelectorAll(actionSelectors.join(",")) ?? [],
        );
        for (const node of nodes) {
          if (!node || seen.has(node) || !isDomElementVisible(node)) continue;
          seen.add(node);
          const text = String(node.textContent ?? "")
            .replace(/\s+/g, " ")
            .trim();
          const baseScore = scoreText(text);
          const cls = String(node.className ?? "").toLowerCase();
          const classScore =
            (cls.includes("key-claim") ? 140 : 0) +
            (cls.includes("key-confirm") ? 120 : 0) +
            (cls.includes("key-continue") ? 110 : 0) +
            (cls.includes("call-to-action") ? 80 : 0) +
            (cls.includes("btn-standard") ? 20 : 0);
          const score = baseScore + classScore;
          if (score <= 0) continue;
          candidates.push({ node, score });
        }
      }
      candidates.sort((a, b) => b.score - a.score);
      return candidates;
    };

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const candidates = gatherCandidates();
      const target = candidates[0]?.node ?? null;
      if (!target) {
        if (attempt < attempts - 1) await delayMs(waitMs);
        continue;
      }
      const clicked = safeClick(target);
      if (!clicked) {
        if (attempt < attempts - 1) await delayMs(waitMs);
        continue;
      }
      await delayMs(waitMs);

      // Some flows show a second confirm step; best-effort one extra click.
      const followUp = gatherCandidates()[0]?.node ?? null;
      if (followUp && followUp !== target) {
        safeClick(followUp);
      }
      return { handled: true };
    }

    return { handled: false, reason: "reward_popup_not_detected" };
  };

  const handleSetSolveCompletionState = async ({ setId, setEntity } = {}) => {
    let rewardHandled = false;
    try {
      const first = await detectAndConfirmRewardPopup({
        maxAttempts: 1,
        intervalMs: 320,
      });
      rewardHandled = Boolean(first?.handled);
    } catch {}

    await delayMs(220);
    const snapshot = await refreshSbcSetChallengesSnapshot(setId, setEntity);
    try {
      refreshSbcSetChooserView(snapshot?.setEntity ?? null);
    } catch {}

    if ((snapshot?.allCompleted || snapshot?.setComplete) && !rewardHandled) {
      try {
        const second = await detectAndConfirmRewardPopup({
          maxAttempts: 2,
          intervalMs: 360,
        });
        rewardHandled = Boolean(second?.handled);
      } catch {}
    }

    if ((snapshot?.allCompleted || snapshot?.setComplete) && !rewardHandled) {
      showToast({
        type: "info",
        title: "Reward Ready",
        message: "Claim the group reward if prompted.",
        timeoutMs: 6500,
      });
    }

    if (snapshot?.allCompleted || snapshot?.setComplete) {
      try {
        if (typeof repositories?.Item?.unassigned?.reset === "function") {
          repositories.Item.unassigned.reset();
        }
        if (typeof services?.Item?.requestUnassignedItems === "function") {
          await sbcApiCall(
            "requestUnassignedItems",
            () => observableToPromise(services.Item.requestUnassignedItems()),
            { minGapMs: 400, maxAttempts: 1 },
          );
        }
        if (typeof repositories?.Store?.setDirty === "function") {
          repositories.Store.setDirty("ALL");
        }
        if (typeof services?.Store?.getPacks === "function") {
          await sbcApiCall(
            "getPacks",
            () =>
              observableToPromise(services.Store.getPacks("ALL", true, true)),
            { minGapMs: 400, maxAttempts: 1 },
          );
        }
      } catch (err) {
        log("debug", "[EA Data] Set solver cache invalidation failed", err);
      }
    }

    return {
      ...snapshot,
      rewardHandled,
    };
  };

  const submitSbcChallenge = async (challenge) => {
    if (!challenge) throw new Error("Missing challenge");
    const setEntity = await ensureSbcSetById(challenge.setId);
    if (!setEntity) throw new Error("SBC set not found");
    if (!services?.SBC?.submitChallenge) {
      throw new Error("services.SBC.submitChallenge unavailable");
    }
    const chemistryEnabled = Boolean(services?.Chemistry?.isFeatureEnabled?.());
    return sbcApiCall(
      "submitChallenge",
      () =>
        observableToPromise(
          services.SBC.submitChallenge(
            challenge,
            setEntity,
            true,
            chemistryEnabled,
            true,
            true,
          ),
        ),
      { minGapMs: SBC_AUTOMATION_SUBMIT_MIN_GAP_MS, maxAttempts: 1 },
    );
  };

  const clearSbcSquad = async (challenge) => {
    if (!challenge) throw new Error("Missing challenge");
    try {
      const slots = squad?.getPlayers?.() ?? [];
      if (
        Array.isArray(slots) &&
        slots.length &&
        typeof squad?.setPlayers === "function"
      ) {
        const list = new Array(slots.length).fill(null);
        for (let index = 0; index < slots.length; index += 1) {
          const slot = squad?.getSlot?.(index) ?? slots[index];
          const item = resolveSlotItem(slot);
          const isBrick = resolveSlotBrick(slot);
          const isLocked = resolveSlotLocked(slot);
          if (isBrick || isLocked === true) {
            list[index] = item ?? null;
            continue;
          }
          if (resolveSlotValid(slot, item)) {
            hadAnyRemovablePlayers = true;
          }
        }
        // Clear editable slots without disturbing locked/brick slots.
        squad.setPlayers(list, true);
      } else {
        for (const slot of slots) {
          const item = resolveSlotItem(slot);
          const isBrick = resolveSlotBrick(slot);
          const isLocked = resolveSlotLocked(slot);
          if (isBrick || isLocked === true) continue;
          if (resolveSlotValid(slot, item)) {
            hadAnyRemovablePlayers = true;
            break;
          }
        }
        squad?.removeAllItems?.();
      }
    } catch {}

    // Avoid saving an already-empty squad: some SBCs can reject this with 403.
    if (!hadAnyRemovablePlayers) {
      return {
        success: true,
        status: null,
        error: null,
        data: null,
        skipped: true,
      };
    }

    return saveChallenge(challenge);
  };

  const ensureMultiSolveOverlay = () => {
    ensureSolveButtonStyles();
    const existing = document.getElementById("ea-data-multisolve-overlay");
    if (existing && multiSolveOverlayState) return existing;

    const overlay = existing || document.createElement("div");
    overlay.id = "ea-data-multisolve-overlay";
    overlay.setAttribute("aria-hidden", "true");
    overlay.innerHTML = `
      <div class="ea-data-multisolve-modal" role="dialog" aria-modal="true" aria-labelledby="ea-data-multisolve-title">
        <div class="ea-data-settings-header">
          <div class="ea-data-settings-title" id="ea-data-multisolve-title">Solve Multiple Times</div>
          <button type="button" class="ea-data-settings-close" aria-label="Close multi solve" data-action="close">×</button>
        </div>

        <div class="ea-data-settings-section-label">Preview squads before auto-submitting.</div>

        <div class="ea-data-settings-section-label" style="margin-top:12px">Player Rating Range</div>
        <div class="ea-data-range" id="ea-data-multisolve-rating-range">
          <div class="ea-data-range__track"></div>
          <input
            class="ea-data-range__input ea-data-range__input--min"
            id="ea-data-multisolve-rating-min"
            type="range"
            min="0"
            max="99"
            step="1"
            value="0"
          />
          <input
            class="ea-data-range__input ea-data-range__input--max"
            id="ea-data-multisolve-rating-max"
            type="range"
            min="0"
            max="99"
            step="1"
            value="99"
          />
        </div>

        <div class="ea-data-range__fields">
          <div class="ea-data-range__field">
            <div class="ea-data-range__label">Min</div>
            <input
              class="ea-data-range__number"
              id="ea-data-multisolve-rating-min-input"
              type="number"
              min="0"
              max="99"
              step="1"
              value="0"
              inputmode="numeric"
            />
          </div>
          <div class="ea-data-range__field">
            <div class="ea-data-range__label">Max</div>
            <input
              class="ea-data-range__number"
              id="ea-data-multisolve-rating-max-input"
              type="number"
              min="0"
              max="99"
              step="1"
              value="99"
              inputmode="numeric"
            />
          </div>
        </div>

        <div class="ea-data-settings-section-label" style="margin-top:12px">Player Pool Options</div>
        <div class="ea-data-toggle-list">
          ${renderSolverToggleFields({ scope: "multi", idPrefix: "ea-data-multisolve-setting-" })}
        </div>

        <div class="ea-data-multisolve-grid">
          <div class="ea-data-multisolve-field ea-data-multisolve-field--times">
            <div class="ea-data-range__label">Times</div>
            <div class="ea-data-times-stepper">
              <button type="button" class="ea-data-times-stepper__btn" data-step="down" data-target="ea-data-multisolve-times" aria-label="Decrease times">-</button>
              <input
                class="ea-data-range__number ea-data-times-stepper__input"
                id="ea-data-multisolve-times"
                type="number"
                min="1"
                max="50"
                step="1"
                value="3"
                inputmode="numeric"
              />
              <button type="button" class="ea-data-times-stepper__btn" data-step="up" data-target="ea-data-multisolve-times" aria-label="Increase times">+</button>
            </div>
          </div>
          <button type="button" class="ea-data-btn ea-data-btn--primary" data-action="generate">Fetch Solutions</button>
        </div>

        <div class="ea-data-multisolve-status" id="ea-data-multisolve-status" aria-live="polite"></div>

        <div class="ea-data-progress" id="ea-data-multisolve-progress-wrap" style="display:none" aria-hidden="true">
          <div class="ea-data-progress__bar" id="ea-data-multisolve-progress"></div>
        </div>

        <div class="ea-data-solutions-list" id="ea-data-multisolve-solutions">
          <div class="ea-data-solutions-empty">No solutions fetched yet.</div>
        </div>

        <div class="ea-data-multisolve-actions">
          <button type="button" class="ea-data-btn ea-data-btn--info" data-action="cancel">Cancel</button>
          <div class="ea-data-multisolve-actions-right">
            <button type="button" class="ea-data-btn ea-data-btn--danger" data-action="stop" style="display:none">Stop</button>
            <button type="button" class="ea-data-btn ea-data-btn--success" data-action="start" disabled>Start Submitting</button>
          </div>
        </div>
      </div>
    `;

    if (!existing) document.body.appendChild(overlay);

    const modal = overlay.querySelector(".ea-data-multisolve-modal");
    const closeBtn = overlay.querySelector('[data-action="close"]');
    const cancelBtn = overlay.querySelector('[data-action="cancel"]');
    const generateBtn = overlay.querySelector('[data-action="generate"]');
    const startBtn = overlay.querySelector('[data-action="start"]');
    const stopBtn = overlay.querySelector('[data-action="stop"]');
    const timesInput = overlay.querySelector("#ea-data-multisolve-times");
    const statusEl = overlay.querySelector("#ea-data-multisolve-status");
    const progressWrap = overlay.querySelector(
      "#ea-data-multisolve-progress-wrap",
    );
    const progressBar = overlay.querySelector("#ea-data-multisolve-progress");
    const listEl = overlay.querySelector("#ea-data-multisolve-solutions");

    const ratingRangeRoot = overlay.querySelector(
      "#ea-data-multisolve-rating-range",
    );
    const ratingMinRange = overlay.querySelector(
      "#ea-data-multisolve-rating-min",
    );
    const ratingMaxRange = overlay.querySelector(
      "#ea-data-multisolve-rating-max",
    );
    const ratingMinInput = overlay.querySelector(
      "#ea-data-multisolve-rating-min-input",
    );
    const ratingMaxInput = overlay.querySelector(
      "#ea-data-multisolve-rating-max-input",
    );
    const toggleBinder = createSolverToggleBinder({
      root: overlay,
      scope: "multi",
      idPrefix: "ea-data-multisolve-setting-",
    });

    const setStatus = (text) => {
      try {
        statusEl.textContent = text ? String(text) : "";
      } catch {}
    };

    const setProgress = (current, total) => {
      const cur = readNumeric(current);
      const tot = readNumeric(total);
      const ok = cur != null && tot != null && tot > 0;
      const pct = ok ? Math.max(0, Math.min(100, (cur / tot) * 100)) : 0;
      try {
        progressWrap.style.display = ok ? "" : "none";
        progressWrap.setAttribute("aria-hidden", ok ? "false" : "true");
        progressBar.style.width = `${pct}%`;
      } catch {}
    };

    let ratingRangeCurrent = { ratingMin: 0, ratingMax: 99 };
    const syncRatingRange = (range, { source } = {}) => {
      const raw = range && typeof range === "object" ? range : {};
      let ratingMin = clampInt(
        raw.ratingMin ?? raw.min ?? raw.minRating ?? raw.min_rating,
        0,
        99,
      );
      let ratingMax = clampInt(
        raw.ratingMax ?? raw.max ?? raw.maxRating ?? raw.max_rating,
        0,
        99,
      );
      if (ratingMin == null) ratingMin = 0;
      if (ratingMax == null) ratingMax = 99;

      if (ratingMin > ratingMax) {
        if (source === "min")
          ratingMin = ratingMax; // clamp min (don't move max)
        else if (source === "max")
          ratingMax = ratingMin; // clamp max (don't move min)
        else {
          const tmp = ratingMin;
          ratingMin = ratingMax;
          ratingMax = tmp;
        }
      }

      try {
        ratingMinRange.value = String(ratingMin);
        ratingMaxRange.value = String(ratingMax);
      } catch {}
      try {
        ratingMinInput.value = String(ratingMin);
        ratingMaxInput.value = String(ratingMax);
      } catch {}

      // When handles overlap (ex: min == max), bring the active handle above the other
      // so it remains draggable.
      try {
        if (ratingMin === ratingMax) {
          if (source === "min") {
            ratingMinRange.style.zIndex = "6";
            ratingMaxRange.style.zIndex = "5";
          } else if (source === "max") {
            ratingMaxRange.style.zIndex = "6";
            ratingMinRange.style.zIndex = "5";
          }
        } else {
          ratingMinRange.style.zIndex = "";
          ratingMaxRange.style.zIndex = "";
        }
      } catch {}

      const minPct = (ratingMin / 99) * 100;
      const maxPct = (ratingMax / 99) * 100;
      try {
        ratingRangeRoot?.style?.setProperty("--min-pct", `${minPct}%`);
        ratingRangeRoot?.style?.setProperty("--max-pct", `${maxPct}%`);
      } catch {}

      ratingRangeCurrent = { ratingMin, ratingMax };
      try {
        multiSolveOverlayState.ratingRange = ratingRangeCurrent;
      } catch {}
    };

    const syncPoolSettings = (settings = {}) => {
      const current =
        multiSolveOverlayState?.poolSettings &&
        typeof multiSolveOverlayState.poolSettings === "object"
          ? multiSolveOverlayState.poolSettings
          : getDefaultSolverPoolSettings();
      const poolSettings = toggleBinder.setValues(settings, current);
      try {
        multiSolveOverlayState.poolSettings = poolSettings;
      } catch {}
      return poolSettings;
    };

    const getPoolSettingsFromInputs = () => {
      const current =
        multiSolveOverlayState?.poolSettings &&
        typeof multiSolveOverlayState.poolSettings === "object"
          ? multiSolveOverlayState.poolSettings
          : getDefaultSolverPoolSettings();
      const poolSettings = toggleBinder.getValues(current);
      try {
        multiSolveOverlayState.poolSettings = poolSettings;
      } catch {}
      return poolSettings;
    };

    const clearNode = (node) => {
      if (!node) return;
      try {
        while (node.firstChild) node.removeChild(node.firstChild);
      } catch {
        try {
          node.innerHTML = "";
        } catch {}
      }
    };

    const refreshOpenChallengeUI = (challenge) => {
      if (!challenge) return;
      const expectedChallengeId = challenge?.id ?? null;
      const payload = { squad: challenge?.squad ?? null };
      try {
        challenge?.onDataChange?.notify?.(payload);
      } catch {}

      const isStillSameChallenge = () =>
        expectedChallengeId == null ||
        currentChallenge?.id === expectedChallengeId;

      const overviewView = currentSbcOverviewView ?? null;

      const tryRefreshOverview = () => {
        try {
          const squad = challenge?.squad ?? null;
          if (!overviewView || !squad) return;
          if (typeof overviewView?.setSquad !== "function") return;
          const args = overviewView?.__eaDataLastSetSquadArgs;
          overviewView.setSquad(squad, ...(Array.isArray(args) ? args : []));
        } catch {}
      };

      try {
        requestAnimationFrame(tryRefreshOverview);
      } catch {
        tryRefreshOverview();
      }

      try {
        setTimeout(() => {
          if (!isStillSameChallenge()) return;
          try {
            challenge?.onDataChange?.notify?.(payload);
          } catch {}
          tryRefreshOverview();
        }, 250);
      } catch {}
    };

    const renderSolutions = () => {
      const solutions = multiSolveOverlayState?.solutions ?? [];
      const maxIndex = Math.max(0, solutions.length - 1);
      const clampedIndex = clampInt(
        multiSolveOverlayState?.activeIndex ?? 0,
        0,
        maxIndex,
      );
      multiSolveOverlayState.activeIndex =
        clampedIndex == null ? 0 : clampedIndex;

      clearNode(listEl);

      if (!solutions.length) {
        const empty = document.createElement("div");
        empty.className = "ea-data-solutions-empty";
        empty.textContent = "No solutions fetched yet.";
        listEl.append(empty);
        return;
      }

      const active = multiSolveOverlayState.activeIndex ?? 0;
      const sol = solutions[active] ?? null;
      const stats = sol?.stats ?? {};
      const requiredPlayers =
        readNumeric(multiSolveOverlayState?.requiredPlayers) ??
        readNumeric(stats?.squadSize) ??
        11;

      const squadRating = stats?.squadRating ?? stats?.ratingTarget ?? "?";
      const chem = stats?.chemistry?.totalChem ?? null;
      const chemStr = chem == null ? "n/a" : String(chem);
      const specialCount = readNumeric(sol?.specialCount) ?? 0;
      const filledCount = Array.isArray(sol?.solutionIds)
        ? sol.solutionIds.length
        : 0;

      const header = document.createElement("div");
      header.className = "ea-data-preview-header";

      const headerLeft = document.createElement("div");
      headerLeft.className = "ea-data-preview-header-left";

      const title = document.createElement("div");
      title.className = "ea-data-solution-title";
      title.textContent = `Solution #${active + 1}`;
      headerLeft.append(title);

      const headerRight = document.createElement("div");
      headerRight.className = "ea-data-preview-header-right";

      const nav = document.createElement("div");
      nav.className = "ea-data-preview-nav";

      const isBusy = Boolean(multiSolveOverlayState?.running);

      const prevBtn = document.createElement("button");
      prevBtn.type = "button";
      prevBtn.className = "ea-data-preview-nav-btn";
      prevBtn.setAttribute("data-action", "prev");
      prevBtn.textContent = "Prev";
      prevBtn.disabled = isBusy || active <= 0;

      const page = document.createElement("div");
      page.className = "ea-data-preview-page";
      page.textContent = `${active + 1} / ${solutions.length}`;

      const nextBtn = document.createElement("button");
      nextBtn.type = "button";
      nextBtn.className = "ea-data-preview-nav-btn";
      nextBtn.setAttribute("data-action", "next");
      nextBtn.textContent = "Next";
      nextBtn.disabled = isBusy || active >= maxIndex;

      nav.append(prevBtn);
      nav.append(page);
      nav.append(nextBtn);

      const sortWrap = document.createElement("div");
      sortWrap.className = "ea-data-preview-sort";

      const sortLabel = document.createElement("div");
      sortLabel.className = "ea-data-preview-sort-label";
      sortLabel.textContent = "Sort";

      const sortSelect = document.createElement("select");
      sortSelect.className = "ea-data-preview-sort-select";
      sortSelect.setAttribute("data-action", "sort");
      sortSelect.disabled = isBusy;
      sortSelect.innerHTML = `
        <option value="rating_desc">Rating</option>
        <option value="slot">Slots</option>
      `;
      sortSelect.value = String(
        multiSolveOverlayState?.sortKey ?? "rating_desc",
      );

      sortWrap.append(sortLabel);
      sortWrap.append(sortSelect);

      headerRight.append(nav);
      headerRight.append(sortWrap);

      header.append(headerLeft);
      header.append(headerRight);

      const cardContainer = document.createElement("div");
      try {
        cardContainer.style.setProperty("margin-bottom", "16px", "important");
        cardContainer.style.backgroundColor = "rgba(0, 0, 0, 0.25)";
        cardContainer.style.border = "1px solid rgba(255, 255, 255, 0.05)";
        cardContainer.style.borderRadius = "8px";
        cardContainer.style.overflow = "hidden";
      } catch {}

      try {
        header.style.padding = "10px 12px";
        header.style.backgroundColor = "rgba(255, 255, 255, 0.05)";
      } catch {}
      cardContainer.append(header);

      const meta = document.createElement("div");
      meta.className = "ea-data-preview-meta";
      meta.textContent = `Rating ${squadRating} | Chem ${chemStr} | Special ${specialCount} | Players ${filledCount}/${requiredPlayers}`;
      try {
        meta.style.padding = "8px 12px";
        meta.style.backgroundColor = "rgba(255, 255, 255, 0.02)";
      } catch {}
      cardContainer.append(meta);

      const playersWrap = document.createElement("div");
      playersWrap.className = "ea-data-preview-players";

      const playerById = multiSolveOverlayState?.playerById ?? null;
      const slotIndexToPos =
        multiSolveOverlayState?.slotIndexToPositionName ?? null;
      const slotSolution = sol?.slotSolution ?? null;

      const slotIndices = Array.isArray(slotSolution?.fieldSlotIndices)
        ? slotSolution.fieldSlotIndices
        : null;
      const slotPlayerIds = Array.isArray(slotSolution?.fieldSlotToPlayerId)
        ? slotSolution.fieldSlotToPlayerId
        : null;
      const perChem = Array.isArray(slotSolution?.perPlayerChem)
        ? slotSolution.perPlayerChem
        : [];
      const onPos = Array.isArray(slotSolution?.onPosition)
        ? slotSolution.onPosition
        : [];

      const ids = Array.isArray(sol?.solutionIds) ? sol.solutionIds : [];
      const rowCount = Math.max(slotPlayerIds?.length ?? 0, ids.length);

      const rows = [];
      for (let i = 0; i < rowCount; i += 1) {
        const slotIndex = slotIndices?.[i] ?? null;
        const playerId = slotPlayerIds?.[i] ?? ids[i] ?? null;
        const player =
          playerById && playerId != null
            ? playerById.get(String(playerId))
            : null;

        const posName =
          slotIndex != null && slotIndexToPos
            ? (slotIndexToPos.get(Number(slotIndex)) ?? null)
            : null;
        const posLabel =
          posName ??
          player?.preferredPositionName ??
          (slotIndex != null ? `Slot ${slotIndex}` : "Slot");

        const ratingNum = readNumeric(player?.rating);
        const rating = ratingNum == null ? "?" : String(ratingNum);
        const nameRaw = player?.name ?? null;
        const name =
          nameRaw && String(nameRaw).trim()
            ? String(nameRaw).trim()
            : "Unknown";
        const rarity = player?.rarityName ?? "";
        const definitionId = player?.definitionId ?? null;
        const isSpecial = Boolean(player?.isSpecial);
        const chemVal = perChem?.[i];
        const onPosVal = onPos?.[i];

        rows.push({
          originalIndex: i,
          slotIndex,
          playerId,
          posLabel,
          rating,
          ratingNum: ratingNum == null ? -1 : ratingNum,
          name,
          rarity,
          definitionId,
          isSpecial,
          chemVal,
          onPosVal,
        });
      }

      const sortKey = String(multiSolveOverlayState?.sortKey ?? "rating_desc");
      if (sortKey === "rating_desc") {
        rows.sort((a, b) => {
          if (b.ratingNum !== a.ratingNum) return b.ratingNum - a.ratingNum;
          const ap = String(a.posLabel ?? "");
          const bp = String(b.posLabel ?? "");
          const cmp = ap.localeCompare(bp);
          if (cmp) return cmp;
          return a.originalIndex - b.originalIndex;
        });
      } else if (sortKey === "slot") {
        rows.sort((a, b) => a.originalIndex - b.originalIndex);
      }

      for (const data of rows) {
        const playerId = data.playerId ?? null;
        const rating = data.rating ?? "?";
        const name = data.name ?? "Unknown";
        const rarity = data.rarity ?? "";
        const definitionId = data.definitionId ?? null;
        const isSpecial = Boolean(data.isSpecial);
        const chemVal = data.chemVal;
        const onPosVal = data.onPosVal;
        const posLabel = data.posLabel ?? "Slot";

        const row = document.createElement("div");
        row.className = "ea-data-preview-row";
        if (rows.indexOf(data) % 2 === 1) {
          try {
            row.style.backgroundColor = "rgba(255, 255, 255, 0.02)";
          } catch {}
        }

        const posEl = document.createElement("div");
        posEl.className = "ea-data-preview-pos";
        posEl.textContent = String(posLabel);

        const main = document.createElement("div");
        main.className = "ea-data-preview-main";

        const left = document.createElement("div");
        left.className = "ea-data-preview-left";

        const ratingEl = document.createElement("div");
        ratingEl.className = "ea-data-preview-rating";
        ratingEl.textContent = String(rating);

        const nameEl = document.createElement("div");
        nameEl.className = "ea-data-preview-name";
        nameEl.textContent = String(name);

        const rarityEl = document.createElement("div");
        rarityEl.className = "ea-data-preview-rarity";
        rarityEl.textContent = rarity ? String(rarity) : "";

        left.append(ratingEl);
        left.append(nameEl);
        if (rarity) left.append(rarityEl);

        const right = document.createElement("div");
        right.className = "ea-data-preview-right";

        const idEl = document.createElement("div");
        idEl.className = "ea-data-preview-id";
        idEl.textContent =
          definitionId != null
            ? `def ${definitionId}`
            : playerId != null
              ? `id ${playerId}`
              : "";
        if (idEl.textContent) right.append(idEl);

        if (isSpecial) {
          const pill = document.createElement("span");
          pill.className = "ea-data-pill ea-data-pill--special";
          pill.textContent = "Special";
          right.append(pill);
        }

        if (onPosVal === false) {
          const pill = document.createElement("span");
          pill.className = "ea-data-pill ea-data-pill--warn";
          pill.textContent = "Off-pos";
          right.append(pill);
        } else if (chemVal != null) {
          const pill = document.createElement("span");
          pill.className = "ea-data-pill";
          pill.textContent = `Chem ${chemVal}`;
          right.append(pill);
        }

        main.append(left);
        main.append(right);

        row.append(posEl);
        row.append(main);
        playersWrap.append(row);
      }

      cardContainer.append(playersWrap);
      listEl.append(cardContainer);

      // Aggregate usage across all fetched solutions so the user can quickly spot
      // rating distribution / special consumption before submitting.
      try {
        const ratingCounts = new Map();
        let usedPlayers = 0;
        let usedSpecial = 0;
        for (const s of solutions) {
          const ids = Array.isArray(s?.solutionIds) ? s.solutionIds : [];
          for (const id of ids) {
            if (id == null) continue;
            usedPlayers += 1;
            const p = playerById ? playerById.get(String(id)) : null;
            const r = readNumeric(p?.rating);
            if (r != null) ratingCounts.set(r, (ratingCounts.get(r) || 0) + 1);
            if (p?.isSpecial) usedSpecial += 1;
          }
        }

        const summary = document.createElement("div");
        summary.className = "ea-data-used-summary";

        const top = document.createElement("div");
        top.className = "ea-data-used-summary-top";

        const titleEl = document.createElement("div");
        titleEl.className = "ea-data-used-summary-title";
        titleEl.textContent = "All Used Players";

        const topRight = document.createElement("div");
        topRight.className = "ea-data-preview-right";

        const solPill = document.createElement("span");
        solPill.className = "ea-data-pill";
        solPill.textContent = `Solutions ${solutions.length}`;
        topRight.append(solPill);

        const playersPill = document.createElement("span");
        playersPill.className = "ea-data-pill";
        playersPill.textContent = `Players ${usedPlayers}`;
        topRight.append(playersPill);

        const specialPill = document.createElement("span");
        specialPill.className = usedSpecial
          ? "ea-data-pill ea-data-pill--special"
          : "ea-data-pill";
        specialPill.textContent = `Special ${usedSpecial}`;
        topRight.append(specialPill);

        top.append(titleEl);
        top.append(topRight);
        summary.append(top);

        const pills = document.createElement("div");
        pills.className = "ea-data-used-summary-pills";

        const entries = Array.from(ratingCounts.entries()).sort(
          ([a], [b]) => b - a,
        );
        if (!entries.length) {
          const pill = document.createElement("span");
          pill.className = "ea-data-pill";
          pill.textContent = "Ratings n/a";
          pills.append(pill);
        } else {
          for (const [rating, count] of entries) {
            const pill = document.createElement("span");
            pill.className = "ea-data-pill ea-data-pill--rating";
            pill.textContent = `${rating}×${count}`;
            pills.append(pill);
          }
        }

        summary.append(pills);
        listEl.append(summary);
      } catch {}
    };

    listEl?.addEventListener("click", (event) => {
      if (multiSolveOverlayState?.running) return;
      const target = event?.target ?? null;
      const btn = target?.closest?.("button[data-action]") ?? null;
      if (!btn) return;
      const action = btn.getAttribute("data-action");
      const solutions = multiSolveOverlayState?.solutions ?? [];
      const maxIndex = Math.max(0, solutions.length - 1);
      const active =
        clampInt(multiSolveOverlayState?.activeIndex ?? 0, 0, maxIndex) ?? 0;
      if (action === "prev") {
        multiSolveOverlayState.activeIndex = Math.max(0, active - 1);
        renderSolutions();
      } else if (action === "next") {
        multiSolveOverlayState.activeIndex = Math.min(maxIndex, active + 1);
        renderSolutions();
      }
    });

    listEl?.addEventListener("change", (event) => {
      if (multiSolveOverlayState?.running) return;
      const target = event?.target ?? null;
      const select = target?.closest?.('select[data-action="sort"]') ?? null;
      if (!select) return;
      multiSolveOverlayState.sortKey = select.value ?? "rating_desc";
      renderSolutions();
    });

    const setRunning = (running, { mode } = {}) => {
      const isRunning = Boolean(running);
      multiSolveOverlayState.running = isRunning;
      if (!isRunning) multiSolveOverlayState.mode = "idle";
      else if (mode) multiSolveOverlayState.mode = String(mode);
      try {
        closeBtn.disabled = isRunning;
        cancelBtn.disabled = isRunning;
      } catch {}
      try {
        if (isRunning) {
          startBtn.disabled = true;
          generateBtn.disabled = true;
          timesInput.disabled = true;
          try {
            ratingRangeRoot?.classList?.add?.("ea-data-range--locked");
            ratingMinRange?.setAttribute?.("aria-disabled", "true");
            ratingMaxRange?.setAttribute?.("aria-disabled", "true");
            ratingMinRange?.setAttribute?.("tabindex", "-1");
            ratingMaxRange?.setAttribute?.("tabindex", "-1");
          } catch {}
          if (ratingMinInput) ratingMinInput.disabled = true;
          if (ratingMaxInput) ratingMaxInput.disabled = true;
          toggleBinder.setDisabled(true);
          try {
            for (const b of modal?.querySelectorAll?.(
              ".ea-data-times-stepper__btn",
            ) ?? []) {
              b.disabled = true;
            }
          } catch {}
          stopBtn.style.display = "";
          stopBtn.disabled = Boolean(multiSolveOverlayState.abortRequested);
          stopBtn.textContent = multiSolveOverlayState.abortRequested
            ? "Stopping..."
            : "Stop";

          const modeValue = String(multiSolveOverlayState.mode ?? "");
          if (modeValue === "generating")
            generateBtn.textContent = "Working...";
          else generateBtn.textContent = "Fetch Solutions";
          if (modeValue === "submitting")
            startBtn.textContent = "Submitting...";
          else startBtn.textContent = "Start Submitting";
        } else {
          generateBtn.disabled = false;
          timesInput.disabled = false;
          try {
            ratingRangeRoot?.classList?.remove?.("ea-data-range--locked");
            ratingMinRange?.removeAttribute?.("aria-disabled");
            ratingMaxRange?.removeAttribute?.("aria-disabled");
            ratingMinRange?.removeAttribute?.("tabindex");
            ratingMaxRange?.removeAttribute?.("tabindex");
          } catch {}
          if (ratingMinInput) ratingMinInput.disabled = false;
          if (ratingMaxInput) ratingMaxInput.disabled = false;
          toggleBinder.setDisabled(false);
          try {
            for (const b of modal?.querySelectorAll?.(
              ".ea-data-times-stepper__btn",
            ) ?? []) {
              b.disabled = false;
            }
          } catch {}
          stopBtn.style.display = "none";
          stopBtn.disabled = false;
          stopBtn.textContent = "Stop";
          startBtn.disabled = !(multiSolveOverlayState.solutions?.length > 0);
          generateBtn.textContent = "Fetch Solutions";
          startBtn.textContent = "Start Submitting";
        }
      } catch {}

      // Update pagination/sort controls disabled state.
      try {
        renderSolutions();
      } catch {}
    };

    const reset = () => {
      multiSolveOverlayState.solutions = [];
      multiSolveOverlayState.activeIndex = 0;
      multiSolveOverlayState.requiredPlayers = 11;
      multiSolveOverlayState.playerById = null;
      multiSolveOverlayState.slotIndexToPositionName = null;
      multiSolveOverlayState.abortRequested = false;
      setRunning(false);
      setStatus("");
      setProgress(null, null);
      renderSolutions();
    };

    const resetForChallenge = (challengeId) => {
      if (multiSolveOverlayState?.running) return;
      const key = challengeId == null ? null : String(challengeId);
      if (multiSolveOverlayState?.challengeId === key) return;
      reset();
      multiSolveOverlayState.challengeId = key;
      try {
        syncRatingRange({ ratingMin: 0, ratingMax: 99 }, { source: "init" });
        syncPoolSettings(getDefaultSolverSettings());
      } catch {}
      try {
        if (currentChallenge?.id === challengeId)
          syncTimesFromRepeatability(currentChallenge);
      } catch {}
    };

    const syncTimesFromRepeatability = (challenge) => {
      if (!timesInput || !challenge) return null;
      const info = getSbcSetRepeatabilityInfo(challenge?.setId ?? null, {
        unlimitedDefault: 50,
        clampMax: 50,
      });
      const max = clampInt(info?.max ?? 50, 1, 50) ?? 50;
      try {
        timesInput.setAttribute("max", String(max));
      } catch {}
      try {
        const rec = readNumeric(info?.recommended);
        if (rec != null)
          timesInput.value = String(clampInt(rec, 1, max) ?? max);
        else {
          const cur = readNumeric(timesInput.value);
          const clamped = clampInt(cur == null ? 3 : cur, 1, max);
          timesInput.value = String(clamped == null ? 3 : clamped);
        }
      } catch {}
      try {
        if (info?.mode !== "UNLIMITED" && info?.remaining === 0) {
          setStatus("No repeats remaining (may require refresh).");
        }
      } catch {}
      return info;
    };

    const getTimes = () => {
      const raw = readNumeric(timesInput?.value);
      const max =
        readNumeric(timesInput?.getAttribute?.("max")) ??
        readNumeric(timesInput?.max) ??
        50;
      const clamped = clampInt(raw == null ? 3 : raw, 1, max);
      return clamped == null ? 3 : clamped;
    };

    overlay.addEventListener("click", (event) => {
      if (event.target !== overlay) return;
      if (multiSolveOverlayState?.running) return;
      closeMultiSolveOverlay();
    });

    modal?.addEventListener("click", (event) => {
      try {
        event.stopPropagation();
      } catch {}
    });

    const onClose = (event) => {
      try {
        event.stopPropagation();
      } catch {}
      if (multiSolveOverlayState?.running) return;
      closeMultiSolveOverlay();
    };

    closeBtn?.addEventListener("click", onClose);
    cancelBtn?.addEventListener("click", onClose);

    stopBtn?.addEventListener("click", (event) => {
      try {
        event.stopPropagation();
      } catch {}
      multiSolveOverlayState.abortRequested = true;
      setStatus("Stopping...");
      try {
        stopBtn.disabled = true;
        stopBtn.textContent = "Stopping...";
      } catch {}
    });

    ratingMinRange?.addEventListener("input", () =>
      syncRatingRange(
        { ratingMin: ratingMinRange.value, ratingMax: ratingMaxRange.value },
        { source: "min" },
      ),
    );
    ratingMaxRange?.addEventListener("input", () =>
      syncRatingRange(
        { ratingMin: ratingMinRange.value, ratingMax: ratingMaxRange.value },
        { source: "max" },
      ),
    );
    ratingMinInput?.addEventListener("input", () =>
      syncRatingRange(
        { ratingMin: ratingMinInput.value, ratingMax: ratingMaxInput.value },
        { source: "min" },
      ),
    );
    ratingMaxInput?.addEventListener("input", () =>
      syncRatingRange(
        { ratingMin: ratingMinInput.value, ratingMax: ratingMaxInput.value },
        { source: "max" },
      ),
    );

    const bumpNumberInput = (input, dir) => {
      if (!input || input.disabled) return;
      const direction = dir === "down" ? "down" : "up";
      try {
        if (direction === "down") input.stepDown();
        else input.stepUp();
      } catch {
        const cur = readNumeric(input.value) ?? 0;
        const step = readNumeric(input.step) ?? 1;
        const min = readNumeric(input.min);
        const max = readNumeric(input.max);
        const next = cur + (direction === "down" ? -step : step);
        const clamped = Math.max(
          min == null ? -1e9 : min,
          Math.min(max == null ? 1e9 : max, next),
        );
        try {
          input.value = String(clamped);
        } catch {}
      }
      try {
        input.dispatchEvent(new Event("input", { bubbles: true }));
      } catch {}
      try {
        input.dispatchEvent(new Event("change", { bubbles: true }));
      } catch {}
    };

    modal?.addEventListener("click", (event) => {
      const btn =
        event?.target?.closest?.(".ea-data-times-stepper__btn") ?? null;
      if (!btn) return;
      try {
        event.preventDefault();
        event.stopPropagation();
      } catch {}
      const targetId = btn.getAttribute("data-target") ?? "";
      const stepDir = btn.getAttribute("data-step") ?? "up";
      const input = overlay.querySelector(`#${targetId}`);
      bumpNumberInput(input, stepDir);
    });

    const buildSafeRequirements = (payload) => {
      const safeRequirements = (payload?.openChallenge?.requirements ?? []).map(
        serializeRequirementForSolver,
      );
      const safeRequirementsNormalized = (
        payload?.openChallenge?.requirementsNormalized ?? []
      ).map((rule) => {
        if (!rule || typeof rule !== "object") return rule;
        return {
          type: rule.type ?? null,
          key: rule.key ?? null,
          keyName: rule.keyName ?? null,
          keyNameNormalized: rule.keyNameNormalized ?? null,
          typeSource: rule.typeSource ?? null,
          op: rule.op ?? null,
          count: rule.count ?? null,
          derivedCount: rule.derivedCount ?? null,
          value: rule.value ?? null,
          scope: rule.scope ?? null,
          scopeName: rule.scopeName ?? null,
          label: rule.label ?? null,
        };
      });
      return { safeRequirements, safeRequirementsNormalized };
    };

    const getFilteredPlayersForSolve = async (payload, challengeId = null) => {
      let settings = null;
      try {
        settings = await getSolverSettingsForChallenge(challengeId);
      } catch {
        settings = getDefaultSolverSettings();
      }
      const effectiveSettings = {
        ...settings,
        ratingRange: ratingRangeCurrent,
        ...getPoolSettingsFromInputs(),
      };
      const requiredIds = new Set();
      try {
        for (const slot of payload?.squadSlots ?? []) {
          const item = slot?.item ?? null;
          const id = item?.id ?? null;
          const concept = Boolean(item?.concept);
          if (id && id !== 0 && !concept) requiredIds.add(String(id));
        }
      } catch {}

      const allPlayers = Array.isArray(payload?.players) ? payload.players : [];
      const { filteredPlayers, poolFilters } =
        filterPlayersBySolverPoolSettings(allPlayers, effectiveSettings, {
          requiredIds,
        });
      const baseFilters =
        payload?.filters && typeof payload.filters === "object"
          ? payload.filters
          : {};
      const mergedFilters = {
        ...baseFilters,
        ...poolFilters,
      };
      return { filteredPlayers, mergedFilters, effectiveSettings };
    };

    const generateSolutions = async () => {
      if (multiSolveOverlayState?.running) return;
      const startedChallengeId = currentChallenge?.id ?? null;
      if (startedChallengeId == null) return;
      if (!isRepeatableChallenge(currentChallenge)) {
        showToast({
          type: "error",
          title: "Multi Solve Unavailable",
          message: "This challenge is not repeatable.",
          timeoutMs: 9000,
        });
        return;
      }

      reset();
      const times = getTimes();
      multiSolveOverlayState.abortRequested = false;
      setRunning(true, { mode: "generating" });
      setStatus("Preparing solver...");
      setProgress(0, times);
      try {
        const bridgeReady = await initSolverBridge();
        if (!bridgeReady) {
          showToast({
            type: "error",
            title: "Solver Not Ready",
            message: "Reload and try again.",
            timeoutMs: 9000,
          });
          return;
        }

        setStatus("Fetching players...");
        const payload = await window.eaData.getSolverPayload({
          ignoreLoaned: true,
        });
        if (currentChallenge?.id !== startedChallengeId) {
          setStatus("");
          return;
        }

        const { safeRequirements, safeRequirementsNormalized } =
          buildSafeRequirements(payload);
        const { filteredPlayers, mergedFilters, effectiveSettings } =
          await getFilteredPlayersForSolve(payload, startedChallengeId);
        const poolConflict = buildSolverPoolExclusionConflict({
          settings: effectiveSettings,
          requirementsNormalized: safeRequirementsNormalized,
          squadSlots: payload?.squadSlots ?? [],
        });
        if (poolConflict?.hasConflict) {
          const notice = buildSolverPoolConflictNotice(poolConflict);
          setStatus("");
          showToast({
            type: "error",
            title: notice?.title ?? "Pool Exclusion Conflict",
            message:
              notice?.message ??
              "Current exclusions conflict with challenge requirements.",
            timeoutMs: 9000,
          });
          return;
        }
        setStatus(
          `Building solutions (0 / ${times})... (pool: ${filteredPlayers.length}, rating: ${mergedFilters?.ratingMin ?? 0}-${mergedFilters?.ratingMax ?? 99})`,
        );
        const playerById = new Map(
          filteredPlayers
            .map((p) => [p?.id != null ? String(p.id) : null, p])
            .filter(([k]) => k != null),
        );

        const slotIndexToPositionName = new Map();
        try {
          for (const slot of payload?.squadSlots ?? []) {
            const idx = slot?.slotIndex ?? slot?.index ?? null;
            const pos = slot?.positionName ?? null;
            if (idx == null) continue;
            slotIndexToPositionName.set(Number(idx), pos);
          }
        } catch {}

        try {
          multiSolveOverlayState.challengeId = String(startedChallengeId);
          multiSolveOverlayState.requiredPlayers =
            readNumeric(payload?.requiredPlayers) ?? 11;
          multiSolveOverlayState.playerById = playerById;
          multiSolveOverlayState.slotIndexToPositionName =
            slotIndexToPositionName;
          multiSolveOverlayState.activeIndex = 0;
        } catch {}

        const used = new Set(
          (mergedFilters?.excludedPlayerIds ?? [])
            .map((v) => (v == null ? null : String(v)))
            .filter(Boolean),
        );
        const solutions = [];

        for (let i = 0; i < times; i += 1) {
          if (multiSolveOverlayState.abortRequested) break;
          setStatus(`Solving ${i + 1} / ${times}...`);
          setProgress(i, times);
          const excludedPlayerIds = Array.from(used);
          const loopFilters = {
            ...mergedFilters,
            excludedPlayerIds,
          };
          const result = await callSolverBridge(
            "SOLVE",
            {
              players: filteredPlayers,
              requirements: safeRequirements,
              requirementsNormalized: safeRequirementsNormalized,
              requiredPlayers: payload.requiredPlayers ?? null,
              squadSlots: payload.squadSlots ?? [],
              prioritize: payload.prioritize,
              filters: loopFilters,
              debug: debugEnabled,
            },
            SOLVER_BRIDGE_TIMEOUT_MS,
          );
          logSolverDebugResult("multi-generate", result, {
            challengeId: startedChallengeId,
            iteration: i + 1,
            total: times,
          });
          if (!result?.solutions?.length) {
            setStatus("");
            showToast({
              type: "error",
              title: "No More Solutions",
              message: "Unable to find more squads with current player pool.",
              timeoutMs: 9000,
            });
            break;
          }

          const solutionIds = result.solutions[0] ?? [];
          const slotSolution = result?.solutionSlots?.[0] ?? null;
          for (const id of solutionIds) {
            if (id == null) continue;
            used.add(String(id));
          }

          let specialCount = 0;
          try {
            for (const id of solutionIds) {
              const p = playerById.get(String(id));
              if (p?.isSpecial) specialCount += 1;
            }
          } catch {}

          solutions.push({
            solutionIds,
            slotSolution,
            stats: result?.stats ?? null,
            specialCount,
          });
          multiSolveOverlayState.solutions = solutions;
          setProgress(i + 1, times);
          renderSolutions();
        }

        // After generating, reflect the actual number of submittable solutions found.
        try {
          if (solutions.length && timesInput) {
            const max =
              readNumeric(timesInput?.getAttribute?.("max")) ??
              readNumeric(timesInput?.max) ??
              50;
            const next = clampInt(solutions.length, 1, max) ?? solutions.length;
            timesInput.value = String(next);
          }
        } catch {}

        if (multiSolveOverlayState.abortRequested) {
          setStatus(`Stopped. Fetched ${solutions.length} solution(s).`);
        } else if (solutions.length) {
          setStatus(`${solutions.length} solution(s) ready.`);
        } else {
          setStatus("");
        }
        setProgress(null, null);
      } catch (error) {
        log("debug", "[EA Data] Multi solve generation failed", error);
        setStatus("");
        showToast({
          type: "error",
          title: "Solver Error",
          message: "Check console for details.",
          timeoutMs: 9000,
        });
      } finally {
        setRunning(false);
        setProgress(null, null);
      }
    };

    const startSubmitting = async () => {
      if (multiSolveOverlayState?.running) return;
      const startedChallengeId = currentChallenge?.id ?? null;
      if (startedChallengeId == null) return;
      const solutions = multiSolveOverlayState?.solutions ?? [];
      if (!solutions.length) return;
      if (!isRepeatableChallenge(currentChallenge)) {
        showToast({
          type: "error",
          title: "Multi Solve Unavailable",
          message: "This challenge is not repeatable.",
          timeoutMs: 9000,
        });
        return;
      }

      multiSolveOverlayState.abortRequested = false;
      setRunning(true, { mode: "submitting" });
      setStatus(`Submitting 0 / ${solutions.length}...`);
      setProgress(0, solutions.length);
      let submitted = 0;
      let completedWithoutError = false;
      enterSbcAutomation();
      try {
        const setEntity = await ensureSbcSetById(
          currentChallenge?.setId ?? null,
        );
        if (!setEntity) throw new Error("SBC set not found");
        if (!services?.SBC?.requestChallengesForSet) {
          throw new Error("services.SBC.requestChallengesForSet unavailable");
        }

        for (let i = 0; i < solutions.length; i += 1) {
          if (multiSolveOverlayState.abortRequested) break;
          if (currentChallenge?.id !== startedChallengeId) {
            throw new Error("Challenge changed");
          }

          setProgress(i, solutions.length);

          const sol = solutions[i];
          setStatus(`(${i + 1}/${solutions.length}) Applying players...`);
          await applySolutionToChallenge(currentChallenge, sol.solutionIds, {
            lookupKey: "id",
            slotSolution: sol.slotSolution ?? null,
            playerById: multiSolveOverlayState?.playerById ?? null,
            preserveExistingValid: false,
          });
          await delayMs(jitterMs(350, 0.35));
          refreshOpenChallengeUI(currentChallenge);

          setStatus(`(${i + 1}/${solutions.length}) Submitting...`);
          const submitRes = await submitSbcChallenge(currentChallenge);
          if (!submitRes?.success) {
            const statusNum =
              parseStatusNumber(submitRes?.status) ??
              parseStatusNumber(submitRes?.error);
            if (isRetryableSbcStatus(statusNum)) {
              throw new Error(
                `Rate limited during submit (status ${statusNum}). Wait a bit and retry.`,
              );
            }
            const code = submitRes?.error ?? "SUBMIT_FAILED";
            throw new Error(
              `Submit failed (status ${statusNum ?? "?"}, error ${code})`,
            );
          }
          submitted += 1;
          setProgress(i + 1, solutions.length);

          showToast({
            type: "success",
            title: `Submitted ${i + 1} / ${solutions.length}`,
            message: "",
            timeoutMs: 3500,
          });

          setStatus(`(${i + 1}/${solutions.length}) Cooling down...`);
          await delayMs(jitterMs(4500, 0.35));
          try {
            await sbcApiCall(
              "requestChallengesForSet",
              () =>
                observableToPromise(
                  services.SBC.requestChallengesForSet(setEntity),
                ),
              { minGapMs: SBC_AUTOMATION_MIN_GAP_MS, maxAttempts: 2 },
            );
          } catch {}
          try {
            setStatus(`(${i + 1}/${solutions.length}) Refreshing...`);
            await loadChallenge(currentChallenge, true, { force: true });
          } catch {}
          refreshOpenChallengeUI(currentChallenge);
        }

        if (multiSolveOverlayState.abortRequested) {
          setStatus(`Stopped. Submitted ${submitted} / ${solutions.length}.`);
        } else {
          setStatus(`Complete. Submitted ${submitted} / ${solutions.length}.`);
        }
        try {
          // Prevent accidental double-submits with stale/consumed players.
          multiSolveOverlayState.solutions = [];
          multiSolveOverlayState.activeIndex = 0;
          renderSolutions();
        } catch {}

        if (multiSolveOverlayState.abortRequested) {
          showToast({
            type: "info",
            title: "Submitting Stopped",
            message: "Leave and re-open this challenge to refresh.",
            timeoutMs: 6500,
          });
        } else {
          showToast({
            type: "success",
            title: "Multi Solve Complete",
            message: "Leave and re-open this challenge to refresh.",
            timeoutMs: 6500,
          });
        }
        completedWithoutError = true;
      } catch (error) {
        log("debug", "[EA Data] Multi solve submit failed", error);
        try {
          setStatus(
            error?.message
              ? `Error: ${error.message}`
              : "Error: Submission failed.",
          );
        } catch {}
        showToast({
          type: "error",
          title: "Multi Solve Failed",
          message: error?.message || "Submission failed.",
          timeoutMs: 9000,
        });
      } finally {
        exitSbcAutomation();
        setRunning(false);
        setProgress(null, null);
        refreshOpenChallengeUI(currentChallenge);
      }

      // Force a navigation away from the challenge so EA reloads/paints the latest state.
      if (completedWithoutError) {
        try {
          closeMultiSolveOverlay();
        } catch {}
        await delayMs(jitterMs(300, 0.25));
        try {
          const exited = await tryExitSbcChallengeView(startedChallengeId);
          if (!exited) {
            showToast({
              type: "info",
              title: "Refresh Needed",
              message: "Please leave and re-open this challenge to refresh.",
              timeoutMs: 8000,
            });
          }
        } catch {}
      }
    };

    generateBtn?.addEventListener("click", async (event) => {
      try {
        event.stopPropagation();
      } catch {}
      await generateSolutions();
    });

    startBtn?.addEventListener("click", async (event) => {
      try {
        event.stopPropagation();
      } catch {}
      await startSubmitting();
    });

    multiSolveOverlayState = {
      overlay,
      closeBtn,
      cancelBtn,
      generateBtn,
      startBtn,
      stopBtn,
      timesInput,
      statusEl,
      listEl,
      ratingRangeRoot,
      ratingMinRange,
      ratingMaxRange,
      ratingMinInput,
      ratingMaxInput,
      toggleBinder,
      ratingRange: ratingRangeCurrent,
      poolSettings: getDefaultSolverPoolSettings(),
      challengeId: null,
      solutions: [],
      activeIndex: 0,
      requiredPlayers: 11,
      playerById: null,
      slotIndexToPositionName: null,
      sortKey: "rating_desc",
      running: false,
      mode: "idle",
      abortRequested: false,
      resetForChallenge,
      syncTimesFromRepeatability,
      syncRatingRange,
      syncPoolSettings,
    };

    if (!multiSolveOverlayKeyHandlerBound) {
      multiSolveOverlayKeyHandlerBound = true;
      document.addEventListener(
        "keydown",
        (event) => {
          if (event?.key !== "Escape") return;
          const open =
            document
              .getElementById("ea-data-multisolve-overlay")
              ?.getAttribute("aria-hidden") === "false";
          if (!open) return;
          if (multiSolveOverlayState?.running) return;
          try {
            event.preventDefault();
          } catch {}
          closeMultiSolveOverlay();
        },
        true,
      );
    }

    syncRatingRange({ ratingMin: 0, ratingMax: 99 }, { source: "init" });
    syncPoolSettings(getDefaultSolverSettings());
    reset();
    return overlay;
  };

  const openMultiSolveOverlay = async () => {
    const challengeId = currentChallenge?.id ?? null;
    if (challengeId == null) {
      showToast({
        type: "error",
        title: "Multi Solve Unavailable",
        message: "Open an SBC challenge first.",
        timeoutMs: 6500,
      });
      return;
    }
    if (!isRepeatableChallenge(currentChallenge)) {
      showToast({
        type: "error",
        title: "Multi Solve Unavailable",
        message: "This challenge is not repeatable.",
        timeoutMs: 9000,
      });
      return;
    }
    try {
      const info = getSbcSetRepeatabilityInfo(currentChallenge?.setId ?? null, {
        unlimitedDefault: 50,
        clampMax: 50,
      });
      const count = readNumeric(info?.challengesCount);
      if (count != null && count > 1) {
        showToast({
          type: "error",
          title: "Multi Solve Unavailable",
          message: "Only supported for standalone SBC challenges.",
          timeoutMs: 9000,
        });
        return;
      }
    } catch {}
    const overlay = ensureMultiSolveOverlay();
    try {
      overlay.style.pointerEvents = "auto";
    } catch {}
    const previousChallengeKey = multiSolveOverlayState?.challengeId ?? null;
    const nextChallengeKey = challengeId == null ? null : String(challengeId);
    try {
      multiSolveOverlayState?.resetForChallenge?.(challengeId);
    } catch {}
    try {
      multiSolveOverlayState?.syncTimesFromRepeatability?.(currentChallenge);
    } catch {}
    if (
      previousChallengeKey !== nextChallengeKey ||
      !multiSolveOverlayState?.ratingRange ||
      !multiSolveOverlayState?.poolSettings
    ) {
      try {
        const settings = await getSolverSettingsForChallenge(challengeId);
        multiSolveOverlayState?.syncRatingRange?.(settings?.ratingRange, {
          source: "open",
        });
        multiSolveOverlayState?.syncPoolSettings?.(settings);
      } catch {}
    }
    overlay.setAttribute("aria-hidden", "false");
    try {
      overlay.style.pointerEvents = "auto";
    } catch {}
    try {
      const input = overlay.querySelector("#ea-data-multisolve-times");
      input?.focus?.();
      input?.select?.();
    } catch {}
  };

  const ensureSetSolveOverlay = () => {
    ensureSolveButtonStyles();
    const existing = document.getElementById("ea-data-setsolve-overlay");
    if (existing && setSolveOverlayState) return existing;

    const overlay = existing || document.createElement("div");
    overlay.id = "ea-data-setsolve-overlay";
    overlay.setAttribute("aria-hidden", "true");
    overlay.style.position = "fixed";
    overlay.style.inset = "0";
    overlay.style.background = "rgba(0, 0, 0, 0.88)";
    overlay.style.display = "none";
    overlay.style.alignItems = "center";
    overlay.style.justifyContent = "center";
    overlay.style.zIndex = "1000002";
    overlay.style.fontFamily = '"Segoe UI", Arial, sans-serif';
    overlay.innerHTML = `
      <div class="ea-data-multisolve-modal" role="dialog" aria-modal="true" aria-labelledby="ea-data-setsolve-title">
        <div id="ea-data-setsolve-left-column">
        <div class="ea-data-settings-header">
          <div class="ea-data-settings-title" id="ea-data-setsolve-title">Solve Entire Set</div>
          <button type="button" class="ea-data-settings-close" aria-label="Close set solve" data-action="close">x</button>
        </div>

        <div class="ea-data-settings-section-label">Generate one squad per remaining challenge in this SBC set.</div>

        <div class="ea-data-settings-section-label" style="margin-top:12px">Player Rating Range</div>
        <div class="ea-data-range" id="ea-data-setsolve-rating-range">
          <div class="ea-data-range__track"></div>
          <input class="ea-data-range__input ea-data-range__input--min" id="ea-data-setsolve-rating-min" type="range" min="0" max="99" step="1" value="0" />
          <input class="ea-data-range__input ea-data-range__input--max" id="ea-data-setsolve-rating-max" type="range" min="0" max="99" step="1" value="99" />
        </div>

        <div class="ea-data-range__fields">
          <div class="ea-data-range__field">
            <div class="ea-data-range__label">Min</div>
            <input class="ea-data-range__number" id="ea-data-setsolve-rating-min-input" type="number" min="0" max="99" step="1" value="0" inputmode="numeric" />
          </div>
          <div class="ea-data-range__field">
            <div class="ea-data-range__label">Max</div>
            <input class="ea-data-range__number" id="ea-data-setsolve-rating-max-input" type="number" min="0" max="99" step="1" value="99" inputmode="numeric" />
          </div>
        </div>

        <div class="ea-data-settings-section-label" style="margin-top:12px">Player Pool Options</div>
        <div class="ea-data-toggle-list">
          ${renderSolverToggleFields({ scope: "set", idPrefix: "ea-data-setsolve-setting-" })}
        </div>

        <div class="ea-data-settings-section-label" style="margin-top:12px">Set Submission Cycles</div>
        <label class="ea-data-toggle-row" for="ea-data-setsolve-multi-enabled">
          <span class="ea-data-toggle-text">
            <span class="ea-data-toggle-title">Solve Multiple Set Cycles</span>
            <span class="ea-data-toggle-icon-wrap" aria-label="Help">
              <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2.5" fill="none" class="ea-data-toggle-info-icon" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><path d="M12 16v-4"></path><path d="M12 8h.01"></path></svg>
              <div class="ea-data-toggle-tooltip">Generate and submit full set cycles for repeatable group sets. A cycle only counts if every challenge in that cycle is solved.</div>
            </span>
          </span>
          <div class="ea-data-toggle-switch">
            <input id="ea-data-setsolve-multi-enabled" type="checkbox" />
            <div class="ea-data-toggle-slider"></div>
          </div>
        </label>

        <div class="ea-data-multisolve-field ea-data-multisolve-field--times" id="ea-data-setsolve-times-wrap" style="margin-top:8px;display:none">
          <div class="ea-data-range__label">Set Cycles</div>
          <div class="ea-data-times-stepper">
            <button type="button" class="ea-data-times-stepper__btn" data-step="down" data-target="ea-data-setsolve-times" aria-label="Decrease set cycles">-</button>
            <input
              class="ea-data-range__number ea-data-times-stepper__input"
              id="ea-data-setsolve-times"
              type="number"
              min="1"
              max="50"
              step="1"
              value="1"
              inputmode="numeric"
            />
            <button type="button" class="ea-data-times-stepper__btn" data-step="up" data-target="ea-data-setsolve-times" aria-label="Increase set cycles">+</button>
          </div>
        </div>

        <div class="ea-data-multisolve-status" id="ea-data-setsolve-cycle-meta" aria-live="polite"></div>

        <div class="ea-data-settings-section-label" style="margin-top:12px">Challenge Selection</div>
        <div class="ea-data-challenge-picker" id="ea-data-setsolve-challenge-picker">
          <div class="ea-data-solutions-empty">Loading challenges...</div>
        </div>

        <div class="ea-data-multisolve-grid">
          <button type="button" class="ea-data-btn ea-data-btn--primary" data-action="generate">Fetch Solutions</button>
        </div>

        <div class="ea-data-multisolve-status" id="ea-data-setsolve-status" aria-live="polite"></div>

        <div class="ea-data-progress" id="ea-data-setsolve-progress-wrap" style="display:none" aria-hidden="true">
          <div class="ea-data-progress__bar" id="ea-data-setsolve-progress"></div>
        </div>

        <div class="ea-data-solutions-list" id="ea-data-setsolve-solutions">
          <div class="ea-data-solutions-empty">No set solutions fetched yet.</div>
        </div>

        <div class="ea-data-multisolve-actions">
          <button type="button" class="ea-data-btn ea-data-btn--info" data-action="cancel">Cancel</button>
          <div class="ea-data-multisolve-actions-right">
            <button type="button" class="ea-data-btn ea-data-btn--danger" data-action="stop" style="display:none">Stop</button>
            <button type="button" class="ea-data-btn ea-data-btn--success" data-action="start" disabled>Start Submitting</button>
          </div>
        </div>
        </div>
        <aside id="ea-data-setsolve-right-panel" aria-live="polite">
          <div class="ea-data-setsolve-empty">Loading set details...</div>
        </aside>
      </div>
    `;

    if (!existing) document.body.appendChild(overlay);

    const modal = overlay.querySelector(".ea-data-multisolve-modal");
    const challengePickerWrap = overlay.querySelector(
      "#ea-data-setsolve-challenge-picker",
    );
    const rightPanelWrap = overlay.querySelector("#ea-data-setsolve-right-panel");
    const closeBtn = overlay.querySelector('[data-action="close"]');
    const cancelBtn = overlay.querySelector('[data-action="cancel"]');
    const generateBtn = overlay.querySelector('[data-action="generate"]');
    const startBtn = overlay.querySelector('[data-action="start"]');
    const stopBtn = overlay.querySelector('[data-action="stop"]');
    const multiSetToggleInput = overlay.querySelector(
      "#ea-data-setsolve-multi-enabled",
    );
    const setCyclesWrap = overlay.querySelector("#ea-data-setsolve-times-wrap");
    const setCyclesInput = overlay.querySelector("#ea-data-setsolve-times");
    const setCyclesMetaEl = overlay.querySelector(
      "#ea-data-setsolve-cycle-meta",
    );
    const statusEl = overlay.querySelector("#ea-data-setsolve-status");
    const progressWrap = overlay.querySelector(
      "#ea-data-setsolve-progress-wrap",
    );
    const progressBar = overlay.querySelector("#ea-data-setsolve-progress");
    const listEl = overlay.querySelector("#ea-data-setsolve-solutions");
    const ratingRangeRoot = overlay.querySelector(
      "#ea-data-setsolve-rating-range",
    );
    const ratingMinRange = overlay.querySelector(
      "#ea-data-setsolve-rating-min",
    );
    const ratingMaxRange = overlay.querySelector(
      "#ea-data-setsolve-rating-max",
    );
    const ratingMinInput = overlay.querySelector(
      "#ea-data-setsolve-rating-min-input",
    );
    const ratingMaxInput = overlay.querySelector(
      "#ea-data-setsolve-rating-max-input",
    );
    const toggleBinder = createSolverToggleBinder({
      root: overlay,
      scope: "set",
      idPrefix: "ea-data-setsolve-setting-",
    });

    const setStatus = (text) => {
      try {
        statusEl.textContent = text ? String(text) : "";
      } catch {}
    };

    const setProgress = (current, total) => {
      const cur = readNumeric(current);
      const tot = readNumeric(total);
      const ok = cur != null && tot != null && tot > 0;
      const pct = ok ? Math.max(0, Math.min(100, (cur / tot) * 100)) : 0;
      try {
        progressWrap.style.display = ok ? "" : "none";
        progressWrap.setAttribute("aria-hidden", ok ? "false" : "true");
        progressBar.style.width = `${pct}%`;
      } catch {}
    };

    const clearNode = (node) => {
      if (!node) return;
      try {
        while (node.firstChild) node.removeChild(node.firstChild);
      } catch {
        try {
          node.innerHTML = "";
        } catch {}
      }
    };

    const ensureSetSolveRightPanelState = () => {
      if (!setSolveOverlayState) return;
      const requestedCycles = clampInt(
        setSolveOverlayState?.requestedSetCycles ?? 1,
        1,
        50,
      );
      if (readNumeric(setSolveOverlayState?.requestedSetCyclesInput) == null) {
        setSolveOverlayState.requestedSetCyclesInput =
          requestedCycles == null ? 1 : requestedCycles;
      }
      if (!(setSolveOverlayState.requirementsByChallengeId instanceof Map)) {
        setSolveOverlayState.requirementsByChallengeId = new Map();
      }
      if (!(setSolveOverlayState.requirementsInFlight instanceof Set)) {
        setSolveOverlayState.requirementsInFlight = new Set();
      }
      const token = Number(setSolveOverlayState.requirementsLoadToken);
      if (!Number.isFinite(token)) {
        setSolveOverlayState.requirementsLoadToken = 0;
      }
      if (typeof setSolveOverlayState.rightPanelInitialized !== "boolean") {
        setSolveOverlayState.rightPanelInitialized = false;
      }
      if (!("rightPanelLastSetId" in setSolveOverlayState)) {
        setSolveOverlayState.rightPanelLastSetId = null;
      }
      if (!(setSolveOverlayState.failureByChallengeId instanceof Map)) {
        setSolveOverlayState.failureByChallengeId = new Map();
      }
      if (!("latestFailureContext" in setSolveOverlayState)) {
        setSolveOverlayState.latestFailureContext = null;
      }
      if (!("generationStopReason" in setSolveOverlayState)) {
        setSolveOverlayState.generationStopReason = null;
      }
    };

    const normalizeFailureToken = (value) => {
      if (value == null) return null;
      const numeric = readNumeric(value);
      if (numeric != null) return String(numeric);
      const text = String(value).trim().toLowerCase().replace(/\s+/g, " ");
      return text || null;
    };

    const collectFailureValueTokens = (value, out = []) => {
      if (value == null) return out;
      if (Array.isArray(value)) {
        for (const item of value) {
          collectFailureValueTokens(item, out);
        }
        return out;
      }
      if (value instanceof Set) {
        for (const item of Array.from(value)) {
          collectFailureValueTokens(item, out);
        }
        return out;
      }
      if (typeof value === "object") {
        const directId = readNumeric(
          value?.id ?? value?.itemId ?? value?.playerId ?? null,
        );
        if (directId != null) {
          out.push(String(directId));
          return out;
        }
        for (const key of Object.keys(value)) {
          collectFailureValueTokens(value[key], out);
        }
        return out;
      }
      const token = normalizeFailureToken(value);
      if (token) out.push(token);
      return out;
    };

    const normalizeFailureRuleKey = (rule) => {
      if (rule == null) return null;
      if (
        typeof rule === "string" ||
        typeof rule === "number" ||
        typeof rule === "boolean"
      ) {
        const token = normalizeFailureToken(rule);
        return token ? `text:${token}` : null;
      }
      if (typeof rule !== "object") return null;
      const type =
        normalizeFailureToken(
          rule?.type ??
            rule?.keyNameNormalized ??
            rule?.keyName ??
            rule?.requirementType ??
            rule?.attribute ??
            null,
        ) ?? "unknown";
      const op = normalizeFailureToken(rule?.op ?? rule?.scopeName ?? null);
      const key = normalizeFailureToken(
        rule?.keyNameNormalized ?? rule?.keyName ?? rule?.key ?? null,
      );
      const target = readNumeric(
        rule?.count ??
          rule?.derivedCount ??
          rule?.target ??
          rule?.value ??
          rule?.min ??
          rule?.minimum ??
          null,
      );
      const valueTokens = Array.from(
        new Set(
          collectFailureValueTokens(rule?.value ?? rule?.values ?? null, []),
        ),
      ).sort();
      const parts = [`type:${type}`];
      if (op) parts.push(`op:${op}`);
      if (key) parts.push(`key:${key}`);
      if (target != null) parts.push(`target:${target}`);
      if (valueTokens.length) parts.push(`value:${valueTokens.join(",")}`);
      return parts.join("|");
    };

    const buildRequirementLineItems = (snapshot) => {
      if (!snapshot || typeof snapshot !== "object") return [];
      const items = [];
      const seen = new Set();
      const pushItem = (value, ruleRef = null) => {
        if (value == null) return;
        const text = String(value).trim();
        if (!text) return;
        const dedupeKey = text.toLowerCase();
        if (seen.has(dedupeKey)) return;
        seen.add(dedupeKey);
        items.push({
          text,
          key: normalizeFailureRuleKey(ruleRef ?? text),
          textToken: normalizeFailureToken(text),
        });
      };

      const normalized = Array.isArray(snapshot?.requirementsNormalized)
        ? snapshot.requirementsNormalized
        : [];
      for (const row of normalized) {
        if (typeof row === "string") {
          pushItem(row, row);
          continue;
        }
        if (!row || typeof row !== "object") {
          if (row != null) pushItem(row, row);
          continue;
        }
        const direct = row.label ?? row.description ?? row.text ?? null;
        if (direct) {
          pushItem(direct, row);
          continue;
        }
        const type =
          row.type ?? row.keyNameNormalized ?? row.keyName ?? "Requirement";
        const min = readNumeric(
          row.count ?? row.derivedCount ?? row.value ?? row.min ?? row.minimum,
        );
        const max = readNumeric(row.max ?? row.maximum ?? null);
        if (min != null && max != null && min !== max) {
          pushItem(`${type}: ${min}-${max}`, row);
        } else if (min != null) {
          pushItem(`${type}: ${min}`, row);
        } else {
          pushItem(type, row);
        }
      }

      if (!items.length) {
        const parsed = Array.isArray(snapshot?.requirements)
          ? snapshot.requirements
          : Array.isArray(snapshot?.requirementsParsed)
            ? snapshot.requirementsParsed
            : [];
        for (const req of parsed) {
          if (!req || typeof req !== "object") continue;
          const direct =
            req.description ??
            req.eligibilityLabel ??
            req.label ??
            req.name ??
            req.title ??
            null;
          if (direct) {
            pushItem(direct, req);
            continue;
          }
          const type =
            req.type ?? req.requirementType ?? req.attribute ?? "Requirement";
          const min = readNumeric(
            req.value ?? req.count ?? req.min ?? req.minimum ?? null,
          );
          const max = readNumeric(req.max ?? req.maximum ?? null);
          if (min != null && max != null && min !== max) {
            pushItem(`${type}: ${min}-${max}`, req);
          } else if (min != null) {
            pushItem(`${type}: ${min}`, req);
          } else {
            pushItem(type, req);
          }
        }
      }

      const squadSize = readNumeric(snapshot?.squadSize);
      if (squadSize != null) {
        const hasSquadLine = items.some((item) =>
          /players in squad|squad size/i.test(item?.text ?? ""),
        );
        if (!hasSquadLine) {
          pushItem(`Players in Squad: ${squadSize}`, {
            type: "players_in_squad",
            op: "exact",
            count: squadSize,
            value: squadSize,
            label: `Players in Squad: ${squadSize}`,
          });
        }
      }

      return items;
    };

    const matchFailureRulesToRequirementIndices = (failureRules, lineItems) => {
      const blocked = new Set();
      const rows = Array.isArray(lineItems) ? lineItems : [];
      if (!rows.length) return blocked;
      const failing = Array.isArray(failureRules) ? failureRules : [];
      if (!failing.length) return blocked;

      const failingRuleKeys = new Set();
      const failingTextTokens = new Set();
      for (const rule of failing) {
        const key = normalizeFailureRuleKey(rule);
        if (key) failingRuleKeys.add(key);
        const token = normalizeFailureToken(
          rule?.label ??
            rule?.description ??
            rule?.eligibilityLabel ??
            rule?.text ??
            rule?.type ??
            rule?.keyNameNormalized ??
            null,
        );
        if (token) failingTextTokens.add(token);
      }

      for (let i = 0; i < rows.length; i += 1) {
        const row = rows[i];
        if (!row) continue;
        if (row.key && failingRuleKeys.has(row.key)) {
          blocked.add(i);
          continue;
        }
        if (row.textToken && failingTextTokens.has(row.textToken)) {
          blocked.add(i);
        }
      }
      return blocked;
    };

    const getFailureSourceMeta = (source) => {
      const normalized = String(source ?? "").toLowerCase();
      if (normalized === "pool-conflict") {
        return {
          label: "Pool Conflict",
          badgeClass: "ea-data-setsolve-req-badge--pool",
          sectionLabel: "Pool Exclusion",
        };
      }
      if (normalized === "slot-unavailable") {
        return {
          label: "Challenge Data",
          badgeClass: "ea-data-setsolve-req-badge--system",
          sectionLabel: "Challenge Data",
        };
      }
      if (normalized === "system") {
        return {
          label: "System",
          badgeClass: "ea-data-setsolve-req-badge--system",
          sectionLabel: "System",
        };
      }
      return {
        label: "Solver",
        badgeClass: "ea-data-setsolve-req-badge--solver",
        sectionLabel: "Solver",
      };
    };

    const createSetSolveInfoSection = (title) => {
      const section = document.createElement("section");
      section.className = "ea-data-setsolve-info-section";
      const heading = document.createElement("div");
      heading.className = "ea-data-setsolve-info-section-title";
      heading.textContent = String(title ?? "");
      section.append(heading);
      return section;
    };

    const appendSetSolveInfoRow = (section, label, value) => {
      if (!section) return;
      const row = document.createElement("div");
      row.className = "ea-data-setsolve-info-row";
      const labelEl = document.createElement("div");
      labelEl.className = "ea-data-setsolve-info-label";
      labelEl.textContent = String(label ?? "");
      const valueEl = document.createElement("div");
      valueEl.className = "ea-data-setsolve-info-value";
      valueEl.textContent = String(value ?? "n/a");
      row.append(labelEl);
      row.append(valueEl);
      section.append(row);
    };

    const renderSetSolveRightPanel = ({ reason = "state" } = {}) => {
      if (!rightPanelWrap) return;
      ensureSetSolveRightPanelState();
      try {
        rightPanelWrap.setAttribute("data-panel-reason", String(reason));
      } catch {}

      const challenges = Array.isArray(setSolveOverlayState?.availableChallenges)
        ? setSolveOverlayState.availableChallenges
        : [];
      const selectedIds = setSolveOverlayState?.selectedChallengeIds;
      const selectedCount =
        selectedIds == null ? challenges.length : selectedIds.size;
      const setId =
        readNumeric(setSolveOverlayState?.setId) ??
        readNumeric(currentSbcSet?.id) ??
        readNumeric(currentChallenge?.setId) ??
        null;
      const setEntity = getSbcSetById(setId) ?? currentSbcSet ?? null;
      const setName =
        setSolveOverlayState?.setName ?? setEntity?.name ?? "Current Set";
      const repeatInfo = getSbcSetRepeatabilityInfo(setId, {
        unlimitedDefault: 50,
        clampMax: 50,
      });
      const repeatMode = String(repeatInfo?.mode ?? "FINITE").toUpperCase();
      const remaining = readNumeric(repeatInfo?.remaining);
      const attemptsLeft =
        repeatMode === "UNLIMITED"
          ? "Unlimited"
          : remaining == null
            ? "n/a"
            : String(Math.max(0, remaining));
      const entries = Array.isArray(setSolveOverlayState?.entries)
        ? setSolveOverlayState.entries
        : [];
      const cycleResults = Array.isArray(setSolveOverlayState?.cycleResults)
        ? setSolveOverlayState.cycleResults
        : [];
      const isMultiModeActive = Boolean(setSolveOverlayState?.multiSetEnabled);
      const useCycleSummary =
        isMultiModeActive &&
        cycleResults.some(
        (cycle) => Array.isArray(cycle?.entries) && cycle.entries.length > 0,
      );
      const summaryEntries = useCycleSummary
        ? cycleResults.flatMap((cycle) =>
            Array.isArray(cycle?.entries) ? cycle.entries : [],
          )
        : entries;
      const solvedEntries = summaryEntries.filter(
        (entry) => entry?.status === "solved",
      ).length;
      const failedEntries = summaryEntries.filter(
        (entry) => entry && entry?.status !== "solved",
      ).length;
      const submittedEntries = summaryEntries.filter(
        (entry) => entry?.submitState === "submitted",
      ).length;
      const challengeOutcomeById = new Map();
      for (const entry of summaryEntries) {
        const challengeId =
          entry?.challengeId == null ? null : String(entry.challengeId);
        if (!challengeId) continue;
        challengeOutcomeById.set(
          challengeId,
          entry?.status === "solved" ? "solved" : "failed",
        );
      }
      const solvedCycles = cycleResults.filter(
        (cycle) => cycle?.status === "solved",
      ).length;
      const discardedCycles = cycleResults.filter(
        (cycle) => cycle?.status === "discarded",
      ).length;
      const submittedCycles = cycleResults.filter(
        (cycle) => cycle?.submitState === "submitted",
      ).length;
      const requestedCyclesInput = clampInt(
        setSolveOverlayState?.requestedSetCyclesInput ?? 1,
        1,
        50,
      );
      const requestedCycles = clampInt(
        setSolveOverlayState?.requestedSetCycles ?? 1,
        1,
        50,
      );
      const feasibleCycles = clampInt(
        setSolveOverlayState?.maxFeasibleCycles ?? null,
        0,
        50,
      );
      const requirementsById =
        setSolveOverlayState?.requirementsByChallengeId instanceof Map
          ? setSolveOverlayState.requirementsByChallengeId
          : new Map();
      const inFlight =
        setSolveOverlayState?.requirementsInFlight instanceof Set
          ? setSolveOverlayState.requirementsInFlight
          : new Set();
      const failureByChallengeId =
        setSolveOverlayState?.failureByChallengeId instanceof Map
          ? setSolveOverlayState.failureByChallengeId
          : new Map();
      const latestFailureContext =
        setSolveOverlayState?.latestFailureContext &&
        typeof setSolveOverlayState.latestFailureContext === "object"
          ? setSolveOverlayState.latestFailureContext
          : null;
      const generationStopReason = sanitizeDisplayText(
        setSolveOverlayState?.generationStopReason,
      );

      clearNode(rightPanelWrap);

      const title = document.createElement("div");
      title.className = "ea-data-setsolve-info-title";
      title.textContent = "Set Information";
      rightPanelWrap.append(title);

      const overview = createSetSolveInfoSection("Set Overview");
      appendSetSolveInfoRow(overview, "Set", setName);
      appendSetSolveInfoRow(
        overview,
        "Challenges",
        `${selectedCount}/${challenges.length || 0} selected`,
      );
      appendSetSolveInfoRow(
        overview,
        "Repeatability",
        repeatMode === "UNLIMITED" ? "Unlimited" : "Finite",
      );
      appendSetSolveInfoRow(overview, "Attempts Left", attemptsLeft);
      appendSetSolveInfoRow(
        overview,
        "Multi-Cycle",
        setSolveOverlayState?.multiSetEnabled ? "Enabled" : "Disabled",
      );
      rightPanelWrap.append(overview);

      const summary = createSetSolveInfoSection("Set Summary");
      appendSetSolveInfoRow(summary, "Entries", summaryEntries.length);
      appendSetSolveInfoRow(summary, "Solved Entries", solvedEntries);
      appendSetSolveInfoRow(summary, "Failed Entries", failedEntries);
      appendSetSolveInfoRow(summary, "Submitted Entries", submittedEntries);
      if (isMultiModeActive) {
        appendSetSolveInfoRow(
          summary,
          "Cycles",
          `${solvedCycles}/${cycleResults.length || 0} solved`,
        );
        appendSetSolveInfoRow(summary, "Discarded Cycles", discardedCycles);
        appendSetSolveInfoRow(summary, "Submitted Cycles", submittedCycles);
        appendSetSolveInfoRow(
          summary,
          "Requested Cycles (Input)",
          requestedCyclesInput ?? 1,
        );
        appendSetSolveInfoRow(
          summary,
          "Requested Cycles (Effective)",
          requestedCycles ?? 1,
        );
        appendSetSolveInfoRow(
          summary,
          "Feasible Cycles",
          feasibleCycles == null ? "n/a" : feasibleCycles,
        );
      }
      rightPanelWrap.append(summary);

      const showFailureSection = latestFailureContext != null || generationStopReason;
      if (showFailureSection) {
        const failureSection = createSetSolveInfoSection("Latest Failure");
        if (latestFailureContext) {
          const sourceMeta = getFailureSourceMeta(latestFailureContext?.source);
          appendSetSolveInfoRow(
            failureSection,
            "Challenge",
            latestFailureContext?.challengeName ??
              latestFailureContext?.challengeId ??
              "n/a",
          );
          appendSetSolveInfoRow(
            failureSection,
            "Cycle",
            latestFailureContext?.cycleIndex == null
              ? "n/a"
              : String(latestFailureContext.cycleIndex),
          );
          appendSetSolveInfoRow(
            failureSection,
            "Source",
            sourceMeta?.sectionLabel ?? "Unknown",
          );
          if (latestFailureContext?.reason) {
            const reasonEl = document.createElement("div");
            reasonEl.className = "ea-data-setsolve-failure-reason";
            reasonEl.textContent = String(latestFailureContext.reason);
            failureSection.append(reasonEl);
          }
        }
        if (generationStopReason) {
          const stopReasonEl = document.createElement("div");
          stopReasonEl.className = "ea-data-setsolve-hint";
          stopReasonEl.textContent = `Generation stop: ${generationStopReason}`;
          failureSection.append(stopReasonEl);
        }
        rightPanelWrap.append(failureSection);
      }

      const reqSection = createSetSolveInfoSection("Challenge Requirements");
      const reqList = document.createElement("div");
      reqList.className = "ea-data-setsolve-req-list";
      if (!challenges.length) {
        const empty = document.createElement("div");
        empty.className = "ea-data-setsolve-empty";
        empty.textContent = "No challenge requirements are available yet.";
        reqList.append(empty);
      } else {
        for (const challenge of challenges) {
          const challengeId = challenge?.id == null ? null : String(challenge.id);
          if (!challengeId) continue;
          const challengeName =
            challenge?.name ??
            challenge?.title ??
            `Challenge ${challengeId}`;
          const cached = requirementsById.get(challengeId) ?? null;
          const challengeFailures = failureByChallengeId.get(challengeId);
          const failureHistory = Array.isArray(challengeFailures)
            ? challengeFailures
            : [];
          const challengeFailure =
            failureHistory.length > 0
              ? failureHistory[failureHistory.length - 1]
              : null;
          const derivedOutcome =
            challengeOutcomeById.get(challengeId) ??
            (challengeFailure ? "failed" : null);
          const failureSourceMeta = getFailureSourceMeta(
            challengeFailure?.source ?? null,
          );
          const activeLoading =
            inFlight.has(challengeId) || cached?.status === "loading";
          const status = activeLoading
            ? "loading"
            : cached?.status === "error"
              ? "error"
              : "ready";
          const lineItems = buildRequirementLineItems(cached?.snapshot ?? null);
          const lines = lineItems.map((item) => item.text);
          const blockedIndices = matchFailureRulesToRequirementIndices(
            challengeFailure?.failingRequirements ?? [],
            lineItems,
          );
          const showReasonOnlyFallback =
            challengeFailure != null &&
            blockedIndices.size === 0 &&
            Boolean(challengeFailure?.reason);

          const card = document.createElement("div");
          card.className = "ea-data-setsolve-req-card";
          if (derivedOutcome === "failed") {
            card.classList.add("ea-data-setsolve-req-card--failed");
          } else if (derivedOutcome === "solved") {
            card.classList.add("ea-data-setsolve-req-card--solved");
          }

          const head = document.createElement("div");
          head.className = "ea-data-setsolve-req-head";
          const nameEl = document.createElement("div");
          nameEl.className = "ea-data-setsolve-req-name";
          nameEl.textContent = challengeName;
          nameEl.title = challengeName;
          const headRight = document.createElement("div");
          headRight.className = "ea-data-setsolve-req-head-right";
          const statusEl = document.createElement("span");
          statusEl.className = `ea-data-setsolve-req-status ea-data-setsolve-req-status--${status}`;
          statusEl.textContent =
            status === "loading"
              ? "Loading"
              : status === "error"
                ? "Unavailable"
                : "Ready";
          headRight.append(statusEl);
          if (challengeFailure) {
            const badgeEl = document.createElement("span");
            badgeEl.className = `ea-data-setsolve-req-badge ${failureSourceMeta.badgeClass}`;
            badgeEl.textContent = failureSourceMeta.label;
            badgeEl.title = challengeFailure?.reason
              ? String(challengeFailure.reason)
              : failureSourceMeta.label;
            headRight.append(badgeEl);
          } else if (derivedOutcome === "solved") {
            const badgeEl = document.createElement("span");
            badgeEl.className =
              "ea-data-setsolve-req-badge ea-data-setsolve-req-badge--solved";
            badgeEl.textContent = "Solved";
            badgeEl.title = "Challenge solved";
            headRight.append(badgeEl);
          }
          head.append(nameEl);
          head.append(headRight);
          card.append(head);

          if (status === "loading" && !lines.length) {
            const skeleton = document.createElement("div");
            skeleton.className = "ea-data-setsolve-skeleton";
            for (let i = 0; i < 3; i += 1) {
              const line = document.createElement("div");
              line.className = "ea-data-setsolve-skeleton-line";
              skeleton.append(line);
            }
            card.append(skeleton);
          } else if (lines.length) {
            const list = document.createElement("ul");
            list.className = "ea-data-setsolve-req-lines";
            for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
              const lineText = lines[lineIndex];
              const li = document.createElement("li");
              li.textContent = lineText;
              if (blockedIndices.has(lineIndex)) {
                li.classList.add("ea-data-setsolve-req-line--blocked");
              }
              list.append(li);
            }
            card.append(list);
            if (showReasonOnlyFallback) {
              const reason = document.createElement("div");
              reason.className = "ea-data-setsolve-failure-reason";
              reason.textContent = String(challengeFailure.reason);
              card.append(reason);
            }
            if (status === "loading") {
              const hint = document.createElement("div");
              hint.className = "ea-data-setsolve-hint";
              hint.textContent = "Refreshing latest requirement details...";
              card.append(hint);
            }
          } else {
            const empty = document.createElement("div");
            empty.className = "ea-data-setsolve-empty";
            empty.textContent =
              status === "error"
                ? cached?.errorMessage ||
                  "Failed to load requirement details for this challenge."
                : "No requirement details returned by EA for this challenge.";
            card.append(empty);
            if (showReasonOnlyFallback) {
              const reason = document.createElement("div");
              reason.className = "ea-data-setsolve-failure-reason";
              reason.textContent = String(challengeFailure.reason);
              card.append(reason);
            }
          }

          reqList.append(card);
        }
      }
      reqSection.append(reqList);
      rightPanelWrap.append(reqSection);
      setSolveOverlayState.rightPanelInitialized = true;
    };

    const refreshSetSolveRequirements = async (setId, challengesInput = null) => {
      ensureSetSolveRightPanelState();
      const state = setSolveOverlayState ?? null;
      if (!state) return;

      const targetSetId =
        readNumeric(setId) ??
        readNumeric(state?.setId) ??
        readNumeric(currentSbcSet?.id) ??
        readNumeric(currentChallenge?.setId) ??
        null;
      const setKey = targetSetId == null ? null : String(targetSetId);
      const challenges = (
        Array.isArray(challengesInput)
          ? challengesInput
          : Array.isArray(state?.availableChallenges)
            ? state.availableChallenges
            : []
      ).filter(Boolean);
      const requirementsById = state.requirementsByChallengeId;
      const prefetchedRequirementsById = getPrefetchedSetRequirementsByChallengeId(
        targetSetId,
      );

      if (!(requirementsById instanceof Map)) return;
      if (state.rightPanelLastSetId !== setKey) {
        requirementsById.clear();
      }
      state.rightPanelLastSetId = setKey;

      const prevToken = Number(state.requirementsLoadToken);
      const token = Number.isFinite(prevToken) ? prevToken + 1 : 1;
      state.requirementsLoadToken = token;
      if (state.requirementsInFlight instanceof Set) {
        state.requirementsInFlight.clear();
      } else {
        state.requirementsInFlight = new Set();
      }

      if (!challenges.length) {
        requirementsById.clear();
        renderSetSolveRightPanel({ reason: "requirements-empty" });
        return;
      }

      const validIds = new Set();
      const needsLoad = [];
      for (const challenge of challenges) {
        const challengeId = challenge?.id == null ? null : String(challenge.id);
        if (!challengeId) continue;
        validIds.add(challengeId);
        const challengeName =
          challenge?.name ??
          challenge?.title ??
          `Challenge ${challengeId}`;
        const prefetched = prefetchedRequirementsById?.get?.(challengeId) ?? null;
        const hasPrefetchedSnapshot =
          prefetched?.snapshot && typeof prefetched.snapshot === "object";
        const snapshot = hasPrefetchedSnapshot
          ? prefetched.snapshot
          : buildRequirementsSnapshot(challenge, null);
        requirementsById.set(challengeId, {
          challengeId,
          challengeName,
          snapshot,
          source: hasPrefetchedSnapshot
            ? (prefetched?.source ?? "prefetch")
            : "snapshot-local",
          status: hasPrefetchedSnapshot ? "ready" : "loading",
          updatedAt: Date.now(),
          errorMessage: null,
        });
        if (!hasPrefetchedSnapshot) needsLoad.push(challenge);
      }
      for (const existingId of Array.from(requirementsById.keys())) {
        if (!validIds.has(existingId)) requirementsById.delete(existingId);
      }
      renderSetSolveRightPanel({ reason: "requirements-seed" });

      for (const challenge of needsLoad) {
        if (state.requirementsLoadToken !== token) return;
        const challengeId = challenge?.id == null ? null : String(challenge.id);
        if (!challengeId) continue;
        const challengeName =
          challenge?.name ??
          challenge?.title ??
          `Challenge ${challengeId}`;
        state.requirementsInFlight.add(challengeId);
        renderSetSolveRightPanel({ reason: "requirements-loading" });
        try {
          const loaded = await loadChallenge(challenge, true, { force: true });
          if (state.requirementsLoadToken !== token) return;
          const snapshot = buildRequirementsSnapshot(
            challenge,
            loaded?.data ?? loaded,
          );
          requirementsById.set(challengeId, {
            challengeId,
            challengeName,
            snapshot,
            source: "snapshot-loaded",
            status: "ready",
            updatedAt: Date.now(),
            errorMessage: null,
          });
          upsertPrefetchedSetRequirement(targetSetId, challengeId, {
            challengeId,
            challengeName,
            snapshot,
            source: "snapshot-loaded",
            status: "ready",
            updatedAt: Date.now(),
            errorMessage: null,
          });
        } catch (err) {
          if (state.requirementsLoadToken !== token) return;
          const existing = requirementsById.get(challengeId) ?? null;
          requirementsById.set(challengeId, {
            challengeId,
            challengeName,
            snapshot: existing?.snapshot ?? null,
            source: existing?.source ?? "fallback",
            status: "error",
            updatedAt: Date.now(),
            errorMessage:
              err?.message == null
                ? "Failed to load requirements from server."
                : String(err.message),
          });
          upsertPrefetchedSetRequirement(targetSetId, challengeId, {
            challengeId,
            challengeName,
            snapshot: existing?.snapshot ?? null,
            source: existing?.source ?? "fallback",
            status: "error",
            updatedAt: Date.now(),
            errorMessage:
              err?.message == null
                ? "Failed to load requirements from server."
                : String(err.message),
          });
          log("debug", "[EA Data] Set solve requirements refresh failed", {
            setId: targetSetId,
            challengeId,
            error: err,
          });
        } finally {
          state.requirementsInFlight.delete(challengeId);
        }
        if (state.requirementsLoadToken !== token) return;
        renderSetSolveRightPanel({ reason: "requirements-updated" });
      }
    };

    const getContentHash = () => {
      try {
        const img = document.querySelector(
          'img[src*="/fut/sbc/companion/challenges/"]',
        );
        if (img?.src) {
          const m = img.src.match(/\/content\/([^/]+)\//);
          if (m) return m[1];
        }
      } catch {}
      return "26E4D4D6-8DBB-4A9A-BD99-9C47D3AA341D";
    };

    const renderChallengePicker = () => {
      const challenges = Array.isArray(
        setSolveOverlayState?.availableChallenges,
      )
        ? setSolveOverlayState.availableChallenges
        : [];
      const selectedIds = setSolveOverlayState?.selectedChallengeIds;
      clearNode(challengePickerWrap);

      if (!challenges.length) {
        const empty = document.createElement("div");
        empty.className = "ea-data-solutions-empty";
        empty.textContent = "No challenges available.";
        challengePickerWrap.append(empty);
        renderSetSolveRightPanel({ reason: "picker-empty" });
        return;
      }

      const contentHash = getContentHash();

      for (let i = 0; i < challenges.length; i += 1) {
        const challenge = challenges[i];
        const chIdStr = String(challenge?.id);
        const name =
          challenge?.name ?? challenge?.title ?? `Challenge ${chIdStr}`;
        const isSelected = selectedIds == null || selectedIds.has(chIdStr);

        const card = document.createElement("div");
        card.className = `ea-data-challenge-card ${
          isSelected
            ? "ea-data-challenge-card--selected"
            : "ea-data-challenge-card--deselected"
        }`;

        const img = document.createElement("img");
        img.className = "ea-data-challenge-card__icon";
        if (challenge?.assetId) {
          img.src = `https://www.ea.com/ea-sports-fc/ultimate-team/web-app/content/${contentHash}/2026/fut/sbc/companion/challenges/images/sbc_challenge_image_${challenge.assetId}.png`;
        }
        img.alt = name;

        const label = document.createElement("div");
        label.className = "ea-data-challenge-card__label";
        label.textContent = name;
        label.title = name;

        card.append(img);
        card.append(label);

        card.addEventListener("click", () => {
          if (setSolveOverlayState?.running) return;
          const currentIds = setSolveOverlayState.selectedChallengeIds;
          let newIds;
          if (currentIds == null) {
            newIds = new Set(challenges.map((c) => String(c.id)));
            newIds.delete(chIdStr);
          } else {
            newIds = new Set(currentIds);
            if (newIds.has(chIdStr)) {
              newIds.delete(chIdStr);
            } else {
              newIds.add(chIdStr);
            }
          }
          if (newIds.size === challenges.length) {
            setSolveOverlayState.selectedChallengeIds = null;
          } else if (newIds.size === 0) {
            setSolveOverlayState.selectedChallengeIds = new Set();
          } else {
            setSolveOverlayState.selectedChallengeIds = newIds;
          }
          renderChallengePicker();
          syncSetCycleControls();
        });

        challengePickerWrap.append(card);
      }
      renderSetSolveRightPanel({ reason: "picker-ready" });
    };

    const renderEntries = () => {
      const entries = Array.isArray(setSolveOverlayState?.entries)
        ? setSolveOverlayState.entries
        : [];
      const cycleResults = Array.isArray(setSolveOverlayState?.cycleResults)
        ? setSolveOverlayState.cycleResults
        : [];
      const isCombinedPreview =
        Boolean(setSolveOverlayState?.multiSetEnabled) &&
        cycleResults.length > 0;

      const maxIndex = Math.max(
        0,
        isCombinedPreview ? cycleResults.length - 1 : entries.length - 1,
      );
      const clampedIndex = clampInt(
        setSolveOverlayState?.activeIndex ?? 0,
        0,
        maxIndex,
      );
      setSolveOverlayState.activeIndex =
        clampedIndex == null ? 0 : clampedIndex;

      clearNode(listEl);

      if (isCombinedPreview) {
        const isBusy = Boolean(setSolveOverlayState?.running);
        const playerById = setSolveOverlayState?.playerById ?? null;
        const sortKey = String(setSolveOverlayState?.sortKey ?? "rating_desc");

        const activeIndex = setSolveOverlayState.activeIndex ?? 0;
        const cycle = cycleResults[activeIndex] ?? null;

        const combinedHeader = document.createElement("div");
        combinedHeader.className = "ea-data-preview-header";

        const headerLeft = document.createElement("div");
        headerLeft.className = "ea-data-preview-header-left";
        const headerTitle = document.createElement("div");
        headerTitle.className = "ea-data-solution-title";
        headerTitle.textContent = `Set Cycle #${activeIndex + 1}`;
        headerLeft.append(headerTitle);

        const headerRight = document.createElement("div");
        headerRight.className = "ea-data-preview-header-right";

        const nav = document.createElement("div");
        nav.className = "ea-data-preview-nav";

        const prevBtn = document.createElement("button");
        prevBtn.type = "button";
        prevBtn.className = "ea-data-preview-nav-btn";
        prevBtn.setAttribute("data-action", "prev");
        prevBtn.textContent = "Prev";
        prevBtn.disabled = isBusy || activeIndex <= 0;

        const page = document.createElement("div");
        page.className = "ea-data-preview-page";
        page.textContent = `${activeIndex + 1} / ${cycleResults.length}`;

        const nextBtn = document.createElement("button");
        nextBtn.type = "button";
        nextBtn.className = "ea-data-preview-nav-btn";
        nextBtn.setAttribute("data-action", "next");
        nextBtn.textContent = "Next";
        nextBtn.disabled = isBusy || activeIndex >= maxIndex;

        nav.append(prevBtn);
        nav.append(page);
        nav.append(nextBtn);

        const sortWrap = document.createElement("div");
        sortWrap.className = "ea-data-preview-sort";
        const sortLabel = document.createElement("div");
        sortLabel.className = "ea-data-preview-sort-label";
        sortLabel.textContent = "Sort";
        const sortSelect = document.createElement("select");
        sortSelect.className = "ea-data-preview-sort-select";
        sortSelect.setAttribute("data-action", "sort");
        sortSelect.disabled = isBusy;
        sortSelect.innerHTML = `
          <option value="rating_desc">Rating</option>
          <option value="slot">Slots</option>
        `;
        sortSelect.value = sortKey;
        sortWrap.append(sortLabel);
        sortWrap.append(sortSelect);

        headerRight.append(nav);
        headerRight.append(sortWrap);
        combinedHeader.append(headerLeft);
        combinedHeader.append(headerRight);
        listEl.append(combinedHeader);

        const solvedCyclesCount = cycleResults.filter(
          (c) => c?.status === "solved",
        ).length;
        const discardedCyclesCount = cycleResults.length - solvedCyclesCount;
        const combinedMeta = document.createElement("div");
        combinedMeta.className = "ea-data-preview-meta";
        combinedMeta.textContent = `Cycles ${cycleResults.length} | Solved ${solvedCyclesCount} | Discarded ${discardedCyclesCount}`;
        listEl.append(combinedMeta);

        const appendEntryRows = (entry, targetNode = listEl) => {
          if (!entry || entry?.status !== "solved") return;
          const playersWrap = document.createElement("div");
          playersWrap.className = "ea-data-preview-players";

          const ids = Array.isArray(entry?.solutionIds)
            ? entry.solutionIds
            : [];
          const slotSolution = entry?.slotSolution ?? null;
          const slotIndices = Array.isArray(slotSolution?.fieldSlotIndices)
            ? slotSolution.fieldSlotIndices
            : null;
          const slotPlayerIds = Array.isArray(slotSolution?.fieldSlotToPlayerId)
            ? slotSolution.fieldSlotToPlayerId
            : null;
          const perChem = Array.isArray(slotSolution?.perPlayerChem)
            ? slotSolution.perPlayerChem
            : [];
          const onPos = Array.isArray(slotSolution?.onPosition)
            ? slotSolution.onPosition
            : [];
          const slotIndexToPos = entry?.slotIndexToPositionName ?? null;

          const getPosName = (slotIndex) => {
            if (slotIndex == null || !slotIndexToPos) return null;
            if (slotIndexToPos instanceof Map) {
              return slotIndexToPos.get(Number(slotIndex)) ?? null;
            }
            if (Array.isArray(slotIndexToPos)) {
              for (const pair of slotIndexToPos) {
                if (!Array.isArray(pair) || pair.length < 2) continue;
                if (Number(pair[0]) === Number(slotIndex))
                  return pair[1] ?? null;
              }
              return null;
            }
            if (typeof slotIndexToPos === "object") {
              return (
                slotIndexToPos[slotIndex] ??
                slotIndexToPos[String(slotIndex)] ??
                null
              );
            }
            return null;
          };

          const rowCount = Math.max(slotPlayerIds?.length ?? 0, ids.length);
          const rows = [];
          for (let i = 0; i < rowCount; i += 1) {
            const slotIndex = slotIndices?.[i] ?? null;
            const playerId = slotPlayerIds?.[i] ?? ids[i] ?? null;
            const player =
              playerById && playerId != null
                ? playerById.get(String(playerId))
                : null;
            const posName = getPosName(slotIndex);
            const posLabel =
              posName ??
              player?.preferredPositionName ??
              (slotIndex != null ? `Slot ${slotIndex}` : "Slot");
            const ratingNum = readNumeric(player?.rating);
            const rating = ratingNum == null ? "?" : String(ratingNum);
            const nameRaw = player?.name ?? null;
            const name =
              nameRaw && String(nameRaw).trim()
                ? String(nameRaw).trim()
                : "Unknown";
            const rarity = player?.rarityName ?? "";
            const definitionId = player?.definitionId ?? null;
            const isSpecial = Boolean(player?.isSpecial);
            const chemVal = perChem?.[i];
            const onPosVal = onPos?.[i];
            rows.push({
              originalIndex: i,
              slotIndex,
              playerId,
              posLabel,
              rating,
              ratingNum: ratingNum == null ? -1 : ratingNum,
              name,
              rarity,
              definitionId,
              isSpecial,
              chemVal,
              onPosVal,
            });
          }

          if (sortKey === "rating_desc") {
            rows.sort((a, b) => {
              if (b.ratingNum !== a.ratingNum) return b.ratingNum - a.ratingNum;
              const ap = String(a.posLabel ?? "");
              const bp = String(b.posLabel ?? "");
              const cmp = ap.localeCompare(bp);
              if (cmp) return cmp;
              return a.originalIndex - b.originalIndex;
            });
          } else {
            rows.sort((a, b) => a.originalIndex - b.originalIndex);
          }

          for (const rowData of rows) {
            const row = document.createElement("div");
            row.className = "ea-data-preview-row";
            if (rows.indexOf(rowData) % 2 === 1) {
              try {
                row.style.backgroundColor = "rgba(255, 255, 255, 0.02)";
              } catch {}
            }

            const posEl = document.createElement("div");
            posEl.className = "ea-data-preview-pos";
            posEl.textContent = String(rowData.posLabel ?? "Slot");

            const main = document.createElement("div");
            main.className = "ea-data-preview-main";
            const left = document.createElement("div");
            left.className = "ea-data-preview-left";

            const ratingEl = document.createElement("div");
            ratingEl.className = "ea-data-preview-rating";
            ratingEl.textContent = String(rowData.rating ?? "?");

            const nameEl = document.createElement("div");
            nameEl.className = "ea-data-preview-name";
            nameEl.textContent = String(rowData.name ?? "Unknown");

            const rarityEl = document.createElement("div");
            rarityEl.className = "ea-data-preview-rarity";
            rarityEl.textContent = rowData.rarity ? String(rowData.rarity) : "";

            left.append(ratingEl);
            left.append(nameEl);
            if (rowData.rarity) left.append(rarityEl);

            const right = document.createElement("div");
            right.className = "ea-data-preview-right";

            const idEl = document.createElement("div");
            idEl.className = "ea-data-preview-id";
            idEl.textContent =
              rowData.definitionId != null
                ? `def ${rowData.definitionId}`
                : rowData.playerId != null
                  ? `id ${rowData.playerId}`
                  : "";
            if (idEl.textContent) right.append(idEl);

            if (rowData.isSpecial) {
              const pill = document.createElement("span");
              pill.className = "ea-data-pill ea-data-pill--special";
              pill.textContent = "Special";
              right.append(pill);
            }
            if (rowData.onPosVal === false) {
              const pill = document.createElement("span");
              pill.className = "ea-data-pill ea-data-pill--warn";
              pill.textContent = "Off-pos";
              right.append(pill);
            } else if (rowData.chemVal != null) {
              const pill = document.createElement("span");
              pill.className = "ea-data-pill";
              pill.textContent = `Chem ${rowData.chemVal}`;
              right.append(pill);
            }

            main.append(left);
            main.append(right);
            row.append(posEl);
            row.append(main);
            playersWrap.append(row);
          }

          targetNode.append(playersWrap);
        };

        if (!cycle) {
          renderSetSolveRightPanel({ reason: "entries-no-cycle" });
          return;
        }
        const cycleIndex = readNumeric(cycle?.cycleIndex) ?? 0;
        const cycleEntries = Array.isArray(cycle?.entries) ? cycle.entries : [];
        const cycleBlock = document.createElement("div");
        cycleBlock.className = "ea-data-used-summary";
        if (listEl.childElementCount > 0) {
          try {
            cycleBlock.style.marginTop = "8px";
          } catch {}
        }

        const top = document.createElement("div");
        top.className = "ea-data-used-summary-top";
        const title = document.createElement("div");
        title.className = "ea-data-used-summary-title";
        title.textContent = `Cycle ${Math.max(1, cycleIndex)}`;
        const right = document.createElement("div");
        right.className = "ea-data-preview-right";
        const statePill = document.createElement("span");
        statePill.className =
          cycle?.status === "solved"
            ? "ea-data-pill ea-data-pill--ok"
            : "ea-data-pill ea-data-pill--fail";
        statePill.textContent =
          cycle?.status === "solved" ? "Solved" : "Discarded";
        right.append(statePill);
        if (cycle?.submitState === "submitted") {
          const submitPill = document.createElement("span");
          submitPill.className = "ea-data-pill ea-data-pill--ok";
          submitPill.textContent = "Submitted";
          right.append(submitPill);
        }
        top.append(title);
        top.append(right);
        cycleBlock.append(top);

        if (cycle?.status !== "solved") {
          const discardedText = document.createElement("div");
          discardedText.className = "ea-data-solutions-empty";
          discardedText.textContent =
            cycle?.reason ??
            "Cycle discarded because at least one challenge could not be solved.";
          cycleBlock.append(discardedText);
          listEl.append(cycleBlock);
        } else {
          const challengesPillRow = document.createElement("div");
          challengesPillRow.className = "ea-data-used-summary-pills";
          try {
            challengesPillRow.style.marginBottom = "8px";
          } catch {}
          const challengesPill = document.createElement("span");
          challengesPill.className = "ea-data-pill";
          challengesPill.textContent = `Challenges ${cycleEntries.length}`;
          challengesPillRow.append(challengesPill);
          cycleBlock.append(challengesPillRow);

          try {
            cycleBlock.style.backgroundColor = "rgba(0, 0, 0, 0.45)";
            cycleBlock.style.border = "1px solid rgba(255, 255, 255, 0.1)";
            cycleBlock.style.borderRadius = "12px";
            cycleBlock.style.padding = "12px";
            cycleBlock.style.marginTop = "16px";
            cycleBlock.style.boxShadow = "0 8px 24px rgba(0, 0, 0, 0.4)";
          } catch {}

          for (const entry of cycleEntries) {
            const detailsEl = document.createElement("details");
            detailsEl.className = "ea-data-solution-details";
            detailsEl.open = true;
            try {
              detailsEl.style.setProperty("margin-top", "12px", "important");
              detailsEl.style.setProperty("margin-bottom", "12px", "important");
              detailsEl.style.setProperty("padding-bottom", "8px", "important");
              detailsEl.style.backgroundColor = "rgba(0, 0, 0, 0.25)";
              detailsEl.style.border = "1px solid rgba(255, 255, 255, 0.05)";
              detailsEl.style.borderRadius = "8px";
              detailsEl.style.overflow = "hidden";
            } catch {}

            const summaryEl = document.createElement("summary");
            summaryEl.className =
              "ea-data-solution-summary ea-data-preview-header";
            try {
              summaryEl.style.cursor = "pointer";
              summaryEl.style.userSelect = "none";
              summaryEl.style.outline = "none";
              summaryEl.style.display = "flex";
              summaryEl.style.alignItems = "center";
              summaryEl.style.justifyContent = "space-between";
              summaryEl.style.padding = "8px 12px";
              summaryEl.style.backgroundColor = "rgba(255, 255, 255, 0.05)";
              summaryEl.style.transition = "background-color 0.2s ease";

              summaryEl.onmouseover = () => {
                summaryEl.style.backgroundColor = "rgba(255, 255, 255, 0.1)";
              };
              summaryEl.onmouseout = () => {
                summaryEl.style.backgroundColor = "rgba(255, 255, 255, 0.05)";
              };
            } catch {}

            const leftWrap = document.createElement("div");
            try {
              leftWrap.style.display = "flex";
              leftWrap.style.alignItems = "center";
            } catch {}

            const arrowIcon = document.createElement("span");
            arrowIcon.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>`;
            try {
              arrowIcon.style.display = "flex";
              arrowIcon.style.marginRight = "6px";
              arrowIcon.style.transition = "transform 0.2s ease";
              arrowIcon.style.transform = "rotate(0deg)";
            } catch {}

            detailsEl.addEventListener("toggle", () => {
              try {
                arrowIcon.style.transform = detailsEl.open
                  ? "rotate(0deg)"
                  : "rotate(-90deg)";
              } catch {}
            });

            const challengeTitle = document.createElement("div");
            challengeTitle.className = "ea-data-solution-title";
            try {
              challengeTitle.style.margin = "0";
            } catch {}
            challengeTitle.textContent =
              entry?.challengeName ?? `Challenge ${entry?.challengeId ?? "?"}`;

            leftWrap.append(arrowIcon);
            leftWrap.append(challengeTitle);
            summaryEl.append(leftWrap);

            const statusMeta = document.createElement("div");
            statusMeta.className = "ea-data-preview-meta";
            if (entry?.status === "solved") {
              const squadRating =
                entry?.stats?.squadRating ?? entry?.stats?.ratingTarget ?? "?";
              const chem = entry?.stats?.chemistry?.totalChem ?? null;
              const chemStr = chem == null ? "n/a" : String(chem);
              const specialCount = readNumeric(entry?.specialCount) ?? 0;
              const players = Array.isArray(entry?.solutionIds)
                ? entry.solutionIds.length
                : 0;
              const requiredPlayers =
                readNumeric(entry?.requiredPlayers) ??
                readNumeric(entry?.stats?.squadSize) ??
                Math.max(players, 0);
              const submitLabel =
                entry?.submitState === "submitted"
                  ? " | Submitted"
                  : entry?.submitState === "skipped"
                    ? " | Skipped"
                    : entry?.submitState === "failed"
                      ? " | Submit Failed"
                      : "";
              statusMeta.textContent = `Rating ${squadRating} | Chem ${chemStr} | Special ${specialCount} | Players ${players}/${requiredPlayers}${submitLabel}`;
            } else {
              statusMeta.textContent =
                entry?.reason ?? "No feasible squad with current player pool.";
            }
            summaryEl.append(statusMeta);
            detailsEl.append(summaryEl);

            cycleBlock.append(detailsEl);
            appendEntryRows(entry, detailsEl);
          }
          listEl.append(cycleBlock);
        }

        try {
          const ratingCounts = new Map();
          let usedPlayers = 0;
          let usedSpecial = 0;
          let totalSolutions = 0;
          for (const c of cycleResults) {
            const ents = Array.isArray(c?.entries) ? c.entries : [];
            for (const ent of ents) {
              if (ent?.status !== "solved") continue;
              totalSolutions += 1;
              const ids = Array.isArray(ent?.solutionIds)
                ? ent.solutionIds
                : [];
              for (const id of ids) {
                if (id == null) continue;
                usedPlayers += 1;
                const p = playerById ? playerById.get(String(id)) : null;
                const r = readNumeric(p?.rating);
                if (r != null)
                  ratingCounts.set(r, (ratingCounts.get(r) || 0) + 1);
                if (p?.isSpecial) usedSpecial += 1;
              }
            }
          }

          const summary = document.createElement("div");
          summary.className = "ea-data-used-summary";
          if (listEl.childElementCount > 0) {
            try {
              summary.style.marginTop = "8px";
            } catch {}
          }

          const topNode = document.createElement("div");
          topNode.className = "ea-data-used-summary-top";

          const titleEl = document.createElement("div");
          titleEl.className = "ea-data-used-summary-title";
          titleEl.textContent = "All Cycles Usage Breakdown";

          const topRight = document.createElement("div");
          topRight.className = "ea-data-preview-right";

          const solPill = document.createElement("span");
          solPill.className = "ea-data-pill";
          solPill.textContent = `Challenges ${totalSolutions}`;
          topRight.append(solPill);

          const playersPill = document.createElement("span");
          playersPill.className = "ea-data-pill";
          playersPill.textContent = `Players ${usedPlayers}`;
          topRight.append(playersPill);

          const specialPill = document.createElement("span");
          specialPill.className = usedSpecial
            ? "ea-data-pill ea-data-pill--special"
            : "ea-data-pill";
          specialPill.textContent = `Special ${usedSpecial}`;
          topRight.append(specialPill);

          topNode.append(titleEl);
          topNode.append(topRight);
          summary.append(topNode);

          const pillsNode = document.createElement("div");
          pillsNode.className = "ea-data-used-summary-pills";

          const countsEntries = Array.from(ratingCounts.entries()).sort(
            ([a], [b]) => b - a,
          );
          if (!countsEntries.length) {
            const pill = document.createElement("span");
            pill.className = "ea-data-pill";
            pill.textContent = "Ratings n/a";
            pillsNode.append(pill);
          } else {
            for (const [rating, count] of countsEntries) {
              const pill = document.createElement("span");
              pill.className = "ea-data-pill ea-data-pill--rating";
              pill.textContent = `${rating}×${count}`;
              pillsNode.append(pill);
            }
          }

          summary.append(pillsNode);
          listEl.append(summary);
        } catch {}
        renderSetSolveRightPanel({ reason: "entries-combined" });
        return;
      }

      if (!entries.length) {
        const empty = document.createElement("div");
        empty.className = "ea-data-solutions-empty";
        empty.textContent = "No set solutions fetched yet.";
        listEl.append(empty);
        renderSetSolveRightPanel({ reason: "entries-empty" });
        return;
      }

      const activeIndex = setSolveOverlayState.activeIndex ?? 0;
      const entry = entries[activeIndex] ?? null;
      const isBusy = Boolean(setSolveOverlayState?.running);
      const playerById = setSolveOverlayState?.playerById ?? null;

      const header = document.createElement("div");
      header.className = "ea-data-preview-header";

      const headerLeft = document.createElement("div");
      headerLeft.className = "ea-data-preview-header-left";
      const title = document.createElement("div");
      title.className = "ea-data-solution-title";
      title.textContent =
        entry?.challengeName ?? `Challenge ${entry?.challengeId ?? "?"}`;
      headerLeft.append(title);

      const headerRight = document.createElement("div");
      headerRight.className = "ea-data-preview-header-right";
      const nav = document.createElement("div");
      nav.className = "ea-data-preview-nav";

      const prevBtn = document.createElement("button");
      prevBtn.type = "button";
      prevBtn.className = "ea-data-preview-nav-btn";
      prevBtn.setAttribute("data-action", "prev");
      prevBtn.textContent = "Prev";
      prevBtn.disabled = isBusy || activeIndex <= 0;

      const page = document.createElement("div");
      page.className = "ea-data-preview-page";
      page.textContent = `${activeIndex + 1} / ${entries.length}`;

      const nextBtn = document.createElement("button");
      nextBtn.type = "button";
      nextBtn.className = "ea-data-preview-nav-btn";
      nextBtn.setAttribute("data-action", "next");
      nextBtn.textContent = "Next";
      nextBtn.disabled = isBusy || activeIndex >= maxIndex;

      nav.append(prevBtn);
      nav.append(page);
      nav.append(nextBtn);

      const sortWrap = document.createElement("div");
      sortWrap.className = "ea-data-preview-sort";
      const sortLabel = document.createElement("div");
      sortLabel.className = "ea-data-preview-sort-label";
      sortLabel.textContent = "Sort";
      const sortSelect = document.createElement("select");
      sortSelect.className = "ea-data-preview-sort-select";
      sortSelect.setAttribute("data-action", "sort");
      sortSelect.disabled = isBusy || entry?.status !== "solved";
      sortSelect.innerHTML = `
        <option value="rating_desc">Rating</option>
        <option value="slot">Slots</option>
      `;
      sortSelect.value = String(setSolveOverlayState?.sortKey ?? "rating_desc");
      sortWrap.append(sortLabel);
      sortWrap.append(sortSelect);

      headerRight.append(nav);
      headerRight.append(sortWrap);
      header.append(headerLeft);
      header.append(headerRight);

      const cardContainer = document.createElement("div");
      try {
        cardContainer.style.setProperty("margin-bottom", "16px", "important");
        cardContainer.style.backgroundColor = "rgba(0, 0, 0, 0.25)";
        cardContainer.style.border = "1px solid rgba(255, 255, 255, 0.05)";
        cardContainer.style.borderRadius = "8px";
        cardContainer.style.overflow = "hidden";
      } catch {}

      try {
        header.style.padding = "10px 12px";
        header.style.backgroundColor = "rgba(255, 255, 255, 0.05)";
      } catch {}
      cardContainer.append(header);

      const statusMeta = document.createElement("div");
      statusMeta.className = "ea-data-preview-meta";
      try {
        statusMeta.style.padding = "8px 12px";
        statusMeta.style.backgroundColor = "rgba(255, 255, 255, 0.02)";
      } catch {}
      if (entry?.status === "solved") {
        const squadRating =
          entry?.stats?.squadRating ?? entry?.stats?.ratingTarget ?? "?";
        const chem = entry?.stats?.chemistry?.totalChem ?? null;
        const chemStr = chem == null ? "n/a" : String(chem);
        const specialCount = readNumeric(entry?.specialCount) ?? 0;
        const players = Array.isArray(entry?.solutionIds)
          ? entry.solutionIds.length
          : 0;
        const requiredPlayers =
          readNumeric(entry?.requiredPlayers) ??
          readNumeric(entry?.stats?.squadSize) ??
          Math.max(players, 0);
        const submitLabel =
          entry?.submitState === "submitted"
            ? " | Submitted"
            : entry?.submitState === "skipped"
              ? " | Skipped"
              : entry?.submitState === "failed"
                ? " | Submit Failed"
                : "";
        statusMeta.textContent = `Rating ${squadRating} | Chem ${chemStr} | Special ${specialCount} | Players ${players}/${requiredPlayers}${submitLabel}`;
      } else {
        const stateLabel = entry?.status === "skipped" ? "Skipped" : "Failed";
        statusMeta.textContent = `${stateLabel} | ${entry?.reason ?? "No feasible squad with current player pool."}`;
      }
      cardContainer.append(statusMeta);

      if (entry?.status === "solved") {
        const playersWrap = document.createElement("div");
        playersWrap.className = "ea-data-preview-players";

        const ids = Array.isArray(entry?.solutionIds) ? entry.solutionIds : [];
        const slotSolution = entry?.slotSolution ?? null;
        const slotIndices = Array.isArray(slotSolution?.fieldSlotIndices)
          ? slotSolution.fieldSlotIndices
          : null;
        const slotPlayerIds = Array.isArray(slotSolution?.fieldSlotToPlayerId)
          ? slotSolution.fieldSlotToPlayerId
          : null;
        const perChem = Array.isArray(slotSolution?.perPlayerChem)
          ? slotSolution.perPlayerChem
          : [];
        const onPos = Array.isArray(slotSolution?.onPosition)
          ? slotSolution.onPosition
          : [];
        const slotIndexToPos = entry?.slotIndexToPositionName ?? null;

        const getPosName = (slotIndex) => {
          if (slotIndex == null || !slotIndexToPos) return null;
          if (slotIndexToPos instanceof Map) {
            return slotIndexToPos.get(Number(slotIndex)) ?? null;
          }
          if (Array.isArray(slotIndexToPos)) {
            for (const pair of slotIndexToPos) {
              if (!Array.isArray(pair) || pair.length < 2) continue;
              if (Number(pair[0]) === Number(slotIndex)) return pair[1] ?? null;
            }
            return null;
          }
          if (typeof slotIndexToPos === "object") {
            return (
              slotIndexToPos[slotIndex] ??
              slotIndexToPos[String(slotIndex)] ??
              null
            );
          }
          return null;
        };

        const rowCount = Math.max(slotPlayerIds?.length ?? 0, ids.length);
        const rows = [];
        for (let i = 0; i < rowCount; i += 1) {
          const slotIndex = slotIndices?.[i] ?? null;
          const playerId = slotPlayerIds?.[i] ?? ids[i] ?? null;
          const player =
            playerById && playerId != null
              ? playerById.get(String(playerId))
              : null;

          const posName = getPosName(slotIndex);
          const posLabel =
            posName ??
            player?.preferredPositionName ??
            (slotIndex != null ? `Slot ${slotIndex}` : "Slot");
          const ratingNum = readNumeric(player?.rating);
          const rating = ratingNum == null ? "?" : String(ratingNum);
          const nameRaw = player?.name ?? null;
          const name =
            nameRaw && String(nameRaw).trim()
              ? String(nameRaw).trim()
              : "Unknown";
          const rarity = player?.rarityName ?? "";
          const definitionId = player?.definitionId ?? null;
          const isSpecial = Boolean(player?.isSpecial);
          const chemVal = perChem?.[i];
          const onPosVal = onPos?.[i];

          rows.push({
            originalIndex: i,
            slotIndex,
            playerId,
            posLabel,
            rating,
            ratingNum: ratingNum == null ? -1 : ratingNum,
            name,
            rarity,
            definitionId,
            isSpecial,
            chemVal,
            onPosVal,
          });
        }

        const sortKey = String(setSolveOverlayState?.sortKey ?? "rating_desc");
        if (sortKey === "rating_desc") {
          rows.sort((a, b) => {
            if (b.ratingNum !== a.ratingNum) return b.ratingNum - a.ratingNum;
            const ap = String(a.posLabel ?? "");
            const bp = String(b.posLabel ?? "");
            const cmp = ap.localeCompare(bp);
            if (cmp) return cmp;
            return a.originalIndex - b.originalIndex;
          });
        } else {
          rows.sort((a, b) => a.originalIndex - b.originalIndex);
        }

        for (const rowData of rows) {
          const row = document.createElement("div");
          row.className = "ea-data-preview-row";
          if (rows.indexOf(rowData) % 2 === 1) {
            try {
              row.style.backgroundColor = "rgba(255, 255, 255, 0.02)";
            } catch {}
          }

          const posEl = document.createElement("div");
          posEl.className = "ea-data-preview-pos";
          posEl.textContent = String(rowData.posLabel ?? "Slot");

          const main = document.createElement("div");
          main.className = "ea-data-preview-main";
          const left = document.createElement("div");
          left.className = "ea-data-preview-left";

          const ratingEl = document.createElement("div");
          ratingEl.className = "ea-data-preview-rating";
          ratingEl.textContent = String(rowData.rating ?? "?");

          const nameEl = document.createElement("div");
          nameEl.className = "ea-data-preview-name";
          nameEl.textContent = String(rowData.name ?? "Unknown");

          const rarityEl = document.createElement("div");
          rarityEl.className = "ea-data-preview-rarity";
          rarityEl.textContent = rowData.rarity ? String(rowData.rarity) : "";

          left.append(ratingEl);
          left.append(nameEl);
          if (rowData.rarity) left.append(rarityEl);

          const right = document.createElement("div");
          right.className = "ea-data-preview-right";

          const idEl = document.createElement("div");
          idEl.className = "ea-data-preview-id";
          idEl.textContent =
            rowData.definitionId != null
              ? `def ${rowData.definitionId}`
              : rowData.playerId != null
                ? `id ${rowData.playerId}`
                : "";
          if (idEl.textContent) right.append(idEl);

          if (rowData.isSpecial) {
            const pill = document.createElement("span");
            pill.className = "ea-data-pill ea-data-pill--special";
            pill.textContent = "Special";
            right.append(pill);
          }
          if (rowData.onPosVal === false) {
            const pill = document.createElement("span");
            pill.className = "ea-data-pill ea-data-pill--warn";
            pill.textContent = "Off-pos";
            right.append(pill);
          } else if (rowData.chemVal != null) {
            const pill = document.createElement("span");
            pill.className = "ea-data-pill";
            pill.textContent = `Chem ${rowData.chemVal}`;
            right.append(pill);
          }

          main.append(left);
          main.append(right);
          row.append(posEl);
          row.append(main);
          playersWrap.append(row);
        }
        cardContainer.append(playersWrap);
      } else {
        const info = document.createElement("div");
        info.className = "ea-data-solutions-empty";
        info.textContent =
          entry?.reason ?? "No feasible squad with current player pool.";
        cardContainer.append(info);
      }

      listEl.append(cardContainer);

      try {
        let solvedCount = 0;
        let failedCount = 0;
        let submittedCount = 0;
        let usedPlayers = 0;
        let usedSpecial = 0;
        const ratingCounts = new Map();
        for (const item of entries) {
          if (item?.status === "solved") solvedCount += 1;
          else failedCount += 1;
          if (item?.submitState === "submitted") submittedCount += 1;
          const ids = Array.isArray(item?.solutionIds) ? item.solutionIds : [];
          for (const id of ids) {
            if (id == null) continue;
            usedPlayers += 1;
            const p = playerById ? playerById.get(String(id)) : null;
            const r = readNumeric(p?.rating);
            if (r != null) ratingCounts.set(r, (ratingCounts.get(r) || 0) + 1);
            if (p?.isSpecial) usedSpecial += 1;
          }
        }

        const summary = document.createElement("div");
        summary.className = "ea-data-used-summary";

        const top = document.createElement("div");
        top.className = "ea-data-used-summary-top";

        const titleEl = document.createElement("div");
        titleEl.className = "ea-data-used-summary-title";
        titleEl.textContent = "Set Summary";

        const topRight = document.createElement("div");
        topRight.className = "ea-data-preview-right";

        const allPill = document.createElement("span");
        allPill.className = "ea-data-pill";
        allPill.textContent = `Challenges ${entries.length}`;
        topRight.append(allPill);

        const solvedPill = document.createElement("span");
        solvedPill.className = solvedCount
          ? "ea-data-pill ea-data-pill--ok"
          : "ea-data-pill";
        solvedPill.textContent = `Solved ${solvedCount}`;
        topRight.append(solvedPill);

        const failedPill = document.createElement("span");
        failedPill.className = failedCount
          ? "ea-data-pill ea-data-pill--fail"
          : "ea-data-pill";
        failedPill.textContent = `Failed ${failedCount}`;
        topRight.append(failedPill);

        const submittedPill = document.createElement("span");
        submittedPill.className = submittedCount
          ? "ea-data-pill ea-data-pill--ok"
          : "ea-data-pill";
        submittedPill.textContent = `Submitted ${submittedCount}`;
        topRight.append(submittedPill);

        const specialPill = document.createElement("span");
        specialPill.className = usedSpecial
          ? "ea-data-pill ea-data-pill--special"
          : "ea-data-pill";
        specialPill.textContent = `Special ${usedSpecial}`;
        topRight.append(specialPill);

        top.append(titleEl);
        top.append(topRight);
        summary.append(top);

        const pills = document.createElement("div");
        pills.className = "ea-data-used-summary-pills";

        const playersPill = document.createElement("span");
        playersPill.className = "ea-data-pill";
        playersPill.textContent = `Players ${usedPlayers}`;
        pills.append(playersPill);

        const ratings = Array.from(ratingCounts.entries()).sort(
          ([a], [b]) => b - a,
        );
        if (!ratings.length) {
          const pill = document.createElement("span");
          pill.className = "ea-data-pill";
          pill.textContent = "Ratings n/a";
          pills.append(pill);
        } else {
          for (const [rating, count] of ratings) {
            const pill = document.createElement("span");
            pill.className = "ea-data-pill ea-data-pill--rating";
            pill.textContent = `${rating}x${count}`;
            pills.append(pill);
          }
        }

        summary.append(pills);
        listEl.append(summary);
      } catch {}
      renderSetSolveRightPanel({ reason: "entries-single" });
    };

    listEl?.addEventListener("click", (event) => {
      if (setSolveOverlayState?.running) return;
      const target = event?.target ?? null;
      const btn = target?.closest?.("button[data-action]") ?? null;
      if (!btn) return;
      const action = btn.getAttribute("data-action");
      if (action !== "prev" && action !== "next") return;

      const entries = Array.isArray(setSolveOverlayState?.entries)
        ? setSolveOverlayState.entries
        : [];
      const cycleResults = Array.isArray(setSolveOverlayState?.cycleResults)
        ? setSolveOverlayState.cycleResults
        : [];
      const isCombinedPreview =
        Boolean(setSolveOverlayState?.multiSetEnabled) &&
        cycleResults.length > 0;

      const workingSet = isCombinedPreview ? cycleResults : entries;
      if (!workingSet.length) return;

      const maxIndex = Math.max(0, workingSet.length - 1);
      const active =
        clampInt(setSolveOverlayState?.activeIndex ?? 0, 0, maxIndex) ?? 0;
      if (action === "prev") {
        setSolveOverlayState.activeIndex = Math.max(0, active - 1);
      } else {
        setSolveOverlayState.activeIndex = Math.min(maxIndex, active + 1);
      }
      renderEntries();
    });

    listEl?.addEventListener("change", (event) => {
      if (setSolveOverlayState?.running) return;
      const target = event?.target ?? null;
      const select = target?.closest?.('select[data-action="sort"]') ?? null;
      if (!select) return;
      setSolveOverlayState.sortKey = select.value ?? "rating_desc";
      renderEntries();
    });

    let ratingRangeCurrent = { ratingMin: 0, ratingMax: 99 };
    const syncRatingRange = (range, { source } = {}) => {
      const raw = range && typeof range === "object" ? range : {};
      let ratingMin = clampInt(
        raw.ratingMin ?? raw.min ?? raw.minRating ?? raw.min_rating,
        0,
        99,
      );
      let ratingMax = clampInt(
        raw.ratingMax ?? raw.max ?? raw.maxRating ?? raw.max_rating,
        0,
        99,
      );
      if (ratingMin == null) ratingMin = 0;
      if (ratingMax == null) ratingMax = 99;
      if (ratingMin > ratingMax) {
        if (source === "min") ratingMin = ratingMax;
        else if (source === "max") ratingMax = ratingMin;
        else {
          const tmp = ratingMin;
          ratingMin = ratingMax;
          ratingMax = tmp;
        }
      }
      try {
        ratingMinRange.value = String(ratingMin);
        ratingMaxRange.value = String(ratingMax);
      } catch {}
      try {
        ratingMinInput.value = String(ratingMin);
        ratingMaxInput.value = String(ratingMax);
      } catch {}
      const minPct = (ratingMin / 99) * 100;
      const maxPct = (ratingMax / 99) * 100;
      try {
        ratingRangeRoot?.style?.setProperty("--min-pct", `${minPct}%`);
        ratingRangeRoot?.style?.setProperty("--max-pct", `${maxPct}%`);
      } catch {}
      ratingRangeCurrent = { ratingMin, ratingMax };
      try {
        setSolveOverlayState.ratingRange = ratingRangeCurrent;
      } catch {}
    };

    const syncPoolSettings = (settings = {}) => {
      const current =
        setSolveOverlayState?.poolSettings &&
        typeof setSolveOverlayState.poolSettings === "object"
          ? setSolveOverlayState.poolSettings
          : getDefaultSolverPoolSettings();
      const poolSettings = toggleBinder.setValues(settings, current);
      try {
        setSolveOverlayState.poolSettings = poolSettings;
      } catch {}
      return poolSettings;
    };

    const getPoolSettingsFromInputs = () => {
      const current =
        setSolveOverlayState?.poolSettings &&
        typeof setSolveOverlayState.poolSettings === "object"
          ? setSolveOverlayState.poolSettings
          : getDefaultSolverPoolSettings();
      const poolSettings = toggleBinder.getValues(current);
      try {
        setSolveOverlayState.poolSettings = poolSettings;
      } catch {}
      return poolSettings;
    };

    const getSubmittableEntriesForCurrentMode = () => {
      const entries = Array.isArray(setSolveOverlayState?.entries)
        ? setSolveOverlayState.entries
        : [];
      const singleSolvedEntries = entries.filter(
        (entry) =>
          entry?.status === "solved" &&
          Array.isArray(entry?.solutionIds) &&
          entry.solutionIds.length > 0,
      );

      if (!setSolveOverlayState?.multiSetEnabled) {
        const cycleResults = Array.isArray(setSolveOverlayState?.cycleResults)
          ? setSolveOverlayState.cycleResults
          : [];
        const firstSolvedCycle = cycleResults.find((cycle) => {
          if (cycle?.status !== "solved") return false;
          const cycleEntries = Array.isArray(cycle?.entries)
            ? cycle.entries
            : [];
          return cycleEntries.every(
            (entry) =>
              entry?.status === "solved" &&
              Array.isArray(entry?.solutionIds) &&
              entry.solutionIds.length > 0,
          );
        });
        const singleCycleEntries = Array.isArray(firstSolvedCycle?.entries)
          ? firstSolvedCycle.entries
          : singleSolvedEntries;
        return {
          entries: singleCycleEntries,
          selectedCycles: [],
          requestedCycles: 1,
          availableCycles: singleCycleEntries.length ? 1 : 0,
          totalEntries: singleCycleEntries.length,
        };
      }

      const allCycles = Array.isArray(setSolveOverlayState?.cycleResults)
        ? setSolveOverlayState.cycleResults
        : [];
      const solvedCycles = allCycles.filter((cycle) => {
        if (cycle?.status !== "solved") return false;
        const cycleEntries = Array.isArray(cycle?.entries) ? cycle.entries : [];
        if (!cycleEntries.length) return false;
        return cycleEntries.every(
          (entry) =>
            entry?.status === "solved" &&
            Array.isArray(entry?.solutionIds) &&
            entry.solutionIds.length > 0,
        );
      });
      const availableCycles = solvedCycles.length;
      const repeatMax = clampInt(
        setSolveOverlayState?.repeatabilityMaxCycles ?? 1,
        1,
        50,
      );
      const cappedRepeatMax = repeatMax == null ? 1 : repeatMax;
      const requestedCycles = clampInt(
        setSolveOverlayState?.requestedSetCycles ?? 1,
        1,
        cappedRepeatMax,
      );
      const selectedCycleCount = Math.min(
        availableCycles,
        requestedCycles == null ? 1 : requestedCycles,
      );
      const selectedCycles =
        availableCycles > 0 ? solvedCycles.slice(0, selectedCycleCount) : [];
      const flattenedEntries = [];
      for (const cycle of selectedCycles) {
        const cycleEntries = Array.isArray(cycle?.entries) ? cycle.entries : [];
        for (const entry of cycleEntries) {
          flattenedEntries.push(entry);
        }
      }
      return {
        entries: flattenedEntries,
        selectedCycles,
        requestedCycles: requestedCycles == null ? 1 : requestedCycles,
        availableCycles,
        selectedCycleCount,
        totalEntries: flattenedEntries.length,
      };
    };

    const updateSetCycleMeta = () => {
      if (!setCyclesMetaEl) return;
      const repeatInfo = setSolveOverlayState?.repeatabilityInfo ?? null;
      const repeatMode = String(repeatInfo?.mode ?? "FINITE").toUpperCase();
      const repeatRemaining = readNumeric(repeatInfo?.remaining);
      const repeatMax = clampInt(
        setSolveOverlayState?.repeatabilityMaxCycles ?? 1,
        1,
        50,
      );
      const cappedRepeatMax = repeatMax == null ? 1 : repeatMax;
      const feasibleCount = clampInt(
        setSolveOverlayState?.maxFeasibleCycles ?? null,
        0,
        cappedRepeatMax,
      );
      const requestedCycles = clampInt(
        setSolveOverlayState?.requestedSetCycles ?? 1,
        1,
        cappedRepeatMax,
      );
      const attemptsLabel =
        repeatMode === "UNLIMITED"
          ? "unlimited"
          : repeatRemaining != null
            ? String(Math.max(0, repeatRemaining))
            : String(cappedRepeatMax);
      try {
        clearNode(setCyclesMetaEl);
        setCyclesMetaEl.className = "ea-data-used-summary-pills";
        setCyclesMetaEl.style.justifyContent = "center";
        setCyclesMetaEl.style.padding = "4px 0";

        const feasiblePill = document.createElement("span");
        feasiblePill.className = "ea-data-pill";
        feasiblePill.textContent =
          feasibleCount == null
            ? "Possible full set submissions: n/a"
            : `Possible full set submissions: ${feasibleCount}`;
        setCyclesMetaEl.append(feasiblePill);

        const attemptsPill = document.createElement("span");
        attemptsPill.className = "ea-data-pill";
        attemptsPill.textContent = `Attempts left: ${attemptsLabel}`;
        setCyclesMetaEl.append(attemptsPill);

        if (setSolveOverlayState?.multiSetEnabled) {
          const selectedLabel = String(
            requestedCycles == null ? 1 : requestedCycles,
          );
          const selectedPill = document.createElement("span");
          selectedPill.className = "ea-data-pill ea-data-pill--special";
          selectedPill.textContent = `Selected cycles: ${selectedLabel}`;
          setCyclesMetaEl.append(selectedPill);
        }
      } catch {}
    };

    const syncSetCycleControls = ({ source = "state" } = {}) => {
      const selectedIds = setSolveOverlayState?.selectedChallengeIds;
      const isPartialSelection = selectedIds != null;

      try {
        if (overlayTitle) {
          const baseName =
            setSolveOverlayState?.setName ??
            currentSbcSet?.name ??
            "Solve Entire Set";
          const totalCount = Array.isArray(
            setSolveOverlayState?.availableChallenges,
          )
            ? setSolveOverlayState.availableChallenges.length
            : 0;
          if (isPartialSelection && totalCount > 0) {
            overlayTitle.textContent = `${baseName} (${selectedIds.size}/${totalCount} selected)`;
          } else {
            overlayTitle.textContent = baseName;
          }
        }
      } catch {}

      try {
        if (multiSetToggleInput) {
          if (isPartialSelection) {
            multiSetToggleInput.checked = false;
            multiSetToggleInput.disabled = true;
            multiSetToggleInput.parentElement.parentElement.title =
              "Multi-cycle requires all challenges to be selected.";
          } else {
            multiSetToggleInput.parentElement.parentElement.title = "";
            if (!setSolveOverlayState?.running) {
              multiSetToggleInput.disabled = false;
            }
          }
        }
      } catch {}

      const enabled = Boolean(multiSetToggleInput?.checked);
      try {
        if (setCyclesWrap) setCyclesWrap.style.display = enabled ? "" : "none";
      } catch {}
      try {
        setSolveOverlayState.multiSetEnabled = enabled;
      } catch {}

      const repeatMax = clampInt(
        setSolveOverlayState?.repeatabilityMaxCycles ?? 1,
        1,
        50,
      );
      const cappedRepeatMax = repeatMax == null ? 1 : repeatMax;
      const feasible = clampInt(
        setSolveOverlayState?.maxFeasibleCycles ?? null,
        0,
        cappedRepeatMax,
      );
      const effectiveMax = cappedRepeatMax;
      const currentValue = readNumeric(setCyclesInput?.value);
      const requestedFromInputState = readNumeric(
        setSolveOverlayState?.requestedSetCyclesInput,
      );
      const requestedFromState =
        requestedFromInputState ??
        readNumeric(setSolveOverlayState?.requestedSetCycles);
      const preferredValue =
        source === "input"
          ? (currentValue ?? requestedFromState)
          : (requestedFromState ?? currentValue);
      const requestedValue = clampInt(preferredValue ?? 1, 1, effectiveMax);
      const finalRequested =
        requestedValue == null ? Math.min(1, effectiveMax) : requestedValue;

      try {
        if (setCyclesInput) {
          setCyclesInput.setAttribute("max", String(effectiveMax));
          setCyclesInput.value = String(finalRequested);
          if (!setSolveOverlayState?.running) {
            setCyclesInput.disabled = !enabled;
          }
        }
      } catch {}
      try {
        setSolveOverlayState.requestedSetCyclesInput = finalRequested;
      } catch {}
      try {
        setSolveOverlayState.requestedSetCycles = finalRequested;
      } catch {}
      updateSetCycleMeta();
      renderSetSolveRightPanel({ reason: "cycle-controls" });
    };

    const syncSetCycleRepeatability = (
      setId,
      { resetRequested = false } = {},
    ) => {
      const info = getSbcSetRepeatabilityInfo(setId, {
        unlimitedDefault: 50,
        clampMax: 50,
      });
      const nextMax = clampInt(info?.max ?? 1, 1, 50);
      const repeatabilityMax = nextMax == null ? 1 : nextMax;
      const recommended = clampInt(info?.recommended ?? 1, 1, repeatabilityMax);
      const nextRequested = Math.max(
        1,
        Math.min(3, recommended == null ? repeatabilityMax : recommended),
      );

      try {
        setSolveOverlayState.repeatabilityInfo = info;
        setSolveOverlayState.repeatabilityMaxCycles = repeatabilityMax;
        setSolveOverlayState.repeatabilityRemaining = readNumeric(
          info?.remaining,
        );
        const requestedInput = readNumeric(
          setSolveOverlayState?.requestedSetCyclesInput,
        );
        const nextRequestedInput =
          resetRequested || requestedInput == null
            ? nextRequested
            : requestedInput;
        setSolveOverlayState.requestedSetCyclesInput =
          nextRequestedInput == null ? 1 : nextRequestedInput;
        setSolveOverlayState.requestedSetCycles =
          clampInt(
            setSolveOverlayState.requestedSetCyclesInput,
            1,
            repeatabilityMax,
          ) ?? 1;
        const currentFeasible = readNumeric(
          setSolveOverlayState?.maxFeasibleCycles,
        );
        if (currentFeasible != null) {
          setSolveOverlayState.maxFeasibleCycles = Math.max(
            0,
            Math.min(repeatabilityMax, Math.floor(currentFeasible)),
          );
        }
      } catch {}
      syncSetCycleControls();
      return info;
    };

    const setRunning = (running, { mode } = {}) => {
      const isRunning = Boolean(running);
      setSolveOverlayState.running = isRunning;
      setSolveOverlayState.mode = isRunning
        ? String(mode ?? "running")
        : "idle";
      try {
        closeBtn.disabled = isRunning;
        cancelBtn.disabled = isRunning;
      } catch {}
      try {
        if (isRunning) {
          generateBtn.disabled = true;
          startBtn.disabled = true;
          stopBtn.style.display = "";
          stopBtn.disabled = Boolean(setSolveOverlayState.abortRequested);
          stopBtn.textContent = setSolveOverlayState.abortRequested
            ? "Stopping..."
            : "Stop";
          ratingRangeRoot?.classList?.add?.("ea-data-range--locked");
          if (ratingMinInput) ratingMinInput.disabled = true;
          if (ratingMaxInput) ratingMaxInput.disabled = true;
          if (multiSetToggleInput) multiSetToggleInput.disabled = true;
          if (setCyclesInput) setCyclesInput.disabled = true;
          toggleBinder.setDisabled(true);
          try {
            for (const btn of modal?.querySelectorAll?.(
              ".ea-data-times-stepper__btn",
            ) ?? []) {
              btn.disabled = true;
            }
          } catch {}
          generateBtn.textContent =
            setSolveOverlayState.mode === "generating"
              ? "Working..."
              : "Fetch Solutions";
          startBtn.textContent =
            setSolveOverlayState.mode === "submitting"
              ? "Submitting..."
              : "Start Submitting";
        } else {
          generateBtn.disabled = false;
          const submissionState = getSubmittableEntriesForCurrentMode();
          startBtn.disabled = (submissionState?.totalEntries ?? 0) <= 0;
          stopBtn.style.display = "none";
          stopBtn.disabled = false;
          stopBtn.textContent = "Stop";
          ratingRangeRoot?.classList?.remove?.("ea-data-range--locked");
          if (ratingMinInput) ratingMinInput.disabled = false;
          if (ratingMaxInput) ratingMaxInput.disabled = false;
          if (multiSetToggleInput) multiSetToggleInput.disabled = false;
          if (setCyclesInput) {
            setCyclesInput.disabled = !Boolean(
              setSolveOverlayState?.multiSetEnabled,
            );
          }
          toggleBinder.setDisabled(false);
          try {
            for (const btn of modal?.querySelectorAll?.(
              ".ea-data-times-stepper__btn",
            ) ?? []) {
              btn.disabled = false;
            }
          } catch {}
          generateBtn.textContent = "Fetch Solutions";
          startBtn.textContent = "Start Submitting";
        }
      } catch {}
      syncSetCycleControls();
      renderEntries();
    };

    const reset = ({ preserveConfig = false } = {}) => {
      setSolveOverlayState.entries = [];
      setSolveOverlayState.cycleResults = [];
      setSolveOverlayState.playerById = null;
      setSolveOverlayState.activeIndex = 0;
      setSolveOverlayState.sortKey = "rating_desc";
      setSolveOverlayState.maxFeasibleCycles = null;
      setSolveOverlayState.generationStopReason = null;
      setSolveOverlayState.latestFailureContext = null;
      try {
        setSolveOverlayState.failureByChallengeId?.clear?.();
      } catch {}
      setSolveOverlayState.abortRequested = false;
      if (!preserveConfig) {
        try {
          if (multiSetToggleInput) multiSetToggleInput.checked = false;
        } catch {}
        try {
          setSolveOverlayState.multiSetEnabled = false;
        } catch {}
        try {
          setSolveOverlayState.requestedSetCyclesInput = 1;
          setSolveOverlayState.requestedSetCycles = 1;
        } catch {}
      }
      setRunning(false);
      setStatus("");
      setProgress(null, null);
      syncSetCycleControls();
      renderEntries();
    };

    const resetForChallenge = (challengeId, setId, setName = null) => {
      if (setSolveOverlayState?.running) return;
      const challengeKey = challengeId == null ? null : String(challengeId);
      const setKey = setId == null ? null : String(setId);
      if (
        setSolveOverlayState?.challengeId === challengeKey &&
        setSolveOverlayState?.setId === setKey
      ) {
        if (setName) setSolveOverlayState.setName = String(setName);
        renderSetSolveRightPanel({ reason: "context-unchanged" });
        return;
      }
      reset();
      setSolveOverlayState.challengeId = challengeKey;
      setSolveOverlayState.setId = setKey;
      setSolveOverlayState.setName = setName == null ? null : String(setName);
      setSolveOverlayState.maxFeasibleCycles = null;
      ensureSetSolveRightPanelState();
      try {
        setSolveOverlayState.requirementsLoadToken += 1;
      } catch {}
      try {
        setSolveOverlayState.rightPanelLastSetId = setKey;
      } catch {}
      try {
        setSolveOverlayState.requirementsByChallengeId?.clear?.();
      } catch {}
      try {
        setSolveOverlayState.requirementsInFlight?.clear?.();
      } catch {}
      renderSetSolveRightPanel({ reason: "context-reset" });
      try {
        syncRatingRange({ ratingMin: 0, ratingMax: 99 }, { source: "init" });
        syncPoolSettings(getDefaultSolverSettings());
        syncSetCycleRepeatability(setId, { resetRequested: true });

        // Trigger a fresh challenge fetch for the picker UI when context changes
        if (setSolveOverlayState?.populatePicker) {
          setSolveOverlayState.populatePicker(setId);
        }
      } catch {}
    };

    const getSortedSetChallenges = async (setId) => {
      const normalizedSetId = readNumeric(setId);
      if (normalizedSetId == null) return [];
      const cached = getPrefetchedSetChallenges(normalizedSetId);
      if (Array.isArray(cached) && cached.length) return cached;
      void prefetchSetChallengeInfo(normalizedSetId, {
        reason: "set-solver-fetch",
      }).catch(() => {});
      const raw = await getChallengesBySetIdsRaw([normalizedSetId]);
      const sorted = sortSetChallengesForSolver(raw);
      upsertPrefetchedSetChallenges(normalizedSetId, sorted);
      return sorted;
    };

    const generateSetSolutions = async () => {
      if (setSolveOverlayState?.running) return;
      const startedChallengeId =
        readNumeric(setSolveOverlayState?.challengeId) ??
        readNumeric(currentChallenge?.id) ??
        null;
      const startedSetId =
        readNumeric(setSolveOverlayState?.setId) ??
        readNumeric(currentSbcSet?.id) ??
        readNumeric(currentChallenge?.setId) ??
        null;
      if (startedSetId == null) return;
      if (!isGroupSbcSet(startedSetId)) {
        showToast({
          type: "error",
          title: "Set Solve Unavailable",
          message: "This is not a group SBC set.",
          timeoutMs: 9000,
        });
        return;
      }

      reset({ preserveConfig: true });
      setSolveOverlayState.challengeId =
        startedChallengeId == null ? null : String(startedChallengeId);
      setSolveOverlayState.setId = String(startedSetId);
      if (!setSolveOverlayState.setName) {
        setSolveOverlayState.setName =
          currentSbcSet?.name ?? currentChallenge?.set?.name ?? null;
      }
      syncSetCycleRepeatability(startedSetId, { resetRequested: false });
      ensureSetSolveRightPanelState();
      try {
        setSolveOverlayState.failureByChallengeId?.clear?.();
      } catch {}
      setSolveOverlayState.latestFailureContext = null;
      setSolveOverlayState.generationStopReason = null;
      setSolveOverlayState.abortRequested = false;
      setRunning(true, { mode: "generating" });
      setStatus("Preparing solver...");
      let automationEntered = false;
      try {
        enterSbcAutomation();
        automationEntered = true;
        const bridgeReady = await initSolverBridge();
        if (!bridgeReady) {
          showToast({
            type: "error",
            title: "Solver Not Ready",
            message: "Reload and try again.",
            timeoutMs: 9000,
          });
          return;
        }

        setStatus("Fetching players...");
        const payload = await window.eaData.getSolverPayload({
          ignoreLoaned: true,
        });

        const hasSetChanged = () => {
          const visibleSetId =
            readNumeric(currentChallenge?.setId) ??
            readNumeric(currentSbcSet?.id);
          if (visibleSetId == null) return false;
          return Number(visibleSetId) !== Number(startedSetId);
        };

        if (hasSetChanged()) {
          setStatus("");
          return;
        }

        let settings = null;
        try {
          settings = await getSolverSettingsForChallenge(startedChallengeId);
        } catch {
          settings = getDefaultSolverSettings();
        }
        const effectiveSettings = {
          ...settings,
          ratingRange: ratingRangeCurrent,
          ...getPoolSettingsFromInputs(),
        };

        const allPlayers = Array.isArray(payload?.players)
          ? payload.players
          : [];
        const { filteredPlayers, poolFilters } =
          filterPlayersBySolverPoolSettings(allPlayers, effectiveSettings);
        const playerById = new Map(
          filteredPlayers
            .map((player) => [
              player?.id != null ? String(player.id) : null,
              player,
            ])
            .filter(([k]) => k != null),
        );
        setSolveOverlayState.playerById = playerById;
        const baseFilters =
          payload?.filters && typeof payload.filters === "object"
            ? payload.filters
            : {};
        const mergedFilters = {
          ...baseFilters,
          ...poolFilters,
        };
        const baseUsed = new Set(
          (mergedFilters?.excludedPlayerIds ?? [])
            .map((value) => (value == null ? null : String(value)))
            .filter(Boolean),
        );

        const challenges = await getSortedSetChallenges(startedSetId);
        if (!challenges.length) {
          setStatus("No remaining challenges in this set.");
          return;
        }

        const selectedIds = setSolveOverlayState?.selectedChallengeIds;
        const filteredChallenges =
          selectedIds == null
            ? challenges
            : challenges.filter((c) => selectedIds.has(String(c?.id)));

        if (!filteredChallenges.length) {
          setStatus("No challenges selected to solve.");
          return;
        }
        const multiSetEnabled = Boolean(multiSetToggleInput?.checked);
        setSolveOverlayState.multiSetEnabled = multiSetEnabled;
        const repeatInfo = syncSetCycleRepeatability(startedSetId, {
          resetRequested: false,
        });
        const repeatMax = clampInt(repeatInfo?.max ?? 1, 1, 50) ?? 1;

        const buildFailureMeta = ({
          source = "solver",
          reason = null,
          challenge = null,
          challengeName = null,
          cycleIndex = null,
          failingRequirements = [],
          stats = null,
        } = {}) => {
          const resolvedChallengeName =
            challengeName ??
            challenge?.name ??
            challenge?.title ??
            `Challenge ${challenge?.id ?? "?"}`;
          const resolvedReason =
            reason ?? "No feasible squad with current player pool.";
          return {
            source,
            reason: resolvedReason,
            challengeId: challenge?.id ?? null,
            challengeName: resolvedChallengeName,
            cycleIndex: readNumeric(cycleIndex),
            failingRequirements: Array.isArray(failingRequirements)
              ? failingRequirements
              : [],
            stats: stats ?? null,
            at: Date.now(),
          };
        };

        const recordFailureMeta = (failureMeta) => {
          if (!failureMeta || typeof failureMeta !== "object") return;
          ensureSetSolveRightPanelState();
          const challengeId =
            failureMeta?.challengeId == null
              ? null
              : String(failureMeta.challengeId);
          if (challengeId) {
            const currentList = Array.isArray(
              setSolveOverlayState?.failureByChallengeId?.get?.(challengeId),
            )
              ? setSolveOverlayState.failureByChallengeId.get(challengeId)
              : [];
            const nextList = currentList.concat(failureMeta).slice(-30);
            setSolveOverlayState.failureByChallengeId.set(challengeId, nextList);
          }
          setSolveOverlayState.latestFailureContext = {
            source: failureMeta?.source ?? "solver",
            reason: failureMeta?.reason ?? null,
            challengeId,
            challengeName: failureMeta?.challengeName ?? null,
            cycleIndex: readNumeric(failureMeta?.cycleIndex),
            at: readNumeric(failureMeta?.at) ?? Date.now(),
          };
        };

        const collectPoolConflictFailureRequirements = (
          conflict,
          requirementsNormalized,
        ) => {
          const rules = Array.isArray(requirementsNormalized)
            ? requirementsNormalized
            : [];
          if (!conflict?.hasConflict || !rules.length) return [];
          const leagueIds = new Set(
            (conflict?.conflictingLeagueIds ?? []).map((value) =>
              String(value),
            ),
          );
          const nationIds = new Set(
            (conflict?.conflictingNationIds ?? []).map((value) =>
              String(value),
            ),
          );
          const matched = [];
          for (const rule of rules) {
            if (!rule || typeof rule !== "object") continue;
            const typeHint = String(
              rule?.type ?? rule?.keyNameNormalized ?? "",
            ).toLowerCase();
            const labelHint = String(rule?.label ?? "").toLowerCase();
            if (leagueIds.size > 0) {
              const hasLeagueSignal =
                typeHint.includes("league") || labelHint.includes("league");
              if (hasLeagueSignal) {
                const ids = extractLeagueIdsFromRequirementValue(rule?.value);
                if (ids.some((value) => leagueIds.has(String(value)))) {
                  matched.push(rule);
                  continue;
                }
              }
            }
            if (nationIds.size > 0) {
              const hasNationSignal =
                typeHint.includes("nation") ||
                typeHint.includes("country") ||
                labelHint.includes("nation") ||
                labelHint.includes("country");
              if (hasNationSignal) {
                const ids = extractNationIdsFromRequirementValue(rule?.value);
                if (ids.some((value) => nationIds.has(String(value)))) {
                  matched.push(rule);
                  continue;
                }
              }
            }
          }
          return matched;
        };

        const makeEntryFromFailure = ({
          challenge = null,
          challengeName = null,
          reason = null,
          slotInfo = null,
          stats = null,
          failureMeta = null,
        } = {}) => ({
          challengeId: challenge?.id ?? null,
          challengeName:
            challengeName ??
            challenge?.name ??
            challenge?.title ??
            `Challenge ${challenge?.id ?? "?"}`,
          status: "failed",
          reason: reason ?? "No feasible squad with current player pool.",
          solutionIds: [],
          slotSolution: null,
          slotIndexToPositionName: slotInfo?.slotIndexToPositionName ?? null,
          requiredPlayers: slotInfo?.requiredPlayers ?? null,
          specialCount: 0,
          stats: stats ?? null,
          failureMeta: failureMeta ?? null,
          submitState: null,
        });

        if (!multiSetEnabled) {
          setProgress(0, filteredChallenges.length);
          const entries = [];
          const used = new Set(baseUsed);

          for (let i = 0; i < filteredChallenges.length; i += 1) {
            if (setSolveOverlayState.abortRequested) break;
            if (hasSetChanged()) throw new Error("Set changed");
            const challenge = filteredChallenges[i];
            const challengeName =
              challenge?.name ??
              challenge?.title ??
              `Challenge ${challenge?.id ?? i + 1}`;
            setStatus(
              `(${i + 1}/${filteredChallenges.length}) Solving ${challengeName}...`,
            );
            setProgress(i, filteredChallenges.length);
            const loaded = await loadChallenge(challenge, true, {
              force: true,
            });
            const snapshot = buildRequirementsSnapshot(
              challenge,
              loaded?.data ?? loaded,
            );
            const slotInfo = buildChallengeSlotsForSolver(
              challenge,
              loaded?.data ?? loaded,
            );
            const safeRequirements = (snapshot?.requirements ?? []).map(
              serializeRequirementForSolver,
            );
            const safeRequirementsNormalized = (
              snapshot?.requirementsNormalized ?? []
            ).map(serializeNormalizedRequirementForSolver);
            if (
              !Array.isArray(slotInfo?.squadSlots) ||
              !slotInfo.squadSlots.length
            ) {
              const failureMeta = buildFailureMeta({
                source: "slot-unavailable",
                challenge,
                challengeName,
                reason: "Challenge slots unavailable.",
              });
              recordFailureMeta(failureMeta);
              entries.push(
                makeEntryFromFailure({
                  challenge,
                  challengeName,
                  reason: "Challenge slots unavailable.",
                  slotInfo,
                  failureMeta,
                }),
              );
              setSolveOverlayState.entries = entries;
              renderEntries();
              setProgress(i + 1, filteredChallenges.length);
              continue;
            }

            const poolConflict = buildSolverPoolExclusionConflict({
              settings: effectiveSettings,
              requirementsNormalized: safeRequirementsNormalized,
              squadSlots: slotInfo?.squadSlots ?? [],
            });
            if (poolConflict?.hasConflict) {
              const notice = buildSolverPoolConflictNotice(poolConflict, {
                challengeName,
              });
              const reason =
                notice?.reason ??
                "Current exclusions conflict with challenge requirements.";
              const conflictRules = collectPoolConflictFailureRequirements(
                poolConflict,
                safeRequirementsNormalized,
              );
              const failureMeta = buildFailureMeta({
                source: "pool-conflict",
                challenge,
                challengeName,
                reason,
                failingRequirements: conflictRules,
              });
              recordFailureMeta(failureMeta);
              entries.push(
                makeEntryFromFailure({
                  challenge,
                  challengeName,
                  reason,
                  slotInfo,
                  failureMeta,
                }),
              );
              setSolveOverlayState.entries = entries;
              renderEntries();
              setProgress(i + 1, filteredChallenges.length);
              showToast({
                type: "error",
                title: notice?.title ?? "Pool Exclusion Conflict",
                message:
                  notice?.message ??
                  `${challengeName}: exclusions conflict with requirements.`,
                timeoutMs: 7000,
              });
              continue;
            }

            const result = await callSolverBridge(
              "SOLVE",
              {
                players: filteredPlayers,
                requirements: safeRequirements,
                requirementsNormalized: safeRequirementsNormalized,
                requiredPlayers: slotInfo.requiredPlayers ?? null,
                squadSlots: slotInfo.squadSlots,
                prioritize: payload?.prioritize,
                filters: {
                  ...mergedFilters,
                  excludedPlayerIds: Array.from(used),
                },
                debug: debugEnabled,
              },
              SOLVER_BRIDGE_TIMEOUT_MS,
            );
            logSolverDebugResult("set-generate", result, {
              setId: startedSetId,
              challengeId: challenge?.id ?? null,
              challengeName,
              iteration: i + 1,
              total: filteredChallenges.length,
            });

            if (result?.solutions?.length) {
              const solutionIds = result.solutions[0] ?? [];
              for (const id of solutionIds) {
                if (id == null) continue;
                used.add(String(id));
              }
              let specialCount = 0;
              for (const id of solutionIds) {
                if (id == null) continue;
                if (playerById?.get?.(String(id))?.isSpecial) specialCount += 1;
              }
              entries.push({
                challengeId: challenge?.id ?? null,
                challengeName,
                status: "solved",
                reason: null,
                solutionIds,
                slotSolution: result?.solutionSlots?.[0] ?? null,
                slotIndexToPositionName:
                  slotInfo?.slotIndexToPositionName ?? null,
                requiredPlayers: slotInfo?.requiredPlayers ?? null,
                specialCount,
                stats: result?.stats ?? null,
                submitState: null,
              });
            } else {
              const failing = Array.isArray(result?.failingRequirements)
                ? result.failingRequirements
                : [];
              const first = failing[0] ?? null;
              const failureReason =
                first?.label ??
                first?.type ??
                first?.keyNameNormalized ??
                "No feasible squad with current player pool.";
              const failureMeta = buildFailureMeta({
                source: "solver",
                challenge,
                challengeName,
                reason: failureReason,
                failingRequirements: failing,
                stats: result?.stats ?? null,
              });
              recordFailureMeta(failureMeta);
              entries.push(
                makeEntryFromFailure({
                  challenge,
                  challengeName,
                  reason: failureReason,
                  slotInfo,
                  stats: result?.stats ?? null,
                  failureMeta,
                }),
              );
            }
            setSolveOverlayState.entries = entries;
            renderEntries();
            setProgress(i + 1, filteredChallenges.length);
          }

          const solvedCount = entries.filter(
            (entry) => entry.status === "solved",
          ).length;
          const failedCount = entries.length - solvedCount;
          const fullSetSolved =
            entries.length > 0 &&
            entries.every((entry) => entry?.status === "solved");
          setSolveOverlayState.cycleResults = [];
          setSolveOverlayState.maxFeasibleCycles = fullSetSolved ? 1 : 0;
          syncSetCycleControls();

          if (setSolveOverlayState.abortRequested) {
            setStatus(`Stopped. Solved ${solvedCount}, failed ${failedCount}.`);
            showToast({
              type: "info",
              title: "Set Solve Stopped",
              message: `${solvedCount} solved, ${failedCount} failed.`,
              timeoutMs: 6500,
            });
          } else {
            setStatus(`${solvedCount} solved, ${failedCount} failed.`);
            showToast({
              type: solvedCount > 0 ? "success" : "error",
              title:
                solvedCount > 0 ? "Set Solutions Ready" : "No Set Solutions",
              message: `${solvedCount} solved, ${failedCount} failed.`,
              timeoutMs: 6500,
            });
          }
          return;
        }

        const requestedCycles = Math.max(
          1,
          readNumeric(setSolveOverlayState.requestedSetCycles) ?? 1,
        );
        const targetCycles = Math.min(repeatMax, requestedCycles);
        const totalWork = Math.max(1, targetCycles * filteredChallenges.length);
        let completedWork = 0;
        setProgress(0, totalWork);
        const cycleResults = [];
        const usedAcrossCycles = new Set(baseUsed);

        for (let cycle = 0; cycle < targetCycles; cycle += 1) {
          if (setSolveOverlayState.abortRequested) break;
          if (hasSetChanged()) throw new Error("Set changed");

          const cycleIndex = cycle + 1;
          const workingUsed = new Set(usedAcrossCycles);
          const cycleEntries = [];
          let discardedReason = null;

          for (let i = 0; i < filteredChallenges.length; i += 1) {
            if (setSolveOverlayState.abortRequested) break;
            if (hasSetChanged()) throw new Error("Set changed");
            const challenge = filteredChallenges[i];
            const challengeName =
              challenge?.name ??
              challenge?.title ??
              `Challenge ${challenge?.id ?? i + 1}`;
            setStatus(
              `(Cycle ${cycleIndex}/${targetCycles}) (${i + 1}/${filteredChallenges.length}) Solving ${challengeName}...`,
            );
            setProgress(completedWork, totalWork);

            const loaded = await loadChallenge(challenge, true, {
              force: true,
            });
            const snapshot = buildRequirementsSnapshot(
              challenge,
              loaded?.data ?? loaded,
            );
            const slotInfo = buildChallengeSlotsForSolver(
              challenge,
              loaded?.data ?? loaded,
            );
            const safeRequirements = (snapshot?.requirements ?? []).map(
              serializeRequirementForSolver,
            );
            const safeRequirementsNormalized = (
              snapshot?.requirementsNormalized ?? []
            ).map(serializeNormalizedRequirementForSolver);

            if (
              !Array.isArray(slotInfo?.squadSlots) ||
              !slotInfo.squadSlots.length
            ) {
              discardedReason = "Challenge slots unavailable.";
              const failureMeta = buildFailureMeta({
                source: "slot-unavailable",
                challenge,
                challengeName,
                cycleIndex,
                reason: discardedReason,
              });
              recordFailureMeta(failureMeta);
              cycleEntries.push(
                makeEntryFromFailure({
                  challenge,
                  challengeName,
                  reason: discardedReason,
                  slotInfo,
                  failureMeta,
                }),
              );
              completedWork += 1;
              setProgress(completedWork, totalWork);
              break;
            }

            const poolConflict = buildSolverPoolExclusionConflict({
              settings: effectiveSettings,
              requirementsNormalized: safeRequirementsNormalized,
              squadSlots: slotInfo?.squadSlots ?? [],
            });
            if (poolConflict?.hasConflict) {
              const notice = buildSolverPoolConflictNotice(poolConflict, {
                challengeName,
              });
              discardedReason =
                notice?.reason ??
                "Current exclusions conflict with challenge requirements.";
              const conflictRules = collectPoolConflictFailureRequirements(
                poolConflict,
                safeRequirementsNormalized,
              );
              const failureMeta = buildFailureMeta({
                source: "pool-conflict",
                challenge,
                challengeName,
                cycleIndex,
                reason: discardedReason,
                failingRequirements: conflictRules,
              });
              recordFailureMeta(failureMeta);
              cycleEntries.push(
                makeEntryFromFailure({
                  challenge,
                  challengeName,
                  reason: discardedReason,
                  slotInfo,
                  failureMeta,
                }),
              );
              showToast({
                type: "error",
                title: notice?.title ?? "Pool Exclusion Conflict",
                message:
                  notice?.message ??
                  `${challengeName}: exclusions conflict with requirements.`,
                timeoutMs: 7000,
              });
              completedWork += 1;
              setProgress(completedWork, totalWork);
              break;
            }

            const result = await callSolverBridge(
              "SOLVE",
              {
                players: filteredPlayers,
                requirements: safeRequirements,
                requirementsNormalized: safeRequirementsNormalized,
                requiredPlayers: slotInfo.requiredPlayers ?? null,
                squadSlots: slotInfo.squadSlots,
                prioritize: payload?.prioritize,
                filters: {
                  ...mergedFilters,
                  excludedPlayerIds: Array.from(workingUsed),
                },
                debug: debugEnabled,
              },
              SOLVER_BRIDGE_TIMEOUT_MS,
            );
            logSolverDebugResult("set-cycle-generate", result, {
              setId: startedSetId,
              challengeId: challenge?.id ?? null,
              challengeName,
              cycle: cycleIndex,
              cycleTarget: targetCycles,
              challengeIndex: i + 1,
              challengeTotal: filteredChallenges.length,
            });

            if (!result?.solutions?.length) {
              const failing = Array.isArray(result?.failingRequirements)
                ? result.failingRequirements
                : [];
              const first = failing[0] ?? null;
              discardedReason =
                first?.label ??
                first?.type ??
                first?.keyNameNormalized ??
                "No feasible squad with current player pool.";
              const failureMeta = buildFailureMeta({
                source: "solver",
                challenge,
                challengeName,
                cycleIndex,
                reason: discardedReason,
                failingRequirements: failing,
                stats: result?.stats ?? null,
              });
              recordFailureMeta(failureMeta);
              cycleEntries.push(
                makeEntryFromFailure({
                  challenge,
                  challengeName,
                  reason: discardedReason,
                  slotInfo,
                  stats: result?.stats ?? null,
                  failureMeta,
                }),
              );
              completedWork += 1;
              setProgress(completedWork, totalWork);
              break;
            }

            const solutionIds = result.solutions[0] ?? [];
            for (const id of solutionIds) {
              if (id == null) continue;
              workingUsed.add(String(id));
            }
            let specialCount = 0;
            for (const id of solutionIds) {
              if (id == null) continue;
              if (playerById?.get?.(String(id))?.isSpecial) specialCount += 1;
            }
            cycleEntries.push({
              challengeId: challenge?.id ?? null,
              challengeName,
              status: "solved",
              reason: null,
              solutionIds,
              slotSolution: result?.solutionSlots?.[0] ?? null,
              slotIndexToPositionName:
                slotInfo?.slotIndexToPositionName ?? null,
              requiredPlayers: slotInfo?.requiredPlayers ?? null,
              specialCount,
              stats: result?.stats ?? null,
              submitState: null,
            });
            completedWork += 1;
            setProgress(completedWork, totalWork);
          }

          const cycleSolved =
            !discardedReason &&
            cycleEntries.length === filteredChallenges.length &&
            cycleEntries.every((entry) => entry?.status === "solved");

          if (cycleSolved) {
            for (const value of Array.from(workingUsed)) {
              usedAcrossCycles.add(value);
            }
            cycleResults.push({
              cycleIndex,
              status: "solved",
              reason: null,
              entries: cycleEntries,
              submitState: null,
            });
          } else {
            const resolvedDiscardReason =
              discardedReason ??
              "Cycle discarded because one or more challenges failed.";
            cycleResults.push({
              cycleIndex,
              status: "discarded",
              reason: resolvedDiscardReason,
              entries: cycleEntries,
              submitState: null,
            });
            if (!setSolveOverlayState.abortRequested) {
              const failedEntry = cycleEntries.find(
                (entry) => entry?.status !== "solved",
              );
              const failedName = sanitizeDisplayText(
                failedEntry?.challengeName,
              );
              const prefix = failedName
                ? `Cycle ${cycleIndex} stopped at ${failedName}`
                : `Cycle ${cycleIndex} stopped`;
              setSolveOverlayState.generationStopReason = `${prefix}: ${resolvedDiscardReason} Later cycles were skipped due to pool depletion.`;
            }
            // Monotonic pool assumption: once a cycle fails with depleted pool,
            // later cycles will not improve.
            break;
          }

          setSolveOverlayState.cycleResults = cycleResults;
          setSolveOverlayState.entries = cycleResults
            .filter((item) => item?.status === "solved")
            .flatMap((item) =>
              Array.isArray(item?.entries) ? item.entries : [],
            );
          setSolveOverlayState.maxFeasibleCycles = cycleResults.filter(
            (item) => item?.status === "solved",
          ).length;
          syncSetCycleControls();
          renderEntries();
        }

        const solvedCycles = cycleResults.filter(
          (item) => item?.status === "solved",
        ).length;
        setSolveOverlayState.cycleResults = cycleResults;
        setSolveOverlayState.entries = cycleResults
          .filter((item) => item?.status === "solved")
          .flatMap((item) =>
            Array.isArray(item?.entries) ? item.entries : [],
          );
        setSolveOverlayState.maxFeasibleCycles = solvedCycles;
        syncSetCycleControls();
        renderEntries();

        if (setSolveOverlayState.abortRequested) {
          setStatus(`Stopped.`);
          showToast({
            type: "info",
            title: "Set Solve Stopped",
            message: `Found ${solvedCycles} full set cycle(s).`,
            timeoutMs: 6500,
          });
        } else if (solvedCycles > 0) {
          setStatus(`Generation complete.`);
          showToast({
            type: "success",
            title: "Set Cycles Ready",
            message: `Found ${solvedCycles} full set cycle(s).`,
            timeoutMs: 6500,
          });
        } else {
          setStatus("No solutions possible.");
          showToast({
            type: "error",
            title: "No Full Set Cycles",
            message: "At least one challenge failed in the first cycle.",
            timeoutMs: 7000,
          });
        }
      } catch (error) {
        log("debug", "[EA Data] Set solve generation failed", error);
        const errorReason = String(error?.message || "Generation failed.");
        setSolveOverlayState.latestFailureContext = {
          source: "system",
          reason: errorReason,
          challengeId: null,
          challengeName: null,
          cycleIndex: null,
          at: Date.now(),
        };
        setSolveOverlayState.generationStopReason = errorReason;
        setStatus(
          error?.message
            ? `Error: ${error.message}`
            : "Error: Generation failed.",
        );
        showToast({
          type: "error",
          title: "Set Solve Failed",
          message: error?.message || "Generation failed.",
          timeoutMs: 9000,
        });
      } finally {
        if (automationEntered) exitSbcAutomation();
        setRunning(false);
        setProgress(null, null);
      }
    };

    const startSubmitting = async () => {
      if (setSolveOverlayState?.running) return;
      const startedChallengeId =
        readNumeric(setSolveOverlayState?.challengeId) ??
        readNumeric(currentChallenge?.id) ??
        null;
      const startedSetId =
        readNumeric(setSolveOverlayState?.setId) ??
        readNumeric(currentSbcSet?.id) ??
        readNumeric(currentChallenge?.setId) ??
        null;
      if (startedSetId == null) return;
      const multiSetEnabled = Boolean(setSolveOverlayState?.multiSetEnabled);
      const submissionPlan = getSubmittableEntriesForCurrentMode();
      const solvedEntries = Array.isArray(submissionPlan?.entries)
        ? submissionPlan.entries
        : [];
      const requestedCycles = clampInt(
        submissionPlan?.requestedCycles ?? 1,
        1,
        50,
      );
      const availableCycles = clampInt(
        submissionPlan?.availableCycles ?? 0,
        0,
        50,
      );
      if (!solvedEntries.length) {
        showToast({
          type: "error",
          title: "No Set Solutions",
          message: "Fetch solutions first.",
          timeoutMs: 6500,
        });
        return;
      }
      if (
        multiSetEnabled &&
        requestedCycles != null &&
        availableCycles != null &&
        requestedCycles > availableCycles
      ) {
        showToast({
          type: "info",
          title: "Limited by Feasibility",
          message: `Requested ${requestedCycles} cycle(s), but only ${availableCycles} full cycle(s) are feasible. Submitting feasible cycles only.`,
          timeoutMs: 7000,
        });
      }

      setSolveOverlayState.abortRequested = false;
      setRunning(true, { mode: "submitting" });
      setStatus(`Submitting 0 / ${solvedEntries.length}...`);
      setProgress(0, solvedEntries.length);
      let submitted = 0;
      let submittedCycles = 0;
      let completedWithoutError = false;
      let shouldExitSetView = false;
      enterSbcAutomation();
      try {
        const setEntity = await ensureSbcSetById(startedSetId);
        if (!setEntity) throw new Error("SBC set not found");
        if (!services?.SBC?.requestChallengesForSet) {
          throw new Error("services.SBC.requestChallengesForSet unavailable");
        }

        const hasSetChanged = () => {
          const visibleSetId =
            readNumeric(currentChallenge?.setId) ??
            readNumeric(currentSbcSet?.id);
          if (visibleSetId == null) return false;
          return Number(visibleSetId) !== Number(startedSetId);
        };

        const cycleBatches = multiSetEnabled
          ? (Array.isArray(submissionPlan?.selectedCycles)
              ? submissionPlan.selectedCycles
              : []
            ).map((cycle, index) => ({
              cycle,
              cycleIndex: readNumeric(cycle?.cycleIndex) ?? index + 1,
              entries: Array.isArray(cycle?.entries) ? cycle.entries : [],
            }))
          : [
              {
                cycle: null,
                cycleIndex: 1,
                entries: solvedEntries,
              },
            ];

        let processedEntries = 0;
        for (let c = 0; c < cycleBatches.length; c += 1) {
          if (setSolveOverlayState.abortRequested) break;
          if (hasSetChanged()) throw new Error("Set changed");
          const batch = cycleBatches[c];
          const batchEntries = Array.isArray(batch?.entries)
            ? batch.entries
            : [];
          if (!batchEntries.length) continue;
          let cycleSubmittedEntries = 0;

          for (let i = 0; i < batchEntries.length; i += 1) {
            if (setSolveOverlayState.abortRequested) break;
            if (hasSetChanged()) throw new Error("Set changed");
            const entry = batchEntries[i];
            const challengeName =
              entry?.challengeName ??
              `Challenge ${entry?.challengeId ?? processedEntries + 1}`;
            setProgress(processedEntries, solvedEntries.length);
            setStatus(
              multiSetEnabled
                ? `(Cycle ${batch.cycleIndex}) (${i + 1}/${batchEntries.length}) Loading ${challengeName}...`
                : `(${i + 1}/${batchEntries.length}) Loading ${challengeName}...`,
            );
            const challengeEntity = await getChallengeEntityForSubmission(
              startedSetId,
              entry?.challengeId,
              entry?.challengeName ?? null,
            );
            if (!challengeEntity) {
              console.warn(
                `[EA Data] startSubmitting skipped ${challengeName} because challenge entity was not found after server refresh`,
              );
              entry.submitState = "skipped";
              entry.reason = "Already completed or unavailable.";
              processedEntries += 1;
              setProgress(processedEntries, solvedEntries.length);
              renderEntries();
              continue;
            }

            try {
              await loadChallenge(challengeEntity, true, { force: true });
              setStatus(
                multiSetEnabled
                  ? `(Cycle ${batch.cycleIndex}) (${i + 1}/${batchEntries.length}) Applying ${challengeName}...`
                  : `(${i + 1}/${batchEntries.length}) Applying ${challengeName}...`,
              );
              await applySolutionToChallenge(
                challengeEntity,
                entry.solutionIds,
                {
                  lookupKey: "id",
                  slotSolution: entry?.slotSolution ?? null,
                  playerById: setSolveOverlayState?.playerById ?? null,
                  preserveExistingValid: false,
                },
              );
              await delayMs(jitterMs(350, 0.35));

              setStatus(
                multiSetEnabled
                  ? `(Cycle ${batch.cycleIndex}) (${i + 1}/${batchEntries.length}) Submitting ${challengeName}...`
                  : `(${i + 1}/${batchEntries.length}) Submitting ${challengeName}...`,
              );
              const submitRes = await submitSbcChallenge(challengeEntity);
              if (!submitRes?.success) {
                const statusNum =
                  parseStatusNumber(submitRes?.status) ??
                  parseStatusNumber(submitRes?.error);
                if (isRetryableSbcStatus(statusNum)) {
                  throw new Error(
                    `Rate limited during submit (status ${statusNum}). Wait a bit and retry.`,
                  );
                }
                const code = submitRes?.error ?? "SUBMIT_FAILED";
                throw new Error(
                  `Submit failed for ${challengeName} (status ${statusNum ?? "?"}, error ${code})`,
                );
              }
              entry.submitState = "submitted";
              clearSetChallengeInfoPrefetchCache(startedSetId);
              submitted += 1;
              cycleSubmittedEntries += 1;
              processedEntries += 1;
              setProgress(processedEntries, solvedEntries.length);
              renderEntries();

              showToast({
                type: "success",
                title: "Challenge Submitted",
                message: `${challengeName} successfully submitted.`,
                timeoutMs: 4000,
              });

              setStatus(
                multiSetEnabled
                  ? `(Cycle ${batch.cycleIndex}) (${i + 1}/${batchEntries.length}) Cooling down...`
                  : `(${i + 1}/${batchEntries.length}) Cooling down...`,
              );
              await delayMs(jitterMs(4500, 0.35));
              try {
                await sbcApiCall(
                  "requestChallengesForSet",
                  () =>
                    observableToPromise(
                      services.SBC.requestChallengesForSet(setEntity),
                    ),
                  { minGapMs: SBC_AUTOMATION_MIN_GAP_MS, maxAttempts: 2 },
                );
              } catch {}
            } catch (challengeError) {
              log(
                "debug",
                "[EA Data] Set solver individual challenge failed",
                challengeError,
              );
              const errMsg = String(challengeError?.message ?? "");
              const isRateLimit = /rate.?limit|status\s*429/i.test(errMsg);
              if (isRateLimit) {
                throw challengeError;
              }
              const isConceptCard = /concept.?card|missing from club/i.test(
                errMsg,
              );
              if (isConceptCard) {
                // Smart re-solve: fetch fresh players, re-solve this challenge, retry apply+submit.
                try {
                  setStatus(
                    multiSetEnabled
                      ? `(Cycle ${batch.cycleIndex}) (${i + 1}/${batchEntries.length}) Re-solving ${challengeName}...`
                      : `(${i + 1}/${batchEntries.length}) Re-solving ${challengeName}...`,
                  );
                  log(
                    "debug",
                    "[EA Data] Smart re-solve: concept card detected, re-solving",
                    { challengeName },
                  );
                  const freshPayload = await window.eaData.getSolverPayload({
                    ignoreLoaned: true,
                    forcePlayersFetch: true,
                  });
                  const freshPlayers = Array.isArray(freshPayload?.players)
                    ? freshPayload.players
                    : [];
                  let reSolveSettings = null;
                  try {
                    reSolveSettings =
                      await getSolverSettingsForChallenge(startedChallengeId);
                  } catch {
                    reSolveSettings = getDefaultSolverSettings();
                  }
                  const reSolveEffective = {
                    ...reSolveSettings,
                    ...getPoolSettingsFromInputs(),
                  };
                  const {
                    filteredPlayers: reSolvePlayers,
                    poolFilters: reSolvePoolFilters,
                  } = filterPlayersBySolverPoolSettings(
                    freshPlayers,
                    reSolveEffective,
                  );
                  const reSolveFilters = {
                    ...(freshPayload?.filters &&
                    typeof freshPayload.filters === "object"
                      ? freshPayload.filters
                      : {}),
                    ...reSolvePoolFilters,
                    excludedPlayerIds: [
                      ...new Set([
                        ...(entry.solutionIds ?? []).map(String),
                        ...solvedEntries
                          .filter(
                            (e, idx) =>
                              idx !== i && e.submitState === "submitted",
                          )
                          .flatMap((e) => (e.solutionIds ?? []).map(String)),
                      ]),
                    ],
                  };
                  await loadChallenge(challengeEntity, true, { force: true });
                  const reSolveLoaded = challengeEntity;
                  const reSolveSnapshot = buildRequirementsSnapshot(
                    challengeEntity,
                    reSolveLoaded?.data ?? reSolveLoaded,
                  );
                  const reSolveSlotInfo = buildChallengeSlotsForSolver(
                    challengeEntity,
                    reSolveLoaded?.data ?? reSolveLoaded,
                  );
                  const reSolveReqs = (reSolveSnapshot?.requirements ?? []).map(
                    serializeRequirementForSolver,
                  );
                  const reSolveReqsNorm = (
                    reSolveSnapshot?.requirementsNormalized ?? []
                  ).map(serializeNormalizedRequirementForSolver);
                  const reSolveResult = await callSolverBridge(
                    "SOLVE",
                    {
                      players: reSolvePlayers,
                      requirements: reSolveReqs,
                      requirementsNormalized: reSolveReqsNorm,
                      requiredPlayers: reSolveSlotInfo?.requiredPlayers ?? null,
                      squadSlots: reSolveSlotInfo?.squadSlots ?? [],
                      filters: reSolveFilters,
                      debug: false,
                    },
                    SOLVER_BRIDGE_TIMEOUT_MS,
                  );
                  if (!reSolveResult?.solutions?.length) {
                    throw new Error("Re-solve found no feasible squad.");
                  }
                  const newSolutionIds = reSolveResult.solutions[0] ?? [];
                  entry.solutionIds = newSolutionIds;
                  entry.slotSolution =
                    reSolveResult?.solutionSlots?.[0] ?? null;
                  // Update the playerById map with fresh data.
                  const freshPlayerById = new Map(
                    reSolvePlayers
                      .map((p) => [p?.id != null ? String(p.id) : null, p])
                      .filter(([k]) => k != null),
                  );
                  setSolveOverlayState.playerById = freshPlayerById;
                  // Retry apply + submit with the new solution.
                  setStatus(
                    multiSetEnabled
                      ? `(Cycle ${batch.cycleIndex}) (${i + 1}/${batchEntries.length}) Applying ${challengeName} (retry)...`
                      : `(${i + 1}/${batchEntries.length}) Applying ${challengeName} (retry)...`,
                  );
                  await applySolutionToChallenge(
                    challengeEntity,
                    newSolutionIds,
                    {
                      lookupKey: "id",
                      slotSolution: entry?.slotSolution ?? null,
                      playerById: freshPlayerById,
                      preserveExistingValid: false,
                    },
                  );
                  await delayMs(jitterMs(350, 0.35));
                  setStatus(
                    multiSetEnabled
                      ? `(Cycle ${batch.cycleIndex}) (${i + 1}/${batchEntries.length}) Submitting ${challengeName} (retry)...`
                      : `(${i + 1}/${batchEntries.length}) Submitting ${challengeName} (retry)...`,
                  );
                  const retrySubmitRes =
                    await submitSbcChallenge(challengeEntity);
                  if (!retrySubmitRes?.success) {
                    const retryCode = retrySubmitRes?.error ?? "SUBMIT_FAILED";
                    throw new Error(
                      `Retry submit failed for ${challengeName} (error ${retryCode})`,
                    );
                  }
                  entry.submitState = "submitted";
                  clearSetChallengeInfoPrefetchCache(startedSetId);
                  submitted += 1;
                  cycleSubmittedEntries += 1;
                  processedEntries += 1;
                  setProgress(processedEntries, solvedEntries.length);
                  renderEntries();
                  showToast({
                    type: "success",
                    title: "Challenge Submitted (Re-solved)",
                    message: `${challengeName} re-solved and submitted successfully.`,
                    timeoutMs: 5000,
                  });
                  setStatus(
                    multiSetEnabled
                      ? `(Cycle ${batch.cycleIndex}) (${i + 1}/${batchEntries.length}) Cooling down...`
                      : `(${i + 1}/${batchEntries.length}) Cooling down...`,
                  );
                  await delayMs(jitterMs(4500, 0.35));
                  try {
                    await sbcApiCall(
                      "requestChallengesForSet",
                      () =>
                        observableToPromise(
                          services.SBC.requestChallengesForSet(setEntity),
                        ),
                      { minGapMs: SBC_AUTOMATION_MIN_GAP_MS, maxAttempts: 2 },
                    );
                  } catch {}
                  continue;
                } catch (retryError) {
                  log("debug", "[EA Data] Smart re-solve failed", retryError);
                }
              }
              // Unrecoverable or re-solve failed – skip this challenge.
              entry.submitState = "failed";
              entry.reason = errMsg || "Apply/submit failed.";
              processedEntries += 1;
              setProgress(processedEntries, solvedEntries.length);
              renderEntries();
              showToast({
                type: "error",
                title: "Challenge Skipped",
                message: `${challengeName}: ${errMsg || "apply failed"}`,
                timeoutMs: 7000,
              });
              continue;
            }
          }

          if (
            multiSetEnabled &&
            !setSolveOverlayState.abortRequested &&
            cycleSubmittedEntries === batchEntries.length
          ) {
            try {
              if (batch?.cycle) batch.cycle.submitState = "submitted";
            } catch {}
            submittedCycles += 1;
            renderEntries();
            try {
              if (setSolveOverlayState.selectedChallengeIds == null) {
                const postState = await handleSetSolveCompletionState({
                  setId: startedSetId,
                  setEntity,
                });
                const remaining = readNumeric(
                  postState?.repeatability?.remaining,
                );
                shouldExitSetView = Boolean(postState?.shouldExitSetView);
                if (postState?.repeatability) {
                  setSolveOverlayState.repeatabilityInfo =
                    postState.repeatability;
                  setSolveOverlayState.repeatabilityRemaining = remaining;
                  const nextMax = clampInt(
                    postState?.repeatability?.max ?? 1,
                    1,
                    50,
                  );
                  setSolveOverlayState.repeatabilityMaxCycles =
                    nextMax == null ? 1 : nextMax;
                }
                syncSetCycleControls();

                // Only forcefully break our multi-cycle iteration if we have provably run out of repeats.
                if (remaining != null && remaining <= 0) {
                  setStatus("No repeatable attempts left. Exiting set...");
                  showToast({
                    type: "info",
                    title: "No Attempts Left",
                    message: "Set limits reached. Exiting set page.",
                    timeoutMs: 7000,
                  });
                  break;
                }
              }
            } catch (postError) {
              log(
                "debug",
                "[EA Data] Set solve post-submit refresh failed",
                postError,
              );
            }
          }

          // Allow the EA backend time to process the repeat reset before
          // fetching challenges for the next cycle.
          if (
            multiSetEnabled &&
            c < cycleBatches.length - 1 &&
            !setSolveOverlayState.abortRequested
          ) {
            await delayMs(jitterMs(2000, 0.3));
          }
        }

        if (setSolveOverlayState.abortRequested) {
          setStatus(
            `Stopped. Submitted ${submitted} / ${solvedEntries.length}.`,
          );
          showToast({
            type: "info",
            title: "Set Submitting Stopped",
            message: `Submitted ${submitted} challenge(s).`,
            timeoutMs: 6500,
          });
        } else {
          if (multiSetEnabled) {
            setStatus(
              `Complete. Submitted ${submitted} challenge(s) across ${submittedCycles} set cycle(s).`,
            );
          } else {
            setStatus(
              `Complete. Submitted ${submitted} / ${solvedEntries.length}.`,
            );
          }
          showToast({
            type: "success",
            title: "Set Solve Complete",
            message: multiSetEnabled
              ? `Submitted ${submittedCycles} set cycle(s).`
              : `Submitted ${submitted} challenge(s).`,
            timeoutMs: 6500,
          });
          if (!multiSetEnabled) {
            try {
              if (setSolveOverlayState.selectedChallengeIds == null) {
                const postState = await handleSetSolveCompletionState({
                  setId: startedSetId,
                  setEntity,
                });
                shouldExitSetView = Boolean(postState?.shouldExitSetView);
                const remaining = readNumeric(
                  postState?.repeatability?.remaining,
                );
                if (postState?.repeatability) {
                  setSolveOverlayState.repeatabilityInfo =
                    postState.repeatability;
                  setSolveOverlayState.repeatabilityRemaining = readNumeric(
                    postState?.repeatability?.remaining,
                  );
                  const nextMax = clampInt(
                    postState?.repeatability?.max ?? 1,
                    1,
                    50,
                  );
                  setSolveOverlayState.repeatabilityMaxCycles =
                    nextMax == null ? 1 : nextMax;
                }
                syncSetCycleControls();
                if (shouldExitSetView) {
                  setStatus("No repeatable attempts left. Exiting set...");
                  showToast({
                    type: "info",
                    title: "No Attempts Left",
                    message: "Set refreshed. Exiting set page.",
                    timeoutMs: 7000,
                  });
                } else {
                  setStatus(
                    remaining != null
                      ? `Set refreshed. Remaining repeats: ${remaining}.`
                      : "Set refreshed.",
                  );
                }
              }
            } catch (postError) {
              log(
                "debug",
                "[EA Data] Set solve post-submit refresh failed",
                postError,
              );
            }
          }
        }
        completedWithoutError = true;
      } catch (error) {
        log("debug", "[EA Data] Set solve submit failed", error);
        try {
          setStatus(
            error?.message
              ? `Error: ${error.message}`
              : "Error: Submission failed.",
          );
        } catch {}
        showToast({
          type: "error",
          title: "Set Solve Failed",
          message: error?.message || "Submission failed.",
          timeoutMs: 9000,
        });
      } finally {
        exitSbcAutomation();
        setRunning(false);
        setProgress(null, null);
      }

      if (completedWithoutError) {
        try {
          closeSetSolveOverlay();
        } catch {}
        if (shouldExitSetView) {
          await delayMs(jitterMs(300, 0.25));
          if (startedChallengeId != null) {
            try {
              await tryExitSbcChallengeView(startedChallengeId);
            } catch {}
          }
          const exitedSet = await tryExitSbcSetView(startedSetId);
          if (!exitedSet) {
            showToast({
              type: "info",
              title: "Refresh Needed",
              message: "Set refreshed.",
              timeoutMs: 8000,
            });
          }
        }
      }
    };

    overlay.addEventListener("click", (event) => {
      if (event.target !== overlay) return;
      if (setSolveOverlayState?.running) return;
      closeSetSolveOverlay();
    });

    modal?.addEventListener("click", (event) => {
      try {
        event.stopPropagation();
      } catch {}
    });

    const onClose = (event) => {
      try {
        event.stopPropagation();
      } catch {}
      if (setSolveOverlayState?.running) return;
      closeSetSolveOverlay();
    };

    closeBtn?.addEventListener("click", onClose);
    cancelBtn?.addEventListener("click", onClose);
    stopBtn?.addEventListener("click", () => {
      setSolveOverlayState.abortRequested = true;
      setStatus("Stopping...");
      try {
        stopBtn.disabled = true;
        stopBtn.textContent = "Stopping...";
      } catch {}
    });

    ratingMinRange?.addEventListener("input", () =>
      syncRatingRange(
        { ratingMin: ratingMinRange.value, ratingMax: ratingMaxRange.value },
        { source: "min" },
      ),
    );
    ratingMaxRange?.addEventListener("input", () =>
      syncRatingRange(
        { ratingMin: ratingMinRange.value, ratingMax: ratingMaxRange.value },
        { source: "max" },
      ),
    );
    ratingMinInput?.addEventListener("input", () =>
      syncRatingRange(
        { ratingMin: ratingMinInput.value, ratingMax: ratingMaxInput.value },
        { source: "min" },
      ),
    );
    ratingMaxInput?.addEventListener("input", () =>
      syncRatingRange(
        { ratingMin: ratingMinInput.value, ratingMax: ratingMaxInput.value },
        { source: "max" },
      ),
    );

    multiSetToggleInput?.addEventListener("change", () => {
      syncSetCycleControls({ source: "state" });
      renderEntries();
    });
    setCyclesInput?.addEventListener("input", () => {
      syncSetCycleControls({ source: "input" });
    });
    setCyclesInput?.addEventListener("change", () => {
      syncSetCycleControls({ source: "input" });
      renderEntries();
    });

    const bumpNumberInput = (input, dir) => {
      if (!input || input.disabled) return;
      const direction = dir === "down" ? "down" : "up";
      try {
        if (direction === "down") input.stepDown();
        else input.stepUp();
      } catch {
        const cur = readNumeric(input.value) ?? 0;
        const step = readNumeric(input.step) ?? 1;
        const min = readNumeric(input.min);
        const max = readNumeric(input.max);
        const next = cur + (direction === "down" ? -step : step);
        const clamped = Math.max(
          min == null ? -1e9 : min,
          Math.min(max == null ? 1e9 : max, next),
        );
        try {
          input.value = String(clamped);
        } catch {}
      }
      try {
        input.dispatchEvent(new Event("input", { bubbles: true }));
      } catch {}
      try {
        input.dispatchEvent(new Event("change", { bubbles: true }));
      } catch {}
    };

    modal?.addEventListener("click", (event) => {
      const btn =
        event?.target?.closest?.(".ea-data-times-stepper__btn") ?? null;
      if (!btn) return;
      try {
        event.preventDefault();
        event.stopPropagation();
      } catch {}
      const targetId = btn.getAttribute("data-target") ?? "";
      const stepDir = btn.getAttribute("data-step") ?? "up";
      const input = overlay.querySelector(`#${targetId}`);
      bumpNumberInput(input, stepDir);
    });

    generateBtn?.addEventListener("click", async () => {
      await generateSetSolutions();
    });
    startBtn?.addEventListener("click", async () => {
      await startSubmitting();
    });

    setSolveOverlayState = {
      overlay,
      closeBtn,
      cancelBtn,
      generateBtn,
      startBtn,
      stopBtn,
      statusEl,
      listEl,
      ratingRangeRoot,
      ratingMinRange,
      ratingMaxRange,
      ratingMinInput,
      ratingMaxInput,
      multiSetToggleInput,
      setCyclesInput,
      setCyclesMetaEl,
      toggleBinder,
      ratingRange: ratingRangeCurrent,
      poolSettings: getDefaultSolverPoolSettings(),
      challengeId: null,
      setId: null,
      setName: null,
      entries: [],
      cycleResults: [],
      playerById: null,
      activeIndex: 0,
      sortKey: "rating_desc",
      multiSetEnabled: false,
      requestedSetCyclesInput: 1,
      requestedSetCycles: 1,
      repeatabilityInfo: null,
      repeatabilityRemaining: null,
      repeatabilityMaxCycles: 1,
      maxFeasibleCycles: null,
      requirementsByChallengeId: new Map(),
      requirementsLoadToken: 0,
      requirementsInFlight: new Set(),
      rightPanelInitialized: false,
      rightPanelLastSetId: null,
      failureByChallengeId: new Map(),
      latestFailureContext: null,
      generationStopReason: null,
      running: false,
      mode: "idle",
      abortRequested: false,
      resetForChallenge,
      syncRatingRange,
      syncPoolSettings,
      syncSetCycleControls,
      syncSetCycleRepeatability,
      renderRightPanel: renderSetSolveRightPanel,
      refreshRequirements: refreshSetSolveRequirements,
    };

    const overlayTitle = overlay.querySelector("#ea-data-setsolve-title");

    // Auto-fetch challenges to populate picker when overlay opens
    const populatePicker = async (overrideSetId = null) => {
      try {
        clearNode(challengePickerWrap);
        const loading = document.createElement("div");
        loading.className = "ea-data-solutions-empty";
        loading.textContent = "Loading challenges...";
        challengePickerWrap.append(loading);

        const targetSetId =
          overrideSetId ??
          readNumeric(currentSbcSet?.id) ??
          readNumeric(currentChallenge?.setId);
        const targetSetKey = targetSetId == null ? null : String(targetSetId);
        if (setSolveOverlayState) {
          setSolveOverlayState.setId = targetSetKey;
          setSolveOverlayState.availableChallenges = [];
          setSolveOverlayState.selectedChallengeIds = null;
          setSolveOverlayState.entries = [];
          setSolveOverlayState.cycleResults = [];
          setSolveOverlayState.activeIndex = 0;
          ensureSetSolveRightPanelState();
          setSolveOverlayState.requirementsLoadToken =
            Number(setSolveOverlayState?.requirementsLoadToken ?? 0) + 1;
          setSolveOverlayState.rightPanelLastSetId = targetSetKey;
          setSolveOverlayState.requirementsByChallengeId?.clear?.();
          setSolveOverlayState.requirementsInFlight?.clear?.();
          renderSetSolveRightPanel({ reason: "picker-loading" });
        }
        renderEntries();
        if (targetSetId != null) {
          const challenges = await getSortedSetChallenges(targetSetId);
          if (setSolveOverlayState) {
            setSolveOverlayState.setId = targetSetKey;
            setSolveOverlayState.availableChallenges = challenges;
            setSolveOverlayState.selectedChallengeIds = null;
          }
          void refreshSetSolveRequirements(targetSetId, challenges);
          renderChallengePicker();
          syncSetCycleControls();
        } else {
          renderSetSolveRightPanel({ reason: "picker-no-set" });
        }
      } catch (err) {
        log("debug", "[EA Data] Picker challenge fetch failed", err);
        renderSetSolveRightPanel({ reason: "picker-error" });
      }
    };

    setSolveOverlayState.populatePicker = populatePicker;
    setSolveOverlayState.renderRightPanel = renderSetSolveRightPanel;
    setSolveOverlayState.refreshRequirements = refreshSetSolveRequirements;
    renderSetSolveRightPanel({ reason: "overlay-init" });

    if (currentSbcSet?.id != null || currentChallenge?.setId != null) {
      populatePicker();
    }

    if (!setSolveOverlayKeyHandlerBound) {
      setSolveOverlayKeyHandlerBound = true;
      document.addEventListener(
        "keydown",
        (event) => {
          if (event?.key !== "Escape") return;
          const open =
            document
              .getElementById("ea-data-setsolve-overlay")
              ?.getAttribute("aria-hidden") === "false";
          if (!open) return;
          if (setSolveOverlayState?.running) return;
          try {
            event.preventDefault();
          } catch {}
          closeSetSolveOverlay();
        },
        true,
      );
    }

    syncRatingRange({ ratingMin: 0, ratingMax: 99 }, { source: "init" });
    syncPoolSettings(getDefaultSolverSettings());
    syncSetCycleRepeatability(
      readNumeric(currentSbcSet?.id) ?? readNumeric(currentChallenge?.setId),
      {
        resetRequested: true,
      },
    );
    reset();
    return overlay;
  };

  const resolveSetSolveContext = async (context = {}) => {
    const sourceSet = context?.set ?? null;
    let setId =
      readNumeric(context?.setId) ??
      readNumeric(sourceSet?.id) ??
      readNumeric(setSolveOverlayState?.setId) ??
      readNumeric(currentSbcSet?.id) ??
      readNumeric(currentChallenge?.setId) ??
      null;
    let setEntity = sourceSet;
    if (!setEntity && setId != null) {
      setEntity = await ensureSbcSetById(setId);
    }
    if (setId == null) setId = readNumeric(setEntity?.id) ?? null;
    const challengeId =
      readNumeric(context?.challengeId) ??
      readNumeric(currentChallenge?.id) ??
      null;
    return {
      challengeId,
      setId,
      setEntity,
      setName: context?.setName ?? setEntity?.name ?? null,
      isGroupSet: isGroupSbcSet(setEntity ?? setId),
    };
  };

  const openSetSolveOverlay = async (context = {}) => {
    let resolved = null;
    try {
      resolved = await resolveSetSolveContext(context);
    } catch {
      resolved = null;
    }
    const challengeId = resolved?.challengeId ?? null;
    const setId = resolved?.setId ?? null;
    const setName = resolved?.setName ?? null;
    const isGroupSet = Boolean(resolved?.isGroupSet);

    if (setId == null) {
      showToast({
        type: "error",
        title: "Set Solve Unavailable",
        message: "Open a group SBC set first.",
        timeoutMs: 6500,
      });
      return;
    }
    if (!isGroupSet) {
      showToast({
        type: "error",
        title: "Set Solve Unavailable",
        message: "Only available for group SBC sets.",
        timeoutMs: 9000,
      });
      return;
    }

    const overlay = ensureSetSolveOverlay();
    const previousChallengeKey = setSolveOverlayState?.challengeId ?? null;
    const previousSetKey = setSolveOverlayState?.setId ?? null;
    const nextChallengeKey = challengeId == null ? null : String(challengeId);
    const nextSetKey = setId == null ? null : String(setId);
    try {
      setSolveOverlayState?.resetForChallenge?.(challengeId, setId, setName);
    } catch {}
    if (
      previousChallengeKey !== nextChallengeKey ||
      previousSetKey !== nextSetKey ||
      !setSolveOverlayState?.ratingRange ||
      !setSolveOverlayState?.poolSettings
    ) {
      try {
        const settings = await getSolverSettingsForChallenge(challengeId);
        setSolveOverlayState?.syncRatingRange?.(settings?.ratingRange, {
          source: "open",
        });
        setSolveOverlayState?.syncPoolSettings?.(settings);
      } catch {}
    }
    try {
      setSolveOverlayState?.syncSetCycleRepeatability?.(setId, {
        resetRequested: false,
      });
    } catch {}
    try {
      const titleEl = overlay.querySelector("#ea-data-setsolve-title");
      if (titleEl) {
        titleEl.textContent = setName
          ? `Solve Entire Set - ${String(setName)}`
          : "Solve Entire Set";
      }
    } catch {}
    overlay.setAttribute("aria-hidden", "false");
    overlay.style.display = "flex";
    try {
      overlay.style.pointerEvents = "auto";
    } catch {}
    try {
      setSolveOverlayState?.renderRightPanel?.({ reason: "open" });
    } catch {}
    if (
      previousChallengeKey === nextChallengeKey &&
      previousSetKey === nextSetKey &&
      setId != null
    ) {
      try {
        void setSolveOverlayState?.populatePicker?.(setId);
      } catch {}
    }
  };

  const syncSetSolveButtonForSet = (button, setEntity) => {
    if (!button) return;
    const isGroupSet = isGroupSbcSet(setEntity);
    try {
      button.disabled = !isGroupSet;
      if (!isGroupSet) {
        button.setAttribute("aria-disabled", "true");
        button.setAttribute("title", "Only available for group SBC sets.");
      } else {
        button.removeAttribute("aria-disabled");
        button.removeAttribute("title");
      }
    } catch {}
  };

  const syncMultiSolveButtonForChallenge = (button, challenge) => {
    if (!button) return;
    let isGroupSet = false;
    try {
      const info = getSbcSetRepeatabilityInfo(challenge?.setId ?? null, {
        unlimitedDefault: 50,
        clampMax: 50,
      });
      const count = readNumeric(info?.challengesCount);
      isGroupSet = count != null && count > 1;
    } catch {}
    try {
      button.disabled = Boolean(isGroupSet);
      if (isGroupSet) {
        button.setAttribute("aria-disabled", "true");
        button.setAttribute(
          "title",
          "Only supported for standalone SBC challenges.",
        );
      } else {
        button.removeAttribute("aria-disabled");
        button.removeAttribute("title");
      }
    } catch {}
  };

  const resolveSetInfoRoot = (view) => {
    if (!view) return null;
    const candidates = [
      view?._setInfo?.getRootElement?.(),
      view?.setInfo?.getRootElement?.(),
      view?.__setInfo?.getRootElement?.(),
      view?.__content,
      view?.getRootElement?.(),
    ];
    for (const node of candidates) {
      if (node && typeof node.appendChild === "function") return node;
    }
    return null;
  };

  const ensureSetSolveChooserButton = (view, setEntity) => {
    if (!view) return;
    const root = resolveSetInfoRoot(view);
    if (!root) return;

    try {
      const existing = view?.__eaDataSetSolveChooserWrapper ?? null;
      if (existing) {
        if (typeof root?.contains === "function" && root.contains(existing)) {
          try {
            syncSetSolveButtonForSet(
              view?.__eaDataSetSolveChooserButton ?? null,
              setEntity ?? currentSbcSet ?? null,
            );
          } catch {}
          return;
        }
        view.__eaDataSetSolveChooserWrapper = null;
        view.__eaDataSetSolveChooserButton = null;
      }
    } catch {}

    ensureSolveButtonStyles();
    const wrapper = document.createElement("div");
    wrapper.className = "ea-data-setsolve-chooser-wrap";
    const button = document.createElement("button");
    button.type = "button";
    button.className =
      "ea-data-setsolve-button ea-data-setsolve-button--chooser";
    button.textContent = "Solve Entire Set";
    button.setAttribute("aria-label", "Solve entire SBC set");
    button.addEventListener("click", async (event) => {
      try {
        event.preventDefault();
        event.stopPropagation();
      } catch {}
      await openSetSolveOverlay({
        set: setEntity ?? currentSbcSet ?? null,
        setId: setEntity?.id ?? currentSbcSet?.id ?? null,
        setName: setEntity?.name ?? currentSbcSet?.name ?? null,
      });
    });
    syncSetSolveButtonForSet(button, setEntity ?? currentSbcSet ?? null);

    wrapper.append(button);
    root.append(wrapper);
    view.__eaDataSetSolveChooserWrapper = wrapper;
    view.__eaDataSetSolveChooserButton = button;
  };

  const cleanupSetSolveChooserButton = (view) => {
    if (!view) return;
    view.__eaDataSetSolveChooserWrapper?.remove?.();
    view.__eaDataSetSolveChooserWrapper = null;
    view.__eaDataSetSolveChooserButton = null;
  };

  const ensureSolveButton = (view, challenge) => {
    if (!view) return;
    const root = view.__content ?? view.getRootElement?.() ?? null;
    if (!root) return;

    // EA will occasionally re-render the panel and replace the root DOM.
    // If our injected button wrapper no longer exists in the current root, re-inject it.
    try {
      const existingWrapper = view?.__eaDataSolveWrapper ?? null;
      if (existingWrapper) {
        if (
          typeof root?.contains === "function" &&
          root.contains(existingWrapper)
        ) {
          try {
            syncMultiSolveButtonForChallenge(
              view?.__eaDataMultiSolveButton ?? null,
              challenge ?? currentChallenge,
            );
          } catch {}
          return;
        }
        view.__eaDataSolveWrapper = null;
        view.__eaDataSolveButton = null;
        view.__eaDataMultiSolveButton = null;
      }
    } catch {}

    ensureSolveButtonStyles();

    const refreshSbcPanelView = (
      panelView,
      challenge,
      { mode = "safe" } = {},
    ) => {
      if (!challenge) return;
      const payload = { squad: challenge?.squad ?? null };
      try {
        challenge?.onDataChange?.notify?.(payload);
      } catch {}

      // Safe mode keeps EA interaction bindings intact by avoiding explicit
      // overview setSquad/deep re-render calls.
      if (mode !== "deep") {
        return;
      }

      const tryRefreshOverview = () => {
        try {
          const overview = currentSbcOverviewView ?? null;
          const squad = challenge?.squad ?? null;
          if (!overview || !squad) return;
          if (typeof overview?.setSquad !== "function") return;
          const args = overview?.__eaDataLastSetSquadArgs;
          overview.setSquad(squad, ...(Array.isArray(args) ? args : []));
        } catch {}
      };

      // Some EA UI builds won't repaint squad slots after programmatic setPlayers/save.
      // A best-effort re-render fixes the "slots look empty until reopen" issue.
      const expectedChallengeId = challenge?.id ?? null;
      const isStillSameChallenge = () =>
        expectedChallengeId == null ||
        currentChallenge?.id === expectedChallengeId;
      // Pitch/overview rendering is owned by a different view than the right panel in some builds.
      try {
        requestAnimationFrame(tryRefreshOverview);
      } catch {
        tryRefreshOverview();
      }

      // Second pass: a delayed re-render often fixes stale pitch rendering without tearing down the view.
      try {
        setTimeout(() => {
          if (!isStillSameChallenge()) return;
          try {
            challenge?.onDataChange?.notify?.(payload);
          } catch {}
          tryRefreshOverview();
        }, 250);
      } catch {}
    };

    const wrapper = document.createElement("div");
    wrapper.classList.add("ea-data-solve-wrapper");

    const button = document.createElement("button");
    button.className = "ea-data-solve-button";
    button.textContent = "Solve Squad";
    button.addEventListener("click", async () => {
      console.log("[EA Data] Solve Squad clicked");
      try {
        dismissToast(activeProgressToast);
      } catch {}
      activeProgressToast = showToast({
        type: "info",
        title: "Finding the Best Squad",
        message: "within Constraints",
        timeoutMs: 0,
      });
      const startedChallengeId = currentChallenge?.id ?? null;
      button.disabled = true;
      showLoadingOverlay("Fetching players...");
      try {
        const payload = await window.eaData.getSolverPayload({
          ignoreLoaned: true,
        });
        if (
          startedChallengeId != null &&
          currentChallenge?.id !== startedChallengeId
        ) {
          console.log("[EA Data] Solve aborted (challenge changed)", {
            startedChallengeId,
            currentChallengeId: currentChallenge?.id ?? null,
          });
          try {
            dismissToast(activeProgressToast);
            activeProgressToast = null;
          } catch {}
          return;
        }
        updateLoadingOverlay("Solving squad...");
        const slowSolveTimer = setTimeout(() => {
          updateLoadingOverlay(
            "Still solving... (this can take up to ~1 minute)",
          );
        }, 15000);
        const bridgeReady = await initSolverBridge();
        if (!bridgeReady) {
          console.log("[EA Data] Solver bridge not ready", solverBridgeError);
          try {
            dismissToast(activeProgressToast);
            activeProgressToast = null;
          } catch {}
          showToast({
            type: "error",
            title: "Solver Not Ready",
            message: "Reload and try again.",
            timeoutMs: 9000,
          });
          return;
        }
        const safeRequirements = (
          payload.openChallenge?.requirements ?? []
        ).map(serializeRequirementForSolver);
        const safeRequirementsNormalized = (
          payload.openChallenge?.requirementsNormalized ?? []
        ).map((rule) => {
          if (!rule || typeof rule !== "object") return rule;
          return {
            type: rule.type ?? null,
            key: rule.key ?? null,
            keyName: rule.keyName ?? null,
            keyNameNormalized: rule.keyNameNormalized ?? null,
            typeSource: rule.typeSource ?? null,
            op: rule.op ?? null,
            count: rule.count ?? null,
            derivedCount: rule.derivedCount ?? null,
            value: rule.value ?? null,
            scope: rule.scope ?? null,
            scopeName: rule.scopeName ?? null,
            label: rule.label ?? null,
          };
        });

        let solverSettings = null;
        try {
          solverSettings =
            await getSolverSettingsForChallenge(startedChallengeId);
        } catch {
          solverSettings = getDefaultSolverSettings();
        }

        const requiredIds = new Set();
        try {
          for (const slot of payload.squadSlots ?? []) {
            const item = slot?.item ?? null;
            const id = item?.id ?? null;
            const concept = Boolean(item?.concept);
            if (id && id !== 0 && !concept) requiredIds.add(String(id));
          }
        } catch {}

        const poolConflict = buildSolverPoolExclusionConflict({
          settings: solverSettings,
          requirementsNormalized: safeRequirementsNormalized,
          squadSlots: payload?.squadSlots ?? [],
        });
        if (poolConflict?.hasConflict) {
          const notice = buildSolverPoolConflictNotice(poolConflict);
          try {
            dismissToast(activeProgressToast);
            activeProgressToast = null;
          } catch {}
          showToast({
            type: "error",
            title: notice?.title ?? "Pool Exclusion Conflict",
            message:
              notice?.message ??
              "Current exclusions conflict with challenge requirements.",
            timeoutMs: 9000,
          });
          return;
        }

        const allPlayers = Array.isArray(payload.players)
          ? payload.players
          : [];
        const { filteredPlayers, poolFilters } =
          filterPlayersBySolverPoolSettings(allPlayers, solverSettings, {
            requiredIds,
          });
        console.log("[EA Data] Player pool filter", {
          ...poolFilters,
          before: allPlayers.length,
          after: filteredPlayers.length,
          required: requiredIds.size,
        });
        const mergedFilters = {
          ...(payload.filters && typeof payload.filters === "object"
            ? payload.filters
            : {}),
          ...poolFilters,
        };
        const result = await callSolverBridge(
          "SOLVE",
          {
            players: filteredPlayers,
            requirements: safeRequirements,
            requirementsNormalized: safeRequirementsNormalized,
            requiredPlayers: payload.requiredPlayers ?? null,
            squadSlots: payload.squadSlots ?? [],
            prioritize: payload.prioritize,
            filters: mergedFilters,
            debug: debugEnabled,
          },
          SOLVER_BRIDGE_TIMEOUT_MS,
        );
        clearTimeout(slowSolveTimer);
        _log("[EA Data] Solver result", result);
        window.__eaDataSolver = window.__eaDataSolver || {};
        window.__eaDataSolver.lastResult = result;
        window.__eaDataSolver.lastAppliedFilters =
          result?.stats?.appliedFilters ?? [];
        window.__eaDataSolver.lastRequirementFlags =
          result?.stats?.requirementFlags ?? {};
        window.__eaDataSolver.lastDebugLog = result?.stats?.debugLog ?? [];
        logSolverDebugResult("single", result, {
          challengeId: startedChallengeId,
        });
        if (result?.solutions?.length && currentChallenge) {
          // If the current squad already contains the same players, avoid re-saving the squad.
          // Repeated saves can trigger EA-side errors (ex: 475) and can leave the UI in a stale state.
          const squadSize =
            Number(payload.requiredPlayers) ||
            Number(result?.stats?.squadSize) ||
            11;
          const chemistryRequired = Boolean(result?.stats?.chemistryTargets);
          const currentFilledBySlotIndex = new Map(
            (payload?.squadSlots || []).slice(0, squadSize).map((slot) => {
              const item = slot?.item ?? null;
              const id =
                item && item.id && item.id !== 0 && !item.concept
                  ? item.id
                  : null;
              return [slot?.slotIndex ?? null, id];
            }),
          );
          const currentFilledIds = Array.from(
            currentFilledBySlotIndex.values(),
          ).filter(Boolean);
          const solutionIds = (result.solutions?.[0] || [])
            .map((id) => (id == null ? null : id))
            .filter(Boolean);
          const isSameApplied = (() => {
            if (currentFilledIds.length !== squadSize) return false;
            if (solutionIds.length !== squadSize) return false;

            // For chemistry challenges, the exact slot assignment matters.
            if (chemistryRequired) {
              const slotSolution = result?.solutionSlots?.[0] ?? null;
              const indices = slotSolution?.fieldSlotIndices ?? null;
              const ids = slotSolution?.fieldSlotToPlayerId ?? null;
              if (!Array.isArray(indices) || !Array.isArray(ids)) return false;
              if (indices.length !== squadSize || ids.length !== squadSize)
                return false;
              for (let i = 0; i < squadSize; i += 1) {
                const slotIndex = indices[i];
                const current = currentFilledBySlotIndex.get(slotIndex) ?? null;
                const desired = ids[i] ?? null;
                if (String(current) !== String(desired)) return false;
              }
              return true;
            }

            // Non-chemistry challenges: if the set of players matches, no need to re-save.
            const a = new Set(currentFilledIds.map((id) => String(id)));
            if (a.size !== squadSize) return false;
            for (const id of solutionIds) {
              if (!a.has(String(id))) return false;
            }
            return true;
          })();
          if (isSameApplied) {
            updateLoadingOverlay("Refreshing UI...");
            refreshSbcPanelView(view, currentChallenge, { mode: "safe" });
            try {
              dismissToast(activeProgressToast);
              activeProgressToast = null;
            } catch {}
            showToast({
              type: "success",
              title: "Solution Already Applied",
              message: "",
              timeoutMs: 6500,
            });
            return;
          }

          updateLoadingOverlay("Applying squad...");
          await applySolutionToChallenge(
            currentChallenge,
            result.solutions[0],
            {
              lookupKey: "id",
              slotSolution: result?.solutionSlots?.[0] ?? null,
              playerById: new Map(
                (payload?.players ?? [])
                  .map((p) => [p?.id != null ? String(p.id) : null, p])
                  .filter(([k]) => k != null),
              ),
            },
          );
          console.log("[EA Data] Solver applied", {
            challengeId: currentChallenge?.id ?? null,
            solutionSize: result.solutions[0]?.length ?? 0,
          });
          updateLoadingOverlay("Refreshing UI...");
          refreshSbcPanelView(view, currentChallenge, { mode: "deep" });
          try {
            dismissToast(activeProgressToast);
            activeProgressToast = null;
          } catch {}
          showToast({
            type: "success",
            title: "Solution Found!!!",
            message: "",
            timeoutMs: 6500,
          });
        } else {
          try {
            dismissToast(activeProgressToast);
            activeProgressToast = null;
          } catch {}
          const failing = Array.isArray(result?.failingRequirements)
            ? result.failingRequirements
            : [];
          console.log("[EA Data] No feasible squad", {
            failingRequirements: failing,
          });
          showToast({
            type: "error",
            title: "No Feasible Squad",
            message: "Not possible with current player pool.",
            timeoutMs: 9000,
          });
        }
      } catch (error) {
        console.log("[EA Data] Solver execution failed", error);
        try {
          dismissToast(activeProgressToast);
          activeProgressToast = null;
        } catch {}
        showToast({
          type: "error",
          title: "Solver Error",
          message: "Check console for details.",
          timeoutMs: 9000,
        });
      } finally {
        hideLoadingOverlay();
        button.disabled = false;
      }
    });

    const referenceButton = root.querySelector(
      "button.btn-standard:not(.ea-data-solve-button)",
    );
    if (referenceButton?.className) {
      button.className = `${referenceButton.className} ea-data-solve-button`;
    } else {
      button.className = "btn-standard call-to-action ea-data-solve-button";
    }

    const settingsButton = document.createElement("button");
    settingsButton.type = "button";
    settingsButton.className = "ea-data-settings-button";
    settingsButton.setAttribute("aria-label", "Solver settings");
    settingsButton.innerHTML = `
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M19.14 12.94c.04-.31.06-.63.06-.94s-.02-.63-.06-.94l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.61-.22l-2.39.96a7.03 7.03 0 0 0-1.63-.94l-.36-2.54A.5.5 0 0 0 13.9 1h-3.8a.5.5 0 0 0-.49.42l-.36 2.54c-.58.23-1.13.54-1.63.94l-2.39-.96a.5.5 0 0 0-.61.22L2.7 7.48a.5.5 0 0 0 .12.64l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94L2.82 14.52a.5.5 0 0 0-.12.64l1.92 3.32c.13.22.39.31.61.22l2.39-.96c.5.4 1.05.71 1.63.94l.36 2.54c.04.24.25.42.49.42h3.8c.24 0 .45-.18.49-.42l.36-2.54c.58-.23 1.13-.54 1.63-.94l2.39.96c.22.09.48 0 .61-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.03-1.58ZM12 15.5A3.5 3.5 0 1 1 12 8a3.5 3.5 0 0 1 0 7.5Z"></path>
      </svg>
    `;
    settingsButton.addEventListener("click", async (event) => {
      try {
        event.preventDefault();
        event.stopPropagation();
      } catch {}
      await openSettingsOverlay();
    });

    const multiSolveButton = document.createElement("button");
    multiSolveButton.type = "button";
    multiSolveButton.className = "ea-data-multisolve-button";
    const multiSolveIcon = document.createElement("span");
    multiSolveIcon.className = "ea-data-multisolve-button__icon";
    multiSolveIcon.setAttribute("aria-hidden", "true");
    const svgNS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(svgNS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2.2");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("width", "14");
    svg.setAttribute("height", "14");
    for (const d of [
      "M17 1l4 4-4 4",
      "M3 11V9a4 4 0 0 1 4-4h14",
      "M7 23l-4-4 4-4",
      "M21 13v2a4 4 0 0 1-4 4H3",
    ]) {
      const p = document.createElementNS(svgNS, "path");
      p.setAttribute("d", d);
      svg.appendChild(p);
    }
    multiSolveIcon.appendChild(svg);
    const multiSolveLabel = document.createElement("span");
    multiSolveLabel.textContent = "Multi Solve";
    multiSolveButton.append(multiSolveIcon, multiSolveLabel);
    multiSolveButton.setAttribute(
      "aria-label",
      "Multi Solve (repeat challenge submissions)",
    );
    multiSolveButton.addEventListener("click", async (event) => {
      try {
        event.preventDefault();
        event.stopPropagation();
      } catch {}
      await openMultiSolveOverlay();
    });
    syncMultiSolveButtonForChallenge(
      multiSolveButton,
      challenge ?? currentChallenge,
    );

    const secondaryRow = document.createElement("div");
    secondaryRow.className = "ea-data-solve-wrapper__secondary";
    secondaryRow.append(multiSolveButton, settingsButton);
    wrapper.append(button);
    wrapper.append(secondaryRow);
    root.append(wrapper);

    view.__eaDataSolveWrapper = wrapper;
    view.__eaDataSolveButton = button;
    view.__eaDataMultiSolveButton = multiSolveButton;
  };

  const cleanupSolveButton = (view) => {
    if (!view) return;
    view.__eaDataSolveButton?.remove?.();
    view.__eaDataSolveWrapper?.remove?.();
    view.__eaDataSolveButton = null;
    view.__eaDataSolveWrapper = null;
    view.__eaDataMultiSolveButton = null;
  };

  // Relay log messages to the content-script isolated world via postMessage.
  // EA overrides console in the page world so direct console.log is invisible.
  // The content-script listener picks up EA_DATA_LOG and logs via native console.
  const _log = (...args) => {
    try {
      if (!window.__eaDataPageLog) window.__eaDataPageLog = [];
      window.__eaDataPageLog.push({ at: Date.now(), args });
    } catch {}
    try {
      window.postMessage({ type: "EA_DATA_LOG", args }, "*");
    } catch {}
  };

  const log = (level, ...args) => {
    if (level === "debug" && !debugEnabled) return;
    _log(...args);
  };

  const logSolverDebugResult = (label, result, extra = null) => {
    if (!debugEnabled) return;
    const stats = result?.stats ?? null;
    _log("[EA Data] Solver debug state", {
      label: label ?? "solve",
      ...(extra && typeof extra === "object" ? extra : {}),
      debugEnabled: stats?.debugEnabled ?? null,
      solverVersion: stats?.solverVersion ?? null,
      debugLogLength: stats?.debugLog?.length ?? 0,
    });
    if (stats?.debugLog?.length) {
      _log("[EA Data] Solver debug log", stats.debugLog);
    }
  };

  const clampInt = (value, min, max) => {
    const numeric = readNumeric(value);
    if (numeric == null) return null;
    const rounded = Math.round(numeric);
    return Math.max(min, Math.min(max, rounded));
  };

  const normalizeRatingRange = (range) => {
    const raw = range && typeof range === "object" ? range : {};
    let ratingMin = clampInt(
      raw.ratingMin ?? raw.min ?? raw.minRating ?? raw.min_rating,
      0,
      99,
    );
    let ratingMax = clampInt(
      raw.ratingMax ?? raw.max ?? raw.maxRating ?? raw.max_rating,
      0,
      99,
    );
    if (ratingMin == null) ratingMin = 0;
    if (ratingMax == null) ratingMax = 99;
    if (ratingMin > ratingMax) {
      const tmp = ratingMin;
      ratingMin = ratingMax;
      ratingMax = tmp;
    }
    return { ratingMin, ratingMax };
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

  const normalizeBooleanSetting = (value, fallback = false) => {
    const parsed = readOptionalBoolean(value);
    if (parsed == null) return Boolean(fallback);
    return parsed;
  };

  const readPersistedDebugEnabled = () => {
    try {
      const windowValue = readOptionalBoolean(
        window?.[DEBUG_ENABLED_STATE_KEY] ?? null,
      );
      if (windowValue != null) return windowValue;
    } catch {}
    try {
      const storageValue = readOptionalBoolean(
        localStorage?.getItem?.(DEBUG_ENABLED_STORAGE_KEY) ?? null,
      );
      if (storageValue != null) return storageValue;
    } catch {}
    try {
      const sessionValue = readOptionalBoolean(
        sessionStorage?.getItem?.(DEBUG_ENABLED_STORAGE_KEY) ?? null,
      );
      if (sessionValue != null) return sessionValue;
    } catch {}
    return false;
  };

  const persistDebugEnabled = (enabled) => {
    const next = Boolean(enabled);
    try {
      window[DEBUG_ENABLED_STATE_KEY] = next;
    } catch {}
    try {
      localStorage?.setItem?.(DEBUG_ENABLED_STORAGE_KEY, next ? "1" : "0");
    } catch {}
    try {
      sessionStorage?.setItem?.(DEBUG_ENABLED_STORAGE_KEY, next ? "1" : "0");
    } catch {}
    return next;
  };

  debugEnabled = readPersistedDebugEnabled();

  const normalizePlayerId = (value) => {
    if (value == null) return null;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) return null;
      const rounded = Math.trunc(value);
      return rounded === 0 ? null : String(rounded);
    }
    if (typeof value === "string") {
      const trimmed = value.trim();
      return trimmed ? trimmed : null;
    }
    return null;
  };

  const normalizePlayerIdList = (value, fallback = []) => {
    const source =
      value instanceof Set
        ? Array.from(value)
        : Array.isArray(value)
          ? value
          : value == null
            ? null
            : [value];
    if (!source) {
      return normalizePlayerIdList(Array.isArray(fallback) ? fallback : []);
    }
    const seen = new Set();
    const normalized = [];
    for (const entry of source) {
      const id = normalizePlayerId(entry);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      normalized.push(id);
    }
    return normalized;
  };

  const readOptionalPlayerIdList = (value) => {
    if (value == null) return null;
    if (Array.isArray(value) || value instanceof Set) {
      return normalizePlayerIdList(value);
    }
    if (typeof value === "string" || typeof value === "number") {
      const single = normalizePlayerId(value);
      return single ? [single] : [];
    }
    return null;
  };

  const normalizeLeagueId = (value) => {
    if (value == null) return null;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) return null;
      const rounded = Math.trunc(value);
      return rounded <= 0 ? null : String(rounded);
    }
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (!trimmed) return null;
      if (/^-?\d+$/.test(trimmed)) {
        const numeric = parseInt(trimmed, 10);
        if (!Number.isFinite(numeric) || numeric <= 0) return null;
        return String(numeric);
      }
      return trimmed;
    }
    return null;
  };

  const normalizeLeagueIdList = (value, fallback = []) => {
    const source =
      value instanceof Set
        ? Array.from(value)
        : Array.isArray(value)
          ? value
          : value == null
            ? null
            : [value];
    if (!source) {
      return normalizeLeagueIdList(Array.isArray(fallback) ? fallback : []);
    }
    const seen = new Set();
    const normalized = [];
    for (const entry of source) {
      const id = normalizeLeagueId(entry);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      normalized.push(id);
    }
    return normalized;
  };

  const readOptionalLeagueIdList = (value) => {
    if (value == null) return null;
    if (Array.isArray(value) || value instanceof Set) {
      return normalizeLeagueIdList(value);
    }
    if (typeof value === "string" || typeof value === "number") {
      const single = normalizeLeagueId(value);
      return single ? [single] : [];
    }
    return null;
  };

  const normalizeNationId = (value) => {
    if (value == null) return null;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) return null;
      const rounded = Math.trunc(value);
      return rounded <= 0 ? null : String(rounded);
    }
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (!trimmed) return null;
      if (/^-?\d+$/.test(trimmed)) {
        const numeric = parseInt(trimmed, 10);
        if (!Number.isFinite(numeric) || numeric <= 0) return null;
        return String(numeric);
      }
      return trimmed;
    }
    return null;
  };

  const normalizeNationIdList = (value, fallback = []) => {
    const source =
      value instanceof Set
        ? Array.from(value)
        : Array.isArray(value)
          ? value
          : value == null
            ? null
            : [value];
    if (!source) {
      return normalizeNationIdList(Array.isArray(fallback) ? fallback : []);
    }
    const seen = new Set();
    const normalized = [];
    for (const entry of source) {
      const id = normalizeNationId(entry);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      normalized.push(id);
    }
    return normalized;
  };

  const readOptionalNationIdList = (value) => {
    if (value == null) return null;
    if (Array.isArray(value) || value instanceof Set) {
      return normalizeNationIdList(value);
    }
    if (typeof value === "string" || typeof value === "number") {
      const single = normalizeNationId(value);
      return single ? [single] : [];
    }
    return null;
  };

  const SETTINGS_PATHS = Object.freeze({
    SOLVER_RATING_RANGE: "solver.ratingRange",
    SOLVER_USE_UNASSIGNED: "solver.useUnassigned",
    SOLVER_ONLY_STORAGE: "solver.onlyStorage",
    SOLVER_EXCLUDE_TRADABLE: "solver.excludeTradable",
    SOLVER_EXCLUDE_SPECIAL: "solver.excludeSpecial",
    SOLVER_USE_EVOLUTION_PLAYERS: "solver.useEvolutionPlayers",
    SOLVER_EXCLUDED_PLAYER_IDS: "solver.excludedPlayerIds",
    SOLVER_EXCLUDED_LEAGUE_IDS: "solver.excludedLeagueIds",
    SOLVER_EXCLUDED_NATION_IDS: "solver.excludedNationIds",
  });
  const SETTINGS_DEFAULTS = Object.freeze({
    solver: Object.freeze({
      ratingRange: Object.freeze({
        ratingMin: 0,
        ratingMax: 99,
      }),
      useUnassigned: true,
      onlyStorage: false,
      excludeTradable: true,
      excludeSpecial: false,
      useEvolutionPlayers: false,
      excludedPlayerIds: Object.freeze([]),
      excludedLeagueIds: Object.freeze([]),
      excludedNationIds: Object.freeze([]),
    }),
  });
  const SOLVER_TOGGLE_FIELDS = Object.freeze([
    Object.freeze({
      key: "useUnassigned",
      path: SETTINGS_PATHS.SOLVER_USE_UNASSIGNED,
      idSuffix: "use-unassigned",
      label: "Use Unassigned",
      help: "Allow duplicate items from Unassigned and transfer pile to bypass pool filters.",
      scopes: Object.freeze(["challenge", "global", "multi", "set"]),
      legacyKeys: Object.freeze(["useDupes"]),
    }),
    Object.freeze({
      key: "onlyStorage",
      path: SETTINGS_PATHS.SOLVER_ONLY_STORAGE,
      idSuffix: "only-storage",
      label: "Only Storage",
      help: "Restrict normal pool selection to SBC storage items.",
      scopes: Object.freeze(["challenge", "global", "multi", "set"]),
      legacyKeys: Object.freeze([]),
    }),
    Object.freeze({
      key: "excludeTradable",
      path: SETTINGS_PATHS.SOLVER_EXCLUDE_TRADABLE,
      idSuffix: "exclude-tradable",
      label: "Exclude Tradable",
      help: "Avoid using tradable players unless they are locked into the squad.",
      scopes: Object.freeze(["challenge", "global", "multi", "set"]),
      legacyKeys: Object.freeze([]),
    }),
    Object.freeze({
      key: "excludeSpecial",
      path: SETTINGS_PATHS.SOLVER_EXCLUDE_SPECIAL,
      idSuffix: "exclude-special",
      label: "Exclude Special",
      help: "Prefer non-special cards for cheaper submissions.",
      scopes: Object.freeze(["challenge", "global", "multi", "set"]),
      legacyKeys: Object.freeze([]),
    }),
    Object.freeze({
      key: "useEvolutionPlayers",
      path: SETTINGS_PATHS.SOLVER_USE_EVOLUTION_PLAYERS,
      idSuffix: "use-evolution-players",
      label: "Use Evolution Players",
      help: "Allow evolution cards in generated solutions. When off, evolution cards are blocked (including unassigned duplicates) except already locked required players.",
      scopes: Object.freeze(["challenge", "global", "multi", "set"]),
      legacyKeys: Object.freeze([]),
    }),
  ]);

  const getSolverToggleFieldDefsForScope = (scope = null) => {
    const scopeKey = scope == null ? null : String(scope).trim().toLowerCase();
    return SOLVER_TOGGLE_FIELDS.filter((field) => {
      const fieldScopes = Array.isArray(field?.scopes) ? field.scopes : [];
      if (!fieldScopes.length || !scopeKey) return true;
      return fieldScopes.includes(scopeKey);
    });
  };

  const getSolverToggleFieldByPath = (path) =>
    SOLVER_TOGGLE_FIELDS.find((field) => field?.path === path) ?? null;

  const getSolverToggleRawValue = (value, field) => {
    if (!value || typeof value !== "object" || !field) return undefined;
    if (field.key in value) return value[field.key];
    for (const legacyKey of field.legacyKeys ?? []) {
      if (legacyKey in value) return value[legacyKey];
    }
    return undefined;
  };

  const getDefaultSolverPoolSettings = () => {
    const defaults = {};
    for (const field of SOLVER_TOGGLE_FIELDS) {
      defaults[field.key] = getSettingDefault(field.path);
    }
    return defaults;
  };

  const normalizeSolverPoolSettingsInput = (value, fallback = null) => {
    const raw = value && typeof value === "object" ? value : {};
    const fallbackSource =
      fallback && typeof fallback === "object"
        ? fallback
        : getDefaultSolverPoolSettings();
    const normalized = {};
    for (const field of SOLVER_TOGGLE_FIELDS) {
      const rawValue = getSolverToggleRawValue(raw, field);
      normalized[field.key] = normalizeBooleanSetting(
        rawValue,
        fallbackSource?.[field.key] ?? getSettingDefault(field.path),
      );
    }
    return normalized;
  };

  const renderSolverToggleFields = ({ scope = null, idPrefix = "" } = {}) => {
    const defs = getSolverToggleFieldDefsForScope(scope);
    if (!defs.length) return "";
    return defs
      .map((field) => {
        const id = `${idPrefix}${field.idSuffix}`;
        return `
          <label class="ea-data-toggle-row" for="${id}">
            <span class="ea-data-toggle-text">
              <span class="ea-data-toggle-title">${field.label}</span>
              <span class="ea-data-toggle-icon-wrap" aria-label="Help">
                <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2.5" fill="none" class="ea-data-toggle-info-icon" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><path d="M12 16v-4"></path><path d="M12 8h.01"></path></svg>
                <div class="ea-data-toggle-tooltip">${field.help}</div>
              </span>
            </span>
            <div class="ea-data-toggle-switch">
              <input id="${id}" type="checkbox" />
              <div class="ea-data-toggle-slider"></div>
            </div>
          </label>
        `;
      })
      .join("");
  };

  const createSolverToggleBinder = ({
    root = null,
    scope = null,
    idPrefix = "",
  } = {}) => {
    const defs = getSolverToggleFieldDefsForScope(scope);
    const controls = defs.map((field) => ({
      field,
      input: root?.querySelector?.(`#${idPrefix}${field.idSuffix}`) ?? null,
    }));
    const readCheckedSnapshot = () => {
      const snapshot = {};
      for (const { field, input } of controls) {
        if (!field) continue;
        snapshot[field.key] = Boolean(input?.checked);
      }
      return snapshot;
    };
    const setValues = (settings, fallback = null) => {
      const normalized = normalizeSolverPoolSettingsInput(
        settings,
        fallback ?? readCheckedSnapshot(),
      );
      for (const { field, input } of controls) {
        if (!field || !input) continue;
        try {
          input.checked = Boolean(normalized[field.key]);
        } catch {}
      }
      return normalized;
    };
    const getValues = (fallback = null) =>
      normalizeSolverPoolSettingsInput(
        readCheckedSnapshot(),
        fallback ?? readCheckedSnapshot(),
      );
    const setDisabled = (disabled) => {
      const nextDisabled = Boolean(disabled);
      for (const { input } of controls) {
        if (!input) continue;
        try {
          input.disabled = nextDisabled;
        } catch {}
      }
    };
    return {
      defs,
      controls,
      setValues,
      getValues,
      setDisabled,
    };
  };

  const clonePlainObject = (value) => {
    try {
      return JSON.parse(JSON.stringify(value ?? {}));
    } catch {
      return {};
    }
  };

  const splitSettingPath = (path) =>
    String(path ?? "")
      .split(".")
      .map((part) => part.trim())
      .filter(Boolean);

  const getSettingByPath = (obj, path) => {
    const parts = splitSettingPath(path);
    if (!parts.length) return undefined;
    let cursor = obj;
    for (const part of parts) {
      if (!cursor || typeof cursor !== "object" || !(part in cursor)) {
        return undefined;
      }
      cursor = cursor[part];
    }
    return cursor;
  };

  const hasSettingByPath = (obj, path) => {
    const parts = splitSettingPath(path);
    if (!parts.length) return false;
    let cursor = obj;
    for (const part of parts) {
      if (!cursor || typeof cursor !== "object" || !(part in cursor)) {
        return false;
      }
      cursor = cursor[part];
    }
    return true;
  };

  const setSettingByPathMut = (target, path, value) => {
    const parts = splitSettingPath(path);
    if (!parts.length || !target || typeof target !== "object") return target;
    let cursor = target;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const part = parts[i];
      if (!cursor[part] || typeof cursor[part] !== "object") cursor[part] = {};
      cursor = cursor[part];
    }
    cursor[parts[parts.length - 1]] = value;
    return target;
  };

  const hasAnyOwnKeys = (value) =>
    Boolean(
      value &&
      typeof value === "object" &&
      Object.keys(value).length > 0 &&
      value.constructor === Object,
    );

  const readOptionalRatingRange = (value) => {
    if (!value || typeof value !== "object") return null;
    const hasRangeKeys = [
      "ratingMin",
      "ratingMax",
      "min",
      "max",
      "minRating",
      "maxRating",
      "min_rating",
      "max_rating",
    ].some((key) => value?.[key] != null);
    if (!hasRangeKeys) return null;
    return normalizeRatingRange(value);
  };

  const normalizeScopeSettings = (value, { legacyRange = false } = {}) => {
    const scope = value && typeof value === "object" ? value : {};
    const solverRaw =
      scope?.solver && typeof scope.solver === "object" ? scope.solver : {};

    let ratingRange = readOptionalRatingRange(solverRaw?.ratingRange);
    if (!ratingRange && legacyRange) {
      ratingRange = readOptionalRatingRange(scope);
    }

    const normalized = {};
    const solver = {};
    if (ratingRange) solver.ratingRange = ratingRange;
    for (const field of SOLVER_TOGGLE_FIELDS) {
      const solverValue = getSolverToggleRawValue(solverRaw, field);
      const legacyValue = legacyRange
        ? getSolverToggleRawValue(scope, field)
        : undefined;
      const normalizedValue = readOptionalBoolean(solverValue ?? legacyValue);
      if (normalizedValue == null) continue;
      solver[field.key] = normalizedValue;
    }
    const excludedRaw =
      solverRaw?.excludedPlayerIds ??
      solverRaw?.excludedPlayers ??
      (legacyRange
        ? (scope?.excludedPlayerIds ?? scope?.excludedPlayers)
        : null);
    const excludedPlayerIds = readOptionalPlayerIdList(excludedRaw);
    if (excludedPlayerIds != null) {
      solver.excludedPlayerIds = excludedPlayerIds;
    }
    const excludedLeagueRaw =
      solverRaw?.excludedLeagueIds ??
      solverRaw?.excludedLeagues ??
      (legacyRange
        ? (scope?.excludedLeagueIds ?? scope?.excludedLeagues)
        : null);
    const excludedLeagueIds = readOptionalLeagueIdList(excludedLeagueRaw);
    if (excludedLeagueIds != null) {
      solver.excludedLeagueIds = excludedLeagueIds;
    }
    const excludedNationRaw =
      solverRaw?.excludedNationIds ??
      solverRaw?.excludedNations ??
      (legacyRange
        ? (scope?.excludedNationIds ?? scope?.excludedNations)
        : null);
    const excludedNationIds = readOptionalNationIdList(excludedNationRaw);
    if (excludedNationIds != null) {
      solver.excludedNationIds = excludedNationIds;
    }
    if (hasAnyOwnKeys(solver)) normalized.solver = solver;
    return normalized;
  };

  const getSettingDefault = (path) => {
    if (path === SETTINGS_PATHS.SOLVER_RATING_RANGE) {
      return normalizeRatingRange(SETTINGS_DEFAULTS.solver.ratingRange);
    }
    const toggleField = getSolverToggleFieldByPath(path);
    if (toggleField) {
      return Boolean(SETTINGS_DEFAULTS?.solver?.[toggleField.key]);
    }
    if (path === SETTINGS_PATHS.SOLVER_EXCLUDED_PLAYER_IDS) {
      return normalizePlayerIdList(
        SETTINGS_DEFAULTS?.solver?.excludedPlayerIds,
      );
    }
    if (path === SETTINGS_PATHS.SOLVER_EXCLUDED_LEAGUE_IDS) {
      return normalizeLeagueIdList(
        SETTINGS_DEFAULTS?.solver?.excludedLeagueIds,
      );
    }
    if (path === SETTINGS_PATHS.SOLVER_EXCLUDED_NATION_IDS) {
      return normalizeNationIdList(
        SETTINGS_DEFAULTS?.solver?.excludedNationIds,
      );
    }
    return null;
  };

  const normalizeSettingValueForPath = (path, value) => {
    if (path === SETTINGS_PATHS.SOLVER_RATING_RANGE) {
      return normalizeRatingRange(value);
    }
    const toggleField = getSolverToggleFieldByPath(path);
    if (toggleField) {
      return normalizeBooleanSetting(
        value,
        getSettingDefault(toggleField.path),
      );
    }
    if (path === SETTINGS_PATHS.SOLVER_EXCLUDED_PLAYER_IDS) {
      return normalizePlayerIdList(
        value,
        getSettingDefault(SETTINGS_PATHS.SOLVER_EXCLUDED_PLAYER_IDS),
      );
    }
    if (path === SETTINGS_PATHS.SOLVER_EXCLUDED_LEAGUE_IDS) {
      return normalizeLeagueIdList(
        value,
        getSettingDefault(SETTINGS_PATHS.SOLVER_EXCLUDED_LEAGUE_IDS),
      );
    }
    if (path === SETTINGS_PATHS.SOLVER_EXCLUDED_NATION_IDS) {
      return normalizeNationIdList(
        value,
        getSettingDefault(SETTINGS_PATHS.SOLVER_EXCLUDED_NATION_IDS),
      );
    }
    return value;
  };

  const normalizePreferences = (value) => {
    const raw = value && typeof value === "object" ? value : {};
    const versionRaw = readNumeric(raw?.version);
    const isLegacy = versionRaw == null || versionRaw < 2;

    const global = normalizeScopeSettings(raw?.global, {
      legacyRange: isLegacy,
    });
    const globalDefaults = [
      SETTINGS_PATHS.SOLVER_RATING_RANGE,
      ...SOLVER_TOGGLE_FIELDS.map((field) => field.path),
      SETTINGS_PATHS.SOLVER_EXCLUDED_PLAYER_IDS,
      SETTINGS_PATHS.SOLVER_EXCLUDED_LEAGUE_IDS,
      SETTINGS_PATHS.SOLVER_EXCLUDED_NATION_IDS,
    ];
    for (const settingPath of globalDefaults) {
      if (hasSettingByPath(global, settingPath)) continue;
      setSettingByPathMut(global, settingPath, getSettingDefault(settingPath));
    }

    const perChallengeRaw =
      raw?.perChallenge && typeof raw.perChallenge === "object"
        ? raw.perChallenge
        : {};
    const perChallenge = {};
    for (const key of Object.keys(perChallengeRaw)) {
      const normalizedScope = normalizeScopeSettings(perChallengeRaw[key], {
        legacyRange: isLegacy,
      });
      if (!hasAnyOwnKeys(normalizedScope)) continue;
      perChallenge[String(key)] = normalizedScope;
    }

    return {
      version: 2,
      global,
      perChallenge,
    };
  };

  const callPrefBridge = (type, payload, timeoutMs = PREF_BRIDGE_TIMEOUT_MS) =>
    new Promise((resolve, reject) => {
      const requestId = crypto.randomUUID();
      const timer = setTimeout(
        () => {
          prefBridgeRequests.delete(requestId);
          reject(new Error("Pref bridge timeout"));
        },
        Math.max(500, readNumeric(timeoutMs) ?? PREF_BRIDGE_TIMEOUT_MS),
      );

      prefBridgeRequests.set(requestId, {
        resolve: (data) => {
          clearTimeout(timer);
          resolve(data);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });

      const message = {
        type,
        requestId,
        source: SOLVER_BRIDGE_SOURCE,
        ...(payload ?? {}),
      };
      try {
        window.postMessage(message, "*");
      } catch (error) {
        prefBridgeRequests.delete(requestId);
        clearTimeout(timer);
        reject(error);
      }
    });

  const prefGet = async (key) => callPrefBridge(PREF_BRIDGE_GET, { key });
  const prefSet = async (key, value) =>
    callPrefBridge(PREF_BRIDGE_SET, { key, value });

  const getPreferences = async ({ force = false } = {}) => {
    const cached = preferencesCache;
    if (!force && cached && Date.now() - cached.at < PREF_CACHE_TTL_MS) {
      return cached.value;
    }
    if (preferencesInFlight) return preferencesInFlight;

    preferencesInFlight = (async () => {
      let raw = null;
      try {
        raw = await prefGet(PREF_STORAGE_KEY);
      } catch (error) {
        raw = null;
        log("debug", "[EA Data] Pref get failed", error);
      }
      const normalized = normalizePreferences(raw);
      preferencesCache = { at: Date.now(), value: normalized };
      return normalized;
    })()
      .catch((error) => {
        preferencesCache = {
          at: Date.now(),
          value: normalizePreferences(null),
        };
        throw error;
      })
      .finally(() => {
        preferencesInFlight = null;
      });

    return preferencesInFlight;
  };

  const savePreferences = async (next) => {
    const normalized = normalizePreferences(next);
    await prefSet(PREF_STORAGE_KEY, normalized);
    preferencesCache = { at: Date.now(), value: normalized };
    return normalized;
  };

  const resolveEffectiveSettingFromPreferences = (
    prefs,
    { challengeId, sessionScope, path, fallback } = {},
  ) => {
    const key = challengeId == null ? null : String(challengeId);
    const hasSession = hasSettingByPath(sessionScope, path);
    const hasLocal =
      key != null && hasSettingByPath(prefs?.perChallenge?.[key], path);
    const hasGlobal = hasSettingByPath(prefs?.global, path);

    let value = fallback;
    if (hasSession) value = getSettingByPath(sessionScope, path);
    else if (hasLocal)
      value = getSettingByPath(prefs?.perChallenge?.[key], path);
    else if (hasGlobal) value = getSettingByPath(prefs?.global, path);

    return normalizeSettingValueForPath(path, value);
  };

  const getEffectiveSetting = async ({
    challengeId = null,
    sessionScope = null,
    path,
    fallback,
  } = {}) => {
    const prefs = await getPreferences();
    const fallbackValue =
      fallback === undefined ? getSettingDefault(path) : fallback;
    return resolveEffectiveSettingFromPreferences(prefs, {
      challengeId,
      sessionScope,
      path,
      fallback: fallbackValue,
    });
  };

  const setGlobalSetting = async (path, value) => {
    const prefs = await getPreferences();
    const next = clonePlainObject(prefs);
    if (!next.global || typeof next.global !== "object") next.global = {};
    setSettingByPathMut(
      next.global,
      path,
      normalizeSettingValueForPath(path, value),
    );
    return savePreferences(next);
  };

  const setChallengeSetting = async (challengeId, path, value) => {
    if (challengeId == null) throw new Error("Missing challengeId");
    const prefs = await getPreferences();
    const next = clonePlainObject(prefs);
    if (!next.perChallenge || typeof next.perChallenge !== "object") {
      next.perChallenge = {};
    }
    const key = String(challengeId);
    const scope =
      next.perChallenge[key] && typeof next.perChallenge[key] === "object"
        ? next.perChallenge[key]
        : {};
    setSettingByPathMut(scope, path, normalizeSettingValueForPath(path, value));
    next.perChallenge[key] = scope;
    return savePreferences(next);
  };

  const getDefaultSolverSettings = () => ({
    ratingRange: getSettingDefault(SETTINGS_PATHS.SOLVER_RATING_RANGE),
    ...getDefaultSolverPoolSettings(),
    excludedPlayerIds: getSettingDefault(
      SETTINGS_PATHS.SOLVER_EXCLUDED_PLAYER_IDS,
    ),
    excludedLeagueIds: getSettingDefault(
      SETTINGS_PATHS.SOLVER_EXCLUDED_LEAGUE_IDS,
    ),
    excludedNationIds: getSettingDefault(
      SETTINGS_PATHS.SOLVER_EXCLUDED_NATION_IDS,
    ),
  });

  const normalizeSolverSettingsInput = (value, fallback = null) => {
    const fallbackSettings =
      fallback && typeof fallback === "object"
        ? fallback
        : getDefaultSolverSettings();
    const raw = value && typeof value === "object" ? value : {};
    const ratingRangeRaw =
      readOptionalRatingRange(raw?.ratingRange) ?? readOptionalRatingRange(raw);
    const fallbackRange =
      readOptionalRatingRange(fallbackSettings?.ratingRange) ??
      getSettingDefault(SETTINGS_PATHS.SOLVER_RATING_RANGE);
    const fallbackPool = normalizeSolverPoolSettingsInput(
      fallbackSettings,
      getDefaultSolverPoolSettings(),
    );
    const normalizedPool = normalizeSolverPoolSettingsInput(raw, fallbackPool);
    const fallbackExcludedPlayerIds = normalizePlayerIdList(
      fallbackSettings?.excludedPlayerIds,
      getSettingDefault(SETTINGS_PATHS.SOLVER_EXCLUDED_PLAYER_IDS),
    );
    const excludedPlayerIds = normalizePlayerIdList(
      raw?.excludedPlayerIds,
      fallbackExcludedPlayerIds,
    );
    const fallbackExcludedLeagueIds = normalizeLeagueIdList(
      fallbackSettings?.excludedLeagueIds,
      getSettingDefault(SETTINGS_PATHS.SOLVER_EXCLUDED_LEAGUE_IDS),
    );
    const excludedLeagueIds = normalizeLeagueIdList(
      raw?.excludedLeagueIds,
      fallbackExcludedLeagueIds,
    );
    const fallbackExcludedNationIds = normalizeNationIdList(
      fallbackSettings?.excludedNationIds,
      getSettingDefault(SETTINGS_PATHS.SOLVER_EXCLUDED_NATION_IDS),
    );
    const excludedNationIds = normalizeNationIdList(
      raw?.excludedNationIds ?? raw?.excludedNations,
      fallbackExcludedNationIds,
    );
    return {
      ratingRange: normalizeRatingRange(ratingRangeRaw ?? fallbackRange),
      ...normalizedPool,
      excludedPlayerIds,
      excludedLeagueIds,
      excludedNationIds,
    };
  };

  const resolveSolverSettingsFromPreferences = (
    prefs,
    { challengeId = null, sessionScope = null, fallback = null } = {},
  ) => {
    const defaults = normalizeSolverSettingsInput(fallback);
    const resolved = {
      ratingRange: resolveEffectiveSettingFromPreferences(prefs, {
        challengeId,
        sessionScope,
        path: SETTINGS_PATHS.SOLVER_RATING_RANGE,
        fallback: defaults.ratingRange,
      }),
    };
    for (const field of SOLVER_TOGGLE_FIELDS) {
      resolved[field.key] = resolveEffectiveSettingFromPreferences(prefs, {
        challengeId,
        sessionScope,
        path: field.path,
        fallback: defaults[field.key],
      });
    }
    const globalExcludedPlayerIds = getSettingByPath(
      prefs?.global,
      SETTINGS_PATHS.SOLVER_EXCLUDED_PLAYER_IDS,
    );
    resolved.excludedPlayerIds = normalizePlayerIdList(
      globalExcludedPlayerIds,
      defaults.excludedPlayerIds,
    );
    const globalExcludedLeagueIds = getSettingByPath(
      prefs?.global,
      SETTINGS_PATHS.SOLVER_EXCLUDED_LEAGUE_IDS,
    );
    resolved.excludedLeagueIds = normalizeLeagueIdList(
      globalExcludedLeagueIds,
      defaults.excludedLeagueIds,
    );
    const globalExcludedNationIds = getSettingByPath(
      prefs?.global,
      SETTINGS_PATHS.SOLVER_EXCLUDED_NATION_IDS,
    );
    resolved.excludedNationIds = normalizeNationIdList(
      globalExcludedNationIds,
      defaults.excludedNationIds,
    );
    return normalizeSolverSettingsInput(resolved, defaults);
  };

  const getSolverSettingsForChallenge = async (
    challengeId,
    { sessionScope = null } = {},
  ) => {
    const prefs = await getPreferences();
    return resolveSolverSettingsFromPreferences(prefs, {
      challengeId,
      sessionScope,
    });
  };

  const setGlobalSolverSettings = async (settings) => {
    const normalized = normalizeSolverSettingsInput(settings);
    const prefs = await getPreferences();
    const next = clonePlainObject(prefs);
    if (!next.global || typeof next.global !== "object") next.global = {};
    setSettingByPathMut(
      next.global,
      SETTINGS_PATHS.SOLVER_RATING_RANGE,
      normalized.ratingRange,
    );
    for (const field of SOLVER_TOGGLE_FIELDS) {
      setSettingByPathMut(next.global, field.path, normalized[field.key]);
    }
    setSettingByPathMut(
      next.global,
      SETTINGS_PATHS.SOLVER_EXCLUDED_PLAYER_IDS,
      normalizePlayerIdList(normalized.excludedPlayerIds),
    );
    setSettingByPathMut(
      next.global,
      SETTINGS_PATHS.SOLVER_EXCLUDED_LEAGUE_IDS,
      normalizeLeagueIdList(normalized.excludedLeagueIds),
    );
    setSettingByPathMut(
      next.global,
      SETTINGS_PATHS.SOLVER_EXCLUDED_NATION_IDS,
      normalizeNationIdList(normalized.excludedNationIds),
    );
    const saved = await savePreferences(next);
    setExcludedPlayerIdsCache(normalized.excludedPlayerIds);
    setExcludedLeagueIdsCache(normalized.excludedLeagueIds);
    setExcludedNationIdsCache(normalized.excludedNationIds);
    return saved;
  };

  const setChallengeSolverSettings = async (challengeId, settings) => {
    if (challengeId == null) throw new Error("Missing challengeId");
    const normalized = normalizeSolverSettingsInput(settings);
    const prefs = await getPreferences();
    const next = clonePlainObject(prefs);
    if (!next.perChallenge || typeof next.perChallenge !== "object") {
      next.perChallenge = {};
    }
    const key = String(challengeId);
    const scope =
      next.perChallenge[key] && typeof next.perChallenge[key] === "object"
        ? next.perChallenge[key]
        : {};
    setSettingByPathMut(
      scope,
      SETTINGS_PATHS.SOLVER_RATING_RANGE,
      normalized.ratingRange,
    );
    for (const field of SOLVER_TOGGLE_FIELDS) {
      setSettingByPathMut(scope, field.path, normalized[field.key]);
    }
    next.perChallenge[key] = scope;
    return savePreferences(next);
  };

  const resetGlobalSolverSettings = async () =>
    setGlobalSolverSettings(getDefaultSolverSettings());

  const getRatingRangeForChallenge = async (
    challengeId,
    { sessionScope = null } = {},
  ) =>
    (
      await getSolverSettingsForChallenge(challengeId, {
        sessionScope,
      })
    ).ratingRange;

  const setRatingRangeForChallenge = async (challengeId, range) =>
    setChallengeSetting(
      challengeId,
      SETTINGS_PATHS.SOLVER_RATING_RANGE,
      normalizeRatingRange(range),
    );

  const setGlobalRatingRange = async (range) =>
    setGlobalSetting(
      SETTINGS_PATHS.SOLVER_RATING_RANGE,
      normalizeRatingRange(range),
    );

  const resetGlobalRatingRange = async () =>
    setGlobalRatingRange(getSettingDefault(SETTINGS_PATHS.SOLVER_RATING_RANGE));

  const setExcludedPlayerIdsCache = (ids) => {
    excludedPlayerIdsCache = normalizePlayerIdList(
      ids,
      getSettingDefault(SETTINGS_PATHS.SOLVER_EXCLUDED_PLAYER_IDS),
    );
    excludedPlayerIdsCacheLoaded = true;
    return excludedPlayerIdsCache;
  };

  const peekExcludedPlayerIdsCache = () =>
    excludedPlayerIdsCacheLoaded ? (excludedPlayerIdsCache ?? []) : null;

  const ensureExcludedPlayerIdsCache = async ({ force = false } = {}) => {
    if (!force && excludedPlayerIdsCacheLoaded) {
      return excludedPlayerIdsCache ?? [];
    }
    if (!force && excludedPlayerIdsCacheInFlight) {
      return excludedPlayerIdsCacheInFlight;
    }
    excludedPlayerIdsCacheInFlight = (async () => {
      const ids = normalizePlayerIdList(
        await getEffectiveSetting({
          challengeId: null,
          path: SETTINGS_PATHS.SOLVER_EXCLUDED_PLAYER_IDS,
          fallback: getSettingDefault(
            SETTINGS_PATHS.SOLVER_EXCLUDED_PLAYER_IDS,
          ),
        }),
        getSettingDefault(SETTINGS_PATHS.SOLVER_EXCLUDED_PLAYER_IDS),
      );
      return setExcludedPlayerIdsCache(ids);
    })().finally(() => {
      excludedPlayerIdsCacheInFlight = null;
    });
    return excludedPlayerIdsCacheInFlight;
  };

  const getGlobalExcludedPlayerIds = async ({ forceRefresh = false } = {}) =>
    normalizePlayerIdList(
      await ensureExcludedPlayerIdsCache({ force: forceRefresh }),
      getSettingDefault(SETTINGS_PATHS.SOLVER_EXCLUDED_PLAYER_IDS),
    );

  const setGlobalExcludedPlayerIds = async (ids) => {
    const normalized = normalizePlayerIdList(
      ids,
      getSettingDefault(SETTINGS_PATHS.SOLVER_EXCLUDED_PLAYER_IDS),
    );
    await setGlobalSetting(
      SETTINGS_PATHS.SOLVER_EXCLUDED_PLAYER_IDS,
      normalized,
    );
    return setExcludedPlayerIdsCache(normalized);
  };

  const toggleGlobalExcludedPlayerId = async (itemId, excluded = true) => {
    const normalizedId = normalizePlayerId(itemId);
    if (!normalizedId) throw new Error("Missing player item id");
    const current = await getGlobalExcludedPlayerIds();
    const set = new Set(current);
    if (excluded) set.add(normalizedId);
    else set.delete(normalizedId);
    return setGlobalExcludedPlayerIds(Array.from(set));
  };

  const clearGlobalExcludedPlayerIds = async () =>
    setGlobalExcludedPlayerIds([]);

  const setExcludedLeagueIdsCache = (ids) => {
    excludedLeagueIdsCache = normalizeLeagueIdList(
      ids,
      getSettingDefault(SETTINGS_PATHS.SOLVER_EXCLUDED_LEAGUE_IDS),
    );
    excludedLeagueIdsCacheLoaded = true;
    return excludedLeagueIdsCache;
  };

  const peekExcludedLeagueIdsCache = () =>
    excludedLeagueIdsCacheLoaded ? (excludedLeagueIdsCache ?? []) : null;

  const ensureExcludedLeagueIdsCache = async ({ force = false } = {}) => {
    if (!force && excludedLeagueIdsCacheLoaded) {
      return excludedLeagueIdsCache ?? [];
    }
    if (!force && excludedLeagueIdsCacheInFlight) {
      return excludedLeagueIdsCacheInFlight;
    }
    excludedLeagueIdsCacheInFlight = (async () => {
      const ids = normalizeLeagueIdList(
        await getEffectiveSetting({
          challengeId: null,
          path: SETTINGS_PATHS.SOLVER_EXCLUDED_LEAGUE_IDS,
          fallback: getSettingDefault(
            SETTINGS_PATHS.SOLVER_EXCLUDED_LEAGUE_IDS,
          ),
        }),
        getSettingDefault(SETTINGS_PATHS.SOLVER_EXCLUDED_LEAGUE_IDS),
      );
      return setExcludedLeagueIdsCache(ids);
    })().finally(() => {
      excludedLeagueIdsCacheInFlight = null;
    });
    return excludedLeagueIdsCacheInFlight;
  };

  const getGlobalExcludedLeagueIds = async ({ forceRefresh = false } = {}) =>
    normalizeLeagueIdList(
      await ensureExcludedLeagueIdsCache({ force: forceRefresh }),
      getSettingDefault(SETTINGS_PATHS.SOLVER_EXCLUDED_LEAGUE_IDS),
    );

  const setGlobalExcludedLeagueIds = async (ids) => {
    const normalized = normalizeLeagueIdList(
      ids,
      getSettingDefault(SETTINGS_PATHS.SOLVER_EXCLUDED_LEAGUE_IDS),
    );
    await setGlobalSetting(
      SETTINGS_PATHS.SOLVER_EXCLUDED_LEAGUE_IDS,
      normalized,
    );
    return setExcludedLeagueIdsCache(normalized);
  };

  const toggleGlobalExcludedLeagueId = async (leagueId, excluded = true) => {
    const normalizedId = normalizeLeagueId(leagueId);
    if (!normalizedId) throw new Error("Missing league id");
    const current = await getGlobalExcludedLeagueIds();
    const set = new Set(current);
    if (excluded) set.add(normalizedId);
    else set.delete(normalizedId);
    return setGlobalExcludedLeagueIds(Array.from(set));
  };

  const clearGlobalExcludedLeagueIds = async () =>
    setGlobalExcludedLeagueIds([]);

  const setExcludedNationIdsCache = (ids) => {
    excludedNationIdsCache = normalizeNationIdList(
      ids,
      getSettingDefault(SETTINGS_PATHS.SOLVER_EXCLUDED_NATION_IDS),
    );
    excludedNationIdsCacheLoaded = true;
    return excludedNationIdsCache;
  };

  const peekExcludedNationIdsCache = () =>
    excludedNationIdsCacheLoaded ? (excludedNationIdsCache ?? []) : null;

  const ensureExcludedNationIdsCache = async ({ force = false } = {}) => {
    if (!force && excludedNationIdsCacheLoaded) {
      return excludedNationIdsCache ?? [];
    }
    if (!force && excludedNationIdsCacheInFlight) {
      return excludedNationIdsCacheInFlight;
    }
    excludedNationIdsCacheInFlight = (async () => {
      const ids = normalizeNationIdList(
        await getEffectiveSetting({
          challengeId: null,
          path: SETTINGS_PATHS.SOLVER_EXCLUDED_NATION_IDS,
          fallback: getSettingDefault(
            SETTINGS_PATHS.SOLVER_EXCLUDED_NATION_IDS,
          ),
        }),
        getSettingDefault(SETTINGS_PATHS.SOLVER_EXCLUDED_NATION_IDS),
      );
      return setExcludedNationIdsCache(ids);
    })().finally(() => {
      excludedNationIdsCacheInFlight = null;
    });
    return excludedNationIdsCacheInFlight;
  };

  const getGlobalExcludedNationIds = async ({ forceRefresh = false } = {}) =>
    normalizeNationIdList(
      await ensureExcludedNationIdsCache({ force: forceRefresh }),
      getSettingDefault(SETTINGS_PATHS.SOLVER_EXCLUDED_NATION_IDS),
    );

  const setGlobalExcludedNationIds = async (ids) => {
    const normalized = normalizeNationIdList(
      ids,
      getSettingDefault(SETTINGS_PATHS.SOLVER_EXCLUDED_NATION_IDS),
    );
    await setGlobalSetting(
      SETTINGS_PATHS.SOLVER_EXCLUDED_NATION_IDS,
      normalized,
    );
    return setExcludedNationIdsCache(normalized);
  };

  const toggleGlobalExcludedNationId = async (nationId, excluded = true) => {
    const normalizedId = normalizeNationId(nationId);
    if (!normalizedId) throw new Error("Missing nation id");
    const current = await getGlobalExcludedNationIds();
    const set = new Set(current);
    if (excluded) set.add(normalizedId);
    else set.delete(normalizedId);
    return setGlobalExcludedNationIds(Array.from(set));
  };

  const clearGlobalExcludedNationIds = async () =>
    setGlobalExcludedNationIds([]);

  const isEvolutionPlayer = (player) => {
    if (!player || typeof player !== "object") return false;
    const resolved =
      typeof player.isEvolution === "function"
        ? player.isEvolution()
        : player.isEvolution;
    if (resolved != null) return Boolean(resolved);
    return Boolean(player.upgrades);
  };

  const filterPlayersBySolverPoolSettings = (
    players,
    settings,
    { requiredIds = null } = {},
  ) => {
    const normalized = normalizeSolverSettingsInput(settings);
    const range = normalizeRatingRange(normalized?.ratingRange);
    const ratingMin = range.ratingMin;
    const ratingMax = range.ratingMax;
    const poolSettings = normalizeSolverPoolSettingsInput(
      normalized,
      getDefaultSolverPoolSettings(),
    );
    const useUnassigned = Boolean(poolSettings?.useUnassigned);
    const onlyStorage = Boolean(poolSettings?.onlyStorage);
    const excludeTradable = Boolean(poolSettings?.excludeTradable);
    const excludeSpecial = Boolean(poolSettings?.excludeSpecial);
    const useEvolutionPlayers = Boolean(poolSettings?.useEvolutionPlayers);
    const excludedPlayerIds = normalizePlayerIdList(
      normalized?.excludedPlayerIds,
      getSettingDefault(SETTINGS_PATHS.SOLVER_EXCLUDED_PLAYER_IDS),
    );
    const excludedLeagueIds = normalizeLeagueIdList(
      normalized?.excludedLeagueIds,
      getSettingDefault(SETTINGS_PATHS.SOLVER_EXCLUDED_LEAGUE_IDS),
    );
    const excludedNationIds = normalizeNationIdList(
      normalized?.excludedNationIds,
      getSettingDefault(SETTINGS_PATHS.SOLVER_EXCLUDED_NATION_IDS),
    );
    const excludedPlayerIdSet = new Set(excludedPlayerIds.map(String));
    const excludedLeagueIdSet = new Set(excludedLeagueIds.map(String));
    const excludedNationIdSet = new Set(excludedNationIds.map(String));

    const required = new Set();
    if (requiredIds instanceof Set) {
      for (const id of requiredIds) {
        if (id == null) continue;
        required.add(String(id));
      }
    } else if (Array.isArray(requiredIds)) {
      for (const id of requiredIds) {
        if (id == null) continue;
        required.add(String(id));
      }
    }

    const source = Array.isArray(players) ? players : [];
    const filteredPlayers = source.filter((player) => {
      const id = player?.id ?? null;
      if (id != null && excludedPlayerIdSet.has(String(id))) return false;
      const leagueId = normalizeLeagueId(player?.leagueId);
      if (leagueId != null && excludedLeagueIdSet.has(String(leagueId))) {
        return false;
      }
      const nationId = normalizeNationId(player?.nationId);
      if (nationId != null && excludedNationIdSet.has(String(nationId))) {
        return false;
      }
      if (id != null && required.has(String(id))) return true;
      // Intentional precedence: evo hard-block runs before unassigned bypass.
      if (!useEvolutionPlayers && isEvolutionPlayer(player)) return false;
      if (useUnassigned && player?.isDuplicate) return true;
      if (onlyStorage && !player?.isStorage) return false;
      if (excludeTradable && Boolean(player?.isTradeable)) return false;
      if (excludeSpecial && Boolean(player?.isSpecial)) return false;
      const rating = readNumeric(player?.rating);
      return rating != null && rating >= ratingMin && rating <= ratingMax;
    });

    return {
      filteredPlayers,
      poolFilters: {
        ratingMin,
        ratingMax,
        ...poolSettings,
        excludedPlayerIds,
        excludedLeagueIds,
        excludedNationIds,
      },
    };
  };

  const LEAGUE_CONFLICT_GENERIC_TYPE_TOKENS = Object.freeze([
    "league_count",
    "leagues_in_squad",
    "same_league_count",
    "players_same_league",
  ]);

  const LEAGUE_CONFLICT_GENERIC_LABEL_PATTERNS = Object.freeze([
    /leagues?\s+in\s+(the\s+)?squad/i,
    /players?\s+from\s+the\s+same\s+league/i,
    /same\s+league/i,
  ]);

  const NATION_CONFLICT_GENERIC_TYPE_TOKENS = Object.freeze([
    "nation_count",
    "countries_in_squad",
    "same_nation_count",
    "players_same_nation",
  ]);

  const NATION_CONFLICT_GENERIC_LABEL_PATTERNS = Object.freeze([
    /countries?\/regions?\s+in\s+(the\s+)?squad/i,
    /countries?\s+in\s+(the\s+)?squad/i,
    /nations?\s+in\s+(the\s+)?squad/i,
    /players?\s+from\s+the\s+same\s+countries?/i,
    /players?\s+from\s+the\s+same\s+nations?/i,
    /same\s+nation/i,
    /same\s+country/i,
  ]);

  const extractLeagueIdsFromRequirementValue = (value) => {
    const entries = [];
    const pushValue = (entry) => {
      if (entry == null) return;
      entries.push(entry);
    };
    if (Array.isArray(value)) {
      for (const entry of value) pushValue(entry);
    } else if (value && typeof value === "object") {
      if (Array.isArray(value.values)) {
        for (const entry of value.values) pushValue(entry);
      } else if (Array.isArray(value._collection)) {
        for (const entry of value._collection) pushValue(entry);
      } else {
        pushValue(value);
      }
    } else {
      pushValue(value);
    }

    const ids = [];
    for (const entry of entries) {
      if (entry && typeof entry === "object") {
        const leagueId = normalizeLeagueId(
          entry?.leagueId ?? entry?.id ?? null,
        );
        if (leagueId) ids.push(leagueId);
        continue;
      }
      const leagueId = normalizeLeagueId(entry);
      if (leagueId) ids.push(leagueId);
    }
    return normalizeLeagueIdList(ids, []);
  };

  const extractNationIdsFromRequirementValue = (value) => {
    const entries = [];
    const pushValue = (entry) => {
      if (entry == null) return;
      entries.push(entry);
    };
    if (Array.isArray(value)) {
      for (const entry of value) pushValue(entry);
    } else if (value && typeof value === "object") {
      if (Array.isArray(value.values)) {
        for (const entry of value.values) pushValue(entry);
      } else if (Array.isArray(value._collection)) {
        for (const entry of value._collection) pushValue(entry);
      } else {
        pushValue(value);
      }
    } else {
      pushValue(value);
    }

    const ids = [];
    for (const entry of entries) {
      if (entry && typeof entry === "object") {
        const nationId = normalizeNationId(
          entry?.nationId ??
            entry?.countryId ??
            entry?.nationalityId ??
            entry?.id ??
            null,
        );
        if (nationId) ids.push(nationId);
        continue;
      }
      const nationId = normalizeNationId(entry);
      if (nationId) ids.push(nationId);
    }
    return normalizeNationIdList(ids, []);
  };

  const isGenericLeagueRequirementRule = (rule, typeHint, labelText) => {
    const normalizedType = String(typeHint ?? "").toLowerCase();
    for (const token of LEAGUE_CONFLICT_GENERIC_TYPE_TOKENS) {
      if (normalizedType.includes(token)) return true;
    }
    if (normalizedType.includes("league") && normalizedType.includes("count")) {
      return true;
    }
    for (const pattern of LEAGUE_CONFLICT_GENERIC_LABEL_PATTERNS) {
      if (pattern.test(labelText)) return true;
    }
    if (
      rule?.derivedCount != null &&
      normalizedType.includes("league") &&
      !normalizedType.includes("id")
    ) {
      return true;
    }
    return false;
  };

  const isGenericNationRequirementRule = (rule, typeHint, labelText) => {
    const normalizedType = String(typeHint ?? "").toLowerCase();
    for (const token of NATION_CONFLICT_GENERIC_TYPE_TOKENS) {
      if (normalizedType.includes(token)) return true;
    }
    if (normalizedType.includes("nation") && normalizedType.includes("count")) {
      return true;
    }
    if (
      normalizedType.includes("country") &&
      normalizedType.includes("count")
    ) {
      return true;
    }
    for (const pattern of NATION_CONFLICT_GENERIC_LABEL_PATTERNS) {
      if (pattern.test(labelText)) return true;
    }
    if (
      rule?.derivedCount != null &&
      (normalizedType.includes("nation") ||
        normalizedType.includes("country")) &&
      !normalizedType.includes("id")
    ) {
      return true;
    }
    return false;
  };

  const collectExplicitRequiredLeagueIds = (requirementsNormalized) => {
    const rules = Array.isArray(requirementsNormalized)
      ? requirementsNormalized
      : [];
    const ids = new Set();
    for (const rule of rules) {
      if (!rule || typeof rule !== "object") continue;
      const typeHint = normalizeKeyName(
        rule?.type ?? rule?.keyNameNormalized ?? rule?.keyName ?? null,
      );
      const labelText = String(rule?.label ?? "").toLowerCase();
      const hasLeagueSignal =
        String(typeHint ?? "").includes("league") ||
        labelText.includes("league");
      if (!hasLeagueSignal) continue;
      if (isGenericLeagueRequirementRule(rule, typeHint, labelText)) continue;
      const leagueIds = extractLeagueIdsFromRequirementValue(rule?.value);
      if (!leagueIds.length) continue;
      for (const leagueId of leagueIds) {
        ids.add(String(leagueId));
      }
    }
    return Array.from(ids);
  };

  const collectExplicitRequiredNationIds = (requirementsNormalized) => {
    const rules = Array.isArray(requirementsNormalized)
      ? requirementsNormalized
      : [];
    const ids = new Set();
    for (const rule of rules) {
      if (!rule || typeof rule !== "object") continue;
      const typeHint = normalizeKeyName(
        rule?.type ?? rule?.keyNameNormalized ?? rule?.keyName ?? null,
      );
      const labelText = String(rule?.label ?? "").toLowerCase();
      const hasNationSignal =
        String(typeHint ?? "").includes("nation") ||
        String(typeHint ?? "").includes("country") ||
        labelText.includes("nation") ||
        labelText.includes("country");
      if (!hasNationSignal) continue;
      if (isGenericNationRequirementRule(rule, typeHint, labelText)) continue;
      const nationIds = extractNationIdsFromRequirementValue(rule?.value);
      if (!nationIds.length) continue;
      for (const nationId of nationIds) {
        ids.add(String(nationId));
      }
    }
    return Array.from(ids);
  };

  const collectLockedRequiredPlayerIdsFromSquadSlots = (squadSlots) => {
    const slots = Array.isArray(squadSlots) ? squadSlots : [];
    const ids = new Set();
    for (const slot of slots) {
      const item = slot?.item ?? null;
      const itemId = normalizePlayerId(item?.id);
      if (!itemId) continue;
      const concept =
        typeof item?.isConcept === "function"
          ? item.isConcept()
          : Boolean(item?.concept);
      if (concept) continue;
      const isRequiredLocked =
        slot?.isLocked === true ||
        slot?.isEditable === false ||
        slot?.isBrick === true;
      if (!isRequiredLocked) continue;
      ids.add(String(itemId));
    }
    return Array.from(ids);
  };

  const buildSolverPoolExclusionConflict = ({
    settings,
    requirementsNormalized = [],
    squadSlots = [],
  } = {}) => {
    const normalized = normalizeSolverSettingsInput(settings);
    const excludedPlayerIds = normalizePlayerIdList(
      normalized?.excludedPlayerIds,
      getSettingDefault(SETTINGS_PATHS.SOLVER_EXCLUDED_PLAYER_IDS),
    );
    const excludedLeagueIds = normalizeLeagueIdList(
      normalized?.excludedLeagueIds,
      getSettingDefault(SETTINGS_PATHS.SOLVER_EXCLUDED_LEAGUE_IDS),
    );
    const excludedNationIds = normalizeNationIdList(
      normalized?.excludedNationIds,
      getSettingDefault(SETTINGS_PATHS.SOLVER_EXCLUDED_NATION_IDS),
    );
    const excludedPlayerIdSet = new Set(excludedPlayerIds.map(String));
    const excludedLeagueIdSet = new Set(excludedLeagueIds.map(String));
    const excludedNationIdSet = new Set(excludedNationIds.map(String));
    if (
      !excludedPlayerIdSet.size &&
      !excludedLeagueIdSet.size &&
      !excludedNationIdSet.size
    ) {
      return {
        hasConflict: false,
        conflictingLockedPlayerIds: [],
        conflictingLeagueIds: [],
        conflictingNationIds: [],
      };
    }

    const requiredLeagueIds = collectExplicitRequiredLeagueIds(
      requirementsNormalized,
    );
    const conflictingLeagueIds = requiredLeagueIds.filter((id) =>
      excludedLeagueIdSet.has(String(id)),
    );
    const requiredNationIds = collectExplicitRequiredNationIds(
      requirementsNormalized,
    );
    const conflictingNationIds = requiredNationIds.filter((id) =>
      excludedNationIdSet.has(String(id)),
    );
    const requiredLockedPlayerIds =
      collectLockedRequiredPlayerIdsFromSquadSlots(squadSlots);
    const conflictingLockedPlayerIds = requiredLockedPlayerIds.filter((id) =>
      excludedPlayerIdSet.has(String(id)),
    );
    return {
      hasConflict:
        conflictingLockedPlayerIds.length > 0 ||
        conflictingLeagueIds.length > 0 ||
        conflictingNationIds.length > 0,
      conflictingLockedPlayerIds,
      conflictingLeagueIds,
      conflictingNationIds,
    };
  };

  const getExcludedPlayerLabelById = (itemId) => {
    loadExcludedPlayerMetaCache();
    const normalized = normalizePlayerId(itemId);
    if (!normalized) return null;
    const meta = excludedPlayerMetaCache.get(String(normalized));
    const name = sanitizeDisplayText(meta?.name);
    if (name) return name;
    return `Player ${normalized}`;
  };

  const formatConflictValueList = (items, { limit = 3 } = {}) => {
    const values = Array.isArray(items)
      ? items
          .map((value) => sanitizeDisplayText(value) ?? String(value ?? ""))
          .filter(Boolean)
      : [];
    if (!values.length) return "";
    const shown = values.slice(0, limit);
    const suffix =
      values.length > limit ? ` +${values.length - limit} more` : "";
    return `${shown.join(", ")}${suffix}`;
  };

  const buildSolverPoolConflictNotice = (
    conflict,
    { challengeName = null } = {},
  ) => {
    if (!conflict?.hasConflict) return null;
    const challengePrefix = challengeName ? `${challengeName}: ` : "";
    const conflictingLeagueLabels = (conflict?.conflictingLeagueIds ?? []).map(
      (leagueId) => getLeagueName(leagueId) ?? `League ${leagueId}`,
    );
    const conflictingNationLabels = (conflict?.conflictingNationIds ?? []).map(
      (nationId) => getNationName(nationId) ?? `Nation ${nationId}`,
    );
    const conflictingPlayerLabels = (
      conflict?.conflictingLockedPlayerIds ?? []
    ).map((itemId) => getExcludedPlayerLabelById(itemId) ?? `Player ${itemId}`);
    const leagueText = formatConflictValueList(conflictingLeagueLabels);
    const nationText = formatConflictValueList(conflictingNationLabels);
    const playerText = formatConflictValueList(conflictingPlayerLabels);

    const messageParts = [];
    const reasonParts = [];
    if (leagueText) {
      messageParts.push(
        `an excluded league is explicitly required (${leagueText})`,
      );
      reasonParts.push("Excluded league is explicitly required");
    }
    if (nationText) {
      messageParts.push(
        `an excluded nation is explicitly required (${nationText})`,
      );
      reasonParts.push("Excluded nation is explicitly required");
    }
    if (playerText) {
      messageParts.push(`a locked squad player is excluded (${playerText})`);
      reasonParts.push("Locked squad player is excluded");
    }
    return {
      title: "Pool Exclusion Conflict",
      message: `${challengePrefix}${messageParts.join("; ")}.`,
      reason: `${reasonParts.join("; ")}.`,
    };
  };

  const callSolverBridge = (
    type,
    payload,
    timeoutMs = SOLVER_BRIDGE_TIMEOUT_MS,
  ) =>
    new Promise((resolve, reject) => {
      const requestId = crypto.randomUUID();
      const timer = setTimeout(() => {
        solverBridgeRequests.delete(requestId);
        reject(new Error("Solver bridge timeout"));
      }, timeoutMs);

      solverBridgeRequests.set(requestId, {
        resolve: (data) => {
          clearTimeout(timer);
          resolve(data);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });

      log("debug", "[EA Data] Solver bridge send", { requestId, type });
      const message = {
        type: SOLVER_BRIDGE_REQUEST,
        requestId,
        source: SOLVER_BRIDGE_SOURCE,
        payload: { type, payload, debug: debugEnabled },
      };
      window.postMessage(message, "*");
      try {
        document.dispatchEvent(
          new CustomEvent(SOLVER_BRIDGE_REQUEST, { detail: message }),
        );
      } catch {}
    });

  const pingSolverBridge = () => {
    const requestId = crypto.randomUUID();
    const detail = { type: SOLVER_BRIDGE_PING, requestId };
    try {
      window.postMessage(detail, "*");
    } catch {}
    try {
      document.dispatchEvent(new CustomEvent(SOLVER_BRIDGE_PING, { detail }));
    } catch {}
  };

  const initSolverBridge = async () => {
    if (solverBridgeReady) return true;
    if (solverBridgeInitPromise) return solverBridgeInitPromise;

    solverBridgeInitPromise = (async () => {
      try {
        await callSolverBridge("INIT", null, SOLVER_BRIDGE_INIT_TIMEOUT_MS);
        solverBridgeReady = true;
        log("debug", "[EA Data] Solver bridge ready");
        return true;
      } catch (error) {
        solverBridgeError = error;
        solverBridgeReady = false;
        solverBridgeInitPromise = null;
        log("debug", "[EA Data] Solver bridge init failed", error);
        return false;
      }
    })();

    return solverBridgeInitPromise;
  };

  const getLocalizationContext = () => {
    if (localizationCache) return localizationCache;
    try {
      if (typeof getLocalization === "function") {
        localizationCache = getLocalization();
        return localizationCache;
      }
    } catch {}
    try {
      if (typeof window?.getLocalization === "function") {
        localizationCache = window.getLocalization();
        return localizationCache;
      }
    } catch {}
    try {
      if (typeof utils?.getLocalization === "function") {
        localizationCache = utils.getLocalization();
        return localizationCache;
      }
    } catch {}
    return null;
  };

  const getPositionName = (positionId) => {
    if (positionId == null) return null;
    try {
      if (typeof UTLocalizationUtil?.positionIdToName === "function") {
        return UTLocalizationUtil.positionIdToName(
          positionId,
          getLocalizationContext() ?? undefined,
        );
      }
    } catch {}
    const lookup = getPositionLookup();
    return lookup?.get(positionId) ?? null;
  };

  const getPositionLookup = () => {
    if (positionLookupCache) return positionLookupCache;
    try {
      if (!factories?.DataProvider?.getPlayerPositionDP) return null;
      const positions = factories.DataProvider.getPlayerPositionDP() ?? [];
      positionLookupCache = new Map();
      for (const position of positions) {
        if (!position || position.id == null) continue;
        positionLookupCache.set(
          position.id,
          position.label ?? position.name ?? `${position.id}`,
        );
      }
      return positionLookupCache;
    } catch {
      return null;
    }
  };

  const getRarityLookup = () => {
    if (rarityLookupCache) return rarityLookupCache;
    try {
      if (
        !factories?.DataProvider?.getItemRarityDP ||
        typeof ItemSubType === "undefined" ||
        typeof ItemType === "undefined" ||
        typeof SearchLevel === "undefined"
      ) {
        return null;
      }
      const rarities =
        factories.DataProvider.getItemRarityDP({
          itemSubTypes: [ItemSubType.PLAYER],
          itemTypes: [ItemType.PLAYER],
          quality: SearchLevel.ANY,
          tradableOnly: false,
        }) ?? [];
      rarityLookupCache = new Map();
      for (const rarity of rarities) {
        if (!rarity || rarity.id == null) continue;
        rarityLookupCache.set(
          rarity.id,
          rarity.label ?? rarity.name ?? `${rarity.id}`,
        );
      }
      return rarityLookupCache;
    } catch {
      return null;
    }
  };

  const getRarityName = (rarityId) => {
    if (rarityId == null) return null;
    const lookup = getRarityLookup();
    return lookup?.get(rarityId) ?? null;
  };

  const collectDataProviderEntries = (raw) => {
    if (!raw) return [];
    if (Array.isArray(raw)) return raw;
    if (typeof raw?.toArray === "function") {
      try {
        const arr = raw.toArray();
        if (Array.isArray(arr)) return arr;
      } catch {}
    }
    if (Array.isArray(raw?._collection)) return raw._collection;
    if (
      raw?._collection &&
      typeof raw._collection === "object" &&
      !Array.isArray(raw._collection)
    ) {
      return Object.values(raw._collection);
    }
    if (typeof raw === "object") {
      const values = Object.values(raw);
      if (values.length && values.every((v) => v && typeof v === "object")) {
        return values;
      }
    }
    return [];
  };

  const getLeagueLookup = () => {
    if (leagueLookupCache) return leagueLookupCache;
    const provider = factories?.DataProvider ?? null;
    if (!provider || typeof provider !== "object") return null;

    const candidateMethods = [
      "getLeagueDP",
      "getLeaguesDP",
      "getLeagueDataProvider",
      "getCompetitionLeagueDP",
      "getCompetitionLeaguesDP",
    ];

    let entries = [];
    for (const method of candidateMethods) {
      const fn = provider?.[method];
      if (typeof fn !== "function") continue;
      try {
        entries = collectDataProviderEntries(fn.call(provider));
      } catch {
        entries = [];
      }
      if (entries.length) break;
    }
    if (!entries.length) return null;

    const lookup = new Map();
    for (const row of entries) {
      if (!row || typeof row !== "object") continue;
      const id = normalizeLeagueId(row?.id ?? row?.leagueId ?? null);
      if (!id) continue;
      const name = sanitizeDisplayText(
        row?.label ??
          row?.name ??
          row?.shortName ??
          row?.description ??
          row?.displayName ??
          null,
      );
      if (name) upsertLeagueMeta(id, { name });
      lookup.set(id, name ?? `League ${id}`);
      const numeric = readNumeric(id);
      if (numeric != null) lookup.set(numeric, name ?? `League ${id}`);
    }
    leagueLookupCache = lookup;
    return leagueLookupCache;
  };

  const getLeagueName = (leagueId) => {
    const id = normalizeLeagueId(leagueId);
    if (!id) return null;
    loadLeagueMetaCache();
    const cached = leagueMetaCache.get(id);
    const cachedName = sanitizeDisplayText(cached?.name);
    if (cachedName) return cachedName;
    const lookup = getLeagueLookup();
    const name = sanitizeDisplayText(
      lookup?.get(id) ?? lookup?.get(readNumeric(id)) ?? null,
    );
    if (name) {
      upsertLeagueMeta(id, { name });
      return name;
    }
    return null;
  };

  const getAvailableLeaguesForExclusion = async ({ force = false } = {}) => {
    loadLeagueMetaCache();
    if (force) leagueLookupCache = null;
    try {
      getLeagueLookup();
    } catch {}

    let options = getLeagueOptionsFromMetaCache();
    if (!options.length) {
      try {
        const snapshot = await ensurePlayersSnapshot({ ignoreLoaned: true });
        cacheLeagueMetaFromPlayers(snapshot?.clubPlayers ?? []);
        cacheLeagueMetaFromPlayers(snapshot?.storagePlayers ?? []);
        options = getLeagueOptionsFromMetaCache();
      } catch {}
    }
    return options;
  };

  const getNationLookup = () => {
    if (nationLookupCache) return nationLookupCache;
    const provider = factories?.DataProvider ?? null;
    if (!provider || typeof provider !== "object") return null;

    const candidateMethods = [
      "getNationDP",
      "getNationsDP",
      "getCountryDP",
      "getCountriesDP",
      "getNationalityDP",
      "getNationalitiesDP",
      "getNationDataProvider",
      "getCountryDataProvider",
    ];

    let entries = [];
    for (const method of candidateMethods) {
      const fn = provider?.[method];
      if (typeof fn !== "function") continue;
      try {
        entries = collectDataProviderEntries(fn.call(provider));
      } catch {
        entries = [];
      }
      if (entries.length) break;
    }
    if (!entries.length) return null;

    const lookup = new Map();
    for (const row of entries) {
      if (!row || typeof row !== "object") continue;
      const id = normalizeNationId(
        row?.id ??
          row?.nationId ??
          row?.countryId ??
          row?.nationalityId ??
          null,
      );
      if (!id) continue;
      const name = sanitizeDisplayText(
        row?.label ??
          row?.name ??
          row?.shortName ??
          row?.description ??
          row?.displayName ??
          null,
      );
      if (name) upsertNationMeta(id, { name });
      lookup.set(id, name ?? `Nation ${id}`);
      const numeric = readNumeric(id);
      if (numeric != null) lookup.set(numeric, name ?? `Nation ${id}`);
    }
    nationLookupCache = lookup;
    return nationLookupCache;
  };

  const getNationName = (nationId) => {
    const id = normalizeNationId(nationId);
    if (!id) return null;
    loadNationMetaCache();
    const cached = nationMetaCache.get(id);
    const cachedName = sanitizeDisplayText(cached?.name);
    if (cachedName) return cachedName;
    const lookup = getNationLookup();
    const name = sanitizeDisplayText(
      lookup?.get(id) ?? lookup?.get(readNumeric(id)) ?? null,
    );
    if (name) {
      upsertNationMeta(id, { name });
      return name;
    }
    return null;
  };

  const getAvailableNationsForExclusion = async ({ force = false } = {}) => {
    loadNationMetaCache();
    if (force) nationLookupCache = null;
    try {
      getNationLookup();
    } catch {}

    let options = getNationOptionsFromMetaCache();
    if (!options.length) {
      try {
        const snapshot = await ensurePlayersSnapshot({ ignoreLoaned: true });
        cacheNationMetaFromPlayers(snapshot?.clubPlayers ?? []);
        cacheNationMetaFromPlayers(snapshot?.storagePlayers ?? []);
        options = getNationOptionsFromMetaCache();
      } catch {}
    }
    return options;
  };

  const getPlayerBioButtonFromPanel = (panel) => {
    if (!panel || typeof panel !== "object") return null;
    if ("_playerBioButton" in panel) return panel._playerBioButton ?? null;
    if ("_bioButton" in panel) return panel._bioButton ?? null;
    if ("_btnBio" in panel) return panel._btnBio ?? null;
    return null;
  };

  const getPanelButtonRootElement = (button) => {
    if (!button) return null;
    try {
      if (typeof button.getRootElement === "function") {
        const root = button.getRootElement();
        if (root && root.nodeType === 1) return root;
      }
    } catch {}
    const fallback = button?._root ?? button?.root ?? button?.element ?? null;
    return fallback && fallback.nodeType === 1 ? fallback : null;
  };

  const resolveItemEntityDisplayName = (item) => {
    if (!item || typeof item !== "object") return null;
    const pick = (value) => {
      if (typeof value !== "string") return null;
      const trimmed = value.trim();
      return trimmed ? trimmed : null;
    };
    try {
      if (typeof item.getName === "function") {
        const name = pick(item.getName());
        if (name) return name;
      }
    } catch {}
    const direct = pick(
      item.commonName ??
        item.displayName ??
        item.shortName ??
        item.name ??
        item?._staticData?.commonName ??
        item?._staticData?.name ??
        null,
    );
    if (direct) return direct;
    const first = pick(item.firstName ?? item?._staticData?.firstName ?? null);
    const last = pick(item.lastName ?? item?._staticData?.lastName ?? null);
    if (first || last) return [first, last].filter(Boolean).join(" ");
    return null;
  };

  const isPlayerItemEntity = (item) => {
    if (!item || typeof item !== "object") return false;
    try {
      if (typeof item.isPlayer === "function") return Boolean(item.isPlayer());
    } catch {}
    try {
      if (typeof ItemType !== "undefined" && item?.itemType != null) {
        return Number(item.itemType) === Number(ItemType.PLAYER);
      }
    } catch {}
    const hasPlayerSignals =
      item?.rating != null ||
      item?.preferredPosition != null ||
      item?.position != null ||
      item?.playStyle != null ||
      item?.nationId != null ||
      item?.leagueId != null ||
      item?.teamId != null;
    return Boolean(item?.definitionId != null && hasPlayerSignals);
  };

  const readViewModelCurrentItem = (owner) => {
    if (!owner || typeof owner !== "object") return null;
    const viewmodel = owner?.viewmodel ?? null;
    if (!viewmodel || typeof viewmodel !== "object") return null;
    const current = viewmodel.current;
    if (typeof current === "function") {
      try {
        return current.call(viewmodel);
      } catch {}
    } else if (current && typeof current === "object") {
      return current;
    }
    const fallback = viewmodel.currentItem ?? viewmodel.item ?? null;
    return fallback && typeof fallback === "object" ? fallback : null;
  };

  const resolveItemDetailsCurrentItem = (
    controller,
    panelData = null,
    panel = null,
  ) => {
    const candidates = [];
    const push = (candidate) => {
      if (!candidate || typeof candidate !== "object") return;
      candidates.push(candidate);
    };
    push(readViewModelCurrentItem(controller));
    const raw = panelData && typeof panelData === "object" ? panelData : null;
    push(raw?.item);
    push(raw?.data?.item);
    push(raw?.itemData);
    push(readViewModelCurrentItem(raw));
    push(panel?._item);
    push(panel?.item);
    push(readViewModelCurrentItem(panel));

    for (const candidate of candidates) {
      if (candidate?.id != null) return candidate;
    }
    for (const candidate of candidates) {
      if (candidate?.definitionId != null) return candidate;
    }
    return null;
  };

  const cleanupPlayerExclusionPanelControl = (panel) => {
    if (!panel) return;
    try {
      clearTimeout(panel.__eaDataExcludeRetryTimer);
    } catch {}
    try {
      panel.__eaDataExcludeControlWrap?.remove?.();
    } catch {}
    try {
      panel.__eaDataExcludeRetryTimer = null;
      panel.__eaDataExcludeControlWrap = null;
      panel.__eaDataExcludeControlInput = null;
      panel.__eaDataExcludeControlSwitch = null;
      panel.__eaDataExcludeStateText = null;
      panel.__eaDataExcludeCurrentItem = null;
      panel.__eaDataExcludeBusy = false;
      panel.__eaDataExcludeSyncToken = 0;
    } catch {}
    try {
      exclusionControlPanels.delete(panel);
    } catch {}
    if (activeItemDetailsPanel === panel) activeItemDetailsPanel = null;
    if (activeSlotActionPanel === panel) activeSlotActionPanel = null;
  };

  const prunePlayerExclusionPanelControls = (keepPanel = null) => {
    const panels = Array.from(exclusionControlPanels);
    for (const panel of panels) {
      if (!panel || panel === keepPanel) continue;
      cleanupPlayerExclusionPanelControl(panel);
    }
  };

  const hasConnectedPanelBioAnchor = (panel) => {
    if (!panel) return false;
    const button = getPlayerBioButtonFromPanel(panel);
    const root = getPanelButtonRootElement(button);
    return Boolean(root && root.parentNode && root.isConnected);
  };

  const shouldUseSlotActionPanelOver = (panel) => {
    if (!panel || !activeSlotActionPanel || activeSlotActionPanel === panel) {
      return false;
    }
    return hasConnectedPanelBioAnchor(activeSlotActionPanel);
  };

  const syncAllPlayerExclusionPanelControls = () => {
    const panels = Array.from(exclusionControlPanels);
    for (const panel of panels) {
      if (!panel) continue;
      void syncPlayerExclusionPanelControl(panel);
    }
  };

  const syncPlayerExclusionPanelControl = async (panel, item = null) => {
    if (!panel) return;
    const wrap = panel?.__eaDataExcludeControlWrap ?? null;
    const input = panel?.__eaDataExcludeControlInput ?? null;
    const switchRoot = panel?.__eaDataExcludeControlSwitch ?? null;
    const stateTextEl = panel?.__eaDataExcludeStateText ?? null;
    if (!wrap || !input) return;

    const token = (readNumeric(panel?.__eaDataExcludeSyncToken) ?? 0) + 1;
    panel.__eaDataExcludeSyncToken = token;

    const currentItem = item ?? panel?.__eaDataExcludeCurrentItem ?? null;
    if (currentItem) panel.__eaDataExcludeCurrentItem = currentItem;

    const currentItemId = normalizePlayerId(currentItem?.id);
    const isPlayer = isPlayerItemEntity(currentItem);
    const currentItemName = resolveItemEntityDisplayName(currentItem);
    if (currentItemId) {
      upsertExcludedPlayerMeta(String(currentItemId), {
        name: currentItemName,
        rating: currentItem?.rating ?? null,
        rarityName: resolveEntityRarityName(currentItem),
      });
    }

    if (!currentItemId || !isPlayer) {
      try {
        switchRoot?.classList?.add?.("ea-data-toggle-switch--instant");
      } catch {}
      try {
        input.checked = false;
        input.disabled = true;
        if (stateTextEl) {
          stateTextEl.textContent = "Unavailable for this item.";
        }
      } catch {}
      try {
        requestAnimationFrame(() =>
          switchRoot?.classList?.remove?.("ea-data-toggle-switch--instant"),
        );
      } catch {
        try {
          switchRoot?.classList?.remove?.("ea-data-toggle-switch--instant");
        } catch {}
      }
      return;
    }

    const nameLabel = currentItemName ?? `Item ${currentItemId}`;
    const applyVisualState = (excluded, disabled) => {
      try {
        switchRoot?.classList?.add?.("ea-data-toggle-switch--instant");
      } catch {}
      try {
        input.checked = Boolean(excluded);
        input.disabled = Boolean(disabled);
        if (stateTextEl) {
          stateTextEl.textContent = excluded
            ? `${nameLabel} is excluded from solver pool.`
            : `${nameLabel} is included in solver pool.`;
        }
      } catch {}
      try {
        requestAnimationFrame(() =>
          switchRoot?.classList?.remove?.("ea-data-toggle-switch--instant"),
        );
      } catch {
        try {
          switchRoot?.classList?.remove?.("ea-data-toggle-switch--instant");
        } catch {}
      }
    };

    const cachedExcludedIds = peekExcludedPlayerIdsCache();
    if (cachedExcludedIds) {
      const cachedSet = new Set(cachedExcludedIds.map(String));
      applyVisualState(
        cachedSet.has(String(currentItemId)),
        Boolean(panel?.__eaDataExcludeBusy),
      );
    } else {
      try {
        input.disabled = true;
        if (stateTextEl) stateTextEl.textContent = "Loading exclusion state...";
      } catch {}
    }

    let excludedIds = cachedExcludedIds ?? [];
    try {
      excludedIds = await ensureExcludedPlayerIdsCache({
        force: !cachedExcludedIds,
      });
    } catch {}
    if ((panel?.__eaDataExcludeSyncToken ?? 0) !== token) return;

    const excludedSet = new Set(excludedIds.map(String));
    const excluded = excludedSet.has(String(currentItemId));
    applyVisualState(excluded, Boolean(panel?.__eaDataExcludeBusy));
  };

  const ensurePlayerExclusionPanelControl = (panel, item = null) => {
    if (!panel) return;
    panel.__eaDataExcludeCurrentItem =
      item ?? panel.__eaDataExcludeCurrentItem ?? null;
    const currentItem = panel.__eaDataExcludeCurrentItem ?? null;
    const currentItemId = normalizePlayerId(currentItem?.id);
    const currentIsPlayer = isPlayerItemEntity(currentItem);
    if (!currentIsPlayer || !currentItemId) {
      cleanupPlayerExclusionPanelControl(panel);
      return;
    }
    if (shouldUseSlotActionPanelOver(panel)) {
      cleanupPlayerExclusionPanelControl(panel);
      return;
    }
    const bioButton = getPlayerBioButtonFromPanel(panel);
    const bioRoot = getPanelButtonRootElement(bioButton);
    if (!bioRoot || !bioRoot.parentNode) {
      if (!panel.__eaDataExcludeRetryTimer) {
        panel.__eaDataExcludeRetryTimer = setTimeout(() => {
          panel.__eaDataExcludeRetryTimer = null;
          ensurePlayerExclusionPanelControl(
            panel,
            panel.__eaDataExcludeCurrentItem ?? null,
          );
        }, 80);
      }
      return;
    }

    let wrap = panel?.__eaDataExcludeControlWrap ?? null;
    if (!wrap) {
      const inputId = `ea-data-item-exclude-toggle-${++exclusionControlSeq}`;
      wrap = document.createElement("div");
      wrap.className = "ea-data-item-panel-exclude-wrap";
      wrap.innerHTML = `
        <label class="ea-data-toggle-row" for="${inputId}">
          <span class="ea-data-toggle-text">
            <span>
              <span class="ea-data-toggle-title">Exclude From Solver</span>
              <span class="ea-data-item-panel-exclude-state">Loading...</span>
            </span>
          </span>
          <div class="ea-data-toggle-switch">
            <input id="${inputId}" type="checkbox" />
            <div class="ea-data-toggle-slider"></div>
          </div>
        </label>
      `;
      const input = wrap.querySelector("input[type='checkbox']");
      const stateTextEl = wrap.querySelector(
        ".ea-data-item-panel-exclude-state",
      );
      const switchRoot = wrap.querySelector(".ea-data-toggle-switch");
      panel.__eaDataExcludeControlWrap = wrap;
      panel.__eaDataExcludeControlInput = input ?? null;
      panel.__eaDataExcludeControlSwitch = switchRoot ?? null;
      panel.__eaDataExcludeStateText = stateTextEl ?? null;
      panel.__eaDataExcludeBusy = false;
      panel.__eaDataExcludeSyncToken = 0;
      exclusionControlPanels.add(panel);

      input?.addEventListener("change", async (event) => {
        try {
          event?.stopPropagation?.();
        } catch {}
        if (panel?.__eaDataExcludeBusy) return;
        const currentItem = panel?.__eaDataExcludeCurrentItem ?? null;
        const itemId = normalizePlayerId(currentItem?.id);
        if (!itemId) {
          syncAllPlayerExclusionPanelControls();
          return;
        }
        const nextExcluded = Boolean(input?.checked);
        panel.__eaDataExcludeBusy = true;
        if (input) input.disabled = true;
        try {
          const name = resolveItemEntityDisplayName(currentItem);
          upsertExcludedPlayerMeta(String(itemId), {
            name,
            rating: currentItem?.rating ?? null,
            rarityName: resolveEntityRarityName(currentItem),
          });
          await toggleGlobalExcludedPlayerId(itemId, nextExcluded);
          await refreshAllGlobalSettingsSections();
          showToast({
            type: "success",
            title: nextExcluded ? "Player Excluded" : "Player Included",
            message: name || `Item ID ${itemId}`,
            timeoutMs: 2600,
          });
        } catch (error) {
          log("debug", "[EA Data] Player exclusion toggle failed", error);
          showToast({
            type: "error",
            title: "Settings Error",
            message: "Failed to update excluded players.",
            timeoutMs: 6000,
          });
        } finally {
          panel.__eaDataExcludeBusy = false;
          syncAllPlayerExclusionPanelControls();
        }
      });
    }
    exclusionControlPanels.add(panel);

    if (
      wrap.parentNode !== bioRoot.parentNode ||
      wrap.previousSibling !== bioRoot
    ) {
      try {
        bioRoot.parentNode.insertBefore(wrap, bioRoot.nextSibling);
      } catch {}
    }

    void syncPlayerExclusionPanelControl(panel);
  };

  const hookItemDetailsViewController = () => {
    if (itemDetailsControllerHooked) return true;
    if (typeof UTItemDetailsViewController === "undefined") return false;
    const proto = UTItemDetailsViewController.prototype;
    if (!proto || proto.__eaDataItemDetailsHooked) return true;
    const originalSetup = proto.setupPanelViewInstanceFromData;
    if (typeof originalSetup !== "function") return false;

    proto.setupPanelViewInstanceFromData = function (panelData, ...args) {
      const result = originalSetup.call(this, panelData, ...args);
      try {
        const panelRaw = this?.panel ?? this?._panel ?? result ?? null;
        const panel =
          panelRaw && typeof panelRaw === "object" ? panelRaw : null;
        const item = resolveItemDetailsCurrentItem(this, panelData, panel);
        if (panel) {
          activeItemDetailsPanel = panel;
          panel.__eaDataExcludeCurrentItem =
            item ?? panel.__eaDataExcludeCurrentItem ?? null;
          if (shouldUseSlotActionPanelOver(panel)) {
            cleanupPlayerExclusionPanelControl(panel);
            return result;
          }
          ensurePlayerExclusionPanelControl(panel, item);
        }
      } catch (error) {
        log("debug", "[EA Data] Item details hook failed", error);
      }
      return result;
    };

    proto.__eaDataItemDetailsHooked = true;
    itemDetailsControllerHooked = true;
    console.log("[EA Data] Item details controller hook installed");
    return true;
  };

  const hookSlotActionPanelView = () => {
    if (slotActionPanelHooked) return true;
    if (typeof UTSlotActionPanelView === "undefined") return false;
    const proto = UTSlotActionPanelView.prototype;
    if (!proto || proto.__eaDataSlotActionHooked) return true;
    const originalSetItem = proto.setItem;
    if (typeof originalSetItem !== "function") return false;
    const originalDestroy = proto.destroyGeneratedElements;

    proto.setItem = function (item, ...args) {
      const result = originalSetItem.call(this, item, ...args);
      try {
        activeSlotActionPanel = this;
        this.__eaDataExcludeCurrentItem =
          item ?? this.__eaDataExcludeCurrentItem ?? null;
        if (activeItemDetailsPanel && activeItemDetailsPanel !== this) {
          cleanupPlayerExclusionPanelControl(activeItemDetailsPanel);
        }
        ensurePlayerExclusionPanelControl(this, item ?? null);
        prunePlayerExclusionPanelControls(this);
      } catch (error) {
        log("debug", "[EA Data] Slot panel hook failed", error);
      }
      return result;
    };

    if (typeof originalDestroy === "function") {
      proto.destroyGeneratedElements = function (...args) {
        const result = originalDestroy.call(this, ...args);
        try {
          if (activeSlotActionPanel === this) activeSlotActionPanel = null;
          cleanupPlayerExclusionPanelControl(this);
        } catch {}
        return result;
      };
    }

    proto.__eaDataSlotActionHooked = true;
    slotActionPanelHooked = true;
    console.log("[EA Data] Slot action panel hook installed");
    return true;
  };

  const triggerAutoFetchForSet = (
    setId,
    { reason = "unknown", challengeId = null } = {},
  ) => {
    if (!autoFetchEnabled) return;
    const normalizedSetId = readNumeric(setId);
    if (normalizedSetId == null) return;
    void prefetchSetChallengeInfo(normalizedSetId, {
      reason: `${reason}-set-info`,
    }).catch((error) => {
      log("debug", "[EA Data] Set info prefetch failed", {
        reason,
        setId: normalizedSetId,
        error,
      });
    });
    if (autoFetchInFlight) return;
    autoFetchInFlight = true;
    log("debug", "[EA Data] Auto-fetch started", {
      reason,
      setId: normalizedSetId,
      challengeId: challengeId ?? null,
    });
    window.eaData
      ?.triggerFetch(
        { ignoreLoaned: true, includeChallenges: false },
        [normalizedSetId],
        {
          silent: true,
        },
      )
      .then((data) => {
        log("info", "[EA Data] Auto-fetch complete", {
          reason,
          setId: normalizedSetId,
          club: data?.clubPlayers?.length ?? 0,
          storage: data?.storagePlayers?.length ?? 0,
          challenges: data?.sbcChallenges?.length ?? 0,
        });
      })
      .catch((error) => {
        log("debug", "[EA Data] Auto-fetch failed", {
          reason,
          setId: normalizedSetId,
          error,
        });
      })
      .finally(() => {
        autoFetchInFlight = false;
      });
  };

  const hookSbcChallengePanel = () => {
    if (sbcPanelHooked) return true;
    if (typeof UTSBCSquadDetailPanelView === "undefined") return false;
    const proto = UTSBCSquadDetailPanelView.prototype;
    if (!proto || proto.__eaDataHooked) return true;

    const originalRender = proto.render;
    const originalDestroy = proto.destroyGeneratedElements;
    // Expose originals for best-effort hard refreshes (destroy + render) without invoking our wrapper side-effects.
    try {
      proto.__eaDataOriginalRender = originalRender;
      proto.__eaDataOriginalDestroyGeneratedElements = originalDestroy;
    } catch {}

    proto.render = function (challenge, ...args) {
      // Capture the full render call signature so refreshes can safely re-render.
      try {
        this.__eaDataLastRenderArgs = Array.isArray(args) ? args : [];
      } catch {}
      const result = originalRender.call(this, challenge, ...args);
      try {
        currentSbcDetailView = this ?? null;
        ensureSolveButton(this, challenge);
        const payload = toChallengePayload(challenge);
        currentChallenge = challenge ?? null;
        currentSlotPlan = null;
        window.postMessage({ type: "EA_SBC_CHALLENGE_OPENED", payload }, "*");

        const challengeId = payload?.id ?? null;
        const setId = payload?.setId ?? null;
        const isNewChallenge =
          Boolean(challengeId) && challengeId !== lastOpenedChallengeId;

        if (isNewChallenge) {
          lastOpenedChallengeId = challengeId;
          log("info", "[EA Data] SBC challenge opened", payload);
        }

        if (isNewChallenge) {
          triggerAutoFetchForSet(setId, {
            reason: "challenge-open",
            challengeId: challengeId ?? null,
          });
        }

        if (currentChallenge && isNewChallenge) {
          const snapshot = buildRequirementsSnapshot(currentChallenge, null);
          if (snapshot?.requirements?.length) {
            log("debug", "[EA Data] SBC requirements", snapshot.requirements);
          } else {
            log("debug", "[EA Data] SBC requirements empty");
          }
          if (snapshot?.requirementsParsed?.length) {
            log(
              "debug",
              "[EA Data] SBC requirements (parsed)",
              snapshot.requirementsParsed,
            );
          }
        }
      } catch {}
      return result;
    };

    proto.destroyGeneratedElements = function (...args) {
      const result = originalDestroy.call(this, ...args);
      try {
        cleanupSolveButton(this);
        if (currentSbcDetailView === this) currentSbcDetailView = null;
        currentChallenge = null;
        lastOpenedChallengeId = null;
        currentSlotPlan = null;
        log("info", "[EA Data] SBC challenge closed");
        window.postMessage({ type: "EA_SBC_CHALLENGE_CLOSED" }, "*");
        try {
          closeMultiSolveOverlay();
        } catch {}
        try {
          multiSolveOverlayState?.resetForChallenge?.(null);
        } catch {}
        try {
          closeSetSolveOverlay();
        } catch {}
        try {
          setSolveOverlayState?.resetForChallenge?.(null, null);
        } catch {}
      } catch {}
      return result;
    };

    proto.__eaDataHooked = true;
    sbcPanelHooked = true;
    console.log("[EA Data] SBC panel hook installed");
    return true;
  };

  const hookSbcOverviewPanel = () => {
    if (sbcOverviewHooked) return true;
    if (typeof UTSBCSquadOverviewView === "undefined") return false;
    const proto = UTSBCSquadOverviewView.prototype;
    if (!proto || proto.__eaDataOverviewHooked) return true;
    const originalSetSquad = proto.setSquad;
    if (typeof originalSetSquad !== "function") return false;

    const originalDestroy = proto.destroyGeneratedElements;

    proto.setSquad = function (squad, ...args) {
      try {
        currentSbcOverviewView = this ?? null;
        this.__eaDataLastSetSquadArgs = Array.isArray(args) ? args : [];
        this.__eaDataLastSquadEntity = squad ?? null;
      } catch {}
      return originalSetSquad.call(this, squad, ...args);
    };

    if (typeof originalDestroy === "function") {
      proto.destroyGeneratedElements = function (...args) {
        const result = originalDestroy.call(this, ...args);
        try {
          if (currentSbcOverviewView === this) currentSbcOverviewView = null;
          this.__eaDataLastSquadEntity = null;
        } catch {}
        return result;
      };
    }

    proto.__eaDataOverviewHooked = true;
    sbcOverviewHooked = true;
    console.log("[EA Data] SBC overview hook installed");
    return true;
  };

  const hookSbcChallengesView = () => {
    if (sbcChallengesHooked) return true;
    if (typeof UTSBCChallengesView === "undefined") return false;
    const proto = UTSBCChallengesView.prototype;
    if (!proto || proto.__eaDataChallengesHooked) return true;
    const originalSetSbcSet = proto.setSBCSet;
    if (typeof originalSetSbcSet !== "function") return false;
    const originalDestroy = proto.destroyGeneratedElements;

    proto.setSBCSet = function (setEntity, ...args) {
      const result = originalSetSbcSet.call(this, setEntity, ...args);
      try {
        const setId = readNumeric(setEntity?.id) ?? null;
        const isNewSet =
          setId != null &&
          (lastOpenedSetId == null || Number(lastOpenedSetId) !== Number(setId));
        if (isNewSet) {
          lastOpenedSetId = setId;
          log("info", "[EA Data] SBC set opened", {
            setId,
            setName: setEntity?.name ?? null,
          });
          triggerAutoFetchForSet(setId, { reason: "set-open" });
        }
        this.__eaDataLastSetSBCSetArgs = Array.isArray(args) ? args : [];
        this.__eaDataCurrentSetEntity = setEntity ?? null;
        currentSbcChallengesView = this ?? null;
        currentSbcSet = setEntity ?? null;
        ensureSetSolveChooserButton(this, setEntity ?? null);
      } catch {}
      return result;
    };

    if (typeof originalDestroy === "function") {
      proto.destroyGeneratedElements = function (...args) {
        const result = originalDestroy.call(this, ...args);
        try {
          cleanupSetSolveChooserButton(this);
          this.__eaDataLastSetSBCSetArgs = [];
          this.__eaDataCurrentSetEntity = null;
          if (currentSbcChallengesView === this)
            currentSbcChallengesView = null;
          currentSbcSet = null;
          lastOpenedSetId = null;
        } catch {}
        return result;
      };
    }

    proto.__eaDataChallengesHooked = true;
    sbcChallengesHooked = true;
    console.log("[EA Data] SBC challenges view hook installed");
    return true;
  };

  const hookAppSettingsView = () => {
    if (appSettingsHooked) return true;
    if (typeof UTAppSettingsView === "undefined") return false;
    const proto = UTAppSettingsView.prototype;
    if (!proto || proto.__eaDataAppSettingsHooked) return true;
    const originalGenerate = proto._generate;
    if (typeof originalGenerate !== "function") return false;
    const originalDestroy = proto.destroyGeneratedElements;

    proto._generate = function (...args) {
      const result = originalGenerate.call(this, ...args);
      try {
        ensureGlobalSettingsSection(this);
      } catch (error) {
        log("debug", "[EA Data] App settings generate hook failed", error);
      }
      return result;
    };

    if (typeof originalDestroy === "function") {
      proto.destroyGeneratedElements = function (...args) {
        try {
          cleanupGlobalSettingsSection(this);
        } catch {}
        return originalDestroy.call(this, ...args);
      };
    }

    proto.__eaDataAppSettingsHooked = true;
    appSettingsHooked = true;
    console.log("[EA Data] App settings view hook installed");
    return true;
  };

  const hookAppSettingsViewController = () => {
    if (appSettingsControllerHooked) return true;
    if (typeof UTAppSettingsViewController === "undefined") return false;
    const proto = UTAppSettingsViewController.prototype;
    if (!proto || proto.__eaDataAppSettingsControllerHooked) return true;
    const originalViewDidAppear = proto.viewDidAppear;
    if (typeof originalViewDidAppear !== "function") return false;

    proto.viewDidAppear = function (...args) {
      const result = originalViewDidAppear.call(this, ...args);
      try {
        const view =
          (typeof this?.getView === "function" ? this.getView() : null) ??
          this?._view ??
          null;
        if (view) void refreshGlobalSettingsSection(view);
      } catch {}
      return result;
    };

    proto.__eaDataAppSettingsControllerHooked = true;
    appSettingsControllerHooked = true;
    console.log("[EA Data] App settings controller hook installed");
    return true;
  };

  const hookGameRewardsView = () => {
    if (gameRewardsHooked) return true;
    if (typeof UTGameRewardsView === "undefined") return false;
    const proto = UTGameRewardsView.prototype;
    if (!proto || proto.__eaDataGameRewardsHooked) return true;
    const originalGenerate = proto._generate;
    if (typeof originalGenerate !== "function") return false;
    const originalDestroy = proto.destroyGeneratedElements;

    // FC Enhancer reference: capture UTGameRewardsView._actionBtn root from _generate.
    proto._generate = function (...args) {
      const result = originalGenerate.call(this, ...args);
      try {
        const actionRoot = this?._actionBtn?.getRootElement?.() ?? null;
        if (actionRoot) rewardActionButtonRoots.add(actionRoot);
      } catch {}
      return result;
    };

    if (typeof originalDestroy === "function") {
      proto.destroyGeneratedElements = function (...args) {
        const result = originalDestroy.call(this, ...args);
        try {
          for (const node of Array.from(rewardActionButtonRoots)) {
            if (!node || !node.isConnected)
              rewardActionButtonRoots.delete(node);
          }
        } catch {}
        return result;
      };
    }

    proto.__eaDataGameRewardsHooked = true;
    gameRewardsHooked = true;
    console.log("[EA Data] Game rewards view hook installed");
    return true;
  };

  const getViewRootElement = (view) => {
    if (!view) return null;
    try {
      if (typeof view?.getRootElement === "function") {
        const root = view.getRootElement();
        if (root instanceof HTMLElement) return root;
      }
    } catch {}
    const fallback = view?._root ?? view?.root ?? view?.element ?? null;
    return fallback instanceof HTMLElement ? fallback : null;
  };

  const resolveCurrencyRootElement = (view) => {
    if (!view) return null;
    const currencies = view?.__currencies ?? null;
    if (!currencies) return null;
    try {
      if (typeof currencies?.getRootElement === "function") {
        const root = currencies.getRootElement();
        if (root instanceof HTMLElement) return root;
      }
    } catch {}
    const fallback =
      currencies?._root ?? currencies?.root ?? currencies?.element ?? null;
    return fallback instanceof HTMLElement ? fallback : null;
  };

  const resolveTitleRootElement = (view) => {
    if (!view) return null;
    const title = view?.__title ?? null;
    if (!title) return null;
    try {
      if (typeof title?.getRootElement === "function") {
        const root = title.getRootElement();
        if (root instanceof HTMLElement) return root;
      }
    } catch {}
    const fallback = title?._root ?? title?.root ?? title?.element ?? null;
    return fallback instanceof HTMLElement ? fallback : null;
  };

  const getActiveTopbarNavRoot = () => {
    const roots = Array.from(
      document.querySelectorAll(
        ".ut-navigation-bar-view, .navbar-style-landscape, .view-navbar",
      ),
    ).filter((node) => node instanceof HTMLElement && node.isConnected);
    if (!roots.length) return null;
    const visible = roots.find((node) => {
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
    return visible ?? roots[0];
  };

  const resolveTopbarNavRootFromView = (view) => {
    const currencyRoot = resolveCurrencyRootElement(view);
    if (currencyRoot instanceof HTMLElement) {
      const rootFromCurrency = currencyRoot.closest(
        ".ut-navigation-bar-view, .navbar-style-landscape, .view-navbar",
      );
      if (rootFromCurrency instanceof HTMLElement) return rootFromCurrency;
    }
    const viewRoot = getViewRootElement(view);
    if (viewRoot instanceof HTMLElement) {
      if (
        viewRoot.matches?.(
          ".ut-navigation-bar-view, .navbar-style-landscape, .view-navbar",
        )
      ) {
        return viewRoot;
      }
      const nestedRoot = viewRoot.querySelector?.(
        ".ut-navigation-bar-view, .navbar-style-landscape, .view-navbar",
      );
      if (nestedRoot instanceof HTMLElement) return nestedRoot;
    }
    return getActiveTopbarNavRoot();
  };

  const isLikelyTopbarTitle = (node) => {
    if (!(node instanceof HTMLElement)) return false;
    if (!node.isConnected) return false;
    const text = (node.textContent ?? "").trim();
    if (!text || text.length > 48) return false;
    const rect = node.getBoundingClientRect();
    if (!(rect.width > 0 && rect.height > 0)) return false;
    // Top-bar titles live near the top-left area of the viewport.
    if (rect.top < -8 || rect.top > 96) return false;
    if (rect.left < 0 || rect.left > Math.max(520, window.innerWidth * 0.55))
      return false;
    return true;
  };

  const findTopbarTitleInsertionPoint = () => {
    const titleCandidates = Array.from(
      document.querySelectorAll(
        ".ut-navigation-bar-view .title, .navbar-style-landscape .title, .view-navbar .title",
      ),
    ).filter((node) => node instanceof HTMLElement && node.isConnected);
    const fallbackCandidates = Array.from(document.querySelectorAll(".title"))
      .filter((node) => isLikelyTopbarTitle(node))
      .filter((node) => node instanceof HTMLElement && node.isConnected);
    const combined = titleCandidates.length ? titleCandidates : fallbackCandidates;
    if (!combined.length) return null;
    const visibleTitles = titleCandidates.filter((node) => {
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
    const visibleFallback = fallbackCandidates.filter((node) => {
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
    const pool = visibleTitles.length
      ? visibleTitles
      : visibleFallback.length
        ? visibleFallback
        : combined;
    const leftMost = pool
      .slice()
      .sort(
        (a, b) =>
          a.getBoundingClientRect().left - b.getBoundingClientRect().left,
      )[0];
    if (!(leftMost instanceof HTMLElement)) return null;
    if (!(leftMost.parentElement instanceof HTMLElement)) return null;
    return {
      parent: leftMost.parentElement,
      beforeNode: leftMost.nextSibling,
      title: leftMost,
    };
  };

  const ensureTopbarSupportButtonAtTitle = (source = "title-inline") => {
    ensureSolveButtonStyles();
    const existing =
      document.querySelector(EA_DATA_TOPBAR_SUPPORT_SELECTOR) ?? null;
    const point = findTopbarTitleInsertionPoint();
    const titleEl = point?.title instanceof HTMLElement ? point.title : null;
    if (!(titleEl instanceof HTMLElement)) return false;
    const wrap =
      existing instanceof HTMLElement
        ? existing
        : createTopbarSupportButtonWrap();
    try {
      const previousTitle = wrap.closest(".title");
      if (previousTitle instanceof HTMLElement && previousTitle !== titleEl) {
        previousTitle.classList.remove("ea-data-topbar-title--with-support");
      }
      for (const titleNode of Array.from(
        document.querySelectorAll(".ea-data-topbar-title--with-support"),
      )) {
        if (titleNode !== titleEl) {
          try {
            titleNode.classList.remove("ea-data-topbar-title--with-support");
          } catch {}
        }
      }
      if (wrap.classList.contains("ea-data-topbar-support-wrap--anchored")) {
        wrap.classList.remove("ea-data-topbar-support-wrap--anchored");
      }
      if (!wrap.classList.contains("ea-data-topbar-support-wrap--inline")) {
        wrap.classList.add("ea-data-topbar-support-wrap--inline");
      }
      if (!titleEl.classList.contains("ea-data-topbar-title--with-support")) {
        titleEl.classList.add("ea-data-topbar-title--with-support");
      }
      if (wrap.parentElement !== titleEl) {
        titleEl.appendChild(wrap);
      }
      if (
        topbarSupportTooltipAnchorButton instanceof HTMLElement &&
        !topbarSupportTooltipAnchorButton.isConnected
      ) {
        hideTopbarSupportTooltip({ immediate: true });
      }
      return true;
    } catch (error) {
      log("debug", "[EA Data] Top-bar support title attach failed", {
        source,
        error,
      });
      return false;
    }
  };

  const ensureTopbarSupportTooltipElement = () => {
    if (!(document.body instanceof HTMLElement)) return null;
    if (topbarSupportTooltip instanceof HTMLElement && topbarSupportTooltip.isConnected) {
      for (const existing of Array.from(
        document.querySelectorAll(`.${EA_DATA_TOPBAR_SUPPORT_TOOLTIP_CLASS}`),
      )) {
        if (existing !== topbarSupportTooltip) {
          try {
            existing.remove();
          } catch {}
        }
      }
      return topbarSupportTooltip;
    }
    for (const existing of Array.from(
      document.querySelectorAll(`.${EA_DATA_TOPBAR_SUPPORT_TOOLTIP_CLASS}`),
    )) {
      try {
        existing.remove();
      } catch {}
    }
    const tip = document.createElement("div");
    tip.className = EA_DATA_TOPBAR_SUPPORT_TOOLTIP_CLASS;
    tip.id = EA_DATA_TOPBAR_SUPPORT_TOOLTIP_ID;
    tip.setAttribute("role", "tooltip");
    tip.setAttribute("aria-hidden", "true");
    const tipText = document.createElement("span");
    tipText.className = "ea-data-topbar-support-tip__text";
    tipText.textContent = EA_DATA_TOPBAR_SUPPORT_TOOLTIP_TEXT;
    tip.append(tipText);
    document.body.appendChild(tip);
    topbarSupportTooltip = tip;
    return tip;
  };

  const clearTopbarSupportTooltipTimers = () => {
    if (topbarSupportTooltipTimer != null) {
      try {
        clearTimeout(topbarSupportTooltipTimer);
      } catch {}
      topbarSupportTooltipTimer = null;
    }
    if (topbarSupportTooltipHideTimer != null) {
      try {
        clearTimeout(topbarSupportTooltipHideTimer);
      } catch {}
      topbarSupportTooltipHideTimer = null;
    }
  };

  const positionTopbarSupportTooltip = () => {
    const tip = topbarSupportTooltip;
    const button = topbarSupportTooltipAnchorButton;
    if (!(tip instanceof HTMLElement) || !(button instanceof HTMLElement)) return;
    if (!tip.isConnected || !button.isConnected) return;
    const rect = button.getBoundingClientRect();
    const viewportWidth = Math.max(
      0,
      window.innerWidth || document.documentElement?.clientWidth || 0,
    );
    const padding = 14;
    const tipHalfWidth = 160;
    const centerX = rect.left + rect.width / 2;
    const clampedCenterX = Math.max(
      padding + tipHalfWidth,
      Math.min(viewportWidth - padding - tipHalfWidth, centerX),
    );
    const top = rect.bottom + 10;
    tip.style.left = `${Math.round(clampedCenterX)}px`;
    tip.style.top = `${Math.round(top)}px`;
  };

  const onTopbarSupportTooltipViewportChange = () => {
    const tip = topbarSupportTooltip;
    if (!(tip instanceof HTMLElement)) return;
    if (!tip.classList.contains(EA_DATA_TOPBAR_SUPPORT_TOOLTIP_VISIBLE_CLASS))
      return;
    if (
      !(topbarSupportTooltipAnchorButton instanceof HTMLElement) ||
      !topbarSupportTooltipAnchorButton.isConnected
    ) {
      hideTopbarSupportTooltip({ immediate: true });
      return;
    }
    positionTopbarSupportTooltip();
  };

  const attachTopbarSupportTooltipViewportListeners = () => {
    if (topbarSupportTooltipViewportListenersAttached) return;
    topbarSupportTooltipViewportListenersAttached = true;
    try {
      window.addEventListener("resize", onTopbarSupportTooltipViewportChange, {
        passive: true,
      });
    } catch {}
    try {
      window.addEventListener("scroll", onTopbarSupportTooltipViewportChange, {
        passive: true,
        capture: true,
      });
    } catch {}
  };

  const detachTopbarSupportTooltipViewportListeners = () => {
    if (!topbarSupportTooltipViewportListenersAttached) return;
    topbarSupportTooltipViewportListenersAttached = false;
    try {
      window.removeEventListener("resize", onTopbarSupportTooltipViewportChange);
    } catch {}
    try {
      window.removeEventListener("scroll", onTopbarSupportTooltipViewportChange, {
        capture: true,
      });
    } catch {}
  };

  const hideTopbarSupportTooltip = ({ immediate = false } = {}) => {
    clearTopbarSupportTooltipTimers();
    const tip = topbarSupportTooltip;
    if (!(tip instanceof HTMLElement)) return;
    topbarSupportTooltipAnchorButton = null;
    tip.classList.remove(EA_DATA_TOPBAR_SUPPORT_TOOLTIP_VISIBLE_CLASS);
    tip.setAttribute("aria-hidden", "true");
    detachTopbarSupportTooltipViewportListeners();
    if (immediate) return;
    topbarSupportTooltipHideTimer = setTimeout(() => {
      topbarSupportTooltipHideTimer = null;
      const currentTip = topbarSupportTooltip;
      if (!(currentTip instanceof HTMLElement)) return;
      if (
        !currentTip.classList.contains(
          EA_DATA_TOPBAR_SUPPORT_TOOLTIP_VISIBLE_CLASS,
        ) &&
        currentTip.parentElement === document.body
      ) {
        try {
          currentTip.remove();
        } catch {}
      }
      if (topbarSupportTooltip === currentTip) {
        topbarSupportTooltip = null;
      }
    }, 220);
  };

  const scheduleTopbarSupportTooltip = (button, delayMs) => {
    if (!(button instanceof HTMLElement)) return;
    clearTopbarSupportTooltipTimers();
    topbarSupportTooltipAnchorButton = button;
    topbarSupportTooltipTimer = setTimeout(() => {
      topbarSupportTooltipTimer = null;
      if (
        !(topbarSupportTooltipAnchorButton instanceof HTMLElement) ||
        topbarSupportTooltipAnchorButton !== button ||
        !button.isConnected
      ) {
        return;
      }
      const tip = ensureTopbarSupportTooltipElement();
      if (!(tip instanceof HTMLElement)) return;
      positionTopbarSupportTooltip();
      attachTopbarSupportTooltipViewportListeners();
      tip.classList.add(EA_DATA_TOPBAR_SUPPORT_TOOLTIP_VISIBLE_CLASS);
      tip.setAttribute("aria-hidden", "false");
    }, Math.max(80, Number(delayMs) || EA_DATA_TOPBAR_SUPPORT_HOVER_DELAY_MS));
  };

  const createTopbarSupportButtonWrap = () => {
    const wrap = document.createElement("div");
    wrap.className = EA_DATA_TOPBAR_SUPPORT_WRAP_CLASS;
    wrap.setAttribute("data-ea-data-topbar-support", "true");
    const button = document.createElement("button");
    button.type = "button";
    button.className = EA_DATA_TOPBAR_SUPPORT_BUTTON_CLASS;
    button.textContent = "Support My Work";
    button.setAttribute("aria-label", "Support AutopilotSBC on Ko-fi");
    button.setAttribute("aria-describedby", EA_DATA_TOPBAR_SUPPORT_TOOLTIP_ID);
    button.addEventListener("pointerenter", () => {
      scheduleTopbarSupportTooltip(button, EA_DATA_TOPBAR_SUPPORT_HOVER_DELAY_MS);
    });
    button.addEventListener("pointerleave", () => {
      hideTopbarSupportTooltip();
    });
    button.addEventListener("focus", () => {
      scheduleTopbarSupportTooltip(button, EA_DATA_TOPBAR_SUPPORT_FOCUS_DELAY_MS);
    });
    button.addEventListener("blur", () => {
      hideTopbarSupportTooltip();
    });
    button.addEventListener("pointerdown", () => {
      hideTopbarSupportTooltip();
    });
    button.addEventListener("keydown", (event) => {
      if (event?.key === "Escape") hideTopbarSupportTooltip();
    });
    button.addEventListener("click", (event) => {
      try {
        event.preventDefault();
        event.stopPropagation();
      } catch {}
      hideTopbarSupportTooltip({ immediate: true });
      try {
        window.open(EA_DATA_SUPPORT_URL, "_blank", "noopener,noreferrer");
      } catch {}
    });
    wrap.append(button);
    return wrap;
  };

  const injectTopbarSupportButtonForView = (view, source = "view") => {
    if (!view) return false;
    const inserted = ensureTopbarSupportButtonAtTitle(source);
    if (!inserted) return false;
    const wrap =
      document.querySelector(EA_DATA_TOPBAR_SUPPORT_SELECTOR) ?? null;
    if (wrap instanceof HTMLElement) {
      topbarSupportWrapperByView.set(view, wrap);
    }
    return true;
  };

  const injectTopbarSupportButtonIntoNavRoot = (
    navRoot,
    { view = null, source = "unknown" } = {},
  ) => {
    if (!(navRoot instanceof HTMLElement) || !navRoot.isConnected) return false;
    const inserted = ensureTopbarSupportButtonAtTitle(source);
    if (!inserted) return false;
    if (view) {
      const wrap =
        document.querySelector(EA_DATA_TOPBAR_SUPPORT_SELECTOR) ?? null;
      if (wrap instanceof HTMLElement) {
        topbarSupportWrapperByView.set(view, wrap);
      }
    }
    return true;
  };

  const cleanupTopbarSupportButtonFromView = (view) => {
    if (!view) return;
    topbarSupportWrapperByView.delete(view);
    if (
      topbarSupportTooltipAnchorButton instanceof HTMLElement &&
      !topbarSupportTooltipAnchorButton.isConnected
    ) {
      hideTopbarSupportTooltip({ immediate: true });
    }
  };

  const scheduleTopbarSupportReflowBurst = (source = "burst") => {
    topbarSupportReflowToken = (topbarSupportReflowToken ?? 0) + 1;
    const token = topbarSupportReflowToken;
    const run = (phase) => {
      if (token !== topbarSupportReflowToken) return;
      try {
        refreshTopbarSupportButton(`${source}-${phase}`);
      } catch {}
    };
    run("sync");
    if (topbarSupportReflowRafId != null) return;
    try {
      topbarSupportReflowRafId = requestAnimationFrame(() => {
        topbarSupportReflowRafId = null;
        run("raf");
      });
    } catch {
      topbarSupportReflowRafId = null;
    }
  };

  const refreshTopbarSupportButton = (source = "observer") => {
    return ensureTopbarSupportButtonAtTitle(`${source}-title`);
  };

  const resolveTopbarSupportObserverRoot = () => {
    const titlePoint = findTopbarTitleInsertionPoint();
    if (titlePoint?.parent instanceof HTMLElement) {
      return titlePoint.parent;
    }
    const navRoot = getActiveTopbarNavRoot();
    return navRoot instanceof HTMLElement ? navRoot : null;
  };

  const nodeTouchesTopbarNav = (node) => {
    if (!(node instanceof Element)) return false;
    try {
      if (
        node.matches?.(
          ".ut-navigation-bar-view, .navbar-style-landscape, .view-navbar, .title",
        )
      ) {
        return true;
      }
      return Boolean(
        node.querySelector?.(
          ".ut-navigation-bar-view, .navbar-style-landscape, .view-navbar, .title",
        ),
      );
    } catch {
      return false;
    }
  };

  const ensureTopbarSupportDocumentObserver = () => {
    if (topbarSupportDocumentObserverStarted) return;
    if (typeof MutationObserver !== "function") return;
    if (!(document.body instanceof HTMLElement)) return;
    topbarSupportDocumentObserverStarted = true;
    topbarSupportDocumentObserver = new MutationObserver((mutations) => {
      let touchesTopbar = false;
      for (const mutation of mutations ?? []) {
        if (mutation?.type !== "childList") continue;
        for (const added of Array.from(mutation.addedNodes ?? [])) {
          if (nodeTouchesTopbarNav(added)) {
            touchesTopbar = true;
            break;
          }
        }
        if (touchesTopbar) break;
        for (const removed of Array.from(mutation.removedNodes ?? [])) {
          if (nodeTouchesTopbarNav(removed)) {
            touchesTopbar = true;
            break;
          }
        }
        if (touchesTopbar) break;
      }
      if (!touchesTopbar) return;
      ensureTopbarSupportObserver();
      scheduleTopbarSupportReflowBurst("observer-document");
    });
    topbarSupportDocumentObserver.observe(document.body, {
      childList: true,
      subtree: true,
    });
  };

  const ensureTopbarSupportObserver = () => {
    if (typeof MutationObserver !== "function") return;
    const root = resolveTopbarSupportObserverRoot();
    if (!(root instanceof HTMLElement)) return;
    const sameRoot = topbarSupportObserverRoot === root;
    if (topbarSupportObserverStarted && sameRoot && topbarSupportObserver) {
      return;
    }
    if (topbarSupportObserver) {
      try {
        topbarSupportObserver.disconnect();
      } catch {}
    }
    topbarSupportObserverStarted = true;
    topbarSupportObserverRoot = root;
    topbarSupportObserver = new MutationObserver(() => {
      scheduleTopbarSupportReflowBurst("observer-mutation");
    });
    topbarSupportObserver.observe(root, {
      childList: true,
      subtree: true,
    });
    scheduleTopbarSupportReflowBurst("observer-init");
  };

  const hookCurrencyNavigationBarView = () => {
    if (currencyNavBarHooked) return true;
    if (typeof UTCurrencyNavigationBarView === "undefined") return false;
    const proto = UTCurrencyNavigationBarView.prototype;
    if (!proto || proto.__eaDataCurrencyNavBarHooked) return true;
    const originalGenerate = proto._generate;
    if (typeof originalGenerate !== "function") return false;
    const originalDestroy = proto.destroyGeneratedElements;

    proto._generate = function (...args) {
      const result = originalGenerate.call(this, ...args);
      try {
        const injectInline = () => {
          ensureTopbarSupportObserver();
          if (injectTopbarSupportButtonForView(this, "currency-navbar-generate")) {
            return true;
          }
          const navRoot = resolveTopbarNavRootFromView(this);
          if (navRoot instanceof HTMLElement) {
            return injectTopbarSupportButtonIntoNavRoot(navRoot, {
              view: this,
              source: "currency-navbar-generate-fallback",
            });
          }
          return false;
        };
        injectInline();
        try {
          requestAnimationFrame(() => {
            injectInline();
          });
        } catch {
          injectInline();
        }
      } catch (error) {
        log("debug", "[EA Data] Currency nav hook inject failed", error);
      }
      return result;
    };

    if (typeof originalDestroy === "function") {
      proto.destroyGeneratedElements = function (...args) {
        const result = originalDestroy.call(this, ...args);
        try {
          cleanupTopbarSupportButtonFromView(this);
        } catch {}
        return result;
      };
    }

    proto.__eaDataCurrencyNavBarHooked = true;
    currencyNavBarHooked = true;
    console.log("[EA Data] Currency navbar hook installed");
    return true;
  };

  const startTopbarSupportHookPolling = () => {
    ensureTopbarSupportDocumentObserver();
    ensureTopbarSupportObserver();
    if (!topbarSupportResizeHooked) {
      topbarSupportResizeHooked = true;
      try {
        window.addEventListener(
          "resize",
          () => {
            scheduleTopbarSupportReflowBurst("window-resize");
            ensureTopbarSupportObserver();
          },
          { passive: true },
        );
      } catch {}
    }
    scheduleTopbarSupportReflowBurst("topbar-boot");
    refreshTopbarSupportButton("topbar-immediate");
    const intervalId = setInterval(() => {
      const navReady = hookCurrencyNavigationBarView();
      const inserted = refreshTopbarSupportButton("topbar-poll");
      ensureTopbarSupportDocumentObserver();
      ensureTopbarSupportObserver();
      if (navReady && inserted) clearInterval(intervalId);
    }, 300);
    setTimeout(() => {
      try {
        clearInterval(intervalId);
      } catch {}
    }, 15000);
  };

  const startSbcHookPolling = () => {
    loadExcludedPlayerMetaCache();
    loadLeagueMetaCache();
    loadNationMetaCache();
    void ensureExcludedPlayerIdsCache().catch(() => {});
    void ensureExcludedLeagueIdsCache().catch(() => {});
    void ensureExcludedNationIdsCache().catch(() => {});
    const intervalId = setInterval(() => {
      const panelReady = hookSbcChallengePanel();
      const overviewReady = hookSbcOverviewPanel();
      const challengesReady = hookSbcChallengesView();
      const rewardsReady = hookGameRewardsView();
      const itemDetailsReady = hookItemDetailsViewController();
      const slotActionReady = hookSlotActionPanelView();
      if (
        panelReady &&
        overviewReady &&
        challengesReady &&
        rewardsReady &&
        itemDetailsReady &&
        slotActionReady
      ) {
        clearInterval(intervalId);
      }
    }, 500);
  };

  const startAppSettingsHookPolling = () => {
    const intervalId = setInterval(() => {
      const viewReady = hookAppSettingsView();
      const controllerReady = hookAppSettingsViewController();
      if (viewReady && controllerReady) {
        clearInterval(intervalId);
      }
    }, 750);
  };

  const scheduleSolverBridgeInit = async () => {
    const ready = await waitForEaReady();
    if (!ready) return;
    await initSolverBridge();
  };

  const resolvePlayerName = (item) => {
    if (!item) return null;
    const pick = (value) => {
      if (typeof value !== "string") return null;
      const trimmed = value.trim();
      return trimmed ? trimmed : null;
    };
    try {
      if (typeof item.getName === "function") {
        const name = pick(item.getName());
        if (name) return name;
      }
    } catch {}
    const direct = pick(
      item.commonName ??
        item.displayName ??
        item.shortName ??
        item.name ??
        null,
    );
    if (direct) return direct;
    const first = pick(item.firstName ?? null);
    const last = pick(item.lastName ?? null);
    if (first || last) return [first, last].filter(Boolean).join(" ");
    const asset = pick(
      item.assetName ?? item.resourceName ?? item._name ?? null,
    );
    if (asset) return asset;
    const staticData = item.staticData ?? item._staticData ?? null;
    if (staticData) {
      const staticName = pick(
        staticData.commonName ??
          staticData.displayName ??
          staticData.name ??
          null,
      );
      if (staticName) return staticName;
      const sFirst = pick(staticData.firstName ?? null);
      const sLast = pick(staticData.lastName ?? null);
      if (sFirst || sLast) return [sFirst, sLast].filter(Boolean).join(" ");
    }
    return null;
  };

  const toPlainPlayer = (item, options = {}) => {
    const duplicateDefIds = options?.duplicateDefIds ?? null;
    const source = options?.source ?? null;
    const rarityId = item.rareflag ?? item.rarityId ?? item.rarity ?? null;
    const isSpecial =
      typeof item.isSpecial === "function"
        ? item.isSpecial()
        : typeof item.isSpecial === "boolean"
          ? item.isSpecial
          : rarityId != null
            ? rarityId > 1
            : null;
    const preferredPositionId =
      item.preferredPosition ??
      item.preferredPositionId ??
      item.position ??
      null;
    const alternativePositionIds =
      item.possiblePositions ??
      item.alternativePositions ??
      item.altPositions ??
      [];
    const preferredPositionName = getPositionName(preferredPositionId);
    const alternativePositionNames = Array.isArray(alternativePositionIds)
      ? alternativePositionIds
          .map((posId) => getPositionName(posId))
          .filter(Boolean)
      : [];

    const storagePile = services?.Item?.UTItemPileEnum?.STORAGE ?? 10;
    const isStorage =
      source === "storage"
        ? true
        : source === "club"
          ? false
          : item.pile === storagePile;
    const isUntradeable =
      typeof item.isTradeable === "function"
        ? !item.isTradeable()
        : !item.isTradeable;
    const isEvolution =
      typeof item.isEvolution === "function"
        ? Boolean(item.isEvolution())
        : Boolean(item.isEvolution ?? item.upgrades);
    const isAcademy = Boolean(item.isEnrolledInAcademy?.());
    const isDuplicate =
      Boolean(duplicateDefIds?.has(item.definitionId)) &&
      !isStorage &&
      !isAcademy &&
      !isEvolution;
    return {
      id: item.id,
      definitionId: item.definitionId,
      name: resolvePlayerName(item),
      pile: item.pile,
      isTradeable: item.isTradeable?.(),
      isUntradeable,
      isStorage,
      isDuplicate,
      rating: item.rating,
      leagueId: item.leagueId,
      leagueName: resolveEntityLeagueName(item),
      nationId: item.nationId,
      nationName: resolveEntityNationName(item),
      teamId: item.teamId,
      playStyle: item.playStyle,
      owners: item.owners,
      upgrades: item.upgrades,
      isEnrolledInAcademy: item.isEnrolledInAcademy?.(),
      rarityId,
      rarityName: getRarityName(rarityId),
      isSpecial,
      isEvolution,
      preferredPositionId,
      preferredPositionName,
      alternativePositionIds,
      alternativePositionNames,
    };
  };

  const toPlainChallenge = (ch) => {
    const snapshot = buildRequirementsSnapshot(ch, null);
    return {
      id: ch.id,
      setId: ch.setId,
      requirements: snapshot.requirements,
      requirementsParsed: snapshot.requirementsParsed,
      requirementsNormalized: snapshot.requirementsNormalized,
      squad: ch.squad ?? ch.getSquad?.(),
      repeatable: ch.repeatable,
      isCompleted: ch.isCompleted?.(),
    };
  };

  const pendingRequests = new Map();
  let autoFetchEnabled = true;
  let autoFetchInFlight = false;

  const sendToPage = (type, payload) =>
    new Promise((resolve, reject) => {
      const requestId = crypto.randomUUID();
      pendingRequests.set(requestId, { resolve, reject });
      window.postMessage({ type, requestId, payload }, "*");
    });

  const reply = (requestId, ok, data, error) => {
    window.postMessage({ type: RES, requestId, ok, data, error }, "*");
  };

  window.addEventListener("message", async (event) => {
    const { type, requestId, payload } = event.data || {};
    if (type === PREF_BRIDGE_RES && requestId) {
      const pending = prefBridgeRequests.get(requestId);
      if (!pending) return;
      prefBridgeRequests.delete(requestId);
      if (event.data.ok) pending.resolve(event.data.data);
      else pending.reject(event.data.error);
      return;
    }
    if (type === SOLVER_BRIDGE_RESPONSE && requestId) {
      const pending = solverBridgeRequests.get(requestId);
      if (!pending) return;
      solverBridgeRequests.delete(requestId);
      if (event.data.ok) pending.resolve(event.data.data);
      else pending.reject(event.data.error);
      return;
    }
    // Ignore our own outbound requests; they are meant for the content-script bridge.
    if (
      (type === PREF_BRIDGE_GET ||
        type === PREF_BRIDGE_SET ||
        type === SOLVER_BRIDGE_REQUEST) &&
      requestId
    ) {
      return;
    }
    if (type === SOLVER_BRIDGE_RESPONSE && event.detail?.requestId) {
      const detail = event.detail;
      const pending = solverBridgeRequests.get(detail.requestId);
      if (!pending) return;
      solverBridgeRequests.delete(detail.requestId);
      if (detail.ok) pending.resolve(detail.data);
      else pending.reject(detail.error);
      return;
    }
    if (type === SOLVER_BRIDGE_TRACE) {
      log("debug", "[EA Data] Solver bridge trace", {
        stage: event.data?.stage,
        requestId: event.data?.requestId,
        details: event.data?.details ?? null,
      });
      return;
    }
    if (type === RES && requestId) {
      const pending = pendingRequests.get(requestId);
      if (!pending) return;
      pendingRequests.delete(requestId);
      if (event.data.ok) pending.resolve(event.data.data);
      else pending.reject(event.data.error);
      return;
    }
    if (!requestId) return;
    const ready = await waitForEaReady();
    if (!ready) {
      return reply(requestId, false, null, {
        code: "EA_RUNTIME_UNAVAILABLE",
        message: "EA services not ready",
      });
    }

    try {
      if (type === REQ.CLUB)
        return reply(requestId, true, await getClubPlayers(payload));
      if (type === REQ.STORAGE)
        return reply(requestId, true, await getStoragePlayers());
      if (type === REQ.CHALLENGES)
        return reply(
          requestId,
          true,
          await getChallengesBySetIds(payload?.setIds || []),
        );
      if (type === REQ.SETS) return reply(requestId, true, await getSbcSets());
    } catch (err) {
      return reply(requestId, false, null, {
        code: "EA_REQUEST_FAILED",
        message: err?.message || "EA request failed",
      });
    }
  });

  document.addEventListener(SOLVER_BRIDGE_RESPONSE, (event) => {
    const detail = event.detail;
    if (!detail?.requestId) return;
    const pending = solverBridgeRequests.get(detail.requestId);
    if (!pending) return;
    solverBridgeRequests.delete(detail.requestId);
    if (detail.ok) pending.resolve(detail.data);
    else pending.reject(detail.error);
  });

  document.addEventListener(SOLVER_BRIDGE_PONG, (event) => {
    const detail = event.detail;
    if (!detail) return;
    log("debug", "[EA Data] Solver bridge pong", detail);
  });

  window.addEventListener("message", (event) => {
    if (event?.data?.type !== SOLVER_BRIDGE_PONG) return;
    log("debug", "[EA Data] Solver bridge pong", event.data);
  });

  document.addEventListener(SOLVER_BRIDGE_TRACE, (event) => {
    const detail = event.detail;
    if (!detail) return;
    log("debug", "[EA Data] Solver bridge trace", {
      stage: detail.stage,
      requestId: detail.requestId,
      details: detail.details ?? null,
    });
  });

  startSbcHookPolling();
  startAppSettingsHookPolling();
  try {
    startTopbarSupportHookPolling();
  } catch (error) {
    log("debug", "[EA Data] Top-bar support hook failed to start", error);
  }
  scheduleSolverBridgeInit();

  const logResult = (label, data) => {
    console.log(`[EA Data] ${label}`, data);
    return data;
  };

  window.eaData = {
    getClubPlayers: (options) =>
      sendToPage("EA_DATA_GET_CLUB_PLAYERS", options).then((data) =>
        logResult("Club players", data),
      ),
    getStoragePlayers: () =>
      sendToPage("EA_DATA_GET_STORAGE_PLAYERS").then((data) =>
        logResult("Storage players", data),
      ),
    getSbcChallenges: (setIds) =>
      sendToPage("EA_DATA_GET_SBC_CHALLENGES", { setIds }).then((data) =>
        logResult("SBC challenges", data),
      ),
    getSbcSets: () =>
      sendToPage("EA_DATA_GET_SBC_SETS").then((data) =>
        logResult("SBC sets", data),
      ),
    getChallengeRequirements: async ({ setId, challengeId }) => {
      if (!setId || !challengeId) return null;
      const challenges = await getChallengesBySetIdsRaw([setId]);
      const match = challenges.find((ch) => ch.id === challengeId);
      if (!match) return null;
      const result = await loadChallenge(match, true);
      const snapshot = buildRequirementsSnapshot(match, result?.data ?? result);
      return {
        challengeId: match.id,
        setId: match.setId,
        requirements: snapshot.requirements,
        requirementsParsed: snapshot.requirementsParsed,
        requirementsNormalized: snapshot.requirementsNormalized,
      };
    },
    getOpenChallengeRequirements: async () => {
      if (!currentChallenge) return null;
      const result = await loadChallenge(currentChallenge, true);
      const snapshot = buildRequirementsSnapshot(
        currentChallenge,
        result?.data ?? result,
      );
      return {
        challengeId: currentChallenge.id,
        setId: currentChallenge.setId,
        requirements: snapshot.requirements,
        requirementsParsed: snapshot.requirementsParsed,
        requirementsNormalized: snapshot.requirementsNormalized,
      };
    },
    getOpenChallengeSlots: async () => {
      if (!currentChallenge) return null;
      const loaded = await loadChallenge(currentChallenge, true, {
        force: true,
      });
      const squad =
        currentChallenge?.squad ??
        loaded?.data?.squad ??
        loaded?.squad ??
        (typeof currentChallenge?.getSquad === "function"
          ? currentChallenge.getSquad()
          : null);

      const formationName =
        squad?.getFormation?.()?.name ?? squad?.formation?.name ?? null;
      const requiredPlayers =
        typeof squad?.getNumOfRequiredPlayers === "function"
          ? squad.getNumOfRequiredPlayers()
          : null;

      const slots = squad?.getPlayers?.() ?? [];
      const fieldPlayers = squad?.getFieldPlayers?.() ?? [];

      const toPrimitivePosition = (value) => {
        if (value == null) return null;
        if (typeof value === "string" || typeof value === "number")
          return value;
        if (typeof value === "object") {
          return (
            value?.typeName ?? value?.name ?? value?.label ?? value?.id ?? null
          );
        }
        return null;
      };

      const toPrimitiveItem = (item) => {
        if (!item) return null;
        const concept =
          typeof item?.isConcept === "function"
            ? item.isConcept()
            : Boolean(item?.concept);
        return {
          id: item?.id ?? null,
          definitionId: item?.definitionId ?? null,
          concept,
        };
      };

      const normalizeSlot = (slot, index) => {
        const item = resolveSlotItem(slot);
        const resolvedPosition = toPrimitivePosition(resolveSlotPosition(slot));
        const positionObj = slot?.position ?? null;
        const positionTypeName =
          positionObj?.typeName ??
          positionObj?.name ??
          positionObj?.label ??
          null;
        const positionTypeId =
          positionObj?.typeId ?? positionObj?.id ?? slot?.positionId ?? null;
        const isLocked = resolveSlotLocked(slot);
        const isEditable =
          typeof slot?.isEditable === "function"
            ? slot.isEditable()
            : typeof slot?.isEditable === "boolean"
              ? slot.isEditable
              : null;
        const isBrick = resolveSlotBrick(slot);
        const isValid = resolveSlotValid(slot, item);
        const slotKeys =
          slot && typeof slot === "object"
            ? Object.keys(slot).slice(0, 50)
            : [];
        const protoMethods = (() => {
          if (!slot || typeof slot !== "object") return [];
          const proto = Object.getPrototypeOf(slot);
          if (!proto) return [];
          return Object.getOwnPropertyNames(proto)
            .filter((name) => typeof slot[name] === "function")
            .slice(0, 50);
        })();

        return {
          index,
          positionResolved: resolvedPosition,
          positionTypeName,
          positionTypeId,
          positionId: slot?.positionId ?? null,
          positionName: slot?.positionName ?? null,
          pos: slot?.pos ?? null,
          isLocked,
          isEditable,
          isBrick,
          isValid,
          item: toPrimitiveItem(item),
          slotKeys,
          protoMethods,
        };
      };

      const normalizeFieldPlayer = (entry, index) => {
        const item = entry?.item ?? entry?.getItem?.() ?? null;
        const positionObj = entry?.position ?? null;
        return {
          index,
          positionTypeName:
            positionObj?.typeName ??
            positionObj?.name ??
            positionObj?.label ??
            null,
          positionTypeId: positionObj?.typeId ?? positionObj?.id ?? null,
          item: toPrimitiveItem(item),
        };
      };

      return {
        challengeId: currentChallenge.id,
        setId: currentChallenge.setId,
        formationName,
        requiredPlayers,
        slotCount: Array.isArray(slots) ? slots.length : 0,
        fieldPlayersCount: Array.isArray(fieldPlayers)
          ? fieldPlayers.length
          : 0,
        slots: Array.isArray(slots) ? slots.map(normalizeSlot) : [],
        fieldPlayers: Array.isArray(fieldPlayers)
          ? fieldPlayers.map(normalizeFieldPlayer)
          : [],
      };
    },
    getSolverPayload: async (options = {}, setIds = []) => {
      const solverOptions = {
        ...options,
        excludeActiveSquad: options?.excludeActiveSquad ?? true,
      };
      const forcePlayersFetch =
        options?.forcePlayersFetch === true ||
        options?.forcePlayers === true ||
        options?.forceFetch === true ||
        options?.force === true;
      const { clubPlayers, storagePlayers, duplicateDefIds } =
        await ensurePlayersSnapshot(solverOptions, {
          force: forcePlayersFetch,
        });
      const requiredDuplicates =
        getChallengeSquadDefinitionIds(currentChallenge);
      const clubDefIds = new Set(
        clubPlayers
          .map((player) => player?.definitionId ?? null)
          .filter((value) => value != null),
      );
      if (requiredDuplicates?.size) {
        for (const defId of requiredDuplicates) {
          if (defId == null) continue;
          clubDefIds.add(defId);
          clubDefIds.add(String(defId));
        }
      }
      const filteredStoragePlayers = storagePlayers.filter((player) => {
        const defId = player?.definitionId ?? null;
        if (defId == null) return true;
        return !clubDefIds.has(defId) && !clubDefIds.has(String(defId));
      });
      const openReq = await window.eaData.getOpenChallengeRequirements();
      let formationName = null;
      let requiredPlayers = null;
      let slotCount = null;
      let squadSlots = [];
      if (currentChallenge) {
        try {
          const loaded = await loadChallenge(currentChallenge, true, {
            force: true,
          });
          const squad =
            currentChallenge?.squad ??
            loaded?.data?.squad ??
            loaded?.squad ??
            (typeof currentChallenge?.getSquad === "function"
              ? currentChallenge.getSquad()
              : null);
          formationName =
            squad?.getFormation?.()?.name ?? squad?.formation?.name ?? null;
          requiredPlayers =
            typeof squad?.getNumOfRequiredPlayers === "function"
              ? squad.getNumOfRequiredPlayers()
              : null;
          const slots = squad?.getPlayers?.() ?? [];
          slotCount = Array.isArray(slots) ? slots.length : 0;

          const normalizeSlotForSolver = (slot, index) => {
            const item = resolveSlotItem(slot);
            const concept =
              typeof item?.isConcept === "function"
                ? item.isConcept()
                : Boolean(item?.concept);
            const positionObj = slot?.position ?? null;
            const positionTypeName =
              positionObj?.typeName ??
              positionObj?.name ??
              positionObj?.label ??
              null;
            const resolved = resolveSlotPosition(slot);
            const resolvedName =
              typeof resolved === "string"
                ? resolved
                : typeof resolved === "object"
                  ? (resolved?.typeName ??
                    resolved?.name ??
                    resolved?.label ??
                    null)
                  : null;
            const positionName = positionTypeName ?? resolvedName ?? null;

            return {
              slotIndex: index,
              positionName,
              isLocked: resolveSlotLocked(slot),
              isEditable:
                typeof slot?.isEditable === "function"
                  ? slot.isEditable()
                  : typeof slot?.isEditable === "boolean"
                    ? slot.isEditable
                    : null,
              isBrick: resolveSlotBrick(slot),
              isValid: resolveSlotValid(slot, item),
              item: item
                ? {
                    id: item?.id ?? null,
                    definitionId: item?.definitionId ?? null,
                    concept,
                  }
                : null,
            };
          };

          const normalizedSlots = Array.isArray(slots)
            ? slots.map(normalizeSlotForSolver)
            : [];
          const fieldSlots = normalizedSlots.filter((slot) =>
            Boolean(slot?.positionName),
          );
          const take =
            typeof requiredPlayers === "number" && requiredPlayers > 0
              ? requiredPlayers
              : 11;
          squadSlots = fieldSlots.slice(0, take).map((slot) => ({
            slotIndex: slot.slotIndex,
            positionName: slot.positionName,
            isLocked: slot.isLocked,
            isEditable: slot.isEditable,
            isBrick: slot.isBrick,
            isValid: slot.isValid,
            item: slot.item,
          }));
        } catch {}
      }
      const sbcChallenges = setIds?.length
        ? await getChallengesBySetIds(setIds)
        : [];
      const mergedPlayers = clubPlayers
        .concat(filteredStoragePlayers)
        .filter((player) => !player?.isEnrolledInAcademy);
      const excludedStorageIds = buildExcludedStorageIds(
        mergedPlayers,
        requiredDuplicates,
      );
      return {
        clubPlayers,
        storagePlayers: filteredStoragePlayers,
        players: mergedPlayers,
        openChallenge: openReq,
        formationName,
        requiredPlayers,
        slotCount,
        squadSlots,
        sbcChallenges,
        prioritize: {
          duplicates: true,
          untradeables: true,
          storage: false,
        },
        filters: {
          onlyDuplicates: false,
          onlyUntradeables: false,
          onlyStorage: false,
          excludedPlayerIds: excludedStorageIds,
        },
      };
    },
    fetchAll: async (options, setIds) => {
      const { clubPlayers, storagePlayers } =
        await ensurePlayersSnapshot(options);
      const includeChallenges = options?.includeChallenges === true;
      const sbcChallenges =
        includeChallenges && setIds?.length
          ? await getChallengesBySetIds(setIds)
          : [];
      return { clubPlayers, storagePlayers, sbcChallenges };
    },
    triggerFetch: (options = {}, setIds = [], { silent = false } = {}) =>
      window.eaData.fetchAll(options, setIds).then((data) => {
        if (!silent) {
          console.log("[EA Data] Fetch triggered", data);
          console.log("[EA Data] Club players", data.clubPlayers);
          console.log("[EA Data] Storage players", data.storagePlayers);
          console.log("[EA Data] SBC challenges", data.sbcChallenges);
        }
        return data;
      }),
    ensurePlayersFetched: (options = {}, config = {}) =>
      ensurePlayersSnapshot(options, config),
    getPlayersFetchStatus: (options = {}) => getPlayersSnapshotStatus(options),
    clearPlayersFetchCache: () => clearPlayersSnapshotCache(),
    setAutoFetch: (enabled) => {
      autoFetchEnabled = Boolean(enabled);
      console.log(
        "[EA Data] Auto-fetch",
        autoFetchEnabled ? "enabled" : "disabled",
      );
    },
    setDebug: (enabled) => {
      debugEnabled = persistDebugEnabled(enabled);
      const marker = document.documentElement?.dataset?.eaSolverBridge || null;
      const markerAt =
        document.documentElement?.dataset?.eaSolverBridgeAt || null;
      console.log("[EA Data] Debug", debugEnabled ? "enabled" : "disabled");
      if (debugEnabled) {
        if (marker) {
          console.log("[EA Data] Solver bridge marker", {
            marker,
            markerAt,
          });
        }
        void pingSolverBridge();
      }
      return {
        enabled: debugEnabled,
        solverBridgeReady: Boolean(solverBridgeReady),
        solverBridgeError: solverBridgeError
          ? String(solverBridgeError?.message ?? solverBridgeError)
          : null,
        marker,
        markerAt,
      };
    },
    getDebug: () => ({
      bridgeVersion: "2026-02-22a",
      enabled: Boolean(debugEnabled),
      persisted: readPersistedDebugEnabled(),
      solverBridgeReady: Boolean(solverBridgeReady),
      solverBridgeError: solverBridgeError
        ? String(solverBridgeError?.message ?? solverBridgeError)
        : null,
    }),
    getSolverPreferences: async ({ force = false } = {}) =>
      getPreferences({ force }),
    getGlobalSolverSettings: async () => getSolverSettingsForChallenge(null),
    setGlobalSolverSettings: async (settings) =>
      setGlobalSolverSettings(settings),
    resetGlobalSolverSettings: async () => resetGlobalSolverSettings(),
    getChallengeSolverSettings: async (
      challengeId = currentChallenge?.id ?? null,
      options = {},
    ) => getSolverSettingsForChallenge(challengeId, options),
    setChallengeSolverSettings: async (
      challengeId = currentChallenge?.id ?? null,
      settings = {},
    ) => setChallengeSolverSettings(challengeId, settings),
    getGlobalExcludedPlayerIds: async () => getGlobalExcludedPlayerIds(),
    setGlobalExcludedPlayerIds: async (ids = []) =>
      setGlobalExcludedPlayerIds(ids),
    toggleGlobalExcludedPlayerId: async (itemId, excluded = true) =>
      toggleGlobalExcludedPlayerId(itemId, excluded),
    clearGlobalExcludedPlayerIds: async () => clearGlobalExcludedPlayerIds(),
    getGlobalExcludedLeagueIds: async () => getGlobalExcludedLeagueIds(),
    setGlobalExcludedLeagueIds: async (ids = []) =>
      setGlobalExcludedLeagueIds(ids),
    toggleGlobalExcludedLeagueId: async (leagueId, excluded = true) =>
      toggleGlobalExcludedLeagueId(leagueId, excluded),
    clearGlobalExcludedLeagueIds: async () => clearGlobalExcludedLeagueIds(),
    getGlobalExcludedNationIds: async () => getGlobalExcludedNationIds(),
    setGlobalExcludedNationIds: async (ids = []) =>
      setGlobalExcludedNationIds(ids),
    toggleGlobalExcludedNationId: async (nationId, excluded = true) =>
      toggleGlobalExcludedNationId(nationId, excluded),
    clearGlobalExcludedNationIds: async () => clearGlobalExcludedNationIds(),
    getGlobalRatingRange: async () =>
      (await getSolverSettingsForChallenge(null)).ratingRange,
    setGlobalRatingRange: async (range) => setGlobalRatingRange(range),
    resetGlobalRatingRange: async () => resetGlobalRatingRange(),
    getChallengeRatingRange: async (
      challengeId = currentChallenge?.id ?? null,
      options = {},
    ) => getRatingRangeForChallenge(challengeId, options),
    getEligibilityEnums: () => ({
      scope:
        typeof SBCEligibilityScope !== "undefined" ? SBCEligibilityScope : null,
      keys: resolveEligibilityKeyEnum(),
    }),
  };
})();
