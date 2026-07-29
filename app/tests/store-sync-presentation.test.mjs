import assert from "node:assert/strict";
import test from "node:test";
import { storeSyncDetailText } from "../src/store-sync-presentation.js";

test("store sync presentation renders success counts with a stable fallback", () => {
  assert.equal(storeSyncDetailText({
    status: "SUCCESS",
    result: {
      fetchedCount: 0,
      details: { fetchedCount: 99 },
    },
  }), "已同步 0 条");
  assert.equal(storeSyncDetailText({
    status: "SUCCESS",
    result: {
      details: { fetchedCount: 12 },
    },
  }), "已同步 12 条");
  assert.equal(storeSyncDetailText({
    status: "SUCCESS",
    result: {},
  }), "同步完成，数量未知");
});

test("store sync presentation renders the sanitized failure reason", () => {
  assert.equal(storeSyncDetailText({
    status: "FAILED",
    error: {
      message: "Ozon 请求暂时不可用",
      taskId: "sync_server_task",
    },
  }), "失败原因：Ozon 请求暂时不可用");
  assert.equal(storeSyncDetailText({
    status: "FAILED",
    error: {},
  }), "同步失败，请重试");
});
