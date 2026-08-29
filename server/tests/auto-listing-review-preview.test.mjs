import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";

test("review preview cache persists a small WebP derived from the immutable accepted image", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "auto-listing-review-preview-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  let previewModule = null;
  try {
    previewModule = await import("../auto-listing-review-preview.mjs");
  } catch {}
  assert.equal(typeof previewModule?.cacheAutoListingReviewPreview, "function");
  assert.equal(typeof previewModule?.readAutoListingReviewPreview, "function");

  const source = await sharp({
    create: { width: 768, height: 1024, channels: 4, background: "#345678" },
  }).png().toBuffer();
  const contentHash = crypto.createHash("sha256").update(source).digest("hex");
  const written = await previewModule.cacheAutoListingReviewPreview({ contentHash, bytes: source, dataDir });
  const cached = await previewModule.readAutoListingReviewPreview({ contentHash, dataDir });
  const metadata = await sharp(cached).metadata();

  assert.equal(written.equals(cached), true);
  assert.equal(metadata.format, "webp");
  assert.ok(metadata.width <= 480);
  assert.ok(metadata.height <= 640);
  assert.ok(cached.length < source.length);
});
