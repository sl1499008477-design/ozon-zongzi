const text = (value) => value === null || value === undefined
  ? ""
  : String(value).trim();

const firstText = (...values) => {
  for (const value of values) {
    const normalized = text(value);
    if (normalized) return normalized;
  }
  return "";
};

const currencyCode = (value) => {
  const code = text(value).toUpperCase();
  return /^[A-Z]{3}$/.test(code) ? code : "";
};

export const collectPriceCurrencyCode = (record = {}) => [
  record?.currencyCode, record?.currency_code, record?.priceCurrency,
  record?.price_currency, record?.currency,
  record?.price?.currency_code, record?.price?.currencyCode, record?.price?.currency,
].map(currencyCode).find(Boolean) || "";

export function formatCollectSourcePrice(record = {}, fallback = {}) {
  const amount = firstText(
    record.price && typeof record.price === "object" ? record.price.price : record.price,
    record.priceText, record.marketingPrice, record.marketing_price, record.sellPrice,
  );
  if (!amount) return "—";
  const currency = collectPriceCurrencyCode(record) || collectPriceCurrencyCode(fallback);
  return currency ? `${amount} ${currency}` : `${amount}（币种未知）`;
}

const moneyNumber = (value) => {
  const normalized = text(value)
    .replace(/[^\d,.-]/g, "")
    .replace(",", ".");
  const number = Number.parseFloat(normalized);
  return Number.isFinite(number) ? number : null;
};

const derivedOldPrice = (value) => {
  const number = moneyNumber(value);
  if (!number || number <= 0) return "";
  const minorUnits = Math.round(number * 100);
  return (Math.round(minorUnits * 1.25) / 100).toFixed(2);
};

export function normalizeCollectEditVariantRow({
  variant = {},
  index = 0,
  rowCount = 1,
  fallbackSku = "",
  fallbackTitle = "",
  fallbackPrice = "",
  offerPrefix = "jz-",
  aspectName = "",
  targetCurrencyCode,
  sourceVariant = variant,
  sourceCurrencyCode = "",
  draftVariant = {},
  draftCurrencyCode = "",
} = {}) {
  const sku = firstText(
    variant.sku,
    variant.variant_id,
    variant.product_id,
    variant.productId,
    fallbackSku,
  );
  const generatedOfferId = `${text(offerPrefix) || "jz-"}${sku}${rowCount > 1 ? `-${String(index + 1).padStart(2, "0")}` : ""}`;
  let quote = variant;
  if (targetCurrencyCode !== undefined) {
    const target = currencyCode(targetCurrencyCode);
    const savedCurrency = collectPriceCurrencyCode(draftVariant) || currencyCode(draftCurrencyCode);
    const sourceCurrency = collectPriceCurrencyCode(sourceVariant) || currencyCode(sourceCurrencyCode);
    const hasSavedPrice = ["sellPrice", "price", "priceText", "marketingPrice", "marketing_price"]
      .some((key) => Object.hasOwn(draftVariant, key));
    quote = target && savedCurrency === target && hasSavedPrice ? draftVariant
      : target && sourceCurrency === target ? sourceVariant : {};
  }
  const sourcePrice = quote.price && typeof quote.price === "object" ? quote.price.price : quote.price;
  // A cleared target quote must stay empty, including when a legacy source price remains on the row.
  const sellPrice = targetCurrencyCode !== undefined && Object.hasOwn(quote, "sellPrice")
    ? text(quote.sellPrice)
    : firstText(quote.sellPrice, sourcePrice, quote.priceText, quote.marketingPrice,
      quote.marketing_price, targetCurrencyCode === undefined ? fallbackPrice : "");
  const baseName = firstText(
    variant.name,
    variant.title,
    variant.productName,
    variant.product_name,
    fallbackTitle,
  );
  const normalizedAspectName = text(aspectName);
  const name = normalizedAspectName
    && !baseName.toLocaleLowerCase("ru-RU").includes(normalizedAspectName.toLocaleLowerCase("ru-RU"))
    ? [baseName, normalizedAspectName].filter(Boolean).join(" / ")
    : baseName;

  return {
    sku,
    offerId: firstText(variant.offerId, variant.offer_id, generatedOfferId),
    name,
    sellPrice,
    oldPrice: sellPrice || targetCurrencyCode === undefined ? firstText(
      quote.oldPrice,
      quote.old_price,
      quote.price && typeof quote.price === "object" ? quote.price.old_price : "",
      derivedOldPrice(sellPrice),
    ) : "",
    stock: firstText(variant.stock, variant.quantity, variant.stocks?.present, "0"),
  };
}
