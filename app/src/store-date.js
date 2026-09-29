const localDayFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export const localDayKey = (value = new Date()) => {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return localDayFormatter.format(date);
};

export const dateInputValue = (value) => {
  if (!value) return "";
  const text = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return "";
  return parsed.toISOString().slice(0, 10);
};

export const todayDateOnly = () => {
  const now = new Date();
  return new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())).toISOString().slice(0, 10);
};

const daysUntilDateOnly = (value) => {
  const dateOnly = dateInputValue(value);
  if (!dateOnly) return null;
  const [year, month, day] = dateOnly.split("-").map(Number);
  const target = Date.UTC(year, month - 1, day);
  const now = new Date();
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.ceil((target - today) / 86400000);
};

export const displayApiKeyDeadline = (store = {}) => {
  const deadline = dateInputValue(store.apiKeyExpiresAt || store.apiKeyExpires_at);
  if (!deadline) return "未知";
  const days = daysUntilDateOnly(deadline);
  if (days === null) return deadline;
  return days >= 0 ? `${deadline} · 剩 ${days} 天` : `${deadline} · 已过期 ${Math.abs(days)} 天`;
};
