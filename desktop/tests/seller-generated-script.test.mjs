import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { parse } from 'acorn';
import { withCollectorRequest } from '../dist-electron/services/collector-network.core.js';

const source = await readFile(new URL('../dist-electron/services/seller-ozon.services.js', import.meta.url), 'utf8');
// Execute the actual private generator without importing Electron or exposing a
// test-only production API. The captured renderer script is then compiled/run.
const start = source.indexOf('async function executeAnalyticsFetch(');
const end = source.indexOf('\nasync function fetchSellerAnalytics(', start);
assert.ok(start >= 0 && end > start);
const analyticsConstant = source.match(/^const ANALYTICS_PATH = .*;$/m)[0];
let routeOrigin = 'https://seller.ozon.ru';
const generate = vm.runInNewContext(`let activeSellerOperations = 0;
${analyticsConstant}\n${source.slice(start, end)}\nexecuteAnalyticsFetch;`, { getSellerRoute: () => ({ origin: routeOrigin }) });

async function execute({ text = '{"items":[{"Sku":4624804325}]}', contentType = 'application/json', status = 200, redirected = false, url = 'https://seller.ozon.ru/api/data', retryAfter = '', error, path, language, origin = 'https://seller.ozon.ru', pageOrigin = origin } = {}) {
    const body = { filter: { sku: '4624804325', query: 'quote" slash\\ backtick` ${value}' }, limit: '1' };
    routeOrigin = origin;
    let captured, invocation, cleared = 0;
    await generate({ webContents: { executeJavaScript(script, userGesture) { captured = script; assert.equal(userGesture, true); } } }, '2681910', body, path, language);
    const compiled = new vm.Script(captured, { filename: 'actual-seller-renderer-script.js' });
    const result = await compiled.runInNewContext({
        AbortController, location: { origin: pageOrigin },
        setTimeout: () => 1,
        clearTimeout: () => { cleared += 1; },
        fetch: async (path, options) => {
            invocation = { path, options };
            if (error) throw error;
            return { ok: status >= 200 && status < 300, status, redirected, url, text: async () => text, headers: { get: name => name === 'content-type' ? contentType : name === 'retry-after' ? retryAfter : null } };
        },
    });
    assert.equal(cleared, 1);
    return { result, invocation, body };
}

test('actual generated Seller script compiles and sends authenticated JSON with unchanged input', async () => {
    const { result, invocation, body } = await execute();
    assert.equal(result.ok, true);
    assert.equal(result.data.items[0].Sku, 4624804325);
    assert.equal(invocation.path, 'https://seller.ozon.ru/api/site/seller-analytics/what_to_sell/data/v3');
    assert.equal(invocation.options.credentials, 'include');
    assert.equal(invocation.options.headers['x-o3-company-id'], '2681910');
    assert.deepEqual(JSON.parse(invocation.options.body), body);
});

test('generated script rejects HTML login pages by MIME, whitespace doctype, and auth redirects', async () => {
    for (const response of [
        { text: '<html>Login</html>', contentType: 'TEXT/HTML; charset=utf-8' },
        { text: '\n\t  <!DOCTYPE html><html>Login</html>', contentType: 'text/plain' },
        { text: '{"message":"login"}', redirected: true, url: 'https://seller.ozon.ru/signin' },
    ]) {
        const { result } = await execute(response);
        assert.equal(result.ok, false);
        assert.equal(result.status, 401);
    }
});

test('generated script preserves HTTP retry information and distinguishes timeouts', async () => {
    const { result } = await execute({ status: 429, retryAfter: '3', text: '{"message":"rate limit"}' });
    assert.equal(result.status, 429);
    assert.equal(result.retryAfter, '3');
    const timedOut = await execute({ error: Object.assign(new Error('deadline'), { name: 'AbortError' }) });
    assert.equal(timedOut.result.code, 'TIMEOUT');
    assert.equal(timedOut.result.status, 0);
});


test('the generated category request uses the observed Seller tree endpoint', async () => {
    const { invocation } = await execute({ path: '/api/v1/seller-tree/get-by-company-id' });
    assert.equal(invocation.path, 'https://seller.ozon.ru/api/v1/seller-tree/get-by-company-id');
    assert.equal(invocation.options.credentials, 'include');
});

