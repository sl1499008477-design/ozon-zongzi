import assert from "node:assert/strict";
import test from "node:test";
import {
  PERMISSIONS,
  assertPermission,
  hasPermission,
  permissionMatrix,
} from "../permissions.mjs";
import { COLLECTOR_PERMISSIONS } from "../collector-auth-service.mjs";

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

test("Collector Ozon reads are scoped to the explicit four-permission collector contract", () => {
  assert.deepEqual(COLLECTOR_PERMISSIONS, [
    "collector.upload",
    "collector.job.read",
    "collector.config.read",
    "collector.ozon.read",
  ]);
  assert.equal(hasPermission(admin, "collector.ozon.read"), false);
  assert.equal(hasPermission(user, "collector.ozon.read"), false);
});
