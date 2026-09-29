import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

for (const file of [
  "account-scoped-collection.test.mjs",
  "auto-listing-validation-boundary-postgres.test.mjs",
  "auto-listing-rich-text-forbidden-projection-postgres.test.mjs",
  "collector-ozon-enrichment-orphan-expiry-migration-postgres.test.mjs",
  "account-deletion-postgres.integration.mjs",
  "collection-pipeline-v4.integration.mjs",
  "collector-desktop.integration.mjs",
  "listing-pipeline-v3.integration.mjs",
  "pricing-config.integration.mjs",
  "pricing-fx.integration.mjs",
]) {
  test(`${file} requires an explicit dedicated test database`, () => {
    const result = spawnSync(process.execPath, ["--test", `server/tests/${file}`], {
      encoding: "utf8", timeout: 10_000,
      env: { PATH: process.env.PATH, QH_LOCAL_NO_DOTENV: "1", QH_LOCAL_NO_LISTEN: "1",
        DATABASE_URL: "postgresql://test:test@127.0.0.1:1/do-not-connect",
        POSTGRES_HOST: "127.0.0.1", POSTGRES_PORT: "1", POSTGRES_DB: "do-not-connect",
        POSTGRES_USER: "test", POSTGRES_PASSWORD: "test" },
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /skip|SKIP/);
  });
}
