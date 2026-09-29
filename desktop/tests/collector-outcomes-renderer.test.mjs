import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parse } from 'acorn';

const source = readFileSync(new URL('../dist/assets/index-zr_rvO4W.js', import.meta.url), 'utf8');
const declarations = parse(source, { ecmaVersion: 'latest', sourceType: 'module' }).body.flatMap(node => node.declarations || []);
const component = declarations.find(node => node.id.name === 'Hg').init.arguments[0];
const body = component.properties.find(node => node.key.name === 'setup').value.body;
const returned = body.body.find(node => node.type === 'ReturnStatement');
const plain = value => JSON.parse(JSON.stringify(value));
function walk(node, visit) {
    if (!node || typeof node !== 'object') return;
    if (node.type) visit(node);
    for (const value of Object.values(node)) {
        if (Array.isArray(value)) value.forEach(child => walk(child, visit));
        else if (value && typeof value === 'object') walk(value, visit);
    }
}
const expressions = {};
walk(component, node => {
    if (node.type === 'ConditionalExpression' && source.slice(node.test.start, node.test.end) === 'he.key==="progress"') expressions.progress = node.consequent;
    if (node.type === 'CallExpression' && node.callee.name === 'r' && node.arguments[0]?.name === 'As'
        && node.arguments[1]?.properties?.some(p => p.key.name === 'title' && p.value.value === '查看采集结果')) expressions.modal = node;
    if (node.type === 'CallExpression' && node.callee.name === 'r' && node.arguments[0]?.name === 'ie'
        && node.arguments[1]?.properties?.some(p => p.key.name === 'class' && p.value.value === 'desktop-outcomes-action')) expressions.button = node;
});

function setup(respond = () => undefined) {
    const calls = [], errors = [], notices = [];
    const vnode = (type, props, children) => ({ type, props, children: typeof children?.default === 'function' ? children.default() : children });
    const context = vm.createContext({
        e: {}, ge: value => ({ value }), _: value => value && Object.hasOwn(value, 'value') ? value.value : value,
        Ws: () => ({ fullPath: '/collection' }), St: value => value, setTimeout: () => 1, it: async () => {},
        qe() {}, hn() {}, r: vnode, ve: vnode, Ge: vnode, Ne() {}, yt: () => null, je: 'Fragment',
        As: 'Modal', ie: 'Button', D: callback => callback, $e: String, Ye: String, Fg: {}, Lg: {}, zg: {},
        Le: { confirm: async()=>true, error: message => errors.push(message), success: message => notices.push(message), warning: message => notices.push(message) },
        window: { electronAPI: { async invoke(channel, payload) {
            assert.doesNotThrow(() => structuredClone(payload));
            calls.push({ channel, payload: plain(payload) });
            const response = await respond(channel, payload);
            if (response !== undefined) return response;
            if (channel === 'collection-get-all-tasks') return { list: [], total: 0 };
            return { code: 200, data: [], message: 'ok' };
        } } },
    });
    const helper = declarations.find(node => node.id.name === 'desktopCollectionTaskData');
    const renders = Object.entries(expressions).map(([key, node]) => `${key}:pe=>{const z=[];return (${source.slice(node.start, node.end)})}`).join(',');
    const binding = name => `${name}:typeof ${name}==='undefined'?undefined:${name}`;
    const state = vm.runInContext(`(() => {const ${source.slice(helper.start, helper.end)};${source.slice(body.start + 1, returned.start)};return {
        ${['showOutcomes', 'closeOutcomes', 'retryFailedItems', 'outcomeOpen', 'selectOutcomeRun', 'loadOutcomeResults', 'toggleOutcomeItem', 'sendOutcomeItems', 'outcomeRunId', 'outcomeResults', 'outcomeSelectedIds', 'resumeTask'].map(binding).join(',')}, dialog:R,
        taskProgress:$, tasks:i, tabs:N,
        ${renders}
    };})()`, context);
    return { ...state, calls, errors, notices };
}

function texts(node) {
    if (node == null) return '';
    if (typeof node === 'string' || typeof node === 'number') return String(node);
    if (Array.isArray(node)) return node.map(texts).join(' ');
    return texts(node.children);
}
function buttons(node, result = []) {
    if (!node || typeof node !== 'object') return result;
    if (Array.isArray(node)) node.forEach(child => buttons(child, result));
    else { if (node.type === 'Button') result.push(node); buttons(node.children, result); }
    return result;
}

