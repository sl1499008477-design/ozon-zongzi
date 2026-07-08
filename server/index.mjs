import { spawn } from "node:child_process";
import http from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { normalizeOzonImportItems } from "./ozon-import-normalizer.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const dataDir = process.env.QH_LOCAL_DATA_DIR || path.join(rootDir, "server-data");
const dataFile = path.join(dataDir, "local-state.json");
const port = Number(process.env.QH_LOCAL_API_PORT || process.env.PORT || 3001);
const OZON_API_BASE = "https://api-seller.ozon.ru";
const DESCRIPTION_CATEGORY_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const descriptionCategoryTreeCache = new Map();
const descriptionCategoryAttributesCache = new Map();
const DEFAULT_ADMIN_USERNAME = process.env.SONLI_ADMIN_USERNAME || "admin";
const DEFAULT_ADMIN_PASSWORD = process.env.SONLI_ADMIN_PASSWORD || "admin123456";

const defaultState = () => ({
  token: "",
  currentAccountId: "",
  sessionIssuedAt: "",
  accounts: [],
  currentStoreId: "",
  stores: [],
  caches: {
    products: [],
    postings: [],
    warehouses: [],
    collectBox: [],
    favorites: [],
    promotions: [],
    returns: [],
    refunds: [],
    announcements: [],
    messageTemplates: [],
    messageHistory: [],
    productTemplates: [],
    watermarkTemplates: [],
  },
  hashes: {},
  leases: {},
  browserAgents: {},
  jobs: {},
  reports: [],
  updatedAt: new Date().toISOString(),
});

function createPasswordHash(password, salt = crypto.randomBytes(16).toString("hex")) {
  return {
    passwordSalt: salt,
    passwordHash: crypto.scryptSync(String(password || ""), salt, 32).toString("hex"),
    passwordAlgorithm: "scrypt",
  };
}

function verifyPassword(password, account = {}) {
  if (!account.passwordHash || !account.passwordSalt) return false;
  const hash = crypto.scryptSync(String(password || ""), account.passwordSalt, 32);
  const expected = Buffer.from(account.passwordHash, "hex");
  return expected.length === hash.length && crypto.timingSafeEqual(expected, hash);
}

function createAccountRecord({ username, password, displayName, role = "user", expiresAt = "", status = "active" }) {
  const now = new Date().toISOString();
  return {
    id: `acct_${crypto.randomUUID()}`,
    username: String(username || "").trim(),
    displayName: String(displayName || username || "").trim(),
    role: role === "admin" ? "admin" : "user",
    status: status === "disabled" ? "disabled" : "active",
    expiresAt: normalizeAccountExpiresAt(expiresAt),
    ...createPasswordHash(password),
    createdAt: now,
    updatedAt: now,
    lastLoginAt: "",
  };
}

function normalizeAccountExpiresAt(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) {
    const err = new Error("登录期限不是有效时间");
    err.status = 400;
    throw err;
  }
  return date.toISOString();
}

function isAccountExpired(account = {}, now = Date.now()) {
  if (!account.expiresAt) return false;
  const expiresAt = new Date(account.expiresAt).getTime();
  return Number.isFinite(expiresAt) && expiresAt <= now;
}

function publicAccount(account = {}) {
  if (!account?.id) return null;
  return {
    id: account.id,
    username: account.username,
    displayName: account.displayName || account.username,
    role: account.role === "admin" ? "admin" : "user",
    status: account.status === "disabled" ? "disabled" : "active",
    expiresAt: account.expiresAt || "",
    expired: isAccountExpired(account),
    createdAt: account.createdAt || "",
    updatedAt: account.updatedAt || "",
    lastLoginAt: account.lastLoginAt || "",
  };
}

function ensureAccountState(state) {
  state.accounts = Array.isArray(state.accounts) ? state.accounts : [];
  const hasAdmin = state.accounts.some((account) => account.role === "admin");
  if (!hasAdmin) {
    state.accounts.unshift(createAccountRecord({
      username: DEFAULT_ADMIN_USERNAME,
      password: DEFAULT_ADMIN_PASSWORD,
      displayName: "管理员",
      role: "admin",
    }));
  }
  if (!state.accounts.some((account) => account.id === state.currentAccountId)) {
    state.currentAccountId = "";
    state.sessionIssuedAt = "";
    state.token = "";
  }
  return state;
}

async function loadState() {
  try {
    const raw = await fs.readFile(dataFile, "utf8");
    const parsed = JSON.parse(raw);
    const base = defaultState();
    return ensureAccountState({
      ...base,
      ...parsed,
      caches: { ...base.caches, ...(parsed.caches || {}) },
      hashes: { ...base.hashes, ...(parsed.hashes || {}) },
      leases: { ...base.leases, ...(parsed.leases || {}) },
      browserAgents: { ...base.browserAgents, ...(parsed.browserAgents || {}) },
      jobs: { ...base.jobs, ...(parsed.jobs || {}) },
      reports: Array.isArray(parsed.reports) ? parsed.reports : base.reports,
      accounts: Array.isArray(parsed.accounts) ? parsed.accounts : base.accounts,
    });
  } catch {
    return ensureAccountState(defaultState());
  }
}

async function saveState(state) {
  state.updatedAt = new Date().toISOString();
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(dataFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function sendJson(res, status, data, extraHeaders = {}) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, x-ozon-store-id, x-device-fingerprint",
    "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    ...extraHeaders,
  });
  res.end(JSON.stringify(data));
}

function sendError(res, status, message, code = "LOCAL_ERROR") {
  sendJson(res, status, { ok: false, message, code });
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const err = new Error("请求体不是有效 JSON");
    err.status = 400;
    throw err;
  }
}

function publicStore(store, state = null) {
  if (!store) return null;
  const currency = storeContractCurrencyCode(state, store);
  return {
    id: store.id,
    storeId: store.id,
    label: store.label,
    companyName: store.companyName || store.label,
    legalName: store.legalName || store.label,
    inn: store.inn || store.taxId || "",
    taxId: store.taxId || store.inn || "",
    isPremium: store.isPremium === true,
    status: store.status || "",
    clientId: store.clientId,
    apiKeyMasked: store.apiKey ? "已保存" : "",
    currency,
    currencyCode: currency,
    companyCurrency: currency,
    watermarkTemplateId: store.watermarkTemplateId || "",
    savedAt: store.savedAt,
    updatedAt: store.updatedAt || store.savedAt,
    profileSyncedAt: store.profileSyncedAt || "",
  };
}

function localAuthPayload(state) {
  const store = activeStore(state);
  const account = activeAccount(state);
  if (!state.token || !account) {
    const err = new Error("请先登录 sonli");
    err.status = 401;
    throw err;
  }
  if (!store) {
    const err = new Error("请先在网页端绑定 Ozon 门店");
    err.status = 400;
    throw err;
  }
  return {
    accessToken: state.token,
    access_token: state.token,
    token: state.token,
    currentOzonStoreId: store.id,
    storeId: store.id,
    user: {
      id: account.id,
      name: account.displayName || account.username,
      phoneNumber: "",
      platform: "local",
    },
    stores: state.stores.map((item) => publicStore(item, state)),
  };
}

function activeStore(state, storeId = state.currentStoreId) {
  return state.stores.find((store) => String(store.id) === String(storeId)) || null;
}

function activeAccount(state, accountId = state.currentAccountId) {
  return (state.accounts || []).find((account) => String(account.id) === String(accountId)) || null;
}

function findAccountByUsername(state, username) {
  const key = String(username || "").trim().toLowerCase();
  if (!key) return null;
  return (state.accounts || []).find((account) => String(account.username || "").toLowerCase() === key) || null;
}

function createStoreId(clientId) {
  return `local_${crypto.createHash("sha256").update(String(clientId)).digest("hex").slice(0, 12)}`;
}

function createToken() {
  return `local-${crypto.randomUUID()}`;
}

function bearerToken(req) {
  const value = req.headers.authorization || "";
  return value.toLowerCase().startsWith("bearer ") ? value.slice(7).trim() : "";
}

function requireAuth(req, state) {
  const token = bearerToken(req);
  if (!state.token || token !== state.token) {
    const err = new Error("未登录，请先登录 sonli");
    err.status = 401;
    throw err;
  }
  const account = activeAccount(state);
  if (!account) {
    const err = new Error("登录状态已失效，请重新登录");
    err.status = 401;
    throw err;
  }
  if (account.status === "disabled") {
    const err = new Error("账号已被停用，请联系管理员");
    err.status = 403;
    throw err;
  }
  if (isAccountExpired(account)) {
    state.token = "";
    state.currentAccountId = "";
    state.sessionIssuedAt = "";
    const err = new Error("账号登录期限已过期，请联系管理员");
    err.status = 403;
    throw err;
  }
  return account;
}

function optionalAuth(req, state) {
  if (!bearerToken(req)) return null;
  try {
    return requireAuth(req, state);
  } catch {
    return null;
  }
}

function requireAdmin(req, state) {
  const account = requireAuth(req, state);
  if (account.role !== "admin") {
    const err = new Error("仅管理员可操作账号");
    err.status = 403;
    throw err;
  }
  return account;
}

const dayKeyFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: process.env.TZ || "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function dateKey(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return dayKeyFormatter.format(date);
}

function postingDateKey(posting = {}) {
  return dateKey(
    posting.in_process_at ||
      posting.created_at ||
      posting.shipment_date ||
      posting.delivering_date ||
      posting.syncedAt
  );
}

function postingAmount(posting = {}) {
  const products = Array.isArray(posting.financial_data?.products)
    ? posting.financial_data.products
    : [];
  const productTotal = products.reduce((sum, item) => sum + (Number(item.price) || 0), 0);
  return productTotal || Number(posting.order_price || posting.total_price || posting.price || 0) || 0;
}

function roundMoney(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function summarize(state) {
  const postings = state.caches.postings || [];
  const syncTypes = new Set(["PRODUCTS", "POSTINGS", "WAREHOUSES", "PROMOTIONS"]);
  const today = dateKey();
  const dayMs = 24 * 60 * 60 * 1000;
  const weekKeys = new Set(
    Array.from({ length: 7 }, (_, index) => dateKey(Date.now() - index * dayMs))
  );
  const postingStats = postings.reduce(
    (stats, posting) => {
      const status = String(posting.status || "").toLowerCase();
      const amount = postingAmount(posting);
      const day = postingDateKey(posting);
      if (status) stats.statusCounts[status] = (stats.statusCounts[status] || 0) + 1;
      stats.totalGmv += amount;
      if (day === today) {
        stats.todayPostings += 1;
        stats.todayGmv += amount;
      }
      if (weekKeys.has(day)) {
        stats.weekPostings += 1;
        stats.weekGmv += amount;
      }
      if (status === "awaiting_packaging") stats.awaitingPackaging += 1;
      if (status === "awaiting_deliver") stats.awaitingDeliver += 1;
      if (status.startsWith("awaiting")) stats.pendingPostings += 1;
      return stats;
    },
    {
      totalGmv: 0,
      todayPostings: 0,
      todayGmv: 0,
      weekPostings: 0,
      weekGmv: 0,
      awaitingPackaging: 0,
      awaitingDeliver: 0,
      pendingPostings: 0,
      statusCounts: {},
    }
  );
  return {
    products: state.caches.products?.length || 0,
    postings: postings.length,
    postingsTotal: postings.length,
    totalGmv: roundMoney(postingStats.totalGmv),
    todayPostings: postingStats.todayPostings,
    todayGmv: roundMoney(postingStats.todayGmv),
    weekPostings: postingStats.weekPostings,
    weekGmv: roundMoney(postingStats.weekGmv),
    awaitingPackaging: postingStats.awaitingPackaging,
    awaitingDeliver: postingStats.awaitingDeliver,
    pendingPostings: postingStats.pendingPostings,
    statusCounts: postingStats.statusCounts,
    warehouses: state.caches.warehouses?.length || 0,
    collectBox: state.caches.collectBox?.length || 0,
    favorites: state.caches.favorites?.length || 0,
    promotions: state.caches.promotions?.length || 0,
    returns: state.caches.returns?.length || 0,
    refunds: state.caches.refunds?.length || 0,
    announcements: state.caches.announcements?.length || 0,
    messageTemplates: state.caches.messageTemplates?.length || 0,
    messageHistory: state.caches.messageHistory?.length || 0,
    productTemplates: state.caches.productTemplates?.length || 0,
    watermarkTemplates: state.caches.watermarkTemplates?.length || 0,
    lastSyncAt: state.reports.findLast?.((r) => r.status === "SUCCESS" && syncTypes.has(r.type))?.createdAt || null,
  };
}

function limitedLocalStatePayload(state) {
  const empty = defaultState();
  return {
    ok: true,
    requiresLogin: true,
    token: "",
    account: null,
    accounts: [],
    currentStoreId: "",
    binding: null,
    stores: [],
    summary: summarize(empty),
    caches: empty.caches,
    jobs: {},
    updatedAt: state.updatedAt,
  };
}

function localStatePayload(state, options = {}) {
  const authenticated = options.authenticated ?? true;
  const account = authenticated ? (options.account || activeAccount(state)) : null;
  if (!authenticated || !account) return limitedLocalStatePayload(state);
  const includeAccounts = options.includeAccounts ?? account.role === "admin";
  return {
    ok: true,
    token: state.token || "",
    account: publicAccount(account),
    accounts: includeAccounts ? (state.accounts || []).map(publicAccount) : [],
    currentStoreId: state.currentStoreId || "",
    binding: publicStore(activeStore(state), state),
    stores: state.stores.map((store) => publicStore(store, state)),
    summary: summarize(state),
    caches: {
      products: state.caches.products || [],
      postings: state.caches.postings || [],
      warehouses: state.caches.warehouses || [],
      collectBox: state.caches.collectBox || [],
      favorites: state.caches.favorites || [],
      promotions: state.caches.promotions || [],
      returns: state.caches.returns || [],
      refunds: state.caches.refunds || [],
      announcements: state.caches.announcements || [],
      messageTemplates: state.caches.messageTemplates || [],
      messageHistory: state.caches.messageHistory || [],
      productTemplates: state.caches.productTemplates || [],
      watermarkTemplates: state.caches.watermarkTemplates || [],
    },
    jobs: state.jobs || {},
    updatedAt: state.updatedAt,
  };
}

function upsertById(list, id, value) {
  const key = String(id || "");
  if (!key) return false;
  const idx = list.findIndex((item) => String(item.id || item.product_id || item.posting_number || item.warehouse_id) === key);
  if (idx >= 0) list[idx] = value;
  else list.push(value);
  return idx < 0;
}

function collectItemKey(item) {
  return String(item?.id || item?.sourceExternalId || item?.sku || item?.productUrl || "");
}

async function saveCollectBoxItemAtomic(item) {
  const latest = await loadState();
  const key = collectItemKey(item);
  latest.caches.collectBox = (latest.caches.collectBox || []).filter((row) => collectItemKey(row) !== key);
  latest.caches.collectBox.unshift(item);
  await saveState(latest);
  return { item, state: latest };
}

async function updateCollectBoxItemAtomic(id, patch) {
  const latest = await loadState();
  const index = (latest.caches.collectBox || []).findIndex((item) => String(item.id) === String(id));
  if (index < 0) return null;
  latest.caches.collectBox[index] = {
    ...latest.caches.collectBox[index],
    ...patch,
    id,
    updatedAt: new Date().toISOString(),
  };
  await saveState(latest);
  return latest.caches.collectBox[index];
}

async function saveCollectBoxBatchAtomic(items) {
  const latest = await loadState();
  latest.caches.collectBox = latest.caches.collectBox || [];
  for (const item of items) {
    const key = collectItemKey(item);
    latest.caches.collectBox = latest.caches.collectBox.filter((row) => collectItemKey(row) !== key);
    latest.caches.collectBox.unshift(item);
  }
  await saveState(latest);
  return latest;
}

function pageParams(url, defaults = {}) {
  const current = Math.max(1, Number(url.searchParams.get("current") || url.searchParams.get("currentPage") || defaults.current || 1) || 1);
  const pageSize = Math.max(1, Math.min(200, Number(url.searchParams.get("pageSize") || defaults.pageSize || 20) || 20));
  return { current, pageSize };
}

function emptyPage(url, data = []) {
  const { current, pageSize } = pageParams(url);
  return { data, items: data, total: data.length, current, pageSize };
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value || {}, key);
}

