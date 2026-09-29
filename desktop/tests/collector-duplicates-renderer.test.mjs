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
        && node.arguments[1]?.properties?.some(p => p.key.name === 'title' && p.value.value === '查看跳过商品')) expressions.modal = node;
    if (node.type === 'CallExpression' && node.callee.name === 'r' && node.arguments[0]?.name === 'ie'
        && node.arguments[1]?.properties?.some(p => p.key.name === 'class' && p.value.value === 'desktop-duplicates-action')) expressions.button = node;
});

function setup(respond = () => undefined) {
    const calls = [], errors = [], notices = [];
    const vnode = (type, props, children) => ({ type, props, children: typeof children?.default === 'function' ? children.default() : children });
    const context = vm.createContext({
        e: {}, ge: value => ({ value }), _: value => value && Object.hasOwn(value, 'value') ? value.value : value,
        Ws: () => ({ fullPath: '/collection' }), St: value => value, setTimeout: () => 1, it: async () => {},
        qe() {}, hn() {}, r: vnode, ve: vnode, Ge: vnode, Ne() {}, yt: () => null, je: 'Fragment',
        As: 'Modal', ie: 'Button', D: callback => callback, $e: String, Ye: String, Fg: {}, Lg: {}, zg: {},
        Le: { error: message => errors.push(message), success: message => notices.push(message), warning: message => notices.push(message) },
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
        ${['showDuplicates', 'closeDuplicates', 'openDuplicateCollectBox', 'openDuplicateListingHistory', 'openDuplicateTask', 'editDuplicateTask', 'sendDuplicateToAiListing', 'duplicateTask', 'duplicateOpen'].map(binding).join(',')}, dialog:R,
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

test('shipped task progress distinguishes saved products and all skip reasons; old data shows zero and never guesses a run', async () => {
    const ui = setup();
    const text = texts(ui.progress({ progress: { totalCount: 1, dedup: { collected: 4, listed: 2, collecting: 3 } } }));
    assert.match(text, /商品\s*1\s*件/u);assert.match(text, /已采集跳过\s*4/u);assert.match(text, /已上架跳过\s*2/u);assert.match(text, /正在采集跳过\s*3/u);
    assert.match(texts(ui.progress({})), /已采集跳过\s*0/u);
    assert.equal(ui.button({ _id: 'old' }).props.disabled, true);
    assert.equal(ui.button({ currentRunId: 'run' }).props.disabled, false);
    const before = ui.calls.length;
    await ui.showDuplicates({ _id: 'old' });
    assert.equal(ui.calls.length, before);assert.match(ui.errors.at(-1), /运行/u);
});

test('skip dialog pins each clicked run and discards delayed results after switching tasks or closing', async () => {
    let resolveOld, resolveClosed;
    const ui = setup((channel, payload) => {
        if (channel !== 'collection-get-duplicates') return;
        if (payload.runId === 'old-run') return new Promise(resolve => { resolveOld = resolve; });
        if (payload.runId === 'closed-run') return new Promise(resolve => { resolveClosed = resolve; });
        return { code: 200, data: { items: [{ sku: 'fresh-sku', state: 'COLLECTING', taskName: '当前来源' }], collectBoxUrl: 'http://127.0.0.1:3000/ozon/products/collect' } };
    });
    const old = ui.showDuplicates({ _id: 'old', currentRunId: 'old-run' });
    assert.match(texts(ui.modal()), /读取/u);
    await ui.showDuplicates({ _id: 'fresh', currentRunId: 'fresh-run' });
    resolveOld({ code: 200, data: { items: [{ sku: 'stale-sku', state: 'LISTED' }] } });await old;
    assert.match(texts(ui.modal()), /fresh-sku/u);assert.doesNotMatch(texts(ui.modal()), /stale-sku/u);
    assert.match(texts(ui.modal()), /暂时跳过/u);
    const pending = ui.showDuplicates({ currentRunId: 'closed-run' });ui.closeDuplicates();
    resolveClosed({ code: 200, data: { items: [{ sku: 'closed-sku', state: 'COLLECTED' }] } });await pending;
    assert.equal(ui.modal().props.open, false);assert.doesNotMatch(texts(ui.modal()), /closed-sku/u);
    assert.deepEqual(ui.calls.filter(c => c.channel === 'collection-get-duplicates').map(c => c.payload), [{ runId: 'old-run' }, { runId: 'fresh-run' }, { runId: 'closed-run' }]);
});

test('failed async reads show an actionable retry; retry keeps the exact run and recovers an empty result', async () => {
    let attempt = 0;
    const ui = setup(channel => channel === 'collection-get-duplicates' ? ++attempt === 1
        ? { code: 503, message: '读取跳过商品失败，请重试', data: null }
        : { code: 200, data: { items: [] } } : undefined);
    await ui.showDuplicates({ currentRunId: 'fixed-run' });
    assert.match(texts(ui.modal()), /读取跳过商品失败/u);
    await buttons(ui.modal()).find(button => texts(button) === '重试').props.onClick();
    assert.equal(attempt, 2);assert.match(texts(ui.modal()), /暂无跳过/u);
    assert.deepEqual(ui.calls.filter(c => c.channel === 'collection-get-duplicates').map(c => c.payload.runId), ['fixed-run', 'fixed-run']);
});

test('existing records open through the trusted Web route and source-task actions reuse the current AI flow without recapture', async () => {
    let openingFails = false, sourceStatus = 'running';
    const ui = setup((channel, payload) => {
        if (channel === 'collection-get-duplicates') return { code: 200, data: { items: [{ sku: '123', state: 'COLLECTED', collectItemId: 'collect', taskId: 'source', runId: 'source-run', taskName: '来源任务' }], collectBoxUrl: 'http://127.0.0.1:3000/ozon/products/collect' } };
        if (channel === 'collection-get-task') return { code: 200, data: { _id: payload, taskName: '来源任务', taskStatus: sourceStatus, progress: { totalCount: 2 } } };
        if (channel === 'open-url') return openingFails ? { code: 500, message: '浏览器不可用' } : { code: 200 };
        if (channel === 'collection-send-to-ai-listing') return { code: 200, data: { aiListingBatches: [] }, message: '已准备' };
    });
    await ui.showDuplicates({ currentRunId: 'run' });
    const row = { sku: '123', state: 'COLLECTED', collectItemId: 'collect', collectorItemId: 'source-item', taskId: 'source', runId: 'source-run' };
    await ui.openDuplicateCollectBox(row);
    const external = ui.calls.find(c => c.channel === 'open-url');assert.equal(external.payload, 'http://127.0.0.1:3000/ozon/products/collect');
    openingFails = true;await ui.openDuplicateCollectBox(row);assert.match(ui.errors.at(-1), /打开|浏览器/u);
    await ui.openDuplicateTask(row);
    const edit = () => buttons(ui.modal()).find(b => texts(b) === '编辑原任务');
    const send = () => buttons(ui.modal()).find(b => texts(b) === '发送至 AI 上架');
    assert.equal(edit().props.disabled, true);assert.equal(send().props.disabled, false);
    assert.equal(ui.calls.some(c => /start|collect-box|ai-listing/.test(c.channel)), false, 'reading source tasks must not initiate work');
    sourceStatus = 'completed';await ui.openDuplicateTask(row);
    assert.equal(edit().props.disabled, false);assert.equal(send().props.disabled, false);
    await send().props.onClick();
    assert.deepEqual(ui.calls.find(c => c.channel === 'collection-send-to-ai-listing').payload, { runId: 'source-run', itemIds: ['source-item'], manual: true });
    let opened = 0;ui.dialog.value = { openDialog() { opened++; } };
    await ui.editDuplicateTask();assert.equal(opened, 1);assert.equal(ui.dialog.value.formData._id, 'source');
});

test('LISTED history without a desktop run opens Web history and never treats an AI ID as a desktop task', async () => {
    const rows = [{ sku: 'ai-sku', state: 'LISTED', taskId: 'old-ai-id', listingTaskId: 'ai-id', taskName: 'AI 名称', collectItemId: 'possibly-deleted' },
        { sku: 'direct-sku', state: 'LISTED', submissionJobId: 'submission' }];
    const ui = setup(channel => channel === 'collection-get-duplicates'
        ? { code: 200, data: { items: rows, listingHistoryUrl: 'http://127.0.0.1:3000/ozon/products/import-history' } } : undefined);
    await ui.showDuplicates({ currentRunId: 'run' });
    assert.equal(buttons(ui.modal()).filter(b => texts(b) === '查看原任务').length, 0);
    assert.equal(buttons(ui.modal()).filter(b => texts(b) === '查看上架记录').length, 2);
    const before = ui.calls.length;await ui.openDuplicateTask(rows[0]);assert.equal(ui.calls.length, before);
    await buttons(ui.modal()).find(b => texts(b) === '查看上架记录').props.onClick();
    assert.equal(ui.calls.at(-1).channel, 'open-url');
    assert.equal(ui.calls.at(-1).payload, 'http://127.0.0.1:3000/ozon/products/import-history');
    assert.match(texts(ui.modal()), /已上架跳过/u);assert.match(texts(ui.modal()), /上架记录/u);
    assert.equal(ui.calls.some(c => c.channel === 'collection-get-task'), false);
});

test('sending a historical duplicate selects only its original item even when the source task latest run contains a different SKU', async () => {
    const ui = setup(channel => channel === 'collection-get-task' ? { code: 200, data: {
        _id: 'original-task', taskName: '原任务', taskStatus: 'completed', currentRunId: 'run-latest-305485466',
        progress: { totalCount: 1 }, currentRun: { id: 'run-latest-305485466' },
    } } : undefined);
    const historical = { sku: '1508194124', state: 'COLLECTED', taskId: 'original-task', runId: 'run-historical-1508194124', collectorItemId: 'historical-item' };
    await ui.openDuplicateTask(historical);
    await buttons(ui.modal()).find(button => texts(button) === '发送至 AI 上架').props.onClick();
    assert.deepEqual(ui.calls.find(call => call.channel === 'collection-send-to-ai-listing').payload,
        { runId: 'run-historical-1508194124', itemIds: ['historical-item'], manual: true });
    assert.match(texts(ui.modal()), /1508194124/u, 'show which historical SKU the action will select');
    let edited = 0;ui.dialog.value = { openDialog() { edited++; } };
    await ui.editDuplicateTask();assert.equal(edited, 1);assert.equal(ui.dialog.value.formData._id, 'original-task');
    assert.equal(ui.dialog.value.formData.currentRunId, 'run-latest-305485466', 'editing still addresses the current task');
});

test('switching between two historical items of the same task cannot let a delayed task read replace the selected source', async () => {
    let resolveFirst, requests = 0;
    const ui = setup(channel => channel === 'collection-get-task' ? ++requests === 1
        ? new Promise(resolve => { resolveFirst = resolve; })
        : { code: 200, data: { _id: 'same-task', taskName: '当前读取', taskStatus: 'completed' } } : undefined);
    const first = ui.openDuplicateTask({ taskId: 'same-task', runId: 'old-a', collectorItemId: 'item-a', sku: '111' });
    const selected = { taskId: 'same-task', runId: 'old-b', collectorItemId: 'item-b', sku: '222' };
    await ui.openDuplicateTask(selected);selected.runId = 'mutated';selected.collectorItemId = 'mutated';
    resolveFirst({ code: 200, data: { _id: 'same-task', taskName: '过期读取', taskStatus: 'completed' } });await first;
    assert.equal(ui.duplicateTask.value.taskName, '当前读取');
    await buttons(ui.modal()).find(button => texts(button) === '发送至 AI 上架').props.onClick();
    assert.deepEqual(ui.calls.find(call => call.channel === 'collection-send-to-ai-listing').payload, { runId: 'old-b', itemIds: ['item-b'], manual: true });
});

test('a historical row without a saved collector item cannot fall back to all qualified items or the latest run', async () => {
    const ui = setup(channel => channel === 'collection-get-task'
        ? { code: 200, data: { _id: 'task', taskName: '原任务', taskStatus: 'completed', currentRunId: 'latest' } } : undefined);
    await ui.openDuplicateTask({ taskId: 'task', runId: 'old-run', sku: '1508194124', collectItemId: 'history-only-reference' });
    const send = buttons(ui.modal()).find(button => texts(button) === '发送至 AI 上架');
    assert.equal(send.props.disabled, true);await send.props.onClick();
    assert.equal(ui.calls.some(call => call.channel === 'collection-send-to-ai-listing'), false);
    assert.match(ui.errors.at(-1), /原采集商品/u);
});

test('a completed historical SKU remains sendable while latest run is running; editing and duplicate in-flight sends remain blocked', async () => {
    let finishSend;
    const ui = setup(channel => {
        if (channel === 'collection-get-task') return { code: 200, data: {
            _id: 'original-task', taskName: '原任务', taskStatus: 'running', currentRunId: 'new-running-run',
        } };
        if (channel === 'collection-send-to-ai-listing') return new Promise(resolve => { finishSend = resolve; });
    });
    const historical = { sku: '1508194124', state: 'COLLECTED', taskId: 'original-task', runId: 'completed-old-run', collectorItemId: 'saved-old-item' };
    await ui.openDuplicateTask(historical);
    const send = () => buttons(ui.modal()).find(button => texts(button) === '发送至 AI 上架');
    assert.equal(send().props.disabled, false, 'the latest run is not the selected source');
    assert.equal(buttons(ui.modal()).find(button => texts(button) === '编辑原任务').props.disabled, true);
    const pending = send().props.onClick();
    assert.equal(send().props.disabled, true, 'only the in-flight handoff disables this ready source');
    await send().props.onClick();
    const writes = ui.calls.filter(call => call.channel === 'collection-send-to-ai-listing');
    assert.equal(writes.length, 1);assert.deepEqual(writes[0].payload, { runId: 'completed-old-run', itemIds: ['saved-old-item'], manual: true });
    finishSend({ code: 200, data: { aiListingBatches: [] }, message: '已准备' });await pending;
    assert.equal(send().props.disabled, false);
    await ui.openDuplicateTask({ ...historical, state: 'COLLECTING' });
    assert.equal(send().props.disabled, true, 'a source that is itself still being collected cannot be sent');
    await send().props.onClick();
    assert.equal(ui.calls.filter(call => call.channel === 'collection-send-to-ai-listing').length, 1);
});
