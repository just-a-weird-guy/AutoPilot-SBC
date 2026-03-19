(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  if (root && typeof root === "object") {
    root.__eaDataLocalExclusionsShared = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const LOCAL_EXCLUSION_FIELDS = Object.freeze([
    "allowedGlobalLeagueIds",
    "allowedGlobalNationIds",
    "extraExcludedLeagueIds",
    "extraExcludedNationIds",
  ]);

  const normalizeIdList = (value, fallback = []) => {
    const source = Array.isArray(value)
      ? value
      : Array.isArray(fallback)
        ? fallback
        : [];
    const normalized = [];
    const seen = new Set();
    for (const entry of source) {
      if (entry == null) continue;
      const text = String(entry).trim();
      if (!text || seen.has(text)) continue;
      seen.add(text);
      normalized.push(text);
    }
    return normalized;
  };

  const getDefaultLocalExclusionSettings = () => ({
    allowedGlobalLeagueIds: [],
    allowedGlobalNationIds: [],
    extraExcludedLeagueIds: [],
    extraExcludedNationIds: [],
  });

  const normalizeLocalExclusionSettings = (value, fallback = null) => {
    const raw = value && typeof value === "object" ? value : {};
    const base =
      fallback && typeof fallback === "object"
        ? fallback
        : getDefaultLocalExclusionSettings();
    return {
      allowedGlobalLeagueIds: normalizeIdList(
        raw.allowedGlobalLeagueIds,
        base.allowedGlobalLeagueIds,
      ),
      allowedGlobalNationIds: normalizeIdList(
        raw.allowedGlobalNationIds,
        base.allowedGlobalNationIds,
      ),
      extraExcludedLeagueIds: normalizeIdList(
        raw.extraExcludedLeagueIds,
        base.extraExcludedLeagueIds,
      ),
      extraExcludedNationIds: normalizeIdList(
        raw.extraExcludedNationIds,
        base.extraExcludedNationIds,
      ),
    };
  };

  const hasLocalExclusionSettings = (value) => {
    const normalized = normalizeLocalExclusionSettings(value);
    return LOCAL_EXCLUSION_FIELDS.some(
      (field) => (normalized[field] ?? []).length > 0,
    );
  };

  const computeEffectiveExcludedIds = ({
    globalExcludedIds = [],
    allowedGlobalIds = [],
    extraExcludedIds = [],
  } = {}) => {
    const globalIds = normalizeIdList(globalExcludedIds, []);
    const allowedIds = new Set(normalizeIdList(allowedGlobalIds, []));
    const extraIds = normalizeIdList(extraExcludedIds, []);
    const effective = [];
    const seen = new Set();

    for (const id of globalIds) {
      if (allowedIds.has(id) || seen.has(id)) continue;
      seen.add(id);
      effective.push(id);
    }
    for (const id of extraIds) {
      if (seen.has(id)) continue;
      seen.add(id);
      effective.push(id);
    }
    return effective;
  };

  const resolveLocalExclusionSettings = ({
    globalExcludedLeagueIds = [],
    globalExcludedNationIds = [],
    localSettings = null,
    fallback = null,
  } = {}) => {
    const normalized = normalizeLocalExclusionSettings(localSettings, fallback);
    return {
      ...normalized,
      excludedLeagueIds: computeEffectiveExcludedIds({
        globalExcludedIds: globalExcludedLeagueIds,
        allowedGlobalIds: normalized.allowedGlobalLeagueIds,
        extraExcludedIds: normalized.extraExcludedLeagueIds,
      }),
      excludedNationIds: computeEffectiveExcludedIds({
        globalExcludedIds: globalExcludedNationIds,
        allowedGlobalIds: normalized.allowedGlobalNationIds,
        extraExcludedIds: normalized.extraExcludedNationIds,
      }),
    };
  };

  const applyLocalExclusionsToSettings = ({
    settings = null,
    globalSettings = null,
  } = {}) => {
    const rawSettings = settings && typeof settings === "object" ? settings : {};
    const rawGlobal =
      globalSettings && typeof globalSettings === "object" ? globalSettings : {};
    const localSettings = normalizeLocalExclusionSettings(rawSettings);
    const hasLocalFields = hasLocalExclusionSettings(localSettings);
    const excludedLeagueIds = normalizeIdList(rawSettings.excludedLeagueIds, []);
    const excludedNationIds = normalizeIdList(rawSettings.excludedNationIds, []);

    if (!hasLocalFields) {
      return {
        ...rawSettings,
        excludedLeagueIds,
        excludedNationIds,
      };
    }

    const resolved = resolveLocalExclusionSettings({
      globalExcludedLeagueIds: rawGlobal.excludedLeagueIds,
      globalExcludedNationIds: rawGlobal.excludedNationIds,
      localSettings,
    });
    return {
      ...rawSettings,
      ...resolved,
    };
  };

  const mergeLocalExclusionsIntoSettings = ({
    settings = null,
    globalSettings = null,
    localSettings = null,
    force = false,
  } = {}) => {
    const rawSettings = settings && typeof settings === "object" ? settings : {};
    const normalizedLocal = normalizeLocalExclusionSettings(localSettings);
    const shouldApply = force || hasLocalExclusionSettings(normalizedLocal);
    if (!shouldApply) {
      return applyLocalExclusionsToSettings({
        settings: rawSettings,
        globalSettings,
      });
    }
    const mergedSettings = {
      ...rawSettings,
      ...normalizedLocal,
    };
    const resolved = resolveLocalExclusionSettings({
      globalExcludedLeagueIds: globalSettings?.excludedLeagueIds,
      globalExcludedNationIds: globalSettings?.excludedNationIds,
      localSettings: normalizedLocal,
    });
    return {
      ...mergedSettings,
      ...resolved,
    };
  };

  const normalizeSetId = (value) => {
    if (value == null) return null;
    const text = String(value).trim();
    if (!text) return null;
    const numeric = Number(text);
    if (!Number.isFinite(numeric) || numeric < 0) return null;
    return String(Math.trunc(numeric));
  };

  const getLocalExclusionFieldsForKind = (kind) => {
    const normalizedKind = String(kind ?? "")
      .trim()
      .toLowerCase();
    if (normalizedKind === "nation") {
      return {
        allowedField: "allowedGlobalNationIds",
        extraField: "extraExcludedNationIds",
      };
    }
    return {
      allowedField: "allowedGlobalLeagueIds",
      extraField: "extraExcludedLeagueIds",
    };
  };

  const getLocalExclusionStateForKind = ({
    kind = "league",
    settings = null,
    globalExcludedIds = [],
  } = {}) => {
    const normalizedSettings = normalizeLocalExclusionSettings(settings);
    const fields = getLocalExclusionFieldsForKind(kind);
    const normalizedGlobalExcludedIds = normalizeIdList(globalExcludedIds, []);
    const allowedGlobalIds = normalizeIdList(
      normalizedSettings[fields.allowedField],
      [],
    );
    const extraExcludedIds = normalizeIdList(
      normalizedSettings[fields.extraField],
      [],
    );
    return {
      allowedField: fields.allowedField,
      extraField: fields.extraField,
      globalExcludedIds: normalizedGlobalExcludedIds,
      allowedGlobalIds,
      extraExcludedIds,
      effectiveExcludedIds: computeEffectiveExcludedIds({
        globalExcludedIds: normalizedGlobalExcludedIds,
        allowedGlobalIds,
        extraExcludedIds,
      }),
    };
  };

  const toggleIdInList = (list, id, shouldInclude) => {
    const normalizedList = normalizeIdList(list, []);
    const normalizedId = normalizeSetId(id);
    if (!normalizedId) return normalizedList;
    const filtered = normalizedList.filter(
      (entry) => String(entry) !== String(normalizedId),
    );
    if (shouldInclude) filtered.push(normalizedId);
    return filtered;
  };

  const toggleLocalExclusionId = ({
    kind = "league",
    mode = "toggle",
    id = null,
    settings = null,
    globalExcludedIds = [],
  } = {}) => {
    const normalizedSettings = normalizeLocalExclusionSettings(settings);
    const fields = getLocalExclusionFieldsForKind(kind);
    const normalizedMode = String(mode ?? "toggle")
      .trim()
      .toLowerCase();
    const normalizedId = normalizeSetId(id);
    const globalExcludedSet = new Set(normalizeIdList(globalExcludedIds, []));
    const next = {
      ...normalizedSettings,
      [fields.allowedField]: normalizeIdList(
        normalizedSettings[fields.allowedField],
        [],
      ),
      [fields.extraField]: normalizeIdList(normalizedSettings[fields.extraField], []),
    };

    if (normalizedMode === "clear_allowed") {
      next[fields.allowedField] = [];
      return normalizeLocalExclusionSettings(next);
    }
    if (normalizedMode === "clear_extra") {
      next[fields.extraField] = [];
      return normalizeLocalExclusionSettings(next);
    }
    if (!normalizedId) {
      return normalizeLocalExclusionSettings(next);
    }

    const inAllowed = next[fields.allowedField].includes(normalizedId);
    const inExtra = next[fields.extraField].includes(normalizedId);
    const globallyExcluded = globalExcludedSet.has(normalizedId);

    if (normalizedMode === "allowed") {
      next[fields.extraField] = toggleIdInList(next[fields.extraField], normalizedId, false);
      next[fields.allowedField] = toggleIdInList(next[fields.allowedField], normalizedId, true);
      return normalizeLocalExclusionSettings(next);
    }
    if (normalizedMode === "extra") {
      next[fields.allowedField] = toggleIdInList(next[fields.allowedField], normalizedId, false);
      next[fields.extraField] = toggleIdInList(next[fields.extraField], normalizedId, true);
      return normalizeLocalExclusionSettings(next);
    }

    if (globallyExcluded) {
      next[fields.extraField] = toggleIdInList(next[fields.extraField], normalizedId, false);
      next[fields.allowedField] = toggleIdInList(
        next[fields.allowedField],
        normalizedId,
        !inAllowed,
      );
    } else {
      next[fields.allowedField] = toggleIdInList(next[fields.allowedField], normalizedId, false);
      next[fields.extraField] = toggleIdInList(
        next[fields.extraField],
        normalizedId,
        !inExtra,
      );
    }

    return normalizeLocalExclusionSettings(next);
  };

  const normalizeSetLocalExclusionsStore = (value) => {
    const raw = value && typeof value === "object" && !Array.isArray(value)
      ? value
      : {};
    const normalized = {};
    for (const [key, entry] of Object.entries(raw)) {
      const setId = normalizeSetId(key);
      if (!setId) continue;
      const settings = normalizeLocalExclusionSettings(entry);
      if (!hasLocalExclusionSettings(settings)) continue;
      normalized[setId] = settings;
    }
    return normalized;
  };

  const getSetLocalExclusionSettings = (store, setId) => {
    const normalizedSetId = normalizeSetId(setId);
    if (!normalizedSetId) return getDefaultLocalExclusionSettings();
    const normalizedStore = normalizeSetLocalExclusionsStore(store);
    return normalizeLocalExclusionSettings(normalizedStore[normalizedSetId]);
  };

  const setSetLocalExclusionSettings = (store, setId, settings) => {
    const normalizedSetId = normalizeSetId(setId);
    const normalizedStore = normalizeSetLocalExclusionsStore(store);
    if (!normalizedSetId) return normalizedStore;
    const normalizedSettings = normalizeLocalExclusionSettings(settings);
    if (hasLocalExclusionSettings(normalizedSettings)) {
      normalizedStore[normalizedSetId] = normalizedSettings;
    } else {
      delete normalizedStore[normalizedSetId];
    }
    return normalizedStore;
  };

  return {
    LOCAL_EXCLUSION_FIELDS,
    computeEffectiveExcludedIds,
    getDefaultLocalExclusionSettings,
    getLocalExclusionStateForKind,
    getSetLocalExclusionSettings,
    hasLocalExclusionSettings,
    applyLocalExclusionsToSettings,
    mergeLocalExclusionsIntoSettings,
    normalizeLocalExclusionSettings,
    normalizeSetLocalExclusionsStore,
    resolveLocalExclusionSettings,
    setSetLocalExclusionSettings,
    toggleLocalExclusionId,
  };
});