function cleanText(value, maxLength = 500) {
  return String(value ?? "").trim().slice(0, maxLength);
}

function normalizeCurrencyCode(value) {
  const code = String(value || "").trim().toUpperCase();
  return /^[A-Z]{3}$/.test(code) ? code : "";
}

function productCurrencyCandidates(product = {}) {
  return [
    product.currency_code,
    product.currencyCode,
    product.companyCurrency,
    product.currency,
    product.priceCurrency,
    product.price?.currency_code,
    product.price?.currencyCode,
    product.price?.currency,
    product.price?.price_currency,
    product.marketing_price_currency,
  ].map(normalizeCurrencyCode).filter(Boolean);
}

function inferCurrencyFromProductCache(state, store = null) {
  const products = Array.isArray(state?.caches?.products) ? state.caches.products : [];
  const storeId = String(store?.id || "");
  const scoped = products.filter((product) => !product.storeId || !storeId || String(product.storeId) === storeId);
  const counts = new Map();
  for (const product of scoped.length ? scoped : products) {
    const [code] = productCurrencyCandidates(product);
    if (code) counts.set(code, (counts.get(code) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || "";
}

function storeContractCurrencyCode(state, store = null) {
  return normalizeCurrencyCode(
    store?.companyCurrency ||
    store?.currency ||
    store?.currencyCode ||
    store?.contractCurrency ||
    store?.defaultCurrency
  ) || inferCurrencyFromProductCache(state, store) || "RUB";
}

function withStoreContractCurrency(state, store, items = []) {
  const currencyCode = storeContractCurrencyCode(state, store);
  return (Array.isArray(items) ? items : []).map((item) => ({
    ...item,
    currency_code: currencyCode,
    currencyCode,
  }));
}

function normalizeMessageTemplate(body, existing = {}) {
  const now = new Date().toISOString();
  const templateName = cleanText(
    hasOwn(body, "templateName") ? body.templateName : hasOwn(body, "name") ? body.name : existing.templateName || existing.name,
    80
  );
  if (!templateName) {
    const err = new Error("模板名称必填");
    err.status = 400;
    throw err;
  }
  const categoryValue = cleanText(hasOwn(body, "category") ? body.category : existing.category || "custom", 32);
  const allowedCategories = new Set(["review", "pickup", "custom"]);
  const content = cleanText(hasOwn(body, "content") ? body.content : existing.content || "", 2000);
  return {
    ...existing,
    id: existing.id || crypto.randomUUID(),
    templateName,
    name: templateName,
    category: allowedCategories.has(categoryValue) ? categoryValue : "custom",
    content,
    createdAt: existing.createdAt || now,
    updatedAt: now,
  };
}

function normalizeMessageHistoryItem(body, store = null) {
  const now = new Date().toISOString();
  const kindValue = cleanText(body.kind || body.type || "custom", 32);
  const allowedKinds = new Set(["review", "pickup", "custom"]);
  const statusValue = cleanText(body.status || "local_record", 32);
  const allowedStatuses = new Set(["local_record", "success", "failed", "pending"]);
  const sentAt = cleanText(body.sentAt || body.createdAt || now, 40);
  return {
    id: body.id || crypto.randomUUID(),
    kind: allowedKinds.has(kindValue) ? kindValue : "custom",
    receiver: cleanText(body.receiver || body.postingNumber || body.posting_number || "—", 120),
    postingNumber: cleanText(body.postingNumber || body.posting_number || body.receiver || "", 120),
    templateName: cleanText(body.templateName || body.template || "默认模板", 120),
    content: cleanText(body.content || "", 1000),
    status: allowedStatuses.has(statusValue) ? statusValue : "local_record",
    storeId: cleanText(body.storeId || store?.id || "", 80),
    storeName: cleanText(body.storeName || store?.label || store?.companyName || "当前店铺", 120),
    sentAt,
    createdAt: now,
    local: true,
    dryRun: true,
  };
}

function normalizeAnnouncement(body, existing = {}) {
  const now = new Date().toISOString();
  const title = cleanText(hasOwn(body, "title") ? body.title : existing.title, 160);
  if (!title) {
    const err = new Error("公告标题必填");
    err.status = 400;
    throw err;
  }
  const rawSections = Array.isArray(body.sections) ? body.sections : (Array.isArray(existing.sections) ? existing.sections : []);
  const sections = rawSections.slice(0, 12).map((section) => {
    if (Array.isArray(section)) {
      return [
        cleanText(section[0], 80),
        (Array.isArray(section[1]) ? section[1] : []).slice(0, 20).map((text) => cleanText(text, 500)).filter(Boolean),
      ];
    }
    return [
      cleanText(section?.title, 80),
      (Array.isArray(section?.bullets) ? section.bullets : []).slice(0, 20).map((text) => cleanText(text, 500)).filter(Boolean),
    ];
  }).filter(([sectionTitle, bullets]) => sectionTitle || bullets.length);
  return {
    ...existing,
    id: cleanText(body.id || body.announcementId || existing.id || crypto.randomUUID(), 120),
    title,
    level: cleanText(hasOwn(body, "level") ? body.level : existing.level || "通知", 40),
    type: cleanText(hasOwn(body, "type") ? body.type : existing.type || "公告", 60),
    time: cleanText(body.time || body.publishedAt || body.createdAt || existing.time || now, 80),
    summary: cleanText(hasOwn(body, "summary") ? body.summary : existing.summary || "", 800),
    sections,
    read: Boolean(hasOwn(body, "read") ? body.read : existing.read),
    createdAt: existing.createdAt || now,
    updatedAt: now,
    local: true,
  };
}

function normalizeReturnItem(body, kind = "return", store = null) {
  const now = new Date().toISOString();
  const id = cleanText(
    body.id ||
      body.returnId ||
      body.return_id ||
      body.refundId ||
      body.refund_id ||
      body.postingNumber ||
      body.posting_number ||
      crypto.randomUUID(),
    160
  );
  const typeValue = cleanText(body.type || body.kind || kind, 32);
  const statusValue = cleanText(body.status || body.state || "unknown", 60);
  const createdAt = cleanText(
    body.createdAt ||
      body.created_at ||
      body.requestedAt ||
      body.requested_at ||
      body.return_date ||
      now,
    60
  );
  const products = Array.isArray(body.products) ? body.products : [];
  const firstProduct = products[0] || {};
  return {
    ...body,
    id,
    type: typeValue,
    status: statusValue || "unknown",
    postingNumber: cleanText(body.postingNumber || body.posting_number || body.posting || "", 160),
    sku: cleanText(body.sku || body.offer_id || firstProduct.sku || firstProduct.offer_id || "", 160),
    productName: cleanText(body.productName || body.product_name || firstProduct.name || firstProduct.title || "", 300),
    storeId: cleanText(body.storeId || store?.id || "", 80),
    storeName: cleanText(body.storeName || store?.label || store?.companyName || "当前店铺", 120),
    requestedAt: createdAt,
    createdAt,
    updatedAt: now,
    local: true,
  };
}

function normalizeProductTemplate(body, existing = {}, store = null) {
  const now = new Date().toISOString();
  const templateName = cleanText(
    hasOwn(body, "templateName") ? body.templateName : hasOwn(body, "name") ? body.name : existing.templateName || existing.name,
    80
  );
  if (!templateName) {
    const err = new Error("模板名称必填");
    err.status = 400;
    throw err;
  }
  const isDefault = hasOwn(body, "isDefault")
    ? Boolean(body.isDefault)
    : hasOwn(body, "default")
      ? Boolean(body.default)
      : Boolean(existing.isDefault);
  const storeId = cleanText(hasOwn(body, "storeId") ? body.storeId : existing.storeId || store?.id || "", 80);
  const storeName = cleanText(
    hasOwn(body, "storeName") ? body.storeName : existing.storeName || store?.label || store?.companyName || "当前店铺",
    120
  );
  const content = cleanText(hasOwn(body, "content") ? body.content : existing.content || "", 3000);
  return {
    ...existing,
    id: existing.id || crypto.randomUUID(),
    templateName,
    name: templateName,
    storeId,
    storeName,
    isDefault,
    default: isDefault,
    content,
    templateSettings: {
      ...(existing.templateSettings || {}),
      content,
    },
    createdAt: existing.createdAt || now,
    updatedAt: now,
  };
}

function normalizeWatermarkTemplate(body, existing = {}) {
  const now = new Date().toISOString();
  const name = cleanText(
    hasOwn(body, "name") ? body.name : hasOwn(body, "templateName") ? body.templateName : existing.name || existing.templateName,
    80
  );
  if (!name) {
    const err = new Error("模板名称必填");
    err.status = 400;
    throw err;
  }
  const typeValue = cleanText(hasOwn(body, "type") ? body.type : existing.type || "text", 24);
  const allowedTypes = new Set(["text", "border", "image"]);
  const fontSize = Math.max(8, Math.min(120, Number(body.fontSize ?? existing.fontSize ?? 28) || 28));
  const opacity = Math.max(0, Math.min(100, Number(body.opacity ?? existing.opacity ?? 40) || 40));
  const rotate = Math.max(-180, Math.min(180, Number(body.rotate ?? existing.rotate ?? -30) || -30));
  const margin = Math.max(0, Math.min(50, Number(body.margin ?? existing.margin ?? 8) || 8));
  const positionValue = cleanText(hasOwn(body, "position") ? body.position : existing.position || "center", 24);
  const allowedPositions = new Set(["center", "tile", "top-left", "top-right", "bottom-left", "bottom-right"]);
  const isDefault = hasOwn(body, "isDefault") ? Boolean(body.isDefault) : Boolean(existing.isDefault);
  return {
    ...existing,
    id: existing.id || crypto.randomUUID(),
    name,
    templateName: name,
    type: allowedTypes.has(typeValue) ? typeValue : "text",
    text: cleanText(hasOwn(body, "text") ? body.text : existing.text || "", 200),
    font: cleanText(hasOwn(body, "font") ? body.font : existing.font || "system", 40),
    fontSize,
    color: cleanText(hasOwn(body, "color") ? body.color : existing.color || "#ffffff", 24),
    opacity,
    rotate,
    margin,
    position: allowedPositions.has(positionValue) ? positionValue : "center",
    isDefault,
    createdAt: existing.createdAt || now,
    updatedAt: now,
  };
}

function localWriteDisabled(res, feature = "该功能") {
  sendError(
    res,
    409,
    `${feature}在本地复刻版中不会直接写入 Ozon。请先在后台绑定并确认真实写入链路后再启用。`,
    "LOCAL_OZON_WRITE_DISABLED",
  );
}

function normalizeCollectItem(raw = {}, sourceId = "") {
  const sku = String(raw.sku || raw.productId || raw.product_id || raw.offer_id || "").trim();
  const productUrl = raw.productUrl || raw.url || raw.link || "";
  return {
    ...raw,
    id: String(raw.id || raw.collectId || raw.sourceExternalId || sku || crypto.randomUUID()),
    sku,
    productUrl,
    name: raw.name || raw.title || raw.productName || sku || productUrl || "—",
    source: raw.source || sourceId || raw.platform || "插件采集",
    status: raw.status || "待处理",
    createdAt: raw.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}


// === Ozon.ru 竞品数据抓取 ===
// 通过 ego-browser CLI 从 ozon.ru 页面抓取商品数据（标题/价格/图片/卖家/品牌等）
// 后备方案：直接 HTTP fetch（可能被反爬拦截）

const EGO_BROWSER_BIN = "/Users/songliang/.local/bin/ego-browser";

function spawnAsync(cmd, args, input, timeoutMs = 60000) {

  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, FORCE_COLOR: "0" },
    });
    let stdout = "";
    let stderr = "";
    let timer = null;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch {}
        reject(new Error(`spawn timeout after ${timeoutMs}ms`));
      }, timeoutMs);
    }
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`exit ${code}: ${stderr.slice(0, 500)}`));
    });
    if (input) {
      child.stdin.write(input);
      child.stdin.end();
    } else {
      child.stdin.end();
    }
  });
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

async function runEgoScript(script, timeoutMs = 120000) {
  const tmpFile = path.join("/tmp", `qh-ego-scrape-${Date.now()}-${Math.random().toString(16).slice(2)}.js`);
  await fs.writeFile(tmpFile, script, "utf8");
  try {
    return await spawnAsync(
      "/bin/zsh",
      ["-lc", `${shellQuote(EGO_BROWSER_BIN)} nodejs < ${shellQuote(tmpFile)}`],
      "",
      timeoutMs,
    );
  } finally {
    await fs.unlink(tmpFile).catch(() => {});
  }
}

async function scrapeOzonProductBySku(sku) {
  const cleanSku = String(sku || "").trim();
  if (!cleanSku) throw new Error("SKU 不能为空");

  // 策略1：通过 ego-browser 抓取 ozon.ru 搜索页
  const script = `
const task = await useOrCreateTaskSpace('qh-scrape-' + ${JSON.stringify(cleanSku)}.slice(-6));
await openOrReuseTab('https://www.ozon.ru/search/?text=${cleanSku}', { wait: true, timeout: 30 });
await wait(4);
const data = await js(() => {
  const results = [];
  // 从搜索结果页提取商品数据
  const cards = document.querySelectorAll('[data-index]');
  for (let i = 0; i < Math.min(cards.length, 5); i++) {
    const card = cards[i];
    const link = card.querySelector('a[href*="/product/"]');
    if (!link) continue;
    const href = link.getAttribute('href') || '';
    const skuMatch = href.match(/-(\\d+)\/?(?:\?|$)/);
    const title = card.querySelector('span[class*="title"], h3, [class*="title"]')?.textContent?.trim() || '';
    const priceText = card.querySelector('[class*="price"]')?.textContent?.trim() || '';
    const img = card.querySelector('img')?.src || '';
    results.push({
      sku: skuMatch ? skuMatch[1] : '',
      title: title,
      priceText: priceText,
      image: img,
      url: href.startsWith('http') ? href : 'https://www.ozon.ru' + href,
    });
  }
  return JSON.stringify(results);
})();
cliLog(data);
`;
  try {
    const result = await runEgoScript(script, 90000);
    const output = `${result.stdout || ""}\n${result.stderr || ""}`;
    const lines = output.trim().split("\n").filter((l) => l.trim());
    const lastLine = lines[lines.length - 1];
    if (lastLine) {
      try {
        const items = JSON.parse(lastLine);
        if (Array.isArray(items) && items.length > 0) {
          return items;
        }
      } catch {}
    }
  } catch (e) {
    console.error("[scrapeOzonProduct] ego-browser failed:", e.message);
  }

  // 策略2：直接 HTTP fetch ozon.ru 搜索页（后备，可能被反爬）
  try {
    const resp = await fetch(
      `https://www.ozon.ru/search/?text=${encodeURIComponent(cleanSku)}`,
      {
        headers: {
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
          "Accept": "text/html,application/xhtml+xml",
          "Accept-Language": "ru-RU,ru;q=0.9",
        },
        signal: AbortSignal.timeout(15000),
      }
    );
    if (resp.ok) {
      const html = await resp.text();
      // 从 HTML 中提取 embedded JSON data
      const items = [];
      // Ozon 页面中有 data-state 属性包含商品数据
      const stateMatches = html.match(/data-state="([^"]+)"/g) || [];
      for (const match of stateMatches.slice(0, 50)) {
        try {
          const jsonStr = match.replace(/^data-state="/, "").replace(/"$/, "").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
          const parsed = JSON.parse(jsonStr);
          if (parsed && (parsed.items || parsed.searchResults || parsed.card)) {
            const cardItems = parsed.items || parsed.searchResults || [parsed.card];
            for (const item of cardItems) {
              if (item && (item.sku || item.id)) {
                items.push({
                  sku: String(item.sku || item.id || ""),
                  title: item.title || item.name || "",
                  priceText: String(item.price || item.priceText || ""),
                  image: item.image || (item.images || [])[0] || "",
                  url: item.url || `https://www.ozon.ru/product/${item.sku || item.id}/`,
                });
              }
            }
          }
        } catch {}
      }
      if (items.length > 0) return items;
    }
  } catch (e) {
    console.error("[scrapeOzonProduct] HTTP fetch failed:", e.message);
  }

  return [];
}

