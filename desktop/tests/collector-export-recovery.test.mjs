import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const url = path => new URL('../dist-electron/' + path, import.meta.url).href;
function probe(script) {
    const directory = mkdtempSync(join(tmpdir(), 'collector-reexport-'));
    try {
        const result = spawnSync(process.execPath, ['--loader', fileURLToPath(new URL('./fixtures/desktop-module-loader.mjs', import.meta.url)), '--input-type=module', '-e', `
            import assert from 'node:assert/strict';
            import { TaskManager } from ${JSON.stringify(url('services/collection/task-manager.services.js'))};
            import { buildTaskExcelPath } from ${JSON.stringify(url('services/collection/excel-path.core.js'))};
            import { SysTemUtils } from ${JSON.stringify(url('utils/system.js'))};
            import { operationStore } from ${JSON.stringify(url('store/index.js'))};
            import ExcelJS from 'exceljs';
            const calls=[],notices=[],manager=new TaskManager();
            manager.setMainWindow({isDestroyed:()=>false,webContents:{send:(channel,data)=>{if(channel==='task-progress')notices.push(data.log.taskLog)}}});
            const run={id:'run',taskId:'task',status:'COMPLETED',progress:{qualifiedCount:200,totalCount:1016}};
            let items=[],runOverride;
            globalThis.__DESKTOP_AXIOS_HANDLER__=async request=>{
                calls.push(request);assert.equal(request.method,'get','export recovery must remain server-read-only');
                if(request.url==='/collector/tasks')return {data:{tasks:[{id:'task',name:'照明导出',status:'COMPLETED',currentRunId:'run',currentRun:run}]}};
                if(request.url==='/collector/runs/run')return {data:{run:runOverride||run}};
                if(request.url==='/collector/runs/run/items'){
                    if(request.params.limit>20) throw Object.assign(new Error('Request failed with status code 502'),{status:502});
                    assert.equal(request.params.limit,20,'full export pages use the production-safe batch size');
                    return {data:{items:items.slice(request.params.offset,request.params.offset+request.params.limit)}};
                }
                throw Error('unexpected '+request.url);
            };
            ${script}
        `], { encoding:'utf8', timeout:30000, env:{...process.env, DESKTOP_TEST_USER_DATA:directory, DESKTOP_TEST_REAL_EXCEL:'1'} });
        assert.equal(result.status,0,result.stderr||result.stdout);
        if (result.stdout.trim()) console.log(result.stdout.trim());
    } finally { rmSync(directory,{recursive:true,force:true}); }
}

test('a completed run with no local workbook can regenerate all 200 groups and 1852 variants in source order', () => probe(`
    import sharp from 'sharp';
    const png=await sharp({create:{width:1,height:1,channels:3,background:'#fff'}}).png().toBuffer();
    let photos=0;globalThis.fetch=async()=>{photos++;return new Response(png,{headers:{'content-type':'image/png'}})};
    const expected=[];
    items=Array.from({length:200},(_,group)=>({sourceSku:String(group),rawPayload:{captureScope:'ALL',variantData:{variants:Array.from({length:group<52?10:9},(_,index)=>{
        const id='原货号-'+group+'-'+index;expected.push(id);return{id,nameLabel:'Группа '+group,cover:'https://cdn.ozon.ru/'+id+'.png'};
    })}},exportData:{}}));
    const listing=await manager.getAllTasks({});
    const path=listing.list[0].tableFilePath;
    assert.equal(path,buildTaskExcelPath(process.env.DESKTOP_TEST_USER_DATA,'task','照明导出'),'missing output still has a trusted recovery target');
    let copied;
    SysTemUtils.fileOperations.copyFile=async source=>{copied=source;return{status:'saved',filePath:source+'.copied'}};
    assert.equal((await manager.downloadExcel(path)).status,'saved');
    const workbook=new ExcelJS.Workbook();await workbook.xlsx.readFile(copied);
    const sheet=workbook.worksheets[0];
    assert.equal(sheet.rowCount,1854);assert.deepEqual(sheet.getColumn(1).values.slice(3),expected);
    assert.equal(sheet.getImages().length,1852);assert.equal(photos,1852);
    const itemCalls=calls.filter(call=>call.url==='/collector/runs/run/items');
    assert.equal(itemCalls.length,11);assert.deepEqual(itemCalls.map(call=>call.params.offset),[0,20,40,60,80,100,120,140,160,180,200]);
    assert.ok(notices.some(message=>/正在.*重新生成导出/.test(message)));
    assert.ok(notices.some(message=>/重新生成导出完成/.test(message)));
    const reads=calls.length;await manager.downloadExcel({taskId:'task'});assert.equal(calls.length,reads,'a successful recovered workbook is reusable');
    console.log(JSON.stringify({restoredGroups:200,restoredVariants:1852,embeddedPhotos:photos,serverWrites:0}));
`));

for (const invalid of ['foreign','active','account-changed']) {
    test('export regeneration rejects '+invalid+' ownership without reading or copying another run', () => probe(`
        await manager.getAllTasks({});
        let copied=false;SysTemUtils.fileOperations.copyFile=async()=>{copied=true;return{status:'saved',filePath:'bad'}};
        runOverride=${JSON.stringify(invalid)}==='foreign'?{...run,taskId:'other'}:{...run,status:'RUNNING'};
        if(${JSON.stringify(invalid)}==='account-changed') {
            runOverride={...run};
            const server=globalThis.__DESKTOP_AXIOS_HANDLER__;
            globalThis.__DESKTOP_AXIOS_HANDLER__=async request=>{const result=await server(request);if(request.url==='/collector/runs/run')operationStore.set('token','changed-account');return result;};
        }
        await assert.rejects(manager.downloadExcel({taskId:'task'}),/归属|运行|账号|任务/);
        assert.equal(copied,false);assert.equal(calls.some(call=>call.url.endsWith('/items')),false);
        assert.ok(notices.some(message=>/重新生成导出失败/.test(message)));
    `));
}

test('a task cannot start another run while its saved export is being rebuilt', () => probe(`
    items=[{rawPayload:{id:'saved-sku'}}];
    await manager.getAllTasks({});
    let entered,release;
    const waiting=new Promise(resolve=>{entered=resolve});
    const server=globalThis.__DESKTOP_AXIOS_HANDLER__;
    globalThis.__DESKTOP_AXIOS_HANDLER__=async request=>{if(request.url.endsWith('/items')){entered();await new Promise(resolve=>{release=resolve})}return server(request)};
    SysTemUtils.fileOperations.copyFile=async path=>({status:'saved',filePath:path+'.copied'});
    const exporting=manager.downloadExcel({taskId:'task'});await waiting;
    await assert.rejects(manager.startTaskById('task'),/重新生成|导出/);
    await assert.rejects(manager.reExecuteTask('task'),/重新生成|导出/);
    release();assert.equal((await exporting).status,'saved');
`));
