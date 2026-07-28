import assert from "node:assert/strict";
import test from "node:test";

import {
  findChineseMobileNumberFindings,
  findCredentialLiteralFindings,
} from "../../scripts/check-personal-data.mjs";

test("detects Chinese mobile numbers without returning the sensitive value", () => {
  const mobile = ["1", "38", "0000", "0000"].join("");
  const findings = findChineseMobileNumberFindings(`当前用户 ${mobile}`);

  assert.deepEqual(findings, [{ index: 5, kind: "chinese-mobile-number" }]);
  assert.equal(JSON.stringify(findings).includes(mobile), false);
});

test("ignores a mobile-shaped substring inside a long hexadecimal digest", () => {
  const digest = ["a7f4", "1380", "000", "0000", "bc91d2e5"].join("");

  assert.deepEqual(findChineseMobileNumberFindings(`sha256=${digest}`), []);
});

test("preserves the existing credential literal detection without returning its value", () => {
  const credentialValue = ["123", "456", "789"].join("");
  const literal = ["client_id=", credentialValue].join("");
  const findings = findCredentialLiteralFindings(literal);

  assert.deepEqual(findings, [{ index: 0, kind: "credential-literal" }]);
  assert.equal(JSON.stringify(findings).includes(credentialValue), false);
});
