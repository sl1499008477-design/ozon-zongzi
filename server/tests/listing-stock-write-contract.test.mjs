import assert from "node:assert/strict";
import test from "node:test";

import {
  projectSubmissionStockWriteCommandV3,
  submissionStockRequestHashV3,
} from "../listing-pipeline.mjs";

function command() {
  const stocks = [{
    submissionItemId: "item-1",
    offerId: "offer-1",
    warehouseId: "warehouse-1",
    quantity: 5,
  }];
  return {
    accountId: "account-1",
    jobId: "job-1",
    snapshotId: "snapshot-1",
    storeId: "store-1",
    importOzonTaskId: "task-1",
    recoveryAttemptId: null,
    requestHash: submissionStockRequestHashV3(stocks),
    correlationId: "correlation-1",
    actorId: "worker-1",
    stocks,
  };
}

test("stock write command is closed, canonical and deeply immutable", () => {
  const projected = projectSubmissionStockWriteCommandV3(command());
  assert.deepEqual(projected, command());
  assert.equal(Object.isFrozen(projected), true);
  assert.equal(Object.isFrozen(projected.stocks), true);
  assert.equal(Object.isFrozen(projected.stocks[0]), true);
  assert.match(projected.requestHash, /^[a-f0-9]{32}$/u);
  assert.equal(projectSubmissionStockWriteCommandV3({ ...command(), extra: true }), null);
  assert.equal(projectSubmissionStockWriteCommandV3({ ...command(), requestHash: "0".repeat(32) }), null);
  assert.equal(projectSubmissionStockWriteCommandV3({ ...command(), recoveryAttemptId: undefined }), null);
  assert.equal(projectSubmissionStockWriteCommandV3({ ...command(), stocks: [
    { ...command().stocks[0], quantity: -1 },
  ] }), null);
});

test("stock write command rejects accessors and proxies without executing traps", () => {
  let calls = 0;
  const accessor = command();
  Object.defineProperty(accessor, "accountId", {
    enumerable: true,
    get() { calls += 1; return "account-1"; },
  });
  assert.equal(projectSubmissionStockWriteCommandV3(accessor), null);
  assert.equal(calls, 0);

  const nestedAccessor = command();
  Object.defineProperty(nestedAccessor.stocks[0], "offerId", {
    enumerable: true,
    get() { calls += 1; return "offer-1"; },
  });
  assert.equal(projectSubmissionStockWriteCommandV3(nestedAccessor), null);
  assert.equal(calls, 0);

  const proxy = new Proxy(command(), {
    ownKeys() { calls += 1; return []; },
    getOwnPropertyDescriptor() { calls += 1; return undefined; },
  });
  assert.equal(projectSubmissionStockWriteCommandV3(proxy), null);
  assert.equal(calls, 0);

  const revoked = Proxy.revocable(command(), {});
  revoked.revoke();
  assert.equal(projectSubmissionStockWriteCommandV3(revoked.proxy), null);
  assert.equal(calls, 0);
});
