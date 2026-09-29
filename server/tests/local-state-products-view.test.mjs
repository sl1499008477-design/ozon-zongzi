import test from 'node:test';
import assert from 'node:assert/strict';

process.env.QH_LOCAL_NO_DOTENV='1';
process.env.QH_LOCAL_NO_LISTEN='1';
process.env.NODE_ENV='test';

const {localStateRequestPlan}=await import('../index.mjs');

test('products view reads products without loading collection details or submission jobs',()=>{
  assert.deepEqual(localStateRequestPlan(new URLSearchParams('view=products')),{
    bootstrap:false,
    includeFullCollection:false,
    includeSubmissionJobs:false,
    collectIds:[],
  });
});

test('default full and bootstrap collection-detail contracts stay distinct',()=>{
  assert.deepEqual(localStateRequestPlan(new URLSearchParams()),{
    bootstrap:false,
    includeFullCollection:true,
    includeSubmissionJobs:true,
    collectIds:[],
  });
  assert.deepEqual(localStateRequestPlan(new URLSearchParams('view=bootstrap')),{
    bootstrap:true,
    includeFullCollection:false,
    includeSubmissionJobs:false,
    collectIds:[],
  });
  assert.deepEqual(localStateRequestPlan(new URLSearchParams('view=bootstrap&collectIds=one&collectIds=two')),{
    bootstrap:true,
    includeFullCollection:false,
    includeSubmissionJobs:false,
    collectIds:['one','two'],
  });
});
