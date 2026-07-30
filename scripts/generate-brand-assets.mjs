import { cp, mkdir } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

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
  await cp(path.join(source, file), path.join(webBrand, file));
  await cp(path.join(source, file), path.join(extensionIcons, file));
}

for (const size of [16, 48, 128]) {
  const extensionIcon = path.join(extensionIcons, `icon${size}.png`);
  await sharp(path.join(source, "ozon-zongzi-symbol.svg"))
    .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toFile(extensionIcon);
  await cp(extensionIcon, path.join(webIcons, `icon${size}.png`));
}
