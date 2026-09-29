import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const collectionUrl=new URL('../dist-electron/services/collection/collection.services.js',import.meta.url).href;
function probe(script){
  const profile=mkdtempSync(join(tmpdir(),'collector-pipeline-'));
  try{
    const child=spawnSync(process.execPath,['--loader',fileURLToPath(new URL('./fixtures/desktop-module-loader.mjs',import.meta.url)),
      '--loader',fileURLToPath(new URL('./fixtures/collector-media-loader.mjs',import.meta.url)),'--input-type=module','-e',`
      import assert from 'node:assert/strict';
      import {mock} from 'node:test';
      import {Collection} from ${JSON.stringify(collectionUrl)};
      const turn=()=>new Promise(setImmediate);
      const gate=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
      const until=async predicate=>{for(let i=0;i<80&&!predicate();i++)await turn();assert.ok(predicate(),'fixture did not reach its expected boundary');};
      const saved=[],reads=[],downloads=[],released=[],endings=[],exported=[],groups=new Map(),confirmed=new Set();
      const holds=new Map(),fails=new Set();let cleanupHold=null,cleanupStarted=false,abortDownload=false;
      const entries=Array.from({length:8},(_,i)=>({id:String(1001+i*1000),sku:String(1001+i*1000),price:100,nameLabel:'Товар'}));
      let pages=entries.slice(0,3),pageReads=0;
      globalThis.__SELLER_CONTEXT__={accountId:'account',source:'ozon_seller_analytics',sourceIdentity:'seller-page:account'};
      globalThis.__SELLER_ANALYTICS_ITEMS__=entries;
      globalThis.__SELLER_LEADERBOARD_HANDLER__=async options=>{pageReads++;return {items:pages.slice(options.offset,options.offset+options.limit),total:pages.length};};
      globalThis.__DESKTOP_AXIOS_HANDLER__=async request=>{
        const path=request.url,data=request.data||{};
        if(path.endsWith('/capabilities'))return {data:{capabilities:{mediaDirectUploadV1:true,eventBatch:true,exportDataFromRaw:true}}};
        if(path.endsWith('/skus/claim'))return {data:{items:data.skus.map(sku=>({sku,state:'CLAIMED'}))}};
        if(path.endsWith('/product-groups/claim')){
          const groupId='group-'+data.anchorSku;groups.set(groupId,{owner:data.anchorSku});
          return {data:{groupId,status:'CLAIMED',skus:[data.anchorSku],cachedVariants:[]}};
        }
        if(path.includes('/product-groups/')&&path.endsWith('/release')){
          released.push({groupId:path.split('/').at(-2),runId:path.split('/')[3],lease:data.leaseToken});
          groups.get(path.split('/').at(-2)).owner='';
        }
        if(path.endsWith('/claim'))return {data:{run:{id:'run'},leaseToken:'lease'}};
        if(path.endsWith('/items')&&request.method==='post'){
          for(const item of data.items){saved.push(structuredClone(item));if(item.status==='QUALIFIED'&&item.rawPayload.collectorGroupId)groups.get(item.rawPayload.collectorGroupId).owner='';}
        }
        if(['/complete','/fail','/cancel'].some(suffix=>path.endsWith(suffix)))endings.push(path.split('/').at(-1));
        return {data:{ok:true}};
      };
      globalThis.__COLLECTOR_MEDIA_IO__={
        prepareFile:async(source,{signal})=>{
          downloads.push(source.sourceSku);
          if(abortDownload){
            await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));
            cleanupStarted=true;await cleanupHold.promise;signal.throwIfAborted();
          }
          await holds.get(source.sourceSku)?.promise;
          signal.throwIfAborted();
          if(fails.has(source.sourceSku))throw Object.assign(Error('broken image'),{code:'COLLECTOR_MEDIA_FORMAT_INVALID'});
          return {path:'fixture',size:12,contentType:'image/png',md5:'fixture',cleanup:async()=>{}};
        },
        issue:async(_run,_lease,source)=>({uploadId:source.sourceSku}),
        confirm:async(_run,_lease,id)=>{if(!confirmed.has(id))throw Object.assign(Error('absent'),{code:'COLLECTOR_MEDIA_NOT_UPLOADED'});return {mediaObject:{uploadId:id}};},
        upload:async ticket=>{confirmed.add(ticket.uploadId);},
      };
      function collection(options={}){
        const c=new Collection({_id:'task',taskName:'流水线验收',isUseCategorySelect:0,aiSelectType:1,targetCount:10,concurrency:2,...options},null);
        c.runId='run';c.leaseToken='lease';c.uuid='instance';c.capabilities={mediaDirectUploadV1:true,eventBatch:true};c.query.pageSize=1;
        c.mainWindowService.getDataByApi=async sku=>{
          reads.push(String(sku));return {success:true,data:{widgetStates:{
            webGallery:{sku,images:['https://cdn.test/'+sku+'.jpg'],color_image:'https://cdn.test/'+sku+'.png'},
            webProductHeading:{sku,title:'Товар '+sku},webPrice:{price:'10.25 ¥'},
            webDescription:{richAnnotationType:'HTML',richAnnotation:'<p>Описание товара</p>'},
          }}};
        };
        c.mainWindowService.getDomain=async()=>'https://www.ozon.ru';
        c.mainWindowService.getSellingData=async()=>({success:true,data:{widgetStates:{webSellerList:{sellers:[]}}}});
        c.mainWindowService.getProductGroup=async sku=>({skus:[sku],variants:[{sku}]});
        c.mainWindowService.createCollectionWindow=async()=>{};
        c.mainWindowService.destroy=()=>{};
        c.excelService.saveExcel=async rows=>{exported.push(...rows.map(row=>row.sku||row.id));return true;};
        c.excelService.getFilePath=async()=>'';c.excelService.flushToDisk=async()=>true;
        return c;
      }
      ${script}
    `],{encoding:'utf8',timeout:12000,env:{...process.env,DESKTOP_TEST_USER_DATA:profile}});
    assert.equal(child.status,0,child.stderr||child.stdout);
  }finally{rmSync(profile,{recursive:true,force:true});}
}

