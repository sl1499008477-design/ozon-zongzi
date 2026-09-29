import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("an explicit environment file anchors its relative credential path", async (t) => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "sonli-explicit-env-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const envFile = path.join(fixture, ".env");
  await writeFile(envFile, 'POSTGRES_DB=fixture_database\nAUTO_LISTING_CREDENTIAL_MASTER_KEY_FILE=private/credential.key\n');
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", `
    await import('./server/env.mjs');
    console.log(JSON.stringify({ db: process.env.POSTGRES_DB, keyFile: process.env.AUTO_LISTING_CREDENTIAL_MASTER_KEY_FILE }));
  `], { encoding: "utf8", env: { PATH: process.env.PATH, SONLI_ENV_FILE: envFile } });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { db: "fixture_database", keyFile: path.join(fixture, "private/credential.key") });
});

test("a missing explicitly selected environment fails instead of opening an empty JSON database", () => {
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", "await import('./server/env.mjs')"], {
    encoding: "utf8", env: { PATH: process.env.PATH, SONLI_ENV_FILE: "/missing-sonli-config-test/.env" },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /SONLI_ENV_FILE/);
});
