import assert from "node:assert/strict";
import test from "node:test";

import { createAiModelCatalogPort } from "../ai-model-catalog-port.mjs";

test("model catalog port exposes one immutable asynchronous list operation", async () => {
  const expected = Object.freeze({ requestId: "request-models", models: [] });
  const port = createAiModelCatalogPort({ listModels: async (input) => {
    assert.deepEqual(input, { connection: { id: "connection-a" } });
    return expected;
  } });

  assert.deepEqual(Object.keys(port), ["listModels"]);
  assert.equal(Object.isFrozen(port), true);
  assert.equal(await port.listModels({ connection: { id: "connection-a" } }), expected);
});

test("model catalog port fails closed when its operation is absent", () => {
  for (const input of [undefined, {}, { listModels: null }]) {
    assert.throws(() => createAiModelCatalogPort(input), TypeError);
  }
});
