import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

const dataDir = await mkdtemp(path.join(os.tmpdir(), "sonli-multivariant-ingest-"));
const dataFile = path.join(dataDir, "local-state.json");
const token = "multivariant-ingest-token";
const accountId = "acct_multivariant_ingest";

process.env.QH_LOCAL_DATA_DIR = dataDir;
process.env.QH_LOCAL_NO_LISTEN = "1";
process.env.QH_LOCAL_NO_DOTENV = "1";
delete process.env.DATABASE_URL;
delete process.env.POSTGRES_HOST;

await writeFile(dataFile, `${JSON.stringify({
  token,
  currentAccountId: accountId,
  accounts: [{ id: accountId, username: "multi-ingest", role: "admin", status: "active" }],
  sessions: {
    [token]: { token, accountId, issuedAt: new Date().toISOString() },
  },
  currentStoreId: "",
  stores: [],
  caches: { collectBox: [] },
  jobs: {},
  hashes: {},
  leases: {},
  browserAgents: {},
  reports: [],
}, null, 2)}\n`, "utf8");

const { handle } = await import("../index.mjs");

async function invoke(method, url, {
  authorization = "",
  body = undefined,
} = {}) {
  const payload = body === undefined ? "" : JSON.stringify(body);
  const req = Readable.from(payload ? [Buffer.from(payload)] : []);
  req.method = method;
  req.url = url;
  req.headers = {
    ...(authorization ? { authorization } : {}),
    ...(payload ? { "content-type": "application/json" } : {}),
  };
  const res = {
    status: 0,
    body: "",
    writeHead(status) { this.status = status; },
    end(text = "") { this.body = String(text || ""); },
  };
  await handle(req, res);
  return {
    status: res.status,
    body: res.body ? JSON.parse(res.body) : null,
  };
}

const firstSource = {
  description_category_id: 17000001,
  type_id: 910001,
  attributes: [{ key: "500", value: "Красный" }],
};
const secondSource = {
  description_category_id: 17000002,
  type_id: 910002,
  attributes: [{ key: "500", value: "Синий" }],
};
const raw = {
  sku: "sku-red",
  name: "Multi variant product",
  variantData: {
    variants: [
      { sku: "sku-red", name: "Red", sourceVariant: firstSource },
      { sku: "sku-blue", name: "Blue", sourceVariant: secondSource },
    ],
  },
};

try {
  const ticket = await invoke("POST", "/extension/collector-auth/ticket", {
    authorization: `Bearer ${token}`,
  });
  assert.equal(ticket.status, 200);
  const exchanged = await invoke("POST", "/extension/collector-auth/exchange", {
    body: {
      ticket: ticket.body.ticket,
      deviceFingerprint: "multi-variant-device",
      extensionVersion: "task4-test",
    },
  });
  assert.equal(exchanged.status, 200);
  const collectorAuthorization = `Collector ${exchanged.body.collectorToken}`;
  const collectorConfig = await invoke("GET", "/collector/health", {
    authorization: collectorAuthorization,
  });
  assert.equal(collectorConfig.status, 200);
  const webBearerConfig = await invoke("GET", "/collector/health", {
    authorization: `Bearer ${token}`,
  });
  assert.equal(webBearerConfig.status, 401);
  assert.equal(webBearerConfig.body.code, "COLLECTOR_AUTH_REQUIRED");
  const collectionInput = {
    source: "ozon",
    sourceSku: raw.sku,
    sourceUrl: `https://www.ozon.ru/product/${raw.sku}/`,
    requestId: "multi-variant-request",
    deviceFingerprint: "multi-variant-device",
    capturedAt: "2026-07-29T00:00:00.000Z",
    payload: raw,
  };

  const uploaded = await invoke("POST", "/sources/ozon/collect", {
    authorization: collectorAuthorization,
    body: collectionInput,
  });
  assert.equal(uploaded.status, 200, JSON.stringify(uploaded.body));
  assert.equal(uploaded.body.data.variantData.variants.length, 2);
  assert.deepEqual(uploaded.body.data.variantData.variants[0].sourceVariant, firstSource);
  assert.deepEqual(uploaded.body.data.variantData.variants[1].sourceVariant, secondSource);
  const job = await invoke(
    "GET",
    `/local/collect-requests/${encodeURIComponent(uploaded.body.requestId)}`,
    { authorization: collectorAuthorization },
  );
  assert.equal(job.status, 200);
  assert.equal(job.body.request.accountId, accountId);
  assert.equal(job.body.request.storeId, null);

  const webBearerUpload = await invoke("POST", "/sources/ozon/collect", {
    authorization: `Bearer ${token}`,
    body: { ...collectionInput, requestId: "web-bearer-must-not-upload" },
  });
  assert.equal(webBearerUpload.status, 401);
  assert.equal(webBearerUpload.body.code, "COLLECTOR_AUTH_REQUIRED");
  const webBearerJob = await invoke(
    "GET",
    `/local/collect-requests/${encodeURIComponent(uploaded.body.requestId)}`,
    { authorization: `Bearer ${token}` },
  );
  assert.equal(webBearerJob.status, 401);
  assert.equal(webBearerJob.body.code, "COLLECTOR_AUTH_REQUIRED");

  const forbiddenScope = await invoke("POST", "/sources/ozon/collect", {
    authorization: collectorAuthorization,
    body: { ...collectionInput, requestId: "forbidden-scope", storeId: "attacker-store" },
  });
  assert.equal(forbiddenScope.status, 400);
  assert.equal(forbiddenScope.body.code, "COLLECTOR_SCOPE_FIELD_FORBIDDEN");

  await assert.rejects(
    invoke("POST", "/ozon/products/import", {
      authorization: collectorAuthorization,
      body: { items: [] },
    }),
    (error) => error?.status === 401,
  );

  const state = JSON.parse(await readFile(dataFile, "utf8"));
  const saved = state.caches.collectBox[0];
  assert.equal(saved.accountId, accountId);
  assert.equal("storeId" in saved, false);
  assert.equal("dataCollectionStoreId" in saved, false);
  assert.equal(saved.variantData.variants.length, 2);
  assert.deepEqual(saved.variantData.variants[0].sourceVariant, firstSource);
  assert.deepEqual(saved.variantData.variants[1].sourceVariant, secondSource);
  console.log("collect multivariant ingest persistence passed");
} finally {
  await rm(dataDir, { recursive: true, force: true });
}
