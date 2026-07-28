import assert from "node:assert/strict";
import {
  CLAIM_TTL_MS,
  claimNextBrowserAgentJob,
} from "../browser-agent-policy.mjs";

const now = Date.parse("2026-07-27T12:00:00.000Z");
const stores = [
  { id: "store_a", ownerAccountId: "acct_a" },
];
const agents = {
  device_new: { id: "device_new", accountId: "acct_a" },
};

const safeState = {
  stores,
  browserAgents: agents,
  jobs: {
    safe_job: {
      id: "safe_job",
      accountId: "acct_a",
      storeId: "store_a",
      type: "ozon.collect_variant",
      status: "RUNNING",
      claimedByDeviceId: "device_old",
      claimExpiresAt: new Date(now - 1).toISOString(),
      claimAttempt: 1,
    },
  },
};

const reclaimed = claimNextBrowserAgentJob(safeState, {
  accountId: "acct_a",
  deviceId: "device_new",
  nowMs: now,
});
assert.equal(reclaimed?.id, "safe_job", "expired read-only work must become claimable");
assert.equal(reclaimed.status, "PROCESSING");
assert.equal(reclaimed.claimedByDeviceId, "device_new");
assert.equal(reclaimed.claimAttempt, 2);
assert.equal(reclaimed.claimExpiresAt, new Date(now + CLAIM_TTL_MS).toISOString());

const publishState = {
  stores,
  browserAgents: agents,
  jobs: {
    publish_job: {
      id: "publish_job",
      accountId: "acct_a",
      storeId: "store_a",
      type: "listing.publish_draft",
      status: "RUNNING",
      claimedByDeviceId: "device_old",
      claimExpiresAt: new Date(now - 1).toISOString(),
      claimAttempt: 1,
    },
  },
};

const publishClaim = claimNextBrowserAgentJob(publishState, {
  accountId: "acct_a",
  deviceId: "device_new",
  nowMs: now,
});
assert.equal(publishClaim, null, "an uncertain publish must not be claimed again");
assert.equal(publishState.jobs.publish_job.status, "RECONCILING");
assert.equal(publishState.jobs.publish_job.claimedByDeviceId, "");
assert.equal(publishState.jobs.publish_job.claimExpiresAt, "");

console.log("browser agent policy timeout test passed");