test('result dialog displays counts, individual reasons and prevents retrying unavailable-only results',async()=>{
 const ui=setup(channel=>channel==='collection-get-outcomes'?{code:200,data:{status:'COMPLETED',qualifiedCount:2,failedCount:1,skippedCount:1,items:[{sku:'broken',status:'FAILED',message:'图册读取不完整'},{sku:'sold',status:'FILTERED_OUT',message:'商品已售罄'}]}}:undefined);
 await ui.showOutcomes({_id:'task',currentRunId:'run',taskName:'混合任务'});
 const text=texts(ui.modal());assert.match(text,/成功 2/);assert.match(text,/失败 1/);assert.match(text,/broken/);assert.match(text,/商品已售罄/);
 assert.equal(buttons(ui.modal()).find(b=>texts(b)==='仅重试失败商品').props.disabled,false);
 await ui.retryFailedItems();
 assert.deepEqual(ui.calls.find(c=>c.channel==='collection-retry-failed').payload,{taskId:'task',runId:'run'});
});

test('interrupted task results show saved products and separate delivery receipts without waiting for the run to complete',async()=>{
 const ui=setup((channel)=>{
  if(channel==='collection-get-runs')return {code:200,data:{runs:[{id:'interrupted',status:'FAILED'}]}};
  if(channel==='collection-get-outcomes')return {code:200,data:{status:'FAILED',qualifiedCount:2,failedCount:1,items:[]}};
  if(channel==='collection-get-results')return {code:200,data:{items:[
   {id:'item-a',sourceSku:'111',name:'已保存商品',collectBoxStatus:'NOT_SENT',aiStatus:'NOT_SENT',canSend:true},
   {id:'item-b',sourceSku:'222',name:'回执已找回',collectBoxStatus:'SENT',aiStatus:'CREATED',aiTasks:[{id:'ai-existing',status:'RUNNING'}],canSend:true}
  ],total:2,limit:50,offset:0}};
 });
 await ui.showOutcomes({_id:'task',currentRunId:'interrupted',taskStatus:'failed'});
 assert.ok(ui.calls.some(call=>call.channel==='collection-get-results'),'saved products must be read even when the run failed');
 const text=texts(ui.modal());assert.match(text,/已保存商品/);assert.match(text,/未入采集箱/);assert.match(text,/已入采集箱/);assert.match(text,/已有 AI 任务/);
 assert.equal(buttons(ui.modal()).find(button=>texts(button)==='加入采集箱').props.disabled,true,'selection is required');
 ui.toggleOutcomeItem('item-a',true);
 assert.equal(buttons(ui.modal()).find(button=>texts(button)==='加入采集箱').props.disabled,false);
});

test('historical successful products are sent by frozen run and item IDs; repeat clicks do not duplicate a pending request',async()=>{
 let releaseSend;
 const ui=setup((channel,payload)=>{
  if(channel==='collection-get-runs')return {code:200,data:{runs:[{id:'latest',status:'COMPLETED'},{id:'old',status:'CANCELLED'}]}};
  if(channel==='collection-get-results')return {code:200,data:{items:[{id:payload.runId+'-item',sourceSku:'111',collectBoxStatus:'NOT_SENT',aiStatus:'NOT_SENT',canSend:true}],total:1,limit:50,offset:0}};
  if(channel==='collection-get-outcomes')return {code:200,data:{status:'CANCELLED',qualifiedCount:1,items:[]}};
  if(channel==='collection-send-to-ai-listing')return new Promise(resolve=>releaseSend=resolve);
 });
 await ui.showOutcomes({_id:'task',currentRunId:'latest',taskStatus:'completed'});
 assert.ok(ui.calls.some(call=>call.channel==='collection-get-runs'),'history is reachable from the existing result dialog');
 await ui.selectOutcomeRun('old');ui.toggleOutcomeItem('old-item',true);
 const sending=ui.sendOutcomeItems('ai');await ui.sendOutcomeItems('ai');
 assert.deepEqual(ui.calls.filter(call=>call.channel==='collection-send-to-ai-listing').map(call=>call.payload),[{runId:'old',itemIds:['old-item'],manual:true}]);
 assert.equal(buttons(ui.modal()).find(button=>texts(button)==='发送至 AI 上架').props.disabled,true);
 releaseSend({code:200,message:'复用已有任务',data:{aiGenerationRequested:true,aiListingBatches:[],aiTaskUrl:'https://example.test/ai'}});await sending;
 assert.equal(ui.calls.filter(call=>call.channel==='collection-get-results'&&call.payload.runId==='old').length,2,'delivery refreshes from server receipts');
});

