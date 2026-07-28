import assert from "node:assert/strict";
import { test } from "node:test";
import {
  appendAuditEvent,
  createAuditEvent,
} from "../audit-event.mjs";

test("audit scope comes from server context and sensitive metadata is redacted", () => {
  const event = createAuditEvent({
    action: "SYNC_CREDENTIALS_READ",
    accountId: "account_server",
    storeId: "store_server",
    deviceId: "device_server",
    source: "extension",
    entityType: "store",
    entityId: "store_server",
    metadata: {
      accountId: "account_spoofed",
      apiKey: "secret-api-key",
      authorization: "Bearer secret-token",
      nested: { password: "secret-password", fetchedCount: 3 },
    },
  });
  assert.equal(event.accountId, "account_server");
  assert.equal(event.storeId, "store_server");
  assert.equal(event.deviceId, "device_server");
  assert.equal(event.source, "extension");
  assert.equal(event.metadata.accountId, undefined);
  assert.equal(event.metadata.apiKey, "[REDACTED]");
  assert.equal(event.metadata.authorization, "[REDACTED]");
  assert.equal(event.metadata.nested.password, "[REDACTED]");
  assert.equal(event.metadata.nested.fetchedCount, 3);
});

test("append is idempotent for a caller-stable audit event id", () => {
  const state = { auditEvents: [] };
  appendAuditEvent(state, {
    eventId: "audit_job_1_success",
    action: "SYNC_SUCCESS",
    accountId: "account_1",
  });
  appendAuditEvent(state, {
    eventId: "audit_job_1_success",
    action: "SYNC_SUCCESS",
    accountId: "account_1",
  });
  assert.equal(state.auditEvents.length, 1);
});
