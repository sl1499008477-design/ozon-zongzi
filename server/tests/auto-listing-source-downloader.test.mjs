import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import sharp from "sharp";

const load = () => import("../auto-listing-source-downloader.mjs");

function fakeRequester(definitions, captures = []) {
  let index = 0;
  return (target, requestOptions, onResponse) => {
    const definition = definitions[Math.min(index, definitions.length - 1)] || {};
    index += 1;
    captures.push({ target: target.href, requestOptions });
    const request = new EventEmitter();
    request.setTimeout = (_timeoutMs, callback) => {
      if (definition.timeout) queueMicrotask(callback);
      return request;
    };
    request.destroy = (error) => queueMicrotask(() => request.emit("error", error));
    request.end = () => {
      if (definition.timeout) return;
      queueMicrotask(() => {
        const response = new EventEmitter();
        response.statusCode = definition.status ?? 200;
        response.headers = definition.headers || {};
        response.resume = () => {};
        response.destroy = () => {};
        onResponse(response);
        for (const chunk of definition.chunks || []) response.emit("data", chunk);
        response.emit("end");
      });
    };
    return request;
  };
}

const publicDns = async () => [{ address: "93.184.216.34", family: 4 }];

test("source downloader rejects non-http URLs and URL credentials before requesting the network", async () => {
  const { createAutoListingSourceImageDownloader } = await load();
  let requests = 0;
  const downloader = createAutoListingSourceImageDownloader({
    lookupHost: publicDns,
    requestImage() { requests += 1; throw new Error("must not request"); },
  });
  for (const sourceUrl of ["data:image/png;base64,AA==", "file:///etc/passwd", "https://user:secret@images.example.test/a.png"]) {
    await assert.rejects(
      downloader.downloadSourceImage({ sourceUrl, timeoutMs: 10_000, maxBytes: 8 * 1024 * 1024, maxRedirects: 3, forbidHttpsDowngrade: true }),
      (error) => error?.code === "AUTO_LISTING_SOURCE_DOWNLOAD_BLOCKED" && error?.retryable === false
        && !error.message.includes(sourceUrl) && error.cause === undefined,
    );
  }
  assert.equal(requests, 0);
});

test("source downloader rejects unknown or secret-bearing Port fields before network I/O", async () => {
  const { createAutoListingSourceImageDownloader } = await load();
  let requests = 0;
  const downloader = createAutoListingSourceImageDownloader({
    lookupHost: publicDns,
    requestImage() { requests += 1; throw new Error("must not request"); },
  });
  await assert.rejects(
    downloader.downloadSourceImage({
      sourceUrl: "https://images.example.test/a.png", timeoutMs: 10_000, maxBytes: 1024,
      maxRedirects: 3, forbidHttpsDowngrade: true, apiKey: "must-not-enter-this-contract",
    }),
    (error) => error?.code === "AUTO_LISTING_SOURCE_DOWNLOAD_INPUT_INVALID",
  );
  await assert.rejects(
    downloader.downloadSourceImage({
      sourceUrl: "https://images.example.test/a.png", timeoutMs: 10_000,
      maxBytes: 8 * 1024 * 1024 + 1, maxPixels: 40_000_001, maxRedirects: 4, forbidHttpsDowngrade: true,
    }),
    (error) => error?.code === "AUTO_LISTING_SOURCE_DOWNLOAD_INPUT_INVALID",
  );
  assert.equal(requests, 0);
});

