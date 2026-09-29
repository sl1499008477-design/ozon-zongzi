import { createReadStream, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { copyFile, mkdir, open, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const moduleRoot = fileURLToPath(new URL("../", import.meta.url));
const artifactTargets = ["mac-arm64", "mac-x64", "win-x64-setup", "win-x64-portable"];
const sourceTargets = ["mac-arm64", "mac-x64", "win-x64"];
const sourceCompanions = ["COPYING.GPLv3", "THIRD-PARTY-NOTICES.txt", "BUILDING.md"];
const prefix = "listing-media/v1/collector/";

function failure(code, message = code) {
  return Object.assign(new Error(message), { code });
}

function check(value, code, message) {
  if (!value) throw failure(code, message);
}

async function digestFile(file) {
  const inputStat = await stat(file);
  check(inputStat.isFile() && inputStat.size > 0, "INPUT_FILE_INVALID");
  const sha = createHash("sha256");
  const md5 = createHash("md5");
  let bytes = 0;
  for await (const chunk of createReadStream(file)) {
    bytes += chunk.length;
    sha.update(chunk);
    md5.update(chunk);
  }
  const md5Bytes = md5.digest();
  check(bytes === inputStat.size, "INPUT_FILE_CHANGED");
  return {
    bytes,
    sha256: sha.digest("hex"),
    md5Hex: md5Bytes.toString("hex"),
    md5Base64: md5Bytes.toString("base64"),
  };
}

async function readJson(file, code) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) throw failure(code);
    throw error;
  }
}

function contentType(name) {
  if (name.endsWith(".zip")) return "application/zip";
  if (name.endsWith(".exe")) return "application/octet-stream";
  if (name.endsWith(".tar.xz")) return "application/x-xz";
  if (name.endsWith(".json")) return "application/json; charset=utf-8";
  return "text/plain; charset=utf-8";
}

function disposition(asciiName, downloadName = asciiName) {
  return `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(downloadName)}`;
}

function header(receipt, name) {
  const headers = receipt?.headers || {};
  const wanted = name.toLowerCase();
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === wanted);
  return entry?.[1];
}

function etag(receipt) {
  return String(receipt?.ETag || header(receipt, "etag") || "").replaceAll('"', "");
}

function versionId(receipt) {
  return receipt?.VersionId || header(receipt, "x-cos-version-id");
}

function validateCosHead(receipt, item) {
  check(receipt, "REMOTE_OBJECT_MISMATCH");
  check(Number(header(receipt, "content-length")) === item.bytes, "REMOTE_OBJECT_MISMATCH");
  check(header(receipt, "x-cos-meta-content-sha256") === item.sha256, "REMOTE_OBJECT_MISMATCH");
  check(etag(receipt) === item.md5Hex, "REMOTE_OBJECT_MISMATCH");
  check(header(receipt, "content-type") === item.contentType, "REMOTE_OBJECT_MISMATCH");
  check(header(receipt, "content-disposition") === item.contentDisposition, "REMOTE_OBJECT_MISMATCH");
  check(header(receipt, "cache-control") === "public,max-age=31536000,immutable", "REMOTE_OBJECT_MISMATCH");
  check(versionId(receipt) && versionId(receipt) !== "null", "REMOTE_OBJECT_VERSION_MISSING");
  return receipt;
}

async function cosHead(client, parameters) {
  try {
    return await client.headObject(parameters);
  } catch (error) {
    if (Number(error.statusCode || error.status) === 404) return null;
    throw error;
  }
}

function publicBaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw failure("COLLECTOR_DOWNLOAD_BASE_URL_INVALID");
  }
  check(url.protocol === "https:", "COLLECTOR_DOWNLOAD_BASE_URL_INVALID");
  check(!url.username && !url.password && !url.search && !url.hash, "COLLECTOR_DOWNLOAD_BASE_URL_INVALID");
  check(url.pathname === "/", "COLLECTOR_DOWNLOAD_BASE_URL_INVALID");
  return url;
}

