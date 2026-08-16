import {
  formatMinorUnits,
  parseMinorUnits,
  postingMoneyGroups,
} from "../shared/order-money.mjs";

export { formatMinorUnits, parseMinorUnits };

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
    for (const [currencyCode, minorText] of Object.entries(postingMoneyGroups(posting, options))) {
      const minor = BigInt(minorText);
      const group = groups[currencyCode] || {
        currencyCode,
        totalMinorValue: 0n,
        todayMinorValue: 0n,
        weekMinorValue: 0n,
      };
      group.totalMinorValue += minor;
      if (day === todayKey) group.todayMinorValue += minor;
      if (weekKeys.has(day)) group.weekMinorValue += minor;
      groups[currencyCode] = group;
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
