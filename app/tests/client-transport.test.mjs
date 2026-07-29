import assert from "node:assert/strict";
import test from "node:test";
import { apiResponseError } from "../src/client-transport.js";

test("HTTP request errors retain status, code, and response body for definitive handling", () => {
  const body = {
    message: "目标经营店铺已停用",
    code: "TARGET_STORE_DISABLED",
  };
  const error = apiResponseError({ status: 409 }, body);

  assert.equal(error.message, "目标经营店铺已停用");
  assert.equal(error.status, 409);
  assert.equal(error.code, "TARGET_STORE_DISABLED");
  assert.equal(error.body, body);
});
