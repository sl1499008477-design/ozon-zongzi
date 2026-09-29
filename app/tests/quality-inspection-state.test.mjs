import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectionOrderKey, inspectionPrefixes, startInspectionReminders } from '../src/use-quality-inspection.js';
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const flush=()=>new Promise(resolve=>setImmediate(resolve));
const summary=(count,latest=[])=>({unreadCount:count,total:count,latest,checkedAt:'2026-09-12T00:00:00Z'});
function harness(){
 const doc=new EventTarget();doc.hidden=false;
 const calls=[],views=[],timers=new Map();let serial=0;
 const feed=startInspectionReminders({document:doc,request:(path,options={})=>{const pending=deferred();calls.push({path,options,...pending});return pending.promise;},onChange:view=>views.push(view),setTimeoutFn:fn=>{timers.set(++serial,fn);return serial;},clearTimeoutFn:id=>timers.delete(id)});
 return {feed,doc,calls,views,timers};
}
test('prefix whole-array edits keep leading zeroes, allow empty settings and reject malformed entries',()=>{
 assert.deepEqual(inspectionPrefixes(['02131','02478','02090','02782','02793','02809']),['02131','02478','02090','02782','02793','02809']);
 assert.deepEqual(inspectionPrefixes([]),[]);
 assert.deepEqual(inspectionPrefixes([' 02131 ','02131','02478']),['02131','02478']);
 for(const value of [['2131'],['021310'],['02a31'],[2131]])assert.throws(()=>inspectionPrefixes(value),/5 位数字/);
 assert.notEqual(inspectionOrderKey({storeId:'store-a',orderNumber:'02131-1'}),inspectionOrderKey({storeId:'store-b',orderNumber:'02131-1'}));
});
test('ACK uses exact displayed order identities and an older poll cannot revive the unread badge',async()=>{
 const h=harness();const old=h.calls[0];
 const ack=h.feed.markRead([{storeId:'store-a',orderNumber:'02131-1',postings:[{},{}]}]);
 assert.equal(old.options.signal.aborted,true);
 assert.equal(h.calls[1].path,'/ozon/order-inspection/read');
 assert.deepEqual(h.calls[1].options.body,{items:[{storeId:'store-a',orderNumber:'02131-1'}]});
 h.calls[1].resolve(summary(1,[{storeId:'store-b',orderNumber:'02478-new'}]));await ack;
 old.resolve(summary(8));await flush();
 assert.equal(h.views.at(-1).summary.unreadCount,1);
 assert.equal(h.views.at(-1).summary.latest[0].orderNumber,'02478-new');
 h.feed.stop();
});
test('ending an account scope aborts its read and ignores late results',async()=>{
 const h=harness();const count=h.views.length;h.feed.stop();
 assert.equal(h.calls[0].options.signal.aborted,true);
 h.calls[0].resolve(summary(9));await flush();
 assert.equal(h.views.length,count);assert.equal(h.timers.size,0);
 assert.equal(await h.feed.markRead([{storeId:'old-store',orderNumber:'02131-1'}]),false);
 assert.equal(h.calls.length,1);
});
test('polling waits for completion, pauses while hidden, and refreshes on visibility without store filtering',async()=>{
 const h=harness();assert.equal(h.timers.size,0);
 assert.equal(h.calls[0].path,'/ozon/order-inspection/summary');
 h.calls[0].resolve(summary(2));await flush();assert.equal(h.timers.size,1);
 h.doc.hidden=true;h.doc.dispatchEvent(new Event('visibilitychange'));assert.equal(h.timers.size,0);
 h.doc.hidden=false;h.doc.dispatchEvent(new Event('visibilitychange'));assert.equal(h.calls.length,2);
 h.calls[1].resolve(summary(3));await flush();assert.equal(h.views.at(-1).summary.unreadCount,3);
 h.feed.stop();
});
test('failed acknowledgement preserves unread state and a logged-out request stops polling',async()=>{
 const h=harness();h.calls[0].resolve(summary(2));await flush();
 const ack=h.feed.markRead([{storeId:'a',orderNumber:'02131-1'}]);
 h.calls[1].reject(new Error('保存失败'));assert.equal(await ack,false);
 assert.equal(h.views.at(-1).summary.unreadCount,2);assert.match(h.views.at(-1).error,/保存失败/);
 const read=h.feed.refresh();h.calls[2].reject(Object.assign(new Error('请重新登录'),{status:401}));await read;
 assert.equal(h.timers.size,0);assert.equal(h.views.at(-1).summary,null);
 h.feed.stop();
});
