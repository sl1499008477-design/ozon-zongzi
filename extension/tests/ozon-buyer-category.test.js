const assert = require('node:assert/strict');
const test = require('node:test');

const {
  findLeafCategoryUrl,
  projectCategoryUrl,
} = require('../lib/ozon-buyer-category.js');

const LEAF = 'https://www.ozon.ru/category/nabory-skladnoy-mebeli-11504/';

test('projects one real Ozon buyer category path and strips tracking data', () => {
  assert.equal(
    projectCategoryUrl(`${LEAF}?at=tracking#ignored`),
    LEAF,
  );
});

test('selects the last single-segment buyer category and ignores a brand breadcrumb', () => {
  const links = [
    '/category/turizm-i-otdyh-na-prirode-11424/',
    '/category/skladnaya-pohodnaya-mebel-32938/',
    '/category/nabory-skladnoy-mebeli-11504/',
    '/category/nabory-skladnoy-mebeli-11504/mqouo-101091944/',
  ].map((href) => ({ href: new URL(href, 'https://www.ozon.ru').href }));
  const root = {
    querySelectorAll(selector) {
      assert.equal(selector, 'a[href*="/category/"]');
      return links;
    },
  };
  assert.equal(findLeafCategoryUrl(root), LEAF);
});

test('rejects numeric Seller taxonomy paths and every authority/path escape', () => {
  for (const value of [
    'https://www.ozon.ru/category/17029005/',
    'https://attacker.test/category/nabory-skladnoy-mebeli-11504/',
    'http://www.ozon.ru/category/nabory-skladnoy-mebeli-11504/',
    'https://www.ozon.ru/category/nabory-skladnoy-mebeli-11504/brand-1/',
    'https://www.ozon.ru/product/example-1941181573/',
  ]) assert.throws(() => projectCategoryUrl(value), { code: 'OZON_BUYER_CATEGORY_URL_INVALID' });
});

