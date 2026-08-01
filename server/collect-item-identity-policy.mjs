const PRESERVED_COLLECT_ITEM_FIELDS = new Set([
  "id",
  "accountId",
  "createdBy",
  "createdAt",
  "updatedAt",
  "status",
  "draftVersion",
  "listingDraft",
  "enrichment",
  "raw",
]);

const SERVER_OWNED_COLLECT_ITEM_FIELDS = new Set([
  "status",
  "createdat",
  "updatedat",
  "deletedat",
  "draftversion",
  "enrichment",
  "pipelineversion",
  "currentdraftid",
  "collectitemid",
  "collectrequestid",
  "listingresult",
  "listingtaskid",
  "listingjobid",
  "listingsubmittedat",
  "listingcompletedat",
  "listinglasterror",
  "listinglasterrorat",
  "listingstatusmessage",
]);

const SENSITIVE_COLLECT_KEY_SUFFIXES = Object.freeze([
  /(?:authorization(?:header|value)?|authentication(?:header|value)?|authheader)$/,
  /(?:setcookie|cookies?(?:header|value|data)?|requestheaders?|proxyheaders?)$/,
  /(?:credentials?(?:hash|header|value|data)?|passwords?(?:hash|value)?|passphrases?(?:hash|value)?|(?:client)?secrets?(?:key|hash|value)?)$/,
  /(?:(?:x)?apikeys?(?:hash|value)?|(?:private|access|secret|signing|encryption)keys?(?:pem|hash|value)?)$/,
  /(?:(?:access|refresh|session|auth|bearer|id|csrf)?tokens?(?:hash|value)?|sessionids?(?:hash|value)?|clientids?(?:hash|value)?|verificationcodes?(?:hash|value)?)$/,
]);
const EXACT_SENSITIVE_COLLECT_KEYS = new Set([
  "auth",
  "cookiejar",
  "header",
  "headers",
  "jwt",
  "session",
]);
const SECRET_VALUE_PATTERNS = Object.freeze([
  /\bBearer[ \t]+[A-Za-z0-9._~+\/-]{20,}={0,2}(?=$|[\s,;])/i,
  /\bBasic[ \t]+[A-Za-z0-9+/]{16,}={0,2}(?=$|[\s,;])/i,
  /\bCollector[ \t]+(?:csess|cst|ctt)_[A-Za-z0-9_-]{16,}\b/i,
  /\b(?:csess|cst|ctt)_[A-Za-z0-9_-]{16,}\b/i,
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{16,}\b/,
  /\bsk-(?:proj-|live-|test-)?[A-Za-z0-9_-]{20,}\b/i,
  /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/i,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /\b(?:api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|session[-_ ]?token|client[-_ ]?secret|private[-_ ]?key|password|passphrase|authorization|cookie|session[-_ ]?id)\s*(?:=|:)\s*["']?[A-Za-z0-9._~+\/%-]{12,}/i,
  /https?:\/\/[^\s\/:@]+:[^\s\/@]{4,}@[^\s/]+/i,
]);

function canonicalFieldName(value) {
  return String(value || "").replace(/[-_]/g, "").toLowerCase();
}

const PRESERVED_COLLECT_ITEM_CANONICAL_FIELDS = new Set(
  [...PRESERVED_COLLECT_ITEM_FIELDS].map(canonicalFieldName),
);

function canonicalSensitiveFieldName(value) {
  return String(value || "").replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function sensitiveCollectKey(value) {
  const key = canonicalSensitiveFieldName(value);
  return EXACT_SENSITIVE_COLLECT_KEYS.has(key)
    || SENSITIVE_COLLECT_KEY_SUFFIXES.some((pattern) => pattern.test(key));
}

function secretShapedText(value) {
  if (typeof value !== "string" || !value) return false;
  const candidates = [value];
  if (value.includes("%")) {
    try {
      const decoded = decodeURIComponent(value);
      if (decoded !== value) candidates.push(decoded);
    } catch {
      // A malformed percent sequence is ordinary catalog text unless another signature matches.
    }
  }
  return candidates.some((candidate) =>
    SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(candidate)));
}

function containsSensitiveCollectEvidence(value, seen = new WeakSet()) {
  if (secretShapedText(value)) return true;
  if (!value || typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) {
    return value.some((entry) => containsSensitiveCollectEvidence(entry, seen));
  }
  return Object.entries(value).some(([key, nested]) =>
    sensitiveCollectKey(key)
    || secretShapedText(key)
    || containsSensitiveCollectEvidence(nested, seen));
}

export function assertCollectedPublicEvidenceSafe(incoming) {
  if (!containsSensitiveCollectEvidence(incoming)) return;
  throw Object.assign(
    new Error("采集商品 payload 包含不允许保存的敏感凭据数据"),
    { status: 400, code: "COLLECT_PAYLOAD_SENSITIVE" },
  );
}

function serverOwnedField(key) {
  return SERVER_OWNED_COLLECT_ITEM_FIELDS.has(canonicalFieldName(key));
}

function preservedCollectItemField(key) {
  return PRESERVED_COLLECT_ITEM_CANONICAL_FIELDS.has(canonicalFieldName(key));
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function blankPublicEvidence(value) {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return !value.trim();
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

function mergeObjectIntoBlanks(current, incoming, root = false) {
  const merged = plainObject(current) ? structuredClone(current) : {};
  if (!plainObject(incoming)) return merged;
  for (const [key, value] of Object.entries(incoming)) {
    if (
      root
      && (preservedCollectItemField(key) || serverOwnedField(key))
    ) continue;
    if (blankPublicEvidence(merged[key])) {
      if (!blankPublicEvidence(value)) merged[key] = structuredClone(value);
    } else if (plainObject(merged[key]) && plainObject(value)) {
      merged[key] = mergeObjectIntoBlanks(merged[key], value);
    }
  }
  return merged;
}

export function mergeCollectedItemPublicEvidence(current, incoming) {
  return mergeObjectIntoBlanks(current, incoming, true);
}

export function sanitizeCollectedPublicEvidence(incoming) {
  if (!plainObject(incoming)) return {};
  const sanitized = structuredClone(incoming);
  for (const key of Object.keys(sanitized)) {
    if (preservedCollectItemField(key) || serverOwnedField(key)) delete sanitized[key];
  }
  return sanitized;
}
