'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync('extension/lib/fx-probe.js', 'utf8');
const context = { console };
context.globalThis = context;
vm.runInNewContext(source, context, { filename: 'fx-probe.js' });

const { extractFrontendPricePair, parseMoney } = context.JzFxProbe;

assert.equal(parseMoney('1\u202f181,74\u202f¥'), 1181.74);
assert.equal(parseMoney('13 358 ₽'), 13358);

const payload = {
  widgetStates: {
    'webPrice-1': JSON.stringify({ cardPrice: '1\u202f181,74\u202f¥', price: '1\u202f246,85\u202f¥' }),
    'webAspects-1': JSON.stringify({
      aspects: [{
        variants: [
          { sku: '1111111111', price: 9827, data: { price: '869,36\u202f¥' } },
          { sku: '2774409776', price: 13358, active: true, availability: 'inStock', data: { price: '1\u202f181,74\u202f¥' } },
        ],
      }],
    }),
  },
};
const pair = extractFrontendPricePair(payload, '2774409776');
assert.equal(pair.ok, true);
assert.equal(pair.rubPrice, 13358);
assert.equal(pair.cnyPrice, 1181.74);
assert.equal(pair.evidence.basis, 'webAspects.variant.price + data.price');

const cnyOnly = extractFrontendPricePair({
  widgetStates: {
    'webPrice-2': JSON.stringify({ cardPrice: '82,72\u202f¥', price: '91,39\u202f¥' }),
  },
}, '3531258145');
assert.equal(cnyOnly.ok, false);
assert.match(cnyOnly.error, /只返回了 CNY/);

const wrongSku = extractFrontendPricePair(payload, '9999999999');
assert.equal(wrongSku.ok, false);

console.log('fx probe extraction smoke passed');
