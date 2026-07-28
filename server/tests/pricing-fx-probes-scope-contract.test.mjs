import assert from "node:assert/strict";
import fs from "node:fs";
const source = fs.readFileSync(new URL("../index.mjs", import.meta.url), "utf8");
assert.match(source, /scope: \{ accountId: account\.id \}/);
assert.match(source, /const account = requireAuth\(req, state\);[\s\S]{0,500}pricing\/fx\/probes\/active/);
console.log("pricing FX probes authenticated scope contract passed");
