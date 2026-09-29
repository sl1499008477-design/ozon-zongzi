import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('desktop sends successful collect-box identities to every AI batch without discarding partial results or publishing', () => {
    const script = `
        import assert from 'node:assert/strict';
        import { prepareCollectorAiListing } from ${JSON.stringify(new URL('../dist-electron/services/collector-backend.services.js', import.meta.url).href)};
        const calls=[];
        globalThis.__DESKTOP_AXIOS_HANDLER__ = async request => {
            calls.push(request);
            if(request.method==='get' && request.url.endsWith('/items')) return {data:{items:Array.from({length:237},(_,i)=>({id:'item-'+i}))}};
            if(request.method==='post' && request.url.endsWith('/collect-box')) {
                const ids=request.data.itemIds;
                return {data:{ok:!ids.includes('item-236'),selected:ids.length,added:ids.length-(ids.includes('item-236')?1:0),
                    results:ids.filter(id=>id!=='item-236').map(id=>({collectorItemId:id,collectItemId:id==='item-235'?'collect-0':id.replace('item-','collect-'),duplicate:id==='item-235'})),
                    errors:ids.includes('item-236')?[{collectorItemId:'item-236',message:'needs source identity'}]:[],missing:[]}};
            }
            throw Error('Unexpected request '+request.url);
        };
        const result=await prepareCollectorAiListing({runId:'run-1',allQualified:true});
        assert.equal(result.ok,false);
        assert.equal(result.errors.length,1);
        assert.deepEqual(result.aiListingBatches.map(x=>x.count),[100,100,35]);
        const ids=result.aiListingBatches.flatMap((batch,i)=>{
            assert.equal(batch.index,i+1);
            const u=new URL(batch.url);
            assert.equal(u.origin,'http://127.0.0.1:3000');
            assert.equal(u.pathname,'/ozon/tools/ai-listing');
            assert.equal(u.searchParams.get('source'),'collect');
            assert.deepEqual([...u.searchParams.keys()].sort(),['ids','source']);
            return u.searchParams.get('ids').split(',');
        });
        assert.equal(ids.length,235);
        assert.equal(new Set(ids).size,235);
        assert.equal(ids.at(-1),'collect-234');
        assert.ok(calls.every(c=>c.url.startsWith('/collector/')),'the handoff never invokes AI billing or an Ozon publishing endpoint');
        globalThis.__DESKTOP_AXIOS_HANDLER__ = async request => ({data:{ok:false,selected:1,added:0,results:[],errors:[{message:'failed'}],missing:[]}});
        const failed=await prepareCollectorAiListing({runId:'run-1',itemIds:['item-0']});
        assert.equal(failed.aiListingBatches.length,0,'failed items cannot produce an empty or guessed AI selection');
    `;
    const child=spawnSync(process.execPath,['--loader',fileURLToPath(new URL('./fixtures/desktop-module-loader.mjs',import.meta.url)),'--input-type=module','-e',script],{encoding:'utf8'});
    assert.equal(child.status,0,child.stderr||child.stdout);
});

test('a failed later import preserves confirmed AI selections and does not retry unconfirmed writes', () => {
    const script = `
        import assert from 'node:assert/strict';
        import { prepareCollectorAiListing } from ${JSON.stringify(new URL('../dist-electron/services/collector-backend.services.js', import.meta.url).href)};
        const imports=[];
        globalThis.__DESKTOP_AXIOS_HANDLER__ = async request => {
            if(request.method==='post' && request.url.endsWith('/collect-box')) {
                imports.push(request.data.itemIds);
                if(imports.length>1) throw Object.assign(Error('Service unavailable'),{status:503});
                return {data:{selected:10,added:10,results:request.data.itemIds.map(id=>({collectorItemId:id,collectItemId:'collect-'+id})),errors:[],missing:[]}};
            }
            throw Error('Unexpected request '+request.url);
        };
        const result=await prepareCollectorAiListing({runId:'run-1',itemIds:Array.from({length:21},(_,i)=>'item-'+i)});
        assert.equal(imports.length,2,'stop after an unconfirmed write; do not repeat or send later batches');
        assert.equal(result.ok,false);
        assert.equal(result.results.length,10);
        assert.equal(result.errors.length,11);
        assert.equal(result.errors[0].collectorItemId,'item-10');
        assert.equal(result.errors.at(-1).collectorItemId,'item-20');
        assert.match(result.errors[0].message,/未确认/);
        assert.match(result.errors.at(-1).message,/尚未/);
        assert.deepEqual(result.aiListingBatches.map(b=>b.count),[10]);
    `;
    const child=spawnSync(process.execPath,['--loader',fileURLToPath(new URL('./fixtures/desktop-module-loader.mjs',import.meta.url)),'--input-type=module','-e',script],{encoding:'utf8'});
    assert.equal(child.status,0,child.stderr||child.stdout);
});

test('IPC keeps a prepared URL when opening the browser fails, and reports an empty selection as 422', () => {
    const script = `
        import assert from 'node:assert/strict';
        import { ipcMain,shell } from 'electron';
        import { collectionIpc } from ${JSON.stringify(new URL('../dist-electron/ipc/collection.ipc.js',import.meta.url).href)};
        import { windowIpc } from ${JSON.stringify(new URL('../dist-electron/ipc/system.ipc.js',import.meta.url).href)};
        const handlers=new Map();
        ipcMain.handle=(name,handler)=>handlers.set(name,handler);
        collectionIpc({});
        windowIpc({webContents:{send(){}}});
        let opened=0;
        shell.openExternal=async()=>{opened++;throw Error('No browser available');};
        globalThis.__DESKTOP_AXIOS_HANDLER__=async request=>({data:{selected:1,added:1,results:[{collectItemId:'collect-1'}],errors:[],missing:[]}});
        const handler=handlers.get('collection-send-to-ai-listing');
        const prepared=await handler(null,{runId:'run-1',itemIds:['item-1']});
        assert.equal(prepared.code,207);
        assert.equal(prepared.data.browserOpenFailed,true);
        assert.equal(prepared.data.results[0].collectItemId,'collect-1');
        assert.equal(new URL(prepared.data.aiListingBatches[0].url).searchParams.get('ids'),'collect-1');
        assert.match(prepared.message,/打开/);
        globalThis.__DESKTOP_AXIOS_HANDLER__=async()=>({data:{items:[]}});
        const empty=await handler(null,{runId:'run-1',allQualified:true});
        assert.equal(empty.code,422);
        assert.equal(opened,1,'no browser is opened for empty results');
        const reopen=handlers.get('open-url');
        const failedOpen=await reopen(null,prepared.data.aiListingBatches[0].url);
        assert.equal(failedOpen.code,500,'the renderer must receive the actual open failure');
        assert.equal((await reopen(null,'file:///tmp/not-allowed')).code,403);
        assert.equal(opened,2,'untrusted URLs cannot reach the shell');
        shell.openExternal=async()=>{opened++;};
        assert.equal((await reopen(null,prepared.data.aiListingBatches[0].url)).code,200);
        assert.equal(opened,3,'reopening does not re-import or recreate selections');
    `;
    const child=spawnSync(process.execPath,['--loader',fileURLToPath(new URL('./fixtures/desktop-module-loader.mjs',import.meta.url)),'--input-type=module','-e',script],{encoding:'utf8'});
    assert.equal(child.status,0,child.stderr||child.stdout);
});
