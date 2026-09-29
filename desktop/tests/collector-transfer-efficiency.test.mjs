import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const url = path => new URL('../dist-electron/' + path, import.meta.url).href;
function probe(script, realExcel = false) {
    const profile = mkdtempSync(join(tmpdir(), 'collector-transfer-'));
    try {
        const child = spawnSync(process.execPath, ['--loader', fileURLToPath(new URL('./fixtures/desktop-module-loader.mjs', import.meta.url)), '--input-type=module', '-e', `
            import assert from 'node:assert/strict';
            import { Collection } from ${JSON.stringify(url('services/collection/collection.services.js'))};
            const turn = () => new Promise(setImmediate);
            const calls = [];
            globalThis.__DESKTOP_AXIOS_HANDLER__ = async request => { calls.push(request); return { data: { ok: true } }; };
            const c = new Collection({ _id:'task', taskName:'效率验收', targetCount:200, aiSelectType:1 }, null);
            c.runId='run'; c.leaseToken='lease'; c.uuid='instance';
            ${script}
        `], { encoding: 'utf8', timeout: 20000, env: { ...process.env, DESKTOP_TEST_USER_DATA: profile, DESKTOP_TEST_REAL_EXCEL: realExcel ? '1' : '0' } });
        assert.equal(child.status, 0, child.stderr || child.stdout);
    } finally { rmSync(profile, { recursive: true, force: true }); }
}

test('advertised raw export sharing removes the repeated body while legacy servers retain full export data', () => probe(`
    const item={id:'123',sku:'123',nameLabel:'中文货号',images:['https://cdn.ozon.ru/1.jpg'],description:'x'.repeat(4096)};
    c.capabilities={exportDataFromRaw:true}; assert.equal(await c.persistRunItem(item),true);
    const compact=calls.at(-1).data.items[0];
    assert.equal(compact.exportDataFromRaw,true); assert.equal(Object.hasOwn(compact,'exportData'),false);
    assert.deepEqual(compact.rawPayload,item);
    c.capabilities={}; assert.equal(await c.persistRunItem(item),true);
    const legacy=calls.at(-1).data.items[0]; assert.deepEqual(legacy.exportData,item);
    assert.ok(JSON.stringify(compact).length < JSON.stringify(legacy).length * .6);
`));

test('ordinary events are batched in source order, status changes flush earlier logs, and final progress drains all', () => probe(`
    c.capabilities={eventBatch:true};
    for(let i=0;i<123;i++) c.outputLog('progress-'+i);
    await c.syncStatusToServer('completed');
    c.outputLog('final receipt');
    await c.flushRunProgress();
    const requests=calls.filter(call=>call.url.endsWith('/events'));
    assert.ok(requests.length <= 5, 'ordinary logs must not become one HTTP request each');
    assert.ok(requests.every(call=>Array.isArray(call.data.events)&&call.data.events.length<=50));
    const events=requests.flatMap(call=>call.data.events);
    assert.deepEqual(events.map(event=>event.message),[...Array.from({length:123},(_,i)=>'progress-'+i),'任务状态：completed','final receipt']);
    assert.equal(calls.at(-1).url,'/collector/runs/run/heartbeat');
`));

test('legacy event upload is serialized and a transient failed batch stays available for final flush', () => probe(`
    let fail=true;
    globalThis.__DESKTOP_AXIOS_HANDLER__=async request=>{
        if(request.url.endsWith('/events')&&fail){fail=false;throw Error('temporary network failure');}
        calls.push(request); return {data:{ok:true}};
    };
    c.outputLog('before'); await c.syncStatusToServer('running');
    c.outputLog('after'); await c.flushRunProgress();
    const events=calls.filter(call=>call.url.endsWith('/events')).map(call=>call.data);
    assert.deepEqual(events.map(event=>event.message),['before','任务状态：running','after']);
    assert.ok(events.every(event=>!event.events));
`));

test('cancellation waits for a persistence already accepted by the server and saves its queued Excel rows', () => probe(`
    import ExcelJS from 'exceljs';
    let release, received;
    const accepted=new Promise(resolve=>{received=resolve});
    globalThis.__DESKTOP_AXIOS_HANDLER__=async request=>{
        calls.push(request);
        if(request.url.endsWith('/items')) {received();await new Promise(resolve=>{release=resolve});}
        return {data:{ok:true}};
    };
    c.writeQueue.push([{id:'中文货号',nameLabel:'Product'}]);
    const writing=c.writeTable(); await accepted;
    let cancelled=false;
    const stopping=c.cancel().then(()=>{cancelled=true});
    await turn(); assert.equal(cancelled,false,'cancel must not clear a live persistence writer');
    release(); await writing; await stopping;
    const workbook=new ExcelJS.Workbook(); await workbook.xlsx.readFile(await c.excelService.getFilePath());
    assert.equal(workbook.worksheets[0].getCell('A3').value,'中文货号');
    assert.equal(c.targetData,1); assert.equal(c.task.taskStatus,'cancelled');
    assert.equal(calls.filter(call=>call.url.endsWith('/items')).length,1);
`, true));

