import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { types } from 'node:util';
import vm from 'node:vm';
import { parse } from 'acorn';

const source = readFileSync(new URL('../dist/assets/index-zr_rvO4W.js', import.meta.url), 'utf8');
const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
const declarations = ast.body.flatMap(node => node.declarations || []);
// Use the shipped Vue reactivity code, excluding browser startup and mounting.
const vueSource = readFileSync(new URL('../dist/assets/index-A-3CMN9t.js', import.meta.url), 'utf8');
const vuePrelude = vueSource.slice(vueSource.indexOf('function J8('), vueSource.indexOf('function aK('));
const { reactive, toRaw } = vm.runInNewContext(`(() => {${vuePrelude};return { reactive:zn, toRaw:Ze };})()`);
const retired = [
    'myProfitPercent', 'internalExpress', 'rubExpressPrice', 'elsePercent',
    'sourceType', 'targetProfitPercent', 'basePriceType', 'rejustType',
    'rejustValue', 'upMode',
];
const legacyTask = {
    _id: 'old-task', taskName: '旧任务', isUseCategorySelect: 1,
    targetUrl: 'https://www.ozon.ru/category/dom-14500/', targetCount: 10,
    soldCountMin: 50, followMax: 30, ratingMin: 4, salePriceMin: 0,
    upMode: 2, basePriceType: '', rejustType: '', rejustValue: undefined,
    myProfitPercent: 90, elsePercent: 90, rubExpressPrice: 15,
    sourceType: '1', internalExpress: 'removed-logistics', targetProfitPercent: 30,
    configuration: { myProfitPercent: 90, sourceType: '1', upMode: 2 },
};
const plain = value => JSON.parse(JSON.stringify(value));

function component(name) {
    return declarations.find(node => node.id.name === name).init.arguments[0];
}

function walk(node, visit) {
    if (!node || typeof node !== 'object') return;
    if (node.type) visit(node);
    for (const value of Object.values(node)) {
        if (Array.isArray(value)) value.forEach(child => walk(child, visit));
        else if (value && typeof value === 'object') walk(value, visit);
    }
}

// Exercise the shipped component setup/handlers without Electron, a browser,
// or mounting Ant Design. Only framework refs/lifecycle and IPC are substituted.
function setup(name, { filterPresetResponse, aiResponse, aiConfigsResponse, openUrlResponse, categoryResponse, shopResponse, props = {}, emit = () => {} } = {}) {
    const calls = [], errors = [], notices = [], externalCalls = [], watches = [], mounts = [];
    const listeners = new Map();
    const definition = component(name);
    const body = definition.properties.find(node => node.key.name === 'setup').value.body;
    const returned = body.body.find(node => node.type === 'ReturnStatement');
    const beforeRender = returned.argument.type === 'SequenceExpression'
        ? returned.argument.expressions.slice(0, -1).map(node => source.slice(node.start, node.end)).join(';')
        : '';
    const helper = declarations.find(node => node.id.name === 'desktopCollectionTaskData');
    let aiButton, aiBatchModal, categoryForm, dialogProps;
    walk(definition, node => {
        if (node.type === 'CallExpression' && node.callee.name === 'r' && node.arguments[0]?.name === 'ie'
            && node.arguments[1]?.properties?.some(prop => prop.key.name === 'class' && prop.value.value === 'desktop-ai-action')) aiButton = node.arguments[1];
        if (node.type === 'CallExpression' && node.callee.name === 'r' && node.arguments[0]?.name === 'As'
            && node.arguments[1]?.properties?.some(prop => (prop.key.name === 'title' && prop.value.value === '分批发送至 AI 上架') || (prop.key.name === 'class' && prop.value.value === 'desktop-ai-result-dialog'))) aiBatchModal = node;
        if (node.type === 'CallExpression' && node.callee.name === 'r' && node.arguments[0]?.name === 'Og') dialogProps = node.arguments[1];
        if (node.type === 'CallExpression' && node.callee.name === 'r' && node.arguments[0]?.name === 'B') {
            walk(node, child => {
                if (child.type === 'CallExpression' && child.callee.name === 'r' && child.arguments[0]?.name === 'Y'
                    && child.arguments[1]?.properties?.some(prop => prop.key.name === 'value' && prop.value.property?.name === 'categoryIds')) categoryForm = node;
            });
        }
    });
    const aiProps = aiButton ? source.slice(aiButton.start, aiButton.end) : 'null';
    const modalRender = aiBatchModal ? source.slice(aiBatchModal.start, aiBatchModal.end) : 'null';
    const categorySlot = categoryForm?.arguments[2].properties.find(node => node.key.name === 'default').value;
    const categoryRender = categorySlot ? source.slice(categorySlot.start, categorySlot.end) : 'null';
    const dialogRender = dialogProps ? source.slice(dialogProps.start, dialogProps.end) : 'null';
    const bindings = name === 'Mg'
        ? `({ form:s, defaults:f, rules:m, open:g, close:I, dialogOpen:a, submit:k, filters:S, saveFilters:w, filterPresets:typeof filterPresets!=='undefined'?filterPresets:undefined, presetName:typeof filterPresetName!=='undefined'?filterPresetName:undefined, presetError:typeof filterPresetError!=='undefined'?filterPresetError:undefined, presetSaving:typeof filterPresetSaving!=='undefined'?filterPresetSaving:undefined, loadFilterPresets:typeof loadFilterPresets==='function'?loadFilterPresets:undefined, saveFilterPreset:typeof saveFilterPreset==='function'?saveFilterPreset:undefined, applyFilterPreset:typeof applyFilterPreset==='function'?applyFilterPreset:undefined,editFilterPreset:typeof editFilterPreset==='function'?editFilterPreset:undefined, deleteFilterPreset:typeof deleteFilterPreset==='function'?deleteFilterPreset:undefined, newFilterPreset:typeof newFilterPreset==='function'?newFilterPreset:undefined, cancelPresetEdit:typeof closeFilterPresetEditor==='function'?closeFilterPresetEditor:undefined, presetEditingId:typeof filterPresetEditingId!=='undefined'?filterPresetEditingId:undefined, presetDeletingId:typeof filterPresetDeletingId!=='undefined'?filterPresetDeletingId:undefined, presetEditor:typeof filterPresetEditor!=='undefined'?filterPresetEditor:undefined, presetSelected:typeof filterPresetSelected!=='undefined'?filterPresetSelected:undefined, aiConfigs:typeof aiListingConfigs!=='undefined'?aiListingConfigs:undefined, aiLoading:typeof aiConfigsLoading!=='undefined'?aiConfigsLoading:undefined, aiError:typeof aiConfigsError!=='undefined'?aiConfigsError:undefined, loadAiConfigs:typeof loadAiListingConfigs==='function'?loadAiListingConfigs:undefined, setAutoSend:typeof setAutoSendToAiListing==='function'?setAutoSendToAiListing:undefined, setAutoStart:typeof setAutoStartAiGeneration==='function'?setAutoStartAiGeneration:undefined, selectAiConfig:typeof selectAiListingConfig==='function'?selectAiListingConfig:undefined, openAiPage:typeof openAiListingPage==='function'?openAiListingPage:undefined, categoryControls:()=>{const p=[],Y='Cascader',z='Button',Pa={SHOW_CHILD:'SHOW_CHILD'};return (${categoryRender})();} })`
        : `({ edit:M, start:g, copy:w, dialog:R, dialogProps:()=>{const z=[];return (${dialogRender});}, sendToAi:typeof sendToAiListing==='function'?sendToAiListing:undefined, sending:typeof aiSendingTaskId!=='undefined'?aiSendingTaskId:undefined, aiButton:pe=>(${aiProps}), batchModal:()=>(${modalRender}) })`;
    const vnode = (type, props, children) => ({ type, props, children: typeof children?.default === 'function' ? children.default() : children });
    const context = vm.createContext({
        e: props, n: emit, t() {}, URL, console,
        ge: value => ({ value }),
        E: options => Object.defineProperty({}, 'value', options),
        Oe: (read, callback) => watches.push({ read, callback }),
        St: toRaw, Ws: () => ({ fullPath: '/collection' }),
        _: value => value && Object.hasOwn(value, 'value') ? value.value : value,
        an: value => value, oa: {},
        r: vnode, ve: vnode, As: 'Modal', ie: 'Button', D: callback => callback, $e: String, Ye: String,
        it: async () => {}, qe: callback => mounts.push(callback), hn() {},
        setTimeout: () => 1,
        Le: { error: value => errors.push(value), success: message => notices.push({ type: 'success', message }), warning: message => notices.push({ type: 'warning', message }) },
        window: { electronAPI: {
            async invoke(channel, payload) {
                assert.doesNotThrow(() => structuredClone(payload), `${channel} must cross Electron's structured-clone boundary`);
                calls.push({ channel, payload: plain(payload) });
                if (channel === 'collection-send-to-ai-listing') return aiResponse?.() || { code: 200, message: '主进程返回的结果' };
                if (channel.startsWith('collection-filter-presets-')) return filterPresetResponse?.(channel, payload) || { code: 200, data: { items: [] } };
                if (channel === 'collection-ai-configs') return aiConfigsResponse?.() || { code: 200, data: { items: [], url: 'https://app.example/ozon/tools/ai-listing' } };
                if (channel === 'open-url') {
                    externalCalls.push([channel, payload]);
                    return openUrlResponse?.() || { code: 200 };
                }
                if (channel === 'collection-get-all-tasks') return { list: [], total: 0 };
                if (channel === 'get-current-task-count') return 4;
                if (channel === 'get-category-list') return categoryResponse?.(payload) || { code: 400, data: [], message: 'Ozon 类目已更新', source: 'live', stale: false, fetchedAt: 1789228800000 };
                if (channel === 'get-shop-list' && shopResponse) return shopResponse();
                if (channel.startsWith('get-')) return { code: 400, data: [] };
                return { code: 200, message: 'ok' };
            },
            sendMessage: (...args) => externalCalls.push(args),
            on(channel, handler) { listeners.set(channel, handler); }, off(channel) { listeners.delete(channel); },
        } },
    });
    const prefix = helper ? `const ${source.slice(helper.start, helper.end)};` : '';
    const state = vm.runInContext(`(() => {${prefix}${source.slice(body.start + 1, returned.start)};${beforeRender};return ${bindings};})()`, context);
    return { ...state, calls, errors, notices, externalCalls, watches, listeners, async mounted() { for (const callback of mounts) await callback(); } };
}


