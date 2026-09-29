import assert from "node:assert/strict";
import test from "node:test";
import { handleHealthRoute } from "../health-routes.mjs";

for (const enabled of [true, false]) {
  test(`queue health failure affects readiness only when enabled=${enabled}`, async () => {
    let result;
    const handled = await handleHealthRoute({ method: "GET" }, {}, new URL("http://localhost/local/storage/health"), {
      dataFile: "/synthetic/state.json", persistenceMode: () => "postgres",
      persistenceHealth: async () => ({ ok: true }), objectStorageHealth: async () => ({ ok: true }),
      objectStorageInfo: () => ({}), listingPipelineEnabled: () => enabled,
      listingPipelineHealth: async () => { throw new Error("private diagnostic must not be exposed"); },
      sendJson: (_response, status, body) => { result = { status, body }; },
    });
    assert.equal(handled, true);
    assert.equal(result.status, enabled ? 503 : 200);
    assert.equal(result.body.ok, !enabled);
    assert.doesNotMatch(JSON.stringify(result), /private diagnostic/);
    assert.equal(result.body.objectCleanup.pending, null, "unknown cleanup state is not a fabricated zero");
  });
}