async function scrapeOzonProductDetail(sku) {
  const cleanSku = String(sku || "").trim();
  if (!cleanSku) throw new Error("SKU 不能为空");

  // 尝试通过 ego-browser proxy 抓取（端口 3002）
  const EGO_PROXY_URL = process.env.EGO_PROXY_URL || "http://127.0.0.1:3002";
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120000);
    const resp = await fetch(`${EGO_PROXY_URL}/scrape`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sku: cleanSku }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (resp.ok) {
      const data = await resp.json();
      if (data?.ok && data?.data) {
        return data.data;
      }
    }
  } catch (e) {
    console.error("[scrapeOzonProductDetail] ego-proxy failed:", e.message);
  }

  // 后备：直接 spawn ego-browser（在非沙箱环境工作时可用）
  const scriptPath = path.join(__dirname, "scrape-script.js");
  let scriptTemplate;
  try {
    scriptTemplate = await fs.readFile(scriptPath, "utf8");
  } catch {
    return null;
  }
  const script = scriptTemplate.replace(/SKU_PLACEHOLDER/g, JSON.stringify(cleanSku));
  try {
    const result = await runEgoScript(script, 120000);
    const output = `${result.stdout || ""}\n${result.stderr || ""}`;
    const lines = output.trim().split("\n").filter((l) => l.trim());
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i];
      if (line === "SCRAPE_FAILED") break;
      try {
        const parsed = JSON.parse(line);
        if (parsed && (parsed.title || parsed.priceText)) {
          return parsed;
        }
      } catch {}
    }
  } catch (e) {
    console.error("[scrapeOzonProductDetail] direct spawn failed:", e.message);
  }
  return null;
}


async function ozonCall(store, apiPath, body, timeoutMs = 60000) {
  if (!store?.clientId || !store?.apiKey) {
    const err = new Error("Ozon Client ID / API Key 未配置");
    err.status = 400;
    throw err;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${OZON_API_BASE}${apiPath}`, {
      method: "POST",
      headers: {
        "Client-Id": String(store.clientId),
        "Api-Key": String(store.apiKey),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body || {}),
      signal: controller.signal,
    });
    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text };
    }
    if (!response.ok) {
      const err = new Error(`Ozon ${response.status}: ${text.slice(0, 300)}`);
      err.status = response.status;
      err.body = data;
      throw err;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

async function ozonGet(store, apiPath, timeoutMs = 60000) {
  if (!store?.clientId || !store?.apiKey) {
    const err = new Error("Ozon Client ID / API Key 未配置");
    err.status = 400;
    throw err;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${OZON_API_BASE}${apiPath}`, {
      method: "GET",
      headers: {
        "Client-Id": String(store.clientId),
        "Api-Key": String(store.apiKey),
      },
      signal: controller.signal,
    });
    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text };
    }
    if (!response.ok) {
      const err = new Error(`Ozon ${response.status}: ${text.slice(0, 300)}`);
      err.status = response.status;
      err.body = data;
      throw err;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

function truthyOzonFlag(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value > 0;
  const text = String(value ?? "").trim().toLowerCase();
  if (!text) return null;
  if (["true", "1", "yes", "y", "premium", "premium_plus", "active", "grace_good"].includes(text)) return true;
  if (["false", "0", "no", "n", "standard", "free", "none", "inactive", "not_premium"].includes(text)) return false;
  return null;
}

function firstCleanText(values, maxLength = 160) {
  for (const value of values) {
    const text = cleanText(value, maxLength);
    if (text) return text;
  }
  return "";
}

function extractSellerInfoProfile(payload = {}) {
  const source = payload?.result && typeof payload.result === "object" ? payload.result : payload;
  const company = source?.company && typeof source.company === "object" ? source.company : {};
  const subscription = source?.subscription && typeof source.subscription === "object" ? source.subscription : {};
  const premiumCandidates = [
    subscription.is_premium,
    subscription.isPremium,
    subscription.premium,
    subscription.current,
    subscription.status,
    source.is_premium,
    source.isPremium,
    source.premium,
  ];
  const premium = premiumCandidates.map(truthyOzonFlag).find((value) => value !== null);
  return {
    companyName: firstCleanText([company.name, source.company_name, source.companyName, source.name], 160),
    legalName: firstCleanText([company.legal_name, company.legalName, source.legal_name, source.legalName], 220),
    inn: firstCleanText([company.inn, company.INN, source.inn, source.INN, company.tax_id, source.tax_id], 80),
    isPremium: premium,
  };
}

async function syncStoreProfile(state, store) {
  const response = await ozonCall(store, "/v1/seller/info", {});
  const profile = extractSellerInfoProfile(response);
  if (profile.companyName) {
    store.companyName = profile.companyName;
    store.shopName = profile.companyName;
  }
  if (profile.legalName) store.legalName = profile.legalName;
  if (profile.inn) {
    store.inn = profile.inn;
    store.taxId = profile.inn;
  }
  if (profile.isPremium !== null && profile.isPremium !== undefined) {
    store.isPremium = profile.isPremium;
  }
  store.profileSyncedAt = new Date().toISOString();
  store.updatedAt = store.profileSyncedAt;
  return profile;
}

async function refreshStoreProfiles(state, storeId = "") {
  const targets = storeId
    ? state.stores.filter((store) => String(store.id) === String(storeId))
    : state.stores;
  if (storeId && !targets.length) {
    const err = new Error("门店不存在");
    err.status = 404;
    throw err;
  }
  const errors = [];
  let syncedCount = 0;
  for (const store of targets) {
    try {
      await syncStoreProfile(state, store);
      syncedCount += 1;
    } catch (error) {
      errors.push({
        storeId: store.id,
        message: String(error?.message || error).slice(0, 240),
      });
    }
  }
  await saveState(state);
  return { syncedCount, errors };
}

function cacheKeyForStore(store, suffix) {
  return `${store?.clientId || store?.id || "unknown"}:${suffix}`;
}

async function getOzonDescriptionCategoryTree(store, language = "DEFAULT") {
  const cacheKey = cacheKeyForStore(store, `tree:${language}`);
  const cached = descriptionCategoryTreeCache.get(cacheKey);
  if (cached && Date.now() - cached.at < DESCRIPTION_CATEGORY_CACHE_TTL_MS) {
    return cached.data;
  }
  const data = await ozonCall(store, "/v1/description-category/tree", { language }, 120000);
  const tree = Array.isArray(data?.result) ? data.result : [];
  descriptionCategoryTreeCache.set(cacheKey, { at: Date.now(), data: tree });
  return tree;
}

function findDescriptionCategoryIdByTypeId(tree, typeId) {
  const wantedTypeId = Number(typeId);
  if (!Number.isFinite(wantedTypeId) || wantedTypeId <= 0) return 0;
  let found = 0;
  const visit = (node, activeDescriptionCategoryId = 0) => {
    if (!node || found) return;
    const currentDescriptionCategoryId = Number(node.description_category_id) || activeDescriptionCategoryId;
    if (Number(node.type_id) === wantedTypeId) {
      found = currentDescriptionCategoryId;
      return;
    }
    for (const child of Array.isArray(node.children) ? node.children : []) {
      visit(child, currentDescriptionCategoryId);
      if (found) return;
    }
  };
  for (const root of Array.isArray(tree) ? tree : []) {
    visit(root, 0);
    if (found) break;
  }
  return found;
}

async function getOzonDescriptionCategoryAttributes(store, descriptionCategoryId, typeId, language = "DEFAULT") {
  const descCatId = Number(descriptionCategoryId);
  const targetTypeId = Number(typeId);
  if (!Number.isFinite(descCatId) || descCatId <= 0 || !Number.isFinite(targetTypeId) || targetTypeId <= 0) {
    return [];
  }
  const cacheKey = cacheKeyForStore(store, `attrs:${language}:${descCatId}:${targetTypeId}`);
  const cached = descriptionCategoryAttributesCache.get(cacheKey);
  if (cached && Date.now() - cached.at < DESCRIPTION_CATEGORY_CACHE_TTL_MS) {
    return cached.data;
  }
  const data = await ozonCall(
    store,
    "/v1/description-category/attribute",
    { description_category_id: descCatId, type_id: targetTypeId, language },
    60000,
  );
  const attrs = Array.isArray(data?.result) ? data.result : [];
  descriptionCategoryAttributesCache.set(cacheKey, { at: Date.now(), data: attrs });
  return attrs;
}

function getRequestStore(state, req, fallbackStoreId) {
  const storeId = req.headers["x-ozon-store-id"] || fallbackStoreId || state.currentStoreId;
  const store = activeStore(state, storeId);
  if (!store) {
    const err = new Error("未绑定 Ozon 店铺");
    err.status = 400;
    throw err;
  }
  return store;
}

function normalizeImportTaskStatus(value = "") {
  const status = String(value || "").toLowerCase();
  if (["imported", "success", "processed"].includes(status)) return "SUCCESS";
  if (["failed", "error"].includes(status)) return "FAILED";
  if (["pending", "processing", "created"].includes(status)) return "RUNNING";
  return status ? status.toUpperCase() : "QUEUED";
}

function upsertImportJob(state, patch) {
  const id = String(patch.id || patch.localTaskId || crypto.randomUUID());
  const previous = state.jobs[id] || {};
  const job = {
    ...previous,
    ...patch,
    id,
    localTaskId: id,
    listing: true,
    createdAt: previous.createdAt || patch.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  state.jobs[id] = job;
  return job;
}

function publicImportTask(job = {}) {
  const {
    clientId,
    items,
    stocks,
    request,
    response,
    statusResponse,
    errorBody,
    ...safe
  } = job;
  return {
    ...safe,
    taskId: job.ozonTaskId || job.taskId || job.id,
    localTaskId: job.localTaskId || job.id,
  };
}

function listImportJobs(state) {
  const accepted = new Set(["IMPORT_BY_SKU", "PRODUCT_IMPORT", "PUBLIC_IMPORT", "FOLLOW_FROM_PUBLIC", "STOCK_IMPORT"]);
  return Object.values(state.jobs || {})
    .filter((job) => job.listing || accepted.has(job.type))
    .map(publicImportTask)
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
}

function publicImportPreviewItem(item = {}, raw = {}) {
  return {
    offer_id: item.offer_id || "",
    sku: raw.scraped_sku || raw.sku || raw.offer_id || "",
    name: item.name || "",
    price: item.price || "",
    currency_code: item.currency_code || "",
    description_category_id: item.description_category_id || "",
    type_id: item.type_id || "",
    imageCount: Array.isArray(item.images) ? item.images.length : 0,
    attributeCount: Array.isArray(item.attributes) ? item.attributes.length : 0,
    complexAttributeCount: Array.isArray(item.complex_attributes) ? item.complex_attributes.length : 0,
    weight: item.weight || "",
    depth: item.depth || "",
    width: item.width || "",
    height: item.height || "",
  };
}

async function previewOzonProductImport(state, req, body) {
  const store = getRequestStore(state, req, body.storeId);
  const rawItems = withStoreContractCurrency(state, store, Array.isArray(body.items) ? body.items.filter(Boolean) : []);
  if (!rawItems.length) {
    const err = new Error("缺少可预检的 items");
    err.status = 400;
    throw err;
  }
  const normalized = await normalizeOzonImportItems(rawItems, {
    strictTypeMatch: !!body.strictTypeMatch,
    getCategoryTree: () => getOzonDescriptionCategoryTree(store, "DEFAULT"),
    getCategoryAttributes: (descriptionCategoryId, typeId) =>
      getOzonDescriptionCategoryAttributes(store, descriptionCategoryId, typeId, "DEFAULT"),
  });
  return {
    ok: true,
    dryRun: true,
    itemCount: normalized.items.length,
    warnings: normalized.warnings || [],
    items: normalized.items.map((item, index) => publicImportPreviewItem(item, rawItems[index] || {})),
  };
}

async function createOzonProductImport(state, req, body, type = "PRODUCT_IMPORT") {
  const store = getRequestStore(state, req, body.storeId);
  const rawItems = withStoreContractCurrency(state, store, Array.isArray(body.items) ? body.items.filter(Boolean) : []);
  const localTaskId = String(body.taskId || crypto.randomUUID());
  const baseJob = upsertImportJob(state, {
    id: localTaskId,
    clientJobId: localTaskId,
    type,
    status: rawItems.length ? "PENDING" : "PENDING_INPUT",
    storeId: store.id,
    entry: body.entry || "",
    sku: body.sku || body.offerId || rawItems[0]?.sku || rawItems[0]?.scraped_sku || "",
    itemCount: rawItems.length,
    stockCount: Array.isArray(body.stocks) ? body.stocks.length : 0,
    items: rawItems,
    stocks: Array.isArray(body.stocks) ? body.stocks : [],
    request: {
      applyWatermark: !!body.applyWatermark,
      applyPoster: !!body.applyPoster,
      applyAiRewrite: !!body.applyAiRewrite,
      strictTypeMatch: !!body.strictTypeMatch,
    },
    local: true,
  });

  if (!rawItems.length) {
    await saveState(state);
    return {
      ok: true,
      local: true,
      queued: true,
      task_id: localTaskId,
      result: { task_id: localTaskId, localTaskId },
      job: publicImportTask(baseJob),
      warnings: ["缺少可直接提交到 Ozon 的 items，已创建待处理任务"],
    };
  }

  let items = [];
  let normalizationWarnings = [];
  try {
    const normalized = await normalizeOzonImportItems(rawItems, {
      strictTypeMatch: !!body.strictTypeMatch,
      getCategoryTree: () => getOzonDescriptionCategoryTree(store, "DEFAULT"),
      getCategoryAttributes: (descriptionCategoryId, typeId) =>
        getOzonDescriptionCategoryAttributes(store, descriptionCategoryId, typeId, "DEFAULT"),
    });
    items = normalized.items;
    normalizationWarnings = normalized.warnings || [];
    if (!items.length) {
      throw new Error(normalizationWarnings[0] || "没有可提交到 Ozon 的有效商品");
    }
    upsertImportJob(state, {
      ...baseJob,
      status: "PENDING",
      items,
      normalizedItemCount: items.length,
      normalizationWarnings,
    });
  } catch (error) {
    const job = upsertImportJob(state, {
      ...baseJob,
      status: "FAILED",
      errorMessage: error?.message || "Ozon 上架数据转换失败",
      local: true,
    });
    await saveState(state);
    const err = new Error(error?.message || "Ozon 上架数据转换失败");
    err.status = 400;
    err.body = { ok: false, job: publicImportTask(job), warnings: normalizationWarnings };
    throw err;
  }

  try {
    const importResp = await ozonCall(store, "/v3/product/import", { items }, 120000);
    const ozonTaskId = importResp?.result?.task_id || importResp?.task_id || "";
    const job = upsertImportJob(state, {
      ...baseJob,
      status: ozonTaskId ? "QUEUED" : "SUBMITTED",
      items,
      normalizedItemCount: items.length,
      normalizationWarnings,
      ozonTaskId,
      response: importResp,
      local: false,
    });
    await saveState(state);
    return {
      ok: true,
      local: false,
      task_id: ozonTaskId || localTaskId,
      result: { ...(importResp?.result || {}), task_id: ozonTaskId || localTaskId, localTaskId },
      job: publicImportTask(job),
      warnings: normalizationWarnings,
      raw: importResp,
    };
  } catch (error) {
    const job = upsertImportJob(state, {
      ...baseJob,
      status: "FAILED",
      items,
      normalizedItemCount: items.length,
      normalizationWarnings,
      errorMessage: error?.message || String(error),
      errorBody: error?.body || null,
      local: false,
    });
    await saveState(state);
    const err = new Error(error?.message || "Ozon 商品上架失败");
    err.status = error?.status || 502;
    err.body = { ok: false, job: publicImportTask(job), ozon: error?.body || null };
    throw err;
  }
}

function pickArray(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value.items)) return value.items;
  if (Array.isArray(value.stocks)) return value.stocks;
  if (Array.isArray(value.rows)) return value.rows;
  if (Array.isArray(value.products)) return value.products;
  if (Array.isArray(value.result?.items)) return value.result.items;
  if (Array.isArray(value.result?.stocks)) return value.result.stocks;
  if (Array.isArray(value.result?.rows)) return value.result.rows;
  if (Array.isArray(value.result?.products)) return value.result.products;
  if (Array.isArray(value.result)) return value.result;
  return [];
}

