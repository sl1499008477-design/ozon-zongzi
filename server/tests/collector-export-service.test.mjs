import assert from "node:assert/strict";
import {
  COLLECTOR_EXPORT_LIMITS,
  generateCollectorRunExcelExport,
  XLSX_CONTENT_TYPE,
} from "../collector-export-service.mjs";

let missingAccountSideEffects = 0;
await assert.rejects(
  () => generateCollectorRunExcelExport({ runId: "run-without-account" }, {
    service: {
      createCollectorExport: async () => {
        missingAccountSideEffects += 1;
        return { id: "must-not-exist" };
      },
      updateCollectorExport: async () => {
        missingAccountSideEffects += 1;
        return { id: "must-not-exist" };
      },
      listCollectorRunItems: async () => {
        missingAccountSideEffects += 1;
        return [];
      },
    },
    buildExcel: async () => Buffer.from("must-not-build"),
  }),
  (error) => error?.code === "COLLECTOR_ACCOUNT_REQUIRED",
);
assert.equal(missingAccountSideEffects, 0);

const transitions = [];
const pages = [
  [{ id: "item-1", exportData: { id: "sku-1" } }],
  [],
];
const service = {
  createCollectorExport: async (input) => ({ id: "export-1", status: "PENDING", ...input }),
  updateCollectorExport: async ({ exportId, patch }) => {
    transitions.push(patch);
    return { id: exportId, ...patch };
  },
  listCollectorRunItems: async (query) => {
    assert.equal(query.accountId, "acct-1");
    assert.equal(query.runId, "run-1");
    assert.equal(query.status, "QUALIFIED");
    return pages.shift();
  },
};

let buildItems = null;
const result = await generateCollectorRunExcelExport({
  accountId: "acct-1",
  runId: "run-1",
  fileName: "测试导出",
}, {
  service,
  buildExcel: async (items, options) => {
    buildItems = items;
    await options.onImageError(Object.assign(new Error("bad image"), { code: "IMAGE_BAD" }), {
      rowNumber: 3,
      column: 49,
      url: "https://image.invalid/a.webp",
    });
    return Buffer.from("xlsx");
  },
  putObject: async ({ key, name, contentType, buffer }) => {
    assert.match(key, /^collector\/acct-1\/run-1\/export-1-/);
    assert.equal(name, "测试导出.xlsx");
    assert.equal(contentType, XLSX_CONTENT_TYPE);
    assert.equal(buffer.toString(), "xlsx");
    return { key: "exports/test.xlsx", bucket: "test", contentType, size: 4, sha256: "abc" };
  },
});

assert.equal(buildItems.length, 1);
assert.equal(result.export.status, "READY");
assert.equal(result.export.objectKey, "exports/test.xlsx");
assert.equal(result.export.itemCount, 1);
assert.equal(result.export.metadata.columnCount, 63);
assert.deepEqual(result.export.metadata.limits, {
  maxItems: COLLECTOR_EXPORT_LIMITS.maxItems,
  maxImagePixels: COLLECTOR_EXPORT_LIMITS.maxImagePixels,
});
assert.equal(result.imageErrors[0].code, "IMAGE_BAD");
assert.deepEqual(transitions.map((patch) => patch.status), ["GENERATING", "READY"]);

const failedTransitions = [];
await assert.rejects(
  () => generateCollectorRunExcelExport({ accountId: "acct-1", runId: "run-2" }, {
    service: {
      ...service,
      createCollectorExport: async () => ({ id: "export-failed" }),
      listCollectorRunItems: async () => [],
      updateCollectorExport: async ({ exportId, patch }) => {
        failedTransitions.push(patch);
        return { id: exportId, ...patch };
      },
    },
    buildExcel: async () => { throw Object.assign(new Error("write failed"), { code: "WRITE_FAILED" }); },
  }),
  (error) => error?.code === "WRITE_FAILED" && error?.exportId === "export-failed",
);
assert.deepEqual(failedTransitions.map((patch) => patch.status), ["GENERATING", "FAILED"]);

const limitTransitions = [];
let limitedBuildCalled = false;
await assert.rejects(
  () => generateCollectorRunExcelExport({ accountId: "acct-1", runId: "run-limit" }, {
    maxExportItems: 1,
    service: {
      createCollectorExport: async () => ({ id: "export-limit" }),
      listCollectorRunItems: async () => [
        { id: "item-1", exportData: { id: "sku-1" } },
        { id: "item-2", exportData: { id: "sku-2" } },
      ],
      updateCollectorExport: async ({ exportId, patch }) => {
        limitTransitions.push(patch);
        return { id: exportId, ...patch };
      },
    },
    buildExcel: async () => {
      limitedBuildCalled = true;
      return Buffer.from("should-not-build");
    },
  }),
  (error) => error?.code === "COLLECTOR_EXPORT_ITEM_LIMIT_EXCEEDED"
    && error?.maxItems === 1
    && error?.exportId === "export-limit",
);
assert.equal(limitedBuildCalled, false);
assert.deepEqual(limitTransitions.map((patch) => patch.status), ["GENERATING", "FAILED"]);
assert.equal(limitTransitions.at(-1).errorCode, "COLLECTOR_EXPORT_ITEM_LIMIT_EXCEEDED");

const twoByTwoPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVR4nGP4z8DwH4QZYAwAR8oH+WdZbrcAAAAASUVORK5CYII=",
  "base64",
);
await assert.rejects(
  () => generateCollectorRunExcelExport({ accountId: "acct-1", runId: "run-pixel-limit" }, {
    maxImagePixels: 1,
    service: {
      createCollectorExport: async () => ({ id: "export-pixel-limit" }),
      listCollectorRunItems: async () => [],
      updateCollectorExport: async ({ exportId, patch }) => ({ id: exportId, ...patch }),
    },
    buildExcel: async (_items, options) => {
      await options.convertImage(twoByTwoPng, {});
      return Buffer.from("should-not-build");
    },
  }),
  (error) => error?.code === "COLLECTOR_EXPORT_IMAGE_PIXEL_LIMIT"
    && error?.maxImagePixels === 1
    && error?.exportId === "export-pixel-limit",
);

console.log("collector export service tests passed");
