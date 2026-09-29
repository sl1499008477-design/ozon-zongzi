import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import COS from "cos-nodejs-sdk-v5";
import { createListingMediaStorage } from "../listing-media-storage.mjs";
import { createAiListingImagePort } from "../ai-listing-runtime.mjs";
import { createAiListingResultStore } from "../ai-listing-image-cache.mjs";
import { createOzonListingMedia } from "../ozon-listing-media.mjs";

const env = { LISTING_MEDIA_STORAGE: "cos", LISTING_COS_BUCKET: "public-media-1250000000",
  LISTING_COS_REGION: "ap-shanghai", LISTING_COS_SECRET_ID: "fixture-id", LISTING_COS_SECRET_KEY: "fixture-key" };
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const sample = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

// Only the remote COS HTTP boundary is replaced. Requests, checksums, SDK file
// streaming/multipart, response parsing and production storage code are real.
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "cos-sdk-test-"));
  const objects = new Map(), requests = [], multipart = new Map(), serverErrors = [];
  let denyNextPut = false;
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost"), key = decodeURIComponent(url.pathname).slice(1);
      const chunks = []; for await (const chunk of req) chunks.push(chunk); const bytes = Buffer.concat(chunks);
      requests.push({ method: req.method, key, bytes, headers: req.headers, query: url.searchParams });
      const etag = '"' + createHash("md5").update(bytes).digest("hex") + '"';
      const xml = body => { res.writeHead(200, { "Content-Type": "application/xml" }); res.end(body); };
      if (req.method === "GET" && url.searchParams.has("uploads")) return xml("<ListMultipartUploadsResult><IsTruncated>false</IsTruncated></ListMultipartUploadsResult>");
      if (req.method === "POST" && url.searchParams.has("uploads")) {
        multipart.set(key, { headers: req.headers, parts: new Map() });
        return xml(`<InitiateMultipartUploadResult><Bucket>${env.LISTING_COS_BUCKET}</Bucket><Key>${key}</Key><UploadId>fixture-upload</UploadId></InitiateMultipartUploadResult>`);
      }
      if (req.method === "PUT") {
        if (denyNextPut) { denyNextPut = false; res.writeHead(403, { "Content-Type": "application/xml" }); res.end("<Error><Code>AccessDenied</Code><Message>fixture denial</Message></Error>"); return; }
        if (url.searchParams.has("partNumber")) multipart.get(key).parts.set(Number(url.searchParams.get("partNumber")), bytes);
        else objects.set(key, { bytes, headers: req.headers, etag });
        res.writeHead(200, { ETag: etag }); res.end(); return;
      }
      if (req.method === "POST" && url.searchParams.has("uploadId")) {
        const upload = multipart.get(key), combined = Buffer.concat([...upload.parts].sort(([a], [b]) => a - b).map(([, value]) => value));
        objects.set(key, { bytes: combined, headers: upload.headers, etag: '"multipart-etag"' });
        return xml(`<CompleteMultipartUploadResult><Bucket>${env.LISTING_COS_BUCKET}</Bucket><Key>${key}</Key><ETag>"multipart-etag"</ETag></CompleteMultipartUploadResult>`);
      }
      if (req.method === "HEAD") {
        const object = objects.get(key);
        if (!object) { res.writeHead(key === "forbidden" ? 403 : 404); res.end(); return; }
        const metadata = Object.fromEntries(Object.entries(object.headers).filter(([name]) => name.startsWith("x-cos-meta-") || ["content-type", "cache-control"].includes(name)));
        res.writeHead(200, { ...metadata, "Content-Length": object.bytes.length, ETag: object.etag }); res.end(); return;
      }
      throw new Error(`Unexpected local COS request ${req.method} ${req.url}`);
    } catch (error) { serverErrors.push(error.message); res.writeHead(500); res.end(); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); assert.deepEqual(serverErrors, []); });
  const cosClient = new COS({ SecretId: env.LISTING_COS_SECRET_ID, SecretKey: env.LISTING_COS_SECRET_KEY,
    Domain: `127.0.0.1:${server.address().port}`, Protocol: "http:", UploadCheckContentMd5: true,
    ConfCwd: directory, Timeout: 2000, KeepAlive: false, ChunkRetryTimes: 0 });
  return { directory, objects, requests, storage: createListingMediaStorage({ env, cosClient }), denyNextPut: () => { denyNextPut = true; } };
}

