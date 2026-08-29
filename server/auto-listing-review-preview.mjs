import crypto from "node:crypto";
import { mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const HASH = /^[a-f0-9]{64}$/u;
const MAX_SOURCE_BYTES = 16 * 1024 * 1024;
const MAX_PREVIEW_BYTES = 2 * 1024 * 1024;

function previewError() {
  return Object.assign(new Error("AUTO_LISTING_REVIEW_PREVIEW_UNAVAILABLE"), {
    code: "AUTO_LISTING_REVIEW_PREVIEW_UNAVAILABLE",
  });
}

function previewPath(contentHash, dataDir) {
  if (!HASH.test(contentHash || "")) throw previewError();
  const root = path.resolve(String(dataDir || process.env.QH_LOCAL_DATA_DIR || "server-data"));
  const directory = path.join(root, "auto-listing-review-previews", contentHash.slice(0, 2));
  return { directory, file: path.join(directory, `${contentHash}.webp`) };
}

function validPreviewBytes(bytes) {
  return Buffer.isBuffer(bytes) && bytes.length > 12 && bytes.length <= MAX_PREVIEW_BYTES
    && bytes.subarray(0, 4).toString("ascii") === "RIFF"
    && bytes.subarray(8, 12).toString("ascii") === "WEBP";
}

export async function readAutoListingReviewPreview({ contentHash, dataDir } = {}) {
  const target = previewPath(contentHash, dataDir);
  let handle;
  try {
    handle = await open(target.file, "r");
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 13 || stat.size > MAX_PREVIEW_BYTES) return null;
    const bytes = await handle.readFile();
    return validPreviewBytes(bytes) ? bytes : null;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw previewError();
  } finally {
    await handle?.close().catch(() => {});
  }
}

export async function cacheAutoListingReviewPreview({ contentHash, bytes, dataDir } = {}) {
  const source = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
  if (!HASH.test(contentHash || "") || source.length < 1 || source.length > MAX_SOURCE_BYTES
    || crypto.createHash("sha256").update(source).digest("hex") !== contentHash) throw previewError();
  const existing = await readAutoListingReviewPreview({ contentHash, dataDir });
  if (existing) return existing;
  let preview;
  try {
    preview = await sharp(source, { failOn: "error", limitInputPixels: 4096 * 4096, animated: false })
      .rotate()
      .resize({ width: 480, height: 640, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 74, effort: 4 })
      .toBuffer();
  } catch {
    throw previewError();
  }
  if (!validPreviewBytes(preview)) throw previewError();
  const target = previewPath(contentHash, dataDir);
  const temporary = `${target.file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await mkdir(target.directory, { recursive: true, mode: 0o700 });
    await writeFile(temporary, preview, { flag: "wx", mode: 0o600 });
    await rename(temporary, target.file);
  } catch {
    throw previewError();
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
  return preview;
}
