import assert from "node:assert/strict";
import test from "node:test";

import { createAutoListingSubmissionReconciliationAdminRuntime } from "../auto-listing-submission-reconciliation-admin-runtime.mjs";

test("admin recovery runtime is lazy, cached and fail-closed while disabled", async () => {
  let repositories = 0;
  const active = createAutoListingSubmissionReconciliationAdminRuntime({
    enabled: true,
    getPool: async () => ({ query() {}, connect() {} }),
    createRepository: () => { repositories += 1; return { reopenDeadTask() {} }; },
    createService: ({ repository }) => ({ repository }),
  });
  assert.strictEqual(await active.getService(), await active.getService());
  assert.equal(repositories, 1);

  const disabled = createAutoListingSubmissionReconciliationAdminRuntime({
    enabled: false,
    getPool: async () => { assert.fail("disabled runtime must not read PostgreSQL"); },
  });
  await assert.rejects(disabled.getService(), { code: "AUTO_LISTING_RECONCILE_ADMIN_DISABLED" });
});
