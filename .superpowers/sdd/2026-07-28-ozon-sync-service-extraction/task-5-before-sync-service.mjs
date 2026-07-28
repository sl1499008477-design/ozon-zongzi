import crypto from "node:crypto";
import { storesForAccount } from "./account-context.mjs";
import { callOzonSellerApi } from "./ozon-client.mjs";

const cleanText = (value, maxLength = 160) =>
  String(value ?? "").trim().slice(0, maxLength);

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

export function createOzonSyncService({
  loadState,
  saveState,
  now = () => new Date(),
  createJobId = () => crypto.randomUUID(),
  logger = console,
}) {
  const nowIso = () => now().toISOString();

  async function syncStoreProfile(state, store) {
    const response = await callOzonSellerApi(store, "/v1/seller/info", {});
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
    store.profileSyncedAt = nowIso();
    store.updatedAt = store.profileSyncedAt;
    return profile;
  }

  async function refreshStoreProfiles(state, { accountId, storeId = "" }) {
    const accountStores = storesForAccount(state, accountId);
    const targets = storeId
      ? accountStores.filter((store) => String(store.id) === String(storeId))
      : accountStores;
    if (storeId && !targets.length) {
      const error = new Error("门店不存在");
      error.status = 404;
      error.code = "STORE_NOT_FOUND";
      throw error;
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

  async function runLocalSync() {
    const error = new Error("Ozon 本地同步尚未迁移到服务");
    error.status = 501;
    error.code = "OZON_SYNC_UNSUPPORTED";
    throw error;
  }

  return {
    syncStoreProfile,
    refreshStoreProfiles,
    runLocalSync,
  };
}