const settle = () => new Promise(resolve => setImmediate(resolve));
const categoryTree = [{ category_id: '15500', name: '家居', children: [{ category_id: '44444', name: '厨房收纳', children: [] }] }];
const updatedCategoryTree = [{ category_id: '17000', name: '汽车用品', children: [{ category_id: '88888', name: '车载收纳', children: [] }] }];
const liveCategories = data => ({ code: 400, data, message: 'Ozon 类目已更新', source: 'live', stale: false, fetchedAt: 1789228800000 });

function categoryUi(options) {
    const page = setup('Hg', options);
    const props = {};
    for (const name of ['categoryList', 'categoryLoading', 'categoryStatus', 'categoryRetry']) {
        const attr = name.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`);
        Object.defineProperty(props, name, { get: () => page.dialogProps()[attr] });
    }
    const ui = setup('Mg', {
        props,
        emit: name => name === 'refreshCategories' && page.dialogProps().onRefreshCategories?.(),
    });
    page.dialog.value = {
        get formData() { return ui.form.value; },
        set formData(value) { ui.form.value = value; },
        openDialog: ui.open, saveOldFormdata: ui.saveFilters,
    };
    const nodes = () => {
        const found = [];
        const visit = node => {
            if (Array.isArray(node)) return node.forEach(visit);
            if (!node || typeof node !== 'object') return;
            found.push(node);
            visit(node.children);
        };
        visit(ui.categoryControls());
        return found;
    };
    return {
        page, ui,
        select: () => nodes().find(node => node.type === 'Cascader'),
        button: () => nodes().find(node => node.type === 'Button'),
        status: () => nodes().find(node => ['alert', 'status'].includes(node.props?.role)),
        categoryCalls: () => page.calls.filter(call => call.channel === 'get-category-list'),
    };
}

test('new and edited task dialogs expose baseline choices before background Seller updates finish', async () => {
    for (const task of [undefined, { ...legacyTask, isUseCategorySelect: 0, categoryIds: [['15500', '44444']] }]) {
        let finish;
        const view = categoryUi({ categoryResponse: payload => payload.localOnly
            ? { code: 400, data: categoryTree, source: 'baseline', snapshotDate: '2026-09-13', stale: true, message: '内置类目快照' }
            : new Promise(resolve => { finish = resolve; }) });
        await view.page.mounted();
        assert.deepEqual(view.categoryCalls(), []);
        const opening = view.page.edit(task);
        await settle();
        assert.equal(view.ui.dialogOpen.value, true);
        assert.deepEqual(plain(view.select().props.options), categoryTree, 'prepared choices must appear before Seller responds');
        assert.equal(view.select().props.disabled, false);
        assert.deepEqual(view.categoryCalls().map(call => call.payload), [{ localOnly: true }, { background: true }]);
        assert.match(view.status().children, /基线|内置/u);
        assert.match(view.status().children, /2026-09-13/u);
        assert.match(view.status().children, /后台/u);
        view.select().props['onUpdate:value']([['15500', '44444']]);
        assert.deepEqual(plain(view.ui.form.value.categoryIds), [['15500', '44444']]);
        view.button().props.onClick();
        await view.page.edit(task);
        assert.equal(view.categoryCalls().length, 2, 'reopening and refresh share the in-flight background request');
        finish({ code: 400, data: updatedCategoryTree, source: 'baseline', snapshotDate: '2026-09-13', stale: true, updateFailed: true, message: 'HTTP 403' });
        await opening;
        assert.deepEqual(plain(view.select().props.options), categoryTree, 'failed background updates do not replace prepared options');
        assert.deepEqual(plain(view.select().props.value), [['15500', '44444']]);
        assert.match(view.status().children, /403/u);
        assert.match(view.status().children, /2026-09-13/u);
        assert.equal(view.button().props.disabled, false);
    }
});

test('a pending shop lookup does not delay category loading or opening the task dialog', async () => {
    let finishShop;
    const view = categoryUi({
        categoryResponse: () => liveCategories(categoryTree),
        shopResponse: () => new Promise(resolve => { finishShop = resolve; }),
    });
    const opening = view.page.edit();
    await settle();
    assert.equal(view.ui.dialogOpen.value, true);
    assert.deepEqual(plain(view.select().props.options), categoryTree);
    finishShop({ code: 400, data: [] });
    await opening;
});

test('cached and learned category results disclose their source and stale refresh messages', async () => {
    const fixtures = [
        { source: 'cache', stale: false, message: '缓存仍在有效期内', sourceText: /缓存/u },
        { source: 'cache', stale: true, message: 'Seller 暂不可用，未能更新类目', sourceText: /缓存/u },
        { source: 'learned', stale: true, message: '当前仅有任务记录中已学习的类目', sourceText: /已学习/u },
    ];
    for (const fixture of fixtures) {
        const view = categoryUi({ categoryResponse: () => ({ code: 400, data: categoryTree, fetchedAt: 1789142400000, ...fixture }) });
        await view.page.edit();
        assert.deepEqual(plain(view.select().props.options), categoryTree);
        const status = view.status();
        assert.ok(status, 'the result source must remain visible beside the selector');
        assert.match(status.children, fixture.sourceText);
        assert.ok(status.children.includes(fixture.message));
        assert.doesNotMatch(status.children, /最新/u);
        if (fixture.source === 'learned') assert.match(status.children, /不完整/u);
        assert.equal(status.props.role, fixture.stale ? 'alert' : 'status');
        assert.equal(view.button().props.disabled, false);
    }
});

test('category refresh failures retain old options and selected paths until retry succeeds', async () => {
    for (const reject of [false, true]) {
        let response = () => liveCategories(categoryTree);
        const view = categoryUi({ categoryResponse: () => response() });
        const task = { ...legacyTask, isUseCategorySelect: 0, categoryIds: [['15500', '44444']] };
        await view.page.edit(task);
        assert.ok(view.button(), 'category refresh must be available beside the selector');
        response = () => {
            if (reject) throw new Error('类目 IPC 连接中断');
            return { code: 500, data: null, message: '请先登录 Seller 再重试' };
        };
        await view.button().props.onClick();
        await settle();
        assert.deepEqual(plain(view.select().props.options), categoryTree);
        assert.deepEqual(plain(view.select().props.value), [['15500', '44444']]);
        assert.equal(view.status().props.role, 'alert');
        assert.match(view.status().children, reject ? /IPC 连接中断/u : /请先登录 Seller/u);
        assert.match(view.button().children.join(''), /重试/u);
        assert.equal(view.button().props.disabled, false);
        response = () => liveCategories(updatedCategoryTree);
        await view.button().props.onClick();
        await settle();
        assert.deepEqual(plain(view.select().props.options), updatedCategoryTree);
        assert.deepEqual(plain(view.select().props.value), [['15500', '44444']], 'refresh must not replace saved task selections');
        assert.equal(view.status().props.role, 'status');
        assert.doesNotMatch(view.status().children, /IPC 连接中断|请先登录 Seller/u);
        assert.deepEqual(view.categoryCalls().map(call => call.payload), [{ localOnly: true }, { background: true }, { background: true, refresh: true }, { background: true, refresh: true }]);
        assert.deepEqual(task.categoryIds, [['15500', '44444']]);
    }
});

test('an initial category error can be retried and closing then reopening checks categories again', async () => {
    let response = { code: 500, data: null, message: 'Seller 类目暂时不可用' };
    const view = categoryUi({ categoryResponse: () => response });
    await view.page.edit();
    assert.deepEqual(plain(view.select().props.options), []);
    assert.equal(view.status()?.props.role, 'alert');
    assert.match(view.status().children, /Seller 类目暂时不可用/u);
    response = liveCategories(categoryTree);
    await view.button().props.onClick();
    await settle();
    assert.deepEqual(plain(view.select().props.options), categoryTree);
    view.ui.close();
    assert.equal(view.ui.dialogOpen.value, false);
    await view.page.edit({ ...legacyTask, categoryIds: [['15500', '44444']] });
    assert.equal(view.ui.dialogOpen.value, true);
    assert.equal(view.select().props.disabled, true, 'link collection keeps its existing disabled category selector');
    assert.equal(view.ui.form.value.targetUrl, 'https://www.ozon.ru/category/dom-14500/');
    assert.deepEqual(plain(view.ui.form.value.categoryIds), [['15500', '44444']]);
    assert.deepEqual(view.categoryCalls().map(call => call.payload), [{ localOnly: true }, { background: true }, { background: true, refresh: true }, { localOnly: true }, { background: true }]);
});

test('simultaneous automatic AI completions keep each task batch selection until dismissed', async () => {
    const ui = setup('Hg');
    await ui.mounted();
    const complete = ui.listeners.get('task-completed');
    assert.equal(typeof complete, 'function');
    const event = (name, ids) => ({ taskName: name, aiListingResult: { code: 200, data: {
        aiListingBatches: ids.map((id, index) => ({ index: index + 1, count: 1, url: `http://127.0.0.1:3000/ozon/tools/ai-listing?ids=${id}` })),
    } } });
    complete(event('第一任务', ['a', 'b']));
    complete(event('第二任务', ['c', 'd', 'e']));
    assert.match(ui.batchModal().children[0].children, /第一任务/u);
    assert.equal(ui.batchModal().children[1].children.length, 2);
    ui.batchModal().props.onCancel();
    assert.match(ui.batchModal().children[0].children, /第二任务/u);
    assert.equal(ui.batchModal().children[1].children.length, 3);
    ui.batchModal().props.onCancel();
    assert.equal(ui.batchModal().props.open, false);
    assert.equal(ui.calls.some(call => call.channel === 'collection-send-to-ai-listing'), false, 'completion events display prepared results without reimporting');
});

