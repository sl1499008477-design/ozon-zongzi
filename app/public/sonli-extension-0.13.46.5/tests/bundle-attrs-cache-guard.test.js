// bundle 空属性缓存守卫回归(源码断言,风格同 collector-manual-start.test.js):
// 实测坑 sku=3270906481:瞬时降级的空属性 bundle 被 24h 缓存复用 → 批量上架特征属性
// 全缺、内容评分「特征」0/30。守住三条线:
//   1) 读侧:无 attributes 的缓存条目不得直接复用(除非 attrsEmptyVerifiedAt 验证期内);
//   2) 写侧:真拉仍无属性 → 打 attrsEmptyVerifiedAt 标记(短期复用,避免每次真拉);
//   3) 观测:searchVariants 对空属性 bundle 留 warn 痕(区分「源本就没有」vs「取数降级」)。
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const sw = fs.readFileSync(
  path.join(__dirname, "..", "background", "service-worker.js"),
  "utf8",
);

assert(
  /const cachedHasAttrs = Array\.isArray\(cached\.item\.attributes\) && cached\.item\.attributes\.length > 0;/.test(sw),
  "bundle cache read must check cached item attributes presence",
);
assert(
  /attrsEmptyVerifiedAt && Date\.now\(\) - attrsEmptyVerifiedAt < 6 \* 60 \* 60 \* 1000/.test(sw),
  "attrs-empty cached bundle may only be reused within the 6h verification window",
);
assert(
  /const hasSimpleAttrs = Array\.isArray\(item\.attributes\) && item\.attributes\.length > 0;/.test(sw) &&
    /attrsEmptyVerifiedAt: Date\.now\(\)/.test(sw),
  "bundle cache write must stamp attrsEmptyVerifiedAt when fetched item has no attributes",
);
assert(
  /bundle attributes EMPTY for sku=/.test(sw),
  "searchVariants must warn when bundle returns no attributes",
);

console.log("bundle attrs cache guard test passed");
