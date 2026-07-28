import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const devScript = await readFile(new URL("./dev.mjs", import.meta.url), "utf8");

assert.match(
  devScript,
  /\["frontend-compat-proxy",\s*"node",\s*\["scripts\/frontend-compat-proxy\.mjs"\]\]/,
  "pnpm dev must start the 3000 compatibility proxy",
);

const proxyScript = await readFile(new URL("./frontend-compat-proxy.mjs", import.meta.url), "utf8");

assert.match(
  proxyScript,
  /(?:const|let|var)\s+host\s*=\s*["']127\.0\.0\.1["']/,
  "the compatibility proxy must listen on 127.0.0.1 by default",
);
assert.match(
  proxyScript,
  /(?:const|let|var)\s+port\s*=\s*(?:Number\([^)]*\)\s*\?\?\s*)?3000/,
  "the compatibility proxy must listen on port 3000 by default",
);
assert.match(
  proxyScript,
  /127\.0\.0\.1:5173/,
  "the compatibility proxy must forward to Vite on 127.0.0.1:5173",
);

console.log("local development entrypoint contract passed");
