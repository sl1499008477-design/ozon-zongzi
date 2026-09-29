import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
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
    version: "1.0.0",
    displayName: "ozon 粽子",
    productName: "ozon 粽子",
    primaryColor: "#1268FF",
    navyColor: "#10234A",
    logoPrimaryUrl: "/brand/ozon-zongzi-logo-primary.svg",
    symbolUrl: "/brand/ozon-zongzi-symbol.svg",
  });
});

test("checked-in brand assets retain the approved Web and extension variants", async () => {
  for (const file of brandFiles) {
    const supplied = await readFile(path.join(sourceAssets, file));
    const webAsset = path.join(repositoryRoot, "app/public/brand", file);
    assert.deepEqual(await readFile(webAsset), supplied, webAsset);

    const extensionAsset = path.join(repositoryRoot, "extension/icons", file);
    const extensionBytes = await readFile(extensionAsset);
    if (file === "ozon-zongzi-symbol.svg") {
      assert.match(
        extensionBytes.toString("utf8"),
        /<rect width="512" height="512" fill="#fff"\/><g fill="#1268FF">/,
      );
    } else {
      assert.deepEqual(extensionBytes, supplied, extensionAsset);
    }
  }

  for (const size of [16, 48, 128]) {
    const safePadding = Math.max(2, Math.round(size / 8));
    for (const [surface, destination] of [
      ["web", path.join(repositoryRoot, "app/public/icons", `icon${size}.png`)],
      ["extension", path.join(repositoryRoot, "extension/icons", `icon${size}.png`)],
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
          const isBrandBlue = alpha >= 240
            && Math.abs(red - 0x12) <= 2
            && Math.abs(green - 0x68) <= 2
            && Math.abs(blue - 0xff) <= 2;
          if (surface === "web" && alpha !== 0) {
            minX = Math.min(minX, x);
            minY = Math.min(minY, y);
            maxX = Math.max(maxX, x);
            maxY = Math.max(maxY, y);
          }
          if (isBrandBlue) {
            if (surface === "extension") {
              minX = Math.min(minX, x);
              minY = Math.min(minY, y);
              maxX = Math.max(maxX, x);
              maxY = Math.max(maxY, y);
            }
            solidBluePixels += 1;
          } else if (surface === "web" && alpha >= 240) {
            assert.ok(
              isBrandBlue,
              `${destination} must render opaque symbol pixels in brand blue #1268FF`,
            );
          }
        }
      }
      assert.ok(solidBluePixels > 0, `${destination} must contain an opaque brand symbol`);
      const paddingKind = surface === "web" ? "alpha" : "blue symbol";
      assert.ok(minX >= safePadding, `${destination} must keep left ${paddingKind} padding`);
      assert.ok(minY >= safePadding, `${destination} must keep top ${paddingKind} padding`);
      assert.ok(maxX <= size - safePadding - 1, `${destination} must keep right ${paddingKind} padding`);
      assert.ok(maxY <= size - safePadding - 1, `${destination} must keep bottom ${paddingKind} padding`);
      if (surface === "extension") {
        const corners = [
          0,
          (info.width - 1) * info.channels,
          (info.height - 1) * info.width * info.channels,
          ((info.height * info.width) - 1) * info.channels,
        ];
        for (const offset of corners) {
          const [red, green, blue, alpha] = data.subarray(offset, offset + 4);
          assert.ok(
            alpha >= 240 && red >= 253 && green >= 253 && blue >= 253,
            `${destination} must keep an opaque white background`,
          );
        }
      }
    }
  }
});
