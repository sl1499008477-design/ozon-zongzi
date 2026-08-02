import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

const dataDir = await mkdtemp(path.join(os.tmpdir(), "sonli-enrichment-read-body-"));
process.env.QH_LOCAL_DATA_DIR = dataDir;
process.env.QH_LOCAL_NO_LISTEN = "1";
process.env.QH_LOCAL_NO_DOTENV = "1";
delete process.env.DATABASE_URL;
delete process.env.POSTGRES_HOST;

const { testExports } = await import("../index.mjs");

test("server readBody keeps legacy empty-body parsing unless a route requires JSON content", async () => {
  assert.deepEqual(await testExports.readBody(Readable.from([])), {});
  await assert.rejects(
    () => testExports.readBody(Readable.from([]), { requireBody: true }),
    (error) => error?.status === 400 && error?.code === "REQUEST_BODY_REQUIRED",
  );
  assert.deepEqual(
    await testExports.readBody(Readable.from([Buffer.from("{}")]), { requireBody: true }),
    {},
  );
});

test.after(() => rm(dataDir, { recursive: true, force: true }));
