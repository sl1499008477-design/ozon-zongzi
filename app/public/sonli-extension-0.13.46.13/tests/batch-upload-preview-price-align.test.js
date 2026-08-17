const fs = require("fs");
const path = require("path");
const assert = require("assert");

const root = path.resolve(__dirname, "..");
const css = fs.readFileSync(path.join(root, "batch-upload", "index.css"), "utf8");

const priceRule = css.match(/\.c-price\s*\{([^}]+)\}/);
assert(priceRule, "missing .c-price rule");
assert(
  /text-align\s*:\s*left\s*;/.test(priceRule[1]),
  ".c-price should align price values with the 售价 header",
);
assert(
  /\.c-price\s+\.price-min\s*\{[^}]*margin-left\s*:/s.test(css),
  "minimum price should remain visually attached to the sale price",
);

console.log("batch-upload preview price alignment checks passed");
