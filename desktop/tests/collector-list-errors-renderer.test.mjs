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
    if (node.type !== 'CallExpression') return;
    if (node.callee.name === 'r' && node.arguments[0]?.name === 'ye') expressions.table = node.arguments[1];
    if (node.callee.name === 've' && node.arguments[1]?.properties?.some(p => p.key.name === 'class' && p.value.value === 'desktop-task-list-feedback')) expressions.feedback = node;
    if (node.callee.name === 'r' && node.arguments[0]?.name === 'ie' && source.slice(node.start, node.end).includes('$e("查询"')) expressions.query = node;
});
const settle = () => new Promise(resolve => setImmediate(resolve));
const plain = value => value === undefined ? value : JSON.parse(JSON.stringify(value));
function setup(respond) {
    const calls = [], lifecycle = {};
    const vnode = (type, props, children) => ({ type, props, children: typeof children?.default === 'function' ? children.default() : children });
    const context = vm.createContext({
        e: {}, ge: value => ({ value }), _: value => value && Object.hasOwn(value, 'value') ? value.value : value,
        Ws: () => ({ fullPath: '/collection' }), St: value => value, setTimeout: () => 1, it: async () => {},
        qe: callback => { lifecycle.mount = callback; }, hn: callback => { lifecycle.unmount = callback; },
        r: vnode, ve: vnode, ie: 'Button', D: callback => callback, $e: String,
        Le: { error() {}, success() {}, warning() {} },
        window: { electronAPI: {
            async invoke(channel, payload) {
                calls.push({ channel, payload: structuredClone(payload) });
                if (channel === 'collection-get-all-tasks') return respond(payload);
                return { code: 200, data: [] };
            }, on() {}, off() {},
        } },
    });
    const helper = declarations.find(node => node.id.name === 'desktopCollectionTaskData');
    const renders = Object.entries(expressions).map(([key, node]) => `${key}:()=>{const z=[];return (${source.slice(node.start, node.end)})}`).join(',');
    const lifecycleCalls = returned.argument.expressions.slice(0, -1).map(node => source.slice(node.start, node.end)).join(';');
    const state = vm.runInContext(`(() => {const ${source.slice(helper.start, helper.end)};${source.slice(body.start + 1, returned.start)};${lifecycleCalls};return {refresh:b,list:i,total:d,${renders}};})()`, context);
    return { ...state, calls, lifecycle };
}
function texts(node) {
    if (node == null) return '';
    if (typeof node === 'string' || typeof node === 'number') return String(node);
    if (Array.isArray(node)) return node.map(texts).join(' ');
    return texts(node.children);
}

test('a failed refresh preserves the last tasks and querying again recovers a real empty list without starting work', async () => {
    let response = { list: [{ _id: 'existing-task', taskName: '已有任务', taskStatus: 'completed' }], total: 21 };
    const ui = setup(() => response);
    await settle();
    response = { code: 500, message: 'Request failed with status code 502', data: null };
    await ui.refresh();
    assert.deepEqual(plain(ui.list.value), [{ _id: 'existing-task', taskName: '已有任务', taskStatus: 'completed' }]);
    assert.equal(ui.total.value, 21);
    assert.match(texts(ui.feedback?.()), /读取失败.*502/u);
    assert.match(texts(ui.feedback?.()), /查询/u);
    response = { list: [], total: 0 };
    await ui.query().props.onClick();
    assert.deepEqual(plain(ui.list.value), []);
    assert.equal(ui.total.value, 0);
    assert.equal(texts(ui.feedback?.()), '');
    assert.match(ui.table().locale?.emptyText || '', /暂无任务/u);
    assert.deepEqual(ui.calls.filter(call => call.channel.startsWith('collection-')).map(call => call.channel), [
        'collection-get-all-tasks', 'collection-get-all-tasks', 'collection-get-all-tasks',
    ]);
});

test('the first pending or failed read is visibly different from a successful empty list', async () => {
    let finish;
    const ui = setup(() => new Promise(resolve => { finish = resolve; }));
    assert.equal(ui.table().loading, true);
    assert.match(ui.table().locale?.emptyText || '', /读取/u);
    finish({ code: 503, message: '服务暂不可用', data: null });
    await settle();
    assert.equal(ui.table().loading, false);
    assert.match(ui.table().locale?.emptyText || '', /失败/u);
    assert.doesNotMatch(ui.table().locale?.emptyText || '', /暂无任务/u);
});

test('a rejected IPC read keeps the last tasks and clears its loading indicator', async () => {
    let unavailable = false;
    const ui = setup(() => {
        if (unavailable) throw new Error('IPC disconnected');
        return { list: [{ _id: 'kept' }], total: 1 };
    });
    await settle();
    unavailable = true;
    await assert.doesNotReject(ui.refresh());
    assert.equal(ui.list.value[0]._id, 'kept');
    assert.equal(ui.table().loading, false);
    assert.match(texts(ui.feedback?.()), /读取失败/u);
});

test('late list responses cannot replace a newer query or repopulate an unmounted account view', async () => {
    const pending = [];
    const ui = setup(() => new Promise(resolve => pending.push(resolve)));
    const newer = ui.refresh();
    pending[1]({ list: [{ _id: 'new-query' }], total: 1 });
    await newer;
    pending[0]({ list: [{ _id: 'old-query' }], total: 22 });
    await settle();
    assert.equal(ui.list.value[0]._id, 'new-query');
    const oldAccount = ui.refresh();
    ui.lifecycle.unmount();
    pending[2]({ list: [{ _id: 'old-account' }], total: 33 });
    await oldAccount;
    assert.equal(ui.list.value[0]._id, 'new-query');
});
