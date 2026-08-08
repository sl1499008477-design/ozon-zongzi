const SELECT_KEYS = new Set([
  "accountId", "policies", "directUploadAllowed", "uploadEnabled", "listingPipelineEnabled",
]);
const COMPLETE_KEYS = new Set(["frozenPolicy", "directUploadAllowed"]);
const POLICY_KEYS = new Set([
  "id", "accountId", "version", "mode", "enabled", "publishedBy", "publishedAt",
]);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/u;

function policyError(code, status = 409) {
  const error = new Error("自动上架上传策略暂时不可用");
  error.code = code;
  error.status = status;
  error.retryable = false;
  return error;
}

function plain(value) {
  try {
    return value !== null && typeof value === "object" && !Array.isArray(value)
      && [Object.prototype, null].includes(Object.getPrototypeOf(value));
  } catch { return false; }
}

function exact(value, keys) {
  if (!plain(value)) throw policyError("AUTO_LISTING_UPLOAD_POLICY_INVALID", 422);
  const own = Reflect.ownKeys(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (own.length !== keys.size || own.some((key) => typeof key !== "string" || !keys.has(key)
    || descriptors[key]?.enumerable !== true || !Object.hasOwn(descriptors[key], "value"))) {
    throw policyError("AUTO_LISTING_UPLOAD_POLICY_INVALID", 422);
  }
  return Object.fromEntries(own.map((key) => [key, descriptors[key].value]));
}

function normalizePolicy(raw) {
  const value = exact(raw, POLICY_KEYS);
  if (!SAFE_ID.test(value.id || "") || !SAFE_ID.test(value.accountId || "")
    || !SAFE_ID.test(value.publishedBy || "")
    || !Number.isSafeInteger(value.version) || value.version < 1 || value.version > 2_147_483_647
    || !["REVIEW", "DIRECT"].includes(value.mode) || typeof value.enabled !== "boolean"
    || typeof value.publishedAt !== "string" || !Number.isFinite(Date.parse(value.publishedAt))) {
    throw policyError("AUTO_LISTING_UPLOAD_POLICY_INVALID", 422);
  }
  return Object.freeze({ ...value });
}

function assertDirectGates({ directUploadAllowed, uploadEnabled = true, listingPipelineEnabled = true }) {
  if (directUploadAllowed !== true || uploadEnabled !== true || listingPipelineEnabled !== true) {
    throw policyError("AUTO_LISTING_DIRECT_UPLOAD_BLOCKED", 503);
  }
}

export function selectAutoListingUploadPolicyForNewJob(raw = {}) {
  const input = exact(raw, SELECT_KEYS);
  if (!SAFE_ID.test(input.accountId || "") || !Array.isArray(input.policies)
    || ![input.directUploadAllowed, input.uploadEnabled, input.listingPipelineEnabled]
      .every((value) => typeof value === "boolean")) {
    throw policyError("AUTO_LISTING_UPLOAD_POLICY_INVALID", 422);
  }
  const scoped = input.policies.filter((policy) => plain(policy) && policy.accountId === input.accountId);
  const published = [];
  for (const policy of scoped) {
    if (policy.enabled !== true || !policy.publishedBy || !policy.publishedAt) continue;
    published.push(normalizePolicy(policy));
  }
  if (published.length < 1) throw policyError("AUTO_LISTING_UPLOAD_POLICY_NOT_PUBLISHED");
  const highestVersion = Math.max(...published.map((policy) => policy.version));
  const current = published.filter((policy) => policy.version === highestVersion);
  if (current.length !== 1) throw policyError("AUTO_LISTING_UPLOAD_POLICY_AMBIGUOUS");
  if (current[0].mode === "DIRECT") assertDirectGates(input);
  return current[0];
}

export function decideAutoListingContentCompletion(raw = {}) {
  const input = exact(raw, COMPLETE_KEYS);
  if (typeof input.directUploadAllowed !== "boolean") {
    throw policyError("AUTO_LISTING_UPLOAD_POLICY_INVALID", 422);
  }
  const policy = normalizePolicy(input.frozenPolicy);
  if (policy.enabled !== true) throw policyError("AUTO_LISTING_UPLOAD_POLICY_INVALID", 422);
  if (policy.mode === "DIRECT") {
    assertDirectGates({ directUploadAllowed: input.directUploadAllowed });
    return Object.freeze({
      event: "CONTENT_READY_FOR_DIRECT_UPLOAD", status: "UPLOAD_QUEUED", invokeUpload: true,
    });
  }
  return Object.freeze({
    event: "CONTENT_READY_FOR_REVIEW", status: "READY_FOR_REVIEW", invokeUpload: false,
  });
}
