import assert from "node:assert/strict";
import fs from "node:fs";
const sql = fs.readFileSync(new URL("../db/migrations/018_pricing_write_idempotency.sql", import.meta.url), "utf8");
assert.match(sql, /PRIMARY KEY \(account_id, store_scope, action, idempotency_key\)/);
assert.match(sql, /payload_hash TEXT NOT NULL/);
assert.match(sql, /response_json JSONB NOT NULL/);
console.log("pricing write idempotency SQL contract passed");