test('a delayed manual handoff cannot overwrite or close automatic results received while it was pending', async () => {
    for (const manualCount of [1, 2]) {
        let finishManual;
        const ui = setup('Hg', { aiResponse: () => new Promise(resolve => { finishManual = resolve; }) });
        await ui.mounted();
        const manual = ui.sendToAi({ _id: 'manual', taskName: '手动任务' });
        const batches = name => [1, 2].map(index => ({ index, count: 1, url: `http://127.0.0.1:3000/ozon/tools/ai-listing?ids=${name}-${index}` }));
        const complete = ui.listeners.get('task-completed');
        for (const name of ['自动一', '自动二']) complete({ taskName: name, aiListingResult: { code: 200, data: { aiListingBatches: batches(name) } } });
        finishManual({ code: 200, message: '准备完成', data: { aiListingBatches: batches('manual').slice(0, manualCount) } });
        await manual;
        assert.equal(ui.batchModal().props.open, true);
        assert.match(ui.batchModal().children[0].children, /自动一/u);
        ui.batchModal().props.onCancel();
        assert.match(ui.batchModal().children[0].children, /自动二/u);
        ui.batchModal().props.onCancel();
        assert.equal(ui.batchModal().props.open, manualCount > 1);
        if (manualCount > 1) assert.match(ui.batchModal().children[0].children, /手动任务/u);
    }
});

function assertNoPricing(data) {
    for (const field of [...retired, 'configuration']) {
        assert.equal(Object.hasOwn(data, field), false, `${field} must not reach the task UI/write boundary`);
    }
}

test('task dialog exposes only Ozon information and selection controls', () => {
    const sections = [], controls = new Set();
    walk(component('Mg'), node => {
        if (node.type === 'CallExpression' && node.callee.name === 've' && node.arguments[0]?.value === 'section') {
            const text = [];
            walk(node, child => {
                if (child.type === 'Literal' && typeof child.value === 'string') text.push(child.value);
            });
            sections.push(text.join(' '));
        }
        if (node.type === 'MemberExpression' && node.object.type === 'CallExpression'
            && node.object.callee.name === '_' && node.object.arguments[0]?.name === 's') controls.add(node.property.name);
    });
    assert.match(sections[0], /基础信息/u);
    assert.match(sections[1], /选品条件/u);
    assert.doesNotMatch(sections.join(' '), /商品定价|利润率|1688|货源成本|定价基准/u);
    for (const field of retired) assert.equal(controls.has(field), false, field);
    for (const field of ['soldCountMin', 'ratingMin', 'followMax', 'salePriceMin', 'numberOfCommentsMin']) assert.equal(controls.has(field), true, field);
    const props = component('Mg').properties.find(node => node.key.name === 'props').value.properties.map(node => node.key.name);
    assert.equal(props.includes('configList'), false);
    assert.equal(props.includes('logisticsSimpleList'), false);
});

test('new task defaults and form validation do not require any pricing configuration', () => {
    const ui = setup('Mg');
    assertNoPricing(ui.defaults.value);
    for (const field of retired) assert.equal(Object.hasOwn(ui.rules, field), false, field);
    assert.equal(ui.rules.taskName.some(rule => rule.required), true);
});

test('new task dialog sends ALL scope while opening a legacy task keeps CURRENT', async () => {
    const fresh = setup('Mg');
    fresh.open();
    assert.equal(fresh.form.value.captureScope, 'ALL');
    const old = setup('Mg');
    old.form.value = { ...legacyTask };
    old.open();
    assert.equal(old.form.value.captureScope, 'CURRENT');
    const whole = setup('Mg');
    whole.form.value = { ...legacyTask, captureScope: 'ALL' };
    whole.open();
    assert.equal(whole.form.value.captureScope, 'ALL');
});

test('automatic AI handoff defaults off and survives new, edited and copied task writes', async () => {
    const fresh = setup('Mg');
    assert.equal(fresh.defaults.value.autoSendToAiListing, false);
    for (const enabled of [true, false]) {
        const ui = setup('Mg');
        ui.form.value = { ...legacyTask, autoSendToAiListing: enabled };
        ui.open();
        await ui.submit('save');
        assert.equal(ui.calls.find(call => call.channel === 'collection-create').payload.data.autoSendToAiListing, enabled);
        const page = setup('Hg');
        await page.copy({ ...legacyTask, autoSendToAiListing: enabled });
        assert.equal(page.calls.find(c => c.channel === 'collection-copy').payload.data.autoSendToAiListing, enabled);
    }
    const old = setup('Mg');
    old.form.value = { ...legacyTask };
    old.open();
    assert.equal(old.form.value.autoSendToAiListing, false, 'old tasks must not silently opt in');
    const dialog = source.slice(component('Mg').start, component('Mg').end);
    assert.match(dialog, /自动发送至 AI 上架/u);
});

test('new Ozon-only tasks can be saved and executed without a target quote', async () => {
    for (const [action, channel] of [['save', 'collection-create'], ['execute', 'collection-create-and-start']]) {
        const ui = setup('Mg');
        Object.assign(ui.form.value, { taskName: 'Ozon采集', isUseCategorySelect: 0, categoryIds: [['__all__', '*']], targetCount: 5, ratingMin: 4, followMax: 30 });
        await ui.submit(action);
        assert.deepEqual(ui.errors, []);
        assert.equal(ui.calls.length, 1);
        assert.equal(ui.calls[0].channel, channel);
        assert.equal(ui.calls[0].payload.data.targetCount, 5);
        assert.equal(ui.calls[0].payload.data.ratingMin, 4);
        assertNoPricing(ui.calls[0].payload.data);
    }
});

