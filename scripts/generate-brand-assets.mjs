import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const extensionOnly = process.argv.includes("--extension-only");
const source = path.resolve("brand-assets/ozon-zongzi");
const webBrand = path.resolve("app/public/brand");
const webIcons = path.resolve("app/public/icons");
const extensionIcons = path.resolve("extension/icons");
const brandFiles = [
  "ozon-zongzi-logo-primary.svg",
  "ozon-zongzi-logo-dark.svg",
  "ozon-zongzi-logo-white.svg",
  "ozon-zongzi-logo-mono.svg",
  "ozon-zongzi-symbol.svg",
];

await Promise.all([webBrand, webIcons, extensionIcons].map((directory) => mkdir(directory, { recursive: true })));

for (const file of brandFiles) {
  if (!extensionOnly) await cp(path.join(source, file), path.join(webBrand, file));
  await cp(path.join(source, file), path.join(extensionIcons, file));
}

const suppliedSymbol = await readFile(path.join(source, "ozon-zongzi-symbol.svg"), "utf8");
// Extension images cannot inherit page CSS currentColor. Bake in blue and a white tile.
await writeFile(path.join(extensionIcons, "ozon-zongzi-symbol.svg"),
  suppliedSymbol.replaceAll("currentColor", "#1268FF").replace('<g fill=', '<rect width="512" height="512" fill="#fff"/><g fill='));
const blueSymbol = Buffer.from(suppliedSymbol.replaceAll("currentColor", "#1268FF"));

for (const size of [16, 48, 128]) {
  const safePadding = Math.max(2, Math.round(size / 8));
  const symbolSize = size - safePadding * 2;
  const renderedSymbol = await sharp(blueSymbol)
    .resize(symbolSize, symbolSize, {
      fit: "contain",
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toBuffer();
  const extensionIcon = path.join(extensionIcons, `icon${size}.png`);
  await sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    },
  })
    .composite([{ input: renderedSymbol, left: safePadding, top: safePadding }])
    .png()
    .toFile(extensionIcon);
  if (!extensionOnly) {
    await sharp({ create: { width: size, height: size, channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite([{ input: renderedSymbol, left: safePadding, top: safePadding }])
      .png().toFile(path.join(webIcons, `icon${size}.png`));
  }
}
