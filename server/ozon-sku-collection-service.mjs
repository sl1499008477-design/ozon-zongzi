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
    throw stableError("OZON_SKU_INVALID");
  }
  return sku;
}

function requireAccount(account) {
  if (!account || typeof account !== "object" || Array.isArray(account)
    || typeof account.id !== "string" || !account.id.trim()) {
    throw stableError("OZON_SKU_ACCOUNT_REQUIRED");
  }
  return account;
}

function successfulItem({ sku, detail, now }) {
  const images = Array.isArray(detail.images) ? detail.images : [];
  const variants = Array.isArray(detail.variants) ? detail.variants : [];
  return {
    sku,
    productUrl: detail.url || `https://www.ozon.ru/product/test-${sku}/`,
    name: detail.title,
    price: detail.price || detail.priceText || "",
    priceText: detail.priceText || "",
    image: detail.primaryImage || images[0] || "",
    images,
    variants,
    variantData: variants.length ? { variants } : undefined,
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

function fallbackItem(sku) {
  return {
    sku,
    name: `SKU ${sku}`,
    source: "SKU 添加（抓取失败）",
    status: "待处理",
    raw: { sku, error: "scrape_failed" },
  };
}

export function createOzonSkuCollectionService({
  scrapeProductDetail,
  normalizeItem,
  saveItem,
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
      let detail;
      try {
        detail = await scrapeProductDetail(sku);
      } catch {
        throw stableError("OZON_SKU_COLLECTION_FAILED");
      }

      const scraped = Boolean(detail && typeof detail === "object" && String(detail.title || "").trim());
      try {
        const normalized = normalizeItem(scraped
          ? successfulItem({ sku, detail, now })
          : fallbackItem(sku));
        if (!normalized || typeof normalized !== "object" || Array.isArray(normalized)) {
          throw stableError("OZON_SKU_COLLECTION_FAILED");
        }
        const saved = await saveItem(normalized, { account });
        if (!saved?.item || typeof saved.item !== "object" || Array.isArray(saved.item)) {
          throw stableError("OZON_SKU_COLLECTION_FAILED");
        }
        return Object.freeze({
          item: saved.item,
          scraped,
          ...(scraped ? {} : { code: "OZON_SKU_SCRAPE_EMPTY" }),
        });
      } catch (caught) {
        if (caught?.code === "OZON_SKU_COLLECTION_FAILED") throw caught;
        throw stableError("OZON_SKU_COLLECTION_FAILED");
      }
    },
  });
}