test('opening and editing an old task ignores malformed retired quotes and preserves Ozon filters', async () => {
    const ui = setup('Mg');
    ui.form.value = { ...legacyTask };
    ui.open();
    assertNoPricing(ui.form.value);
    await ui.submit('save');
    assert.deepEqual(ui.errors, []);
    assert.equal(ui.calls.filter(call => call.channel === 'collection-create').length, 1);
    const saved = ui.calls.find(call => call.channel === 'collection-create').payload.data;
    assert.equal(saved._id, 'old-task');
    assert.equal(saved.soldCountMin, 50);
    assert.equal(saved.ratingMin, 4);
    assert.equal(saved.followMax, 30);
    assert.equal(saved.salePriceMin, 0);
    assertNoPricing(saved);
});

test('saving also removes stale pricing fields assigned after a dialog was opened', async () => {
    const ui = setup('Mg');
    ui.open();
    Object.assign(ui.form.value, legacyTask);
    await ui.submit('execute');
    assert.deepEqual(ui.errors, []);
    assert.equal(ui.calls.filter(call => call.channel === 'collection-create-and-start').length, 1);
    assertNoPricing(ui.calls.find(call => call.channel === 'collection-create-and-start').payload.data);
});

test('task page startup and editing do not load pricing or logistics configuration', async () => {
    const page = setup('Hg');
    const ui = setup('Mg');
    page.dialog.value = {
        get formData() { return ui.form.value; },
        set formData(value) { ui.form.value = value; },
        openDialog: ui.open, saveOldFormdata: ui.saveFilters,
    };
    await page.mounted();
    await page.edit({ ...legacyTask });
    const channels = page.calls.map(call => call.channel);
    assert.equal(channels.includes('get-logistics-list'), false);
    assert.equal(channels.includes('get-config-list'), false);
    assert.equal(channels.includes('get-category-list'), true);
    assertNoPricing(ui.form.value);
});

test('starting or copying an existing task cannot resubmit its retired pricing configuration', async () => {
    const page = setup('Hg');
    await page.start({ ...legacyTask });
    await page.copy({ ...legacyTask });
    const writes = page.calls.filter(call => ['collection-create-and-start', 'collection-copy'].includes(call.channel));
    assert.equal(writes.length, 2);
    for (const { payload } of writes) {
        assertNoPricing(payload.data);
        assert.equal(payload.data._id, 'old-task');
        assert.equal(payload.data.ratingMin, 4);
    }
});

test('starting a reactive task serializes nested category paths and progress at the IPC boundary', async () => {
    const raw = { ...legacyTask, categoryIds: [['__all__', '14500']], progress: { counts: { saved: 1 }, skus: ['2157503620'] } };
    const row = reactive(raw);
    for (const value of [row, row.categoryIds, row.categoryIds[0], row.progress, row.progress.counts, row.progress.skus]) {
        assert.equal(types.isProxy(value), true, 'the fixture uses real nested Vue proxies');
    }
    assert.doesNotThrow(() => structuredClone(toRaw(row)), 'the original row is unwrapped by toRaw');
    assert.throws(() => structuredClone(toRaw({ ...row })), { name: 'DataCloneError' }, 'a rest/spread copy retains nested proxies');
    const page = setup('Hg');
    await page.start(row);
    const written = page.calls.find(call => call.channel === 'collection-create-and-start').payload.data;
    assert.deepEqual(written.categoryIds, raw.categoryIds);
    assert.deepEqual(written.progress, raw.progress);
    assert.equal(written._id, raw._id);
    assertNoPricing(written);
    assert.equal(raw.myProfitPercent, 90, 'cleaning the IPC payload must not mutate the source task');
});

test('copying and saving reactive tasks keep nested Ozon data serializable and discard retired pricing', async () => {
    const task = { ...legacyTask, categoryIds: [['__all__', '14500']], progress: { counts: { saved: 1 } } };
    const page = setup('Hg');
    await page.copy(reactive({ ...task }));
    const copied = page.calls.find(call => call.channel === 'collection-copy').payload.data;
    assert.deepEqual(copied.categoryIds, task.categoryIds);
    assert.deepEqual(copied.progress, task.progress);
    assertNoPricing(copied);
    for (const [action, channel] of [['save', 'collection-create'], ['execute', 'collection-create-and-start']]) {
        const ui = setup('Mg');
        ui.form.value = reactive({ ...task });
        await ui.submit(action);
        assert.deepEqual(ui.errors, []);
        const saved = ui.calls.find(call => call.channel === channel).payload.data;
        assert.deepEqual(saved.categoryIds, task.categoryIds);
        assert.deepEqual(saved.progress, task.progress);
        assertNoPricing(saved);
    }
});

test('invalid Ozon ranges remain blocked before IPC submission', async () => {
    const ui = setup('Mg');
    Object.assign(ui.form.value, { taskName: '范围校验', isUseCategorySelect: 0, categoryIds: [['__all__', '*']], soldCountMin: 20, soldCountMax: 10 });
    await ui.submit('save');
    assert.equal(ui.calls.length, 0);
    assert.equal(ui.errors.at(-1), '最小值不能超过最大值');
});

test('static selection presets and restoration of custom Ozon filters remain local', () => {
    const ui = setup('Mg');
    Object.assign(ui.form.value, { aiSelectType: 1, soldCountMin: 77, ratingMin: 4.5, followMax: 12 });
    ui.watches[0].callback(2, 1);
    assert.equal(ui.form.value.soldCountMin, 50);
    assert.equal(ui.form.value.ratingMin, 4);
    assert.equal(ui.form.value.followMax, 30);
    ui.watches[0].callback(1, 2);
    assert.equal(ui.form.value.soldCountMin, 77);
    assert.equal(ui.form.value.ratingMin, 4.5);
    assert.equal(ui.form.value.followMax, 12);
    assert.equal(ui.calls.length, 0);
});

test('AI entry permits saved results from every run status and rejects tasks with no run', () => {
    const ui = setup('Hg');
    assert.equal(typeof ui.sendToAi, 'function');
    for (const taskStatus of ['running', 'pending', 'noExecuted']) {
        assert.equal(ui.aiButton({ _id: 'task-1', taskStatus }).disabled, true, taskStatus);
    }
    for (const taskStatus of ['completed', 'failed', 'cancelled', 'running', 'pending']) {
        const props = ui.aiButton({ _id: 'task-1', currentRunId: 'saved-run', taskStatus });
        assert.equal(props.disabled, false, taskStatus);
        assert.equal(props.loading, false);
        assert.equal(typeof props.onClick, 'function');
    }
});

test('AI entry sends only the task selection and displays Main success or partial messages unchanged', async () => {
    for (const [code, type] of [[200, 'success'], [207, 'warning']]) {
        const message = `Main response ${code}`;
        const ui = setup('Hg', { aiResponse: () => ({ code, message, data: { partial: code === 207, results: [{ collectItemId: 'collect-1' }] }, url: 'https://main-selected.example/ai' }) });
        const props = ui.aiButton({ _id: 'task-1', currentRunId: 'saved-run', taskStatus: 'completed', config: { targetStoreId: 'must-not-send' } });
        assert.ok(props, 'the shipped AI action must exist');
        await props.onClick();
        const writes = ui.calls.filter(call => call.channel === 'collection-send-to-ai-listing');
        assert.deepEqual(writes, [{ channel: 'collection-send-to-ai-listing', payload: { taskId: 'task-1', runId: 'saved-run', allQualified: true, manual: true } }]);
        assert.deepEqual(ui.notices, [{ type, message }]);
        assert.deepEqual(ui.errors, []);
        assert.deepEqual(ui.externalCalls, [], 'Main alone opens the trusted Web destination');
        assert.equal(ui.sending.value, '');
    }
});

