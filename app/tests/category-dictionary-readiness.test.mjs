import assert from "node:assert/strict";
import test from "node:test";
import * as dictionaryReadinessModule from "../src/use-category-dictionary-readiness.js";

const {
  CATEGORY_DICTIONARY_ERROR_MESSAGE,
  categoryDictionaryReadiness,
  createCategoryDictionaryRequestController,
} = dictionaryReadinessModule;

const target = { key: "30", attributeId: 30 };
const requestInput = {
  storeId: "store-a",
  itemId: "item-a",
  descriptionCategoryId: 10,
  typeId: 20,
  targets: [target],
};

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test("binds each values request to store, item, category, type, attribute and generation", async () => {
  const calls = [];
  const states = [];
  const controller = createCategoryDictionaryRequestController({
    readValues: async (input) => {
      calls.push(input);
      return [{ id: 1, value: "One" }];
    },
    formatOption: (row) => ({ value: row.id, label: row.value }),
    onState: (state) => states.push(structuredClone(state)),
  });

  assert.equal(await controller.load(requestInput), true);
  assert.deepEqual(calls, [{
    storeId: "store-a",
    itemId: "item-a",
    descriptionCategoryId: 10,
    typeId: 20,
    attributeId: 30,
    generation: 1,
  }]);
  assert.deepEqual(states.at(-1).options, {
    30: [{ value: 1, label: "One" }],
  });
  assert.equal(categoryDictionaryReadiness(states.at(-1)).ready, true);
});

test("ignores stale success and failure completions after the request scope changes", async () => {
  const staleSuccess = deferred();
  const staleFailure = deferred();
  const currentRequest = deferred();
  const states = [];
  const controller = createCategoryDictionaryRequestController({
    readValues: ({ storeId }) => ({
      "store-a": staleSuccess.promise,
      "store-b": staleFailure.promise,
      "store-c": currentRequest.promise,
    })[storeId],
    formatOption: (row) => row,
    onState: (state) => states.push(structuredClone(state)),
  });

  const staleSuccessLoad = controller.load(requestInput);
  const staleFailureLoad = controller.load({
    ...requestInput,
    storeId: "store-b",
    itemId: "item-b",
  });
  const currentLoad = controller.load({
    ...requestInput,
    storeId: "store-c",
    itemId: "item-c",
  });
  const stateAfterScopeChange = structuredClone(states.at(-1));
  assert.deepEqual(categoryDictionaryReadiness(stateAfterScopeChange), {
    ready: false,
    message: CATEGORY_DICTIONARY_ERROR_MESSAGE,
  });

  staleSuccess.resolve([{ id: 1, value: "Stale" }]);
  assert.equal(await staleSuccessLoad, false);
  assert.deepEqual(states.at(-1), stateAfterScopeChange);
  staleFailure.reject(new Error("stale upstream failure"));
  assert.equal(await staleFailureLoad, false);
  assert.deepEqual(states.at(-1), stateAfterScopeChange);

  currentRequest.resolve([{ id: 2, value: "Current" }]);
  assert.equal(await currentLoad, true);
  assert.equal(states.at(-1).error, "");
  assert.deepEqual(states.at(-1).options, {
    30: [{ id: 2, value: "Current" }],
  });
});

test("fails visibly, clears options, blocks readiness and a successful retry restores it", async () => {
  let attempt = 0;
  const retryRequest = deferred();
  const states = [];
  const controller = createCategoryDictionaryRequestController({
    readValues: async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("secret upstream body");
      return retryRequest.promise;
    },
    formatOption: (row) => row,
    onState: (state) => states.push(structuredClone(state)),
  });

  assert.equal(await controller.load(requestInput), true);
  assert.deepEqual(states.at(-1).options, {});
  assert.equal(states.at(-1).loading, false);
  assert.equal(states.at(-1).error, CATEGORY_DICTIONARY_ERROR_MESSAGE);
  assert.deepEqual(categoryDictionaryReadiness(states.at(-1)), {
    ready: false,
    message: CATEGORY_DICTIONARY_ERROR_MESSAGE,
  });
  assert.equal(JSON.stringify(states.at(-1)).includes("secret upstream body"), false);

  const retryLoad = controller.load(requestInput);
  assert.equal(states.at(-1).loading, true);
  assert.equal(states.at(-1).error, CATEGORY_DICTIONARY_ERROR_MESSAGE);
  retryRequest.resolve([]);
  assert.equal(await retryLoad, true);
  assert.deepEqual(states.at(-1).options, { 30: [] });
  assert.equal(states.at(-1).error, "");
  assert.deepEqual(categoryDictionaryReadiness(states.at(-1)), {
    ready: true,
    message: "",
  });
});

test("rejects a malformed successful values result instead of publishing authentic empty readiness", async () => {
  const states = [];
  const controller = createCategoryDictionaryRequestController({
    readValues: async () => ({ ok: true }),
    formatOption: (row) => row,
    onState: (state) => states.push(structuredClone(state)),
  });

  assert.equal(await controller.load(requestInput), true);
  assert.deepEqual(states.at(-1).options, {});
  assert.equal(states.at(-1).error, CATEGORY_DICTIONARY_ERROR_MESSAGE);
  assert.deepEqual(categoryDictionaryReadiness(states.at(-1)), {
    ready: false,
    message: CATEGORY_DICTIONARY_ERROR_MESSAGE,
  });
});

test("accepts explicit empty items or data arrays and rejects malformed 2xx response shapes", () => {
  const rowsOf = dictionaryReadinessModule.dictionaryRowsOfResponse;
  assert.equal(typeof rowsOf, "function");
  assert.deepEqual(rowsOf({ items: [] }), []);
  assert.deepEqual(rowsOf({ data: [] }), []);
  assert.throws(
    () => rowsOf({ ok: true }),
    (error) => error?.code === "OZON_CATEGORY_UI_UNAVAILABLE"
      && error.message === CATEGORY_DICTIONARY_ERROR_MESSAGE,
  );
});
