import assert from "node:assert/strict";
import crypto from "node:crypto";
import "./support/dedicated-postgres-test-environment.mjs";
import { closePostgresPool, getPostgresPool, postgresEnabled } from "../db/connection.mjs";
import {
  createFxProbe,
  deleteFxProbe,
  getFxStatus,
  ingestFxObservations,
  updateFxProbe,
} from "../pricing-fx-service.mjs";

if (!postgresEnabled()) {
  console.log("pricing fx integration skipped: PostgreSQL disabled");
  process.exit(0);
}

const suffix = crypto.randomInt(100000, 999999);
const skus = [`8100${suffix}`, `8200${suffix}`, `8300${suffix}`];
const probes = [];
let rateId = "";

try {
  for (const [index, sku] of skus.entries()) {
    probes.push(await createFxProbe({ sku, label: `integration-${index}` }));
  }
  const changed = await updateFxProbe(probes[0].id, { label: "integration-updated", status: "ACTIVE" });
  assert.equal(changed.label, "integration-updated");

  const ingested = await ingestFxObservations({
    observations: [
      { sku: skus[0], rubPrice: 1200, cnyPrice: 100, source: "integration" },
      { sku: skus[1], rubPrice: 1210, cnyPrice: 100, source: "integration" },
      { sku: skus[2], rubPrice: 2000, cnyPrice: 100, source: "integration" },
    ],
    deviceId: "integration-device",
  });
  assert.equal(ingested.accepted, 2);
  assert.equal(ingested.rejected, 1);
  assert.equal(ingested.rate.rate, 12.05);
  rateId = ingested.rate.id;

  const status = await getFxStatus();
  assert.ok(status.probes.some((probe) => probe.id === probes[0].id && probe.rubPrice === 1200));
  assert.equal(status.rate.id, rateId);
  console.log("pricing fx integration test passed");
} finally {
  const pool = await getPostgresPool();
  if (rateId) await pool.query("DELETE FROM pricing_live_exchange_rates WHERE id=$1", [rateId]);
  for (const probe of probes) await deleteFxProbe(probe.id).catch(() => {});
  await closePostgresPool();
}
