import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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

test("ownership migration guards legacy local-state assignment behind a sole-account check", async () => {
  const migration = await readFile(new URL("../db/migrations/008_operating_store_account_ownership.sql", import.meta.url), "utf8");
  const legacyUpdate = migration.slice(migration.indexOf("UPDATE stores target"), migration.indexOf("\n\nUPDATE stores\n"));
  assert.match(legacyUpdate, /AND \(SELECT COUNT\(\*\) FROM accounts\) = 1;/);
});
