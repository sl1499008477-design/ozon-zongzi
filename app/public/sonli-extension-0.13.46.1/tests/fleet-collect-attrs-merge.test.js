const assert = require("node:assert/strict");
const fs = require("node:fs");

const workerSource = fs.readFileSync("extension/background/service-worker.js", "utf8");
const startToken = "const _fc = await callFleet(backendUrl, token, storeId, 'collect', { sku });";
const endToken = "return { ok: true, data: { items: [_sv] } };";
const start = workerSource.indexOf(startToken);
const endStart = workerSource.indexOf(endToken, start);
assert.notEqual(start, -1, "searchVariants must retain the fleet collect call");
assert.notEqual(endStart, -1, "searchVariants must return the enriched fleet sourceVariant");

const branchClose = workerSource.indexOf("\n            }", endStart + endToken.length);
assert.notEqual(branchClose, -1, "fleet sourceVariant branch must remain syntactically complete");
const executableBranch = workerSource.slice(start, branchClose + "\n            }".length);
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const runFleetBranch = new AsyncFunction(
  "callFleet",
  "backendUrl",
  "token",
  "storeId",
  "sku",
  "_ck",
  "_fleetCacheSet",
  `${executableBranch}\nreturn null;`,
);

(async () => {
  const calls = [];
  const cached = [];
  const fleetResponse = {
    sourceVariant: {
      attributes: [
        { key: "10", value: "existing" },
      ],
    },
    bundleItem: {
      attributes: [
        { attribute_id: 20, complex_id: 0, values: [{ value: "simple" }] },
        { attribute_id: 30, complex_id: "0", values: [{ value: "first" }, { value: "second" }] },
        { attribute_id: 10, complex_id: 0, values: [{ value: "must-not-overwrite" }] },
        { attribute_id: 40, complex_id: 1, values: [{ value: "complex-must-not-merge" }] },
        { attribute_id: 50, complex_id: 0, values: [{ value: "" }, null] },
      ],
    },
  };

  const result = await runFleetBranch(
    async (...args) => {
      calls.push(args);
      return fleetResponse;
    },
    "https://backend.example.test",
    "account-token",
    "store-a",
    "sku-123",
    "fleet-cache-key",
    (...args) => cached.push(args),
  );

  assert.deepEqual(calls, [[
    "https://backend.example.test",
    "account-token",
    "store-a",
    "collect",
    { sku: "sku-123" },
  ]]);
  assert.deepEqual(result, {
    ok: true,
    data: {
      items: [{
        attributes: [
          { key: "10", value: "existing" },
          { key: "20", value: "simple" },
          { key: "30", collection: ["first", "second"] },
        ],
      }],
    },
  });
  assert.deepEqual(cached, [["fleet-cache-key", fleetResponse]]);

  console.log("fleet collect bundle attribute merge behavior passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
