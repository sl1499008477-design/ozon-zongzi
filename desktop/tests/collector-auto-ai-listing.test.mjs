import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const moduleUrl = name => new URL(`../dist-electron/${name}`, import.meta.url).href;
const run = script => {
    const child = spawnSync(process.execPath, ['--loader', fileURLToPath(new URL('./fixtures/desktop-module-loader.mjs', import.meta.url)), '--input-type=module', '-e', script], { encoding: 'utf8', timeout: 15000 });
    assert.equal(child.status, 0, child.stderr || child.stdout);
};

test('task completion sends only opted-in successful runs, pins the exact run and preserves collection on handoff failure', () => run(`
    import assert from 'node:assert/strict';
    import { shell } from 'electron';
    import { TaskManager } from ${JSON.stringify(moduleUrl('services/collection/task-manager.services.js'))};
    const requests=[], opened=[], events=[];
    shell.openExternal=async url=>opened.push(url);
    globalThis.__DESKTOP_AXIOS_HANDLER__=async request=>{
        requests.push(request);
        if(request.method==='get' && request.url.endsWith('/items')) return {data:{items:[{id:'qualified-1'}]}};
        if(request.method==='get' && request.url==='/collector/runs/exact-enabled') return {data:{run:{id:'exact-enabled',status:'COMPLETED',configurationSnapshot:{configuration:{autoSendToAiListing:true}}}}};
        if(request.method==='post' && request.url.endsWith('/collect-box')) return {data:{ok:true,selected:1,added:1,results:[{collectItemId:'collect-1'}],errors:[],missing:[]}};
        throw Error('Unexpected request '+request.url);
    };
    const manager=new TaskManager();
    manager.setMainWindow({isDestroyed:()=>false,webContents:{send:(channel,payload)=>events.push({channel,payload})}});
    let clears=0;
    function add(id,{status='completed',enabled=false,count=1}={}) {
        const info={_id:id,taskName:id,taskStatus:status,currentRunId:'WRONG-newer-run',autoSendToAiListing:!enabled};
        manager.tasks.set(id,{getTaskInfo:()=>info,run:async()=>({runId:'exact-'+id,autoSendToAiListing:enabled,filePath:'',progress:{current:0,total:30,totalCount:count}}),clearStatus:()=>clears++,outputLog(){}});
        return info;
    }
    for(const [id,options] of [['old',{}],['off',{enabled:false}],['failed',{enabled:true,status:'failed'}],['cancelled',{enabled:true,status:'cancelled'}],['empty',{enabled:true,count:0}]]) {
        add(id,options);await manager.executeTask(id);
    }
    assert.equal(requests.length,0);
    const enabled=add('enabled',{enabled:true});
    await manager.executeTask('enabled');
    await manager.executeTask('enabled');
    assert.equal(opened.length,1,'one automatic handoff per completed run');
    assert.ok(requests.every(r=>r.url==='/collector/capabilities'||r.url.includes('/runs/exact-enabled')),'do not resolve the latest run after completion');
    assert.equal(new URL(opened[0]).searchParams.get('ids'),'collect-1');
    const completed=events.find(e=>e.channel==='task-completed'&&e.payload.taskId==='enabled');
    assert.equal(completed.payload.aiListingResult.code,200);
    assert.equal(enabled.taskStatus,'completed');
    assert.equal(manager.activeTasks.size,0);
    globalThis.__DESKTOP_AXIOS_HANDLER__=async()=>{throw Object.assign(Error('网络暂时不可用'),{status:503})};
    const failed=add('send-fails',{enabled:true});await manager.executeTask('send-fails');
    assert.equal(failed.taskStatus,'completed','sending failure is not collection failure');
    assert.equal(manager.filePathList.get('send-fails').progress.totalCount,1,'collected result remains available');
    const notice=events.find(e=>e.channel==='task-completed'&&e.payload.taskId==='send-fails').payload;
    assert.equal(notice.level,'warning');assert.match(notice.message,/手动|补发/u);
    assert.equal(clears,7);
`));

test('Collection returns the completed run and frozen automatic-send flag after its lease is cleared', () => run(`
    import assert from 'node:assert/strict';
    import { Collection } from ${JSON.stringify(moduleUrl('services/collection/collection.services.js'))};
    globalThis.__SELLER_CONTEXT__={accountId:'account-1',sourceIdentity:'seller-1'};
    globalThis.__DESKTOP_AXIOS_HANDLER__=async request=>({data:request.url.endsWith('/claim')?{run:{startedAt:'2026-09-10T00:00:00Z'},leaseToken:'lease-test'}:{}});
    for(const enabled of [true,false,undefined]) {
        const task={_id:'task-1',taskName:'snapshot',categoryIds:[],autoSendToAiListing:!enabled,progress:{current:0,total:1,totalCount:1},isUseCategorySelect:0};
        const collection=new Collection(task,null);
        collection.restoreRun({id:'frozen-run',configurationSnapshot:{configuration:{isUseCategorySelect:0,categoryIds:[],autoSendToAiListing:enabled}}});
        collection.preparedClean=true;
        collection.startHeartbeat=()=>{};collection.stopHeartbeat=()=>{};
        collection.mainWindowService.createCollectionWindow=async()=>{};
        collection.mainWindowService.destroy=()=>{};
        collection.categoryMode=async()=>{collection.reason='success';};
        collection.waitForAllTasks=async()=>{};collection.expendShop=async()=>{};
        collection.reWriteTable=async()=>{};collection.flushRunProgress=async()=>{};
        const result=await collection.run();
        assert.equal(collection.getTaskInfo().taskStatus,'completed');assert.equal(collection.getRunId(),'');
        assert.equal(result.runId,'frozen-run');assert.equal(result.autoSendToAiListing,enabled===true);
    }
`));

