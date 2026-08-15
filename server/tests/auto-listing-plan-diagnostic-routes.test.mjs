import assert from "node:assert/strict";
import test from "node:test";

import { createAutoListingPlanDiagnosticHttpHandler } from "../auto-listing-plan-diagnostic-routes.mjs";

const admin = Object.freeze({ id: "account-a", role: "admin" });

function harness({ actor = admin, service = null, body = null } = {}) {
  const calls = [];
  const responses = [];
  const handler = createAutoListingPlanDiagnosticHttpHandler({
    async authenticate() { calls.push(["authenticate"]); return actor; },
    async getService() { calls.push(["service"]); return service ?? {
      async getLatest(input) { calls.push(["latest", input]); return { responseId: "response-a" }; },
      async replay(input) { calls.push(["replay", input]); return { created: true, detail: { responseId: "response-a" } }; },
    }; },
    async readJson(_req, options) { calls.push(["readJson", options]); return body; },
    sendJson(_res, status, payload) { responses.push({ status, payload }); },
  });
  return {
    calls,
    async request(method, path) {
      const handled = await handler({ method }, {}, new URL(path, "http://localhost"));
      return { handled, response: responses.at(-1) };
    },
  };
}

test("GET route delegates one exact job and item identity after backend permission", async () => {
  const h = harness({ actor: {
    id: "account-a", role: "admin", username: "admin-a", displayName: "管理员 A",
  } });
  const result = await h.request("GET", "/admin/auto-listing/plan-diagnostics/items/item-a/latest?jobId=job-a");
  assert.equal(result.handled, true);
  assert.equal(result.response.status, 200);
  assert.deepEqual(h.calls.find(([name]) => name === "latest")?.[1], {
    actor: admin, jobId: "job-a", itemId: "item-a",
  });
});

test("POST replay requires one exact confirmed text-only command", async () => {
  const command = {
    jobId: "job-a", itemId: "item-a", sourceSnapshotId: "snapshot-a", expectedStatusVersion: 9,
    costConfirmed: true, idempotencyKey: "diagnostic-once-a", correlationId: "corr-a",
  };
  const h = harness({ body: command });
  const result = await h.request("POST", "/admin/auto-listing/plan-diagnostics/replays");
  assert.equal(result.response.status, 201);
  assert.deepEqual(h.calls.find(([name]) => name === "replay")?.[1], { actor: admin, ...command });
  assert.deepEqual(h.calls.find(([name]) => name === "readJson")?.[1], {
    maxBytes: 256 * 1024, requireBody: true,
  });

  for (const invalidBody of [
    { ...command, costConfirmed: false },
    { ...command, extra: true },
  ]) {
    const invalid = await harness({ body: invalidBody }).request(
      "POST", "/admin/auto-listing/plan-diagnostics/replays",
    );
    assert.equal(invalid.response.status, 400);
  }
});

test("route closes method, query, encoded path, authentication and permission boundaries", async () => {
  for (const [method, path, status] of [
    ["POST", "/admin/auto-listing/plan-diagnostics/items/item-a/latest?jobId=job-a", 405],
    ["GET", "/admin/auto-listing/plan-diagnostics/items/item-a/latest", 400],
    ["GET", "/admin/auto-listing/plan-diagnostics/items/item-a/latest?jobId=job-a&extra=1", 400],
    ["GET", "/admin/auto-listing/plan-diagnostics/items/item%2Fa/latest?jobId=job-a", 400],
  ]) {
    const result = await harness().request(method, path);
    assert.equal(result.handled, true);
    assert.equal(result.response.status, status);
  }
  const ordinary = harness({ actor: { id: "account-a", role: "user" } });
  const forbidden = await ordinary.request("GET", "/admin/auto-listing/plan-diagnostics/items/item-a/latest?jobId=job-a");
  assert.equal(forbidden.response.status, 403);
  assert.equal(ordinary.calls.some(([name]) => name === "service"), false);
  const unknown = await harness().request("GET", "/admin/auto-listing/other");
  assert.equal(unknown.handled, false);
});

test("route exposes only fixed safe errors", async () => {
  for (const [error, status, code] of [
    [Object.assign(new Error("missing"), { code: "AUTO_LISTING_PLAN_DIAGNOSTIC_NOT_FOUND", status: 404 }), 404, "AUTO_LISTING_PLAN_DIAGNOSTIC_NOT_FOUND"],
    [Object.assign(new Error("postgres://user:secret@host"), { code: "RAW_DATABASE_ERROR", status: 418 }), 500, "AUTO_LISTING_PLAN_DIAGNOSTIC_INTERNAL_ERROR"],
  ]) {
    const result = await harness({ service: { async getLatest() { throw error; } } })
      .request("GET", "/admin/auto-listing/plan-diagnostics/items/item-a/latest?jobId=job-a");
    assert.equal(result.response.status, status);
    assert.equal(result.response.payload.code, code);
    assert.equal(JSON.stringify(result.response).includes("secret"), false);
  }
});
