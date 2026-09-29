import assert from "node:assert/strict";
import test from "node:test";
import { activeTestFiles } from "./test-manifest.mjs";

test("the active gate includes script and colocated frontend regressions", () => {
  for (const file of ["scripts/dev.test.mjs", "scripts/verify-isolation.test.mjs", "scripts/test-manifest.test.mjs", "scripts/verification-contract-mutations.test.mjs", "app/src/auto-listing-rfbs-warehouse.test.mjs"]) {
    assert.ok(activeTestFiles.includes(file), `missing regression: ${file}`);
  }
});
