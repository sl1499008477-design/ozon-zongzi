const moneyFormatters = new Map();

export const dashboardMoney = (value, currencyCode = "CNY") => {
  if (value === null || value === undefined || value === "") return "—";
  const code = String(currencyCode || "").toUpperCase();
  if (!/^[A-Z]{3}$/.test(code) || code === "UNKNOWN") return `${value} ${code || "币种未知"}`;
  if (!moneyFormatters.has(code)) {
    moneyFormatters.set(code, new Intl.NumberFormat("zh-CN", {
      style: "currency",
      currency: code,
      currencyDisplay: "symbol",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }));
  }
  return moneyFormatters.get(code).format(Number(value));
};

const minorToDecimal = (value) => {
  const minor = BigInt(value || "0");
  const negative = minor < 0n;
  const absolute = negative ? -minor : minor;
  return `${negative ? "-" : ""}${absolute / 100n}.${String(absolute % 100n).padStart(2, "0")}`;
};

export const dashboardMinorMoney = (minor, currencyCode) =>
  dashboardMoney(minorToDecimal(minor), currencyCode);

const nonZeroMoneyGroups = (groups = {}) =>
  Object.entries(groups).filter(([, minor]) => BigInt(minor || "0") !== 0n);

export const dashboardMoneyGroups = (groups = {}) => {
  const entries = nonZeroMoneyGroups(groups);
  if (!entries.length) {
    const firstCode = Object.keys(groups)[0];
    return firstCode ? dashboardMinorMoney("0", firstCode) : "—";
  }
  return entries.map(([code, minor]) => dashboardMinorMoney(minor, code)).join(" + ");
};

export const averageMinor = (minor, count) =>
  count > 0 ? (BigInt(minor || "0") + BigInt(Math.floor(count / 2))) / BigInt(count) : 0n;

export const dashboardSummaryMoney = (summary, period = "total") => {
  const field = period === "today" ? "today" : period === "week" ? "week" : "total";
  const groups = Object.values(summary?.gmvByCurrency || {})
    .filter((group) => BigInt(group?.[`${field}Minor`] || "0") !== 0n);
  if (groups.length > 1) {
    return groups.map((group) => dashboardMoney(group[field], group.currencyCode)).join(" + ");
  }
  if (groups.length === 1) return dashboardMoney(groups[0][field], groups[0].currencyCode);
  return dashboardMoney(summary?.[`${field}Gmv`], summary?.currencyCode);
};