function stockCountFromOzon(row = {}) {
  return Number(
    row.present ??
    row.stock ??
    row.available ??
    row.quantity ??
    row.balance ??
    row.available_stock ??
    row.free_to_sell ??
    row.free_to_sell_amount ??
    0
  ) || 0;
}

function normalizeWarehouseStockRows(item = {}, defaultSource = "fbs") {
  const rows = pickArray(item.stocks).length ? pickArray(item.stocks) : pickArray(item);
  const sourceRows = rows.length ? rows : (item.warehouse_id || item.warehouseId || item.warehouse_name || item.warehouseName ? [item] : []);
  return sourceRows.map((row) => ({
    ...row,
    warehouse_id: row.warehouse_id ?? row.warehouseId ?? row.warehouse?.id ?? item.warehouse_id ?? item.warehouseId,
    warehouse_name: row.warehouse_name ?? row.warehouseName ?? row.warehouse?.name ?? item.warehouse_name ?? item.warehouseName,
    present: stockCountFromOzon(row),
    reserved: Number(row.reserved ?? row.reserved_stock ?? row.reserved_amount ?? 0) || 0,
    sku: row.sku ?? item.sku,
    offer_id: row.offer_id ?? item.offer_id,
    product_id: row.product_id ?? item.product_id,
    source: row.source || defaultSource,
  })).filter((row) => row.warehouse_id || row.warehouse_name);
}

function addWarehouseStockLookup(map, item = {}, defaultSource = "fbs") {
  const rows = normalizeWarehouseStockRows(item, defaultSource);
  const keys = [
    item.product_id,
    item.productId,
    item.id,
    item.offer_id,
    item.offerId,
    item.item_code,
    item.sku,
  ].filter(Boolean).map(String);
  if (!rows.length || !keys.length) return;
  for (const key of keys) {
    const existing = map.get(key) || [];
    map.set(key, [...existing, ...rows]);
  }
}

function warehouseStockRowsForProduct(map, product = {}) {
  const keys = [
    product.product_id,
    product.productId,
    product.id,
    product.offer_id,
    product.offerId,
    product.item_code,
    product.sku,
  ].filter(Boolean).map(String);
  return keys
    .map((key) => map.get(key))
    .find((rows) => Array.isArray(rows)) || [];
}

