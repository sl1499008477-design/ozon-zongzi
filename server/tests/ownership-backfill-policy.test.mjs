import assert from "node:assert/strict";
import test from "node:test";
import { resolveLegacyStoreOwner } from "../ownership-backfill-policy.mjs";

test("legacy owner backfill uses reliable evidence or the sole account only", () => {
  assert.equal(resolveLegacyStoreOwner({ ownerAccountId: "acct_a" }, [{ id: "acct_a" }, { id: "acct_b" }]), "acct_a");
  assert.equal(resolveLegacyStoreOwner({}, [{ id: "acct_only" }]), "acct_only");
});

test("legacy owner backfill fails closed for an ownerless store with multiple accounts", () => {
  assert.throws(
    () => resolveLegacyStoreOwner({}, [{ id: "acct_a" }, { id: "acct_b" }]),
    (error) => error?.code === "STORE_OWNER_MAPPING_REQUIRED",
  );
});
