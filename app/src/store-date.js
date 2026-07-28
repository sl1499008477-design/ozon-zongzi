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

const addDaysDateOnly = (value, days) => {
  const dateOnly = dateInputValue(value);
  if (!dateOnly) return "";
  const [year, month, day] = dateOnly.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
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

const apiKeyCreatedDateForStore = (store = {}) => dateInputValue(
  store.apiKeyCreatedAt
  || store.apiKeyCreated_at
  || store.savedAt
  || store.createdAt
  || store.updatedAt
  || store.updated_at,
);

export const displayApiKeyDeadline = (store = {}) => {
  const explicitCreatedAt = dateInputValue(store.apiKeyCreatedAt || store.apiKeyCreated_at);
  const createdAt = explicitCreatedAt || apiKeyCreatedDateForStore(store);
  const deadline = createdAt
    ? addDaysDateOnly(createdAt, 180)
    : dateInputValue(store.apiKeyExpiresAt || store.apiKeyExpires_at);
  if (!deadline) return "未设置";
  const days = daysUntilDateOnly(deadline);
  if (days === null) return deadline;
  const suffix = createdAt && !explicitCreatedAt ? "（按新增日）" : "";
  return days >= 0
    ? `${deadline} · 剩 ${days} 天${suffix}`
    : `${deadline} · 已过期 ${Math.abs(days)} 天${suffix}`;
};
