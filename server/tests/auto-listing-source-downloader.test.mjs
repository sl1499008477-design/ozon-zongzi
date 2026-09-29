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
const diagnosticInput = { sourceUrl: 'https://images.example.test/second.png?signature=private#private', timeoutMs: 10000,
  maxBytes: 1024, maxRedirects: 3, forbidHttpsDowngrade: true };

test('failed source identifies its own URL, underlying cause and bounded retry waits without signed credentials', async () => {
  const { createAutoListingSourceImageDownloader } = await load();
  let now = 100, reads = 0;
  const waits = [];
  const downloader = createAutoListingSourceImageDownloader({ clock: () => now,
    sleep: async ms => { waits.push(ms); now += ms; },
    downloadImage: async () => { reads++; now += 40;
      throw Object.assign(new Error('private signed URL must not escape', { cause: Object.assign(new Error('private'), { code: 'ECONNRESET' }) }),
        { code: 'COLLECTOR_EXCEL_IMAGE_DOWNLOAD_FAILED' }); },
  });
  await assert.rejects(downloader.downloadSourceImage(diagnosticInput), error => {
    assert.equal(error.code, 'AUTO_LISTING_SOURCE_DOWNLOAD_FAILED');
    assert.equal(error.diagnostic.sourceUrl, 'https://images.example.test/second.png');
    assert.equal(error.diagnostic.attemptCount, 3);
    assert.equal(error.diagnostic.elapsedMs, 870);
    assert.deepEqual(error.diagnostic.attempts.map(value => [value.upstreamCode, value.elapsedMs]),
      [['ECONNRESET', 40], ['ECONNRESET', 40], ['ECONNRESET', 40]]);
    assert.doesNotMatch(JSON.stringify(error), /private|signature/);
    return true;
  });
  assert.equal(reads, 3);
  assert.deepEqual(waits, [250, 500]);
});

test('a missing image after a signed redirect keeps the actual HTTP status and is not retried', async () => {
  const { createAutoListingSourceImageDownloader } = await load();
  const requests = [], waits = [];
  const downloader = createAutoListingSourceImageDownloader({ lookupHost: publicDns,
    sleep: async ms => waits.push(ms),
    requestImage: fakeRequester([{ status: 302, headers: { location: 'https://cdn.example.test/missing.png?token=private' } }, { status: 404 }], requests),
  });
  await assert.rejects(downloader.downloadSourceImage(diagnosticInput), error => {
    assert.equal(error.retryable, false);
    assert.equal(error.diagnostic.failedUrl, 'https://cdn.example.test/missing.png');
    assert.equal(error.diagnostic.attempts[0].httpStatus, 404);
    assert.equal(error.diagnostic.attempts[0].stage, 'request');
    assert.equal(error.diagnostic.attemptCount, 1);
    assert.doesNotMatch(JSON.stringify(error), /private|token|signature/);
    return true;
  });
  assert.equal(requests.length, 2);
  assert.deepEqual(waits, []);
});

test('DNS failures retain phase timing and the resolver error code', async () => {
  const { createAutoListingSourceImageDownloader } = await load();
  let now = 0;
  const downloader = createAutoListingSourceImageDownloader({ clock: () => now, sleep: async ms => { now += ms; },
    lookupHost: async () => { now += 12; throw Object.assign(new Error('private hostname'), { code: 'EAI_AGAIN' }); },
  });
  await assert.rejects(downloader.downloadSourceImage(diagnosticInput), error => {
    assert.equal(error.diagnostic.attempts[2].stage, 'dns');
    assert.equal(error.diagnostic.attempts[2].dnsMs, 12);
    assert.equal(error.diagnostic.attempts[2].upstreamCode, 'EAI_AGAIN');
    return true;
  });
});

test('invalid image bytes retain the inspection phase and never schedule a retry', async () => {
  const { createAutoListingSourceImageDownloader } = await load();
  let reads = 0;
  const invalid = createAutoListingSourceImageDownloader({ sleep: async () => assert.fail('invalid bytes cannot retry'),
    downloadImage: async () => { reads++; return { buffer: Buffer.from('not an image'), contentType: 'image/png' }; },
  });
  await assert.rejects(invalid.downloadSourceImage(diagnosticInput), error => {
    assert.equal(error.code, 'AUTO_LISTING_SOURCE_IMAGE_INVALID');
    assert.equal(error.diagnostic.attempts[0].stage, 'inspect');
    return true;
  });
  assert.equal(reads, 1);
});

