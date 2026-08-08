import assert from "node:assert/strict";
import test from "node:test";

import {
  decideAutoListingContentCompletion,
  selectAutoListingUploadPolicyForNewJob,
} from "../auto-listing-upload-policy.mjs";

const review = Object.freeze({
  id: "policy-review-v1", accountId: "account-a", version: 1, mode: "REVIEW",
  enabled: true, publishedBy: "admin-a", publishedAt: "2026-08-08T00:00:00.000Z",
});
const direct = Object.freeze({
  id: "policy-direct-v2", accountId: "account-a", version: 2, mode: "DIRECT",
  enabled: true, publishedBy: "admin-a", publishedAt: "2026-08-08T01:00:00.000Z",
});

test("new jobs freeze the highest published account policy and callers cannot choose a mode", () => {
  const selected = selectAutoListingUploadPolicyForNewJob({
    accountId: "account-a",
    policies: [direct, review, { ...review, id: "other", accountId: "account-b", version: 99 }],
    directUploadAllowed: true,
    uploadEnabled: true,
    listingPipelineEnabled: true,
  });
  assert.deepEqual(selected, direct);
  assert.throws(() => selectAutoListingUploadPolicyForNewJob({
    accountId: "account-a", policies: [review], directUploadAllowed: false,
    uploadEnabled: true, listingPipelineEnabled: true, mode: "DIRECT",
  }), { code: "AUTO_LISTING_UPLOAD_POLICY_INVALID" });
});

test("missing, ambiguous same-version, unpublished and cross-account policies fail closed", () => {
  const base = { accountId: "account-a", directUploadAllowed: false, uploadEnabled: true, listingPipelineEnabled: true };
  assert.throws(() => selectAutoListingUploadPolicyForNewJob({ ...base, policies: [] }), {
    code: "AUTO_LISTING_UPLOAD_POLICY_NOT_PUBLISHED",
  });
  assert.throws(() => selectAutoListingUploadPolicyForNewJob({ ...base, policies: [review, { ...review, id: "duplicate" }] }), {
    code: "AUTO_LISTING_UPLOAD_POLICY_AMBIGUOUS",
  });
  for (const policy of [
    { ...review, enabled: false },
    { ...review, publishedBy: null, publishedAt: null },
    { ...review, accountId: "account-b" },
  ]) {
    assert.throws(() => selectAutoListingUploadPolicyForNewJob({ ...base, policies: [policy] }), {
      code: "AUTO_LISTING_UPLOAD_POLICY_NOT_PUBLISHED",
    });
  }
});

test("DIRECT policy is unusable until every server-side rollout gate is enabled", () => {
  const base = { accountId: "account-a", policies: [direct] };
  for (const missing of ["directUploadAllowed", "uploadEnabled", "listingPipelineEnabled"]) {
    const gates = { directUploadAllowed: true, uploadEnabled: true, listingPipelineEnabled: true, [missing]: false };
    assert.throws(() => selectAutoListingUploadPolicyForNewJob({ ...base, ...gates }), {
      code: "AUTO_LISTING_DIRECT_UPLOAD_BLOCKED",
    });
  }
  assert.deepEqual(selectAutoListingUploadPolicyForNewJob({
    ...base, directUploadAllowed: true, uploadEnabled: true, listingPipelineEnabled: true,
  }), direct);
});

test("a job keeps its frozen mode even after a newer policy is published", () => {
  assert.deepEqual(decideAutoListingContentCompletion({
    frozenPolicy: review, directUploadAllowed: true,
  }), { event: "CONTENT_READY_FOR_REVIEW", status: "READY_FOR_REVIEW", invokeUpload: false });

  assert.deepEqual(decideAutoListingContentCompletion({
    frozenPolicy: direct, directUploadAllowed: true,
  }), { event: "CONTENT_READY_FOR_DIRECT_UPLOAD", status: "UPLOAD_QUEUED", invokeUpload: true });
});

test("runtime DIRECT kill switch is checked again at content completion", () => {
  assert.throws(() => decideAutoListingContentCompletion({
    frozenPolicy: direct, directUploadAllowed: false,
  }), { code: "AUTO_LISTING_DIRECT_UPLOAD_BLOCKED" });
  assert.throws(() => decideAutoListingContentCompletion({
    frozenPolicy: { ...direct, enabled: false }, directUploadAllowed: true,
  }), { code: "AUTO_LISTING_UPLOAD_POLICY_INVALID" });
});