test("source downloader rejects private or mixed DNS answers and pins the validated public address", async () => {
  const { createAutoListingSourceImageDownloader } = await load();
  let requests = 0;
  const privateDownloader = createAutoListingSourceImageDownloader({
    lookupHost: async () => [{ address: "93.184.216.34", family: 4 }, { address: "127.0.0.1", family: 4 }],
    requestImage() { requests += 1; throw new Error("must not request"); },
  });
  await assert.rejects(
    privateDownloader.downloadSourceImage({ sourceUrl: "https://images.example.test/a.png", timeoutMs: 10_000, maxBytes: 1024, maxRedirects: 3, forbidHttpsDowngrade: true }),
    (error) => error?.code === "AUTO_LISTING_SOURCE_DOWNLOAD_BLOCKED",
  );
  assert.equal(requests, 0);

  const png = await sharp({ create: { width: 2, height: 3, channels: 4, background: "red" } }).png().toBuffer();
  const captures = [];
  const downloader = createAutoListingSourceImageDownloader({
    lookupHost: publicDns,
    requestImage: fakeRequester([{ headers: { "content-type": "image/png", "content-length": String(png.length) }, chunks: [png] }], captures),
  });
  const downloaded = await downloader.downloadSourceImage({ sourceUrl: "https://images.example.test/a.png", timeoutMs: 10_000, maxBytes: 1024, maxRedirects: 3, forbidHttpsDowngrade: true });
  assert.deepEqual({ contentType: downloaded.contentType, width: downloaded.width, height: downloaded.height, sizeBytes: downloaded.sizeBytes }, { contentType: "image/png", width: 2, height: 3, sizeBytes: png.length });
  await new Promise((resolve, reject) => captures[0].requestOptions.lookup("images.example.test", {}, (error, address, family) => {
    if (error) reject(error);
    else { assert.equal(address, "93.184.216.34"); assert.equal(family, 4); resolve(); }
  }));
});

test("source downloader accepts Ozon image CDN through benchmark-range proxy DNS only", async () => {
  const { createAutoListingSourceImageDownloader } = await load();
  const png = await sharp({ create: { width: 2, height: 3, channels: 4, background: "red" } }).png().toBuffer();
  const benchmarkDns = async () => [{ address: "198.18.0.13", family: 4 }];
  const downloader = createAutoListingSourceImageDownloader({
    lookupHost: benchmarkDns,
    requestImage: fakeRequester([{
      headers: { "content-type": "image/png", "content-length": String(png.length) },
      chunks: [png],
    }]),
  });

  const downloaded = await downloader.downloadSourceImage({
    sourceUrl: "https://ir-20.ozone.ru/s3/multimedia-1-5/wc1000/example.png",
    timeoutMs: 10_000,
    maxBytes: 1024,
    maxRedirects: 3,
    forbidHttpsDowngrade: true,
  });
  assert.deepEqual(
    { contentType: downloaded.contentType, width: downloaded.width, height: downloaded.height },
    { contentType: "image/png", width: 2, height: 3 },
  );

  for (const [sourceUrl, address] of [
    ["https://images.example.test/a.png", "198.18.0.13"],
    ["https://ir-20.ozone.ru.evil.test/a.png", "198.18.0.13"],
    ["http://ir-20.ozone.ru/a.png", "198.18.0.13"],
    ["https://ir-20.ozone.ru/a.png", "10.0.0.9"],
  ]) {
    const blocked = createAutoListingSourceImageDownloader({
      lookupHost: async () => [{ address, family: 4 }],
      requestImage() { throw new Error("must not request"); },
    });
    await assert.rejects(
      blocked.downloadSourceImage({
        sourceUrl,
        timeoutMs: 10_000,
        maxBytes: 1024,
        maxRedirects: 3,
        forbidHttpsDowngrade: true,
      }),
      (error) => error?.code === "AUTO_LISTING_SOURCE_DOWNLOAD_BLOCKED",
    );
  }

  for (const location of [
    "https://images.example.test/redirected.png",
    "http://ir-20.ozone.ru/redirected.png",
  ]) {
    const redirected = createAutoListingSourceImageDownloader({
      lookupHost: benchmarkDns,
      requestImage: fakeRequester([{ status: 302, headers: { location } }]),
    });
    await assert.rejects(
      redirected.downloadSourceImage({
        sourceUrl: "https://ir-20.ozone.ru/original.png",
        timeoutMs: 10_000,
        maxBytes: 1024,
        maxRedirects: 3,
        forbidHttpsDowngrade: true,
      }),
      (error) => error?.code === "AUTO_LISTING_SOURCE_DOWNLOAD_BLOCKED",
    );
  }
});

