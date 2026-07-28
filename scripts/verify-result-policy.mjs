export function evaluateCheckResult(result, expectedExitCode = 0) {
  if (result?.error) {
    return {
      ok: false,
      kind: result.error.code === "ENOENT" ? "missing-command" : "spawn-error",
      detail: result.error.message,
    };
  }
  if (result?.signal) {
    return { ok: false, kind: "signal", detail: result.signal };
  }
  if (!Number.isInteger(result?.status)) {
    return { ok: false, kind: "missing-status" };
  }
  if (result.status === expectedExitCode) {
    return { ok: true, kind: "passed", code: result.status };
  }
  return {
    ok: false,
    kind: result.status === 2 ? "environment-blocker" : "failed",
    code: result.status,
  };
}
