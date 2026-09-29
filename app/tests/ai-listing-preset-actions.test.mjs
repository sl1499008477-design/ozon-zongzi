import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {createLatestRequestGate} from '../src/latest-request-gate.js';
const source=readFileSync(new URL('../src/AiListingPresets.jsx',import.meta.url),'utf8');
// Exercise the component's actual action handlers while validation/network work is pending.
for(const action of ['save','remove'])test(`${action} prevents an earlier configuration read from replacing manual values`,async()=>{
 const gate=createLatestRequestGate();let finishRead;let applied=false;
 const applying=gate.run({request:()=>new Promise(resolve=>{finishRead=resolve}),apply:()=>{applied=true}});
 let finishAction;
 const pending=new Promise((_,reject)=>{finishAction=()=>reject(new Error('fixture interrupted'))});
 const start=source.indexOf(` const ${action}=`);
 const end=source.indexOf(action==='save'?' const remove=':' return <>',start);
 const text=source.slice(start,end);
 const fn=new Function('applyGate','name','form','request','selected','message','setBusy','busy','setSaveError','setInvalidField',`${text};return ${action};`)(
  {current:gate},'saved name',{validateFields:()=>pending},()=>pending,'A',{error(){}},()=>{},false,()=>{},()=>{});
 const running=fn();finishRead({targetStoreId:'old'});await applying;
 finishAction();await running;
 assert.equal(applied,false);
});


test('invalid preset fields show the actual reason and correction target without sending a save',async()=>{
 const start=source.indexOf(' const save=');const text=source.slice(start,source.indexOf(' const remove=',start));
 let shown='',target,requested=false;const loading=[];
 const fn=new Function('applyGate','name','form','request','selected','message','setBusy','busy','setSaveError','setInvalidField',`${text};return save;`)(
  {current:createLatestRequestGate()},'配置',{validateFields:async()=>{throw {errorFields:[{name:['fallbackStores'],errors:['请添加至少一家备用店铺']}]};}},()=>{requested=true;},'A',{error(){}},x=>loading.push(x),false,x=>shown=x,x=>target=x);
 await fn();assert.equal(shown,'请添加至少一家备用店铺');assert.deepEqual(target,['fallbackStores']);assert.equal(requested,false);assert.deepEqual(loading,[true,false]);
});