test('AI entry stays loading during IPC and does not dispatch duplicate clicks', async () => {
    let finish;
    const ui = setup('Hg', { aiResponse: () => new Promise(resolve => { finish = resolve; }) });
    assert.equal(typeof ui.sendToAi, 'function');
    const first = ui.sendToAi({ _id: 'task-1' });
    assert.equal(ui.aiButton({ _id: 'task-1', currentRunId: 'saved-run', taskStatus: 'completed' }).loading, true);
    assert.equal(ui.aiButton({ _id: 'task-2', currentRunId: 'other-run', taskStatus: 'completed' }).loading, false);
    assert.equal(ui.aiButton({ _id: 'task-2', currentRunId: 'other-run', taskStatus: 'completed' }).disabled, true);
    await ui.sendToAi({ _id: 'task-1' });
    await ui.sendToAi({ _id: 'task-2' });
    assert.equal(ui.calls.filter(call => call.channel === 'collection-send-to-ai-listing').length, 1);
    finish({ code: 200, message: 'Main完成' });
    await first;
    assert.equal(ui.sending.value, '');
    assert.equal(ui.aiButton({ _id: 'task-1', currentRunId: 'saved-run', taskStatus: 'completed' }).disabled, false);
});

test('AI entry preserves a Main failure message and releases loading for retry', async () => {
    const ui = setup('Hg', { aiResponse: () => ({ code: 422, message: 'Main具体失败原因', data: { aiListingBatches: [] } }) });
    assert.equal(typeof ui.sendToAi, 'function');
    await ui.sendToAi({ _id: 'task-1' });
    assert.deepEqual(ui.errors, ['Main具体失败原因']);
    assert.deepEqual(ui.notices, []);
    assert.equal(ui.sending.value, '');
    assert.equal(ui.batchModal().props.open, false);
    assert.deepEqual(ui.externalCalls, []);
});

test('AI entry catches IPC rejection and releases loading without opening another URL', async () => {
    const ui = setup('Hg', { aiResponse: async () => { throw new Error('IPC连接中断'); } });
    assert.equal(typeof ui.sendToAi, 'function');
    await ui.sendToAi({ _id: 'task-1' });
    assert.deepEqual(ui.errors, ['IPC连接中断']);
    assert.deepEqual(ui.externalCalls, []);
    assert.equal(ui.sending.value, '');
});

const aiBatches = [
    { index: 1, count: 100, url: 'https://main-selected.example/ozon/tools/ai-listing?source=collect&ids=first-100' },
    { index: 2, count: 100, url: 'https://main-selected.example/ozon/tools/ai-listing?source=collect&ids=second-100' },
    { index: 3, count: 35, url: 'https://main-selected.example/ozon/tools/ai-listing?source=collect&ids=remaining-35' },
];

test('235 unique successful results retain all 100/100/35 batches without opening tabs automatically', async () => {
    const ui = setup('Hg', { aiResponse: () => ({ code: 207, message: 'Main部分成功结果', data: { added: 236, errors: [{ code: 'failed-item' }], aiListingBatches: aiBatches } }) });
    await ui.sendToAi({ _id: 'task-many' });
    const modal = ui.batchModal();
    assert.ok(modal, 'the existing Modal component must expose the batch picker');
    assert.equal(modal.props.open, true);
    assert.match(modal.children[0].children, /235.*3/u);
    assert.deepEqual(plain(modal.children[1].children.map(button => button.children.join(''))), [
        '第 1 批（100 条）', '第 2 批（100 条）', '第 3 批（35 条）',
    ]);
    assert.deepEqual(ui.externalCalls, []);
    assert.deepEqual(ui.notices, [{ type: 'warning', message: 'Main部分成功结果' }]);
});

test('opening batches uses the exact Main URLs, keeps the picker open, and marks only 已打开', async () => {
    const ui = setup('Hg', { aiResponse: () => ({ code: 200, message: 'Main分批结果', data: { aiListingBatches: aiBatches } }) });
    await ui.sendToAi({ _id: 'task-many' });
    assert.ok(ui.batchModal());
    for (let index = 0; index < 3; index++) {
        await ui.batchModal().children[1].children[index].props.onClick();
        const modal = ui.batchModal();
        assert.equal(modal.props.open, true);
        const labels = modal.children[1].children.map(button => button.children.join(''));
        assert.match(labels[index], /已打开/u);
        if (index < 2) assert.doesNotMatch(labels[index + 1], /已打开/u);
        assert.doesNotMatch(labels.join(' '), /已创建|已上架|已发布/u);
    }
    assert.deepEqual(ui.externalCalls, aiBatches.map(batch => ['open-url', batch.url]));
    ui.batchModal().props.onCancel();
    assert.equal(ui.batchModal().props.open, false);
});

test('a later single batch preserves the current picker without duplicating the Main auto-open', async () => {
    let result = { code: 200, message: 'Main分批结果', data: { aiListingBatches: aiBatches } };
    const ui = setup('Hg', { aiResponse: () => result });
    await ui.sendToAi({ _id: 'task-many' });
    assert.ok(ui.batchModal());
    for (const aiListingBatches of [[{ index: 1, count: 100, url: 'https://main-selected.example/already-opened' }], []]) {
        result = { code: 200, message: 'Main已打开', data: { aiListingBatches } };
        await ui.sendToAi({ _id: 'task-small' });
        assert.equal(ui.batchModal().props.open, true);
        assert.equal(ui.batchModal().children[1].children.length, aiBatches.length);
        assert.deepEqual(ui.externalCalls, []);
    }
});

test('the next multi-batch response clears the previous opened markers after dismissal', async () => {
    const ui = setup('Hg', { aiResponse: () => ({ code: 200, message: 'Main分批结果', data: { aiListingBatches: aiBatches } }) });
    await ui.sendToAi({ _id: 'task-first' });
    assert.ok(ui.batchModal());
    await ui.batchModal().children[1].children[0].props.onClick();
    assert.match(ui.batchModal().children[1].children[0].children.join(''), /已打开/u);
    ui.batchModal().props.onCancel();
    await ui.sendToAi({ _id: 'task-second' });
    assert.doesNotMatch(ui.batchModal().children[1].children[0].children.join(''), /已打开/u);
});

test('a single prepared batch remains available when Main could not open the browser', async () => {
    const message = '商品已准备好但未能自动打开，请点批次打开';
    const ui = setup('Hg', { aiResponse: () => ({ code: 207, message, data: {
        browserOpenFailed: true, aiListingBatches: [{ ...aiBatches[0], count: 1 }],
    } }) });
    await ui.sendToAi({ _id: 'task-single' });
    const modal = ui.batchModal();
    assert.equal(modal.props.open, true);
    assert.match(modal.children[0].children, /共 1 条，分 1 批/u);
    assert.equal(modal.children[1].children.length, 1);
    assert.equal(modal.children[1].children[0].children.join(''), '第 1 批（1 条）');
    assert.deepEqual(ui.notices, [{ type: 'warning', message }]);
    assert.deepEqual(ui.externalCalls, []);
    await modal.children[1].children[0].props.onClick();
    assert.deepEqual(ui.calls.filter(call => call.channel === 'open-url'), [{ channel: 'open-url', payload: aiBatches[0].url }]);
    assert.equal(ui.batchModal().props.open, true);
    assert.match(ui.batchModal().children[1].children[0].children.join(''), /已打开/u);
});

test('failed batch opens remain unmarked and retryable for Main errors and IPC rejection', async () => {
    for (const reject of [false, true]) {
        let attempts = 0;
        const ui = setup('Hg', {
            aiResponse: () => ({ code: 207, message: '请手动打开', data: { browserOpenFailed: true, aiListingBatches: [aiBatches[0]] } }),
            openUrlResponse: () => {
                attempts += 1;
                if (attempts > 1) return { code: 200 };
                if (reject) throw new Error('打开IPC中断');
                return { code: 500, message: '浏览器仍未打开' };
            },
        });
        await ui.sendToAi({ _id: 'task-single' });
        await ui.batchModal().children[1].children[0].props.onClick();
        const retry = ui.batchModal().children[1].children[0];
        assert.doesNotMatch(retry.children.join(''), /已打开/u);
        assert.equal(Boolean(retry.props.disabled), false);
        assert.equal(Boolean(retry.props.loading), false);
        assert.equal(ui.errors.at(-1), reject ? '打开IPC中断' : '浏览器仍未打开');
        await retry.props.onClick();
        assert.equal(attempts, 2);
        assert.match(ui.batchModal().children[1].children[0].children.join(''), /已打开/u);
        assert.deepEqual(ui.externalCalls, [['open-url', aiBatches[0].url], ['open-url', aiBatches[0].url]]);
    }
});

