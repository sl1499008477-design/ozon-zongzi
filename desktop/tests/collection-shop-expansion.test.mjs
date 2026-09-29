import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const collectionSource = readFileSync(new URL('../dist-electron/services/collection/collection.services.js', import.meta.url), 'utf8');
const parseSource = readFileSync(new URL('../dist-electron/services/collection/parse.services.js', import.meta.url), 'utf8');
// Execute the actual shop-selection method and its existing money parser; only
// the browser navigation and further product collection are substituted.
const Collection = vm.runInNewContext(
    parseSource.slice(parseSource.indexOf('function parseOzonMoney'), parseSource.indexOf('function parseStorefrontPrice'))
    + collectionSource.slice(collectionSource.indexOf('export class Collection')).replace('export class', 'class')
    + '\nCollection',
);

const seller = (link, price, rating = 5) => ({ link, price: { cardPrice: { price } }, rating: { totalScore: rating } });

async function chosenShop(sellers) {
    const collection = Object.create(Collection.prototype), visited = [];
    Object.assign(collection, {
        task: { expendType: true, targetCount: 2, expendShopCount: 1 },
        targetData: 0, expendShopCount: 0,
        goodsData: new Map([['sku', { sellers: { sellers } }]]),
        parseService: { guessLikeList: new Set() },
        outputLog() {},
        mainWindowService: { changeUrl: async link => visited.push(link) },
        getHtmlData: async () => { collection.targetData = 2; },
    });
    await collection.expendShop();
    return visited;
}

test('shop selection compares CNY decimal-comma prices numerically in the existing descending order', async () => {
    assert.deepEqual(await chosenShop([
        seller('/seller/lower/', '29,50\u2009¥'),
        seller('/seller/higher/', '30 ¥'),
    ]), ['/seller/higher/']);
});

test('shop selection keeps RUB decimal-comma and grouping separators in their actual amount', async () => {
    assert.deepEqual(await chosenShop([
        seller('/seller/lower/', '1\u00a0200,50 ₽'),
        seller('/seller/higher/', '1 300 ₽'),
    ]), ['/seller/higher/']);
});

test('shop selection does not compare different or unknown currencies as the same money', async () => {
    for (const other of ['9999 ₽', '9999']) {
        assert.deepEqual(await chosenShop([
            seller('/seller/rating-first/', '100 ¥', 5),
            seller('/seller/other-currency/', other, 4.5),
        ]), ['/seller/rating-first/']);
    }
});