test('disk failure is a visible export warning and does not invalidate already persisted collection results', () => probe(`
    c.excelService.saveExcel=async()=>true;
    c.excelService.flushToDisk=async()=>false;
    c.writeQueue.push([{id:'123',nameLabel:'Product'}]); await c.writeTable();
    await c.reWriteTable();
    assert.equal(c.goodsData.size,1); assert.equal(c.targetData,1);
    assert.equal(c.reason,undefined); assert.equal(c.writeError,true);
    assert.match(c.task.exportError,/Excel/);
`));

test('category reading prefetches exactly one next page while the current product waits and preserves final-page items', () => probe(`
    const pages=[]; let release, detailStarted;
    const started=new Promise(resolve=>{detailStarted=resolve});
    c.query.pageSize=1; c.task.targetCount=3;
    globalThis.__SELLER_LEADERBOARD_HANDLER__=async options=>{
        pages.push(options.offset);
        return {items:[{id:String(options.offset+1),sku:String(options.offset+1),price:100,nameLabel:'Product'}],total:3};
    };
    globalThis.__DESKTOP_AXIOS_HANDLER__=async request=>{
        calls.push(request);
        if(request.url.endsWith('/skus/claim')) return {data:{items:request.data.skus.map(sku=>({sku,state:'CLAIMED'}))}};
        return {data:{ok:true}};
    };
    c.getHtmlDetailData=async item=>{
        if(item.id==='1'){detailStarted();await new Promise(resolve=>{release=resolve});}
        return {...item,storefrontPrice:{amount:'10',currencyCode:'CNY'}};
    };
    c.excelService.saveExcel=async()=>true; c.excelService.getFilePath=async()=>'';
    const collecting=c.categoryMode(3); await started; await turn();
    assert.deepEqual(pages,[0,1],'next read overlaps the current product without fetching a third page');
    release(); await collecting;
    assert.equal(c.targetData,3); assert.deepEqual(pages,[0,1,2]);
    assert.deepEqual(calls.filter(call=>call.url.endsWith('/items')).map(call=>call.data.items[0].sourceSku),['1','2','3']);
    await c.flushRunEvents();
`));

test('actual storefront and backend requests across many tasks share one global network budget', () => probe(`
    import { sonliRequest } from ${JSON.stringify(url('services/sonli-api.services.js'))};
    import { MainWindowService } from ${JSON.stringify(url('services/collection/main-window.services.js'))};
    let active=0,maxActive=0,release;
    const blocked=new Promise(resolve=>{release=resolve});
    const call=async()=>{active++;maxActive=Math.max(active,maxActive);await blocked;active--;};
    globalThis.__DESKTOP_AXIOS_HANDLER__=async()=>{await call();return {data:{ok:true}};};
    const requests=Array.from({length:12},(_,index)=>sonliRequest({method:'get',url:'/collector/tasks/'+index}));
    for(let index=0;index<12;index++){
        const window=new MainWindowService();
        window.browserWindow={isDestroyed:()=>false,webContents:{executeJavaScript:async()=>{await call();return {success:true,data:{widgetStates:{}}};}}};
        requests.push(window.getOzonPageJson('https://www.ozon.ru/product/'+index+'/'));
    }
    await turn(); const observed=maxActive; release(); await Promise.all(requests);
    assert.ok(observed>1&&maxActive<=4,'task multiplication exceeded global network budget: '+maxActive);
`));

test('lease heartbeats get the next available request slot before a backlog of ordinary reads', () => probe(`
    import { sonliRequest } from ${JSON.stringify(url('services/sonli-api.services.js'))};
    const waiting=[];let blocked=true;
    globalThis.__DESKTOP_AXIOS_HANDLER__=async request=>{calls.push(request);if(blocked)await new Promise(resolve=>waiting.push(resolve));return{data:{ok:true}}};
    const reads=Array.from({length:20},(_,index)=>sonliRequest({method:'get',url:'/collector/tasks/'+index}));
    await turn();assert.equal(calls.length,4);
    const heartbeat=sonliRequest({method:'post',url:'/collector/runs/run/heartbeat'});
    waiting.shift()();await turn();const next=calls[4]?.url;
    blocked=false;waiting.splice(0).forEach(resolve=>resolve());await Promise.all([...reads,heartbeat]);
    assert.equal(next,'/collector/runs/run/heartbeat','bulk reads must not expire a live lease');
`));