test('a batch is not marked open before the Main acknowledgement and duplicate pending clicks are blocked', async () => {
    let finish;
    const ui = setup('Hg', {
        aiResponse: () => ({ code: 200, message: '分批结果', data: { aiListingBatches: aiBatches } }),
        openUrlResponse: () => new Promise(resolve => { finish = resolve; }),
    });
    await ui.sendToAi({ _id: 'task-many' });
    const first = ui.batchModal().children[1].children[0].props.onClick();
    const buttons = ui.batchModal().children[1].children;
    assert.doesNotMatch(buttons[0].children.join(''), /已打开/u);
    assert.equal(buttons[0].props.loading, true);
    assert.equal(buttons[0].props.disabled, true);
    await buttons[0].props.onClick();
    assert.equal(ui.externalCalls.length, 1);
    finish({ code: 200 });
    await first;
    assert.match(ui.batchModal().children[1].children[0].children.join(''), /已打开/u);
    assert.equal(ui.batchModal().children[1].children[0].props.loading, false);
    assert.equal(ui.batchModal().children[1].children[0].props.disabled, false);
});

test('new tasks save CNY black-price bounds with the same currency shown beside the inputs', async () => {
    const dialogSource = source.slice(component('Mg').start, component('Mg').end);
    assert.ok(dialogSource.includes('前台黑标价（¥）'));
    const ui = setup('Mg');
    for (const field of ['salePriceMin', 'salePriceMax']) {
        let input;
        walk(component('Mg'), node => {
            if (node.type === 'CallExpression' && node.callee.name === 'r' && node.arguments[0]?.name === 'R'
                && node.arguments[1]?.properties?.some(prop => prop.key.name === 'value' && prop.value.property?.name === field)) input = node.arguments[1];
        });
        const currency = input.properties.find(prop => prop.key.value === 'addon-before').value;
        assert.equal(vm.runInNewContext(source.slice(currency.start, currency.end), { _: value => value.value, s: ui.form }), '¥');
    }
    Object.assign(ui.form.value, { taskName: '黑标价筛选', aiSelectType: 1, isUseCategorySelect: 0, categoryIds: [['__all__', '*']], salePriceMin: 100, salePriceMax: 150 });
    await ui.submit('save');
    assert.deepEqual(ui.errors, []);
    assert.equal(ui.calls[0].payload.data.salePriceBasis, 'storefrontCny');
    assert.equal(ui.calls[0].payload.data.salePriceMin, 100);
    assert.equal(ui.calls[0].payload.data.salePriceMax, 150);
});

test('legacy tasks and presets retain Seller RUB bounds while new presets retain CNY black-price bounds', async () => {
    const ui = setup('Mg');
    ui.form.value = { ...legacyTask, aiSelectType: 1, salePriceMin: 500, salePriceMax: 900 };
    ui.open();
    await ui.submit('save');
    assert.equal(ui.calls.find(call => call.channel === 'collection-create').payload.data.salePriceBasis, 'sellerRub');
    assert.equal(ui.calls.find(call => call.channel === 'collection-create').payload.data.salePriceMin, 500);
    ui.filterPresets.value = [
        { id: 'old', filters: { salePriceMin: 500, salePriceMax: 900 } },
        { id: 'new', filters: { salePriceBasis: 'storefrontCny', salePriceMin: 100, salePriceMax: 150 } },
    ];
    ui.applyFilterPreset('new');
    assert.equal(ui.form.value.salePriceBasis, 'storefrontCny');
    assert.equal(ui.form.value.salePriceMin, 100);
    ui.applyFilterPreset('old');
    assert.equal(ui.form.value.salePriceBasis, 'sellerRub');
    assert.equal(ui.form.value.salePriceMin, 500);
});

test('switching price basis schedules the currency addon update along with price bounds', () => {
    const inputs = [];
    let priceTooltip;
    walk(component('Mg'), node => {
        if (node.type === 'CallExpression' && node.callee.name === 'r' && node.arguments[0]?.name === 'H'
            && node.arguments[1]?.properties?.some(prop => prop.key.name === 'title'
                && source.slice(prop.value.start, prop.value.end).includes('人民币黑标价'))) priceTooltip = node;
        if (node.type !== 'CallExpression' || node.callee.name !== 'r' || node.arguments[0]?.name !== 'R') return;
        const field = node.arguments[1]?.properties?.find(prop => prop.key.name === 'value')?.value.property?.name;
        if (['salePriceMin', 'salePriceMax'].includes(field)) inputs.push(node);
    });
    assert.equal(inputs.length, 2);
    for (const input of inputs) {
        // Vue's PROPS patch flag only applies props named in dynamicProps.
        assert.ok(input.arguments[4].elements.some(prop => prop.value === 'addon-before'));
    }
    assert.equal(priceTooltip.arguments[3]?.value, 8, 'the price explanation must update when a different basis is applied');
    assert.ok(priceTooltip.arguments[4].elements.some(prop => prop.value === 'title'));
});

test('default and custom monthly sales dynamics use percentages and preserve the 10 threshold on save', async () => {
    const inputs = [];
    walk(component('Mg'), node => {
        if (node.type !== 'CallExpression' || node.callee.name !== 'r') return;
        const props = node.arguments[1]?.properties;
        const field = props?.find(prop => prop.key.name === 'value')?.value.property?.name;
        if (['monthDynamicsMin', 'monthDynamicsMax'].includes(field)) inputs.push({ field, props });
    });
    assert.equal(inputs.length, 4, 'both min/max controls in the default and custom modes are covered');
    for (const { field, props } of inputs) {
        assert.equal(props.find(prop => prop.key.value === 'addon-after')?.value.value, '%', field);
        assert.equal(props.some(prop => prop.value?.value === '₽'), false, field);
    }
    for (const aiSelectType of [1, 2]) {
        const ui = setup('Mg');
        Object.assign(ui.form.value, { taskName: '销售动态筛选', isUseCategorySelect: 0, categoryIds: [['__all__', '*']],
            aiSelectType, monthDynamicsMin: 10, monthDynamicsMax: 30 });
        if (aiSelectType === 2) ui.watches[0].callback(2, 1);
        assert.equal(ui.form.value.monthDynamicsMin, 10);
        const maximum = ui.form.value.monthDynamicsMax;
        await ui.submit('save');
        assert.deepEqual(ui.errors, []);
        assert.equal(ui.calls[0].payload.data.monthDynamicsMin, 10);
        assert.equal(ui.calls[0].payload.data.monthDynamicsMax, maximum);
    }
});


const reviewPreset = { id: 'review-preset', name: '审核后上架', updatedAt: '2026-09-14T01:00:00Z', config: { manualReview: true, targetStoreId: 'store-a', targetWarehouseId: 'wh-a', stock: 5 } };
const submitPreset = { id: 'submit-preset', name: '自动上架', updatedAt: '2026-09-14T02:00:00Z', config: { manualReview: false, targetStoreId: 'store-b', targetWarehouseId: 'wh-b', stock: 10 } };
const presetResponse = items => ({ code: 200, data: { items, url: 'https://app.example/ozon/tools/ai-listing' } });
const validTask = { taskName: '隔离任务', isUseCategorySelect: 0, categoryIds: [['15500', '44444']], targetCount: 5 };

test('automatic AI generation defaults off for new and historical tasks and is cleared when handoff is disabled', async () => {
    const ui = setup('Mg', { aiConfigsResponse: () => presetResponse([reviewPreset]) });
    assert.equal(ui.defaults.value.autoStartAiGeneration, false);
    ui.form.value = { ...legacyTask, autoSendToAiListing: true };
    ui.open();
    assert.equal(ui.form.value.autoStartAiGeneration, false);
    assert.equal(ui.calls.filter(call => call.channel === 'collection-ai-configs').length, 0, 'optional AI preset lookup is lazy');
    ui.setAutoStart(true);
    await settle();
    ui.selectAiConfig(reviewPreset.id);
    assert.equal(ui.form.value.aiListingConfigUpdatedAt, reviewPreset.updatedAt);
    ui.setAutoSend(false);
    assert.equal(ui.form.value.autoStartAiGeneration, false);
    assert.equal(ui.form.value.aiListingConfigId, '');
    assert.equal(ui.form.value.aiAutoSubmitConfirmed, false);
    ui.setAutoSend(true);
    assert.equal(ui.form.value.autoStartAiGeneration, false);
});

