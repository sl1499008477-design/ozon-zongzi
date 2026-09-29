import { parseWebCollectionInput } from './ozon-web-collection.mjs';
import { sanitizeCollectorText } from './collector-auth-service.mjs';

export function createOzonWebCollectionHttpHandler({ service, authenticateWeb, authenticateCollector, readJson, sendJson }) {
  return async function handle(req, res, url) {
    const web = url.pathname.match(/^\/ozon\/collect-box\/web-jobs(?:\/([^/]+)\/(retry|cancel))?\/?$/);
    const collector = url.pathname.match(/^\/collector\/ozon\/web-jobs\/(next|([^/]+)\/(progress|result|fail))\/?$/);
    if (!web && !collector) return false;
    try {
      if (web) {
        const account = await authenticateWeb(req);
        if (req.method === 'GET' && !web[1]) {
          sendJson(res, 200, { ok: true, data: await service.list({ accountId: account.id, page: url.searchParams.get('page'), pageSize: url.searchParams.get('pageSize') }) });
          return true;
        }
        if (req.method !== 'POST') throw Object.assign(new Error('请求方法不支持'), { status: 405 });
        const body = await readJson(req);
        if (!web[1]) {
          const input = parseWebCollectionInput(body);
          sendJson(res, 202, { ok: true, data: await service.create({ accountId: account.id, ...input }) });
        } else {
          if (Object.keys(body || {}).length) throw Object.assign(new Error('任务范围由登录账号确定'), { status: 400 });
          sendJson(res, 200, { ok: true, data: await service[web[2]]({ accountId: account.id, id: decodeURIComponent(web[1]) }) });
        }
        return true;
      }
      const auth = await authenticateCollector(req, 'collector.upload');
      if (req.method !== 'POST') throw Object.assign(new Error('请求方法不支持'), { status: 405 });
      const actor = { accountId: auth.accountId || auth.account?.id, collectorSessionId: auth.collectorSessionId };
      const body = await readJson(req);
      const operation = collector[1] === 'next' ? 'next' : collector[3];
      const fields = { next: [], progress: ['claimFence','message'], result: ['claimFence','payload','capturedAt'], fail: ['claimFence','code','message','waiting'] }[operation];
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !fields.includes(key))) {
        throw Object.assign(new Error('采集任务请求字段无效'), { status: 400 });
      }
      if (operation !== 'next' && (typeof body.claimFence !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(body.claimFence))) {
        throw Object.assign(new Error('采集任务领取编号无效'), { status: 400 });
      }
      const data = operation === 'next' ? await service.claim(actor)
        : await service[operation === 'result' ? 'complete' : operation]({ ...actor, id: decodeURIComponent(collector[2]), ...body });
      sendJson(res, 200, { ok: true, data });
    } catch (failure) {
      const status = Number(failure.status) || 500;
      sendJson(res, status, { ok: false,
        code: /^[A-Z][A-Z0-9_]{0,100}$/.test(String(failure.code || '')) ? failure.code : 'WEB_COLLECTION_FAILED',
        message: status >= 500 ? '网页采集服务暂不可用，请稍后重试' : sanitizeCollectorText(failure.message, { max: 300 }),
      });
    }
    return true;
  };
}
