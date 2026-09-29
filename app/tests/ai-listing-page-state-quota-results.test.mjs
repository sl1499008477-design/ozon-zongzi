import test from 'node:test';
import assert from 'node:assert/strict';
import {aiListingTaskStatus} from '../src/ai-listing-page-state.js';

const retryAt=Date.parse('2026-09-28T00:05:00Z');

test('submission waits explain the actual recovery action instead of treating every wait as quota exhaustion',()=>{
  for(const [code,label,action] of [
    ['DAILY_LIMIT','等待每日额度',/额度可用后继续/],
    ['DAILY_UPDATE_LIMIT','等待每日更新额度',/更新额度可用后继续/],
    ['TOTAL_LIMIT','店铺总容量不足',/释放.*容量/],
    ['QUOTA_UNAVAILABLE','额度暂时无法确认',/重新查询/],
    ['QUOTA_UNKNOWN','额度暂时无法确认',/重新查询/],
    ['RATE_LIMIT','请求频率受限',/请求频率|限流/],
    ['STORE_QUEUE','等待店铺提交',/提交队列|前序商品/],
    ['RESERVED_CAPACITY','等待店铺提交',/提交队列|前序商品/],
    ['RESULT_PENDING','提交结果待确认',/原请求|原提交/],
    ['TARGET_UNAVAILABLE','店铺或仓库待确认',/重新检查.*店铺.*仓库/],
  ]){
    const waitKey=['RATE_LIMIT','STORE_QUEUE','RESULT_PENDING','TARGET_UNAVAILABLE'].includes(code)?'submissionWait':'quotaWait';
    const view=aiListingTaskStatus({status:'READY_TO_SUBMIT',[waitKey]:{code,retryAt}});
    assert.equal(view.label,label);
    assert.match(view.description,/2026-09-28 08:05.*北京时间/);
    assert.match(view.description,action);
    if(['RATE_LIMIT','STORE_QUEUE','RESERVED_CAPACITY','RESULT_PENDING','TARGET_UNAVAILABLE'].includes(code))
      assert.doesNotMatch(view.description,/确认额度可用/);
    if(code==='TOTAL_LIMIT')assert.doesNotMatch(view.description,/次日|明天/);
  }
});

test('unconfirmed listing targets do not claim exhausted quota while generation is waiting',()=>{
  const view=aiListingTaskStatus({status:'GENERATING',generationStage:'waiting_target',
    submissionWait:{code:'TARGET_UNAVAILABLE',message:'仓库查询暂时失败',retryAt}});
  assert.equal(view.label,'店铺或仓库待确认');
  assert.match(view.description,/仓库查询暂时失败.*重新检查.*店铺.*仓库/);
  assert.doesNotMatch(view.description,/额度不足|确认额度|查询店铺额度/);
});

test('an imported SKU counts as created before inventory is complete and retains its siblings daily wait',()=>{
  const task={status:'SUBMITTED',quotaWait:{code:'DAILY_LIMIT',retryAt,required:2},
    submissionResults:[
      {sku:'a',importStatus:'SUCCEEDED',productId:'101',stockStatus:'PENDING'},
      {sku:'b',importStatus:'FAILED',stockStatus:'PENDING'},
      {sku:'c',importStatus:'FAILED',stockStatus:'PENDING'},
    ]};
  const view=aiListingTaskStatus(task);
  assert.equal(view.label,'已创建 1/3，剩余 2 个等待每日额度');
  assert.match(view.description,/库存完成 0/);
  assert.equal(aiListingTaskStatus({...task,completedSkuCount:1}).label,view.label);
});

test('list summaries use trusted creation counts rather than completed inventory counts',()=>{
  const task={status:'READY_TO_SUBMIT',createdSkuCount:1,totalSkuCount:3,completedSkuCount:0,
    quotaWait:{code:'DAILY_LIMIT',required:2}};
  assert.equal(aiListingTaskStatus(task).label,'已创建 1/3，剩余 2 个等待每日额度');
  assert.equal(aiListingTaskStatus({...task,createdSkuCount:0,completedSkuCount:1}).label,'等待每日额度');
});

test('detail creation counts include Ozon creation evidence before a product id is recorded',()=>{
  const view=aiListingTaskStatus({status:'SUBMITTED',quotaWait:{code:'DAILY_LIMIT'},submissionResults:[
    {sku:'a',importStatus:'PENDING',isCreated:true},{sku:'b',importStatus:'FAILED'},
  ]});
  assert.equal(view.label,'已创建 1/2，剩余 1 个等待每日额度');
});

test('detail creation evidence includes an existing product id and excludes skipped siblings from the total',()=>{
  const task={status:'SUBMITTED',quotaWait:{code:'TOTAL_LIMIT'},
    skuProgress:[{sku:'a',status:'READY'},{sku:'b',status:'READY'},{sku:'c',status:'SKIPPED'}],
    submissionResults:[
      {sku:'a',importStatus:'FAILED',productId:'101',stockStatus:'PENDING'},
      {sku:'b',importStatus:'FAILED',productId:0,stockStatus:'PENDING'},
    ]};
  assert.equal(aiListingTaskStatus(task).label,'已创建 1/2，剩余 1 个等待店铺容量');
});

test('stale quota state does not turn failed, paused or cancelled tasks into active waits',()=>{
  for(const [status,label] of [['SUBMISSION_FAILED','提交失败'],['GENERATION_FAILED','生图失败'],['PAUSED','已暂停'],['CANCELLED','已取消']]){
    const view=aiListingTaskStatus({status,createdSkuCount:1,totalSkuCount:3,quotaWait:{code:'DAILY_LIMIT',retryAt}});
    assert.equal(view.label,label);
    assert.doesNotMatch(view.description,/下次检查|额度可用后继续/);
  }
});

test('unknown submissions stay pending result verification even with a stale daily quota reason',()=>{
  const task={status:'SUBMISSION_UNCERTAIN',createdSkuCount:1,totalSkuCount:3};
  assert.equal(aiListingTaskStatus({...task,quotaWait:{code:'DAILY_LIMIT'}}).label,'提交结果待确认');
  const view=aiListingTaskStatus({...task,submissionWait:{code:'RESULT_PENDING',retryAt}});
  assert.match(view.label,/提交结果待确认/);
  assert.match(view.description,/原请求|原提交/);
  assert.doesNotMatch(view.description,/额度可用后继续/);
});

test('a submission queue wait takes precedence over a stale quota wait without losing created counts',()=>{
  const view=aiListingTaskStatus({status:'READY_TO_SUBMIT',createdSkuCount:1,totalSkuCount:3,
    quotaWait:{code:'DAILY_LIMIT'},submissionWait:{code:'STORE_QUEUE',retryAt}});
  assert.equal(view.label,'已创建 1/3，剩余 2 个等待店铺提交');
  assert.doesNotMatch(view.description,/额度可用后继续/);
});
