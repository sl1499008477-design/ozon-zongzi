(function (root) {
  'use strict';
  const DEFAULT_ORIGIN = 'https://seller.ozon.ru';
  const ORIGINS = Object.freeze([DEFAULT_ORIGIN, 'https://seller.ozonru.cn']);
  const STORAGE_KEY = 'sonliSellerOrigin';
  const createSellerRoute = ({ storage = root.chrome?.storage?.local, isBusy = () => false, onChange = async () => {} } = {}) => {
    let origin = DEFAULT_ORIGIN, operations = 0, switching = false, initialized = false;
    const ready = Promise.resolve(storage.get(STORAGE_KEY)).then(stored => {
      if (ORIGINS.includes(stored?.[STORAGE_KEY])) origin = stored[STORAGE_KEY];
      initialized = true;
    });
    const getOrigin = () => origin;
    const run = async operation => {
      if (!initialized) await ready;
      if (switching) throw new Error('SELLER_ROUTE_BUSY');
      operations++;
      try { return await operation(); } finally { operations--; }
    };
    const setOrigin = async (next, activity = {}) => {
      await ready;
      if (!ORIGINS.includes(next)) throw new Error('SELLER_ROUTE_INVALID');
      if (switching || operations) throw new Error('SELLER_ROUTE_BUSY');
      if (origin === next) return origin;
      switching = true;
      try {
        if (await isBusy(activity)) throw new Error('SELLER_ROUTE_BUSY');
        await onChange();
        await storage.set({ [STORAGE_KEY]: next });
        origin = next;
        return origin;
      } finally { switching = false; }
    };
    return Object.freeze({ ready, getOrigin, run, setOrigin });
  };
  // Only the Web account setting can change this preference. This cache stores
  // the last applied route, so an interrupted collector resumes on that route.
  const createAccountSellerRoute = ({ storage = root.chrome?.storage?.local,
    sessionManager, getBackendUrl, isBusy = () => false, onChange = async () => {} } = {}) => {
    const CACHE_KEY = 'sonliSellerRouteByAccount';
    let cache = {}, scope = '', applied = null, status = {}, syncing = null, ready;
    const current = async () => {
      const operation = await sessionManager.beginCollectorOperation();
      if (!operation?.accountId) throw new Error('COLLECTOR_AUTH_REQUIRED');
      const server = String(await getBackendUrl()).replace(/\/+$/, '');
      return { operation, key: JSON.stringify([server, operation.accountId]) };
    };
    const normalize = value => {
      const origin = value?.route === 'CN' ? 'https://seller.ozonru.cn'
        : value?.route === 'RU' ? DEFAULT_ORIGIN : null;
      if (!origin || value.sellerOrigin !== origin || !Number.isSafeInteger(value.revision) || value.revision < 0)
        throw new Error('SELLER_ROUTE_UNAVAILABLE');
      return {route:value.route, revision:value.revision, updatedAt:value.updatedAt ?? null, sellerOrigin:origin};
    };
    const route = createSellerRoute({ storage: {
      get: async () => {
        cache = (await storage.get(CACHE_KEY))[CACHE_KEY] || {};
        try {
          const owner = await current();
          const jobs = (await storage.get('jzOzonWebCollectionByAccount')).jzOzonWebCollectionByAccount;
          const job = jobs?.[owner.operation.accountId];
          if (job?.sellerRoute?.scopeKey === owner.key) cache[owner.key] = normalize(job.sellerRoute);
          if (!cache[owner.key]) {
            if (['capturing','result','failure','waiting','reclaim'].includes(job?.phase) && !job.sellerRoute) {
              const origin = (await storage.get(STORAGE_KEY))[STORAGE_KEY] || DEFAULT_ORIGIN;
              if (ORIGINS.includes(origin)) {
                cache[owner.key] = {route:origin === DEFAULT_ORIGIN ? 'RU' : 'CN',revision:0,updatedAt:null,sellerOrigin:origin};
                await storage.set({[CACHE_KEY]:cache});
              }
            }
          }
          if (cache[owner.key]) { applied = normalize(cache[owner.key]); scope = owner.key; status = {...applied,stale:true}; }
        } catch { /* No authenticated account: no previous account is reused. */ }
        return {[STORAGE_KEY]:applied?.sellerOrigin || DEFAULT_ORIGIN};
      },
      set: async () => {},
    }, isBusy, onChange });
    ready = route.ready;
    const assertOwner = async owner => {
      const latest = await current();
      if (latest.key !== owner.key || latest.operation.sessionIdentity !== owner.operation.sessionIdentity)
        throw new Error('COLLECTOR_SESSION_CHANGED');
    };
    const sync = (activity = {}) => {
      if (syncing) return syncing;
      const work = Promise.resolve().then(async () => {
        await ready;
        const owner = await current();
        let preference, stale = false;
        try {
          const response = await sessionManager.collectorFetch('/collector/ozon-route', {
            collectorOperation:owner.operation, permission:'collector.config.read', method:'GET',
            signal:root.AbortSignal?.timeout?.(15000),
          });
          if (!response.ok) throw Object.assign(new Error('SELLER_ROUTE_UNAVAILABLE'), {status:response.status});
          preference = normalize(JSON.parse(await response.text()));
        } catch (error) {
          if (error.status === 401 || error.status === 403 || error.code === 'COLLECTOR_SESSION_CHANGED') throw error;
          if (!cache[owner.key]) { status = {error:'SELLER_ROUTE_UNAVAILABLE'}; throw new Error('SELLER_ROUTE_UNAVAILABLE'); }
          preference = normalize(cache[owner.key]); stale = true;
        }
        await assertOwner(owner);
        const changingAccount = scope !== owner.key;
        // Do not switch either origin or owner under active work. The caller for
        // another account must wait; the same account may finish its frozen work.
        if (changingAccount && await isBusy(activity)) throw new Error('SELLER_ROUTE_BUSY');
        try {
          if (changingAccount || preference.sellerOrigin !== route.getOrigin()) await route.setOrigin(preference.sellerOrigin,activity);
        } catch (error) {
          if (error.message !== 'SELLER_ROUTE_BUSY' || changingAccount || !applied) throw error;
          status = {...applied,stale,pendingRoute:preference.route};
          return {...status};
        }
        if (changingAccount && applied?.sellerOrigin === preference.sellerOrigin) await onChange();
        await assertOwner(owner);
        scope = owner.key; applied = preference; status = {...preference,stale};
        cache[scope] = preference;
        await storage.set({[CACHE_KEY]:cache});
        return {...status};
      });
      syncing = work;
      work.then(() => { syncing = null; }, () => { syncing = null; });
      return work;
    };
    const run = async operation => {
      await ready;
      const owner = await current();
      if (owner.key !== scope || !applied || status.error) throw new Error('SELLER_ROUTE_UNAVAILABLE');
      return route.run(async () => {
        const result = await operation();
        await assertOwner(owner);
        return result;
      });
    };
    const snapshot = () => ({...applied,scopeKey:scope});
    const prepareNewWork = async (activity = {}) => {
      const next = await sync(activity);
      if (next.pendingRoute) throw new Error('SELLER_ROUTE_BUSY: Ozon 线路将在当前任务完成后切换，请稍后开始新任务');
      return snapshot();
    };
    const resumeWork = async saved => {
      await ready;
      const owner = await current();
      if (!saved) {
        if (owner.key !== scope || !applied) throw new Error('SELLER_ROUTE_UNAVAILABLE');
        return snapshot();
      }
      if (saved.scopeKey !== owner.key) throw new Error('COLLECTOR_SESSION_CHANGED');
      const frozen = normalize(saved);
      if (owner.key === scope && frozen.sellerOrigin === route.getOrigin()) return snapshot();
      const previousOrigin = route.getOrigin();
      // The resumed job itself may own the Web busy flag. Other active Seller
      // operations still prevent switching accounts or routes under them.
      await route.setOrigin(frozen.sellerOrigin,{resume:true});
      if (owner.key !== scope && previousOrigin === frozen.sellerOrigin) await onChange();
      await assertOwner(owner);
      scope = owner.key;applied = frozen;status = {...frozen,stale:true};cache[scope] = frozen;
      await storage.set({[CACHE_KEY]:cache});
      return snapshot();
    };
    return Object.freeze({ready,sync,prepareNewWork,resumeWork,run,getOrigin:route.getOrigin,getStatus:()=>({...status})});
  };
  const api = Object.freeze({ DEFAULT_ORIGIN, ORIGINS, STORAGE_KEY, createSellerRoute, createAccountSellerRoute });
  root.JzSellerRoute = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : self);