test('later category-page details run while first media is blocked, with a durable preparing checkpoint',()=>probe(`
  const held=gate();holds.set('1001',held);const c=collection();
  const running=c.categoryMode(10);await until(()=>downloads.includes('1001'));
  try{
    for(let i=0;i<40;i++)await turn();
    assert.ok(reads.includes('2001'),'the next detail page must not wait for first-page media');
    assert.ok(saved.some(row=>row.sourceSku==='1001'&&row.rawPayload.mediaPreparation?.status==='preparing'),'metadata must be durable before the first download');
    assert.equal(c.reason,undefined,'pending media is not successful completion');
    assert.ok(saved.some(row=>row.sourceSku==='2001'&&row.status==='QUALIFIED'));
  }finally{held.resolve();await running;await c.flushRunEvents();}
  assert.equal(c.targetData,3);assert.deepEqual(exported,['2001','3001','1001']);
`));

test('bounded media backlog stops new category pages and releases a target reservation after failure',()=>probe(`
  const first=gate(),second=gate();holds.set('1001',first);holds.set('2001',second);fails.add('1001');
  const c=collection({targetCount:1});const running=c.categoryMode(1);
  await until(()=>downloads.includes('1001'));
  for(let i=0;i<20;i++)await turn();
  assert.deepEqual(downloads,['1001'],'a pending product owns its target slot');
  first.resolve();await until(()=>downloads.includes('2001'));
  assert.equal(c.targetData,0);assert.equal(c.outcomes.failed,1);
  second.resolve();await running;await c.flushRunEvents();
  assert.equal(c.targetData,1);assert.deepEqual(downloads,['1001','2001']);
  assert.equal(saved.filter(row=>row.status==='QUALIFIED').length,1);
`));

