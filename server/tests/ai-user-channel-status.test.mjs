import test from 'node:test';
import assert from 'node:assert/strict';
import {createAiUserChannels} from '../ai-user-channels.mjs';
test('channel status is account scoped, mutually exclusive, and excludes credentials',async()=>{
 const future=new Date(Date.now()+60000).toISOString();
 const rows=[{enabled:true,lease_until:future},{enabled:true,cooldown_until:future},{enabled:true,request_status:'FAILED',error_code:'AI_GATEWAY_UNEXPECTED_EOF'},{enabled:true,request_status:'SUCCEEDED'},{enabled:false,lease_until:future},{enabled:true,connection_check:{status:'MODEL_MISSING'}}].map((r,i)=>({id:String(i),name:'channel '+i,credential:'private',...r}));
 const service=createAiUserChannels({pool:{query:async(sql,args)=>{assert.deepEqual(args,['user-a']);assert.match(sql,/WHERE c.account_id=\$1/);assert.match(sql,/WHERE account_id=\$1 AND channel_id=c.id/);return{rows};}}});
 const result=await service.workingStatus('user-a');
 assert.deepEqual(result.counts,{total:6,working:1,cooling:1,abnormal:2,idle:1,disabled:1,attention:0});
 assert.ok(!JSON.stringify(result).includes('private'));
});
