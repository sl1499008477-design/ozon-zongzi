import assert from "node:assert/strict";
import test from "node:test";
import {
  PERMISSIONS,
  assertPermission,
  hasPermission,
  permissionMatrix,
} from "../permissions.mjs";

const admin = { id: "admin", role: "admin" };
const user = { id: "user", role: "user" };

test("permission matrix separates global administration from tenant operations", () => {
  assert.equal(hasPermission(admin, PERMISSIONS.ACCOUNT_MANAGE), true);
  assert.equal(hasPermission(admin, PERMISSIONS.PRICING_MANAGE), true);
  assert.equal(hasPermission(admin, PERMISSIONS.ANNOUNCEMENT_MANAGE), true);
  assert.equal(hasPermission(user, PERMISSIONS.ACCOUNT_MANAGE), false);
  assert.equal(hasPermission(user, PERMISSIONS.PRICING_MANAGE), false);
  assert.equal(hasPermission(user, PERMISSIONS.ANNOUNCEMENT_MANAGE), false);
  assert.equal(hasPermission(user, PERMISSIONS.TENANT_OPERATE), true);
  assert.equal(permissionMatrix[PERMISSIONS.TENANT_OPERATE].scope, "OWN_ACCOUNT_AND_STORES");
});

test("unknown permissions fail closed with a stable error contract", () => {
  assert.equal(hasPermission(admin, "unknown"), false);
  assert.throws(
    () => assertPermission(user, PERMISSIONS.PRICING_MANAGE),
    (error) =>
      error?.status === 403
      && error?.code === "PERMISSION_FORBIDDEN"
      && error?.permission === PERMISSIONS.PRICING_MANAGE,
  );
});