test('server-managed completed runs report durable pending or partial status without a second desktop handoff', () => run(`
    import assert from 'node:assert/strict';
    import { TaskManager } from ${JSON.stringify(moduleUrl('services/collection/task-manager.services.js'))};
    const requests=[],events=[];
    globalThis.__DESKTOP_AXIOS_HANDLER__=async request=>{requests.push(request);throw Error('desktop must not send a managed run again');};
    for(const [status,level] of [['PENDING','success'],['PARTIAL','warning']]) {
        const manager=new TaskManager();
        manager.setMainWindow({isDestroyed:()=>false,webContents:{send:(channel,payload)=>events.push({channel,payload})}});
        const info={_id:'managed-'+status,taskName:'Managed',taskStatus:'completed'};
        manager.tasks.set(info._id,{getTaskInfo:()=>info,run:async()=>({runId:'exact-run',autoSendToAiListing:true,serverManagedHandoff:true,
            handoff:{status,processed:1,created:1,reused:0,blocked:status==='PARTIAL'?1:0,errors:[]},progress:{totalCount:2}}),clearStatus(){},outputLog(){}});
        await manager.executeTask(info._id);
        const notice=events.find(event=>event.channel==='task-completed'&&event.payload.taskId===info._id).payload;
        assert.equal(notice.level,level);
        assert.match(notice.message,/后台|服务器|补发/);
        assert.equal(info.taskStatus,'completed');
    }
    assert.deepEqual(requests,[]);
`));

test('Collection returns the server completion receipt only for the frozen automatic-generation path', () => run(`
    import assert from 'node:assert/strict';
    import { Collection } from ${JSON.stringify(moduleUrl('services/collection/collection.services.js'))};
    globalThis.__SELLER_CONTEXT__={accountId:'account',sourceIdentity:'seller'};
    globalThis.__DESKTOP_AXIOS_HANDLER__=async request=>({data:request.url.endsWith('/claim')?{run:{},leaseToken:'lease'}:
        request.url.endsWith('/capabilities')?{capabilities:{durableHandoff:true,eventBatch:true}}:
        request.url.endsWith('/complete')?{run:{id:'run',handoff:{status:'PENDING',processed:0}}}: {}});
    for(const autoStart of [true,false]) {
        const c=new Collection({_id:'task',taskName:'Frozen',isUseCategorySelect:1,targetCount:1,autoStartAiGeneration:!autoStart},null);
        c.restoreRun({id:'run',configurationSnapshot:{configuration:{isUseCategorySelect:1,targetCount:1,autoSendToAiListing:true,autoStartAiGeneration:autoStart}}});
        c.preparedClean=true;c.targetData=1;c.startHeartbeat=()=>{};c.mainWindowService.destroy=()=>{};
        c.reWriteTable=async()=>{};c.waitForAllTasks=async()=>{};
        const result=await c.run();
        assert.equal(result.serverManagedHandoff,autoStart);
        assert.equal(result.handoff.status,'PENDING');
        assert.equal(result.runId,'run');
    }
`));

test('explicit all-qualified resend schedules the durable remainder without replaying old desktop batches', () => run(`
    import assert from 'node:assert/strict';
    import { shell } from 'electron';
    import { sendCollectorResultsToAiListing } from ${JSON.stringify(moduleUrl('services/collector-ai-listing.services.js'))};
    const requests=[],opened=[];shell.openExternal=async value=>opened.push(value);
    globalThis.__DESKTOP_AXIOS_HANDLER__=async request=>{
        requests.push(request);
        if(request.url==='/collector/capabilities')return {data:{capabilities:{durableHandoff:true}}};
        if(request.url==='/collector/tasks/task/runs')return {data:{runs:[{id:'run'}]}};
        if(request.url==='/collector/runs/run')return {data:{run:{id:'run',status:'COMPLETED',handoff:{status:'PARTIAL'},configurationSnapshot:{configuration:{autoSendToAiListing:true,autoStartAiGeneration:true}}}}};
        if(request.url==='/collector/runs/run/handoff/retry')return {data:{handoff:{status:'PENDING',processed:1,created:1,reused:0}}};
        throw Error('old desktop batch must not run: '+request.url);
    };
    const result=await sendCollectorResultsToAiListing({taskId:'task',allQualified:true});
    assert.equal(result.code,200);assert.equal(result.data.handoff.status,'PENDING');
    assert.deepEqual(requests.filter(request=>request.method==='post').map(request=>request.url),['/collector/runs/run/handoff/retry']);
    assert.equal(opened.length,1);assert.match(opened[0],/tab=tasks/);
`));
