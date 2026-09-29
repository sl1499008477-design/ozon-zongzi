import test from 'node:test';
import assert from 'node:assert/strict';
import {aiListingTaskStatus} from '../src/ai-listing-page-state.js';

const daily={code:'DAILY_LIMIT',message:'每日新增额度不足，需要 5 个，剩余 3 个。',retryAt:Date.parse('2026-09-26T00:05:00Z')};

test('daily quota wait is visible before generation and submission with a Beijing recheck time',()=>{
  for(const status of ['GENERATING','READY_TO_SUBMIT','SUBMITTED']){
    const view=aiListingTaskStatus({status,generationStage:'waiting_quota',quotaWait:daily});
    assert.equal(view.label,'等待每日额度');
    assert.equal(view.color,'gold');
    assert.match(view.description,/需要 5 个，剩余 3 个/);
    assert.match(view.description,/2026-09-26 08:05.*北京时间/);
    assert.match(view.description,/确认.*可用.*继续/);
  }
});

test('total capacity, query failure and reservation waiting are distinct and do not promise daily recovery',()=>{
  for(const [code,label] of [['TOTAL_LIMIT','店铺总容量不足'],['QUOTA_UNAVAILABLE','额度暂时无法确认'],['RESERVED_CAPACITY','等待店铺提交']]){
    const view=aiListingTaskStatus({status:'GENERATING',quotaWait:{code,message:'已保留生成图片'}});
    assert.equal(view.label,label);assert.match(view.description,/已保留生成图片/);
    assert.doesNotMatch(view.description,/08:05|次日|明天/);
  }
  const tooLarge=aiListingTaskStatus({status:'GENERATION_FAILED',quotaWait:{code:'GROUP_EXCEEDS_DAILY_LIMIT',message:'本商品 SKU 数超过店铺每日总限额，请分批处理'}});
  assert.equal(tooLarge.label,'额度不足，需处理');assert.equal(tooLarge.color,'red');
  assert.match(tooLarge.description,/分批处理/);assert.doesNotMatch(tooLarge.description,/自动继续/);
});

test('stale quota reason does not mask user pause, cancellation, completion or uncertain submission',()=>{
  for(const [status,label] of [['PAUSED','已暂停'],['CANCELLED','已取消'],['COMPLETED','上架完成'],['SUBMISSION_UNCERTAIN','提交结果待确认']]){
    const view=aiListingTaskStatus({status,quotaWait:daily});assert.equal(view.label,label);
    assert.doesNotMatch(view.description,/检查额度/);
  }
  assert.equal(aiListingTaskStatus({status:'GENERATING',controlAction:'pause',quotaWait:daily}).label,'正在暂停');
});

test('a partly listed product retains its success summary and explains remaining quota wait',()=>{
  const view=aiListingTaskStatus({status:'READY_TO_SUBMIT',completedSkuCount:1,quotaWait:daily});
  assert.equal(view.label,'等待每日额度');assert.match(view.description,/每日新增额度不足/);
});
