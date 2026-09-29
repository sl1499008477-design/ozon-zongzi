import assert from "node:assert/strict";
import test from "node:test";
import { localDayKey } from "../src/store-date.js";

test("listing history dates keep the Shanghai calendar boundary", () => {
  assert.equal(localDayKey("2026-09-05T16:00:00Z"), "2026-09-06");
  assert.equal(localDayKey("2026-09-05T15:59:59Z"), "2026-09-05");
  assert.equal(localDayKey("invalid"), "");
});

test("official Key expiry wins and creation timestamps never imply an expiry", async () => {
  const {displayApiKeyDeadline}=await import('../src/store-date.js');
  assert.match(displayApiKeyDeadline({apiKeyCreatedAt:'2026-01-01',apiKeyExpiresAt:'2027-03-04'}),/^2027-03-04/);
  assert.equal(displayApiKeyDeadline({savedAt:'2026-01-01'}),'未知');
  assert.equal(displayApiKeyDeadline({apiKeyCreatedAt:'2026-01-01'}),'未知');
});
