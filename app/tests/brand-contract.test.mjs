import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import sharp from "sharp";
import { PRODUCT_BRAND } from "../src/brand.js";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const sourceAssets = path.join(repositoryRoot, "brand-assets/ozon-zongzi");
const brandFiles = [
  "ozon-zongzi-logo-primary.svg",
  "ozon-zongzi-logo-dark.svg",
  "ozon-zongzi-logo-white.svg",
  "ozon-zongzi-logo-mono.svg",
  "ozon-zongzi-symbol.svg",
];

test("product brand exposes the approved display contract", () => {
  assert.deepEqual(PRODUCT_BRAND, {
    displayName: "ozon 粽子",
    productName: "ozon 粽子",
    primaryColor: "#1268FF",
    navyColor: "#10234A",
    logoPrimaryUrl: "/brand/ozon-zongzi-logo-primary.svg",
    symbolUrl: "/brand/ozon-zongzi-symbol.svg",
  });
});

test("brand generator copies the supplied SVGs and creates correctly sized PNG icons", async () => {
  const generated = spawnSync(process.execPath, ["scripts/generate-brand-assets.mjs"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  assert.equal(generated.status, 0, generated.stderr || generated.stdout);

  for (const file of brandFiles) {
    const supplied = await readFile(path.join(sourceAssets, file));
    for (const destination of [
      path.join(repositoryRoot, "brand-assets/ozon-zongzi", file),
      path.join(repositoryRoot, "app/public/brand", file),
      path.join(repositoryRoot, "extension/icons", file),
    ]) {
      await access(destination);
      assert.deepEqual(await readFile(destination), supplied, destination);
    }
  }

  for (const size of [16, 48, 128]) {
    const safePadding = Math.max(2, Math.round(size / 8));
    for (const destination of [
      path.join(repositoryRoot, "app/public/icons", `icon${size}.png`),
      path.join(repositoryRoot, "extension/icons", `icon${size}.png`),
    ]) {
      const metadata = await sharp(destination).metadata();
      assert.equal(metadata.format, "png", destination);
      assert.equal(metadata.width, size, destination);
      assert.equal(metadata.height, size, destination);
      assert.equal(metadata.hasAlpha, true, destination);

      const { data, info } = await sharp(destination)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      let minX = info.width;
      let minY = info.height;
      let maxX = -1;
      let maxY = -1;
      let solidBluePixels = 0;
      for (let y = 0; y < info.height; y += 1) {
        for (let x = 0; x < info.width; x += 1) {
          const offset = (y * info.width + x) * info.channels;
          const [red, green, blue, alpha] = data.subarray(offset, offset + 4);
          if (alpha === 0) continue;
          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
          maxX = Math.max(maxX, x);
          maxY = Math.max(maxY, y);
          if (alpha >= 240) {
            assert.ok(
              Math.abs(red - 0x12) <= 2
                && Math.abs(green - 0x68) <= 2
                && Math.abs(blue - 0xff) <= 2,
              `${destination} must render opaque symbol pixels in brand blue #1268FF`,
            );
            solidBluePixels += 1;
          }
        }
      }
      assert.ok(solidBluePixels > 0, `${destination} must contain an opaque brand symbol`);
      assert.ok(minX >= safePadding, `${destination} must keep left alpha padding`);
      assert.ok(minY >= safePadding, `${destination} must keep top alpha padding`);
      assert.ok(maxX <= size - safePadding - 1, `${destination} must keep right alpha padding`);
      assert.ok(maxY <= size - safePadding - 1, `${destination} must keep bottom alpha padding`);
    }
  }
});
