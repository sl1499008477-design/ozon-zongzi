import test from 'node:test';
import assert from 'node:assert/strict';
import {readDailyListingSummary} from '../daily-listing-summary.mjs';

test('daily listing summary uses Beijing midnight and keeps store identities and coverage explicit', async () => {
  const calls=[];
  const pool={query:async(sql,values)=>{
    calls.push({sql,values});
    if(sql.includes('listing_success_tracking'))return {rows:[{started_at:'2026-09-27T10:00:00.000Z'}]};
    return {rows:[{store_id:'first',store_name:'主店',count:2},{store_id:'second',store_name:'第二店',count:1}]};
  }};
  const result=await readDailyListingSummary({pool,accountId:'owner',now:Date.parse('2026-09-27T16:00:00Z')});
  assert.deepEqual(result,{count:3,date:'2026-09-28',timeZone:'Asia/Shanghai',byStore:[
    {storeId:'first',storeName:'主店',count:2},{storeId:'second',storeName:'第二店',count:1}],complete:true,note:''});
  const values=calls.find(call=>call.sql.includes('listing_successes')).values;
  assert.equal(values[0],'owner');
  assert.equal(new Date(values[1]).toISOString(),'2026-09-27T16:00:00.000Z');
  assert.equal(new Date(values[2]).toISOString(),'2026-09-28T16:00:00.000Z');
});

test('activation day is explicitly partial and a failed read never becomes a zero',async()=>{
  const pool={query:async sql=>({rows:sql.includes('listing_success_tracking')?[{started_at:'2026-09-27T10:00:00Z'}]:[]})};
  const result=await readDailyListingSummary({pool,accountId:'owner',now:Date.parse('2026-09-27T15:59:59Z')});
  assert.equal(result.count,0);assert.equal(result.complete,false);assert.match(result.note,/历史.*时间/);assert.match(result.note,/不计入.*重试/);
  await assert.rejects(readDailyListingSummary({pool:{query:async()=>{throw new Error('database unavailable');}},accountId:'owner'}),/database unavailable/);
});
