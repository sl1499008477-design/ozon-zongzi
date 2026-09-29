import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

test("feature flags return the static payload without loading persisted state", async (context) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "sonli-feature-flags-state-isolation-"));
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  await writeFile(path.join(dataDir, "local-state.json"), "controlled unreadable state", "utf8");
  process.env.QH_LOCAL_DATA_DIR = dataDir;
  process.env.QH_LOCAL_NO_LISTEN = "1";
  process.env.QH_LOCAL_NO_DOTENV = "1";
  process.env.LISTING_PIPELINE_V3 = "0";
  process.env.SONLI_ADMIN_PASSWORD = "feature-flag-isolation-test";
  delete process.env.DATABASE_URL;
  delete process.env.POSTGRES_HOST;

  const { handle } = await import("../index.mjs");
  const request = Readable.from([]);
  request.method = "GET";
  request.url = "/feature-flags/me";
  request.headers = {};
  const response = {
    status: 0,
    body: "",
    writeHead(status) { this.status = status; },
    end(body = "") { this.body = String(body); },
  };

  await handle(request, response);

  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.body), {
    ozon_fleet_serverside: false,
    ozon_public_import: false,
    localClone: true,
  });
});
