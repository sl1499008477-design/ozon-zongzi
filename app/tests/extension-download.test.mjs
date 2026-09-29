import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { EXTENSION_DOWNLOAD_PATH, EXTENSION_VERSION } from "../src/extension-page-contract.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const manifest = JSON.parse(readFileSync(path.join(root, "extension/manifest.json"), "utf8"));

test("collector download points to the packaged current extension", () => {
  assert.equal(EXTENSION_VERSION, manifest.version);
  assert.equal(EXTENSION_DOWNLOAD_PATH, `/ozon 粽子-扩展-v${EXTENSION_VERSION}.zip`);
  assert.ok(existsSync(path.join(root, "app/public", EXTENSION_DOWNLOAD_PATH)));
});

test("desktop download manifest labels each COS artifact with its published platform version", () => {
  const desktop = JSON.parse(readFileSync(path.join(root, "desktop/package.json"), "utf8"));
  const release = JSON.parse(readFileSync(path.join(root, "app/src/collector-release.json"), "utf8"));
  assert.equal(release.version, desktop.version);
  assert.equal(release.artifacts.length, 4);
  const supportedTargets = new Set(["mac-arm64", "mac-x64", "win-x64-setup", "win-x64-portable"]);
  assert.deepEqual(new Set(release.artifacts.map(({ target }) => target)), supportedTargets);
  for (const artifact of release.artifacts) {
    const version = artifact.version || release.version;
    assert.match(version, /^\d+\.\d+\.\d+$/);
    const url = new URL(artifact.path);
    assert.equal(url.protocol, "https:");
    assert.equal(url.hostname, "assets.ozonzongzi.com");
    assert.ok(Number.isSafeInteger(artifact.bytes) && artifact.bytes > 0);
    assert.match(artifact.sha256, /^[a-f0-9]{64}$/);
    assert.equal(
      url.pathname,
      `/listing-media/v1/collector/${version}/${artifact.target}-${artifact.sha256.slice(0, 16)}/ozon-zongzi-v${version}-${artifact.target}.${artifact.target.startsWith("mac-") ? "zip" : "exe"}`,
    );
  }
});
