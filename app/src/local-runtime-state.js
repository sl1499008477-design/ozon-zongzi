const emptySummary = () => ({
  products: 0,
  postings: 0,
  postingsTotal: 0,
  currencyCode: "",
  currencyCodes: [],
  mixedCurrencies: false,
  gmvByCurrency: {},
  totalGmv: null,
  todayPostings: 0,
  todayGmv: null,
  weekPostings: 0,
  weekGmv: null,
  awaitingPackaging: 0,
  awaitingDeliver: 0,
  pendingPostings: 0,
  statusCounts: {},
  warehouses: 0,
  collectBox: 0,
  favorites: 0,
  promotions: 0,
  returns: 0,
  refunds: 0,
  messageTemplates: 0,
  messageHistory: 0,
  productTemplates: 0,
  lastSyncAt: null,
});

const emptyCaches = () => ({
  products: [],
  postings: [],
  warehouses: [],
  collectBox: [],
  favorites: [],
  promotions: [],
  returns: [],
  refunds: [],
  messageTemplates: [],
  messageHistory: [],
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
