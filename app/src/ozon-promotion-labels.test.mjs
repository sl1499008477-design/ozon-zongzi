import assert from 'node:assert/strict';
import test from 'node:test';
import { ozonPromotionTitle, ozonPromotionTypeLabel } from './ozon-promotion-labels.mjs';

test('uses the approved campaign names, including spacing and trailing punctuation', () => {
  assert.equal(ozonPromotionTitle({ title: '  Максимальный   бустинг: усиление. ' }), '最大提升（加强版）');
  assert.equal(ozonPromotionTitle({ title: 'Максимальный бустинг' }), '最大提升');
  assert.equal(ozonPromotionTitle({ title: 'Учебные скидки' }), '学校用品折扣');
  assert.equal(ozonPromotionTitle({ title: 'Эластичный бустинг. Без ограничения срока действия' }), '弹性提升（不限期）');
});

test('unknown campaigns use the known type and distinct IDs without guessing a translation', () => {
  const campaign = Object.freeze({ id: '1001', title: 'Совершенно новая акция', type: 'STOCK_DISCOUNT' });
  assert.equal(ozonPromotionTitle(campaign), '库存折扣活动（ID 1001）');
  assert.equal(ozonPromotionTitle({ ...campaign, id: '1002' }), '库存折扣活动（ID 1002）');
  assert.equal(campaign.title, 'Совершенно новая акция');
  assert.equal(ozonPromotionTitle({ id: '1003', title: '最大提升 Новая акция', type: 'NEW_TYPE' }), '平台活动（ID 1003）');
});

test('the product price API and promotion snapshot share labels and campaign identity', () => {
  const snapshot = { id: '4273875', title: 'Максимальный бустинг: усиление', type: 'ELASTIC_BOOSTING' };
  assert.equal(ozonPromotionTitle(snapshot), '最大提升（加强版）（ID 4273875）');
  assert.equal(ozonPromotionTitle({ action_id: snapshot.id, title: snapshot.title, action_type: snapshot.type }), ozonPromotionTitle(snapshot));
  assert.equal(ozonPromotionTitle({ id: 'older', title: 'Эластичный бустинг. Без ограничения срока действия' }), '弹性提升（不限期）（ID older）');
});

test('Chinese names remain intact and missing metadata has a Chinese fallback', () => {
  assert.equal(ozonPromotionTitle({ id: '2001', title: '夏季商品折扣' }), '夏季商品折扣（ID 2001）');
  assert.equal(ozonPromotionTitle({ id: '2002', title: 'New sale', type: 'ELASTIC_BOOSTING' }), '弹性提升活动（ID 2002）');
  assert.equal(ozonPromotionTitle({ id: '2003' }), '平台活动（ID 2003）');
  assert.equal(ozonPromotionTitle({}), '平台活动');
  assert.equal(ozonPromotionTypeLabel('ELASTIC_BOOSTING'), '弹性提升');
  assert.equal(ozonPromotionTypeLabel('STOCK_DISCOUNT'), '库存折扣');
  assert.equal(ozonPromotionTypeLabel('NEW_TYPE'), '其他平台活动');
  assert.equal(ozonPromotionTypeLabel(), '类型未提供');
});