async function collectRelease({ projectRoot, source, requireSources }) {
  const desktopPackage = await readJson(path.join(projectRoot, "desktop/package.json"), "DESKTOP_PACKAGE_INVALID");
  const version = desktopPackage.version;
  check(typeof version === "string" && /^\d+\.\d+\.\d+$/.test(version), "DESKTOP_PACKAGE_INVALID");
  const objects = [];
  const artifacts = [];

  for (const target of artifactTargets) {
    const extension = target.startsWith("mac-") ? "zip" : "exe";
    const localName = `ozon 粽子-v${version}-${target}.${extension}`;
    const localPath = path.join(source, localName);
    let facts;
    try {
      facts = await digestFile(localPath);
    } catch (error) {
      if (error.code === "ENOENT") {
        if (requireSources) throw failure("RELEASE_INPUT_MISSING", localName);
        continue;
      }
      throw error;
    }
    const asciiName = `ozon-zongzi-v${version}-${target}.${extension}`;
    const key = `${prefix}${version}/${target}-${facts.sha256.slice(0, 16)}/${asciiName}`;
    objects.push({ target, localPath, key, asciiName, downloadName: localName, contentType: contentType(localName), ...facts });
    artifacts.push({ target, path: requireSources ? null : `/downloads/collector/${localName}`, bytes: facts.bytes, sha256: facts.sha256 });
  }
  check(objects.length > 0, "RELEASE_INPUT_MISSING", `未找到 ${version} 的桌面下载包，请先完成打包。`);
  if (!requireSources) return { version, objects, manifest: { version, artifacts } };
  check(objects.length === artifactTargets.length, "RELEASE_INPUT_MISSING");

  const lock = await readJson(path.join(projectRoot, "desktop/media-tools.lock.json"), "SOURCE_INPUT_INVALID");
  check(lock.schema === 1 && typeof lock.version === "string" && lock.targets, "SOURCE_INPUT_INVALID");
  const sources = [];
  for (const target of sourceTargets) {
    const directory = path.join(source, "ffmpeg-source", target);
    const releasePath = path.join(directory, "SOURCE-RELEASE.json");
    const release = await readJson(releasePath, "SOURCE_INPUT_INVALID");
    const archiveName = `ffmpeg-${lock.version}-${target}-source.tar.xz`;
    const allowed = [archiveName, ...sourceCompanions, "SOURCE-RELEASE.json"];
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") throw failure("SOURCE_INPUT_INVALID");
      throw error;
    }
    check(entries.length === allowed.length && entries.every(entry => entry.isFile() && allowed.includes(entry.name)), "SOURCE_INPUT_INVALID");
    check(release.schema === 1 && release.target === target && release.ffmpegVersion === lock.version, "SOURCE_INPUT_INVALID");
    check(release.sourceArchive === archiveName, "SOURCE_INPUT_INVALID");
    check(release.files && Object.keys(release.files).sort().join("\n") === [archiveName, ...sourceCompanions].sort().join("\n"), "SOURCE_INPUT_INVALID");
    const lockedHashes = (lock.targets[target]?.archives || []).map(item => item.sha256).sort();
    check(lockedHashes.length > 0 && lockedHashes.every(value => /^[a-f0-9]{64}$/.test(value)), "SOURCE_INPUT_INVALID");
    check(Array.isArray(release.binaryArchiveSha256) && release.binaryArchiveSha256.slice().sort().join("\n") === lockedHashes.join("\n"), "SOURCE_INPUT_INVALID");

    const publishedFiles = [];
    for (const name of allowed) {
      const localPath = path.join(directory, name);
      const facts = await digestFile(localPath);
      if (name !== "SOURCE-RELEASE.json") check(release.files[name] === facts.sha256, "SOURCE_INPUT_INVALID");
      const kind = name === archiveName ? "source" : name === "BUILDING.md" ? "building" : name === "SOURCE-RELEASE.json" ? "release" : "license";
      const key = `${prefix}${version}/ffmpeg-source/${target}/${facts.sha256.slice(0, 16)}/${name}`;
      objects.push({ target, localPath, key, asciiName: name, downloadName: name, contentType: contentType(name), ...facts });
      publishedFiles.push({ kind, name, path: null, bytes: facts.bytes, sha256: facts.sha256 });
    }
    sources.push({ target, ffmpegVersion: release.ffmpegVersion, binaryArchiveSha256: lockedHashes, files: publishedFiles });
  }
  return { version, objects, manifest: { version, artifacts, sources } };
}

async function uploadAndVerify({ item, client, bucket, region, baseUrl, fetchImpl }) {
  const parameters = { Bucket: bucket, Region: region, Key: item.key };
  let receipt = await cosHead(client, parameters);
  if (receipt) {
    validateCosHead(receipt, item);
  } else {
    const stream = createReadStream(item.localPath);
    try {
      await client.putObject({
        ...parameters,
        Body: stream,
        ContentLength: item.bytes,
        ContentMD5: item.md5Base64,
        ContentType: item.contentType,
        CacheControl: "public,max-age=31536000,immutable",
        ContentDisposition: item.contentDisposition,
        "x-cos-meta-content-sha256": item.sha256,
      });
    } catch (error) {
      receipt = await cosHead(client, parameters);
      if (!receipt) throw error;
    } finally {
      stream.destroy();
    }
    receipt = validateCosHead(await cosHead(client, parameters), item);
  }

  const url = new URL(item.key, baseUrl).href;
  const requestOptions = headers => ({
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
    headers: { "Accept-Encoding": "identity", ...headers },
  });
  const publicHead = await fetchImpl(url, { ...requestOptions(), method: "HEAD" });
  check(publicHead.status === 200, "PUBLIC_OBJECT_MISMATCH");
  check(Number(publicHead.headers.get("content-length")) === item.bytes, "PUBLIC_OBJECT_MISMATCH");
  check(publicHead.headers.get("content-type") === item.contentType, "PUBLIC_OBJECT_MISMATCH");
  check(publicHead.headers.get("x-cos-meta-content-sha256") === item.sha256, "PUBLIC_OBJECT_MISMATCH");
  check(publicHead.headers.get("content-disposition") === item.contentDisposition, "PUBLIC_OBJECT_MISMATCH");
  check(publicHead.headers.get("cache-control") === "public,max-age=31536000,immutable", "PUBLIC_OBJECT_MISMATCH");

  const offsets = item.bytes <= 1024 ? [0] : [0, item.bytes - 1024];
  const handle = await open(item.localPath, "r");
  try {
    for (const offset of offsets) {
      const length = Math.min(1024, item.bytes - offset);
      const expected = Buffer.alloc(length);
      const { bytesRead } = await handle.read(expected, 0, length, offset);
      check(bytesRead === length, "PUBLIC_OBJECT_MISMATCH");
      const end = offset + length - 1;
      const response = await fetchImpl(url, requestOptions({ Range: `bytes=${offset}-${end}` }));
      check(response.status === 206, "PUBLIC_OBJECT_MISMATCH");
      check(response.headers.get("content-range") === `bytes ${offset}-${end}/${item.bytes}`, "PUBLIC_OBJECT_MISMATCH");
      const actual = Buffer.from(await response.arrayBuffer());
      check(actual.equals(expected), "PUBLIC_OBJECT_MISMATCH");
    }
  } finally {
    await handle.close();
  }
  return { url, versionId: versionId(receipt) };
}

