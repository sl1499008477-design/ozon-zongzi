import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createEnrichmentWorker } from '../dist-electron/services/enrichment-worker.core.js';

const identity = { accountId: 'account-a', parentToken: 'test-parent' };
const httpError = status => Object.assign(new Error(`Request failed with status code ${status}`), { status, code: 'ERR_BAD_RESPONSE' });
function idleWorker(post) {
    let sellerChecks = 0;
    const worker = createEnrichmentWorker({
        getIdentity: () => identity, openSession: async () => post,
        verifySeller: async () => { sellerChecks++; return { sellerCompanyId: '12345' }; },
        capture: async () => { throw new Error('Unexpected capture'); },
    });
    return { worker, get sellerChecks() { return sellerChecks; } };
}

test('a 502 before any job reports the service outage and a healthy empty poll clears that error', async () => {
    let offline = true;
    const calls = [];
    const f = idleWorker(async path => {
        calls.push(path);
        if (offline) throw httpError(502);
        return { available: false };
    });
    await f.worker.runOnce();
    assert.equal(f.worker.getStatus().errorKind, 'service');
    assert.match(f.worker.getStatus().message, /服务.*不可用.*502/u);
    assert.doesNotMatch(f.worker.getStatus().message, /Seller/u);
    offline = false;
    await f.worker.runOnce();
    assert.equal(f.worker.getStatus().phase, 'idle');
    assert.equal(f.worker.getStatus().errorKind, '');
    assert.equal(f.sellerChecks, 0);
    assert.equal(f.worker.getStatus().completed, 0);
    assert.ok(calls.every(path => path.endsWith('/available')));
});

test('assistant authorization failures direct users to assistant login or permissions rather than Seller', async () => {
    for (const status of [401, 403]) {
        const f = idleWorker(async () => { throw httpError(status); });
        await f.worker.runOnce();
        assert.equal(f.worker.getStatus().errorKind, 'auth');
        assert.match(f.worker.getStatus().message, status === 401 ? /重新登录.*助手|助手.*重新登录/u : /账号.*权限/u);
        assert.doesNotMatch(f.worker.getStatus().message, /Seller/u);
        assert.equal(f.sellerChecks, 0);
    }
});

test('a healthy available:false response clears a previous polling error without reporting a completed SKU', async () => {
    let offline = true;
    const f = idleWorker(async () => {
        if (offline) throw httpError(502);
        return { available: false };
    });
    await f.worker.runOnce();
    assert.equal(f.worker.getStatus().phase, 'error');
    offline = false;
    await f.worker.runOnce();
    assert.equal(f.worker.getStatus().phase, 'idle');
    assert.equal(f.worker.getStatus().completed, 0);
    assert.equal(f.worker.getStatus().sku, '');
});

test('an empty claim after another client takes the job clears a prior polling error without capturing or failing a SKU', async () => {
    let offline = true;
    const calls = [];
    const f = idleWorker(async path => {
        calls.push(path.split('/').at(-1));
        if (offline) throw httpError(502);
        if (path.endsWith('/available')) return { available: true };
        if (path.endsWith('/next')) return { job: null };
        throw new Error(`Unexpected request ${path}`);
    });
    await f.worker.runOnce();
    assert.equal(f.worker.getStatus().phase, 'error');
    offline = false;
    await f.worker.runOnce();
    assert.equal(f.worker.getStatus().phase, 'idle');
    assert.equal(f.worker.getStatus().errorKind, '');
    assert.equal(f.worker.getStatus().sku, '');
    assert.equal(f.worker.getStatus().completed, 0);
    assert.deepEqual(calls, ['available', 'available', 'next']);
});

test('a runtime-wrapped 502 from availability is a service outage even with an enrichment error code', async () => {
    const f = idleWorker(async path => {
        assert.ok(path.endsWith('/available'));
        throw Object.assign(httpError(502), { code: 'ZONGZI_ENRICH_UPSTREAM_FAILED' });
    });
    await f.worker.runOnce();
    assert.equal(f.worker.getStatus().errorKind, 'service');
    assert.match(f.worker.getStatus().message, /服务.*不可用.*502/u);
    assert.equal(f.worker.getStatus().sku, '');
    assert.equal(f.sellerChecks, 0);
});

