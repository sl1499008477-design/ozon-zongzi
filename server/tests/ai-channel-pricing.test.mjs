import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeChannelPricing, estimateChannelCost, sampleChannelPricing } from '../ai-channel-pricing.mjs';

test('计价配置保留十进制精度，允许免费，拒绝负数、非法币种和不完整单价', () => {
  assert.deepEqual(normalizeChannelPricing({mode:'REQUEST',currency:'CNY',requestPrice:'0.200000'}), {mode:'REQUEST',currency:'CNY',requestPrice:'0.2'});
  assert.equal(normalizeChannelPricing({mode:'REQUEST',currency:'USD',requestPrice:'0'}).requestPrice,'0');
  assert.equal(normalizeChannelPricing(null),null);
  for (const value of [{mode:'REQUEST',currency:'USD',requestPrice:'-1'},{mode:'REQUEST',currency:'RUB',requestPrice:'1'},{mode:'TOKEN',currency:'USD',inputPrice:'1'},{mode:'REQUEST',currency:'CNY',requestPrice:'0.0000001'}]) {
    assert.throws(()=>normalizeChannelPricing(value),{code:'INVALID_CHANNEL_PRICING',statusCode:400});
  }
});
test('按次费用与切片数量无关，按量分别计算输入和补全，缺用量不记零', () => {
  assert.equal(estimateChannelCost({mode:'REQUEST',requestPrice:'0.2'},null),'0.2');
  const pricing={mode:'TOKEN',inputPrice:'1.25',outputPrice:'10'};
  assert.equal(estimateChannelCost(pricing,{inputTokens:1000000,outputTokens:100000}),'2.25');
  assert.equal(estimateChannelCost({mode:'TOKEN',inputPrice:'0.000001',outputPrice:'0'},{inputTokens:1,outputTokens:0}),'0.000000000001');
  assert.equal(estimateChannelCost(pricing,{totalTokens:100}),null);
  assert.equal(estimateChannelCost(pricing,{inputTokens:1,outputTokens:undefined}),null);
  assert.equal(estimateChannelCost(pricing,{inputTokens:0,outputTokens:0}),'0');
});
test('网关核价只作为样本估算，不能当成完整账单或猜测未知币种', () => {
  const report={currency:'CNY',latestQuota:100000,quotaPerYuan:500000,model:'image',checkedAt:'2026-09-11T01:00:00Z'};
  assert.equal(sampleChannelPricing(report).requestPrice,'0.2');
  assert.equal(sampleChannelPricing(report).source,'PRICE_SAMPLE');
  assert.equal(sampleChannelPricing({...report,currency:'USD'}),null);
  assert.equal(sampleChannelPricing({...report,latestQuota:null}),null);
});