test("source downloader rejects IPv6 benchmark and ORCHID special-purpose DNS answers before requesting", async () => {
  const { createAutoListingSourceImageDownloader } = await load();
  for (const address of ["2001:2::1", "2001:20::1"]) {
    let requests = 0;
    const downloader = createAutoListingSourceImageDownloader({
      lookupHost: async () => [{ address, family: 6 }],
      requestImage() { requests += 1; throw new Error("must not request"); },
    });
    await assert.rejects(
      downloader.downloadSourceImage({
        sourceUrl: "https://images.example.test/a.png",
        timeoutMs: 10_000,
        maxBytes: 1024,
        maxRedirects: 3,
        forbidHttpsDowngrade: true,
      }),
      (error) => error?.code === "AUTO_LISTING_SOURCE_DOWNLOAD_BLOCKED" && error?.retryable === false,
    );
    assert.equal(requests, 0);
  }
});

test("source downloader rejects every HTTPS downgrade while the collector compatibility default remains opt-in", async () => {
  const { createAutoListingSourceImageDownloader } = await load();
  const downloader = createAutoListingSourceImageDownloader({
    lookupHost: publicDns,
    requestImage: fakeRequester([{ status: 302, headers: { location: "http://public.example.test/a.png" } }]),
  });
  await assert.rejects(
    downloader.downloadSourceImage({ sourceUrl: "https://images.example.test/a.png", timeoutMs: 10_000, maxBytes: 1024, maxRedirects: 3, forbidHttpsDowngrade: true }),
    (error) => error?.code === "AUTO_LISTING_SOURCE_DOWNLOAD_BLOCKED" && error?.retryable === false,
  );
});

test("source downloader closes timeout, byte, MIME and magic failures behind stable safe errors", async () => {
  const { createAutoListingSourceImageDownloader } = await load();
  const cases = [
    [{ timeout: true }, "AUTO_LISTING_SOURCE_DOWNLOAD_FAILED", true],
    [{ headers: { "content-type": "image/png", "content-length": "2000" } }, "AUTO_LISTING_SOURCE_IMAGE_TOO_LARGE", false],
    [{ headers: { "content-type": "text/html" }, chunks: [Buffer.from("<secret>")] }, "AUTO_LISTING_SOURCE_IMAGE_INVALID", false],
    [{ headers: { "content-type": "image/jpeg" }, chunks: [Buffer.from("not-a-jpeg")] }, "AUTO_LISTING_SOURCE_IMAGE_INVALID", false],
  ];
  for (const [definition, code, retryable] of cases) {
    const downloader = createAutoListingSourceImageDownloader({ lookupHost: publicDns, requestImage: fakeRequester([definition]) });
    await assert.rejects(
      downloader.downloadSourceImage({ sourceUrl: "https://images.example.test/sensitive?token=secret", timeoutMs: 250, maxBytes: 1024, maxRedirects: 3, forbidHttpsDowngrade: true }),
      (error) => error?.code === code && error?.retryable === retryable
        && !/secret|images\.example/u.test(error.message) && error.cause === undefined,
    );
  }
});

test("source downloader decodes only single-frame PNG JPEG or WebP within the pixel limit", async () => {
  const { createAutoListingSourceImageDownloader } = await load();
  const animatedGif = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH/C05FVFNDQVBFMi4wAwEAAAAh+QQJAAABACwAAAAAAQABAAACAkQBADs=", "base64");
  const tooManyPixels = await sharp({ create: { width: 11, height: 10, channels: 3, background: "blue" } }).png().toBuffer();
  for (const [contentType, bytes, maxPixels] of [["image/gif", animatedGif, 1000], ["image/png", tooManyPixels, 100]]) {
    const downloader = createAutoListingSourceImageDownloader({
      lookupHost: publicDns,
      requestImage: fakeRequester([{ headers: { "content-type": contentType }, chunks: [bytes] }]),
    });
    await assert.rejects(
      downloader.downloadSourceImage({ sourceUrl: "https://images.example.test/a", timeoutMs: 10_000, maxBytes: 1024 * 1024, maxRedirects: 3, maxPixels, forbidHttpsDowngrade: true }),
      (error) => error?.code === "AUTO_LISTING_SOURCE_IMAGE_INVALID",
    );
  }
});
