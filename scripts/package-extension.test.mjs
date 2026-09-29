import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const script = fileURLToPath(new URL("./package-extension.mjs", import.meta.url));
const runtimeFiles = [
  "background/collector-client.js", "background/collector-ozon-enrichment-agent.js",
  "background/collector-account-status.js", "background/ozon-web-collection.js",
  "background/collector-ozon-enrichment-client.js", "background/service-worker.js",
  "content/seller-company-context-hook.js", "lib/collector-auth-flow.js", "lib/collector-session.js",
  "lib/category-strategy-handoff.js", "lib/category-strategy-sampling.js", "lib/ozon-buyer-category.js",
  "lib/ozon-collect-coordinator.js", "lib/ozon-enrichment-contract.js", "lib/seller-company-context.js",
  "lib/seller-company-context-runtime.js", "lib/seller-recovery-tab.js",
];

async function put(root, relative, body) {
  const target = path.join(root, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, body);
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "sonli-package-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await put(root, "extension/manifest.json", JSON.stringify({ manifest_version: 3, name: "Package fixture", version: "0.13.46.39" }));
  for (const file of runtimeFiles) await put(root, `extension/${file}`, `// fixture ${file}\n`);
  for (const file of ["tests/fixture.js", "background/__tests__/fixture.js", "popup/__tests__/fixture.js"])
    await put(root, `extension/${file}`, "// test only\n");
  await put(root, "app/public/sonli-extension-0.13.46.38.zip", "old ZIP A");
  await put(root, "app/public/sonli-extension-0.13.46.38/manifest.json", "old unpacked A");
  return root;
}

function pack(root, env = process.env) {
  return spawnSync(process.execPath, [script], { cwd: root, env, encoding: "utf8" });
}

async function filesUnder(dir) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(full));
    else files.push(full);
  }
  return files;
}

