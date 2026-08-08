import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [compose, example, indexSource, connectionSource, storageSource] = await Promise.all([
  readFile(new URL("../../docker-compose.yml", import.meta.url), "utf8"),
  readFile(new URL("../../.env.example", import.meta.url), "utf8"),
  readFile(new URL("../index.mjs", import.meta.url), "utf8"),
  readFile(new URL("../db/connection.mjs", import.meta.url), "utf8"),
  readFile(new URL("../object-storage.mjs", import.meta.url), "utf8"),
]);

for (const literal of [
  "admin123456",
  "sonli_password",
  "sonli_minio_password",
  "replace-with-a-long-random-secret",
]) {
  assert.doesNotMatch(compose, new RegExp(literal), `compose must not contain default secret ${literal}`);
  assert.doesNotMatch(example, new RegExp(literal), `environment template must not contain default secret ${literal}`);
  assert.doesNotMatch(indexSource, new RegExp(literal), `server must not contain default secret ${literal}`);
  assert.doesNotMatch(connectionSource, new RegExp(literal), `database client must not contain default secret ${literal}`);
  assert.doesNotMatch(storageSource, new RegExp(literal), `object storage client must not contain default secret ${literal}`);
}

for (const name of [
  "POSTGRES_PASSWORD",
  "MINIO_ACCESS_KEY",
  "MINIO_SECRET_KEY",
  "APP_ENCRYPTION_KEY",
  "SONLI_ADMIN_PASSWORD",
  "POSTGRES_PORT",
  "MINIO_PORT",
  "MINIO_CONSOLE_PORT",
  "WEB_PORT",
]) {
  assert.match(
    compose,
    new RegExp(`\\$\\{${name}:\\?`),
    `${name} must be explicitly supplied to docker compose`,
  );
}

assert.match(compose, /auto-listing-ai-worker:[\s\S]*?profiles: \["application", "auto-listing-ai"\]/u);
assert.match(compose, /auto-listing-ai-worker:[\s\S]*?command: \["node", "server\/auto-listing-ai-worker\.mjs"\]/u);
assert.match(compose, /AUTO_LISTING_ENABLED: \$\{AUTO_LISTING_ENABLED:-false\}/u);
assert.match(compose, /AUTO_LISTING_AI_ENABLED: \$\{AUTO_LISTING_AI_ENABLED:-false\}/u);
assert.match(compose, /AUTO_LISTING_EXCEL_MAX_BYTES: \$\{AUTO_LISTING_EXCEL_MAX_BYTES:-2097152\}/u);
assert.match(compose, /AUTO_LISTING_EXCEL_MAX_ROWS: \$\{AUTO_LISTING_EXCEL_MAX_ROWS:-1000\}/u);
assert.match(example, /^AUTO_LISTING_EXCEL_MAX_BYTES=2097152$/mu);
assert.match(example, /^AUTO_LISTING_EXCEL_MAX_ROWS=1000$/mu);
assert.match(compose, /AUTO_LISTING_AI_ALLOWED_SECRET_ENV_NAMES: \$\{AUTO_LISTING_AI_ALLOWED_SECRET_ENV_NAMES:-\}/u);
assert.match(compose, /AUTO_LISTING_AI_ALLOWED_GATEWAY_BASE_URLS: \$\{AUTO_LISTING_AI_ALLOWED_GATEWAY_BASE_URLS:-\}/u);
assert.match(compose, /auto-listing-ai-worker:[\s\S]*?restart: on-failure[\s\S]*?stop_grace_period: 5m/u);
assert.match(compose, /^      SUB2API_API_KEY: \$\{SUB2API_API_KEY:-\}$/mu,
  "AI key must only come from the environment");

console.log("infrastructure configuration contract passed");
