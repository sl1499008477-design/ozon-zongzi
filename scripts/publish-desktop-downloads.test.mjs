import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

import * as publisher from "./publish-desktop-downloads.mjs";

const publishDesktopDownloads = publisher.publishDesktopDownloads;

const VERSION = "2.3.4";
const TARGETS = ["mac-arm64", "mac-x64", "win-x64"];
const INSTALLERS = ["mac-arm64", "mac-x64", "win-x64-setup", "win-x64-portable"];
const SOURCE_FILES = ["COPYING.GPLv3", "THIRD-PARTY-NOTICES.txt", "BUILDING.md"];
const ENV = {
  LISTING_COS_BUCKET: "downloads-123",
  LISTING_COS_REGION: "ap-test",
  LISTING_COS_SECRET_ID: "id",
  LISTING_COS_SECRET_KEY: "secret",
  COLLECTOR_DOWNLOAD_BASE_URL: "https://assets.example.test/",
};

const sha256 = data => createHash("sha256").update(data).digest("hex");
const md5 = data => createHash("md5").update(data).digest("hex");

async function fixture(options = {}) {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "collector-downloads-"));
  const source = path.join(projectRoot, "release");
  const appDir = path.join(projectRoot, "external-app");
  await mkdir(path.join(projectRoot, "desktop"), { recursive: true });
  await mkdir(path.join(appDir, "src"), { recursive: true });
  await mkdir(path.join(projectRoot, "app/src"), { recursive: true });
  await mkdir(source, { recursive: true });
  await writeFile(path.join(projectRoot, "desktop/package.json"), JSON.stringify({ version: VERSION }));
  const oldManifest = "{\n  \"version\": \"last-good\",\n  \"artifacts\": []\n}\n";
  await writeFile(path.join(appDir, "src/collector-release.json"), oldManifest);
  await writeFile(path.join(projectRoot, "app/src/collector-release.json"), "daily-sentinel\n");

  const archives = {};
  for (const target of TARGETS) {
    const data = Buffer.from(`binary-${target}`);
    archives[target] = { file: `ffmpeg-${target}.zip`, sha256: sha256(data), bytes: data.length };
  }
  await writeFile(path.join(projectRoot, "desktop/media-tools.lock.json"), JSON.stringify({
    schema: 1,
    version: "9.0.1",
    targets: Object.fromEntries(TARGETS.map(target => [target, { archives: [archives[target]] }])),
  }));

  for (const target of INSTALLERS) {
    if (options.omitArtifact === target) continue;
    const extension = target.startsWith("mac-") ? "zip" : "exe";
    await writeFile(
      path.join(source, `ozon 粽子-v${VERSION}-${target}.${extension}`),
      Buffer.from(`${target}:`.repeat(300)),
    );
  }

  for (const target of TARGETS) {
    const directory = path.join(source, "ffmpeg-source", target);
    await mkdir(directory, { recursive: true });
    const sourceArchive = `ffmpeg-9.0.1-${target}-source.tar.xz`;
    const fileData = {
      [sourceArchive]: Buffer.from(`source-${target}:`.repeat(160)),
      "COPYING.GPLv3": Buffer.from(`GPLv3 ${target}\n`),
      "THIRD-PARTY-NOTICES.txt": Buffer.from(`FFmpeg and x264 notices ${target}\n`),
      "BUILDING.md": Buffer.from(`# Build ${target}\n`),
    };
    for (const [name, data] of Object.entries(fileData)) {
      if (options.omitSourceFile === `${target}/${name}`) continue;
      await writeFile(path.join(directory, name), data);
    }
    const release = {
      schema: 1,
      target,
      ffmpegVersion: "9.0.1",
      binaryArchiveSha256: [archives[target].sha256],
      sourceArchive,
      files: Object.fromEntries(Object.entries(fileData).map(([name, data]) => [name, sha256(data)])),
    };
    await writeFile(path.join(directory, "SOURCE-RELEASE.json"), `${JSON.stringify(release, null, 2)}\n`);
  }
  return { projectRoot, source, appDir, oldManifest };
}