test('category API uses the verified Seller company in its body and rechecks context before returning', async () => {
    const definition = parse(source, { ecmaVersion: 'latest', sourceType: 'module' }).body
        .find(node => node.type === 'ExportNamedDeclaration' && node.declaration?.id?.name === 'fetchSellerCategoryTree');
    assert.ok(definition, 'the live category entry point must exist');
    const calls = [], checks = [], win = { show() {} };
    const actual = { accountId: 'account-a', sellerCompanyId: '2826323', sourceIdentity: 'seller-page:2826323' };
    const payload = { result: { '15621031': { descriptionCategoryId: '15621031' } } };
    const context = {
        withCollectorRequest, activeSellerOperations: 0,
        throwIfAborted() {}, abortable: promise => promise,
        verifyCurrentSellerStore: async expected => { checks.push(expected); return actual; },
        ensureSellerWindow: async () => win, requestGate: async () => {},
        executeAnalyticsFetch: async (...args) => { calls.push(args); return { ok: true, data: payload, status: 200 }; },
    };
    const read = vm.runInNewContext(source.slice(definition.declaration.start, definition.end) + '\nfetchSellerCategoryTree', context);
    const result = await read({ expectedContext: actual });
    assert.deepEqual(result, payload);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], win);
    assert.equal(calls[0][1], '2826323');
    assert.deepEqual(JSON.parse(JSON.stringify(calls[0][2])), { company_id: '2826323' });
    assert.equal(calls[0][3], '/api/v1/seller-tree/get-by-company-id');
    assert.deepEqual(checks, [actual, actual, actual]);
});


test('login HTML never becomes an error message and retains the actual HTTP status', async () => {
    const { result } = await execute({ status: 403, contentType: 'text/html', text: '<html>private-token=secret</html>' });
    assert.equal(result.ok, false);
    assert.equal(result.httpStatus, 403);
    assert.doesNotMatch(result.message || '', /private-token|secret|<html>/);
});


test('product captures request Russian while analytics keeps its existing Chinese display',async()=>{
 const product=await execute({path:'/api/v1/search',language:'ru'});
 assert.equal(product.invocation.options.headers['x-o3-language'],'ru');
 assert.equal((await execute()).invocation.options.headers['x-o3-language'],'zh-Hans');
});

test('product transport marks a preflight rejection unsent and keeps a confirmed draft for caching',async()=>{
 const node=parse(source,{ecmaVersion:'latest',sourceType:'module'}).body.find(n=>n.type==='ExportNamedDeclaration'&&n.declaration?.id?.name==='requestSellerProduct').declaration;
 let checks=0,fetches=0,deny=true;
 const context={throwIfAborted(){},verifyCurrentSellerStore:async()=>{checks++;if(deny)throw Object.assign(new Error('login'),{code:'SELLER_LOGIN_REQUIRED'});if(checks>2)throw new Error('changed after response');},ensureSellerWindow:async()=>({}),abortable:p=>p,requestGate:async()=>{},executeAnalyticsFetch:async(_win,_id,_body,_path,language)=>{fetches++;assert.equal(language,'ru');return {ok:true,data:{item:{origin_variant_id:'900'}}};}};
 const request=vm.runInNewContext(source.slice(node.start,node.end)+'\nrequestSellerProduct',{...context,withCollectorRequest,activeSellerOperations:0});
 await assert.rejects(request('/api/v1/search',{},{}),error=>error.requestSent===false);assert.equal(fetches,0);
 checks=0;deny=false;
 const result=await request('/api/site/seller-prototype/create-bundle-by-variant-id',{},{sellerCompanyId:'12345'});
 assert.equal(result.item.origin_variant_id,'900');assert.equal(fetches,1);assert.equal(checks,2);
});


test('renderer sends only to the selected Seller origin and refuses a late navigation before sending', async () => {
    const china = await execute({ origin: 'https://seller.ozonru.cn' });
    assert.equal(china.invocation.path, 'https://seller.ozonru.cn/api/site/seller-analytics/what_to_sell/data/v3');
    const redirected = await execute({ origin: 'https://seller.ozonru.cn', pageOrigin: 'https://seller.ozon.ru' });
    assert.equal(redirected.invocation, undefined);
    assert.equal(redirected.result.ok, false);
    assert.equal(redirected.result.requestSent, false);
});
