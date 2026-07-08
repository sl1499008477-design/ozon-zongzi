import crypto from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const FALLBACK_KEY = "sonli-local-development-key-change-before-production";

function encryptionSource() {
  const value = process.env.APP_ENCRYPTION_KEY || process.env.SONLI_ENCRYPTION_KEY || "";
  if (value) return { value, fallback: false };
  return { value: FALLBACK_KEY, fallback: true };
}

function encryptionKey() {
  return crypto.createHash("sha256").update(encryptionSource().value).digest();
}

export function encryptionHealth() {
  const source = encryptionSource();
  return {
    algorithm: ALGORITHM,
    configured: !source.fallback,
    fallback: source.fallback,
    keyVersion: process.env.APP_ENCRYPTION_KEY_VERSION || "v1",
  };
}

export function encryptSecret(value) {
  const plain = String(value || "");
  if (!plain) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return {
    algorithm: ALGORITHM,
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
    keyVersion: process.env.APP_ENCRYPTION_KEY_VERSION || "v1",
  };
}

export function decryptSecret(payload) {
  if (!payload) return "";
  if (typeof payload === "string") return payload;
  const ciphertext = payload.ciphertext || payload.encryptedApiKey || payload.encrypted_api_key;
  const iv = payload.iv;
  const authTag = payload.authTag || payload.auth_tag;
  if (!ciphertext || !iv || !authTag) return "";
  const decipher = crypto.createDecipheriv(ALGORITHM, encryptionKey(), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(authTag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value || {}));
}

export function protectStateForStorage(state) {
  const protectedState = cloneJson(state);
  protectedState.stores = (Array.isArray(protectedState.stores) ? protectedState.stores : []).map((store) => {
    const next = { ...store };
    if (next.apiKey) {
      next.apiKeyEncrypted = encryptSecret(next.apiKey);
      next.apiKeyProtected = true;
      delete next.apiKey;
    }
    return next;
  });
  return protectedState;
}

export function stateNeedsSecretProtection(state) {
  return (Array.isArray(state?.stores) ? state.stores : []).some((store) => Boolean(store?.apiKey));
}

export function unprotectStateFromStorage(state) {
  const runtimeState = cloneJson(state);
  runtimeState.stores = (Array.isArray(runtimeState.stores) ? runtimeState.stores : []).map((store) => {
    const next = { ...store };
    if (!next.apiKey && next.apiKeyEncrypted) {
      try {
        next.apiKey = decryptSecret(next.apiKeyEncrypted);
        delete next.apiKeyDecryptError;
      } catch (error) {
        next.apiKey = "";
        next.apiKeyDecryptError = String(error?.message || error).slice(0, 240);
      }
    }
    return next;
  });
  return runtimeState;
}
