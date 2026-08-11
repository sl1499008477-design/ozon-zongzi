const SUPPORTED_CURRENCIES = new Set(["RUB", "CNY"]);

const currencyError = (code) => {
  const error = new Error(code);
  error.code = code;
  return error;
};

export function normalizeAutoListingCurrency(value) {
  if (typeof value !== "string") return null;
  const currency = value.trim();
  return SUPPORTED_CURRENCIES.has(currency) ? currency : null;
}

export function resolveAutoListingPriceCurrency({
  sourceCurrency,
  targetStoreCurrency,
  sourceTargetStoreId,
  targetStoreId,
} = {}) {
  const targetCurrency = normalizeAutoListingCurrency(targetStoreCurrency);
  if (!targetCurrency) throw currencyError("AUTO_LISTING_TARGET_STORE_CURRENCY_UNSUPPORTED");

  const hasSourceCurrency = sourceCurrency !== undefined
    && sourceCurrency !== null
    && sourceCurrency !== "";
  if (hasSourceCurrency) {
    const currency = normalizeAutoListingCurrency(sourceCurrency);
    if (!currency) throw currencyError("AUTO_LISTING_SOURCE_CURRENCY_UNSUPPORTED");
    if (currency !== targetCurrency) throw currencyError("AUTO_LISTING_SOURCE_CURRENCY_MISMATCH");
    return Object.freeze({ currency, currencySource: "SOURCE" });
  }

  if (typeof sourceTargetStoreId !== "string" || sourceTargetStoreId.trim() !== targetStoreId) {
    throw currencyError("AUTO_LISTING_SOURCE_CURRENCY_UNSUPPORTED");
  }
  return Object.freeze({ currency: targetCurrency, currencySource: "TARGET_STORE" });
}
