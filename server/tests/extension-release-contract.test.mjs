import assert from "node:assert/strict";
import crypto from "node:crypto";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

const rootDir = path.resolve(import.meta.dirname, "../..");

async function requestJson(handle, pathname) {
  const request = Readable.from([]);
  request.method = "GET";
  request.url = pathname;
  request.headers = {};
  const response = {
    status: 0,
    body: "",
    writeHead(status) { this.status = status; },
    end(body = "") { this.body = String(body); },
  };
  await handle(request, response);
  return { status: response.status, body: JSON.parse(response.body || "{}") };
}

test("0.13.46.2 release metadata and download endpoint stay aligned", async (context) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "sonli-release-contract-"));
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  process.env.QH_LOCAL_DATA_DIR = dataDir;
  process.env.QH_LOCAL_NO_LISTEN = "1";
  process.env.QH_LOCAL_NO_DOTENV = "1";
  process.env.LISTING_PIPELINE_V3 = "0";
  process.env.SONLI_ADMIN_PASSWORD = `release-${crypto.randomUUID()}`;
  delete process.env.DATABASE_URL;
  delete process.env.POSTGRES_HOST;

  const [{ handle }, extensionContract, manifestText, packageText] = await Promise.all([
    import("../index.mjs"),
    import("../../app/src/extension-page-contract.mjs"),
    readFile(path.join(rootDir, "extension/manifest.json"), "utf8"),
    readFile(path.join(rootDir, "package.json"), "utf8"),
  ]);
  const manifest = JSON.parse(manifestText);
  const rootPackage = JSON.parse(packageText);
  const [health, latest] = await Promise.all([
    requestJson(handle, "/health"),
    requestJson(handle, "/extension/latest"),
  ]);

  assert.equal(manifest.version, "0.13.46.2");
  assert.equal(extensionContract.EXTENSION_VERSION, manifest.version);
  assert.equal(extensionContract.EXTENSION_DOWNLOAD_PATH, `/sonli-extension-${manifest.version}.zip`);
  assert.equal(rootPackage.version, `${manifest.version}-local`);
  assert.equal(health.status, 200);
  assert.equal(health.body.version, rootPackage.version);
  assert.equal(latest.status, 200);
  assert.deepEqual(latest.body, {
    version: manifest.version,
    latestVersion: manifest.version,
    downloadUrl: `/sonli-extension-${manifest.version}.zip`,
  });

  for (const currentReleasePath of [
    `app/public/sonli-extension-${manifest.version}`,
    `app/public/sonli-extension-${manifest.version}.zip`,
    `app/dist/sonli-extension-${manifest.version}.zip`,
  ]) {
    await access(path.join(rootDir, currentReleasePath));
  }

  for (const retiredReleasePath of [
    "app/public/sonli-extension-0.13.46.1",
    "app/public/sonli-extension-0.13.46.1.zip",
    "app/dist/sonli-extension-0.13.46.1.zip",
  ]) {
    await assert.rejects(
      access(path.join(rootDir, retiredReleasePath)),
      (error) => error?.code === "ENOENT",
      `retired extension release must not ship: ${retiredReleasePath}`,
    );
  }
});
