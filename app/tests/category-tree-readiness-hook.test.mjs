import assert from "node:assert/strict";
import test from "node:test";
import { useCategoryTreeReadiness } from "../src/use-category-tree-readiness.js";

test("exports the focused category tree readiness hook", () => {
  assert.equal(typeof useCategoryTreeReadiness, "function");
});