function dedupeWarehouseStockRows(rows = []) {
  const seen = new Set();
  return rows.filter((row) => {
    const key = [
      String(row.source || ""),
      String(row.warehouse_id ?? row.warehouseId ?? ""),
      String(row.warehouse_name ?? row.warehouseName ?? ""),
      String(row.sku ?? ""),
      String(row.offer_id ?? row.offerId ?? ""),
    ].join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function fetchWarehouseStockLookup(store) {
  const map = new Map();
  let total = 0;
  const limit = 1000;
  try {
    for (let offset = 0; offset < 100000; offset += limit) {
      const data = await ozonCall(store, "/v2/analytics/stock_on_warehouses", { limit, offset, warehouse_type: "ALL" }, 120000);
      const items = pickArray(data);
      if (!items.length) break;
      for (const item of items) {
        addWarehouseStockLookup(map, item, "fbo");
        total += 1;
      }
      if (items.length < limit) break;
    }
    return { loaded: true, map, total };
  } catch (error) {
    console.error("[syncProducts] warehouse stock detail sync failed:", String(error?.message || error).slice(0, 300));
    return { loaded: false, map, total: 0 };
  }
}

async function fetchFbsWarehouseStockLookup(store, products = []) {
  const map = new Map();
  const offerIds = [...new Set(products.map((item) => item.offer_id || item.offerId).filter(Boolean).map(String))];
  const skuIds = [...new Set(products.map((item) => item.sku).filter(Boolean).map(Number).filter(Boolean))];
  const chunks = offerIds.length
    ? offerIds.reduce((acc, item, index) => {
        if (index % 500 === 0) acc.push([]);
        acc[acc.length - 1].push(item);
        return acc;
      }, [])
    : skuIds.reduce((acc, item, index) => {
        if (index % 500 === 0) acc.push([]);
        acc[acc.length - 1].push(item);
        return acc;
      }, []);
  let total = 0;
  try {
    for (const chunk of chunks) {
      let cursor = "";
      for (let page = 0; page < 50; page += 1) {
        const payload = {
          limit: 1000,
          ...(offerIds.length ? { offer_id: chunk } : { sku: chunk }),
          ...(cursor ? { cursor } : {}),
        };
        const data = await ozonCall(store, "/v2/product/info/stocks-by-warehouse/fbs", payload, 120000);
        const items = pickArray(data);
        for (const item of items) {
          addWarehouseStockLookup(map, item, "fbs");
          total += 1;
        }
        cursor = data?.cursor || data?.result?.cursor || "";
        if (!data?.has_next && !data?.result?.has_next) break;
        if (!cursor) break;
      }
    }
    return { loaded: true, map, total };
  } catch (error) {
    console.error("[syncProducts] fbs warehouse stock sync failed:", String(error?.message || error).slice(0, 300));
    return { loaded: false, map, total: 0 };
  }
}

function productMatchesStockChange(product = {}, stock = {}, store = {}) {
  const productStoreId = product.storeId || product.store_id || product.ozonStoreId || product.localStoreId;
  const productClientId = product.clientId || product.client_id || product.ozonClientId;
  if (productStoreId && String(productStoreId) !== String(store.id)) return false;
  if (!productStoreId && productClientId && String(productClientId) !== String(store.clientId)) return false;
  const stockOfferId = stock.offer_id || stock.offerId;
  const stockProductId = stock.product_id || stock.productId;
  const stockSku = stock.sku;
  if (stockOfferId && String(product.offer_id || product.offerId || "") === String(stockOfferId)) return true;
  if (stockProductId && String(product.product_id || product.productId || product.id || "") === String(stockProductId)) return true;
  if (stockSku && String(product.sku || product.ozon_sku || "") === String(stockSku)) return true;
  return false;
}

function applyStockChangesToCache(state, store, stocks = []) {
  const products = state.caches.products || [];
  const syncedAt = new Date().toISOString();
  let updated = 0;
  for (const stock of stocks) {
    const warehouseId = stock.warehouse_id ?? stock.warehouseId;
    if (!warehouseId) continue;
    const product = products.find((item) => productMatchesStockChange(item, stock, store));
    if (!product) continue;
    const nextStock = Math.max(0, Number(stock.stock ?? stock.present ?? 0) || 0);
    const rows = Array.isArray(product.warehouse_stocks) ? [...product.warehouse_stocks] : [];
    const existingIndex = rows.findIndex((row) => String(row.warehouse_id ?? row.warehouseId) === String(warehouseId));
    const currentRow = existingIndex >= 0 ? rows[existingIndex] : {};
    const nextRow = {
      ...currentRow,
      warehouse_id: Number(warehouseId) || String(warehouseId),
      present: nextStock,
      reserved: Number(currentRow.reserved ?? currentRow.reserved_stock ?? 0) || 0,
      sku: product.sku ?? stock.sku,
      source: currentRow.source || "fbs",
    };
    if (existingIndex >= 0) rows[existingIndex] = nextRow;
    else rows.push(nextRow);
    product.warehouse_stocks = rows;

    const fbsTotal = rows.reduce((sum, row) => sum + stockCountFromOzon(row), 0);
    const stockRows = Array.isArray(product.stocks?.stocks) ? product.stocks.stocks : [];
    const nonFbsRows = stockRows.filter((row) => !String(row.source || "").toLowerCase().includes("fbs"));
    product.stocks = {
      ...(product.stocks || {}),
      has_stock: fbsTotal > 0 || nonFbsRows.some((row) => stockCountFromOzon(row) > 0),
      stocks: [
        ...nonFbsRows,
        {
          present: fbsTotal,
          reserved: rows.reduce((sum, row) => sum + (Number(row.reserved ?? row.reserved_stock ?? 0) || 0), 0),
          sku: product.sku ?? stock.sku,
          source: "fbs",
        },
      ],
    };
    product.syncedAt = syncedAt;
    updated += 1;
  }
  return updated;
}

async function syncProducts(state, store) {
  let imported = 0;
  const cache = state.caches.products;
  const warehouseStockLookup = await fetchWarehouseStockLookup(store);
  for (const visibility of ["ALL", "ARCHIVED"]) {
    let lastId = "";
    for (let page = 0; page < 20; page += 1) {
      const listPayload = { limit: 1000, filter: { visibility } };
      if (lastId) listPayload.last_id = lastId;
      const listRes = await ozonCall(store, "/v3/product/list", listPayload);
      const items = listRes?.result?.items || [];
      const listItemById = new Map(items.map((item) => [String(item.product_id || item.id || item.offer_id || ""), item]));
      const ids = items.map((item) => item.product_id).filter(Boolean).map(String);
      if (!ids.length) break;
      for (let i = 0; i < ids.length; i += 1000) {
        const chunk = ids.slice(i, i + 1000);
        const infoRes = await ozonCall(store, "/v3/product/info/list", { product_id: chunk }, 120000);
        const priceRes = await ozonCall(
          store,
          "/v5/product/info/prices",
          { filter: { product_id: chunk, visibility }, limit: chunk.length },
          120000
        );
        const details = infoRes?.result?.items || infoRes?.items || [];
        const priceDetails = priceRes?.items || priceRes?.result?.items || [];
        const priceItemById = new Map(priceDetails.map((item) => [String(item.product_id || item.id || item.offer_id || ""), item]));
        const fbsWarehouseStockLookup = await fetchFbsWarehouseStockLookup(store, details);
        const syncedAt = new Date().toISOString();
        for (const raw of details) {
          const id = raw.id || raw.product_id || raw.offer_id;
          const listItem = listItemById.get(String(id || "")) || {};
          const priceItem = priceItemById.get(String(id || "")) || {};
          const warehouseStocks = dedupeWarehouseStockRows([
            ...warehouseStockRowsForProduct(warehouseStockLookup.map, raw),
            ...warehouseStockRowsForProduct(fbsWarehouseStockLookup.map, raw),
          ]);
          const isArchived = Boolean(raw.is_archived || raw.archived || visibility === "ARCHIVED");
          upsertById(cache, id, {
            ...raw,
            id: String(id),
            price: priceItem.price || raw.price,
            marketing_actions: priceItem.marketing_actions || raw.marketing_actions,
            price_info: priceItem,
            price_indexes: priceItem.price_indexes || raw.price_indexes,
            ...(warehouseStockLookup.loaded || fbsWarehouseStockLookup.loaded ? { warehouse_stocks: warehouseStocks || [] } : {}),
            visibilityFilter: visibility,
            listVisibility: listItem.visibility || visibility,
            is_archived: isArchived,
            storeId: store.id,
            storeName: store.label || store.companyName || "",
            clientId: store.clientId,
            syncedAt,
          });
          imported += 1;
        }
      }
      const nextLastId = listRes?.result?.last_id;
      if (!nextLastId || String(nextLastId) === String(lastId)) break;
      lastId = String(nextLastId);
    }
  }
  return imported;
}

async function syncPostings(state, store, sinceDays = 30) {
  let imported = 0;
  const now = new Date();
  // Ozon FBS API 限制查询周期不超过 ~30 天，分批拉取
  const totalDays = Math.max(1, Math.min(Number(sinceDays) || 30, 365));
  const batchDays = 28; // 安全间隔

  for (let offset = 0; offset < totalDays; offset += batchDays) {
    const batchEnd = new Date(now.getTime() - Math.max(0, offset) * 24 * 60 * 60 * 1000);
    const batchStart = new Date(now.getTime() - Math.min(totalDays, offset + batchDays) * 24 * 60 * 60 * 1000);
    let cursor = "";

    for (let page = 0; page < 50; page += 1) {
      let listRes;
      try {
        listRes = await ozonCall(store, "/v4/posting/fbs/list", {
          cursor,
          limit: 100,
          filter: { since: batchStart.toISOString(), to: batchEnd.toISOString() },
          with: {
            analytics_data: true,
            barcodes: true,
            financial_data: true,
            translit: true,
          },
        });
      } catch (e) {
        if (String(e?.message || "").includes("PERIOD_IS_TOO_LONG")) {
          // 缩短周期重试
          const midTime = (batchStart.getTime() + batchEnd.getTime()) / 2;
          const midDate = new Date(midTime);
          listRes = await ozonCall(store, "/v4/posting/fbs/list", {
            cursor: "",
            limit: 100,
            filter: { since: batchStart.toISOString(), to: midDate.toISOString() },
            with: { analytics_data: true, barcodes: true, financial_data: true, translit: true },
          });
        } else {
          throw e;
        }
      }
      const result = listRes?.result || listRes || {};
      const postings = result.postings || result.items || [];
      if (!postings.length) break;
      for (const raw of postings) {
        const id = raw.posting_number || raw.order_id || raw.id;
        upsertById(state.caches.postings, id, { ...raw, id: String(id), syncedAt: new Date().toISOString() });
        imported += 1;
      }
      const nextCursor = result.cursor || listRes?.cursor || "";
      const hasNext = result.has_next ?? listRes?.has_next;
      if (hasNext === false || !nextCursor || String(nextCursor) === String(cursor)) break;
      cursor = String(nextCursor);
    }
  }

  // Also sync FBO postings
  try {
    let fboLastId = "";
    for (let page = 0; page < 50; page += 1) {
      const fboPayload = { limit: 100, with: { analytics_data: true } };
      if (fboLastId) fboPayload.last_id = fboLastId;
      const fboRes = await ozonCall(store, "/v2/posting/fbo/list", fboPayload);
      const fboPostings = fboRes?.result?.postings || [];
      if (!fboPostings.length) break;
      for (const raw of fboPostings) {
        const id = raw.posting_number || raw.order_id || raw.id;
        upsertById(state.caches.postings, id, { ...raw, id: String(id), syncedAt: new Date().toISOString(), shipment_type: "FBO" });
        imported += 1;
      }
      fboLastId = fboRes?.result?.last_id || "";
      if (!fboLastId) break;
    }
  } catch (e) {
    console.error("[syncPostings] FBO sync failed:", e.message);
  }

  return imported;
}

async function syncWarehouses(state, store) {
  const res = await ozonCall(store, "/v2/warehouse/list", {});
  const candidate =
    res?.result?.warehouses ||
    res?.result?.items ||
    res?.result ||
    res?.warehouses ||
    res?.items ||
    [];
  const warehouses = Array.isArray(candidate) ? candidate : [];
  const syncedAt = new Date().toISOString();
  const scopedWarehouses = warehouses.map((raw) => ({
    ...raw,
    id: String(raw.warehouse_id || raw.id || raw.name || crypto.randomUUID()),
    storeId: store.id,
    storeName: store.label || store.companyName || "",
    clientId: store.clientId,
    syncedAt,
  }));
  state.caches.warehouses = [
    ...(state.caches.warehouses || []).filter((item) => {
      const storeId = item.storeId || item.store_id || item.ozonStoreId || item.currentOzonStoreId || item.localStoreId;
      const clientId = item.clientId || item.client_id || item.ozonClientId;
      const storeName = item.storeName || item.store_name || item.shopName || item.companyName;
      if (!storeId && !clientId && !storeName) return false;
      if (storeId && String(storeId) === String(store.id)) return false;
      if (clientId && String(clientId) === String(store.clientId)) return false;
      return true;
    }),
    ...scopedWarehouses,
  ];
  return scopedWarehouses.length;
}

async function syncPromotions(state, store) {
  const res = await ozonGet(store, "/v1/actions");
  const items = Array.isArray(res)
    ? res
    : (Array.isArray(res?.result) ? res.result : (res?.result?.items || res?.items || res?.actions || []));
  const promotions = (Array.isArray(items) ? items : []).map((raw) => ({
    ...raw,
    id: String(raw.id || raw.action_id || raw.title || crypto.randomUUID()),
    syncedAt: new Date().toISOString(),
  }));
  state.caches.promotions = promotions;
  return promotions.length;
}

async function runLocalSync(state, type, storeId, options = {}) {
  const store = activeStore(state, storeId);
  if (!store) {
    const err = new Error("未找到已绑定门店");
    err.status = 400;
    throw err;
  }
  const upper = String(type || "").toUpperCase();
  const jobId = options.jobId || crypto.randomUUID();
  const report = {
    id: jobId,
    clientJobId: jobId,
    storeId: store.id,
    type: upper,
    status: "RUNNING",
    fetchedCount: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  state.jobs[jobId] = report;
  state.reports.unshift(report);
  await saveState(state);
  try {
    try {
      await syncStoreProfile(state, store);
      delete store.profileSyncError;
    } catch (error) {
      store.profileSyncError = String(error?.message || error).slice(0, 240);
    }
    let fetched = 0;
    if (upper === "PRODUCTS") fetched = await syncProducts(state, store);
    else if (upper === "POSTINGS") fetched = await syncPostings(state, store, options.postingsSinceDays);
    else if (upper === "WAREHOUSES") fetched = await syncWarehouses(state, store);
    else if (upper === "PROMOTIONS") fetched = await syncPromotions(state, store);
    else throw new Error("不支持的同步类型");
    report.status = "SUCCESS";
    report.fetchedCount = fetched;
    report.updatedAt = new Date().toISOString();
    state.jobs[jobId] = report;
    await saveState(state);
    return report;
  } catch (error) {
    report.status = "FAILED";
    report.error = String(error?.message || error).slice(0, 500);
    report.updatedAt = new Date().toISOString();
    state.jobs[jobId] = report;
    await saveState(state);
    throw error;
  }
}

async function handle(req, res) {
  if (req.method === "OPTIONS") {
    sendJson(res, 204, {});
    return;
  }

  const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
  const state = await loadState();

  if (req.method === "GET" && url.pathname === "/health") {
    sendJson(res, 200, { ok: true, service: "qh-local-api", version: "0.13.46.1-local" });
    return;
  }

  if (req.method === "GET" && url.pathname === "/local/state") {
    const account = optionalAuth(req, state);
    sendJson(res, 200, localStatePayload(state, {
      authenticated: Boolean(account),
      account,
      includeAccounts: account?.role === "admin",
    }));
    return;
  }

  if (req.method === "POST" && url.pathname === "/local/accounts/login") {
    const body = await readBody(req);
    const username = String(body.username || body.phoneNumber || body.phone || "").trim();
    const password = String(body.password || "");
    const account = findAccountByUsername(state, username);
    if (!account || !verifyPassword(password, account)) {
      sendError(res, 401, "账号或密码错误", "LOCAL_LOGIN_FAILED");
      return;
    }
    if (account.status === "disabled") {
      sendError(res, 403, "账号已被停用，请联系管理员", "LOCAL_ACCOUNT_DISABLED");
      return;
    }
    if (isAccountExpired(account)) {
      sendError(res, 403, "账号登录期限已过期，请联系管理员", "LOCAL_ACCOUNT_EXPIRED");
      return;
    }
    const now = new Date().toISOString();
    state.token = createToken();
    state.currentAccountId = account.id;
    state.sessionIssuedAt = now;
    account.lastLoginAt = now;
    account.updatedAt = now;
    await saveState(state);
    sendJson(res, 200, {
      ok: true,
      token: state.token,
      account: publicAccount(account),
      state: localStatePayload(state, { authenticated: true, account, includeAccounts: account.role === "admin" }),
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/local/accounts/logout") {
    state.token = "";
    state.currentAccountId = "";
    state.sessionIssuedAt = "";
    await saveState(state);
    sendJson(res, 200, { ok: true, state: limitedLocalStatePayload(state) });
    return;
  }

  if (req.method === "GET" && url.pathname === "/local/accounts") {
    requireAdmin(req, state);
    sendJson(res, 200, { ok: true, accounts: state.accounts.map(publicAccount) });
    return;
  }

  if (req.method === "POST" && url.pathname === "/local/accounts") {
    requireAdmin(req, state);
    const body = await readBody(req);
    const username = String(body.username || "").trim();
    const password = String(body.password || "");
    if (!username || !password) {
      sendError(res, 400, "账号和初始密码必填");
      return;
    }
    if (findAccountByUsername(state, username)) {
      sendError(res, 409, "账号已存在", "LOCAL_ACCOUNT_EXISTS");
      return;
    }
    const account = createAccountRecord({
      username,
      password,
      displayName: body.displayName || username,
      role: body.role || "user",
      expiresAt: body.expiresAt || "",
      status: body.status || "active",
    });
    state.accounts.push(account);
    await saveState(state);
    sendJson(res, 200, { ok: true, account: publicAccount(account), accounts: state.accounts.map(publicAccount) });
    return;
  }

  const accountMatch = url.pathname.match(/^\/local\/accounts\/([^/]+)$/);
  if (accountMatch && req.method === "PATCH") {
    const admin = requireAdmin(req, state);
    const accountId = decodeURIComponent(accountMatch[1]);
    const account = state.accounts.find((item) => item.id === accountId);
    if (!account) {
      sendError(res, 404, "账号不存在");
      return;
    }
    const body = await readBody(req);
    if (body.displayName !== undefined) account.displayName = String(body.displayName || account.username).trim();
    if (body.role !== undefined) account.role = body.role === "admin" ? "admin" : "user";
    if (body.status !== undefined) account.status = body.status === "disabled" ? "disabled" : "active";
    if (body.expiresAt !== undefined) account.expiresAt = normalizeAccountExpiresAt(body.expiresAt);
    if (body.password) Object.assign(account, createPasswordHash(body.password));
    if (account.id === admin.id && account.status === "disabled") {
      sendError(res, 400, "不能停用当前登录的管理员账号");
      return;
    }
    if (account.id === admin.id && account.role !== "admin") {
      sendError(res, 400, "不能取消当前登录账号的管理员权限");
      return;
    }
    account.updatedAt = new Date().toISOString();
    await saveState(state);
    sendJson(res, 200, { ok: true, account: publicAccount(account), accounts: state.accounts.map(publicAccount) });
    return;
  }

  if (accountMatch && req.method === "DELETE") {
    const admin = requireAdmin(req, state);
    const accountId = decodeURIComponent(accountMatch[1]);
    if (accountId === admin.id) {
      sendError(res, 400, "不能删除当前登录的管理员账号");
      return;
    }
    const before = state.accounts.length;
    state.accounts = state.accounts.filter((account) => account.id !== accountId);
    if (state.accounts.length === before) {
      sendError(res, 404, "账号不存在");
      return;
    }
    await saveState(state);
    sendJson(res, 200, { ok: true, accounts: state.accounts.map(publicAccount) });
    return;
  }

  if (req.method === "POST" && url.pathname === "/local/binding") {
    requireAuth(req, state);
    const body = await readBody(req);
    const requestedLabel = String(body.storeName || body.label || "").trim();
    const clientId = String(body.clientId || "").trim();
    const id = createStoreId(clientId);
    const existing = activeStore(state, id);
    const apiKey = String(body.apiKey || existing?.apiKey || "").trim();
    if (!clientId || !apiKey) {
      sendError(res, 400, "Client-Id 和 Api-Key 必填");
      return;
    }
    const storeName = requestedLabel || existing?.label || "已绑定门店";
    const store = {
      ...(existing || {}),
      id,
      storeId: id,
      label: storeName,
      companyName: storeName,
      legalName: storeName,
      clientId,
      apiKey,
      savedAt: existing?.savedAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    state.stores = [store, ...state.stores.filter((item) => item.id !== id)];
    state.currentStoreId = id;
    try {
      await syncStoreProfile(state, store);
      delete store.profileSyncError;
    } catch (error) {
      store.profileSyncError = String(error?.message || error).slice(0, 240);
    }
    await saveState(state);
    sendJson(res, 200, { ok: true, token: state.token, store: publicStore(store, state), state: localStatePayload(state) });
    return;
  }

  if (req.method === "DELETE" && url.pathname === "/local/binding") {
    requireAuth(req, state);
    state.currentStoreId = "";
    state.stores = [];
    state.caches = defaultState().caches;
    state.hashes = {};
    state.leases = {};
    state.jobs = {};
    state.reports = [];
    await saveState(state);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && url.pathname === "/local/current-store") {
    requireAuth(req, state);
    const body = await readBody(req);
    const storeId = String(body.storeId || body.id || "").trim();
    const store = activeStore(state, storeId);
    if (!store) {
      sendError(res, 404, "门店不存在");
      return;
    }
    state.currentStoreId = store.id;
    try {
      await syncStoreProfile(state, store);
      delete store.profileSyncError;
    } catch (error) {
      store.profileSyncError = String(error?.message || error).slice(0, 240);
      store.updatedAt = new Date().toISOString();
    }
    await saveState(state);
    sendJson(res, 200, { ok: true, store: publicStore(store, state), state: localStatePayload(state) });
    return;
  }

  if (req.method === "POST" && url.pathname === "/local/stores/refresh-profile") {
    requireAuth(req, state);
    const body = await readBody(req);
    const storeId = String(body.storeId || "").trim();
    const result = await refreshStoreProfiles(state, storeId);
    sendJson(res, 200, { ok: true, ...result, state: localStatePayload(await loadState()) });
    return;
  }

  const localStoreMatch = url.pathname.match(/^\/local\/stores\/([^/]+)$/);
  if (req.method === "DELETE" && localStoreMatch) {
    requireAuth(req, state);
    const storeId = decodeURIComponent(localStoreMatch[1]);
    const exists = state.stores.some((store) => String(store.id) === String(storeId));
    if (!exists) {
      sendError(res, 404, "门店不存在");
      return;
    }
    state.stores = state.stores.filter((store) => String(store.id) !== String(storeId));
    if (String(state.currentStoreId || "") === String(storeId)) {
      state.currentStoreId = state.stores[0]?.id || "";
    }
    await saveState(state);
    sendJson(res, 200, { ok: true, state: localStatePayload(state) });
    return;
  }

  const localSyncMatch = url.pathname.match(/^\/local\/sync\/([^/]+)$/);
  if (req.method === "POST" && localSyncMatch) {
    requireAuth(req, state);
    const body = await readBody(req);
    const report = await runLocalSync(state, localSyncMatch[1], body.storeId || state.currentStoreId, body);
    sendJson(res, 200, { ok: true, job: report, state: localStatePayload(await loadState()) });
    return;
  }

  if (req.method === "GET" && url.pathname === "/auth/ozon-stores") {
    requireAuth(req, state);
    sendJson(res, 200, state.stores.map((store) => publicStore(store, state)));
    return;
  }

  if (req.method === "GET" && url.pathname === "/auth/captcha") {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="36"><rect width="96" height="36" fill="#f5f7fb"/><text x="14" y="24" fill="#1677ff" font-size="18" font-family="Arial">LOCAL</text></svg>`;
    sendJson(res, 200, {
      data: {
        captchaId: "local-captcha",
        imageBase64: `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`,
      },
    });
    return;
  }

  if (req.method === "PUT" && url.pathname === "/auth/device/heartbeat") {
    sendJson(res, 200, { ok: true, local: true, at: new Date().toISOString() });
    return;
  }

  const storePatchMatch = url.pathname.match(/^\/auth\/ozon-stores\/([^/]+)$/);
  if (req.method === "PATCH" && storePatchMatch) {
    requireAuth(req, state);
    const body = await readBody(req);
    const store = activeStore(state, decodeURIComponent(storePatchMatch[1]));
    if (!store) {
      sendError(res, 404, "门店不存在");
      return;
    }
    const cookieAuth = body.cookieAuth || {};
    store.sellerCompanyId = cookieAuth.sc_company_id || store.sellerCompanyId || "";
    store.sellerCookieCount = cookieAuth.cookies ? String(cookieAuth.cookies).split(";").filter(Boolean).length : (store.sellerCookieCount || 0);
    store.sellerCookieSyncedAt = new Date().toISOString();
    store.updatedAt = new Date().toISOString();
    await saveState(state);
    sendJson(res, 200, { ok: true, store: publicStore(store, state), sellerCompanyId: store.sellerCompanyId, sellerCookieCount: store.sellerCookieCount });
    return;
  }

  if (req.method === "POST" && url.pathname === "/auth/send-code") {
    await readBody(req);
    sendError(res, 400, "本地版不支持短信登录，请使用管理员分配的账号密码登录", "LOCAL_SMS_DISABLED");
    return;
  }

  if (req.method === "POST" && url.pathname === "/auth/sms/verify") {
    await readBody(req);
    sendError(res, 400, "本地版不支持短信登录，请使用账号密码登录", "LOCAL_SMS_DISABLED");
    return;
  }

  if (req.method === "POST" && url.pathname === "/auth/login-password") {
    const body = await readBody(req);
    const username = String(body.username || body.phoneNumber || body.phone || "").trim();
    const password = String(body.password || "");
    const account = findAccountByUsername(state, username);
    if (!account || !verifyPassword(password, account)) {
      sendError(res, 401, "账号或密码错误", "LOCAL_LOGIN_FAILED");
      return;
    }
    if (account.status === "disabled") {
      sendError(res, 403, "账号已被停用，请联系管理员", "LOCAL_ACCOUNT_DISABLED");
      return;
    }
    if (isAccountExpired(account)) {
      sendError(res, 403, "账号登录期限已过期，请联系管理员", "LOCAL_ACCOUNT_EXPIRED");
      return;
    }
    const now = new Date().toISOString();
    state.token = createToken();
    state.currentAccountId = account.id;
    state.sessionIssuedAt = now;
    account.lastLoginAt = now;
    account.updatedAt = now;
    await saveState(state);
    try {
      sendJson(res, 200, { ok: true, local: true, ...localAuthPayload(state), account: publicAccount(account) });
    } catch (error) {
      sendError(res, error.status || 400, error.message, "LOCAL_BINDING_REQUIRED");
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/feature-flags/me") {
    sendJson(res, 200, {
      ozon_fleet_serverside: false,
      ozon_public_import: false,
      localClone: true,
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/membership/usage-summary") {
    requireAuth(req, state);
    sendJson(res, 200, {
      plan: "free",
      level: "免费会员",
      canUse: { AI_EDIT: true },
      usage: { aiEditTrialExpired: false },
      limits: {},
      local: true,
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/jidian/balance") {
    requireAuth(req, state);
    sendJson(res, 200, { balance: 0, pointLabel: "极点", local: true });
    return;
  }

  if (req.method === "GET" && url.pathname === "/jidian/pricing") {
    requireAuth(req, state);
    sendJson(res, 200, { AI_IMAGE: 50, AI_REWRITE: 20, _meta: { pointAlias: "极点", local: true } });
    return;
  }

  if (req.method === "GET" && url.pathname === "/ozon/watermark-settings") {
    requireAuth(req, state);
    sendJson(res, 200, state.caches.watermarkTemplates || []);
    return;
  }

  if (req.method === "POST" && url.pathname === "/ozon/watermark-settings") {
    requireAuth(req, state);
    const body = await readBody(req);
    state.caches.watermarkTemplates = state.caches.watermarkTemplates || [];
    const item = normalizeWatermarkTemplate({
      ...body,
      isDefault: hasOwn(body, "isDefault") ? body.isDefault : state.caches.watermarkTemplates.length === 0,
    });
    if (item.isDefault) {
      state.caches.watermarkTemplates = state.caches.watermarkTemplates.map((template) => ({ ...template, isDefault: false }));
      const store = activeStore(state);
      if (store) store.watermarkTemplateId = item.id;
    }
    state.caches.watermarkTemplates.unshift(item);
    await saveState(state);
    sendJson(res, 200, { ok: true, item, state: localStatePayload(state), local: true });
    return;
  }

  const watermarkTemplateMatch = url.pathname.match(/^\/ozon\/watermark-settings\/([^/]+)$/);
  if (watermarkTemplateMatch && (req.method === "PUT" || req.method === "DELETE")) {
    requireAuth(req, state);
    const id = decodeURIComponent(watermarkTemplateMatch[1]);
    state.caches.watermarkTemplates = state.caches.watermarkTemplates || [];
    const index = state.caches.watermarkTemplates.findIndex((item) => String(item.id) === String(id));
    if (index < 0) {
      sendError(res, 404, "水印模板不存在");
      return;
    }
    const store = activeStore(state);
    if (req.method === "DELETE") {
      const [removed] = state.caches.watermarkTemplates.splice(index, 1);
      if (store?.watermarkTemplateId === removed.id) {
        store.watermarkTemplateId = state.caches.watermarkTemplates[0]?.id || "";
        state.caches.watermarkTemplates = state.caches.watermarkTemplates.map((template, templateIndex) => ({
          ...template,
          isDefault: templateIndex === 0 && Boolean(store.watermarkTemplateId),
        }));
      }
      await saveState(state);
      sendJson(res, 200, { ok: true, removedId: removed.id, state: localStatePayload(state), local: true });
      return;
    }
    const body = await readBody(req);
    const item = normalizeWatermarkTemplate(body, state.caches.watermarkTemplates[index]);
    if (item.isDefault) {
      state.caches.watermarkTemplates = state.caches.watermarkTemplates.map((template) => (
        String(template.id) === String(item.id) ? template : { ...template, isDefault: false }
      ));
      if (store) store.watermarkTemplateId = item.id;
    }
    state.caches.watermarkTemplates[index] = item;
    await saveState(state);
    sendJson(res, 200, { ok: true, item, state: localStatePayload(state), local: true });
    return;
  }

  if (req.method === "POST" && url.pathname === "/usage/track") {
    requireAuth(req, state);
    const body = await readBody(req);
    state.reports.unshift({
      id: crypto.randomUUID(),
      type: "USAGE_TRACK",
      status: "SUCCESS",
      featureKey: body.featureKey || "",
      client: body.client || "",
      version: body.version || "",
      createdAt: new Date().toISOString(),
    });
    state.reports = state.reports.slice(0, 200);
    await saveState(state);
    sendJson(res, 200, { ok: true, local: true });
    return;
  }

  if (req.method === "GET" && url.pathname === "/ozon/sync/client-intervals") {
    requireAuth(req, state);
    sendJson(res, 200, { postingsMin: 5, productsMin: 30, warehousesMin: 360 });
    return;
  }

  const credMatch = url.pathname.match(/^\/ozon\/stores\/([^/]+)\/sync-credentials$/);
  if (req.method === "GET" && credMatch) {
    requireAuth(req, state);
    const store = activeStore(state, decodeURIComponent(credMatch[1]));
    if (!store) {
      sendError(res, 404, "门店不存在");
      return;
    }
    sendJson(res, 200, { clientId: store.clientId, apiKey: store.apiKey });
    return;
  }

  if (req.method === "POST" && url.pathname === "/ozon/sync/lease/acquire") {
    requireAuth(req, state);
    const body = await readBody(req);
    const leaseKey = `${body.storeId}:${String(body.type || "").toUpperCase()}`;
    const now = Date.now();
    const existing = state.leases[leaseKey];
    if (existing && new Date(existing.expiresAt).getTime() > now && existing.deviceId !== body.deviceId) {
      sendJson(res, 200, { acquired: false, expiresAt: existing.expiresAt });
      return;
    }
    const ttl = Math.max(60, Number(body.ttlSeconds || 300));
    const lease = {
      leaseId: crypto.randomUUID(),
      storeId: body.storeId,
      type: String(body.type || "").toUpperCase(),
      deviceId: body.deviceId || "",
      expiresAt: new Date(now + ttl * 1000).toISOString(),
    };
    state.leases[leaseKey] = lease;
    await saveState(state);
    sendJson(res, 200, { acquired: true, leaseId: lease.leaseId, expiresAt: lease.expiresAt });
    return;
  }

  if (req.method === "POST" && url.pathname === "/ozon/sync/lease/heartbeat") {
    requireAuth(req, state);
    const body = await readBody(req);
    const leaseEntry = Object.entries(state.leases).find(([, lease]) => lease.leaseId === body.leaseId);
    if (!leaseEntry) {
      sendJson(res, 200, { refreshed: false, expiresAt: null });
      return;
    }
    const ttl = Math.max(60, Number(body.ttlSeconds || 300));
    leaseEntry[1].expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
    await saveState(state);
    sendJson(res, 200, { refreshed: true, expiresAt: leaseEntry[1].expiresAt });
    return;
  }

  if (req.method === "POST" && url.pathname === "/ozon/sync/lease/release") {
    requireAuth(req, state);
    const body = await readBody(req);
    for (const [key, lease] of Object.entries(state.leases)) {
      if (lease.leaseId === body.leaseId) delete state.leases[key];
    }
    await saveState(state);
    sendJson(res, 200, { released: true });
    return;
  }

  if (req.method === "POST" && url.pathname === "/ozon/sync/client-report") {
    requireAuth(req, state);
    const body = await readBody(req);
    const jobId = body.clientJobId || body.id || crypto.randomUUID();
    const previous = state.jobs[jobId] || {};
    const report = {
      ...previous,
      ...body,
      id: jobId,
      clientJobId: jobId,
      updatedAt: new Date().toISOString(),
      createdAt: previous.createdAt || new Date().toISOString(),
    };
    state.jobs[jobId] = report;
    state.reports.unshift(report);
    state.reports = state.reports.slice(0, 200);
    await saveState(state);
    sendJson(res, 200, { ok: true, job: report });
    return;
  }

  if (url.pathname === "/browser-agents/register" && req.method === "POST") {
    requireAuth(req, state);
    const body = await readBody(req);
    const deviceKey = String(body.deviceKey || body.extensionId || "local-browser-agent");
    const agentId = `local_agent_${crypto.createHash("sha256").update(deviceKey).digest("hex").slice(0, 12)}`;
    const agent = {
      id: agentId,
      deviceKey,
      deviceName: body.deviceName || "Chrome Browser Agent",
      extensionId: body.extensionId || "",
      extensionVersion: body.extensionVersion || "",
      capabilities: Array.isArray(body.capabilities) ? body.capabilities : [],
      status: "online",
      local: true,
      registeredAt: state.browserAgents?.[agentId]?.registeredAt || new Date().toISOString(),
      lastHeartbeatAt: new Date().toISOString(),
    };
    state.browserAgents = { ...(state.browserAgents || {}), [agentId]: agent };
    await saveState(state);
    sendJson(res, 200, agent);
    return;
  }

  if (url.pathname === "/browser-agents/heartbeat" && req.method === "POST") {
    requireAuth(req, state);
    const body = await readBody(req);
    const agentId = String(body.deviceId || body.id || "").trim() || `local_agent_${crypto.randomUUID().slice(0, 12)}`;
    const previous = state.browserAgents?.[agentId] || {};
    const agent = {
      ...previous,
      id: agentId,
      extensionVersion: body.extensionVersion || previous.extensionVersion || "",
      capabilities: Array.isArray(body.capabilities) ? body.capabilities : (previous.capabilities || []),
      status: "online",
      local: true,
      registeredAt: previous.registeredAt || new Date().toISOString(),
      lastHeartbeatAt: new Date().toISOString(),
    };
    state.browserAgents = { ...(state.browserAgents || {}), [agentId]: agent };
    await saveState(state);
    sendJson(res, 200, agent);
    return;
  }

  if (url.pathname === "/browser-agents/jobs/next" && req.method === "GET") {
    requireAuth(req, state);
    const deviceId = url.searchParams.get("deviceId") || "";
    if (deviceId) {
      if (!state.browserAgents) state.browserAgents = {};
      state.browserAgents[deviceId] = {
        deviceId,
        lastHeartbeatAt: new Date().toISOString(),
        registeredAt: state.browserAgents[deviceId]?.registeredAt || new Date().toISOString(),
      };
      await saveState(state);
    }
    const executableTypes = new Set([
      "collect.hot_products",
      "collect.product_detail",
      "ozon.collect_variant",
      "ozon.market_data",
      "listing.create_draft",
      "listing.publish_draft",
    ]);
    const pending = Object.values(state.jobs || {}).find(j =>
      executableTypes.has(j.type) &&
      (j.status === "PENDING" || j.status === "pending")
    );
    if (pending) {
      pending.status = "PROCESSING";
      pending.updatedAt = new Date().toISOString();
      state.jobs[pending.id] = pending;
      await saveState(state);
      sendJson(res, 200, { job: pending, idle: false });
    } else {
      sendJson(res, 200, { job: null, idle: true });
    }
    return;
  }

  const browserAgentJobMatch = url.pathname.match(/^\/browser-agents\/jobs\/([^/]+)\/(progress|result|fail)$/);
  if (browserAgentJobMatch && req.method === "POST") {
    requireAuth(req, state);
    const body = await readBody(req);
    const jobId = decodeURIComponent(browserAgentJobMatch[1]);
    const action = browserAgentJobMatch[2];
    const previous = state.jobs[jobId] || {};
    const statusMap = { progress: "RUNNING", result: "SUCCESS", fail: "FAILED" };
    const job = {
      ...previous,
      ...body,
      id: jobId,
      status: statusMap[action],
      local: true,
      updatedAt: new Date().toISOString(),
      createdAt: previous.createdAt || new Date().toISOString(),
    };
    state.jobs[jobId] = job;
    state.reports.unshift({
      id: crypto.randomUUID(),
      type: `BROWSER_AGENT_${action.toUpperCase()}`,
      status: job.status,
      jobId,
      deviceId: body.deviceId || "",
      createdAt: new Date().toISOString(),
    });
    state.reports = state.reports.slice(0, 200);
    await saveState(state);
    sendJson(res, 200, { ok: true, job, local: true });
    return;
  }

  const jobMatch = url.pathname.match(/^\/ozon\/sync\/jobs\/([^/]+)$/);
  if (req.method === "GET" && jobMatch) {
    requireAuth(req, state);
    const job = state.jobs[decodeURIComponent(jobMatch[1])] || null;
    if (!job) {
      sendError(res, 404, "同步任务不存在");
      return;
    }
    sendJson(res, 200, job);
    return;
  }

  const agentJobMatch = url.pathname.match(/^\/browser-agents\/(collection-jobs|market-data-jobs)(?:\/([^/]+))?$/);
  if (agentJobMatch) {
    requireAuth(req, state);
    const kind = agentJobMatch[1];
    const jobId = agentJobMatch[2] ? decodeURIComponent(agentJobMatch[2]) : crypto.randomUUID();
    if (req.method === "POST" && !agentJobMatch[2]) {
      const body = await readBody(req);
      const sku = String(body.sku || "").trim();
      const type = kind === "market-data-jobs" ? "ozon.market_data" : "ozon.collect_variant";
      const job = {
        id: jobId,
        type,
        kind,
        params: { ...body, sku },
        sku,
        status: "PENDING",
        result: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        local: true,
      };
      state.jobs[jobId] = job;
      await saveState(state);
      sendJson(res, 200, job);
      return;
    }
    if (req.method === "GET" && agentJobMatch[2]) {
      sendJson(res, 200, state.jobs[jobId] || {
        id: jobId,
        type: kind,
        status: "PENDING",
        result: null,
      });
      return;
    }
  }

  if (req.method === "POST" && url.pathname === "/ozon/cache/import-with-hash") {
    requireAuth(req, state);
    const body = await readBody(req);
    const items = Array.isArray(body.items) ? body.items : [];
    let imported = 0;
    for (const item of items) {
      const id = String(item.id || item.productId || "");
      if (!id) continue;
      const raw = item.raw || state.caches.products.find((row) => String(row.id || row.product_id) === id) || { id };
      upsertById(state.caches.products, id, { ...raw, id, contentHash: item.contentHash, syncedAt: new Date().toISOString() });
      state.hashes[`PRODUCTS:${id}`] = item.contentHash || "";
      imported += 1;
    }
    await saveState(state);
    sendJson(res, 200, { imported, needRaw: [] });
    return;
  }

  if (req.method === "POST" && url.pathname === "/ozon/postings/cache/import") {
    requireAuth(req, state);
    const body = await readBody(req);
    const items = Array.isArray(body.items) ? body.items : [];
    for (const item of items) {
      const id = String(item.posting_number || item.order_id || item.id || crypto.randomUUID());
      upsertById(state.caches.postings, id, { ...item, id, syncedAt: new Date().toISOString() });
    }
    await saveState(state);
    sendJson(res, 200, { imported: items.length });
    return;
  }

  if (req.method === "POST" && url.pathname === "/ozon/warehouses/cache/import") {
    requireAuth(req, state);
    const body = await readBody(req);
    const items = Array.isArray(body.items) ? body.items : [];
    const store = activeStore(state, body.storeId || req.headers["x-ozon-store-id"] || state.currentStoreId);
    const syncedAt = new Date().toISOString();
    const imported = items.map((item) => ({
      ...item,
      id: String(item.warehouse_id || item.id || item.name || crypto.randomUUID()),
      ...(store
        ? {
            storeId: store.id,
            storeName: store.label || store.companyName || "",
            clientId: store.clientId,
          }
        : {}),
      syncedAt,
    }));
    state.caches.warehouses = [
      ...(state.caches.warehouses || []).filter((item) => {
        if (!store) return false;
        const storeId = item.storeId || item.store_id || item.ozonStoreId || item.currentOzonStoreId || item.localStoreId;
        const clientId = item.clientId || item.client_id || item.ozonClientId;
        const storeName = item.storeName || item.store_name || item.shopName || item.companyName;
        if (!storeId && !clientId && !storeName) return false;
        if (storeId && String(storeId) === String(store.id)) return false;
        if (clientId && String(clientId) === String(store.clientId)) return false;
        return true;
      }),
      ...imported,
    ];
    await saveState(state);
    sendJson(res, 200, { imported: items.length });
    return;
  }

  if (req.method === "GET" && url.pathname === "/ozon/products/cache/status-counts") {
    requireAuth(req, state);
    sendJson(res, 200, { ALL: state.caches.products.length, total: state.caches.products.length });
    return;
  }

  if (req.method === "GET" && url.pathname === "/ozon/products/cache") {
    requireAuth(req, state);
    sendJson(res, 200, { data: state.caches.products, total: state.caches.products.length });
    return;
  }

  const productDataMatch = url.pathname.match(/^\/ozon\/product-data\/([^/]+)$/);
  if (req.method === "GET" && productDataMatch) {
    requireAuth(req, state);
    const sku = decodeURIComponent(productDataMatch[1]);
    const product = state.caches.products.find((item) =>
      [item.id, item.product_id, item.offer_id, item.sku].some((value) => String(value || "") === String(sku)),
    ) || null;
    sendJson(res, 200, { ok: true, data: product, sku, local: true });
    return;
  }

  if (req.method === "POST" && url.pathname === "/ozon/product-data/batch") {
    requireAuth(req, state);
    const body = await readBody(req);
    const skus = Array.isArray(body.skus) ? body.skus : Array.isArray(body.items) ? body.items : [];
    const products = state.caches.products.filter((item) =>
      skus.some((sku) => [item.id, item.product_id, item.offer_id, item.sku].some((value) => String(value || "") === String(sku))),
    );
    sendJson(res, 200, { ok: true, data: products, items: products, total: products.length, local: true });
    return;
  }

  if (req.method === "POST" && url.pathname === "/ozon/product-data/dims") {
    requireAuth(req, state);
    sendJson(res, 200, { ok: true, imported: 0, local: true });
    return;
  }

  // === 采集箱 SKU 抓取端点 ===
  if (req.method === "POST" && url.pathname === "/ozon/collect-box/scrape") {
    requireAuth(req, state);
    const body = await readBody(req);
    const sku = String(body.sku || body.skuId || "").trim();
    if (!sku) {
      sendError(res, 400, "SKU 不能为空");
      return;
    }
    try {
      const detail = await scrapeOzonProductDetail(sku);
      if (detail && detail.title) {
        const item = normalizeCollectItem({
          sku,
          productUrl: detail.url || `https://www.ozon.ru/product/test-${sku}/`,
          name: detail.title,
          price: detail.price || detail.priceText || "",
          priceText: detail.priceText || "",
          image: detail.primaryImage || (detail.images || [])[0] || "",
          images: detail.images || [],
          seller: detail.sellerName || "",
          sellerLink: detail.sellerLink || "",
          brand: detail.brand || "",
          category: (detail.categories || []).join(" / "),
          rating: detail.rating || null,
          reviewCount: detail.reviewCount || null,
          source: "SKU 抓取",
          status: "已采集",
          raw: { sku, scrapedAt: new Date().toISOString() },
        });
        await saveCollectBoxItemAtomic(item);
        sendJson(res, 200, { ok: true, data: item, scraped: true });
      } else {
        // 抓取失败，仍然创建条目但标记为待处理
        const item = normalizeCollectItem({
          sku,
          name: `SKU ${sku}`,
          source: "SKU 添加（抓取失败）",
          status: "待处理",
          raw: { sku, error: "scrape_failed" },
        });
        await saveCollectBoxItemAtomic(item);
        sendJson(res, 200, { ok: true, data: item, scraped: false, error: "未能从 ozon.ru 抓取到商品数据" });
      }
    } catch (error) {
      sendError(res, 500, `抓取失败: ${error.message}`);
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/ozon/collect-box/scrape-search") {
    requireAuth(req, state);
    const body = await readBody(req);
    const sku = String(body.sku || body.query || "").trim();
    if (!sku) {
      sendError(res, 400, "SKU / 搜索词不能为空");
      return;
    }
    try {
      const results = await scrapeOzonProductBySku(sku);
      sendJson(res, 200, { ok: true, data: results, total: results.length });
    } catch (error) {
      sendError(res, 500, `搜索失败: ${error.message}`);
    }
    return;
  }

  // === 类目树端点：尝试调用 Ozon API，失败时返回空 ===
  if (req.method === "GET" && url.pathname === "/ozon/categories/tree") {
    requireAuth(req, state);
    const language = url.searchParams.get("language") || "DEFAULT";
    const store = getRequestStore(state, req);
    if (store) {
      try {
        const tree = await getOzonDescriptionCategoryTree(store, language);
        sendJson(res, 200, { data: tree, items: tree, total: tree.length, language });
        return;
      } catch (err) {
        // Ozon API 可能对类目树端点返回 404，回退到从商品数据推断
      }
    }
    // 从已同步的商品数据中提取类目信息
    const catMap = new Map();
    for (const p of (state.caches.products || [])) {
      const catId = p.description_category_id;
      const typeId = p.type_id;
      if (catId) {
        const key = String(catId);
        if (!catMap.has(key)) {
          catMap.set(key, {
            id: catId,
            type_id: typeId,
            name: p.category || "",
            title: p.category || "",
            children: [],
          });
        }
      }
    }
    const tree = [...catMap.values()];
    sendJson(res, 200, { data: tree, items: tree, total: tree.length, language, inferred: true });
    return;
  }

  const categoryAttributesMatch = url.pathname.match(/^\/ozon\/description-category\/([^/]+)\/attributes$/);
  if (req.method === "GET" && categoryAttributesMatch) {
    requireAuth(req, state);
    const typeId = decodeURIComponent(categoryAttributesMatch[1]);
    const store = getRequestStore(state, req);
    if (store) {
      let catId = Number(url.searchParams.get("descriptionCategoryId") || url.searchParams.get("description_category_id")) || 0;
      if (!catId) {
        try {
          const tree = await getOzonDescriptionCategoryTree(store, "DEFAULT");
          catId = findDescriptionCategoryIdByTypeId(tree, typeId);
        } catch {
          catId = 0;
        }
      }
      if (!catId) {
        const product = (state.caches.products || []).find(
          (p) => String(p.type_id) === String(typeId)
        );
        catId = Number(product?.description_category_id) || 0;
      }
      if (catId) {
        try {
          const attrs = await getOzonDescriptionCategoryAttributes(store, catId, typeId, "DEFAULT");
          sendJson(res, 200, { data: attrs, items: attrs, total: attrs.length, typeId, categoryId: catId });
          return;
        } catch (err) {
          // 回退到空
        }
      }
    }
    sendJson(res, 200, { data: [], items: [], total: 0, typeId });
    return;
  }

  if (req.method === "GET" && url.pathname === "/ozon/collect-box") {
    requireAuth(req, state);
    sendJson(res, 200, emptyPage(url, state.caches.collectBox));
    return;
  }

  if (req.method === "POST" && url.pathname === "/ozon/collect-box") {
    requireAuth(req, state);
    const body = await readBody(req);
    const sku = String(body.sku || "").trim();
    const isUrl = /^https?:\/\//i.test(String(body.productUrl || body.url || body.name || ""));
    // 如果有 SKU 且不是 URL，尝试抓取 ozon.ru 数据
    if (sku && !isUrl) {
      try {
        const detail = await scrapeOzonProductDetail(sku);
        if (detail && detail.title) {
          const item = normalizeCollectItem({
            ...body,
            sku,
            productUrl: detail.url || `https://www.ozon.ru/product/test-${sku}/`,
            name: detail.title,
            price: detail.price || detail.priceText || "",
            priceText: detail.priceText || "",
            image: detail.primaryImage || (detail.images || [])[0] || "",
            images: detail.images || [],
            seller: detail.sellerName || "",
            sellerLink: detail.sellerLink || "",
            brand: detail.brand || "",
            category: (detail.categories || []).join(" / "),
            rating: detail.rating || null,
            reviewCount: detail.reviewCount || null,
            source: body.source || "SKU 抓取",
            status: "已采集",
            raw: { sku, scrapedAt: new Date().toISOString() },
          });
          await saveCollectBoxItemAtomic(item);
          sendJson(res, 200, item);
          return;
        }
      } catch (e) {
        // 抓取失败，继续创建普通条目
      }
    }
    const item = normalizeCollectItem(body);
    await saveCollectBoxItemAtomic(item);
    sendJson(res, 200, item);
    return;
  }

  const collectItemMatch = url.pathname.match(/^\/ozon\/collect-box\/([^/]+)$/);
  if (req.method === "PATCH" && collectItemMatch) {
    requireAuth(req, state);
    const id = decodeURIComponent(collectItemMatch[1]);
    const body = await readBody(req);
    const item = await updateCollectBoxItemAtomic(id, body);
    if (!item) {
      sendError(res, 404, "采集箱条目不存在");
      return;
    }
    sendJson(res, 200, item);
    return;
  }

  if (req.method === "POST" && url.pathname === "/ozon/collect-box/batch") {
    requireAuth(req, state);
    const body = await readBody(req);
    const items = Array.isArray(body.items) ? body.items : [];
    const imported = [];
    for (const raw of items) {
      const item = normalizeCollectItem(raw);
      imported.push(item);
    }
    const latest = await saveCollectBoxBatchAtomic(imported);
    sendJson(res, 200, { ok: true, imported: imported.length, data: imported, total: latest.caches.collectBox.length });
    return;
  }

  const sourceCollectMatch = url.pathname.match(/^\/sources\/([^/]+)\/collect(?:\/batch)?$/);
  if (req.method === "POST" && sourceCollectMatch) {
    requireAuth(req, state);
    const sourceId = decodeURIComponent(sourceCollectMatch[1]);
    const body = await readBody(req);
    const isBatch = url.pathname.endsWith("/batch");
    const rawItems = isBatch
      ? (Array.isArray(body.items) ? body.items : [])
      : [body.raw || body.product || body];
    const imported = [];
    for (const raw of rawItems) {
      const item = normalizeCollectItem({ ...raw, raw, sourceId }, sourceId);
      imported.push(item);
    }
    const latest = await saveCollectBoxBatchAtomic(imported);
    sendJson(res, 200, isBatch
      ? { ok: true, imported: imported.length, data: imported, total: latest.caches.collectBox.length }
      : { ok: true, data: imported[0] || null });
    return;
  }

  if (req.method === "GET" && url.pathname === "/ozon/favorites") {
    requireAuth(req, state);
    sendJson(res, 200, emptyPage(url, state.caches.favorites));
    return;
  }

  if (req.method === "POST" && url.pathname === "/ozon/favorites") {
    requireAuth(req, state);
    const body = await readBody(req);
    const item = normalizeCollectItem(body, "favorite");
    upsertById(state.caches.favorites, item.id, item);
    await saveState(state);
    sendJson(res, 200, item);
    return;
  }

  if (req.method === "GET" && url.pathname === "/ozon/warehouses") {
    requireAuth(req, state);
    sendJson(res, 200, state.caches.warehouses);
    return;
  }

  if (req.method === "GET" && url.pathname === "/ozon/returns") {
    requireAuth(req, state);
    const query = cleanText(url.searchParams.get("q") || url.searchParams.get("query") || "", 120).toLowerCase();
    const type = cleanText(url.searchParams.get("type") || "", 32).toLowerCase();
    const status = cleanText(url.searchParams.get("status") || "", 60).toLowerCase();
    const source = [...(state.caches.returns || []), ...(state.caches.refunds || [])];
    const items = source.filter((item) => {
      if (type && !String(item.type || item.kind || "").toLowerCase().includes(type)) return false;
      if (status && !String(item.status || "").toLowerCase().includes(status)) return false;
      if (query) {
        const text = [
          item.id,
          item.postingNumber,
          item.posting_number,
          item.sku,
          item.offer_id,
          item.productName,
          item.product_name,
          item.status,
        ].filter(Boolean).join(" ").toLowerCase();
        if (!text.includes(query)) return false;
      }
      return true;
    });
    sendJson(res, 200, emptyPage(url, items));
    return;
  }

  if (req.method === "POST" && url.pathname === "/ozon/returns/batch") {
    requireAuth(req, state);
    const store = activeStore(state, req.headers["x-ozon-store-id"] || state.currentStoreId);
    const body = await readBody(req);
    const kind = cleanText(body.kind || body.type || "return", 32);
    const target = kind.toLowerCase().includes("refund") ? state.caches.refunds : state.caches.returns;
    const items = (Array.isArray(body.items) ? body.items : []).slice(0, 200).map((item) => normalizeReturnItem(item, kind, store));
    for (const item of items) upsertById(target, item.id, item);
    await saveState(state);
    sendJson(res, 200, { ok: true, created: items.length, items, state: localStatePayload(state), local: true });
    return;
  }

  if (req.method === "GET" && url.pathname === "/ozon/products/import-by-sku/tasks") {
    requireAuth(req, state);
    const tasks = listImportJobs(state);
    sendJson(res, 200, emptyPage(url, tasks));
    return;
  }

  if (req.method === "POST" && url.pathname === "/extension/l1-samples") {
    requireAuth(req, state);
    const body = await readBody(req);
    state.reports.unshift({
      id: crypto.randomUUID(),
      type: "L1_SAMPLES",
      status: "SUCCESS",
      sampleCount: Array.isArray(body.samples) ? body.samples.length : 0,
      createdAt: new Date().toISOString(),
    });
    state.reports = state.reports.slice(0, 200);
    await saveState(state);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && url.pathname === "/ozon/selection/bestsellers/snapshot") {
    requireAuth(req, state);
    const body = await readBody(req);
    state.reports.unshift({
      id: crypto.randomUUID(),
      type: "BESTSELLERS_SNAPSHOT",
      status: "SUCCESS",
      period: body.period || "",
      itemCount: Array.isArray(body.items) ? body.items.length : 0,
      createdAt: new Date().toISOString(),
    });
    state.reports = state.reports.slice(0, 200);
    await saveState(state);
    sendJson(res, 200, { ok: true, imported: Array.isArray(body.items) ? body.items.length : 0 });
    return;
  }

  if (req.method === "POST" && url.pathname === "/ozon/selection/category-mapping") {
    requireAuth(req, state);
    sendJson(res, 200, { ok: true, local: true });
    return;
  }

  if (req.method === "POST" && url.pathname === "/ozon/extension/translate") {
    requireAuth(req, state);
    const body = await readBody(req);
    const texts = Array.isArray(body.texts) ? body.texts : [];
    sendJson(res, 200, { texts, translated: texts, from: body.from || "ru", to: body.to || "zh", local: true });
    return;
  }

  if (req.method === "POST" && url.pathname === "/ozon/extension/ai-optimize") {
    requireAuth(req, state);
    const body = await readBody(req);
    sendJson(res, 200, { ...body, optimized: false, suggestions: [], local: true });
    return;
  }

  if (req.method === "GET" && url.pathname === "/ozon/announcements") {
    requireAuth(req, state);
    const query = cleanText(url.searchParams.get("q") || url.searchParams.get("keyword"), 120).toLowerCase();
    const type = cleanText(url.searchParams.get("type"), 60).toLowerCase();
    const records = state.caches.announcements || [];
    const filtered = records.filter((item) => {
      const haystack = [item.title, item.summary, item.level, item.type]
        .map((value) => String(value || "").toLowerCase())
        .join(" ");
      if (query && !haystack.includes(query)) return false;
      if (type && !String(item.type || "").toLowerCase().includes(type)) return false;
      return true;
    });
    sendJson(res, 200, emptyPage(url, filtered));
    return;
  }

  if (req.method === "POST" && url.pathname === "/ozon/announcements/batch") {
    requireAuth(req, state);
    const body = await readBody(req);
    const items = Array.isArray(body.items) ? body.items : [];
    state.caches.announcements = state.caches.announcements || [];
    for (const item of items.slice(0, 100)) {
      const normalized = normalizeAnnouncement(item);
      upsertById(state.caches.announcements, normalized.id, normalized);
    }
    state.caches.announcements.sort((left, right) => new Date(right.time || right.createdAt || 0) - new Date(left.time || left.createdAt || 0));
    await saveState(state);
    sendJson(res, 200, { ok: true, imported: Math.min(items.length, 100), state: localStatePayload(state), local: true });
    return;
  }

  if (req.method === "POST" && url.pathname === "/ozon/announcements/read-all") {
    requireAuth(req, state);
    state.caches.announcements = (state.caches.announcements || []).map((item) => ({ ...item, read: true, updatedAt: new Date().toISOString() }));
    await saveState(state);
    sendJson(res, 200, { ok: true, updated: state.caches.announcements.length, state: localStatePayload(state), local: true });
    return;
  }

  if (req.method === "GET" && url.pathname === "/ozon/templates") {
    requireAuth(req, state);
    const templateName = cleanText(url.searchParams.get("templateName"), 80).toLowerCase();
    const defaultFilter = cleanText(url.searchParams.get("default") || url.searchParams.get("isDefault"), 16).toLowerCase();
    const storeFilter = cleanText(url.searchParams.get("store") || url.searchParams.get("storeName"), 120).toLowerCase();
    const templates = state.caches.productTemplates || [];
    const filtered = templates.filter((item) => {
      const itemName = String(item.templateName || item.name || "").toLowerCase();
      const itemStore = String(item.storeName || item.storeId || "").toLowerCase();
      if (templateName && !itemName.includes(templateName)) return false;
      if (storeFilter && !itemStore.includes(storeFilter)) return false;
      if (defaultFilter) {
        const defaultText = item.isDefault ? "是 true 1 yes default" : "否 false 0 no";
        if (!defaultText.includes(defaultFilter)) return false;
      }
      return true;
    });
    sendJson(res, 200, emptyPage(url, filtered));
    return;
  }

  if (req.method === "POST" && url.pathname === "/ozon/templates") {
    requireAuth(req, state);
    const body = await readBody(req);
    const item = normalizeProductTemplate(body, {}, activeStore(state));
    state.caches.productTemplates = state.caches.productTemplates || [];
    if (item.isDefault) {
      state.caches.productTemplates = state.caches.productTemplates.map((template) => ({ ...template, isDefault: false, default: false }));
    }
    state.caches.productTemplates.unshift(item);
    await saveState(state);
    sendJson(res, 200, { ok: true, item, state: localStatePayload(state), local: true });
    return;
  }

  const productTemplateMatch = url.pathname.match(/^\/ozon\/templates\/([^/]+)$/);
  if (productTemplateMatch && (req.method === "PUT" || req.method === "DELETE")) {
    requireAuth(req, state);
    const id = decodeURIComponent(productTemplateMatch[1]);
    state.caches.productTemplates = state.caches.productTemplates || [];
    const index = state.caches.productTemplates.findIndex((item) => String(item.id) === String(id));
    if (index < 0) {
      sendError(res, 404, "商品模板不存在");
      return;
    }
    if (req.method === "DELETE") {
      const [removed] = state.caches.productTemplates.splice(index, 1);
      await saveState(state);
      sendJson(res, 200, { ok: true, removedId: removed.id, state: localStatePayload(state), local: true });
      return;
    }
    const body = await readBody(req);
    const item = normalizeProductTemplate(body, state.caches.productTemplates[index], activeStore(state));
    if (item.isDefault) {
      state.caches.productTemplates = state.caches.productTemplates.map((template) => (
        String(template.id) === String(item.id) ? template : { ...template, isDefault: false, default: false }
      ));
    }
    state.caches.productTemplates[index] = item;
    await saveState(state);
    sendJson(res, 200, { ok: true, item, state: localStatePayload(state), local: true });
    return;
  }

  if (req.method === "GET" && url.pathname === "/ozon/message-templates") {
    requireAuth(req, state);
    const templateName = cleanText(url.searchParams.get("templateName"), 80).toLowerCase();
    const category = cleanText(url.searchParams.get("category"), 32);
    const contentPreview = cleanText(url.searchParams.get("contentPreview"), 120).toLowerCase();
    const templates = state.caches.messageTemplates || [];
    const filtered = templates.filter((item) => {
      const itemName = String(item.templateName || item.name || "").toLowerCase();
      const itemContent = String(item.content || "").toLowerCase();
      if (templateName && !itemName.includes(templateName)) return false;
      if (category && item.category !== category) return false;
      if (contentPreview && !itemContent.includes(contentPreview)) return false;
      return true;
    });
    sendJson(res, 200, emptyPage(url, filtered));
    return;
  }

  if (req.method === "POST" && url.pathname === "/ozon/message-templates") {
    requireAuth(req, state);
    const body = await readBody(req);
    const item = normalizeMessageTemplate(body);
    state.caches.messageTemplates = state.caches.messageTemplates || [];
    state.caches.messageTemplates.unshift(item);
    await saveState(state);
    sendJson(res, 200, { ok: true, item, state: localStatePayload(state), local: true });
    return;
  }

  const messageTemplateMatch = url.pathname.match(/^\/ozon\/message-templates\/([^/]+)$/);
  if (messageTemplateMatch && (req.method === "PUT" || req.method === "DELETE")) {
    requireAuth(req, state);
    const id = decodeURIComponent(messageTemplateMatch[1]);
    state.caches.messageTemplates = state.caches.messageTemplates || [];
    const index = state.caches.messageTemplates.findIndex((item) => String(item.id) === String(id));
    if (index < 0) {
      sendError(res, 404, "消息模板不存在");
      return;
    }
    if (req.method === "DELETE") {
      const [removed] = state.caches.messageTemplates.splice(index, 1);
      await saveState(state);
      sendJson(res, 200, { ok: true, removedId: removed.id, state: localStatePayload(state), local: true });
      return;
    }
    const body = await readBody(req);
    state.caches.messageTemplates[index] = normalizeMessageTemplate(body, state.caches.messageTemplates[index]);
    await saveState(state);
    sendJson(res, 200, { ok: true, item: state.caches.messageTemplates[index], state: localStatePayload(state), local: true });
    return;
  }

  if (req.method === "GET" && url.pathname === "/ozon/message-history") {
    requireAuth(req, state);
    const receiver = cleanText(url.searchParams.get("receiver"), 120).toLowerCase();
    const template = cleanText(url.searchParams.get("template") || url.searchParams.get("templateName"), 120).toLowerCase();
    const content = cleanText(url.searchParams.get("content"), 120).toLowerCase();
    const status = cleanText(url.searchParams.get("status"), 32);
    const kind = cleanText(url.searchParams.get("kind"), 32);
    const records = state.caches.messageHistory || [];
    const filtered = records.filter((item) => {
      if (receiver && !String(item.receiver || item.postingNumber || "").toLowerCase().includes(receiver)) return false;
      if (template && !String(item.templateName || "").toLowerCase().includes(template)) return false;
      if (content && !String(item.content || "").toLowerCase().includes(content)) return false;
      if (status && item.status !== status) return false;
      if (kind && item.kind !== kind) return false;
      return true;
    });
    sendJson(res, 200, emptyPage(url, filtered));
    return;
  }

  if (req.method === "POST" && url.pathname === "/ozon/message-history/batch") {
    requireAuth(req, state);
    const body = await readBody(req);
    const items = Array.isArray(body.items) ? body.items : [];
    const store = activeStore(state);
    const created = items.slice(0, 200).map((item) => normalizeMessageHistoryItem(item, store));
    state.caches.messageHistory = [...created, ...(state.caches.messageHistory || [])].slice(0, 1000);
    await saveState(state);
    sendJson(res, 200, { ok: true, created: created.length, items: created, state: localStatePayload(state), local: true, dryRun: true });
    return;
  }

  const templateApplyMatch = url.pathname.match(/^\/ozon\/templates\/([^/]+)\/apply$/);
  if (req.method === "POST" && templateApplyMatch) {
    requireAuth(req, state);
    const id = decodeURIComponent(templateApplyMatch[1]);
    const template = (state.caches.productTemplates || []).find((item) => String(item.id) === String(id));
    sendJson(res, 200, {
      ok: true,
      templateId: id,
      templateSettings: template?.templateSettings || {},
      template: template || null,
      local: true,
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/ozon/ai/optimize-for-rating") {
    requireAuth(req, state);
    const body = await readBody(req);
    sendJson(res, 200, {
      ok: true,
      local: true,
      optimized: false,
      title: body.title || "",
      description: body.description || "",
      attrs: body.currentAttrs || body.attrs || [],
      warnings: ["本地复刻版未接入线上 AI 优化服务"],
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/ozon/ai/suggest-category") {
    requireAuth(req, state);
    sendJson(res, 200, { ok: true, local: true, suggestions: [], category: null });
    return;
  }

  if (req.method === "POST" && url.pathname === "/ozon/ai/verify-category") {
    requireAuth(req, state);
    sendJson(res, 200, { ok: true, local: true, valid: true, reason: "本地复刻版未接入线上 AI 复核服务" });
    return;
  }

  const aiDraftMatch = url.pathname.match(/^\/ozon\/collect-box\/([^/]+)\/ai-listing-draft(?:\/(confirm|publish))?$/);
  if (req.method === "POST" && aiDraftMatch) {
    requireAuth(req, state);
    const id = decodeURIComponent(aiDraftMatch[1]);
    const action = aiDraftMatch[2] || "create";
    const item = state.caches.collectBox.find((row) => String(row.id) === String(id));
    if (!item) {
      sendError(res, 404, "采集箱条目不存在");
      return;
    }
    if (action === "publish") {
      localWriteDisabled(res, "AI 上架草稿发布");
      return;
    }
    const body = await readBody(req);
    item.aiListingDraft = {
      ...(item.aiListingDraft || {}),
      ...body,
      status: action === "confirm" ? "CONFIRMED_LOCAL" : "DRAFT_LOCAL",
      updatedAt: new Date().toISOString(),
    };
    item.updatedAt = new Date().toISOString();
    await saveState(state);
    sendJson(res, 200, { ok: true, draft: item.aiListingDraft, item, local: true });
    return;
  }

  if (req.method === "POST" && url.pathname === "/ozon/products/import/status") {
    requireAuth(req, state);
    const body = await readBody(req);
    const taskId = body.task_id || body.taskId || "";
    if (!taskId) {
      sendError(res, 400, "缺少 task_id");
      return;
    }
    const store = getRequestStore(state, req, body.storeId);
    const numericTaskId = Number(taskId);
    try {
      const data = await ozonCall(store, "/v1/product/import/info", {
        task_id: Number.isFinite(numericTaskId) && numericTaskId > 0 ? numericTaskId : taskId,
      }, 60000);
      const items = data?.result?.items || data?.items || [];
      const statuses = Array.isArray(items) ? items.map((item) => normalizeImportTaskStatus(item.status)) : [];
      const failed = statuses.filter((status) => status === "FAILED").length;
      const success = statuses.filter((status) => status === "SUCCESS").length;
      const done = statuses.length > 0 && failed + success === statuses.length;
      const status = failed > 0
        ? (success > 0 ? "PARTIAL_SUCCESS" : "FAILED")
        : (done ? "SUCCESS" : "RUNNING");
      const job = Object.values(state.jobs || {}).find((row) => String(row.ozonTaskId || row.taskId || row.id) === String(taskId));
      if (job) {
        upsertImportJob(state, {
          ...job,
          status,
          statusResponse: data,
          errorMessage: failed > 0 ? "Ozon 返回部分或全部商品导入失败" : "",
        });
        await saveState(state);
      }
      sendJson(res, 200, {
        ok: true,
        task_id: taskId,
        status,
        done,
        result: data?.result || data,
        raw: data,
        local: false,
      });
    } catch (error) {
      sendJson(res, error?.status || 502, {
        ok: false,
        task_id: taskId,
        status: "FAILED",
        done: true,
        error: error?.message || "Ozon 上架状态查询失败",
        ozon: error?.body || null,
        local: false,
      });
    }
    return;
  }

  const disabledWriteEndpoints = new Map([
    ["/ozon/products/prepare-bundle-items", "门户上架准备"],
    ["/ozon/products/import-from-public", "公开商品上架"],
    ["/ozon/products/follow-from-public", "公开商品跟卖"],
  ]);
  if (req.method === "POST" && url.pathname === "/ozon/products/import/preview") {
    requireAuth(req, state);
    const body = await readBody(req);
    try {
      const result = await previewOzonProductImport(state, req, body);
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, error?.status || 502, {
        ok: false,
        dryRun: true,
        message: error?.message || "Ozon 商品上架预检失败",
        ...(error?.body || {}),
      });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/ozon/products/import") {
    requireAuth(req, state);
    const body = await readBody(req);
    try {
      const result = await createOzonProductImport(state, req, body, "PRODUCT_IMPORT");
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, error?.status || 502, {
        ok: false,
        message: error?.message || "Ozon 商品上架失败",
        ...(error?.body || {}),
      });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/ozon/stocks/import") {
    requireAuth(req, state);
    const body = await readBody(req);
    const store = getRequestStore(state, req, body.storeId);
    const stocks = Array.isArray(body.stocks) ? body.stocks : Array.isArray(body.items) ? body.items : [];
    if (!stocks.length) {
      sendError(res, 400, "缺少库存明细");
      return;
    }
    const jobId = crypto.randomUUID();
    try {
      const data = await ozonCall(store, "/v2/products/stocks", { stocks }, 60000);
      const updatedCache = applyStockChangesToCache(state, store, stocks);
      const job = upsertImportJob(state, {
        id: jobId,
        type: "STOCK_IMPORT",
        status: "SUCCESS",
        storeId: store.id,
        stockCount: stocks.length,
        updatedCache,
        response: data,
        local: false,
      });
      await saveState(state);
      sendJson(res, 200, { ok: true, result: data?.result || data, updatedCache, job: publicImportTask(job), raw: data });
    } catch (error) {
      const job = upsertImportJob(state, {
        id: jobId,
        type: "STOCK_IMPORT",
        status: "FAILED",
        storeId: store.id,
        stockCount: stocks.length,
        errorMessage: error?.message || String(error),
        errorBody: error?.body || null,
        local: false,
      });
      await saveState(state);
      sendJson(res, error?.status || 502, {
        ok: false,
        message: error?.message || "Ozon 库存写入失败",
        job: publicImportTask(job),
        ozon: error?.body || null,
      });
    }
    return;
  }
  if (req.method === "POST" && url.pathname === "/ozon/products/import-by-sku") {
    requireAuth(req, state);
    const body = await readBody(req);
    try {
      const result = await createOzonProductImport(state, req, body, "IMPORT_BY_SKU");
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, error?.status || 502, {
        ok: false,
        message: error?.message || "Ozon SKU 上架失败",
        ...(error?.body || {}),
      });
    }
    return;
  }

  if (req.method === "POST" && disabledWriteEndpoints.has(url.pathname)) {
    requireAuth(req, state);
    localWriteDisabled(res, disabledWriteEndpoints.get(url.pathname));
    return;
  }

  const fleetMatch = url.pathname.match(/^\/ozon\/fleet\/([^/]+)$/);
  if (req.method === "POST" && fleetMatch) {
    requireAuth(req, state);
    sendJson(res, 200, { ok: false, disabled: true, local: true, path: decodeURIComponent(fleetMatch[1]) });
    return;
  }

  if (req.method === "GET" && url.pathname === "/extension/latest") {
    sendJson(res, 200, { version: "0.13.46.1", latestVersion: "0.13.46.1", downloadUrl: "/qh-extension-0.13.46.1.zip" });
    return;
  }

  sendError(res, 404, `未实现的本地接口: ${req.method} ${url.pathname}`, "LOCAL_NOT_FOUND");
}

export { handle };

const server = http.createServer((req, res) => {
  handle(req, res).catch((error) => {
    const status = Number(error?.status || 500);
    sendError(res, status, error?.message || "本地服务异常");
  });
});

if (process.env.QH_LOCAL_NO_LISTEN !== "1") {
  server.listen(port, "127.0.0.1", () => {
    console.log(`QH local API listening on http://127.0.0.1:${port}`);
  });
}