test('automatic generation requires a saved preset and persists its selected revision for main-process freezing', async () => {
    const ui = setup('Mg', { aiConfigsResponse: () => presetResponse([reviewPreset]) });
    assert.equal(typeof ui.setAutoStart, 'function');
    ui.open();
    Object.assign(ui.form.value, validTask);
    ui.setAutoSend(true);
    ui.setAutoStart(true);
    await settle();
    await ui.submit('save');
    assert.match(ui.errors.at(-1), /选择.*配置/u);
    assert.equal(ui.calls.some(call => call.channel === 'collection-create'), false);
    ui.selectAiConfig(reviewPreset.id);
    await ui.submit('save');
    const saved = ui.calls.find(call => call.channel === 'collection-create').payload.data;
    assert.equal(saved.autoStartAiGeneration, true);
    assert.equal(saved.aiListingConfigId, reviewPreset.id);
    assert.equal(saved.aiListingConfigUpdatedAt, reviewPreset.updatedAt);
    assert.equal(saved.aiAutoSubmitConfirmed, false);
    assert.equal(Object.hasOwn(saved, 'aiListingConfigSnapshot'), false, 'the renderer sends a selected id and revision; freezing belongs to the main process');
});

test('presets that submit automatically require acknowledgement and changing a preset clears it', async () => {
    const ui = setup('Mg', { aiConfigsResponse: () => presetResponse([submitPreset, reviewPreset]) });
    assert.equal(typeof ui.setAutoStart, 'function');
    ui.open();
    Object.assign(ui.form.value, validTask);
    ui.setAutoSend(true);
    ui.setAutoStart(true);
    await settle();
    ui.selectAiConfig(submitPreset.id);
    await ui.submit('execute');
    assert.match(ui.errors.at(-1), /确认.*自动提交/u);
    assert.equal(ui.calls.some(call => call.channel === 'collection-create-and-start'), false);
    ui.form.value.aiAutoSubmitConfirmed = true;
    ui.selectAiConfig(reviewPreset.id);
    assert.equal(ui.form.value.aiAutoSubmitConfirmed, false);
    ui.selectAiConfig(submitPreset.id);
    ui.form.value.aiAutoSubmitConfirmed = true;
    await ui.submit('execute');
    assert.equal(ui.calls.find(call => call.channel === 'collection-create-and-start').payload.data.aiAutoSubmitConfirmed, true);
});

test('pending preset requests do not block closing and cannot overwrite a reopened dialog', async () => {
    const pending = [];
    const ui = setup('Mg', { aiConfigsResponse: () => new Promise(resolve => pending.push(resolve)) });
    assert.equal(typeof ui.setAutoStart, 'function');
    ui.open();
    ui.setAutoSend(true);
    ui.setAutoStart(true);
    assert.equal(ui.aiLoading.value, true);
    ui.close();
    assert.equal(ui.dialogOpen.value, false);
    assert.equal(ui.aiLoading.value, false);
    ui.open();
    ui.setAutoSend(true);
    ui.setAutoStart(true);
    pending[1](presetResponse([reviewPreset]));
    await settle();
    pending[0](presetResponse([submitPreset]));
    await settle();
    assert.deepEqual(plain(ui.aiConfigs.value), [reviewPreset]);
});

test('preset failures can be refreshed and a changed revision removes automatic submission acknowledgement', async () => {
    let response = { code: 503, message: '暂时无法读取配置' };
    const ui = setup('Mg', { aiConfigsResponse: () => response });
    assert.equal(typeof ui.setAutoStart, 'function');
    ui.open();
    ui.setAutoSend(true);
    ui.setAutoStart(true);
    await settle();
    assert.match(ui.aiError.value, /暂时无法读取配置/u);
    response = presetResponse([submitPreset]);
    await ui.loadAiConfigs();
    assert.equal(ui.aiError.value, '');
    ui.selectAiConfig(submitPreset.id);
    ui.form.value.aiAutoSubmitConfirmed = true;
    response = presetResponse([{ ...submitPreset, updatedAt: '2026-09-14T03:00:00Z' }]);
    await ui.loadAiConfigs();
    assert.equal(ui.form.value.aiAutoSubmitConfirmed, false);
    assert.equal(ui.form.value.aiListingConfigUpdatedAt, '2026-09-14T03:00:00Z');
    await ui.openAiPage();
    assert.deepEqual(ui.externalCalls, [['open-url', 'https://app.example/ozon/tools/ai-listing']]);
});

test('all custom filter fields are restored and hidden conditions are cleared by AI and default modes', () => {
    const ui = setup('Mg');
    const custom = { weightRangeMin: 10, weightRangeMax: 600, packageLengthMin: 20, packageLengthMax: 400, packageWidthMin: 30, packageWidthMax: 300, packageHeightMin: 40, packageHeightMax: 200, returnCancelRateMin: 0, returnCancelRateMax: 5, monthDynamicsMin: -50, monthDynamicsMax: 200, brandType: '1', salesSchema: 'FBS' };
    Object.assign(ui.form.value, { aiSelectType: 1, ...custom });
    ui.watches[0].callback(2, 1);
    for (const key of Object.keys(custom).filter(key => !['monthDynamicsMin', 'brandType', 'salesSchema'].includes(key))) assert.equal(ui.form.value[key], undefined, key);
    assert.equal(ui.form.value.monthDynamicsMin, 10);
    ui.watches[0].callback(1, 2);
    for (const [key, value] of Object.entries(custom)) assert.equal(ui.form.value[key], value, key);
    ui.watches[0].callback(0, 1);
    for (const key of Object.keys(custom).filter(key => !['brandType', 'salesSchema'].includes(key))) assert.equal(ui.form.value[key], undefined, key);
    ui.watches[0].callback(1, 0);
    for (const [key, value] of Object.entries(custom)) assert.equal(ui.form.value[key], value, key);
});

test('zero maximum remains an active filter bound while negative growth and unbounded ranges are valid', async () => {
    for (const [min, max, passes] of [[1, 0, false], [0, 0, true], [undefined, 0, true], [-80, 250, true], [50, undefined, true]]) {
        const ui = setup('Mg');
        Object.assign(ui.form.value, validTask, { aiSelectType: 1, monthDynamicsMin: min, monthDynamicsMax: max });
        await ui.submit('save');
        assert.equal(ui.calls.some(call => call.channel === 'collection-create'), passes, `${min} to ${max}`);
    }
});


test('automatic generation results show created tasks and partial failures without prompting another start', async () => {
    const ui = setup('Hg');
    await ui.mounted();
    ui.listeners.get('task-completed')({ taskName: '自动生成任务', aiListingResult: { code: 207, message: '已建立 1 个 AI 任务，1 个商品暂未建立任务', data: {
        aiGenerationRequested: true,
        aiTasks: [{ id: 'task-a', status: 'COLLECTING' }],
        aiTaskUrl: 'https://app.example/ozon/tools/ai-listing?tab=tasks',
        aiStartErrors: [{ collectItemId: 'item-b', message: '配置库存不足' }],
    } } });
    const modal = ui.batchModal();
    assert.equal(modal.props.open, true);
    assert.equal(modal.props.title, 'AI 生成任务');
    const text = JSON.stringify(modal.children);
    assert.match(text, /已建立 1 个 AI 任务/u);
    assert.match(text, /配置库存不足/u);
    assert.doesNotMatch(text, /确认配置并开始 AI 上架/u);
    await modal.children[1].children[0].props.onClick();
    assert.deepEqual(ui.externalCalls, [['open-url', 'https://app.example/ozon/tools/ai-listing?tab=tasks']]);
    assert.equal(ui.calls.some(call => call.channel === 'collection-send-to-ai-listing'), false);
});

test('created AI tasks and ordinary manual batch results retain their separate queued display', async () => {
    const ui = setup('Hg');
    await ui.mounted();
    const completed = ui.listeners.get('task-completed');
    completed({taskName:'自动生成',aiListingResult:{code:200,message:'已建立 1 个 AI 任务',data:{aiGenerationRequested:true,aiTasks:[{id:'a'}],aiTaskUrl:'https://app.example/ozon/tools/ai-listing?tab=tasks'}}});
    completed({taskName:'仅发送',aiListingResult:{code:200,data:{aiListingBatches:[{index:1,count:100,url:'https://app.example/1'},{index:2,count:10,url:'https://app.example/2'}]}}});
    assert.equal(ui.batchModal().props.title, 'AI 生成任务');
    ui.batchModal().props.onCancel();
    assert.equal(ui.batchModal().props.title, '分批发送至 AI 上架');
    assert.equal(ui.batchModal().children[1].children.length, 2);
});


