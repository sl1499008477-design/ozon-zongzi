import test from 'node:test';
import assert from 'node:assert/strict';
import { parseOzonProductCards } from '../dist-electron/services/collection/ozon-list-parser.core.js';

test('parses modern Ozon product cards without relying on legacy paginator classes', async () => {
    const html = `
      <main data-widget="searchResultsV2">
        <div data-index="0" class="tile-root">
          <a href="/product/ochki-solntsezashchitnye-1087510030/">
            <img src="https://ir.ozone.ru/product.jpg">
          </a>
          <span class="tsHeadline500Medium">27,87 ¥</span>
          <span class="tsBodyControl400Small">184,01 ¥</span>
          <a href="/product/ochki-solntsezashchitnye-1087510030/">Очки солнцезащитные</a>
          <span class="tsBodyMBold">4.9 377 отзывов</span>
        </div>
      </main>`;
    const items = parseOzonProductCards(html, 'https://www.ozon.ru');
    assert.equal(items.length, 1);
    assert.equal(items[0].id, '1087510030');
    assert.equal(items[0].price, 27.87);
    assert.equal(items[0].oPrice, 184.01);
    assert.equal(items[0].nameLabel, 'Очки солнцезащитные');
    assert.equal(items[0].cover, 'https://ir.ozone.ru/product.jpg');
  });
