const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const helperPath = path.join(__dirname, "..", "lib", "category-readiness.js");
const context = vm.createContext({});
vm.runInContext(fs.readFileSync(helperPath, "utf8"), context, { filename: helperPath });
const api = context.SonliCategoryReadiness;

function readyState() {
  return {
    opts: { storeId: "store-a" },
    catTree: { children: [{ type_id: 20 }] },
    catTreeLoading: true,
    catTreeError: "",
    category: { typeId: 20 },
    catPath: [{ type_id: 20 }],
    attrsSchema: [{ id: 30 }],
    reqAttrs: [{ id: 30 }],
    ratingAttrs: [{ id: 31 }],
    categoryDataError: "",
    categoryDataReady: true,
  };
}

{
  const state = readyState();
  const scope = api.captureReadyScope(state);
  assert.equal(Object.isFrozen(scope), true);
  assert.equal(api.requireReadyScope(state, scope), true);

  api.failAttributes(state, new Error("offline"));
  assert.throws(() => api.requireReadyScope(state, scope), /Ozon/);
}

{
  const state = readyState();
  const scope = api.captureReadyScope(state);
  state.opts.storeId = "store-b";
  assert.throws(() => api.requireReadyScope(state, scope), /Ozon/);
}

{
  const state = readyState();
  const scope = api.captureReadyScope(state);
  state.category = { typeId: 20 };
  assert.throws(() => api.requireReadyScope(state, scope), /Ozon/);
}

{
  const state = readyState();
  const category = state.category;
  api.invalidateRestored(state);
  assert.equal(state.category, category);
  assert.equal(state.catTree, null);
  assert.equal(state.categoryDataReady, false);
  assert.match(state.categoryDataError, /Ozon/);
  assert.equal(state.attrsSchema.length, 0);
  assert.equal(state.reqAttrs.length, 0);
  assert.equal(state.ratingAttrs.length, 0);
  assert.throws(() => api.requireReady(state), /Ozon/);
}

{
  const state = readyState();
  api.failTree(state, new Error("offline"));
  assert.equal(state.catTree, null);
  assert.equal(state.catTreeLoading, false);
  assert.equal(state.category, null);
  assert.equal(state.catPath.length, 0);
  assert.equal(state.attrsSchema.length, 0);
  assert.equal(state.reqAttrs.length, 0);
  assert.equal(state.ratingAttrs.length, 0);
  assert.equal(state.categoryDataReady, false);
  assert.match(state.catTreeError, /Ozon/);
  assert.match(state.categoryDataError, /Ozon/);
  assert.throws(() => api.requireReady(state), /Ozon/);
}

{
  const state = readyState();
  api.failAttributes(state, new Error("offline"));
  assert.deepEqual(state.catTree, { children: [{ type_id: 20 }] });
  assert.deepEqual(state.category, { typeId: 20 });
  assert.deepEqual(state.catPath, [{ type_id: 20 }]);
  assert.equal(state.attrsSchema.length, 0);
  assert.equal(state.reqAttrs.length, 0);
  assert.equal(state.ratingAttrs.length, 0);
  assert.equal(state.categoryDataReady, false);
  assert.match(state.categoryDataError, /Ozon/);
}

{
  const state = readyState();
  state.attrsSchema = [];
  state.reqAttrs = [];
  state.ratingAttrs = [];
  state.categoryDataReady = false;
  state.categoryDataError = "offline";
  api.markReady(state);
  assert.equal(state.categoryDataReady, true);
  assert.equal(state.categoryDataError, "");
  assert.equal(api.requireReady(state), true);
}

for (const state of [
  { ...readyState(), categoryDataReady: false },
  { ...readyState(), categoryDataError: "offline" },
  { ...readyState(), category: null },
]) {
  assert.throws(() => api.requireReady(state), /Ozon/);
}

console.log("category readiness helper tests passed");