test('connection failures retain time before headers and TLS certificate failures do not retry', async () => {
  const { createAutoListingSourceImageDownloader } = await load();
  let now = 0, reads = 0;
  const downloader = createAutoListingSourceImageDownloader({ clock: () => now,
    sleep: async () => assert.fail('certificate errors cannot retry'), lookupHost: publicDns,
    requestImage: () => {
      reads++;
      const request = new EventEmitter();
      request.setTimeout = () => request;
      request.end = () => queueMicrotask(() => { now += 40; request.emit('error', Object.assign(new Error('private URL'), { code: 'CERT_HAS_EXPIRED' })); });
      return request;
    },
  });
  await assert.rejects(downloader.downloadSourceImage(diagnosticInput), error => {
    assert.equal(error.retryable, false);
    assert.equal(error.diagnostic.attempts[0].upstreamCode, 'CERT_HAS_EXPIRED');
    assert.equal(error.diagnostic.attempts[0].requestMs, 40);
    return true;
  });
  assert.equal(reads, 1);
});

test('an interrupted HTTP 200 body retries and records body time rather than treating headers as success', async () => {
  const { createAutoListingSourceImageDownloader } = await load();
  let now = 0, reads = 0;
  const waits = [];
  const downloader = createAutoListingSourceImageDownloader({ clock: () => now, lookupHost: publicDns,
    sleep: async ms => { waits.push(ms); now += ms; },
    requestImage: (_target, _options, respond) => {
      reads++;
      const request = new EventEmitter();
      request.setTimeout = () => request;
      request.end = () => queueMicrotask(() => {
        const response = new EventEmitter();
        response.statusCode = 200; response.headers = { 'content-type': 'image/png' };
        respond(response); now += 25; response.emit('aborted');
      });
      return request;
    },
  });
  await assert.rejects(downloader.downloadSourceImage(diagnosticInput), error => {
    assert.equal(error.retryable, true);
    assert.equal(error.diagnostic.attempts[2].stage, 'body');
    assert.equal(error.diagnostic.attempts[2].bodyMs, 25);
    assert.equal(error.diagnostic.attempts[2].httpStatus, 200);
    return true;
  });
  assert.equal(reads, 3); assert.deepEqual(waits, [250, 500]);
});

test('invalid null input preserves the public input error even with diagnostic collection enabled', async () => {
  const { createAutoListingSourceImageDownloader } = await load();
  await assert.rejects(createAutoListingSourceImageDownloader().downloadSourceImage(null), { code: 'AUTO_LISTING_SOURCE_DOWNLOAD_INPUT_INVALID' });
});

test('a redirect DNS failure identifies the destination without misreporting the earlier redirect status', async () => {
  const { createAutoListingSourceImageDownloader } = await load();
  const downloader = createAutoListingSourceImageDownloader({ sleep: async () => {},
    lookupHost: async host => {
      if (host === 'cdn.example.test') throw Object.assign(new Error('offline'), { code: 'EAI_AGAIN' });
      return publicDns();
    },
    requestImage: fakeRequester([{ status: 302, headers: { location: 'https://cdn.example.test/missing.png?token=private' } }]),
  });
  await assert.rejects(downloader.downloadSourceImage(diagnosticInput), error => {
    assert.equal(error.diagnostic.failedUrl, 'https://cdn.example.test/missing.png');
    assert.equal(error.diagnostic.attempts[2].stage, 'dns');
    assert.equal(error.diagnostic.attempts[2].httpStatus, undefined);
    return true;
  });
});

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

test("source downloader retries a transient download failure before returning a valid image", async () => {
  const { createAutoListingSourceImageDownloader } = await load();
  const png = await sharp({ create: { width: 2, height: 3, channels: 4, background: "red" } }).png().toBuffer();
  for (const sourceCode of [
    "COLLECTOR_EXCEL_IMAGE_DNS_FAILED",
    "COLLECTOR_EXCEL_IMAGE_DOWNLOAD_FAILED",
    "COLLECTOR_EXCEL_IMAGE_TIMEOUT",
  ]) {
    let attempts = 0;
    const downloader = createAutoListingSourceImageDownloader({
      async downloadImage() {
        attempts += 1;
        if (attempts === 1) {
          const error = new Error("temporary network failure");
          error.code = sourceCode;
          throw error;
        }
        return { buffer: png, contentType: "image/png" };
      },
    });

    const downloaded = await downloader.downloadSourceImage({
      sourceUrl: "https://images.example.test/a.png",
      timeoutMs: 10_000,
      maxBytes: 1024,
      maxRedirects: 3,
      forbidHttpsDowngrade: true,
    });

    assert.equal(attempts, 2, sourceCode);
    assert.equal(downloaded.contentType, "image/png");
  }
});