test('a late result-page read cannot replace another run or carry its selection into the new page',async()=>{
 let releaseOld;
 const ui=setup((channel,payload)=>{
  if(channel==='collection-get-outcomes')return {code:200,data:{status:'FAILED',qualifiedCount:1,items:[]}};
  if(channel==='collection-get-results')return payload.runId==='old'?new Promise(resolve=>releaseOld=resolve):{code:200,data:{items:[{id:'new-item',sourceSku:'222',canSend:true}],total:1,limit:50,offset:0}};
 });
 const old=ui.showOutcomes({_id:'old-task',currentRunId:'old'});
 await new Promise(resolve=>setImmediate(resolve));
 assert.ok(ui.calls.some(call=>call.channel==='collection-get-results'),'saved result reads are part of the dialog');
 await ui.showOutcomes({_id:'new-task',currentRunId:'new'});ui.toggleOutcomeItem('new-item',true);
 releaseOld({code:200,data:{items:[{id:'old-item',sourceSku:'111'}],total:1}});await old;
 assert.deepEqual(plain(ui.outcomeResults.value.items).map(item=>item.id),['new-item']);
 assert.deepEqual(plain(ui.outcomeSelectedIds.value),['new-item']);
 ui.closeOutcomes();assert.equal(ui.outcomeOpen.value,false);
});

test('resuming an interrupted task uses its original run instead of creating a fresh collection',async()=>{
 const ui=setup(channel=>channel==='collection-resume-task'?{code:409,message:'原运行仍由另一台助手执行，请稍后重试'}:undefined);
 assert.equal(typeof ui.resumeTask,'function','the resume action is available');
 await ui.resumeTask({_id:'task',currentRunId:'original-run',resume:{allowed:true}});
 assert.deepEqual(ui.calls.find(call=>call.channel==='collection-resume-task').payload,{taskId:'task',runId:'original-run'});
 assert.equal(ui.calls.some(call=>call.channel==='collection-create-and-start'),false);
 assert.match(ui.errors.at(-1),/另一台助手/);
});
test('running result dialog labels preparing media separately and keeps retry disabled',async()=>{
 const ui=setup(channel=>channel==='collection-get-outcomes'?{code:200,data:{status:'RUNNING',qualifiedCount:3,preparingCount:2,failedCount:1,skippedCount:1,items:[{sku:'preparing-sku',status:'PREPARING',message:'正在下载素材'},{sku:'broken-sku',status:'FAILED',message:'下载失败'},{sku:'sold-sku',status:'FILTERED_OUT',message:'商品已售罄'}]}}:undefined);
 await ui.showOutcomes({_id:'task',currentRunId:'run',taskName:'正在采集'});
 const text=texts(ui.modal());assert.match(text,/准备中 2 件/);assert.match(text,/失败 1 件/);
 assert.match(text,/preparing-sku 素材准备中/);assert.match(text,/broken-sku 失败 \/ 待重试/);assert.match(text,/sold-sku 已跳过/);
 assert.equal(buttons(ui.modal()).find(b=>texts(b)==='仅重试失败商品').props.disabled,true);
 await ui.retryFailedItems();assert.equal(ui.calls.some(c=>c.channel==='collection-retry-failed'),false);
});
test('task list shows a nonzero media preparation count only while running',()=>{
 const ui=setup();
 assert.match(texts(ui.progress({taskStatus:'running',progress:{mediaPreparingCount:2}})),/素材准备中 2 组/);
 for(const [taskStatus,mediaPreparingCount] of [['running',0],['running',undefined],['completed',2],['failed',2],['cancelled',2],['pending',2]]){
  assert.doesNotMatch(texts(ui.progress({taskStatus,progress:{mediaPreparingCount}})),/素材准备中/);
 }
});
test('startup error without a run remains visible and never creates a failed-only retry',async()=>{
 const ui=setup();await ui.showOutcomes({_id:'task',taskName:'启动失败',lastErrorMessage:'Seller 选品接口 HTTP 403'});
 assert.match(texts(ui.modal()),/HTTP 403/);assert.equal(buttons(ui.modal()).find(b=>texts(b)==='仅重试失败商品').props.disabled,true);
 await ui.retryFailedItems();assert.equal(ui.calls.some(c=>c.channel==='collection-retry-failed'),false);
});
test('switching or closing result dialogs ignores stale reads and can retry a failed read on the same run',async()=>{
 let finish,attempt=0;const ui=setup((channel,payload)=>{
  if(channel!=='collection-get-outcomes')return;
  if(payload.runId==='old')return new Promise(r=>{finish=r;});
  if(++attempt===1)return {code:503,message:'读取失败，请重试'};
  return {code:200,data:{status:'COMPLETED',qualifiedCount:1,failedCount:0,skippedCount:1,items:[{sku:'sold',status:'FILTERED_OUT',message:'已下架'}]}};
 });
 const old=ui.showOutcomes({_id:'old-task',currentRunId:'old'});await ui.showOutcomes({_id:'new-task',currentRunId:'new'});
 finish({code:200,data:{qualifiedCount:99,items:[]}});await old;assert.match(texts(ui.modal()),/读取失败/);
 await buttons(ui.modal()).find(b=>texts(b)==='重试读取').props.onClick();assert.match(texts(ui.modal()),/已下架/);
 assert.equal(buttons(ui.modal()).find(b=>texts(b)==='仅重试失败商品').props.disabled,true);
 assert.deepEqual(ui.calls.filter(c=>c.channel==='collection-get-outcomes').map(c=>c.payload.runId),['old','new','new']);
 ui.closeOutcomes();assert.equal(ui.outcomeOpen.value,false);
});

