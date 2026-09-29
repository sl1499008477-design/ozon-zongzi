import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { normalizeCollectorTask, toCollectorTaskPayload } from '../dist-electron/services/collector-contract.core.js';

const moduleUrl = name => new URL(`../dist-electron/${name}`, import.meta.url).href;
const run = script => {
    const child = spawnSync(process.execPath, ['--loader', fileURLToPath(new URL('./fixtures/desktop-module-loader.mjs', import.meta.url)), '--input-type=module', '-e', script], { encoding: 'utf8', timeout: 15000 });
    assert.equal(child.status, 0, child.stderr || child.stdout);
};

test('persisted current-run duplicate counts survive normalization; old and local tasks retain their own counts', () => {
    const input = { id: 'task', progress: { totalCount: 99, dedup: { collected: 99 } }, currentRunId: 'run', currentRun: {
        id: 'run', progress: { totalCount: 30, qualifiedCount: 1 }, resultSummary: { dedup: { collected: 4, listed: 2, collecting: 3 } },
    } };
    const task = normalizeCollectorTask(input);
    assert.deepEqual(task.progress, { current: 0, total: 30, totalCount: 1, dedup: { collected: 4, listed: 2, collecting: 3 } });
    assert.equal(task.currentRunId, 'run');
    assert.deepEqual(normalizeCollectorTask({ id: 'old', currentRun: { id: 'old-run' }, progress: input.progress }).progress.dedup, { collected: 0, listed: 0, collecting: 0 });
    assert.deepEqual(normalizeCollectorTask({ id: 'new' }).progress.dedup, { collected: 0, listed: 0, collecting: 0 });
    const local = { id: 'local', progress: { current: 1, totalCount: 2, dedup: { listed: 7 } } };
    assert.deepEqual(normalizeCollectorTask(local).progress.dedup, { collected: 0, listed: 7, collecting: 0 });
    assert.deepEqual(local.progress.dedup, { listed: 7 }, 'read conversion must not modify source progress');
    assert.equal(Object.hasOwn(toCollectorTaskPayload(task).configuration, 'progress'), false);
});

test('duplicate reads pin the supplied run, exhaust event cursors and return only public item fields', () => run(`
    import assert from 'node:assert/strict';
    import { readCollectorDuplicates } from ${JSON.stringify(moduleUrl('services/collector-duplicates.services.js'))};
    const calls=[];
    globalThis.__DESKTOP_AXIOS_HANDLER__=async request=>{
        calls.push(request);
        assert.equal(request.method,'get');
        assert.equal(request.url,'/collector/runs/exact%2Frun/events');
        assert.equal(request.params.eventType,'SKU_DUPLICATES');assert.equal(request.params.limit,500);
        const start=request.params.afterId;
        return {data:{events:Array.from({length:start===0?500:1},(_,i)=>({id:start+i+1,payload:{items:[{
            sku:String(start+i+1),state:['COLLECTED','LISTED','COLLECTING'][i%3],collectItemId:'collect-'+i,
            collectorItemId:'item-'+i,taskId:'origin',runId:'origin-run',taskName:'原任务',token:'must-not-leave-service',
        }]}}))}};
    };
    const result=await readCollectorDuplicates({runId:'exact/run',taskId:'do-not-resolve-latest'});
    assert.deepEqual(calls.map(c=>c.params.afterId),[0,500]);assert.equal(result.items.length,501);
    assert.equal(result.items.at(-1).sku,'501');assert.equal(result.runId,'exact/run');
    assert.deepEqual(Object.keys(result.items[0]).sort(),['sku','state','collectItemId','collectorItemId','taskId','runId','taskName'].sort());
    const url=new URL(result.collectBoxUrl);assert.equal(url.origin,'http://127.0.0.1:3000');
    assert.equal(url.pathname,'/ozon/products/collect');assert.equal(url.search,'','collection page has no identity filter contract');
    await assert.rejects(readCollectorDuplicates({taskId:'no-run'}));assert.equal(calls.length,2,'never guess a latest run');
`));

test('a full page followed by empty results completes; a repeated cursor fails instead of looping or showing a partial list', () => run(`
    import assert from 'node:assert/strict';
    import { readCollectorDuplicates } from ${JSON.stringify(moduleUrl('services/collector-duplicates.services.js'))};
    const page=Array.from({length:500},(_,i)=>({id:i+1,payload:{items:[]}}));let calls=0;
    globalThis.__DESKTOP_AXIOS_HANDLER__=async()=>({data:{events:++calls===1?page:[]}});
    assert.deepEqual((await readCollectorDuplicates({runId:'run'})).items,[]);assert.equal(calls,2);
    calls=0;globalThis.__DESKTOP_AXIOS_HANDLER__=async()=>{calls++;return {data:{events:page}};};
    await assert.rejects(readCollectorDuplicates({runId:'run'}));assert.equal(calls,2);
`));