test('saved custom presets include every filter but never task identity, targets or AI settings', async () => {
    const ui = setup('Mg', { filterPresetResponse: (channel, payload) => ({ code: 200, data: { items: [{ id: 'preset-1', name: payload.name, filters: payload.filters }], item: { id: 'preset-1' } } }) });
    ui.open();
    Object.assign(ui.form.value, { aiSelectType: 1, taskName: '不保存任务名', targetCount: 20, categoryIds: [['15500']], autoStartAiGeneration: true });
    for (const key of Object.keys(ui.filters.value)) ui.form.value[key] = key === 'brandType' ? '1' : key === 'salesSchema' ? 'FBS' : key.endsWith('Min') ? 0 : 50;
    ui.form.value.monthDynamicsMin = -25;
    ui.form.value.monthDynamicsMax = 250;
    ui.presetName.value = '轻小件';
    await ui.saveFilterPreset();
    const saved = ui.calls.find(call => call.channel === 'collection-filter-presets-save').payload;
    assert.equal(saved.name, '轻小件');
    assert.deepEqual(Object.keys(saved.filters).sort(), Object.keys(ui.filters.value).sort());
    for (const key of Object.keys(ui.filters.value)) assert.equal(saved.filters[key], ui.form.value[key], key);
    assert.equal(ui.notices.at(-1).type, 'success');
});

test('applying a preset clears unset bounds, preserves zeros and leaves task/AI configuration alone', async () => {
    const item = { id: 'one', name: '轻小件', filters: { soldCountMin: 0, monthDynamicsMin: -50, monthDynamicsMax: 200, brandType: '1', salesSchema: 'FBO,FBS' } };
    const ui = setup('Mg', { filterPresetResponse: () => ({ code: 200, data: { items: [item] } }) });
    ui.open(); await ui.loadFilterPresets();
    Object.assign(ui.form.value, { aiSelectType: 1, weightRangeMax: 400, ratingMin: 4, taskName: '我的任务', aiListingConfigId: 'original', autoSendToAiListing: true, targetUrl: 'https://www.ozon.ru/category/dom/' });
    ui.applyFilterPreset('one');
    assert.equal(ui.form.value.soldCountMin, 0);
    assert.equal(ui.form.value.monthDynamicsMin, -50);
    assert.equal(ui.form.value.weightRangeMax, undefined);
    assert.equal(ui.form.value.ratingMin, undefined);
    assert.equal(ui.form.value.brandType, '1');
    assert.equal(ui.form.value.aiListingConfigId, 'original');
    assert.equal(ui.form.value.autoSendToAiListing, true);
    assert.equal(ui.form.value.taskName, '我的任务');
    ui.watches[0].callback(2, 1); ui.watches[0].callback(1, 2);
    assert.equal(ui.form.value.soldCountMin, 0);
    assert.equal(ui.form.value.monthDynamicsMax, 200);
});

test('invalid ranges and duplicate names keep the preset editor open without changing existing presets', async () => {
    const ui = setup('Mg', { filterPresetResponse: channel => channel.endsWith('-list') ? { code: 200, data: { items: [] } } : { code: 409, message: '已有同名方案，请换一个名称' } });
    ui.open(); ui.form.value.aiSelectType = 1; ui.presetName.value = '重复';
    Object.assign(ui.form.value, { soldCountMin: 10, soldCountMax: 0 });
    await ui.saveFilterPreset();
    assert.equal(ui.calls.some(call => call.channel === 'collection-filter-presets-save'), false);
    assert.match(ui.presetError.value, /最小值/);
    ui.form.value.soldCountMax = 20;
    await ui.saveFilterPreset();
    assert.match(ui.presetError.value, /同名/);
    assert.equal(ui.presetName.value, '重复');
    assert.equal(ui.presetSaving.value, false);
});

test('closed dialogs ignore stale preset lists and saving responses', async () => {
    let finish;
    const ui = setup('Mg', { filterPresetResponse: () => new Promise(resolve => { finish = resolve; }) });
    ui.open(); const pending = ui.loadFilterPresets(); ui.close();
    finish({ code: 200, data: { items: [{ id: 'old', name: '上次账号', filters: {} }] } });
    await pending;
    assert.deepEqual(plain(ui.filterPresets.value), []);
    assert.equal(ui.presetSaving.value, false);
});

test('editing a saved selection preset updates its ID and returns to new-save mode afterwards', async () => {
    const item = { id: 'existing', name: '旧方案', filters: { soldCountMin: 5, ratingMin: 4, brandType: '1' } };
    const ui = setup('Mg', { filterPresetResponse: (channel, payload) => channel.endsWith('-update')
        ? { code: 200, data: { item: { ...item, ...payload }, items: [{ ...item, ...payload }] } }
        : { code: 200, data: { items: [item] } } });
    ui.open(); await settle();
    Object.assign(ui.form.value, { taskName: '当前任务', aiListingConfigId: 'original', autoSendToAiListing: true });
    ui.editFilterPreset(item.id);
    assert.equal(ui.form.value.aiSelectType, 1);
    assert.equal(ui.presetName.value, '旧方案');
    ui.presetName.value = '修改方案';
    Object.assign(ui.form.value, { soldCountMin: 0, monthDynamicsMin: -20, ratingMin: undefined });
    await ui.saveFilterPreset();
    const update = ui.calls.find(call => call.channel === 'collection-filter-presets-update').payload;
    assert.equal(update.id, 'existing');
    assert.equal(update.name, '修改方案');
    assert.equal(update.filters.soldCountMin, 0);
    assert.equal(update.filters.monthDynamicsMin, -20);
    assert.equal(update.filters.ratingMin, undefined);
    assert.equal(update.filters.taskName, undefined);
    assert.equal(ui.filterPresets.value.length, 1);
    assert.equal(ui.presetEditor.value, false);
    assert.equal(ui.form.value.taskName, '当前任务');
    assert.equal(ui.form.value.aiListingConfigId, 'original');
    ui.newFilterPreset();
    assert.equal(ui.presetEditingId.value, undefined);
    assert.equal(ui.presetName.value, '');
});

test('preset deletion requires its confirmation and preserves the applied task conditions', async () => {
    const item = { id: 'existing', name: '旧方案', filters: { soldCountMin: 0 } };
    const ui = setup('Mg', { filterPresetResponse: channel => ({ code: 200, data: { items: channel.endsWith('-delete') ? [] : [item] } }) });
    ui.open(); await settle(); ui.editFilterPreset(item.id);
    await ui.deleteFilterPreset(item.id);
    assert.equal(ui.calls.some(call => call.channel.endsWith('-delete')), false);
    ui.presetDeletingId.value = item.id;
    await ui.deleteFilterPreset(item.id);
    assert.deepEqual(plain(ui.calls.find(call => call.channel.endsWith('-delete')).payload), { id: item.id });
    assert.equal(ui.filterPresets.value.length, 0);
    assert.equal(ui.presetSelected.value, undefined);
    assert.equal(ui.presetEditingId.value, undefined);
    assert.equal(ui.presetEditor.value, false);
    assert.equal(ui.form.value.soldCountMin, 0);
});

test('failed preset writes keep visible rows and draft edits while closed dialogs ignore late deletes', async () => {
    const item = { id: 'existing', name: '旧方案', filters: { soldCountMin: 0 } };
    let finish;
    const ui = setup('Mg', { filterPresetResponse: channel => channel.endsWith('-list')
        ? { code: 200, data: { items: [item] } } : channel.endsWith('-update')
            ? { code: 400, message: '已有同名方案' } : new Promise(resolve => { finish = resolve; }) });
    ui.open(); await settle(); ui.editFilterPreset(item.id);
    ui.presetName.value = '重复名称'; await ui.saveFilterPreset();
    assert.equal(ui.presetName.value, '重复名称');
    assert.equal(ui.presetEditor.value, true);
    assert.deepEqual(plain(ui.filterPresets.value), [item]);
    assert.match(ui.presetError.value, /同名/);
    ui.cancelPresetEdit();
    assert.equal(ui.presetEditor.value, false);
    ui.presetDeletingId.value = item.id;
    const deleting = ui.deleteFilterPreset(item.id);
    assert.equal(ui.presetSaving.value, true);
    await ui.deleteFilterPreset(item.id);
    assert.equal(ui.calls.filter(call => call.channel.endsWith('-delete')).length, 1);
    ui.close(); finish({ code: 200, data: { items: [item] } }); await deleting;
    assert.equal(ui.filterPresets.value.length, 0);
    assert.equal(ui.presetDeletingId.value, undefined);
});