test('a new pre-run startup error takes precedence over an older successful run',async()=>{
 const ui=setup();await new Promise(resolve=>setImmediate(resolve));
 ui.tasks.value=[{_id:'task',currentRunId:'old-success',taskStatus:'completed'}];
 await ui.taskProgress({collectionTask:{_id:'task',currentRunId:'old-success',taskStatus:'failed',startError:{message:'本次 Seller 登录超时'}},log:{taskLog:'启动失败'}});
 await ui.showOutcomes(ui.tasks.value[0]);
 assert.match(texts(ui.modal()),/本次 Seller 登录超时/);assert.equal(ui.calls.some(c=>c.channel==='collection-get-outcomes'),false);
 assert.equal(buttons(ui.modal()).find(b=>texts(b)==='仅重试失败商品').props.disabled,true);
});

test('a successful retry progress snapshot clears the obsolete startup error and opens the new run',async()=>{
 const logs=[];const ui=setup((channel,payload)=>channel==='collection-get-outcomes'&&payload.runId==='new-run'
  ?{code:200,data:{status:'COMPLETED',qualifiedCount:1,failedCount:2,skippedCount:0,items:[{sku:'waiting-1',status:'FAILED',message:'等待媒体'},{sku:'waiting-2',status:'FAILED',message:'等待媒体'}]}}
  :undefined);
 await new Promise(resolve=>setImmediate(resolve));
 ui.tasks.value=[{_id:'task',currentRunId:'old-run',taskStatus:'failed',startError:{message:'旧 Seller 登录超时'},progress:{current:0,total:0,totalCount:0}}];
 ui.tabs.value={writeLog:(taskId,log)=>logs.push({taskId,log})};
 const progress={current:3,total:3,totalCount:3,outcomes:{failed:2,skipped:0}};
 const log={date:'[2026/09/18 10:00:00]',taskLog:'任务完成'};
 await ui.taskProgress({collectionTask:{_id:'task',currentRunId:'new-run',taskStatus:'completed',progress},log});
 assert.deepEqual(plain(ui.tasks.value[0].progress),progress);
 assert.deepEqual(logs,[{taskId:'task',log}]);
 await ui.showOutcomes(ui.tasks.value[0]);
 assert.deepEqual(ui.calls.filter(call=>call.channel==='collection-get-outcomes').map(call=>call.payload.runId),['new-run']);
 const text=texts(ui.modal());assert.match(text,/成功 1/);assert.match(text,/失败 2/);assert.doesNotMatch(text,/旧 Seller 登录超时/);
});


test('task progress shows product and SKU totals without presenting unknown legacy group sizes as SKU counts',()=>{
 const ui=setup();
 const shown=texts(ui.progress({taskStatus:'completed',progress:{totalCount:10,skuCount:22}}));
 assert.match(shown,/商品\s+10\s+件\s*·\s*SKU\s+22\s+个/);
 assert.doesNotMatch(shown,/新采集/);
 assert.match(texts(ui.progress({taskStatus:'noExecuted',progress:{totalCount:0,skuCount:0}})),/商品\s+0\s+件\s*·\s*SKU\s+0\s+个/);
 assert.match(texts(ui.progress({taskStatus:'completed',progress:{totalCount:2}})),/SKU\s+—\s+个/);
});
