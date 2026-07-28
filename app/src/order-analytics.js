import {
  postingMoneyGroups,
  summarizePostingMoney,
} from "./order-money.js";

const localDayFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const localHourFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Shanghai",
  hour: "2-digit",
  hour12: false,
});

export const localDayKey = (value = new Date()) => {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return localDayFormatter.format(date);
};

export const dayLabel = (key) => key ? key.slice(5) : "—";

export const postingBusinessDate = (posting = {}) =>
  posting.in_process_at
  || posting.created_at
  || posting.shipment_date
  || posting.delivering_date
  || posting.syncedAt;

const mergeMoneyGroups = (target, source) => {
  Object.entries(source || {}).forEach(([code, minor]) => {
    target[code] = String(BigInt(target[code] || "0") + BigInt(minor || "0"));
  });
  return target;
};

const incrementMap = (map, key, value = 1) => {
  if (!key) return;
  map.set(key, (map.get(key) || 0) + value);
};

const topEntries = (map, limit = 5) =>
  [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([label, value]) => ({ label, value }));

export const dataScreenModel = (postings = [], range = "30天", now = new Date()) => {
  const rangeDays = Number.parseInt(range, 10) || 30;
  const dayMs = 24 * 60 * 60 * 1000;
  const days = Array.from({ length: rangeDays }, (_, index) => {
    const date = new Date(now.getTime() - (rangeDays - 1 - index) * dayMs);
    const key = localDayKey(date);
    return { key, label: dayLabel(key), count: 0, amountMinor: 0, amountByCurrency: {} };
  });
  const dayMap = new Map(days.map((day) => [day.key, day]));
  const today = localDayKey(now);
  const statusMap = new Map();
  const channelMap = new Map();
  const hourBuckets = Array.from({ length: 8 }, (_, index) => ({
    label: `${index * 3}时`,
    count: 0,
  }));
  const hotProductMap = new Map();

  postings.forEach((posting) => {
    const businessDate = postingBusinessDate(posting);
    const dayRow = dayMap.get(localDayKey(businessDate));
    if (!dayRow) return;
    dayRow.count += 1;
    mergeMoneyGroups(dayRow.amountByCurrency, postingMoneyGroups(posting));
    incrementMap(statusMap, String(posting.status || "unknown").toLowerCase());
    incrementMap(
      channelMap,
      posting.delivery_method?.tpl_provider
        || posting.delivery_method?.warehouse
        || posting.delivery_method?.name
        || "未识别渠道",
    );
    if (dayRow.key === today) {
      const hour = Number(localHourFormatter.format(new Date(businessDate))) || 0;
      hourBuckets[Math.min(7, Math.floor(hour / 3))].count += 1;
      (posting.products || []).forEach((product) => {
        incrementMap(
          hotProductMap,
          product.name || product.offer_id || product.sku || "未命名商品",
          Number(product.quantity) || 1,
        );
      });
    }
  });

  const latestOrders = [...postings]
    .filter((posting) => dayMap.has(localDayKey(postingBusinessDate(posting))))
    .sort((left, right) =>
      new Date(postingBusinessDate(right)).getTime() - new Date(postingBusinessDate(left)).getTime()
    )
    .slice(0, 5)
    .map((posting) => ({
      id: posting.posting_number || posting.order_id || posting.id,
      status: posting.status || "—",
      amountByCurrency: postingMoneyGroups(posting),
      time: postingBusinessDate(posting),
    }));

  const rangeMoney = days.reduce(
    (groups, day) => mergeMoneyGroups(groups, day.amountByCurrency),
    {},
  );
  const rangeCurrencyCodes = Object.keys(rangeMoney).sort();
  const moneyComparable = rangeCurrencyCodes.length <= 1;
  const currencyCode = rangeCurrencyCodes[0] || "";
  if (moneyComparable && currencyCode) {
    days.forEach((day) => {
      day.amountMinor = Number(BigInt(day.amountByCurrency[currencyCode] || "0"));
    });
  }

  return {
    days,
    statusRows: topEntries(statusMap, 6),
    channelRows: topEntries(channelMap, 5),
    hourBuckets,
    hotProducts: topEntries(hotProductMap, 5),
    latestOrders,
    rangeMoney,
    moneyComparable,
    currencyCode,
    maxCount: Math.max(1, ...days.map((day) => day.count)),
    maxAmountMinor: Math.max(1, ...days.map((day) => day.amountMinor)),
    maxHour: Math.max(1, ...hourBuckets.map((hour) => hour.count)),
  };
};

const profitRangeDays = {
  "7 天": 7,
  "30 天": 30,
  "90 天": 90,
  "180 天": 180,
};

const formatIsoDate = (value) => {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

export function profitDateRange(range, now = new Date()) {
  const days = profitRangeDays[range] || 30;
  const end = new Date(now);
  const start = new Date(end);
  start.setDate(end.getDate() - days + 1);
  return {
    days,
    label: `${formatIsoDate(start)} 至 ${formatIsoDate(end)}`,
    start,
    end,
  };
}

export const profitTrendModel = (postings = [], range = "30 天", now = new Date()) => {
  const { days } = profitDateRange(range, now);
  const dayMs = 24 * 60 * 60 * 1000;
  const rows = Array.from({ length: days }, (_, index) => {
    const date = new Date(now.getTime() - (days - 1 - index) * dayMs);
    const key = localDayKey(date);
    return { key, count: 0, amountMinor: 0, amountByCurrency: {} };
  });
  const rowMap = new Map(rows.map((row) => [row.key, row]));

  postings.forEach((posting) => {
    const row = rowMap.get(localDayKey(postingBusinessDate(posting)));
    if (!row) return;
    row.count += 1;
    mergeMoneyGroups(row.amountByCurrency, postingMoneyGroups(posting));
  });

  const inRange = postings.filter((posting) => rowMap.has(localDayKey(postingBusinessDate(posting))));
  const moneySummary = summarizePostingMoney(inRange);
  const currencyCode = moneySummary.currencyCodes[0] || "";
  const moneyComparable = moneySummary.currencyCodes.length <= 1;
  if (moneyComparable && currencyCode) {
    rows.forEach((row) => {
      row.amountMinor = Number(BigInt(row.amountByCurrency[currencyCode] || "0"));
    });
  }
  const activeRows = rows.filter((row) => row.count > 0);
  const totalOrders = activeRows.reduce((sum, row) => sum + row.count, 0);
  const totalAmountMinor = currencyCode ? Number(BigInt(moneySummary.byCurrency[currencyCode] || "0")) : 0;
  const bestDay = moneyComparable
    ? activeRows.reduce(
        (best, row) => (!best || row.amountMinor > best.amountMinor ? row : best),
        null,
      )
    : null;

  return {
    rows: rows.slice().reverse(),
    chartRows: rows,
    activeDays: activeRows.length,
    blankDays: days - activeRows.length,
    totalOrders,
    totalAmountMinor,
    totalByCurrency: moneySummary.byCurrency,
    moneyComparable,
    currencyCode,
    bestDay,
    maxAmountMinor: Math.max(1, ...rows.map((row) => row.amountMinor)),
    maxCount: Math.max(1, ...rows.map((row) => row.count)),
  };
};