test('simultaneously finished details cannot both reserve the final product target slot',()=>probe(`
  const held=gate();holds.set('1001',held);holds.set('2001',held);const c=collection({targetCount:1});c.process=2;
  const processing=Promise.all(entries.slice(0,2).map(item=>c.taskHandle({...item,storefrontPrice:null,color_image:'https://cdn.test/'+item.id+'.png'})));
  await until(()=>downloads.length>0);for(let i=0;i<20;i++)await turn();
  try{assert.equal(downloads.length,1,'the target reservation must be atomic between simultaneous details');
    assert.equal(c.pendingProductSaves,1);
  }finally{held.resolve();await processing;await c.waitForAllTasks();await c.flushRunEvents();}
  assert.equal(c.targetData,1);assert.equal(c.process,0,'target-capped details must leave the active progress count');
  assert.deepEqual([...new Set(saved.filter(row=>row.rawPayload.mediaPreparation?.status==='preparing').map(row=>row.sourceSku))],['1001'],'only the admitted product creates checkpoints');
`));

test('category backlog remains bounded while all admitted media are blocked',()=>probe(`
  pages=entries;const held=gate();for(const item of pages)holds.set(item.id,held);
  const c=collection();const running=c.categoryMode(10);
  await until(()=>downloads.length>=1);for(let i=0;i<40;i++)await turn();
  try{assert.equal(downloads.length,2,'both pending slots should fill before applying backpressure');
    assert.ok(reads.length<=4,'prepared details cannot grow past the bounded backlog and active detail workers');
    assert.ok(pageReads<=4,'only the bounded backlog and one prefetched page may be read');
  }finally{held.resolve();await running;await c.flushRunEvents();}
  assert.equal(c.targetData,8);
`));

test('URL collection progresses to later details while a previous media save remains pending',()=>probe(`
  const held=gate();holds.set('1001',held);const c=collection({isUseCategorySelect:1,targetCount:2});let page=0;
  c.mainWindowService.getHTML=async()=>({html:'fixture-'+page,domain:'https://www.ozon.ru'});
  c.mainWindowService.scrollPage=async()=>{page++;return true;};
  c.parseService.ozonListParser=async(_html,_domain,select)=>{
    const item=entries[page];c.parseService.ozonGoodsData.add(item.id);return select([item]);
  };
  mock.timers.enable({apis:['setTimeout']});const running=c.getHtmlData(2);
  try{
    await until(()=>downloads.includes('1001'));mock.timers.tick(2000);
    for(let i=0;i<40;i++)await turn();
    assert.ok(reads.includes('2001'),'URL detail progression must overlap media');
    assert.equal(c.reason,undefined);held.resolve();await running;assert.equal(c.targetData,2);
  }finally{held.resolve();mock.timers.reset();await running;await c.flushRunEvents();}
`));

test('group ownership survives deferred save and cancellation waits for media cleanup before clearing the lease',()=>probe(`
  abortDownload=true;cleanupHold=gate();const c=collection({captureScope:'ALL'});
  const processing=c.categoryProcess([entries[0]]);await until(()=>downloads.length===1);
  assert.equal(groups.get('group-1001').owner,'1001');assert.equal(released.length,0);
  let cancelled=false;const cancelling=c.cancel().then(()=>{cancelled=true;});
  await until(()=>cleanupStarted);await turn();
  try{assert.equal(cancelled,false,'cancellation must await pending save cleanup');
    assert.equal(c.runId,'run');assert.equal(released.length,0);
  }finally{cleanupHold.resolve();await cancelling;await processing.catch(()=>{});await c.flushRunEvents();}
  assert.deepEqual(released,[{groupId:'group-1001',runId:'run',lease:'lease'}]);
  assert.equal(c.activeGroupIds.size,0);assert.equal(c.pendingProductSaves,0);
  assert.equal(saved.some(row=>row.status==='QUALIFIED'),false);assert.deepEqual(endings,['cancel']);
`));

