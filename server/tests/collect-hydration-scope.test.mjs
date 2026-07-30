import assert from "node:assert/strict";
import test from "node:test";
import { attachTrustedCollectAccountScope } from "../collect-hydration-scope.mjs";
import { publicPersistedCollectionItem } from "../collection-public-shape.mjs";

test("trusted account scope is restored internally and stripped publicly", () => {
  const [internal] = attachTrustedCollectAccountScope(" account-a ", [{
    id: "collect-1",
    sku: "3224975094",
    accountId: "forged-account",
  }]);

  assert.equal(internal.accountId, "account-a");
  assert.equal(publicPersistedCollectionItem(internal).accountId, undefined);
});

test("trusted account scope is required", () => {
  assert.throws(
    () => attachTrustedCollectAccountScope("", [{ id: "collect-1" }]),
    (error) => error?.code === "COLLECT_ACCOUNT_REQUIRED",
  );
});
