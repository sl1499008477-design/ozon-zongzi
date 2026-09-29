import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareCollectorMedia,createCollectorMediaWorkQueue} from '../dist-electron/services/collection/media-preparer.services.js';

const gate=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const tick=()=>new Promise(setImmediate);
const item=sku=>({sku,color_image:`https://source.test/${sku}.png`,richContent:{img:{src:`https://source.test/${sku}-rich.png`}}});
function ports(overrides={}){
  const issued=[],uploaded=[],ready=new Set();
  return {issued,uploaded,options:{capabilities:{mediaDirectUploadV1:true},concurrency:3,
    prepareFile:async()=>({size:12,contentType:'image/png',md5:'checksum',cleanup:async()=>{}}),
    issue:async(_run,_lease,source)=>{issued.push(source);return {uploadId:source.sourceUrl};},
    confirm:async(_run,_lease,id)=>{if(!ready.has(id))throw Object.assign(Error('absent'),{code:'COLLECTOR_MEDIA_NOT_UPLOADED'});return {mediaObject:{uploadId:id}};},
    upload:async ticket=>{uploaded.push(ticket.uploadId);ready.add(ticket.uploadId);},...overrides}};
}

test('a product issues no new COS ticket until every required local file is prepared',async()=>{
  const slow=gate(),started=gate();
  const p=ports({prepareFile:async source=>{
    if(source.purpose==='rich-image'){started.resolve();await slow.promise;}
    return {size:12,contentType:'image/png',md5:'checksum',cleanup:async()=>{}};
  }});
  const pending=prepareCollectorMedia(item('1'),p.options);await started.promise;
  try{for(let i=0;i<8;i++)await tick();assert.deepEqual(p.issued,[]);assert.deepEqual(p.uploaded,[]);}
  finally{slow.resolve();await pending;}
  assert.equal(p.uploaded.length,2);
});

test('one failed local file leaves existing COS receipts intact and starts no new uploads',async()=>{
  const product=item('1');product.videos=[{url:'https://source.test/already.mp4'}];
  const receipt={sourceSku:'1',purpose:'video',index:0,sourceUrl:product.videos[0].url,uploadId:'already'};
  product.mediaObjects=[receipt];let released=0;
  const p=ports({prepareFile:async source=>{
    if(source.purpose==='rich-image'){await tick();throw Object.assign(Error('broken source'),{code:'ECONNRESET'});}
    return {size:12,contentType:'image/png',md5:'checksum',cleanup:async()=>{released++;}};
  }});
  const result=await prepareCollectorMedia(product,p.options);
  assert.equal(result.mediaPreparation.status,'waiting');assert.deepEqual(result.mediaObjects,[receipt]);
  assert.deepEqual(p.issued,[]);assert.deepEqual(p.uploaded,[]);assert.equal(released,1);
});

test('several product barriers finish through a single shared network slot without deadlock',async()=>{
  const queue=createCollectorMediaWorkQueue({concurrency:1,videoConcurrency:1}),finished=new Set();
  const p=ports({runMediaWork:(work,options)=>queue.run(work,options),prepareFile:async source=>{
    await tick();finished.add(source.sourceUrl);return {size:12,contentType:'image/png',md5:'checksum',cleanup:async()=>{}};
  }});
  const issue=p.options.issue;p.options.issue=async(...args)=>{
    const source=args[2];assert.ok(finished.has(`https://source.test/${source.sourceSku}.png`));
    assert.ok(finished.has(`https://source.test/${source.sourceSku}-rich.png`));return issue(...args);
  };
  let timeout;
  try{
    const results=await Promise.race([Promise.all(['1','2','3','4'].map(sku=>prepareCollectorMedia(item(sku),p.options))),
      new Promise((_,reject)=>{timeout=setTimeout(()=>reject(Error('product barrier held a shared queue slot')),1000);})]);
    assert.ok(results.every(result=>result.mediaPreparation.status==='ready'));assert.equal(p.uploaded.length,8);
  }finally{clearTimeout(timeout);}
});

test('a ticket with different expected bytes cannot PUT the staged source',async()=>{
  const p=ports({issue:async()=>({uploadId:'changed',intent:{size:12,contentType:'image/png',md5:'different'}})});
  const result=await prepareCollectorMedia({sku:'1',color_image:'https://source.test/a.png'},p.options);
  assert.equal(result.mediaPreparation.status,'waiting');assert.equal(result.mediaPreparation.diagnostics[0].code,'COLLECTOR_MEDIA_SOURCE_CHANGED');
  assert.deepEqual(p.uploaded,[]);
});