test('a legacy group save failure releases its ownership exactly once',()=>probe(`
  const c=collection({captureScope:'ALL'});c.capabilities={};
  const server=globalThis.__DESKTOP_AXIOS_HANDLER__;
  globalThis.__DESKTOP_AXIOS_HANDLER__=async request=>{
    if(request.url.endsWith('/items')&&request.data?.items?.[0]?.status==='QUALIFIED')throw Object.assign(Error('storage unavailable'),{code:'ECONNRESET'});
    return server(request);
  };
  await assert.rejects(c.categoryProcess([entries[0]]),{code:'ECONNRESET'});
  assert.deepEqual(released,[{groupId:'group-1001',runId:'run',lease:'lease'}]);
  assert.equal(c.pendingProductSaves,0);assert.equal(c.activeGroupIds.size,0);await c.flushRunEvents();
`));

test('run completion and handoff wait until every accepted product has ready media',()=>probe(`
  pages=entries.slice(0,2);const held=gate();holds.set('1001',held);
  const c=collection({targetCount:2});c.restoreRun({id:'run',status:'QUEUED'});c.preparedClean=true;
  const running=c.run();await until(()=>downloads.includes('1001'));
  for(let i=0;i<40;i++)await turn();
  try{assert.ok(reads.includes('2001'));assert.deepEqual(endings,[]);assert.equal(c.task.taskStatus,'running');}
  finally{held.resolve();await running;await c.flushRunEvents();}
  assert.deepEqual(endings,['complete']);assert.equal(c.task.taskStatus,'completed');
  assert.equal(saved.filter(row=>row.status==='QUALIFIED'&&row.rawPayload.mediaPreparation.status==='ready').length,2);
`));

for(const errorCode of ['ACCOUNT_CHANGED','COLLECTOR_RUN_LEASE_INVALID'])test(errorCode+' stops further writes and waits for sibling media cleanup',()=>probe(`
  pages=entries.slice(0,2);const ready=gate(),cleanup=gate();let cleaning=false,writeAttempts=0;
  holds.set('1001',ready);
  const prepare=globalThis.__COLLECTOR_MEDIA_IO__.prepareFile;
  globalThis.__COLLECTOR_MEDIA_IO__.prepareFile=async(source,options)=>{
    if(source.sourceSku==='1001')return prepare(source,options);
    downloads.push(source.sourceSku);await new Promise(resolve=>options.signal.addEventListener('abort',resolve,{once:true}));
    cleaning=true;await cleanup.promise;options.signal.throwIfAborted();
  };
  const server=globalThis.__DESKTOP_AXIOS_HANDLER__;
  globalThis.__DESKTOP_AXIOS_HANDLER__=async request=>{
    if(request.url.endsWith('/items')&&request.data?.items?.[0]?.status==='QUALIFIED'){
      writeAttempts++;throw Object.assign(Error('scope unavailable'),{code:${JSON.stringify(errorCode)}});
    }
    return server(request);
  };
  const c=collection({targetCount:2});c.restoreRun({id:'run',status:'QUEUED'});c.preparedClean=true;
  let done=false;const running=c.run().then(()=>{done=true;});
  await until(()=>downloads.length===2);ready.resolve();await until(()=>writeAttempts===1);
  for(let i=0;i<20;i++)await turn();
  try{
    assert.equal(c.cancellationController.signal.aborted,true,'scope errors must stop the sibling immediately rather than retrying a write');
    assert.equal(cleaning,true);assert.equal(done,false);assert.equal(c.runId,'run');assert.equal(writeAttempts,1);
  }finally{cleanup.resolve();if(!c.cancellationController.signal.aborted)await c.cancel();await running;await c.flushRunEvents();}
  assert.equal(c.task.taskStatus,'failed');assert.deepEqual(endings,['fail']);assert.equal(c.targetData,0);assert.equal(c.pendingProductSaves,0);
`));
