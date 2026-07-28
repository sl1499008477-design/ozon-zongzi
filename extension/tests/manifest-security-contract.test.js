const assert = require('node:assert/strict');
const fs = require('node:fs');
const manifest = JSON.parse(fs.readFileSync('extension/manifest.json', 'utf8'));
const assets = manifest.content_scripts.flatMap((entry) => entry.js || []);
assert.equal(assets.includes('content/collector/l1-diff.js'), false);
assert.equal(manifest.host_permissions.includes('https://open.er-api.com/*'), false);
console.log('manifest security contract passed');
