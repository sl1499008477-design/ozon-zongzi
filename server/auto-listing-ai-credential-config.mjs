import { constants } from "node:fs";
import { open as openKeyFile } from "node:fs/promises";
import { isAbsolute } from "node:path";

const ENV_KEY = "AUTO_LISTING_CREDENTIAL_MASTER_KEY";
const ENV_KEY_FILE = "AUTO_LISTING_CREDENTIAL_MASTER_KEY_FILE";
const KEY_BYTES = 32;

function credentialConfigError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function configured(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function decodeKey(value) {
  const encoded = typeof value === "string" ? value.trim() : "";
  if (!/^[A-Za-z0-9_-]{43}$/u.test(encoded)) return null;
  const key = Buffer.from(encoded, "base64url");
  return key.length === KEY_BYTES ? key : null;
}

function secureRegularFile(fileStat) {
  return fileStat
    && typeof fileStat.isFile === "function"
    && typeof fileStat.isSymbolicLink === "function"
    && fileStat.isFile()
    && !fileStat.isSymbolicLink()
    && Number.isInteger(fileStat.mode)
    && (fileStat.mode & 0o077) === 0;
}

async function readVerifiedDescriptor(filePath, open) {
  let handle;
  try {
    handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw credentialConfigError("AUTO_LISTING_AI_CREDENTIAL_KEY_FILE_INVALID");
  }
  try {
    let fileStat;
    try {
      fileStat = await handle.stat();
    } catch {
      throw credentialConfigError("AUTO_LISTING_AI_CREDENTIAL_KEY_FILE_INVALID");
    }
    if (!secureRegularFile(fileStat)) {
      throw credentialConfigError("AUTO_LISTING_AI_CREDENTIAL_KEY_FILE_INVALID");
    }
    try {
      return await handle.readFile("utf8");
    } catch {
      throw credentialConfigError("AUTO_LISTING_AI_CREDENTIAL_KEY_FILE_READ_FAILED");
    }
  } finally {
    try { await handle.close(); } catch { /* The credential read result is already determined. */ }
  }
}

export async function loadAutoListingCredentialKey({
  env = process.env,
  readFile,
  stat,
  open,
} = {}) {
  const environmentValue = env?.[ENV_KEY];
  const filePath = typeof env?.[ENV_KEY_FILE] === "string" ? env[ENV_KEY_FILE].trim() : env?.[ENV_KEY_FILE];
  const hasEnvironmentValue = configured(environmentValue);
  const hasFilePath = configured(filePath);

  if (hasEnvironmentValue && hasFilePath) {
    throw credentialConfigError("AUTO_LISTING_AI_CREDENTIAL_KEY_SOURCE_CONFLICT");
  }
  if (!hasEnvironmentValue && !hasFilePath) {
    throw credentialConfigError("AUTO_LISTING_AI_CREDENTIAL_KEY_MISSING");
  }
  if (hasEnvironmentValue) {
    const key = decodeKey(environmentValue);
    if (!key) throw credentialConfigError("AUTO_LISTING_AI_CREDENTIAL_KEY_INVALID");
    return key;
  }

  if (String(env?.NODE_ENV || "").trim().toLowerCase() === "production" && !isAbsolute(filePath)) {
    throw credentialConfigError("AUTO_LISTING_AI_CREDENTIAL_KEY_PRODUCTION_SOURCE_REQUIRED");
  }

  if ((readFile !== undefined || stat !== undefined) && typeof open !== "function") {
    throw credentialConfigError("AUTO_LISTING_AI_CREDENTIAL_KEY_FILE_INVALID");
  }
  const key = decodeKey(await readVerifiedDescriptor(filePath, open || openKeyFile));
  if (!key) throw credentialConfigError("AUTO_LISTING_AI_CREDENTIAL_KEY_INVALID");
  return key;
}
