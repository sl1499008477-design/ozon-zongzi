const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const sourcePath = path.join(__dirname, "..", "background", "sync", "sync-state.js");
const source = fs.readFileSync(sourcePath, "utf8");

function loadState() {
  const storage = {};
  const context = {
    crypto: { randomUUID: () => "device-1" },
    chrome: {
      storage: {
        local: {
          get: async (key) => {
            if (Array.isArray(key)) {
              return key.reduce((out, item) => {
                out[item] = storage[item];
                return out;
              }, {});
            }
            return { [key]: storage[key] };
          },
          set: async (values) => {
            Object.assign(storage, values);
          },
        },
      },
    },
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(source, context, { filename: sourcePath });
  return context.JzSyncState;
}

(async () => {
  const state = loadState();

  assert.strictEqual(
    await state.getPostingsWatermark("store-1"),
    null,
    "missing postings watermark should read as null",
  );

  await state.setPostingsWatermark("store-1", {
    lastSuccessTo: "2026-06-26T12:00:00.000Z",
    updatedAt: "2026-06-26T12:05:00.000Z",
  });

  const storeOneWatermark = await state.getPostingsWatermark("store-1");
  assert.strictEqual(storeOneWatermark.lastSuccessTo, "2026-06-26T12:00:00.000Z");
  assert.strictEqual(storeOneWatermark.updatedAt, "2026-06-26T12:05:00.000Z");
  assert.strictEqual(
    await state.getPostingsWatermark("store-2"),
    null,
    "watermarks are store scoped",
  );

  await state.setPostingsWatermark("store-2", {
    lastSuccessTo: "2026-06-27T00:00:00.000Z",
  });

  const unchangedStoreOneWatermark = await state.getPostingsWatermark("store-1");
  assert.strictEqual(
    unchangedStoreOneWatermark.lastSuccessTo,
    "2026-06-26T12:00:00.000Z",
  );
  assert.strictEqual(
    unchangedStoreOneWatermark.updatedAt,
    "2026-06-26T12:05:00.000Z",
  );
  assert.strictEqual(
    await state.getPostingsWatermark("store-2").then((v) => v.lastSuccessTo),
    "2026-06-27T00:00:00.000Z",
  );
})();