function createRemote({ failAfterStoreKey, rejectWithoutStoreKey, initial = new Map() } = {}) {
  const objects = new Map(initial);
  const puts = [];
  const publicRequests = [];
  let failed = false;
  const missing = () => Object.assign(new Error("missing"), { statusCode: 404 });
  const head = Key => {
    const object = objects.get(Key);
    if (!object) throw missing();
    return {
      ETag: `\"${object.etag}\"`,
      VersionId: object.versionId,
      headers: {
        "content-length": String(object.body.length),
        "content-type": object.contentType,
        "content-disposition": object.contentDisposition,
        "cache-control": object.cacheControl,
        "x-cos-meta-content-sha256": object.sha256,
        "x-cos-version-id": object.versionId,
        etag: `\"${object.etag}\"`,
      },
    };
  };
  const client = {
    async headObject({ Key }) { return head(Key); },
    async putObject(input) {
      const chunks = [];
      for await (const chunk of input.Body) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      assert.equal(body.length, input.ContentLength);
      assert.equal(createHash("md5").update(body).digest("base64"), input.ContentMD5);
      const object = {
        body,
        etag: md5(body),
        sha256: input["x-cos-meta-content-sha256"],
        contentType: input.ContentType,
        contentDisposition: input.ContentDisposition,
        cacheControl: input.CacheControl,
        versionId: `version-${puts.length + 1}`,
      };
      puts.push({ ...input, Body: undefined });
      if (input.Key === rejectWithoutStoreKey) throw new Error("PUT was not accepted");
      objects.set(input.Key, object);
      if (!failed && input.Key === failAfterStoreKey) {
        failed = true;
        throw new Error("response lost after accepted PUT");
      }
      return { ETag: `\"${object.etag}\"`, VersionId: object.versionId };
    },
  };
  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(url);
    const key = decodeURIComponent(parsed.pathname.slice(1));
    const object = objects.get(key);
    publicRequests.push({ url, init });
    if (!object) return new Response(null, { status: 404 });
    const headers = {
      "content-length": String(object.body.length),
      "content-type": object.contentType,
      "content-disposition": object.contentDisposition,
      "cache-control": object.cacheControl,
      "x-cos-meta-content-sha256": object.sha256,
    };
    if (init.method === "HEAD") return new Response(null, { status: 200, headers });
    const match = /^bytes=(\d+)-(\d+)$/.exec(init.headers?.Range || "");
    assert.ok(match, "public verification must use an explicit byte range");
    const start = Number(match[1]);
    const end = Math.min(Number(match[2]), object.body.length - 1);
    return new Response(object.body.subarray(start, end + 1), {
      status: 206,
      headers: { ...headers, "content-length": String(end - start + 1), "content-range": `bytes ${start}-${end}/${object.body.length}` },
    });
  };
  return { client, fetchImpl, objects, puts, publicRequests };
}

async function runCos(f, remote, overrides = {}) {
  return publishDesktopDownloads({
    projectRoot: f.projectRoot,
    source: f.source,
    appDir: f.appDir,
    mode: "cos",
    env: ENV,
    cosClient: remote.client,
    fetchImpl: remote.fetchImpl,
    ...overrides,
  });
}

