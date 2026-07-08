import crypto from "node:crypto";
import { Readable } from "node:stream";

let clientPromise = null;
let bucketReady = false;

function minioPort() {
  return Number(process.env.MINIO_PORT || 9000);
}

function minioUseSsl() {
  const value = String(process.env.MINIO_USE_SSL || "false").toLowerCase();
  return value === "1" || value === "true";
}

export function objectStorageInfo() {
  return {
    endpoint: process.env.MINIO_ENDPOINT || "127.0.0.1",
    port: minioPort(),
    useSSL: minioUseSsl(),
    bucket: process.env.MINIO_BUCKET || "sonli-local-files",
  };
}

function bucketName() {
  return objectStorageInfo().bucket;
}

async function getClient() {
  if (!clientPromise) {
    clientPromise = import("minio")
      .then(({ Client }) => new Client({
        endPoint: process.env.MINIO_ENDPOINT || "127.0.0.1",
        port: minioPort(),
        useSSL: minioUseSsl(),
        accessKey: process.env.MINIO_ACCESS_KEY || "sonli_minio",
        secretKey: process.env.MINIO_SECRET_KEY || "sonli_minio_password",
      }))
      .catch((error) => {
        throw new Error(`MinIO 依赖未安装或不可用，请先执行 pnpm install。原始错误: ${error.message}`);
      });
  }
  return clientPromise;
}

async function ensureBucket() {
  if (bucketReady) return;
  const client = await getClient();
  const bucket = bucketName();
  const exists = await client.bucketExists(bucket);
  if (!exists) await client.makeBucket(bucket);
  bucketReady = true;
}

function safeFileName(name) {
  const fallback = "file";
  return String(name || fallback)
    .trim()
    .replace(/[^\w.\-\u4e00-\u9fa5]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120) || fallback;
}

function decodeBase64Payload(payload) {
  const raw = String(payload || "");
  const [, dataUrlType, dataUrlBody] = raw.match(/^data:([^;]+);base64,(.*)$/s) || [];
  const base64 = dataUrlBody || raw;
  const buffer = Buffer.from(base64, "base64");
  if (!buffer.length) {
    const err = new Error("文件内容为空");
    err.status = 400;
    throw err;
  }
  const maxBytes = Number(process.env.LOCAL_FILE_MAX_BYTES || 50 * 1024 * 1024);
  if (buffer.length > maxBytes) {
    const err = new Error(`文件超过本地上传限制 ${Math.round(maxBytes / 1024 / 1024)}MB`);
    err.status = 413;
    throw err;
  }
  return { buffer, dataUrlType };
}

export function buildObjectKey(name) {
  const date = new Date().toISOString().slice(0, 10);
  return `local/${date}/${crypto.randomUUID()}-${safeFileName(name)}`;
}

export async function putObjectFromBase64({ key, name, contentType, base64 }) {
  await ensureBucket();
  const { buffer, dataUrlType } = decodeBase64Payload(base64);
  const objectKey = key || buildObjectKey(name);
  const type = contentType || dataUrlType || "application/octet-stream";
  const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");
  const client = await getClient();
  await client.putObject(
    bucketName(),
    objectKey,
    Readable.from(buffer),
    buffer.length,
    {
      "Content-Type": type,
      "X-Amz-Meta-Original-Name": String(name || ""),
    }
  );
  return {
    key: objectKey,
    bucket: bucketName(),
    contentType: type,
    size: buffer.length,
    sha256,
  };
}

export async function getObjectStream(key) {
  const client = await getClient();
  return client.getObject(bucketName(), String(key || ""));
}

export async function removeObject(key) {
  const client = await getClient();
  await client.removeObject(bucketName(), String(key || ""));
}

export async function objectStorageHealth() {
  await ensureBucket();
  return {
    ok: true,
    ...objectStorageInfo(),
  };
}
