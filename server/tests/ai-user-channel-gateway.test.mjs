import test from 'node:test';
import assert from 'node:assert/strict';
import { createUserChannelGateway } from '../ai-user-channel-gateway.mjs';

test('旧流程的文字和图片请求使用用户通道，保留冻结模型并记录归属',async()=>{
 const calls=[];const profile={id:'frozen',accountId:'user-a',textModel:'text-a',imageModel:'image-a'};
 const channels={run:async(input,call)=>{calls.push(input);return call({profile:{...profile,id:'dedicated'},gateway:{
  createTextResponse:async input=>{assert.equal(input.profile.id,'dedicated');return {value:{ok:true},requestId:'text-request'};},
  generateImage:async input=>{assert.equal(input.model,'image-a');return {bytes:Buffer.from('image'),requestId:'image-request'};},
 }});}};
 const gateway=createUserChannelGateway(channels);
 assert.deepEqual(await gateway.createTextResponse({profile,model:'text-a',correlationId:'job',requestKey:'text'}),{value:{ok:true},requestId:'text-request'});
 assert.equal((await gateway.generateImage({profile,model:'image-a',correlationId:'job',requestKey:'image'})).requestId,'image-request');
 assert.deepEqual(calls.map(x=>[x.accountId,x.textModel,x.imageModel,x.taskId]),[['user-a','text-a','image-a','job'],['user-a','text-a','image-a','job']]);
});
test('没有用户通道时不能调用旧网关或偷偷替换模型',async()=>{
 const gateway=createUserChannelGateway({run:async()=>{throw Object.assign(new Error('unassigned'),{code:'AI_GATEWAY_NO_CAPACITY'});}});
 await assert.rejects(gateway.createTextResponse({profile:{accountId:'user-b',textModel:'old',imageModel:'image'},requestKey:'one'}),{code:'AI_GATEWAY_NO_CAPACITY'});
});
