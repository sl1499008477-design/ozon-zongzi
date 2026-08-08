import crypto from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const PURPOSE = "AUTO_LISTING_SUB2API_GATEWAY_KEY_V1";

function credentialCryptoError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function validScope(scope) {
  return scope
    && typeof scope.accountId === "string" && scope.accountId.trim().length > 0
    && typeof scope.connectionId === "string" && scope.connectionId.trim().length > 0
    && Number.isSafeInteger(scope.connectionVersion) && scope.connectionVersion > 0;
}

function aadFor(scope, keyVersion) {
  if (!validScope(scope)) throw credentialCryptoError("AUTO_LISTING_AI_CREDENTIAL_SCOPE_INVALID");
  return Buffer.from(JSON.stringify({
    purpose: PURPOSE,
    accountId: scope.accountId,
    connectionId: scope.connectionId,
    connectionVersion: scope.connectionVersion,
    keyVersion,
  }), "utf8");
}

function decodeBase64(value, expectedBytes) {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) return null;
  const decoded = Buffer.from(value, "base64");
  if (decoded.length !== expectedBytes || decoded.toString("base64") !== value) return null;
  return decoded;
}

function decodeCiphertext(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) return null;
  const decoded = Buffer.from(value, "base64");
  if (!decoded.length || decoded.toString("base64") !== value) return null;
  return decoded;
}

function validPayload(payload, keyVersion) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  if (payload.algorithm !== ALGORITHM || payload.keyVersion !== keyVersion) return null;
  const iv = decodeBase64(payload.iv, IV_BYTES);
  const authTag = decodeBase64(payload.authTag, AUTH_TAG_BYTES);
  const ciphertext = decodeCiphertext(payload.ciphertext);
  return iv && authTag && ciphertext ? { iv, authTag, ciphertext } : null;
}

export function createAutoListingCredentialCipher({ key, keyVersion } = {}) {
  if (!Buffer.isBuffer(key) || key.length !== 32 || typeof keyVersion !== "string" || !keyVersion.trim()) {
    throw credentialCryptoError("AUTO_LISTING_AI_CREDENTIAL_CIPHER_INVALID");
  }
  const encryptionKey = Buffer.from(key);
  const normalizedKeyVersion = keyVersion.trim();

  return {
    encrypt(scope, plaintext) {
      try {
        if (typeof plaintext !== "string" || !plaintext.length) {
          throw credentialCryptoError("AUTO_LISTING_AI_CREDENTIAL_ENCRYPT_FAILED");
        }
        const iv = crypto.randomBytes(IV_BYTES);
        const cipher = crypto.createCipheriv(ALGORITHM, encryptionKey, iv);
        cipher.setAAD(aadFor(scope, normalizedKeyVersion));
        const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
        return {
          algorithm: ALGORITHM,
          ciphertext: ciphertext.toString("base64"),
          iv: iv.toString("base64"),
          authTag: cipher.getAuthTag().toString("base64"),
          keyVersion: normalizedKeyVersion,
        };
      } catch (error) {
        if (error?.code === "AUTO_LISTING_AI_CREDENTIAL_ENCRYPT_FAILED") throw error;
        throw credentialCryptoError("AUTO_LISTING_AI_CREDENTIAL_ENCRYPT_FAILED");
      }
    },

    decrypt(scope, payload) {
      try {
        const encoded = validPayload(payload, normalizedKeyVersion);
        if (!encoded) throw credentialCryptoError("AUTO_LISTING_AI_CREDENTIAL_DECRYPT_FAILED");
        const decipher = crypto.createDecipheriv(ALGORITHM, encryptionKey, encoded.iv);
        decipher.setAAD(aadFor(scope, normalizedKeyVersion));
        decipher.setAuthTag(encoded.authTag);
        return Buffer.concat([decipher.update(encoded.ciphertext), decipher.final()]).toString("utf8");
      } catch {
        throw credentialCryptoError("AUTO_LISTING_AI_CREDENTIAL_DECRYPT_FAILED");
      }
    },

    fingerprint(plaintext) {
      if (typeof plaintext !== "string" || !plaintext.length) {
        throw credentialCryptoError("AUTO_LISTING_AI_CREDENTIAL_FINGERPRINT_FAILED");
      }
      return crypto.createHmac("sha256", encryptionKey).update(plaintext, "utf8").digest("hex").slice(0, 32);
    },
  };
}
