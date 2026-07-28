function normalizedDecimalText(value) {
  if (value === null || value === undefined || value === "") return "";
  let text = String(value).trim().replace(/\s+/g, "");
  if (!text) return "";
  if (text.includes(".") && text.includes(",")) text = text.replace(/,/g, "");
  else if (!text.includes(".") && text.includes(",")) text = text.replace(",", ".");
  return text;
}

export function parseMinorUnits(value, scale = 2) {
  const text = normalizedDecimalText(value);
  const match = text.match(/^([+-]?)(\d+)(?:\.(\d*))?$/);
  if (!match) return null;
  const sign = match[1] === "-" ? -1n : 1n;
  const whole = BigInt(match[2]);
  const fraction = match[3] || "";
  const factor = 10n ** BigInt(scale);
  const kept = fraction.slice(0, scale).padEnd(scale, "0");
  const roundingDigit = Number(fraction[scale] || "0");
  const absolute = whole * factor + BigInt(kept || "0") + (roundingDigit >= 5 ? 1n : 0n);
  return sign * absolute;
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
  return /^[A-Z]{3}$/.test(normalized) ? normalized : "UNKNOWN";
}

function postingCurrency(posting = {}) {
  return currencyCode(
    posting.currency_code
    || posting.currencyCode
    || posting.currency
    || posting.financial_data?.currency_code
    || posting.financial_data?.currencyCode,
  );
}

function postingMoneyRows(posting = {}) {
  const products = Array.isArray(posting.financial_data?.products)
    ? posting.financial_data.products
    : [];
  const productRows = products.map((item) => {
    const minor = parseMinorUnits(item.price);
    if (minor === null) return null;
    return {
      currencyCode: currencyCode(
        item.currency_code
        || item.currencyCode
        || item.currency
        || postingCurrency(posting),
      ),
      minor,
    };
  }).filter(Boolean);
  if (productRows.length) return productRows;
  const minor = parseMinorUnits(posting.order_price ?? posting.total_price ?? posting.price);
  return minor === null ? [] : [{ currencyCode: postingCurrency(posting), minor }];
}

function periodValue(groups, field) {
  const nonZero = Object.values(groups).filter((group) => group[field] !== 0n);
  return nonZero.length === 1 ? formatMinorUnits(nonZero[0][field]) : null;
}

export function summarizeOrderMoney(postings = [], options = {}) {
  const dateKey = options.dateKey || ((value) => String(value || "").slice(0, 10));
  const todayKey = String(options.todayKey || "");
  const weekKeys = options.weekKeys instanceof Set ? options.weekKeys : new Set();
  const groups = {};

  for (const posting of Array.isArray(postings) ? postings : []) {
    const day = dateKey(
      posting.in_process_at
      || posting.created_at
      || posting.shipment_date
      || posting.delivering_date
      || posting.syncedAt,
    );
    for (const row of postingMoneyRows(posting)) {
      const group = groups[row.currencyCode] || {
        currencyCode: row.currencyCode,
        totalMinorValue: 0n,
        todayMinorValue: 0n,
        weekMinorValue: 0n,
      };
      group.totalMinorValue += row.minor;
      if (day === todayKey) group.todayMinorValue += row.minor;
      if (weekKeys.has(day)) group.weekMinorValue += row.minor;
      groups[row.currencyCode] = group;
    }
  }

  const currencyCodes = Object.keys(groups).sort();
  const gmvByCurrency = Object.fromEntries(currencyCodes.map((code) => {
    const group = groups[code];
    return [code, {
      currencyCode: code,
      totalMinor: String(group.totalMinorValue),
      total: formatMinorUnits(group.totalMinorValue),
      todayMinor: String(group.todayMinorValue),
      today: formatMinorUnits(group.todayMinorValue),
      weekMinor: String(group.weekMinorValue),
      week: formatMinorUnits(group.weekMinorValue),
    }];
  }));
  const mixedCurrencies = currencyCodes.length > 1;
  return {
    currencyCodes,
    currencyCode: currencyCodes.length === 1 ? currencyCodes[0] : "",
    mixedCurrencies,
    gmvByCurrency,
    totalGmv: periodValue(groups, "totalMinorValue"),
    todayGmv: periodValue(groups, "todayMinorValue"),
    weekGmv: periodValue(groups, "weekMinorValue"),
  };
}
