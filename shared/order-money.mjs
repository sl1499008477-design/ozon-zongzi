function normalizedDecimalText(value) {
  if (value === null || value === undefined || value === "") return "";
  let text = String(value).trim().replace(/\s+/g, "");
  if (!text) return "";
  if (text.includes(".") && text.includes(",")) text = text.replace(/,/g, "");
  else if (!text.includes(".") && text.includes(",")) text = text.replace(",", ".");
  return text;
}

export function parseMinorUnits(value, scale = 2) {
  const match = normalizedDecimalText(value).match(/^([+-]?)(\d+)(?:\.(\d*))?$/);
  if (!match) return null;
  const sign = match[1] === "-" ? -1n : 1n;
  const factor = 10n ** BigInt(scale);
  const fraction = match[3] || "";
  const kept = fraction.slice(0, scale).padEnd(scale, "0");
  const roundingDigit = Number(fraction[scale] || "0");
  return sign * (
    BigInt(match[2]) * factor
    + BigInt(kept || "0")
    + (roundingDigit >= 5 ? 1n : 0n)
  );
}

export function formatMinorUnits(value, scale = 2) {
  const units = typeof value === "bigint" ? value : BigInt(value || 0);
  const negative = units < 0n;
  const absolute = negative ? -units : units;
  const factor = 10n ** BigInt(scale);
  const whole = absolute / factor;
  const fraction = String(absolute % factor).padStart(scale, "0");
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

function currencyCode(value) {
  const normalized = String(value || "").trim().toUpperCase();
  return /^[A-Z]{3}$/.test(normalized) ? normalized : "";
}

function mappedStoreCurrency(posting, currencyByStoreId) {
  const storeId = String(posting.storeId || posting.store_id || "");
  if (!storeId) return "";
  const value = currencyByStoreId instanceof Map
    ? currencyByStoreId.get(storeId)
    : currencyByStoreId?.[storeId];
  return currencyCode(value);
}

export function resolvePostingCurrencyCode(posting = {}, options = {}) {
  return currencyCode(
    posting.currency_code
    || posting.currencyCode
    || posting.currency
    || posting.financial_data?.currency_code
    || posting.financial_data?.currencyCode,
  )
    || mappedStoreCurrency(posting, options.currencyByStoreId)
    || currencyCode(options.fallbackCurrencyCode)
    || "UNKNOWN";
}

function addMinor(groups, code, minor) {
  groups[code] = String(BigInt(groups[code] || "0") + minor);
}

export function postingMoneyGroups(posting = {}, options = {}) {
  const groups = {};
  const financialProducts = Array.isArray(posting.financial_data?.products)
    ? posting.financial_data.products
    : [];
  for (const product of financialProducts) {
    const minor = parseMinorUnits(product.price);
    if (minor === null) continue;
    addMinor(
      groups,
      currencyCode(product.currency_code || product.currencyCode || product.currency)
        || resolvePostingCurrencyCode(posting, options),
      minor,
    );
  }
  if (Object.keys(groups).length) return groups;

  for (const product of Array.isArray(posting.products) ? posting.products : []) {
    const minor = parseMinorUnits(product.price);
    if (minor === null) continue;
    const quantity = BigInt(Math.max(0, Math.trunc(Number(product.quantity) || 1)));
    addMinor(
      groups,
      currencyCode(product.currency_code || product.currencyCode || product.currency)
        || resolvePostingCurrencyCode(posting, options),
      minor * quantity,
    );
  }
  if (Object.keys(groups).length) return groups;

  const minor = parseMinorUnits(posting.order_price ?? posting.total_price ?? posting.price);
  if (minor !== null) addMinor(groups, resolvePostingCurrencyCode(posting, options), minor);
  return groups;
}

export function summarizePostingMoney(postings = [], options = {}) {
  const byCurrency = {};
  for (const posting of Array.isArray(postings) ? postings : []) {
    for (const [code, minor] of Object.entries(postingMoneyGroups(posting, options))) {
      addMinor(byCurrency, code, BigInt(minor));
    }
  }
  const currencyCodes = Object.keys(byCurrency).sort();
  return {
    byCurrency: Object.fromEntries(currencyCodes.map((code) => [code, byCurrency[code]])),
    currencyCodes,
    singleCurrency: currencyCodes.length <= 1,
  };
}