test("source downloader caps transient retries and never retries deterministic or unknown failures", async () => {
  const { AUTO_LISTING_SOURCE_DOWNLOAD_POLICY, createAutoListingSourceImageDownloader } = await load();
  const input = {
    sourceUrl: "https://images.example.test/a.png",
    timeoutMs: 10_000,
    maxBytes: 1024,
    maxRedirects: 3,
    forbidHttpsDowngrade: true,
  };

  let transientAttempts = 0;
  const transientDownloader = createAutoListingSourceImageDownloader({
    async downloadImage() {
      transientAttempts += 1;
      const error = new Error("temporary network failure");
      error.code = "COLLECTOR_EXCEL_IMAGE_DOWNLOAD_FAILED";
      throw error;
    },
  });
  await assert.rejects(
    transientDownloader.downloadSourceImage(input),
    (error) => error?.code === "AUTO_LISTING_SOURCE_DOWNLOAD_FAILED" && error?.retryable === true,
  );
  assert.equal(transientAttempts, AUTO_LISTING_SOURCE_DOWNLOAD_POLICY.maxAttempts);

  for (const [sourceCode, expectedCode] of [
    ["COLLECTOR_EXCEL_IMAGE_PRIVATE_ADDRESS", "AUTO_LISTING_SOURCE_DOWNLOAD_BLOCKED"],
    ["COLLECTOR_EXCEL_IMAGE_REDIRECT_INVALID", "AUTO_LISTING_SOURCE_DOWNLOAD_FAILED"],
    ["COLLECTOR_EXCEL_IMAGE_REDIRECT_LIMIT", "AUTO_LISTING_SOURCE_DOWNLOAD_FAILED"],
    ["COLLECTOR_EXCEL_IMAGE_DNS_INVALID", "AUTO_LISTING_SOURCE_DOWNLOAD_FAILED"],
    ["UNEXPECTED_PROGRAMMER_ERROR", "AUTO_LISTING_SOURCE_DOWNLOAD_FAILED"],
  ]) {
    let attempts = 0;
    const downloader = createAutoListingSourceImageDownloader({
      async downloadImage() {
        attempts += 1;
        const error = new Error("deterministic failure");
        error.code = sourceCode;
        throw error;
      },
    });
    await assert.rejects(
      downloader.downloadSourceImage(input),
      (error) => error?.code === expectedCode && error?.retryable === false,
    );
    assert.equal(attempts, 1, sourceCode);
  }
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

test("source downloader trusts only HTTPS Ozon static image CDN hosts behind benchmark proxy DNS", async () => {
  const { createAutoListingSourceImageDownloader } = await load();
  const png = await sharp({ create: { width: 2, height: 3, channels: 4, background: "red" } }).png().toBuffer();
  const benchmarkDns = async () => [{ address: "198.18.0.21", family: 4 }];
  const downloader = createAutoListingSourceImageDownloader({
    lookupHost: benchmarkDns,
    requestImage: fakeRequester([{
      headers: { "content-type": "image/png", "content-length": String(png.length) },
      chunks: [png],
    }]),
  });

  const downloaded = await downloader.downloadSourceImage({
    sourceUrl: "https://ir-20.ozonstatic.cn/s3/multimedia-1-z/example.jpg",
    timeoutMs: 10_000,
    maxBytes: 1024,
    maxRedirects: 3,
    forbidHttpsDowngrade: true,
  });
  assert.deepEqual(
    { contentType: downloaded.contentType, width: downloaded.width, height: downloaded.height },
    { contentType: "image/png", width: 2, height: 3 },
  );

  for (const sourceUrl of [
    "https://ir-20.ozonstatic.cn.evil.test/a.png",
    "http://ir-20.ozonstatic.cn/a.png",
  ]) {
    const blocked = createAutoListingSourceImageDownloader({
      lookupHost: benchmarkDns,
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