test('a claimed SKU upstream failure remains specific after a later available-but-empty claim', async () => {
    let failed = false;
    const worker = createEnrichmentWorker({
        getIdentity: () => identity,
        openSession: async () => async path => {
            if (path.endsWith('/available')) return { available: true };
            if (path.endsWith('/next')) return { job: failed ? null : { id: 'job', sku: '3556540370', claimFence: 'fence' } };
            if (path.endsWith('/fail')) { failed = true; return { ok: true }; }
            throw new Error(`Unexpected request ${path}`);
        },
        verifySeller: async () => ({ sellerCompanyId: '12345' }),
        capture: async () => { throw Object.assign(new Error('SKU 3556540370 的 Seller 商品资料读取失败（HTTP 502）'), { code: 'ZONGZI_ENRICH_UPSTREAM_FAILED', status: 502 }); },
    });
    await worker.runOnce();
    await worker.runOnce();
    assert.equal(worker.getStatus().phase, 'error');
    assert.equal(worker.getStatus().errorKind, 'product');
    assert.equal(worker.getStatus().sku, '3556540370');
    assert.match(worker.getStatus().message, /3556540370.*Seller.*502/u);
});

test('transport loss before any job is actionable without claiming a Seller or SKU failure', async () => {
    const f = idleWorker(async () => { throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET', status: 0 }); });
    await f.worker.runOnce();
    assert.equal(f.worker.getStatus().errorKind, 'service');
    assert.match(f.worker.getStatus().message, /网络|连接/u);
    assert.equal(f.worker.getStatus().sku, '');
});

test('real SKU failures retain their explanation when a later queue poll is empty', async () => {
    let failed = false;
    const worker = createEnrichmentWorker({
        getIdentity: () => identity,
        openSession: async () => async path => {
            if (path.endsWith('/available')) return { available: !failed };
            if (path.endsWith('/next')) return { job: { id: 'job', sku: '3556540370', claimFence: 'fence' } };
            if (path.endsWith('/fail')) { failed = true; return { ok: true }; }
            throw new Error(`Unexpected request ${path}`);
        },
        verifySeller: async () => ({ sellerCompanyId: '12345' }),
        capture: async () => { throw Object.assign(new Error('SKU 3556540370 商品包结果未知，已停止重复创建'), { code: 'ZONGZI_ENRICH_BUNDLE_UNCERTAIN' }); },
    });
    await worker.runOnce();
    assert.equal(worker.getStatus().phase, 'error');
    await worker.runOnce();
    assert.equal(worker.getStatus().phase, 'error');
    assert.equal(worker.getStatus().sku, '3556540370');
    assert.match(worker.getStatus().message, /3556540370.*结果未知.*停止重复创建/u);
});

// Only the DOM/IPC boundaries are substitutes: the shipped status script builds
// the elements, chooses their visibility/text and registers the real handlers.
function panelUi(invoke = async () => ({ phase: 'idle', message: '服务已恢复', completed: 0 })) {
    const elements = [], listeners = new Map(), calls = [];
    function element(tag) {
        const node = { tag, dataset: {}, children: [], hidden: false, textContent: '', handlers: {},
            setAttribute() {}, append(...items) { this.children.push(...items); },
            addEventListener(name, callback) { this.handlers[name] = callback; },
        };
        elements.push(node); return node;
    }
    const document = { createElement: element, body: element('body') };
    const api = { on: (name, callback) => listeners.set(name, callback), async invoke(channel) { calls.push(channel); return invoke(channel); } };
    vm.runInNewContext(readFileSync(new URL('../dist/assets/enrichment-status.js', import.meta.url), 'utf8'), { window: { electronAPI: api }, document });
    return { panel: elements.find(node => node.tag === 'details'), summary: elements.find(node => node.tag === 'summary'),
        message: elements.find(node => node.tag === 'p'), note: elements.find(node => node.tag === 'small'),
        buttons: elements.filter(node => node.tag === 'button'), render: listeners.get('enrichment-status'), calls };
}

test('service and assistant auth notices never suggest opening Seller, while Seller login keeps that action', async () => {
    const ui = panelUi();
    await new Promise(resolve => setImmediate(resolve));
    ui.render({ phase: 'error', errorKind: 'service', message: '补全服务暂不可用（HTTP 502）' });
    assert.equal(ui.summary.textContent, '自动补全：异常');assert.match(ui.message.textContent,/服务.*不可用/u);
    assert.equal(ui.buttons[0].hidden, true);
    assert.match(ui.buttons[1].textContent, /重新检查/u);
    await ui.buttons[1].handlers.click();
    assert.equal(ui.calls.at(-1), 'enrichment-resume');
    assert.equal(ui.panel.dataset.phase, 'idle');
    ui.render({ phase: 'error', errorKind: 'auth', message: '请重新登录采集助手' });
    assert.equal(ui.buttons[0].hidden, true);
    assert.equal(ui.summary.textContent, '自动补全：异常');assert.match(ui.message.textContent,/助手.*登录|登录.*助手/u);
    ui.render({ phase: 'needs_login', errorKind: 'seller', message: '需要登录 Seller' });
    assert.equal(ui.buttons[0].hidden, false);
    assert.equal(ui.buttons[1].textContent, '继续补全');
    assert.equal(ui.summary.textContent, '自动补全：异常');assert.match(ui.message.textContent,/Seller/u);
    ui.render({ phase: 'signed_out', message: '' });
    assert.equal(ui.panel.hidden, true);
});


test('compact status uses confirmed work counts while active and paused details remain available', async () => {
    const ui=panelUi();await new Promise(resolve=>setImmediate(resolve));
    assert.equal(ui.summary.textContent,'自动补全：已就绪');
    ui.render({phase:'working',completed:0,sku:'100',message:'正在补全 SKU 100 的类目、包装和属性'});
    assert.equal(ui.summary.textContent,'自动补全：已就绪');assert.match(ui.message.textContent,/正在补全 SKU 100/);
    ui.render({phase:'working',completed:3,sku:'101',message:'正在补全 SKU 101 的类目、包装和属性'});
    assert.equal(ui.summary.textContent,'自动补全：已处理 3 件');assert.match(ui.message.textContent,/SKU 101/);
    ui.render({phase:'idle',completed:3,message:'该批次已暂停，其他任务继续处理'});
    assert.equal(ui.summary.textContent,'自动补全：已处理 3 件');assert.match(ui.message.textContent,/暂停/);
    assert.match(ui.note.textContent,/本次登录期间.*同一商品在不同任务中分别计数/);
});

test('an abnormal status opens its specific cause and a healthy snapshot removes the old cause', async () => {
    const ui=panelUi();await new Promise(resolve=>setImmediate(resolve));
    ui.render({phase:'error',completed:2,errorKind:'service',message:'资料补全服务暂不可用',errorDetail:'socket hang up；错误代码：ECONNRESET'});
    assert.equal(ui.summary.textContent,'自动补全：异常');assert.equal(ui.panel.open,true);
    assert.match(ui.message.textContent,/socket hang up.*ECONNRESET/s);
    ui.render({phase:'idle',completed:2,message:'服务连接正常'});
    assert.equal(ui.summary.textContent,'自动补全：已处理 2 件');assert.equal(ui.message.textContent,'服务连接正常');
    ui.render({phase:'signed_out',completed:0,message:''});assert.equal(ui.panel.hidden,true);
});

test('a delayed initial error snapshot cannot replace the newer healthy worker event', async () => {
    let reply;const ui=panelUi(()=>new Promise(resolve=>reply=resolve));
    ui.render({phase:'idle',completed:1,message:'已补全 1 个 SKU'});
    reply({phase:'error',completed:0,message:'已经恢复的旧网络错误'});await new Promise(resolve=>setImmediate(resolve));
    assert.equal(ui.summary.textContent,'自动补全：已处理 1 件');assert.doesNotMatch(ui.message.textContent,/旧网络错误/);
});

test('a delayed resume reply cannot replace a newer completion or signed-out event', async () => {
    let reply;
    const ui = panelUi(channel => channel === 'enrichment-resume' ? new Promise(resolve => reply = resolve)
        : Promise.resolve({ phase: 'idle', completed: 0, message: '已就绪' }));
    await new Promise(resolve => setImmediate(resolve));
    ui.render({ phase: 'error', completed: 0, message: '旧连接错误' });
    const request = ui.buttons[1].handlers.click();
    ui.render({ phase: 'signed_out', completed: 0, message: '' });
    reply({ phase: 'error', completed: 0, message: '旧连接错误' });
    await request;
    assert.equal(ui.panel.hidden, true);
    assert.equal(ui.message.textContent, '');
});

test('a delayed Seller login reply cannot replace the current recovered status', async () => {
    let reply;
    const ui = panelUi(channel => channel === 'seller-open-login' ? new Promise(resolve => reply = resolve)
        : Promise.resolve({ phase: 'idle', completed: 0, message: '已就绪' }));
    await new Promise(resolve => setImmediate(resolve));
    ui.render({ phase: 'needs_login', completed: 0, message: '需要登录 Seller' });
    const request = ui.buttons[0].handlers.click();
    ui.render({ phase: 'idle', completed: 1, message: '已补全 1 个 SKU' });
    reply({ code: 500, message: '旧线路窗口未打开' });
    await request;
    assert.equal(ui.summary.textContent, '自动补全：已处理 1 件');
    assert.equal(ui.message.textContent, '已补全 1 个 SKU');
});

test('current worker errors carry the exact message and code without serializing credentials, then clear when recovered', async () => {
    let error=Object.assign(new Error('读取补全队列时连接断开'),{code:'ECONNRESET',config:{headers:{Authorization:'Bearer secret-token',Cookie:'secret-cookie'}}});
    const f=idleWorker(async()=>{if(error)throw error;return{available:false}});
    await f.worker.runOnce();const status=f.worker.getStatus();
    assert.match(status.errorDetail,/读取补全队列时连接断开/);assert.match(status.errorDetail,/ECONNRESET/);
    assert.doesNotMatch(JSON.stringify(status),/secret-token|secret-cookie|Authorization/);
    error=null;await f.worker.runOnce();assert.equal(f.worker.getStatus().errorDetail,'');
});

test('unknown current failures remain specific instead of only saying that enrichment did not finish', async () => {
    const f=idleWorker(async()=>{throw Object.assign(new Error('队列租约响应缺少任务 ID'),{code:'RESPONSE_INVALID',status:502})});
    await f.worker.runOnce();assert.match(f.worker.getStatus().errorDetail,/队列租约响应缺少任务 ID/);
    assert.match(f.worker.getStatus().errorDetail,/RESPONSE_INVALID/);assert.match(f.worker.getStatus().errorDetail,/502/);
});

test('the worker-to-panel count waits for result acknowledgement, counts separate jobs and resets across accounts', async () => {
    const ui = panelUi();
    await new Promise(resolve => setImmediate(resolve));
    let currentIdentity = identity, jobNumber = 0, acknowledge;
    const worker = createEnrichmentWorker({
        getIdentity: () => currentIdentity,
        openSession: async () => async path => {
            if (path.endsWith('/available')) return { available: currentIdentity === identity };
            if (path.endsWith('/next')) return { job: { id: `job-${++jobNumber}`, taskKey: `task-${jobNumber}`, sku: '100', claimFence: 'fence' } };
            if (path.endsWith('/result')) return new Promise(resolve => acknowledge = resolve);
            throw new Error(`Unexpected request ${path}`);
        },
        verifySeller: async () => ({ sellerCompanyId: '12345' }), capture: async () => ({ sku: '100' }),
        notify: ui.render,
    });
    for (let count = 1; count <= 2; count++) {
        const active = worker.runOnce();
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(ui.summary.textContent, count === 1 ? '自动补全：已就绪' : '自动补全：已处理 1 件');
        acknowledge({ ok: true });
        await active;
        assert.equal(ui.summary.textContent, `自动补全：已处理 ${count} 件`);
    }
    currentIdentity = { accountId: 'account-b', parentToken: 'other-parent' };
    await worker.runOnce();
    assert.equal(ui.summary.textContent, '自动补全：已就绪');
    await worker.stop();
    assert.equal(ui.panel.hidden, true);
});
