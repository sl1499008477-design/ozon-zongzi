export const PERMISSIONS = Object.freeze({
  ACCOUNT_MANAGE: "account.manage",
  PRICING_MANAGE: "pricing.manage",
  ANNOUNCEMENT_MANAGE: "announcement.manage",
  AI_CONTENT_MANAGE: "ai-content.manage",
  TENANT_OPERATE: "tenant.operate",
});

export const permissionMatrix = Object.freeze({
  [PERMISSIONS.ACCOUNT_MANAGE]: Object.freeze({
    roles: Object.freeze(["admin"]),
    scope: "GLOBAL_ADMIN",
    label: "账号管理",
  }),
  [PERMISSIONS.PRICING_MANAGE]: Object.freeze({
    roles: Object.freeze(["admin"]),
    scope: "GLOBAL_ADMIN",
    label: "算价配置管理",
  }),
  [PERMISSIONS.ANNOUNCEMENT_MANAGE]: Object.freeze({
    roles: Object.freeze(["admin"]),
    scope: "GLOBAL_ADMIN",
    label: "全局公告管理",
  }),
  [PERMISSIONS.AI_CONTENT_MANAGE]: Object.freeze({
    roles: Object.freeze(["admin"]),
    scope: "GLOBAL_ADMIN",
    label: "AI 内容策略管理",
  }),
  [PERMISSIONS.TENANT_OPERATE]: Object.freeze({
    roles: Object.freeze(["admin", "user"]),
    scope: "OWN_ACCOUNT_AND_STORES",
    label: "本账号经营操作",
  }),
});

export function hasPermission(account, permission) {
  const rule = permissionMatrix[permission];
  if (!account?.id || !rule) return false;
  return rule.roles.includes(account.role === "admin" ? "admin" : "user");
}

export function assertPermission(account, permission) {
  if (hasPermission(account, permission)) return account;
  const rule = permissionMatrix[permission];
  const error = new Error(`没有${rule?.label || "该操作"}权限`);
  error.status = 403;
  error.code = "PERMISSION_FORBIDDEN";
  error.permission = permission;
  throw error;
}
