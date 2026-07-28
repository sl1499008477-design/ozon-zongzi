import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import {
  activeTestFiles,
  discoverTestFiles,
  historicalTestExclusions,
} from "./test-manifest.mjs";

const discovered = discoverTestFiles();
for (const [file, reason] of Object.entries(historicalTestExclusions)) {
  assert.equal(existsSync(file), true, `历史测试清单中的文件不存在：${file}`);
  assert.ok(String(reason || "").trim().length >= 12, `历史测试必须说明不可运行原因：${file}`);
}
assert.equal(
  activeTestFiles.length + Object.keys(historicalTestExclusions).length,
  discovered.length,
  "每个测试必须自动纳入门禁，或明确登记为历史专项测试",
);
assert.equal(activeTestFiles.length > 0, true, "现行测试清单不能为空");

console.log(
  `test inventory ok: ${activeTestFiles.length} active, `
  + `${Object.keys(historicalTestExclusions).length} historical/manual`,
);