test('later evidence for the same SKU replaces the temporary skip and retains the reusable identity', () => run(`
    import assert from 'node:assert/strict';
    import { readCollectorDuplicates } from ${JSON.stringify(moduleUrl('services/collector-duplicates.services.js'))};
    globalThis.__DESKTOP_AXIOS_HANDLER__=async()=>({data:{events:[
        {id:1,payload:{items:[{sku:'sku',state:'COLLECTING',taskId:'source',runId:'source-run'}]}},
        {id:2,payload:{items:[{sku:'sku',state:'COLLECTED',collectItemId:'collect',taskId:'source',runId:'source-run',taskName:'来源'}]}},
    ]}});
    assert.deepEqual((await readCollectorDuplicates({runId:'run'})).items,[{sku:'sku',state:'COLLECTED',collectItemId:'collect',taskId:'source',runId:'source-run',taskName:'来源'}]);
`));

test('AI/direct listing identifiers remain separate from desktop task identities, including older mixed taskId evidence', () => run(`
    import assert from 'node:assert/strict';
    import { readCollectorDuplicates } from ${JSON.stringify(moduleUrl('services/collector-duplicates.services.js'))};
    globalThis.__DESKTOP_AXIOS_HANDLER__=async()=>({data:{events:[{id:1,payload:{items:[
        {sku:'a',state:'LISTED',taskId:'old-ai-id',taskName:'AI task',listingTaskId:'ai-id',collectItemId:'possibly-deleted'},
        {sku:'b',state:'LISTED',submissionJobId:'submission-id'},
        {sku:'c',state:'COLLECTING',taskId:'desktop-id',runId:'desktop-run',taskName:'桌面任务'},
    ]}}]}});
    const result=await readCollectorDuplicates({runId:'selected-run'});
    assert.deepEqual(result.items,[
        {sku:'a',state:'LISTED',listingTaskId:'ai-id',collectItemId:'possibly-deleted'},
        {sku:'b',state:'LISTED',submissionJobId:'submission-id'},
        {sku:'c',state:'COLLECTING',taskId:'desktop-id',runId:'desktop-run',taskName:'桌面任务'},
    ]);
    const url=new URL(result.listingHistoryUrl);assert.equal(url.pathname,'/ozon/products/import-history');assert.equal(url.search,'');
`));

test('IPC reads off-page source tasks through the account-authorized API and returns safe load errors without writes', () => run(`
    import assert from 'node:assert/strict';
    import { ipcMain } from 'electron';
    import { collectionIpc } from ${JSON.stringify(moduleUrl('ipc/collection.ipc.js'))};
    const handlers=new Map(),calls=[];ipcMain.handle=(name,handler)=>handlers.set(name,handler);collectionIpc({});
    globalThis.__DESKTOP_AXIOS_HANDLER__=async request=>{
        calls.push(request);assert.equal(request.method,'get');
        if(request.url==='/collector/tasks/source-task')return {data:{task:{id:'source-task',name:'另一页原任务',status:'COMPLETED',currentRunId:'source-run'}}};
        throw Object.assign(Error('internal token=do-not-show'),{status:403});
    };
    const task=await handlers.get('collection-get-task')(null,'source-task');
    assert.equal(task.code,200);assert.equal(task.data._id,'source-task');assert.equal(task.data.taskName,'另一页原任务');
    const failed=await handlers.get('collection-get-duplicates')(null,{runId:'foreign-run'});
    assert.equal(failed.code,403);assert.equal(failed.data,null);assert.doesNotMatch(failed.message,/internal|token/);
    const absent=await handlers.get('collection-get-task')(null,'foreign-task');assert.equal(absent.code,403);assert.doesNotMatch(absent.message,/internal|token/);
    assert.equal(calls.length,3);
`));

test('historical item handoff crosses the real IPC/service chain without resolving latest or importing sibling items', () => run(`
    import assert from 'node:assert/strict';
    import { ipcMain, shell } from 'electron';
    import { collectionIpc } from ${JSON.stringify(moduleUrl('ipc/collection.ipc.js'))};
    const handlers=new Map(),calls=[],opened=[];ipcMain.handle=(name,handler)=>handlers.set(name,handler);collectionIpc({});
    shell.openExternal=async url=>opened.push(url);
    globalThis.__DESKTOP_AXIOS_HANDLER__=async request=>{
        calls.push(request);
        if(request.method==='get'){
            assert.equal(request.url,'/collector/runs/old-run-1508194124','only the exact historical run is read for its frozen configuration');
            return {data:{run:{id:'old-run-1508194124',status:'COMPLETED',configuration:{autoSendToAiListing:true,autoStartAiGeneration:false}}}};
        }
        assert.equal(request.method,'post','explicit historical identity requires no latest-run lookup');
        assert.equal(request.url,'/collector/runs/old-run-1508194124/collect-box');
        assert.deepEqual(request.data,{itemIds:['old-item-1508194124'],sourceKeys:[]});
        return {data:{ok:true,selected:1,added:1,results:[{collectorItemId:'old-item-1508194124',collectItemId:'old-collect-1508194124'}],errors:[],missing:[]}};
    };
    const result=await handlers.get('collection-send-to-ai-listing')(null,{runId:'old-run-1508194124',itemIds:['old-item-1508194124']});
    assert.equal(result.code,200);assert.equal(calls.length,2);assert.equal(opened.length,1);
    assert.equal(new URL(opened[0]).searchParams.get('ids'),'old-collect-1508194124');
    assert.equal(result.data.aiListingBatches[0].count,1);
    assert.ok(!JSON.stringify(calls).includes('305485466'),'the newer run/SKU cannot enter the historical selection');
`));
