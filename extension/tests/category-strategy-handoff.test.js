const assert = require('node:assert/strict');
const test = require('node:test');

const { projectBrowserUrl } = require('../lib/category-strategy-handoff.js');

const VALID = 'https://www.ozon.ru/category/nabory-skladnoy-mebeli-11504/'
  + '?zongziCategoryStrategySession=session-a';
const LEGACY_PRODUCT = 'https://www.ozon.ru/product/'
  + 'mqouo-shkaf-skladnoy-turisticheskiy-1941181573/'
  + '?zongziCategoryStrategySession=session-a';

test('sampling browser URL accepts one exact Ozon category session URL', () => {
  assert.equal(projectBrowserUrl(VALID), VALID);
  assert.equal(projectBrowserUrl(LEGACY_PRODUCT), LEGACY_PRODUCT);
});

test('sampling browser URL rejects every authority, path, query, and identifier escape', () => {
  const accessor = {};
  Object.defineProperty(accessor, 'toString', { enumerable: true, get() {
    throw new Error('must not execute');
  } });
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  for (const value of [
    '',
    ` ${VALID}`,
    'https://attacker.test/category/nabory-skladnoy-mebeli-11504/?zongziCategoryStrategySession=session-a',
    'https://user:pass@www.ozon.ru/category/nabory-skladnoy-mebeli-11504/?zongziCategoryStrategySession=session-a',
    'http://www.ozon.ru/category/nabory-skladnoy-mebeli-11504/?zongziCategoryStrategySession=session-a',
    'https://www.ozon.ru/category/17028922/?zongziCategoryStrategySession=session-a',
    'https://www.ozon.ru/category/nabory-skladnoy-mebeli-11504/brand-1/?zongziCategoryStrategySession=session-a',
    'https://www.ozon.ru/product/17028922/?zongziCategoryStrategySession=session-a',
    'https://www.ozon.ru/category/nabory-skladnoy-mebeli-11504/',
    'https://www.ozon.ru/category/nabory-skladnoy-mebeli-11504/?zongziCategoryStrategySession=session-a&secret=x',
    'https://www.ozon.ru/category/nabory-skladnoy-mebeli-11504/?zongziCategoryStrategySession=session-a&zongziCategoryStrategySession=session-b',
    'https://www.ozon.ru/category/nabory-skladnoy-mebeli-11504/?zongziCategoryStrategySession=%2Funsafe',
    `${VALID}#fragment`,
    'x'.repeat(2_049),
    accessor,
    revoked.proxy,
  ]) assert.throws(() => projectBrowserUrl(value), {
    code: 'CATEGORY_STRATEGY_HANDOFF_URL_INVALID',
  });
});
