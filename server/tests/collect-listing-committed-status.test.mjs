import assert from 'node:assert/strict';
import test from 'node:test';

process.env.NODE_ENV='test';
process.env.QH_LOCAL_NO_LISTEN='1';
process.env.QH_LOCAL_NO_DOTENV='1';

const {testExports}=await import('../index.mjs');

test('a committed submission result survives an auxiliary listing status conflict',async()=>{
  const committed=Object.freeze({ok:true,job:{id:'job-committed'},task_id:'ozon-task'});
  const calls=[];
  const returned=await testExports.syncCommittedCollectListingState({
    result:committed,
    updateStatus:async patch=>{
      calls.push(patch);
      throw Object.assign(new Error('draft changed concurrently'),{code:'DRAFT_VERSION_CONFLICT'});
    },
    logWarning:()=>{},
  });
  assert.equal(returned,committed);
  assert.deepEqual(calls,[{
    status:'上架中',listingTaskId:'ozon-task',listingJobId:'job-committed',listingLastError:'',
  }]);
});

test('collection listing preview explicitly uses the submit category policy without changing public preview defaults',()=>{
  assert.equal(testExports.resolvePreviewCategoryMatchPolicy({},'TARGET_STORE_EXACT'),'TARGET_STORE_EXACT');
  assert.equal(testExports.resolvePreviewCategoryMatchPolicy({}),'DEFAULT');
  assert.equal(testExports.resolvePreviewCategoryMatchPolicy({entry:'COLLECT_EDIT_AUTO_CATEGORY'}),'TARGET_STORE_EXACT');
});

test('an ACTIVE account-shared category supplies the exact listing target without accepting unresolved evidence',()=>{
  const stale={status:'MATCHED',target:{storeId:'store-a',descriptionCategoryId:76222737,typeId:97000001}};
  const item={id:'collect-a',categoryResolution:stale,listingDraft:{sku:'707743WE',title:'sample',
    categoryResolution:stale,variants:[{sku:'707743WE',categoryResolution:stale}]}};
  const active=testExports.applyAccountSharedListingCategory(item,{
    status:'ACTIVE',currentDescriptionCategoryId:76107195,currentTypeId:970665788,
  },'store-a');
  assert.deepEqual(active.listingDraft.categoryResolution,{
    status:'MATCHED',method:'ACCOUNT_SHARED_ACTIVE',
    target:{storeId:'store-a',descriptionCategoryId:76107195,typeId:970665788},
  });
  const [listingItem]=testExports.buildCollectBoxListingItems(active,'store-a');
  assert.equal(listingItem.description_category_id,76107195);
  assert.equal(listingItem.type_id,970665788);
  assert.equal(item.listingDraft.categoryResolution,stale);
  assert.deepEqual(active.listingDraft.variants[0].categoryResolution,active.listingDraft.categoryResolution);
  const unresolved=testExports.applyAccountSharedListingCategory(item,{
    status:'NEEDS_REVIEW',currentDescriptionCategoryId:76107195,currentTypeId:970665788,
  },'store-a');
  const [blocked]=testExports.buildCollectBoxListingItems(unresolved,'store-a');
  assert.equal(Number(blocked.description_category_id || 0),0);
  assert.equal(Number(blocked.type_id || 0),0);
  assert.equal(item.listingDraft.categoryResolution,stale);
  const invalidated=testExports.applyAccountSharedListingCategory(item,{status:'INVALIDATED'},'store-a');
  const [invalidatedRow]=testExports.buildCollectBoxListingItems(invalidated,'store-a');
  assert.equal(Number(invalidatedRow.description_category_id || 0),0);
  assert.equal(Number(invalidatedRow.type_id || 0),0);
});
