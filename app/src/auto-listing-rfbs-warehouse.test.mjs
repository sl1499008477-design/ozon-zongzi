import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  autoListingTaskErrorMessage,
  autoListingWarehouseOptions,
} from "./auto-listing-config.js";

const page = await readFile(new URL("./AutoListingPage.jsx", import.meta.url), "utf8");

test("pending RFBS produces the exact safe option contract and keeps a hydrated preference", () => {
  const result = autoListingWarehouseOptions({
    targetStoreId: "store-a",
    selectedWarehouseId: "warehouse-a",
    warehouses: [{
      id: "warehouse-a",
      storeId: "store-a",
      warehouse_id: "1001",
      name: "CEL-测试",
      listingEligibility: {
        eligible: false,
        code: "RFBS_VALIDATION_REQUIRED",
        fulfillmentType: "RFBS",
        evidenceRequired: true,
      },
    }],
  });

  assert.deepEqual(result.options[0], {
    value: "warehouse-a",
    label: "CEL-测试（RFBS · 创建任务时验证）",
    fulfillmentType: "RFBS",
    evidenceRequired: true,
    statusLabel: "创建任务时验证",
  });
  assert.equal(result.selectedWarehouseId, "warehouse-a");
});

test("verified RFBS remains visibly distinct from a warehouse pending creation-time validation", () => {
  const result = autoListingWarehouseOptions({
    targetStoreId: "store-a",
    warehouses: [{
      id: "warehouse-b",
      storeId: "store-a",
      warehouse_id: "1002",
      name: "CEL-已验证",
      listingEligibility: {
        eligible: true,
        fulfillmentType: "RFBS",
        evidenceRequired: true,
      },
    }],
  });

  assert.deepEqual(result.options[0], {
    value: "warehouse-b",
    label: "CEL-已验证（RFBS · 已验证）",
    fulfillmentType: "RFBS",
    evidenceRequired: true,
    statusLabel: "已验证",
  });
});

test("changing stores clears the old pending RFBS preference", () => {
  const result = autoListingWarehouseOptions({
    targetStoreId: "store-b",
    selectedWarehouseId: "warehouse-a",
    warehouses: [{
      id: "warehouse-a", storeId: "store-a", warehouse_id: "1001", name: "CEL-测试",
      listingEligibility: {
        eligible: false, code: "RFBS_VALIDATION_REQUIRED", fulfillmentType: "RFBS", evidenceRequired: true,
      },
    }],
  });
  assert.deepEqual(result.options, []);
  assert.equal(result.selectedWarehouseId, "");
});

test("stable RFBS failures map to safe actionable copy without reflecting server text", () => {
  const cases = [
    ["RFBS_WAREHOUSE_NOT_FOUND", "未在当前店铺找到该 RFBS 仓库，请同步仓库后重试"],
    ["RFBS_WAREHOUSE_DISABLED", "该 RFBS 仓库当前不可用，请在 Ozon 启用或改选其他仓库"],
    ["RFBS_WAREHOUSE_SCOPE_MISMATCH", "仓库与当前店铺不匹配，请重新选择店铺和仓库"],
    ["RFBS_WAREHOUSE_CHANGED", "RFBS 仓库信息已变化，请同步仓库后重新选择"],
    ["RFBS_WAREHOUSE_EVIDENCE_EXPIRED", "RFBS 仓库验证已过期，请重试创建任务"],
    ["RFBS_VALIDATION_REQUIRED", "Ozon 仓库验证暂时不可用，请稍后重试"],
    ["AUTO_LISTING_RFBS_VALIDATION_FAILED", "RFBS 仓库验证失败，请稍后重试或联系管理员"],
  ];
  for (const [code, expected] of cases) {
    assert.equal(autoListingTaskErrorMessage({ code, message: "api-key-secret raw upstream body" }), expected);
  }
  assert.equal(autoListingTaskErrorMessage({ code: "OTHER", message: "ordinary safe message" }), "ordinary safe message");
  assert.equal(autoListingTaskErrorMessage(null), "任务创建失败");
});

test("page presents RFBS read-only verification and retains store-change and late-response fences", () => {
  assert.match(page, /活跃 FBS \/ RFBS 仓库/u);
  assert.match(page, /RFBS 新店仓库将在创建任务时由后端只读验证，不会在验证阶段创建商品或修改库存。/u);
  assert.match(page, /selectedWarehouseId && !warehouseChoice\.selectedWarehouseId/u);
  assert.match(page, /form\.setFieldValue\("targetWarehouseId", ""\)/u);
  assert.match(page, /requestVersion !== loadRequestRef\.current/u);
  assert.match(page, /if \(createInFlightRef\.current\) return/u);
  assert.match(page, /autoListingTaskErrorMessage\(caught\)/u);
});
