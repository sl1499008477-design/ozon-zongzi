import assert from "node:assert/strict";
import test from "node:test";
import {
  assertAutoListingTransition,
  nextAutoListingStatus,
} from "../auto-listing-state-machine.mjs";

const permittedTransitions = [
  ["CREATED", "SOURCE_CAPTURED", "SOURCE_READY"],
  ["SOURCE_READY", "START_PLANNING", "PLANNING"],
  ["PLANNING", "PLAN_READY", "GENERATING"],
  ["GENERATING", "CONTENT_READY_FOR_REVIEW", "READY_FOR_REVIEW"],
  ["GENERATING", "CONTENT_READY_FOR_DIRECT_UPLOAD", "UPLOAD_QUEUED"],
  ["READY_FOR_REVIEW", "APPROVE_UPLOAD", "UPLOAD_QUEUED"],
  ["UPLOAD_QUEUED", "START_UPLOAD", "UPLOADING"],
  ["UPLOADING", "UPLOAD_SUCCEEDED", "SUCCEEDED"],
  ["PLANNING", "RETRYABLE_FAILURE", "RETRYABLE_ERROR"],
  ["GENERATING", "RETRYABLE_FAILURE", "RETRYABLE_ERROR"],
  ["UPLOAD_QUEUED", "RETRYABLE_FAILURE", "RETRYABLE_ERROR"],
  ["UPLOADING", "RETRYABLE_FAILURE", "RETRYABLE_ERROR"],
  ["RETRYABLE_ERROR", "RETRY_PLANNING", "PLANNING"],
  ["RETRYABLE_ERROR", "RETRY_GENERATION", "GENERATING"],
  ["RETRYABLE_ERROR", "RETRY_UPLOAD", "UPLOAD_QUEUED"],
  ["READY_FOR_REVIEW", "REGENERATE", "GENERATING"],
  ["CREATED", "BLOCK", "BLOCKED"],
  ["SOURCE_READY", "BLOCK", "BLOCKED"],
  ["PLANNING", "BLOCK", "BLOCKED"],
  ["GENERATING", "BLOCK", "BLOCKED"],
  ["READY_FOR_REVIEW", "BLOCK", "BLOCKED"],
  ["UPLOAD_QUEUED", "BLOCK", "BLOCKED"],
  ["UPLOADING", "BLOCK", "BLOCKED"],
  ["CREATED", "CANCEL", "CANCELLED"],
  ["SOURCE_READY", "CANCEL", "CANCELLED"],
  ["PLANNING", "CANCEL", "CANCELLED"],
  ["GENERATING", "CANCEL", "CANCELLED"],
  ["READY_FOR_REVIEW", "CANCEL", "CANCELLED"],
  ["UPLOAD_QUEUED", "CANCEL", "CANCELLED"],
  ["RETRYABLE_ERROR", "CANCEL", "CANCELLED"],
];

const expectForbidden = (currentStatus, eventType) => {
  assert.throws(
    () => nextAutoListingStatus(currentStatus, eventType),
    (error) => error?.code === "AUTO_LISTING_TRANSITION_FORBIDDEN",
  );
};

test("enumerates every permitted transition through the closed event table", () => {
  for (const [currentStatus, eventType, targetStatus] of permittedTransitions) {
    assert.equal(nextAutoListingStatus(currentStatus, eventType), targetStatus);
    assert.doesNotThrow(() =>
      assertAutoListingTransition(currentStatus, eventType, targetStatus),
    );
  }
});

test("rejects forbidden jumps, unknown inputs, and an upload cancellation", () => {
  for (const [currentStatus, eventType] of [
    ["CREATED", "UPLOAD_SUCCEEDED"],
    ["SOURCE_READY", "UPLOAD_SUCCEEDED"],
    ["SOURCE_READY", "START_UPLOAD"],
    ["UPLOADING", "CANCEL"],
    ["UNKNOWN", "CANCEL"],
    ["CREATED", "UNKNOWN_EVENT"],
  ]) {
    expectForbidden(currentStatus, eventType);
  }
});

test("allows retry recovery only through its explicit recovery event", () => {
  assert.equal(nextAutoListingStatus("RETRYABLE_ERROR", "RETRY_PLANNING"), "PLANNING");
  assert.equal(nextAutoListingStatus("RETRYABLE_ERROR", "RETRY_GENERATION"), "GENERATING");
  assert.equal(nextAutoListingStatus("RETRYABLE_ERROR", "RETRY_UPLOAD"), "UPLOAD_QUEUED");
  expectForbidden("RETRYABLE_ERROR", "RETRYABLE_FAILURE");
  expectForbidden("RETRYABLE_ERROR", "BLOCK");
});

test("rejects every event from terminal states", () => {
  const events = [
    "SOURCE_CAPTURED",
    "START_PLANNING",
    "PLAN_READY",
    "CONTENT_READY_FOR_REVIEW",
    "CONTENT_READY_FOR_DIRECT_UPLOAD",
    "APPROVE_UPLOAD",
    "START_UPLOAD",
    "UPLOAD_SUCCEEDED",
    "RETRYABLE_FAILURE",
    "RETRY_PLANNING",
    "RETRY_GENERATION",
    "RETRY_UPLOAD",
    "REGENERATE",
    "BLOCK",
    "CANCEL",
  ];
  for (const status of ["SUCCEEDED", "BLOCKED", "CANCELLED"]) {
    for (const eventType of events) expectForbidden(status, eventType);
  }
});

test("assertion rejects arbitrary, no-op, and mismatched targets", () => {
  for (const targetStatus of ["CREATED", "SUCCEEDED", "BLOCKED", "SOURCE_READY"]) {
    assert.throws(
      () => assertAutoListingTransition("SOURCE_READY", "START_PLANNING", targetStatus),
      (error) => error?.code === "AUTO_LISTING_TRANSITION_FORBIDDEN",
    );
  }
});