test("real SDK preserves a failed paid result, publishes formal/preview bytes and prepares new plus historical URLs", async t => {
  const f = await fixture(t), resultStore = createAiListingResultStore({ directory: join(f.directory, "results"), minFreeBytes: 0 });
  const publication = { baseUrl: "https://assets.example.test/", prefix: "listing-media/v1" };
  const input = { accountId: "account", taskId: "task", sku: "sku", index: 0, sourceUrl: "https://source.test/image.png",
    prompt: "preserve product", image: { ratio: "3:4", resolution: "1K", quality: "high", language: "ru" }, requestKey: "original" };
  let generations = 0;
  const port = createAiListingImagePort({ publication, resultStore, putObject: f.storage.putObjectFromBuffer,
    loadProfile: async () => ({ imageModel: "fixture" }), downloadImage: async () => ({ buffer: sample, contentType: "image/png" }),
    gateway: { generateImage: async () => { generations++; return { bytes: sample, contentType: "image/png" }; } } });
  f.denyNextPut(); await assert.rejects(port(input), { code: "AI_LISTING_STORAGE_FAILED" });
  assert.equal(f.objects.size, 0); assert.deepEqual((await resultStore.load(input, "SINGLE")).bytes, sample);
  const image = await port({ ...input, requestKey: "retry" });
  assert.equal(generations, 1); assert.equal(f.objects.size, 2); assert.deepEqual(f.objects.get(image.objectKey).bytes, sample);
  assert.equal(f.requests.filter(item => item.method === "PUT")[0].key, image.objectKey);
  const uploads = f.requests.filter(item => item.method === "PUT");
  for (const upload of uploads) {
    assert.equal(upload.headers["content-md5"], createHash("md5").update(upload.bytes).digest("base64"));
    assert.equal(upload.headers["cache-control"], "public,max-age=31536000,immutable");
    assert.equal(upload.headers["x-cos-meta-content-sha256"], hash(upload.bytes));
  }
  let downloads = 0;
  const oldUrl = `https://www.ozonzongzi.com/listing-media/v1/ai-image-listing/${"b".repeat(64)}.png`;
  const items = [{ offer_id: "one", images: [image.generatedUrl, oldUrl], primary_image: image.generatedUrl }], before = structuredClone(items);
  const prepare = createOzonListingMedia({ publication, downloadBaseUrl: publication.baseUrl, ...f.storage,
    downloadImage: async ({ sourceUrl }) => { assert.equal(sourceUrl, oldUrl); downloads++; return { bytes: sample, contentType: "image/png", contentHash: hash(sample) }; } });
  const first = await prepare({ accountId: "account", taskId: "task", items });
  assert.equal(first[0].images[0], image.generatedUrl); assert.equal(first[0].primary_image, image.generatedUrl);
  assert.match(first[0].images[1], /^https:\/\/assets\.example\.test\/listing-media\/v1\/prepared\/[a-f0-9]{64}\.png$/);
  assert.deepEqual(await prepare({ accountId: "account", taskId: "task", items }), first);
  assert.equal(downloads, 1); assert.deepEqual(items, before);
  const head = await f.storage.statObject(image.objectKey);
  assert.equal(head.size, sample.length); assert.equal(head.contentType, "image/png"); assert.equal(head.sha256, hash(sample));
  await assert.rejects(f.storage.statObject("missing"), error => error.statusCode === 404);
  await assert.rejects(f.storage.statObject("forbidden"), error => error.statusCode === 403);
});

test("real SDK streams small files and checksummed multipart video uploads with their original metadata", async t => {
  const f = await fixture(t);
  for (const size of [128 * 1024, 2 * 1024 ** 2 + 123]) {
    const bytes = Buffer.alloc(size, 7), path = join(f.directory, `${size}.mp4`), key = `listing-media/v1/prepared/${size}.mp4`;
    await writeFile(path, bytes);
    const saved = await f.storage.putObjectFromFile({ key, path, contentType: "video/mp4", metadata: { "X-Amz-Meta-Content-Sha256": hash(bytes) } });
    assert.equal(saved.size, size); assert.equal(saved.sha256, hash(bytes)); assert.deepEqual(f.objects.get(key).bytes, bytes);
    const head = await f.storage.statObject(key);
    assert.equal(head.size, size); assert.equal(head.contentType, "video/mp4"); assert.equal(head.sha256, hash(bytes));
    assert.equal(head.metaData["cache-control"], "public,max-age=31536000,immutable");
  }
  const parts = f.requests.filter(req => req.query.has("partNumber"));
  assert.equal(parts.length, 3);
  for (const part of parts) {
    assert.ok(part.bytes.length <= 1024 ** 2);
    assert.equal(part.headers["content-md5"], createHash("md5").update(part.bytes).digest("base64"));
  }
});
