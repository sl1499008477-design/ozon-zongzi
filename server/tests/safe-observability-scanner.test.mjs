import assert from "node:assert/strict";
import test from "node:test";
import {
  assertNoSensitiveMarkersDeep,
  findSensitiveMarkersDeep,
} from "./support/safe-observability-scanner.mjs";

const RAW_MARKER = "raw-upstream-marker-must-not-persist";

test("recursive observability scan detects a raw marker in a cyclic Error cause", () => {
  const root = new Error("safe outer message", {
    cause: Object.assign(new Error(`nested ${RAW_MARKER}`), { code: "UPSTREAM_RAW" }),
  });
  root.code = "SAFE_OUTER";
  root.context = { retry: true, root };

  const findings = findSensitiveMarkersDeep(["category failure", { error: root }], [RAW_MARKER]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].marker, RAW_MARKER);
  assert.match(findings[0].path, /cause\.message$/);
  assert.throws(
    () => assertNoSensitiveMarkersDeep(["category failure", { error: root }], [RAW_MARKER]),
    /sensitive observability marker/i,
  );
});

test("recursive observability scan accepts a non-empty safe cyclic Error", () => {
  const safe = Object.assign(new Error("controlled category failure"), {
    code: "OZON_RATE_LIMITED",
  });
  safe.cause = { owner: safe };
  assert.deepEqual(findSensitiveMarkersDeep(["category failure", { error: safe }], [RAW_MARKER]), []);
  assert.doesNotThrow(() => (
    assertNoSensitiveMarkersDeep(["category failure", { error: safe }], [RAW_MARKER])
  ));
});