async function defaultCosClient(env) {
  const { default: COS } = await import("cos-nodejs-sdk-v5");
  return new COS({
    SecretId: env.LISTING_COS_SECRET_ID,
    SecretKey: env.LISTING_COS_SECRET_KEY,
    Protocol: "https:",
    Timeout: 900_000,
    AutoSwitchHost: false,
  });
}

export async function publishDesktopDownloads({
  projectRoot = moduleRoot,
  source = path.join(projectRoot, "desktop/release"),
  appDir = path.join(projectRoot, "app"),
  mode = "local",
  env = process.env,
  cosClient,
  fetchImpl = globalThis.fetch,
} = {}) {
  source = path.resolve(source);
  appDir = path.resolve(appDir);
  check(mode === "local" || mode === "cos", "PUBLISH_MODE_INVALID");
  const release = await collectRelease({ projectRoot: path.resolve(projectRoot), source, requireSources: mode === "cos" });
  const manifestPath = path.join(appDir, "src/collector-release.json");

  if (mode === "local") {
    const destination = path.join(appDir, "public/downloads/collector");
    await mkdir(destination, { recursive: true });
    for (let index = 0; index < release.objects.length; index += 1) {
      const item = release.objects[index];
      const output = path.join(destination, item.downloadName);
      await copyFile(item.localPath, `${output}.tmp`);
      await rename(`${output}.tmp`, output);
      release.manifest.artifacts[index].path = `/downloads/collector/${item.downloadName}`;
    }
  } else {
    for (const name of ["LISTING_COS_BUCKET", "LISTING_COS_REGION", "LISTING_COS_SECRET_ID", "LISTING_COS_SECRET_KEY"])
      check(typeof env[name] === "string" && env[name].trim(), "COS_CONFIG_INVALID");
    check(typeof fetchImpl === "function", "COS_CONFIG_INVALID");
    const baseUrl = publicBaseUrl(env.COLLECTOR_DOWNLOAD_BASE_URL);
    const client = cosClient || await defaultCosClient(env);
    for (const item of release.objects) {
      item.contentDisposition = disposition(item.asciiName, item.downloadName);
      const verified = await uploadAndVerify({
        item,
        client,
        bucket: env.LISTING_COS_BUCKET,
        region: env.LISTING_COS_REGION,
        baseUrl,
        fetchImpl,
      });
      const artifact = release.manifest.artifacts.find(candidate => candidate.target === item.target && candidate.path === null);
      if (artifact) artifact.path = verified.url;
      else {
        const sourceEntry = release.manifest.sources.find(candidate => candidate.target === item.target);
        sourceEntry.files.find(candidate => candidate.name === item.asciiName).path = verified.url;
      }
    }
  }

  await mkdir(path.dirname(manifestPath), { recursive: true });
  await writeFile(`${manifestPath}.tmp`, `${JSON.stringify(release.manifest, null, 2)}\n`);
  await rename(`${manifestPath}.tmp`, manifestPath);
  return release.manifest;
}

async function main() {
  const args = process.argv.slice(2);
  const mode = args.includes("--cos") ? "cos" : "local";
  const positional = args.filter(value => value !== "--cos");
  check(positional.length <= 2 && positional.every(value => !value.startsWith("--")), "PUBLISH_ARGUMENTS_INVALID");
  const result = await publishDesktopDownloads({
    source: positional[0] || path.join(moduleRoot, "desktop/release"),
    appDir: positional[1] || path.join(moduleRoot, "app"),
    mode,
  });
  console.log(`采集助手 ${result.version}：已发布 ${result.artifacts.length} 个下载包${mode === "cos" ? `及 ${result.sources.length} 组源码材料到 COS` : ""}。`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main().catch(error => {
    console.error(error.code || "DESKTOP_DOWNLOAD_PUBLICATION_FAILED");
    process.exitCode = 1;
  });
}