async function compressionAwareServer(t, objects) {
  const seen = [];
  const server = createServer((request, response) => {
    const key = decodeURIComponent(new URL(request.url, "http://localhost").pathname.slice(1));
    const object = objects.get(key);
    if (!object) {
      response.writeHead(404).end();
      return;
    }
    const acceptEncoding = request.headers["accept-encoding"] || "";
    const identityOnly = acceptEncoding.split(",").map(value => value.trim()).filter(Boolean).every(value => value === "identity");
    const range = request.headers.range;
    seen.push({ method: request.method, acceptEncoding, range });
    const commonHeaders = {
      "content-type": object.contentType,
      "content-disposition": object.contentDisposition,
      "cache-control": object.cacheControl,
      "x-cos-meta-content-sha256": object.sha256,
    };
    if (!identityOnly) {
      const compressed = gzipSync(object.body);
      response.writeHead(200, { ...commonHeaders, "content-encoding": "gzip", "content-length": compressed.length });
      response.end(request.method === "HEAD" ? undefined : compressed);
      return;
    }
    if (range) {
      const match = /^bytes=(\d+)-(\d+)$/.exec(range);
      assert.ok(match);
      const start = Number(match[1]);
      const end = Math.min(Number(match[2]), object.body.length - 1);
      const body = object.body.subarray(start, end + 1);
      response.writeHead(206, {
        ...commonHeaders,
        "content-length": body.length,
        "content-range": `bytes ${start}-${end}/${object.body.length}`,
      });
      response.end(body);
      return;
    }
    response.writeHead(200, { ...commonHeaders, "content-length": object.body.length });
    response.end(request.method === "HEAD" ? undefined : object.body);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const { port } = server.address();
  return {
    seen,
    fetchImpl(url, options) {
      const publicUrl = new URL(url);
      return fetch(`http://127.0.0.1:${port}${publicUrl.pathname}`, options);
    },
  };
}

test("COS publishes four installers and the three verified FFmpeg source sets before replacing the manifest", async t => {
  assert.equal(typeof publishDesktopDownloads, "function", "publisher must expose its injectable release boundary");
  const f = await fixture();
  t.after(() => rm(f.projectRoot, { recursive: true, force: true }));
  const remote = createRemote();

  const result = await runCos(f, remote);
  const manifest = JSON.parse(await readFile(path.join(f.appDir, "src/collector-release.json"), "utf8"));

  assert.equal(result.artifacts.length, 4);
  assert.equal(result.sources.length, 3);
  assert.equal(remote.puts.length, 19);
  assert.deepEqual(manifest, result);
  assert.deepEqual(manifest.artifacts.map(item => item.target), INSTALLERS);
  assert.deepEqual(manifest.sources.map(item => item.target), TARGETS);
  assert.equal(manifest.sources[0].files.length, 5);
  assert.equal(manifest.sources[0].files[0].kind, "source");
  assert.match(manifest.sources[0].files[0].path, /^https:\/\/assets\.example\.test\/listing-media\/v1\/collector\/2\.3\.4\/ffmpeg-source\/mac-arm64\/[a-f0-9]{16}\//);
  assert.ok(manifest.sources.every(item => item.ffmpegVersion === "9.0.1"));
  assert.ok(manifest.sources.every(item => item.binaryArchiveSha256.length === 1));
  assert.ok(remote.puts.every(item => item.Key.startsWith("listing-media/v1/collector/2.3.4/")));
  assert.ok(remote.puts.every(item => /^[\x20-\x7e]+$/.test(item.Key)));
  assert.ok(remote.puts.every(item => item.CacheControl === "public,max-age=31536000,immutable"));
  assert.ok(remote.puts.every(item => item.ContentDisposition.includes("attachment")));
  assert.ok(remote.puts.some(item => item.ContentDisposition.includes("%E7%B2%BD%E5%AD%90")));
  assert.ok(remote.publicRequests.some(item => item.init.method === "HEAD"));
  assert.ok(remote.publicRequests.some(item => item.init.headers?.Range));
  assert.equal(await readFile(path.join(f.projectRoot, "app/src/collector-release.json"), "utf8"), "daily-sentinel\n");

  await runCos(f, remote);
  assert.equal(remote.puts.length, 19, "a second publication must reuse all verified objects");
});

test("public HEAD and Range verify the same identity representation through real Node fetch", async t => {
  const f = await fixture();
  t.after(() => rm(f.projectRoot, { recursive: true, force: true }));
  const remote = createRemote();
  const http = await compressionAwareServer(t, remote.objects);

  const result = await runCos(f, remote, { fetchImpl: http.fetchImpl });

  assert.equal(result.artifacts.length, 4);
  assert.equal(result.sources.length, 3);
  assert.equal(remote.puts.length, 19);
  assert.ok(http.seen.some(request => request.method === "HEAD"));
  assert.ok(http.seen.some(request => request.range));
  assert.ok(http.seen.every(request => request.acceptEncoding.split(",").map(value => value.trim()).filter(Boolean).every(value => value === "identity")));
});

test("a lost PUT response is reconciled by HEAD without uploading the body again", async t => {
  const f = await fixture();
  t.after(() => rm(f.projectRoot, { recursive: true, force: true }));
  const first = await readFile(path.join(f.source, `ozon 粽子-v${VERSION}-mac-arm64.zip`));
  const key = `listing-media/v1/collector/${VERSION}/mac-arm64-${sha256(first).slice(0, 16)}/ozon-zongzi-v${VERSION}-mac-arm64.zip`;
  const remote = createRemote({ failAfterStoreKey: key });

  await runCos(f, remote);

  assert.equal(remote.puts.filter(item => item.Key === key).length, 1);
  assert.equal(remote.objects.size, 19);
});

test("a failed PUT with no object is not retried and keeps the last-good manifest", async t => {
  const f = await fixture();
  t.after(() => rm(f.projectRoot, { recursive: true, force: true }));
  const first = await readFile(path.join(f.source, `ozon 粽子-v${VERSION}-mac-arm64.zip`));
  const key = `listing-media/v1/collector/${VERSION}/mac-arm64-${sha256(first).slice(0, 16)}/ozon-zongzi-v${VERSION}-mac-arm64.zip`;
  const remote = createRemote({ rejectWithoutStoreKey: key });

  await assert.rejects(runCos(f, remote), /PUT was not accepted/);

  assert.equal(remote.puts.filter(item => item.Key === key).length, 1);
  assert.equal(remote.objects.size, 0);
  assert.equal(await readFile(path.join(f.appDir, "src/collector-release.json"), "utf8"), f.oldManifest);
});

test("a mismatched existing object is rejected and the last-good manifest remains", async t => {
  const f = await fixture();
  t.after(() => rm(f.projectRoot, { recursive: true, force: true }));
  const body = await readFile(path.join(f.source, `ozon 粽子-v${VERSION}-mac-arm64.zip`));
  const key = `listing-media/v1/collector/${VERSION}/mac-arm64-${sha256(body).slice(0, 16)}/ozon-zongzi-v${VERSION}-mac-arm64.zip`;
  const wrong = Buffer.from("wrong existing body");
  const remote = createRemote({ initial: new Map([[key, {
    body: wrong,
    etag: md5(wrong),
    sha256: sha256(wrong),
    contentType: "application/zip",
    contentDisposition: "attachment",
    cacheControl: "public,max-age=31536000,immutable",
    versionId: "wrong-version",
  }]]) });

  await assert.rejects(runCos(f, remote), error => error.code === "REMOTE_OBJECT_MISMATCH");
  assert.equal(remote.puts.length, 0);
  assert.equal(await readFile(path.join(f.appDir, "src/collector-release.json"), "utf8"), f.oldManifest);
});

for (const scenario of [
  { name: "a missing installer", fixture: { omitArtifact: "win-x64-portable" }, code: "RELEASE_INPUT_MISSING" },
  { name: "a missing source material", fixture: { omitSourceFile: "win-x64/BUILDING.md" }, code: "SOURCE_INPUT_INVALID" },
]) {
  test(`${scenario.name} fails preflight with zero uploads`, async t => {
    const f = await fixture(scenario.fixture);
    t.after(() => rm(f.projectRoot, { recursive: true, force: true }));
    const remote = createRemote();

    await assert.rejects(runCos(f, remote), error => error.code === scenario.code);
    assert.equal(remote.puts.length, 0);
    assert.equal(await readFile(path.join(f.appDir, "src/collector-release.json"), "utf8"), f.oldManifest);
  });
}

test("changed or non-whitelisted source material fails preflight with zero uploads", async t => {
  await t.test("a changed declared file", async t => {
    const f = await fixture();
    t.after(() => rm(f.projectRoot, { recursive: true, force: true }));
    await writeFile(path.join(f.source, "ffmpeg-source/mac-x64/BUILDING.md"), "changed after release manifest\n");
    const remote = createRemote();
    await assert.rejects(runCos(f, remote), error => error.code === "SOURCE_INPUT_INVALID");
    assert.equal(remote.puts.length, 0);
  });
  await t.test("an extra file", async t => {
    const f = await fixture();
    t.after(() => rm(f.projectRoot, { recursive: true, force: true }));
    await writeFile(path.join(f.source, "ffmpeg-source/win-x64/private-cache.bin"), "must not publish\n");
    const remote = createRemote();
    await assert.rejects(runCos(f, remote), error => error.code === "SOURCE_INPUT_INVALID");
    assert.equal(remote.puts.length, 0);
  });
});

test("a public verification failure keeps the last-good manifest after uploads", async t => {
  const f = await fixture();
  t.after(() => rm(f.projectRoot, { recursive: true, force: true }));
  const remote = createRemote();
  const failingFetch = async () => new Response(null, { status: 503 });

  await assert.rejects(runCos(f, remote, { fetchImpl: failingFetch }), error => error.code === "PUBLIC_OBJECT_MISMATCH");
  assert.ok(remote.puts.length > 0);
  assert.equal(await readFile(path.join(f.appDir, "src/collector-release.json"), "utf8"), f.oldManifest);
});

test("unsafe public base URLs are rejected before any upload", async t => {
  const f = await fixture();
  t.after(() => rm(f.projectRoot, { recursive: true, force: true }));
  for (const value of [
    "http://assets.example.test/",
    "https://user:password@assets.example.test/",
    "https://assets.example.test/?token=secret",
    "https://assets.example.test/#fragment",
  ]) {
    const remote = createRemote();
    await assert.rejects(
      runCos(f, remote, { env: { ...ENV, COLLECTOR_DOWNLOAD_BASE_URL: value } }),
      error => error.code === "COLLECTOR_DOWNLOAD_BASE_URL_INVALID",
    );
    assert.equal(remote.puts.length, 0);
  }
});

test("local mode keeps the existing partial-package behavior and does not require sources", async t => {
  const f = await fixture({ omitArtifact: "win-x64-portable" });
  t.after(() => rm(f.projectRoot, { recursive: true, force: true }));
  await rm(path.join(f.source, "ffmpeg-source"), { recursive: true });

  const result = await publishDesktopDownloads({
    projectRoot: f.projectRoot,
    source: f.source,
    appDir: f.appDir,
    mode: "local",
  });

  assert.equal(result.artifacts.length, 3);
  assert.equal("sources" in result, false);
  for (const item of result.artifacts) {
    assert.match(item.path, /^\/downloads\/collector\//);
    assert.equal((await stat(path.join(f.appDir, "public", item.path))).size, item.bytes);
  }
});

test("the CLI keeps source and appDir as its two local-mode positional arguments", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "collector-downloads-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, "release");
  const appDir = path.join(directory, "app");
  await mkdir(source, { recursive: true });
  const current = JSON.parse(await readFile(new URL("../desktop/package.json", import.meta.url), "utf8"));
  await writeFile(path.join(source, `ozon 粽子-v${current.version}-mac-arm64.zip`), "local package\n");
  const node = process.execPath;
  const script = new URL("./publish-desktop-downloads.mjs", import.meta.url);

  const result = await new Promise(resolve => {
    const child = spawn(node, [fileURLToPath(script), source, appDir], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", data => { stdout += data; });
    child.stderr.on("data", data => { stderr += data; });
    child.on("close", code => resolve({ code, stdout, stderr }));
  });

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /已发布 1 个下载包/);
  const manifest = JSON.parse(await readFile(path.join(appDir, "src/collector-release.json"), "utf8"));
  assert.deepEqual(manifest.artifacts.map(item => item.target), ["mac-arm64"]);
});
