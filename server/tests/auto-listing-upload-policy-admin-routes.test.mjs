import assert from "node:assert/strict";
import test from "node:test";

import { createAutoListingUploadPolicyAdminHttpHandler } from "../auto-listing-upload-policy-admin-routes.mjs";

function response() {
  const sent = [];
  const handler = createAutoListingUploadPolicyAdminHttpHandler({
    authenticate: async () => ({ id: "account-a", role: "admin" }),
    getService: async () => ({
      listPolicies: async () => [{ id: "policy-a" }],
      publishPolicy: async (input) => ({ id: "policy-b", mode: input.mode }),
      checkPublicationHealth: async () => ({ evidenceId: "health-a", outcome: "PASSED" }),
    }),
    readJson: async (req) => req.body,
    sendJson: (_res, status, payload) => sent.push({ status, payload }),
  });
  return { handler, sent };
}

test("GET lists and POST publishes policies through the closed admin route", async () => {
  const { handler, sent } = response();
  assert.equal(await handler({ method: "GET" }, {}, new URL("http://local/admin/auto-listing/upload-policies")), true);
  assert.equal(sent[0].status, 200);

  assert.equal(await handler({ method: "POST", body: {
    mode: "REVIEW", publicationReason: "开发审核", idempotencyKey: "policy-key", correlationId: "corr-a",
  } }, {}, new URL("http://local/admin/auto-listing/upload-policies")), true);
  assert.equal(sent[1].status, 201);
  assert.equal(sent[1].payload.data.mode, "REVIEW");
});

test("POST publication-health is an explicit admin-only health action", async () => {
  const { handler, sent } = response();
  assert.equal(await handler({ method: "POST", body: {} }, {},
    new URL("http://local/admin/auto-listing/upload-policies/publication-health")), true);
  assert.deepEqual(sent.at(-1), {
    status: 201, payload: { ok: true, data: { evidenceId: "health-a", outcome: "PASSED" } },
  });
});

test("disabled admin runtime remains a stable 404 contract", async () => {
  const sent = [];
  const handler = createAutoListingUploadPolicyAdminHttpHandler({
    authenticate: async () => ({ id: "account-a", role: "admin" }),
    getService: async () => {
      const error = new Error("disabled");
      error.code = "AUTO_LISTING_UPLOAD_POLICY_ADMIN_DISABLED";
      error.status = 404;
      throw error;
    },
    readJson: async () => ({}),
    sendJson: (_res, status, payload) => sent.push({ status, payload }),
  });
  await handler({ method: "GET" }, {}, new URL("http://local/admin/auto-listing/upload-policies"));
  assert.equal(sent[0].status, 404);
  assert.equal(sent[0].payload.code, "AUTO_LISTING_UPLOAD_POLICY_ADMIN_DISABLED");
});

test("runtime initialization failure remains a stable retryable service contract", async () => {
  const sent = [];
  const handler = createAutoListingUploadPolicyAdminHttpHandler({
    authenticate: async () => ({ id: "account-a", role: "admin" }),
    getService: async () => {
      const error = new Error("database unavailable");
      error.code = "AUTO_LISTING_UPLOAD_POLICY_ADMIN_INITIALIZATION_FAILED";
      error.status = 503;
      throw error;
    },
    readJson: async () => ({}),
    sendJson: (_res, status, payload) => sent.push({ status, payload }),
  });
  await handler({ method: "GET" }, {}, new URL("http://local/admin/auto-listing/upload-policies"));
  assert.equal(sent[0].status, 503);
  assert.equal(sent[0].payload.code, "AUTO_LISTING_UPLOAD_POLICY_ADMIN_INITIALIZATION_FAILED");
});

test("missing account scope remains the repository's stable 404 contract", async () => {
  const sent = [];
  const handler = createAutoListingUploadPolicyAdminHttpHandler({
    authenticate: async () => ({ id: "account-missing", role: "admin" }),
    getService: async () => ({ async listPolicies() {
      const error = new Error("hidden database detail");
      error.code = "AUTO_LISTING_UPLOAD_POLICY_ADMIN_SCOPE_NOT_FOUND";
      error.status = 404;
      throw error;
    } }),
    readJson: async () => ({}),
    sendJson: (_res, status, payload) => sent.push({ status, payload }),
  });
  await handler({ method: "GET" }, {}, new URL("http://local/admin/auto-listing/upload-policies"));
  assert.equal(sent[0].status, 404);
  assert.equal(sent[0].payload.code, "AUTO_LISTING_UPLOAD_POLICY_ADMIN_SCOPE_NOT_FOUND");
});

test("route rejects extra body fields, query parameters and unsupported methods", async () => {
  const { handler, sent } = response();
  await handler({ method: "POST", body: {
    mode: "DIRECT", publicationReason: "direct", idempotencyKey: "key", correlationId: "corr", enabled: true,
  } }, {}, new URL("http://local/admin/auto-listing/upload-policies"));
  assert.equal(sent.at(-1).status, 400);

  await handler({ method: "GET" }, {}, new URL("http://local/admin/auto-listing/upload-policies?accountId=other"));
  assert.equal(sent.at(-1).status, 400);

  await handler({ method: "DELETE" }, {}, new URL("http://local/admin/auto-listing/upload-policies"));
  assert.equal(sent.at(-1).status, 405);
  assert.equal(await handler({ method: "GET" }, {}, new URL("http://local/unrelated")), false);
});
