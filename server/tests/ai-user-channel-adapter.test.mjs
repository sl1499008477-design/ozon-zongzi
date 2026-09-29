import test from 'node:test';
import assert from 'node:assert/strict';
import {createAiUserChannels} from '../ai-user-channels.mjs';
import {createSub2ApiAdapter} from '../sub2api-ai-adapter.mjs';
import {getAiGatewayDiagnostic} from '../ai-gateway-port.mjs';

for (const [status, upstreamCode, expectedCode, notSent] of [
 [429, 'insufficient_quota', 'AI_GATEWAY_QUOTA_EXHAUSTED', true],
 [504, 'upstream_timeout', 'RETRYABLE_GATEWAY', false],
]) test(`user channel preserves diagnostic evidence and isolates ${expectedCode}`, async () => {
 const row={id:'channel-a',account_id:'user-a',base_url:'https://gateway.example.test/v1',text_model:'',image_model:'gpt-image-2',image_protocol:'SUB2API_OPENAI_IMAGES',credential:{}};
 const queries=[];
 const service=createAiUserChannels({
  pool:{query:async(sql,args)=>{queries.push({sql,args});return {rows:[]};},connect:async()=>({query:async sql=>({rows:sql.startsWith('WITH chosen')?[row]:[]}),release(){}})},
  cipher:{decrypt:()=> 'test-only-key'},
  gatewayFactory:options=>createSub2ApiAdapter({...options,resolveHostname:async()=>[{address:'8.8.8.8',family:4}],fetchImpl:async()=>new Response(JSON.stringify({error:{code:upstreamCode,message:'PRIVATE_PROMPT test-only-key'}}),{status,headers:{'content-type':'application/json','x-request-id':'upstream-request-1'}})}),
 });
 await assert.rejects(service.run({accountId:'user-a',taskId:'task-a',requestKey:'attempt-a'},async({gateway,profile})=>gateway.generateImage({profile,model:profile.imageModel,correlationId:'task-a',requestKey:'attempt-a',prompt:'product image'})),error=>{
  const diagnostic=getAiGatewayDiagnostic(error);
  assert.equal(error.channelId,'channel-a');
  assert.equal(diagnostic.code,expectedCode);
  assert.equal(diagnostic.requestId,'upstream-request-1');
  assert.equal(diagnostic.httpStatus,status);
  assert.equal(diagnostic.upstreamCode,upstreamCode);
  assert.equal(diagnostic.deliveryState,notSent?'NOT_SENT':'POSSIBLY_SENT');
  assert.doesNotMatch(JSON.stringify(diagnostic),/PRIVATE_PROMPT|test-only-key/);
  return true;
 });
 const recorded=queries.find(({sql})=>sql.startsWith("UPDATE ai_user_channel_requests SET status='FAILED'"));
 assert.equal(recorded.args[1],'user-a');
 assert.equal(recorded.args[2],expectedCode);
 assert.equal(recorded.args[3],'upstream-request-1');
 const released=queries.find(({sql})=>sql.startsWith('UPDATE ai_user_channels SET lease_token=NULL,lease_until=NULL,'));
 assert.equal(released.args[0],'channel-a');
 assert.equal(released.args[1],'user-a');
 assert.equal(released.args[3],true);
 assert.equal(released.args[4],notSent);
 assert.equal(released.args[5],expectedCode);
 assert.equal(released.args[6],!notSent);
});

for(const kind of ['text','image','direct']) test(`user channel supplies a synchronous credential to the real ${kind} adapter`,async()=>{
 const row={id:'channel-a',account_id:'user-a',base_url:'https://gateway.example.test/v1',text_model:'gpt-5.6-luna',image_model:'gpt-image-2',credential:{},...(kind==='direct'?{text_model:'',image_protocol:'SUB2API_OPENAI_IMAGES'}:{})};
 let sent=0;
 const service=createAiUserChannels({
  pool:{query:async()=>({rows:[]}),connect:async()=>({query:async sql=>({rows:sql.startsWith('WITH chosen')?[row]:[]}),release(){}})},
  cipher:{decrypt:()=> 'test-only-key'},
  gatewayFactory:options=>createSub2ApiAdapter({...options,resolveHostname:async()=>[{address:'8.8.8.8',family:4}],fetchImpl:async(url,options)=>{
   sent++;assert.equal(new Headers(options.headers).get('authorization'),'Bearer test-only-key');
   if(kind==='direct') { assert.ok(String(url).endsWith('/images/edits')); const form=await new Response(options.body,{headers:{'Content-Type':options.headers['Content-Type']}}).formData();assert.equal(form.get('model'),'gpt-image-2');assert.equal(form.get('response_format'),'b64_json');assert.ok(form.get('image').size>0); return new Response(JSON.stringify({data:[{b64_json:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='}]}),{headers:{'Content-Type':'application/json'}}); }
   assert.equal(JSON.parse(options.body).model,'gpt-5.6-luna');
   return new Response(JSON.stringify({id:'response-test',model:'gpt-5.6-luna',output:kind==='text'?[{type:'message',content:[{type:'output_text',text:'{"ok":true}'}]}]:[{type:'image_generation_call',status:'completed',result:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='}]}),{status:200,headers:{'content-type':'application/json'}});
  }}),
 });
 const result=await service.run({accountId:'user-a',taskId:'test-task',requestKey:'test-request'},async({gateway,profile})=>kind!=='text'?gateway.generateImage({profile,model:profile.imageModel,correlationId:'test-task',requestKey:'test-image',prompt:'A blue square.',...(kind==='direct'?{sourceImages:[{bytes:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64'),contentType:'image/png'}]}:{}),size:'1024x1024',quality:'low'}):gateway.createTextResponse({profile,model:profile.textModel,correlationId:'test-task',requestKey:'test-request',prompt:'Return JSON.',jsonSchema:{type:'object',properties:{ok:{type:'boolean'}},required:['ok'],additionalProperties:false}}));
 if(kind==='text')assert.deepEqual(result.value,{ok:true});else assert.ok(result.bytes.length>0);assert.equal(sent,1);
});