test("packaging leaves the current download and unpacked tree public, then archives older releases", async t => {
  const root = await fixture(t);
  await put(root, "app/public/qh-extension-0.13.46.1.zip", "legacy ZIP");
  await put(root, "app/public/sonli-extension-0.13.46.40.zip", "future ZIP");
  await put(root, "app/public/sonli-extension-latest.zip", "unversioned artifact");
  await put(root, "app/public/brand/icon.svg", "brand");
  const result = pack(root);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual((await readdir(path.join(root, "app/public"))).sort(), [
    "brand", "ozon 粽子-扩展-v0.13.46.39", "ozon 粽子-扩展-v0.13.46.39.zip",
    "sonli-extension-0.13.46.40.zip", "sonli-extension-latest.zip",
  ]);
  const manifest = JSON.parse(await readFile(path.join(root, "app/public/ozon 粽子-扩展-v0.13.46.39/manifest.json"), "utf8"));
  assert.equal(manifest.version, "0.13.46.39");
  const zip = path.join(root, "app/public/ozon 粽子-扩展-v0.13.46.39.zip");
  const entries = spawnSync("zipinfo", ["-1", zip], { encoding: "utf8" });
  assert.equal(entries.status, 0, entries.stderr);
  assert.doesNotMatch(entries.stdout, /(?:^|\/)(?:tests|__tests__)\//m);
  const zipped = spawnSync("unzip", ["-p", zip, "manifest.json"], { encoding: "utf8" });
  assert.equal(zipped.status, 0, zipped.stderr);
  assert.deepEqual(JSON.parse(zipped.stdout), manifest);
  const archived = await filesUnder(path.join(root, "outputs/extension-archive"));
  assert.deepEqual((await Promise.all(archived.map(file => readFile(file, "utf8")))).sort(), ["legacy ZIP", "old ZIP A", "old unpacked A"]);
});

test("repeated packaging preserves different old packages with the same filename and the replaced current release", async t => {
  const root = await fixture(t);
  assert.equal(pack(root).status, 0);
  const previousCurrent = await readFile(path.join(root, "app/public/ozon 粽子-扩展-v0.13.46.39.zip"));
  await put(root, "app/public/sonli-extension-0.13.46.38.zip", "old ZIP B");
  await put(root, "app/public/sonli-extension-0.13.46.38/manifest.json", "old unpacked B");
  await put(root, "extension/background/service-worker.js", "// changed current release\n");
  const second = pack(root);
  assert.equal(second.status, 0, second.stderr);
  const archived = await filesUnder(path.join(root, "outputs/extension-archive"));
  const oldZips = archived.filter(file => path.basename(file) === "sonli-extension-0.13.46.38.zip");
  assert.equal(oldZips.length, 2);
  assert.deepEqual((await Promise.all(oldZips.map(file => readFile(file, "utf8")))).sort(), ["old ZIP A", "old ZIP B"]);
  const oldDirectories = archived.filter(file => file.endsWith("sonli-extension-0.13.46.38/manifest.json"));
  assert.deepEqual((await Promise.all(oldDirectories.map(file => readFile(file, "utf8")))).sort(), ["old unpacked A", "old unpacked B"]);
  const priorCurrent = archived.find(file => path.basename(file) === "ozon 粽子-扩展-v0.13.46.39.zip");
  assert.ok(priorCurrent);
  assert.deepEqual(await readFile(priorCurrent), previousCurrent);
  assert.equal(await readFile(path.join(root, "app/public/ozon 粽子-扩展-v0.13.46.39/background/service-worker.js"), "utf8"), "// changed current release\n");
});

for (const failure of ["missing runtime", "zip failure"]) {
  test(`${failure} leaves all published versions unchanged`, async t => {
    const root = await fixture(t);
    await put(root, "app/public/ozon 粽子-扩展-v0.13.46.39.zip", "existing current ZIP");
    await put(root, "app/public/ozon 粽子-扩展-v0.13.46.39/manifest.json", "existing current directory");
    let env = process.env;
    if (failure === "missing runtime") {
      await rm(path.join(root, "extension/background/collector-client.js"));
    } else {
      await put(root, "bin/zip", "#!/bin/sh\nexit 7\n");
      await chmod(path.join(root, "bin/zip"), 0o755);
      env = { ...process.env, PATH: `${path.join(root, "bin")}${path.delimiter}${process.env.PATH}` };
    }
    const result = pack(root, env);
    assert.notEqual(result.status, 0);
    assert.equal(await readFile(path.join(root, "app/public/ozon 粽子-扩展-v0.13.46.39.zip"), "utf8"), "existing current ZIP");
    assert.equal(await readFile(path.join(root, "app/public/ozon 粽子-扩展-v0.13.46.39/manifest.json"), "utf8"), "existing current directory");
    assert.equal(await readFile(path.join(root, "app/public/sonli-extension-0.13.46.38.zip"), "utf8"), "old ZIP A");
    assert.equal(await readFile(path.join(root, "app/public/sonli-extension-0.13.46.38/manifest.json"), "utf8"), "old unpacked A");
  });
}


test("production packaging targets HTTPS in a separate directory and preserves local source/downloads", async t => {
  const root = await fixture(t);
  const realExtension = fileURLToPath(new URL("../extension/", import.meta.url));
  await cp(realExtension, path.join(root, "extension"), { recursive: true });
  const originalWorker = await readFile(path.join(root, "extension/background/service-worker.js"), "utf8");
  const originalManifest = JSON.parse(await readFile(path.join(root, "extension/manifest.json"), "utf8"));
  const output = path.join(root, "production downloads");
  const result = spawnSync(process.execPath, [script, "--web-origin", "https://www.ozonzongzi.com", "--output-dir", output], {
    cwd: root, encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const entries = await readdir(output).catch(() => []);
  assert.ok(entries.includes(`ozon 粽子-扩展-v${originalManifest.version}.zip`), "production ZIP must use the requested output directory");
  const unpacked = path.join(output, `ozon 粽子-扩展-v${originalManifest.version}`);
  const manifest = JSON.parse(await readFile(path.join(unpacked, "manifest.json"), "utf8"));
  assert.equal(manifest.key, originalManifest.key);
  assert.equal(manifest.name, "ozon 粽子");
  assert.equal(manifest.version, originalManifest.version);
  assert.ok(manifest.host_permissions.includes("https://www.ozonzongzi.com/*"));
  assert.ok(manifest.content_scripts.find(item => item.js?.includes("content/sync-auth.js")).matches.includes("https://www.ozonzongzi.com/*"));
  const background = await readFile(path.join(unpacked, "background/service-worker.js"), "utf8");
  assert.match(background, /const BACKEND_URLS = \['https:\/\/www\.ozonzongzi\.com\/api'\]/);
  const bridge = { URL, module: { exports: {} } };
  vm.runInNewContext(await readFile(path.join(unpacked, "lib/web-bridge-policy.js"), "utf8"), bridge);
  assert.equal(bridge.module.exports.isTrustedWebBridgeSender({ url: "https://www.ozonzongzi.com/login" }), true);
  assert.equal(bridge.module.exports.isTrustedWebBridgeSender({ url: "https://qh.jizhangerp.com/login" }), false);
  assert.equal(bridge.module.exports.isTrustedWebBridgeSender({ url: "https://untrusted.example/login" }), false);
  assert.equal(await readFile(path.join(root, "extension/background/service-worker.js"), "utf8"), originalWorker);
  assert.equal(await readFile(path.join(root, "app/public/sonli-extension-0.13.46.38.zip"), "utf8"), "old ZIP A");
  const zipped = spawnSync("unzip", ["-p", path.join(output, `ozon 粽子-扩展-v${originalManifest.version}.zip`), "background/service-worker.js"], { encoding: "utf8" });
  assert.equal(zipped.status, 0);
  assert.equal(zipped.stdout, background);
});

test("production packaging rejects an insecure build origin before changing downloads", async t => {
  const root = await fixture(t);
  const result = spawnSync(process.execPath, [script, "--web-origin", "http://example.com", "--output-dir", path.join(root, "production")], {
    cwd: root, encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.equal(await readFile(path.join(root, "app/public/sonli-extension-0.13.46.38.zip"), "utf8"), "old ZIP A");
});

test("desktop publication can prepare another Web build without touching local downloads", async t => {
  const root = await fixture(t);
  const publishScript = path.join(root, "scripts/publish-desktop-downloads.mjs");
  await put(root, "scripts/publish-desktop-downloads.mjs", await readFile(new URL("./publish-desktop-downloads.mjs", import.meta.url)));
  await put(root, "desktop/package.json", JSON.stringify({ version: "1.0.0" }));
  const source = path.join(root, "installers");
  for (const target of ["mac-arm64", "mac-x64", "win-x64-setup", "win-x64-portable"]) {
    await put(source, `ozon 粽子-v1.0.0-${target}.${target.startsWith("mac-") ? "zip" : "exe"}`, `fixture-${target}`);
  }
  await put(root, "app/src/collector-release.json", '{"existing":true}');
  const appDir = path.join(root, "deployment/app");
  const result = spawnSync(process.execPath, [publishScript, source, appDir], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const releasePath = path.join(appDir, "src/collector-release.json");
  const releaseText = await readFile(releasePath, "utf8").catch(() => "");
  assert.ok(releaseText, "release manifest must be written to the selected Web build");
  const release = JSON.parse(releaseText);
  assert.equal(release.artifacts.length, 4);
  for (const artifact of release.artifacts) {
    assert.equal(await readFile(path.join(appDir, "public", artifact.path), "utf8"), `fixture-${artifact.target}`);
  }
  assert.equal(await readFile(path.join(root, "app/public/sonli-extension-0.13.46.38.zip"), "utf8"), "old ZIP A");
});
