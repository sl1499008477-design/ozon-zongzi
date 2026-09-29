const emptySummary = () => ({
  products: 0,
  warehouses: 0,
  collectBox: 0,
  favorites: 0,
  productTemplates: 0,
  lastSyncAt: null,
});

const emptyCaches = () => ({
  products: [],
  warehouses: [],
  collectBox: [],
  favorites: [],
  productTemplates: [],
});

export function emptyLocalRuntimeData() {
  return {
    currentStoreId: "",
    stores: [],
    summary: emptySummary(),
    caches: emptyCaches(),
    jobs: {},
  };
}

export function localRuntimeStateFromApi(state = {}) {
  const empty = emptyLocalRuntimeData();
  return {
    currentStoreId: String(state?.currentStoreId || ""),
    stores: Array.isArray(state?.stores) ? state.stores : empty.stores,
    summary: state?.summary && typeof state.summary === "object" ? state.summary : empty.summary,
    caches: state?.caches && typeof state.caches === "object" ? state.caches : empty.caches,
    jobs: state?.jobs && typeof state.jobs === "object" ? state.jobs : empty.jobs,
  };
}

export function localStatePathForPage(pathname = '/', search = '') {
  const path=pathname.replace(/\/+$/, '')||'/';
  if(['/', '/login', '/ozon/dashboard', '/ozon/products/list'].includes(path))return '/local/state?view=bootstrap';
  if(['/ozon/products/import-history','/ozon/products/collect','/ozon/templates'].includes(path))return '/local/state?view=bootstrap';
  if(path==='/ozon/products/collect/edit'||path==='/ozon/tools/ai-listing') {
    const params=new URLSearchParams(search),query=new URLSearchParams({view:'bootstrap'});
    const ids=path.endsWith('/edit')?[params.get('id')]:String(params.get('ids')||'').split(',');
    for(const id of [...new Set(ids.filter(Boolean))])query.append('collectIds',id);
    return `/local/state?${query}`;
  }
  const full=path==='/' || path==='/login' || path==='/ozon/dashboard' || path==='/ozon/products' || path.startsWith('/ozon/products/') || path==='/ozon/tools/stores'
    || (path==='/ozon/tools/ai-listing' && Boolean(new URLSearchParams(search).get('ids')));
  return full?'/local/state':'/local/state?view=bootstrap';
}

export function pageStateNeedsLoading(requiredStateView, loadedStateView) {
  return requiredStateView!=='/local/state?view=bootstrap' && loadedStateView!==requiredStateView;
}
