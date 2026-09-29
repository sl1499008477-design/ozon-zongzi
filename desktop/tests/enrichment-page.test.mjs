import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../dist/assets/enrichment-page.js', import.meta.url), 'utf8');
const settle = () => new Promise(resolve => setImmediate(resolve));
const tasks = () => ['a', 'b'].map((id, i) => ({ key: `run:${id}`, name: '照明类目', taskId: `task-${id}`, runId: id,
    createdAt: `2026-09-16T1${i}:00:00Z`, controlState: 'ACTIVE', total: 3, pending: 2, processing: 0, completed: 1, failed: 0, currentSkus: [], errorMessage: '' }));
function fixture() {
    const calls = [], events = new Map(); let response = { code: 200, data: tasks() };
    const api = { on: (name, fn) => events.set(name, fn), off: name => events.delete(name),
        async invoke(channel, input) {
            calls.push({ channel, input: input ? JSON.parse(JSON.stringify(input)) : input });
            if (channel === 'enrichment-tasks') return typeof response === 'function' ? response() : structuredClone(response);
            if (channel === 'enrichment-task-control') return { code: 200, data: { ...tasks().find(task => task.key === input.taskKey),
                controlState: { pause: 'PAUSED', resume: 'ACTIVE', cancel: 'CANCELLED' }[input.action] } };
            return { phase: 'idle', message: '', completed: 0 };
        } };
    const context = { window: { electronAPI: api, setInterval: () => 1, clearInterval() {} },
        h: (tag, props, children) => ({ tag, props: props || {}, children }), console };
    vm.runInNewContext(source.replace(/^import[^\n]+\n/, '').replace('export default', 'globalThis.component ='), context);
    const component = context.component, state = component.data();
    for (const [name, fn] of Object.entries(component.methods)) state[name] = fn.bind(state);
    component.mounted.call(state);
    return { state, calls, events, render: () => component.render.call(state), dispose: () => component.beforeUnmount.call(state),
        respond: value => { response = value; } };
}
function all(node, predicate) {
    if (Array.isArray(node)) return node.flatMap(child => all(child, predicate));
    if (!node || typeof node !== 'object') return [];
    return [...(predicate(node) ? [node] : []), ...all(node.children, predicate)];
}
function text(node) { return Array.isArray(node) ? node.map(text).join(' ') : node && typeof node === 'object' ? text(node.children) : String(node ?? ''); }
const row = (ui, key) => all(ui.render(), node => node.props['data-task-key'] === key)[0];
const button = (node, label) => all(node, child => child.tag === 'button' && text(child) === label)[0];

test('same-named collection batches remain separate and pause targets the chosen run only', async t => {
    const ui = fixture(); t.after(ui.dispose); await settle();
    assert.equal(all(ui.render(), node => node.props['data-task-key']).length, 2);
    assert.notEqual(text(row(ui, 'run:a')), text(row(ui, 'run:b')));
    await button(row(ui, 'run:a'), '暂停').props.onClick();
    assert.deepEqual(ui.calls.filter(call => call.channel === 'enrichment-task-control').map(call => call.input), [{ taskKey: 'run:a', action: 'pause' }]);
    assert.match(text(row(ui, 'run:a')), /已暂停/u);
    assert.ok(button(row(ui, 'run:a'), '恢复'));
    assert.ok(button(row(ui, 'run:b'), '暂停'));
});

test('cancel requires a named-task confirmation and preserves other task rows', async t => {
    const ui = fixture(); t.after(ui.dispose); await settle();
    button(row(ui, 'run:b'), '取消补全').props.onClick();
    assert.equal(ui.calls.some(call => call.channel === 'enrichment-task-control'), false);
    const dialog = all(ui.render(), node => node.props.role === 'alertdialog')[0];
    assert.match(text(dialog), /照明类目/u);
    assert.match(text(dialog), /保留/u);
    await button(dialog, '确认取消').props.onClick();
    assert.deepEqual(ui.calls.filter(call => call.channel === 'enrichment-task-control').map(call => call.input), [{ taskKey: 'run:b', action: 'cancel' }]);
    assert.match(text(row(ui, 'run:b')), /已取消/u);
    assert.ok(button(row(ui, 'run:a'), '暂停'));
});

test('list refresh failures keep visible tasks and explain the failure instead of showing an empty queue', async t => {
    const ui = fixture(); t.after(ui.dispose); await settle();
    ui.respond({ code: 503, message: 'HTTP 503', data: null }); await ui.state.refresh();
    assert.equal(ui.state.tasks.length, 2);
    assert.match(text(ui.render()), /读取失败.*503/u);
});

test('a stale refresh cannot undo an acknowledged pause', async t => {
    const ui = fixture(); t.after(ui.dispose); await settle();
    let complete; ui.respond(() => new Promise(resolve => { complete = resolve; }));
    const refresh = ui.state.refresh();
    await button(row(ui, 'run:a'), '暂停').props.onClick();
    complete({ code: 200, data: tasks() }); await refresh;
    assert.equal(ui.state.tasks[0].controlState, 'PAUSED');
});

test('leaving the tab unsubscribes and discards late account-specific task responses', async () => {
    const ui = fixture(); await settle(); let complete;
    ui.respond(() => new Promise(resolve => { complete = resolve; }));
    const refresh = ui.state.refresh(); ui.dispose();
    complete({ code: 200, data: [] }); await refresh;
    assert.equal(ui.state.tasks.length, 2);
    assert.equal(ui.events.size, 0);
});
