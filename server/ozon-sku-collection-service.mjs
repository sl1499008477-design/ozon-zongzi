const SKU_MAX_LENGTH = 160;

function stableError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function normalizeSku(value) {
  const sku = typeof value === "string" || typeof value === "number"
    ? String(value).trim()
    : "";
  if (!sku || sku.length > SKU_MAX_LENGTH || /[\u0000-\u001f\u007f]/u.test(sku)) {
    throw stableError("ZONGZI_SKU_INVALID");
  }
  return sku;
}

function requireAccount(account) {
  if (!account || typeof account !== "object" || Array.isArray(account)
    || typeof account.id !== "string" || !account.id.trim()) {
    throw stableError("ZONGZI_SKU_ACCOUNT_REQUIRED");
  }
  return account;
}

function optionalTargetStoreId(value) {
  if (value === null || value === undefined || value === "") return "";
  const targetStoreId = typeof value === "string" ? value.trim() : "";
  if (!targetStoreId || targetStoreId.length > 240
    || /[/\\\u0000-\u001f\u007f]/u.test(targetStoreId)) {
    throw stableError("ZONGZI_SKU_TARGET_STORE_INVALID");
  }
  return targetStoreId;
}

function publicProductIdFromSku(sku) {
  if (!/^\d+$/u.test(sku)) return null;
  const value = Number(sku);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function publicTypeName(sourceCharacteristics) {
  for (const characteristic of sourceCharacteristics) {
    const name = typeof characteristic?.name === "string"
      ? characteristic.name.replace(/\s+/gu, " ").trim().toLocaleLowerCase("ru-RU")
      : "";
    const value = typeof characteristic?.value === "string"
      ? characteristic.value.replace(/\s+/gu, " ").trim()
      : "";
    if (name === "тип" && value && value.length <= 240
      && !/[\u0000-\u001f\u007f]/u.test(value)) return value;
  }
  return "";
}

function localizedAmount(value) {
  if (!(typeof value === "string" || (typeof value === "number" && Number.isFinite(value)))) return null;
  const original = String(value).trim();
  if (!original) return null;
  const currency = /(?:¥|\bCNY\b)/iu.test(original)
    ? "CNY"
    : /(?:₽|\bRUB\b|руб)/iu.test(original) ? "RUB" : "";
  let numeric = original.replace(/[^0-9.,'’\s\u00a0\u2007\u202f]/gu, "")
    .replace(/['’\s\u00a0\u2007\u202f]/gu, "");
  if (!numeric) return null;
  const comma = numeric.lastIndexOf(",");
  const dot = numeric.lastIndexOf(".");
  const separator = Math.max(comma, dot);
  if (separator >= 0) {
    const fractionalDigits = numeric.length - separator - 1;
    if (fractionalDigits >= 1 && fractionalDigits <= 2) {
      numeric = `${numeric.slice(0, separator).replace(/[.,]/gu, "")}.${numeric.slice(separator + 1)}`;
    } else {
      numeric = numeric.replace(/[.,]/gu, "");
    }
  }
  if (!/^[0-9]+(?:\.[0-9]{1,2})?$/u.test(numeric)) return null;
  const [whole, fraction] = numeric.split(".");
  return {
    amount: `${whole.replace(/^0+(?=\d)/u, "") || "0"}${fraction === undefined ? "" : `.${fraction}`}`,
    currency,
    original,
  };
}

export function normalizeOzonPublicVariants(value) {
  if (!Array.isArray(value)) return [];
  return value.map((variant) => {
    if (!variant || typeof variant !== "object" || Array.isArray(variant)) return variant;
    const normalized = { ...variant };
    const price = localizedAmount(variant.price ?? variant.priceText);
    if (price) {
      normalized.price = price.amount;
      normalized.priceText = typeof variant.priceText === "string" && variant.priceText.trim()
        ? variant.priceText : price.original;
      if (!normalized.currency && !normalized.currencyCode && !normalized.currency_code && price.currency) {
        normalized.currency = price.currency;
      }
    }
    if (!Array.isArray(normalized.images) && !Array.isArray(normalized.media)) {
      const image = [variant.image, variant.coverImage]
        .find((candidate) => typeof candidate === "string" && candidate.trim());
      if (image) normalized.images = [image.trim()];
    }
    return normalized;
  });
}

function successfulItem({ sku, detail, now }) {
  const images = Array.isArray(detail.images) ? detail.images : [];
  const variants = normalizeOzonPublicVariants(detail.variants);
  const sourceCharacteristics = Array.isArray(detail.sourceCharacteristics)
    ? detail.sourceCharacteristics
    : [];
  const ozonProductId = publicProductIdFromSku(sku);
  const typeName = publicTypeName(sourceCharacteristics);
  return {
    sku,
    ...(ozonProductId ? { ozonProductId } : {}),
    productUrl: detail.url || `https://www.ozon.ru/product/test-${sku}/`,
    name: detail.title,
    price: detail.price || detail.priceText || "",
    priceText: detail.priceText || "",
    image: detail.primaryImage || images[0] || "",
    images,
    variants,
    variantData: variants.length ? { variants } : undefined,
    ...(sourceCharacteristics.length ? { sourceCharacteristics } : {}),
    ...(typeName ? { sourceCategory: { typeName } } : {}),
    seller: detail.sellerName || "",
    sellerLink: detail.sellerLink || "",
    brand: detail.brand || "",
    category: (Array.isArray(detail.categories) ? detail.categories : []).join(" / "),
    rating: detail.rating || null,
    reviewCount: detail.reviewCount || null,
    source: "SKU 抓取",
    status: "已采集",
    raw: { sku, scrapedAt: now() },
  };
}

export function createOzonSkuCollectionService({
  scrapeProductDetail,
  normalizeItem,
  saveItem,
  findExisting = async () => null,
  now = () => new Date().toISOString(),
} = {}) {
  if (typeof scrapeProductDetail !== "function" || typeof normalizeItem !== "function"
    || typeof saveItem !== "function" || typeof now !== "function") {
    throw new TypeError("Ozon SKU collection dependencies are required");
  }

  return Object.freeze({
    async collectOzonSkuForAccount(input = {}) {
      const account = requireAccount(input.account);
      const sku = normalizeSku(input.sku);
      const targetStoreId = optionalTargetStoreId(input.targetStoreId);
      const existing = await findExisting({accountId:account.id,sku});
      const failedPlaceholder = existing?.collectionState !== "LISTED" && existing?.raw?.error === "scrape_failed"
        && !existing.enrichment && !existing.image && !existing.images?.length && !existing.listingDraft?.images?.length;
      if (failedPlaceholder) throw stableError("ZONGZI_SKU_SCRAPE_EMPTY");
      if (existing) return {item:existing,scraped:false,duplicate:true,code:"COLLECT_SKU_ALREADY_EXISTS"};
      let detail;
      try {
        detail = await scrapeProductDetail(sku);
      } catch {
        throw stableError("ZONGZI_SKU_COLLECTION_FAILED");
      }

      const scraped = Boolean(detail && typeof detail === "object" && String(detail.title || "").trim());
      if (!scraped) throw stableError("ZONGZI_SKU_SCRAPE_EMPTY");
      try {
        const normalized = normalizeItem(successfulItem({ sku, detail, now }));
        if (!normalized || typeof normalized !== "object" || Array.isArray(normalized)) {
          throw stableError("ZONGZI_SKU_COLLECTION_FAILED");
        }
        const saved = await saveItem(normalized, {
          account,
          ...(targetStoreId ? { targetStoreId } : {}),
        });
        if (!saved?.item || typeof saved.item !== "object" || Array.isArray(saved.item)) {
          throw stableError("ZONGZI_SKU_COLLECTION_FAILED");
        }
        return Object.freeze({
          item: saved.item,
          scraped,
          ...(scraped ? {} : { code: "ZONGZI_SKU_SCRAPE_EMPTY" }),
        });
      } catch (caught) {
        if (caught?.code === "ZONGZI_SKU_COLLECTION_FAILED") throw caught;
        throw stableError("ZONGZI_SKU_COLLECTION_FAILED");
      }
    },
  });
}
