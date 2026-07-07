// fleet collect 完整业务属性回归(源码断言):
// 实测坑(sku 3270906481 / 2720736474):fleet 的 mergeBundleIntoSv 从 SW 移植时漏了
// 「bundle 完整业务属性合并」(SW v0.10.26 起就有),灰度用户 searchVariants 被 fleet
// 接管后 _sourceVariant 只剩 10-12 个最小集属性 → 特征评分 0/30。守两条线:
//   1) fleet collect.ts 必须把 complex_id=0 的 bundle 业务属性合入 sv;
//   2) SW 消费 fleet collect 时,必须有 bundleItem 兜底合并(覆盖旧 fleet/旧 Redis 缓存窗口)。
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const fleetCollect = fs.readFileSync(
  path.join(__dirname, "..", "..", "ozon-fleet", "src", "fleet", "collect.ts"),
  "utf8",
);
const sw = fs.readFileSync(
  path.join(__dirname, "..", "background", "service-worker.js"),
  "utf8",
);

// fleet 侧:业务属性合并存在(complex_id=0 → { key, value | collection })
assert(
  /function mergeBundleIntoSv[\s\S]*complex_id[\s\S]*attribute_id[\s\S]*collection: vals\.map/.test(fleetCollect),
  "fleet mergeBundleIntoSv must merge simple (complex_id=0) bundle attributes into sv",
);
assert(
  /if \(!key \|\| existing\.has\(key\)\) continue;/.test(fleetCollect),
  "fleet bundle attr merge must dedupe against existing sv attribute keys",
);

// SW 侧:fleet collect 消费处有 bundleItem 兜底合并
assert(
  /const _fc = await callFleet\(backendUrl, token, storeId, 'collect', \{ sku \}\);[\s\S]*?_fc\.bundleItem[\s\S]*?attribute_id/.test(sw),
  "SW must merge fleet bundleItem simple attributes into sourceVariant as fallback",
);

console.log("fleet collect attrs merge test passed");
