import assert from "node:assert/strict";
import test from "node:test";
import { evaluateCheckResult } from "../../scripts/verify-result-policy.mjs";

test("a normal gate accepts only its expected zero exit code", () => {
  assert.deepEqual(evaluateCheckResult({ status: 0 }), {
    ok: true,
    kind: "passed",
    code: 0,
  });
  assert.deepEqual(evaluateCheckResult({ status: 1 }), {
    ok: false,
    kind: "failed",
    code: 1,
  });
});

test("the credential scan accepts no-match 1 and rejects match 0", () => {
  assert.deepEqual(evaluateCheckResult({ status: 1 }, 1), {
    ok: true,
    kind: "passed",
    code: 1,
  });
  assert.deepEqual(evaluateCheckResult({ status: 0 }, 1), {
    ok: false,
    kind: "failed",
    code: 0,
  });
});

test("spawn errors, signals and missing status always fail closed", () => {
  const missing = Object.assign(new Error("spawn rg ENOENT"), { code: "ENOENT" });
  assert.deepEqual(evaluateCheckResult({ status: null, error: missing }), {
    ok: false,
    kind: "missing-command",
    detail: "spawn rg ENOENT",
  });
  assert.deepEqual(evaluateCheckResult({ status: null, signal: "SIGTERM" }), {
    ok: false,
    kind: "signal",
    detail: "SIGTERM",
  });
  assert.deepEqual(evaluateCheckResult({ status: null }), {
    ok: false,
    kind: "missing-status",
  });
});

test("exit code 2 is identified as an environment blocker unless explicitly expected", () => {
  assert.deepEqual(evaluateCheckResult({ status: 2 }), {
    ok: false,
    kind: "environment-blocker",
    code: 2,
  });
  assert.deepEqual(evaluateCheckResult({ status: 2 }, 2), {
    ok: true,
    kind: "passed",
    code: 2,
  });
});
