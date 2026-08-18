(function (root) {
  'use strict';
  const stableScope = (scope) => {
    const backendOrigin = String(scope?.backendOrigin || '').trim();
    const accountId = String(scope?.accountId || '').trim();
    const storeId = String(scope?.storeId || '').trim();
    if (!/^https?:\/\//.test(backendOrigin) || !accountId || !storeId) return null;
    return { backendOrigin, accountId, storeId };
  };
  const createPricingConfigCache = ({ ttlMs = 5 * 60_000, now = () => Date.now(), read, write }) => {
    const keyFor = (scope) => {
      const safe = stableScope(scope);
      return safe ? `sonli_pricing_config_cache_v2:${encodeURIComponent(safe.backendOrigin)}:${encodeURIComponent(safe.accountId)}:${encodeURIComponent(safe.storeId)}` : null;
    };
    const get = async (scope) => {
      const safe = stableScope(scope);
      const key = keyFor(safe);
      if (!key) return null;
      const record = await read(key);
      if (!record || record.backendOrigin !== safe.backendOrigin || record.accountId !== safe.accountId || record.storeId !== safe.storeId || now() - Number(record.cachedAt || 0) > ttlMs) return null;
      return record.config || null;
    };
    const put = async (scope, config) => {
      const safe = stableScope(scope);
      const key = keyFor(safe);
      if (!key || !config) throw new Error('PRICING_CONFIG_SCOPE_REQUIRED');
      await write(key, { ...safe, config, cachedAt: now() });
      return config;
    };
    const load = async (scope, fetcher) => {
      const safe = stableScope(scope);
      if (!safe) throw new Error('PRICING_CONFIG_UNAVAILABLE');
      try {
        const config = await fetcher();
        if (!config) throw new Error('empty config');
        return await put(safe, config);
      } catch {
        const cached = await get(safe);
        if (cached) return cached;
        throw new Error('PRICING_CONFIG_UNAVAILABLE');
      }
    };
    return Object.freeze({ keyFor, get, put, load });
  };
  const api = Object.freeze({ createPricingConfigCache });
  root.JzPricingConfigCache = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : self);
