import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
process.env.QH_LOCAL_NO_DOTENV='1';
process.env.QH_LOCAL_NO_LISTEN='1';
const {handleFastCollectionRoute}=await import('../index.mjs');

test('the collector upload response exposes duplicate skips to the installed extension',async()=>{
 for(const duplicate of [true,false]){
  const body={source:'ozon',sourceSku:'2102714113',requestId:'outcome-test',capturedAt:'2026-09-12T00:00:00.000Z',payload:{sku:'2102714113',name:'Светильник'}};
  const req=Readable.from([Buffer.from(JSON.stringify(body))]);req.method='POST';req.headers={'content-type':'application/json'};
  const res={status:0,body:null,writeHead(status){this.status=status;},end(text){this.body=JSON.parse(text);}};
  await handleFastCollectionRoute(req,res,new URL('http://local/sources/ozon/collect'),{
   categoryEvidencePort:{async recordCollectionResult(){}},pipelineEnabled:()=>true,
   authenticateRequest:async()=>({id:'outcome-account'}),
   ingestCollectRequest:async()=>({duplicate,action:duplicate?'skipped':'created',item:{id:'collect-1',sku:'2102714113'},requestId:duplicate?'':'request-1'}),
  });
  assert.equal(res.status,200);
  assert.equal(res.body.duplicate,duplicate,'collector-client reads the envelope duplicate flag');
  assert.equal(res.body.data.duplicate,duplicate,'retain the existing item contract');
 }
});
