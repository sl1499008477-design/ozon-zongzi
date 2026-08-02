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
} = {}) {
  const sku = firstText(
    variant.sku,
    variant.variant_id,
    variant.product_id,
    variant.productId,
    fallbackSku,
  );
  const generatedOfferId = `${text(offerPrefix) || "jz-"}${sku}${rowCount > 1 ? `-${String(index + 1).padStart(2, "0")}` : ""}`;
  const sourcePrice = variant.price && typeof variant.price === "object"
    ? variant.price.price
    : variant.price;
  const sellPrice = firstText(
    variant.sellPrice,
    sourcePrice,
    variant.priceText,
    variant.marketingPrice,
    variant.marketing_price,
    fallbackPrice,
  );
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
    oldPrice: firstText(
      variant.oldPrice,
      variant.old_price,
      variant.price && typeof variant.price === "object" ? variant.price.old_price : "",
      derivedOldPrice(sellPrice),
    ),
    stock: firstText(variant.stock, variant.quantity, variant.stocks?.present, "0"),
  };
}
