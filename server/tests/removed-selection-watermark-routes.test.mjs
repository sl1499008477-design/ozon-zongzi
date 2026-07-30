import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Readable } from "node:stream";

const dataDir = await mkdtemp(path.join(os.tmpdir(), "sonli-removed-selection-watermark-"));
const token = "removed-selection-watermark-token";

process.env.QH_LOCAL_DATA_DIR = dataDir;
process.env.QH_LOCAL_NO_LISTEN = "1";
process.env.QH_LOCAL_NO_DOTENV = "1";
delete process.env.DATABASE_URL;
delete process.env.POSTGRES_HOST;

const fixture = {
  token,
  currentAccountId: "account-a",
  sessionIssuedAt: "2026-07-30T00:00:00.000Z",
  sessions: {
    [token]: {
      token,
      accountId: "account-a",
      issuedAt: "2026-07-30T00:00:00.000Z",
    },
  },
  accounts: [{
    id: "account-a",
    username: "account-a",
    role: "admin",
    status: "active",
  }],
  currentStoreId: "store-a",
  currentStoreIdsByAccount: { "account-a": "store-a" },
  caches: {
    products: [],
    postings: [],
    warehouses: [],
    collectBox: [],
    watermarkTemplates: [{
      id: "watermark-a",
      accountId: "account-a",
      storeId: "store-a",
      name: "retired watermark",
    }],
  },
  stores: [{
    id: "store-a",
    ownerAccountId: "account-a",
    clientId: "client-a",
    apiKey: "secret-a",
    watermarkTemplateId: "watermark-a",
  }],
  hashes: {},
  leases: {},
  browserAgents: {},
  jobs: {},
  reports: [],
  auditEvents: [],
};

await writeFile(path.join(dataDir, "local-state.json"), JSON.stringify(fixture), "utf8");
const { handle, testExports } = await import("../index.mjs");

async function requestJson(method, pathname, body) {
  const payload = body === undefined ? "" : JSON.stringify(body);
  const req = Readable.from(payload ? [Buffer.from(payload)] : []);
  req.method = method;
  req.url = pathname;
  req.headers = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    "x-ozon-store-id": "store-a",
  };
  const res = {
    status: 0,
    body: "",
    writeHead(status) {
      this.status = status;
    },
    end(text = "") {
      this.body = String(text || "");
    },
  };
  try {
    await handle(req, res);
  } catch (error) {
    res.writeHead(Number(error?.status || 500));
    res.end(JSON.stringify({
      ok: false,
      code: error?.code || "LOCAL_ERROR",
      message: error?.message || "本地服务异常",
    }));
  }
  return { status: res.status, body: JSON.parse(res.body || "{}") };
}

const removedRoutes = [
  ["GET", "/ozon/watermark-settings"],
  ["POST", "/ozon/watermark-settings"],
  ["PUT", "/ozon/watermark-settings/watermark-a"],
  ["DELETE", "/ozon/watermark-settings/watermark-a"],
  ["POST", "/ozon/selection/bestsellers/snapshot"],
  ["POST", "/ozon/selection/category-mapping"],
];

test("retired selection and watermark APIs use the generic 404 contract", async () => {
  for (const [method, pathname] of removedRoutes) {
    const response = await requestJson(method, pathname, {});
    assert.equal(response.status, 404, `${method} ${pathname}`);
    assert.equal(response.body.code, "LOCAL_NOT_FOUND", `${method} ${pathname}`);
  }
});

test("legacy watermark fields are stripped from active and public state", async () => {
  const normalized = testExports.ensureAccountState(structuredClone(fixture));
  assert.equal(Object.hasOwn(normalized.caches, "watermarkTemplates"), false);
  assert.equal(Object.hasOwn(normalized.stores[0], "watermarkTemplateId"), false);

  const state = await requestJson("GET", "/local/state", undefined);
  assert.equal(state.status, 200);
  assert.equal(Object.hasOwn(state.body.caches, "watermarkTemplates"), false);
  assert.equal(Object.hasOwn(state.body.summary, "watermarkTemplates"), false);
  assert.equal(Object.hasOwn(state.body.stores[0], "watermarkTemplateId"), false);
});

test.after(async () => {
  await rm(dataDir, { recursive: true, force: true });
});
