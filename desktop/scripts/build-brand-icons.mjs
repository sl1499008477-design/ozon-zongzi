import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const desktop = fileURLToPath(new URL('../', import.meta.url));
const brand = path.resolve(desktop, '../app/public/brand');
const assets = path.join(desktop, 'dist/assets');
const symbol = await fs.readFile(path.join(brand, 'ozon-zongzi-symbol.svg'), 'utf8');
// Keep the Web mark unchanged; add only the requested white rounded icon tile.
const inner = symbol.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
const icon = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <title>ozon 粽子 · 桌面采集助手</title>
  <rect x="64" y="64" width="896" height="896" rx="196" fill="#fff"/>
  <svg x="96" y="176" width="768" height="768" viewBox="0 0 512 512" color="#1268FF">${inner}</svg>
</svg>\n`;
await fs.copyFile(path.join(brand, 'ozon-zongzi-logo-primary.svg'), path.join(assets, 'ozon-zongzi-logo.svg'));
await fs.writeFile(path.join(assets, 'ozon-zongzi-icon.svg'), icon);
await sharp(Buffer.from(icon)).png().toFile(path.join(desktop, 'build/icon.png'));
// PNG-compressed ICO entries are supported by Chromium and Windows.
const sizes = [16, 32, 48, 128, 256];
const images = await Promise.all(sizes.map(size => sharp(Buffer.from(icon)).resize(size).png().toBuffer()));
const header = Buffer.alloc(6 + sizes.length * 16);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(sizes.length, 4);
let offset = header.length;
images.forEach((image, index) => {
  const entry = 6 + index * 16;
  header[entry] = header[entry + 1] = sizes[index] % 256;
  header.writeUInt16LE(1, entry + 4);
  header.writeUInt16LE(32, entry + 6);
  header.writeUInt32LE(image.length, entry + 8);
  header.writeUInt32LE(offset, entry + 12);
  offset += image.length;
});
await fs.writeFile(path.join(desktop, 'dist/favicon.ico'), Buffer.concat([header, ...images]));
console.log('Web logo copied; rounded blue-on-white PNG/SVG/ICO generated.');
