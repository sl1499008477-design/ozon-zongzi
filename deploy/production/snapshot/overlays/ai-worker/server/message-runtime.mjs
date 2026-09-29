import { getPostgresPool, postgresEnabled } from './db/connection.mjs';
import { runMigrations } from './db/migrate.mjs';
import { createMessageService } from './message-service.mjs';
import { assertPermission, PERMISSIONS } from './permissions.mjs';

export function createMessageRuntime({authenticate,readJson,sendJson,resolveService,resolvePool=getPostgresPool} = {}) {
  let initialization;let running=false;
  const lanes=[{method:'processNext',delay:2000},{method:'syncNext',delay:5000},{method:'prepareChatNext',delay:15000}].map(lane=>({...lane,timer:null,active:null}));
  async function service() {
    if(!initialization) {
      initialization=(async()=>{
        if(resolveService)return resolveService();
        const pool=await resolvePool();await runMigrations(pool);return createMessageService({pool});
      })();
      initialization.catch(()=>{initialization=null;});
    }
    return initialization;
  }
  async function handleRoute(req,res,url) {
    const pathname=url.pathname.startsWith('/api/')?url.pathname.slice(4):url.pathname;
    if(!pathname.startsWith('/ozon/messages/'))return false;
    const route=pathname.slice('/ozon/messages/'.length);const webhook=route.match(/^webhook\/([^/]+)\/([^/]+)$/);
    try {
      if(webhook&&req.method==='POST') {
        const body=await readJson(req,{maxBytes:128*1024,requireBody:true});
        sendJson(res,200,await(await service()).webhook(decodeURIComponent(webhook[1]),decodeURIComponent(webhook[2]),body));
        return true;
      }
      const account=await authenticate(req);assertPermission(account,PERMISSIONS.TENANT_OPERATE);
      const scope={accountId:account.id,storeId:url.searchParams.get('storeId') || ''};
      const messages=await service();let result;
      const read=()=>readJson(req,{maxBytes:32*1024,requireBody:true});
      if(req.method==='GET'&&route==='overview')result=await messages.overview(scope);
      else if(req.method==='GET'&&route==='postings')result=await messages.postings(scope,{q:url.searchParams.get('q') || '',trigger:url.searchParams.get('trigger') || ''});
      else if(req.method==='GET'&&route==='records')result=await messages.records(scope,{status:url.searchParams.get('status') || '',trigger:url.searchParams.get('trigger') || ''});
      else if(req.method==='PUT'&&route==='settings')result=await messages.saveSettings(scope,await read());
      else if(req.method==='POST'&&route==='sync')result=await messages.requestSync(scope);
      else if(req.method==='POST'&&route==='templates')result=await messages.saveTemplate(scope,await read());
      else if(req.method==='POST'&&route==='preview')result=await messages.preview(scope,await read());
      else if(req.method==='PUT'&&/^templates\/[^/]+$/.test(route))result=await messages.saveTemplate(scope,await read(),decodeURIComponent(route.split('/')[1]));
      else if(req.method==='DELETE'&&/^templates\/[^/]+$/.test(route))result=await messages.deleteTemplate(scope,decodeURIComponent(route.split('/')[1]));
      else if(req.method==='POST'&&/^records\/[^/]+\/reconcile$/.test(route))result=await messages.reconcile(scope,decodeURIComponent(route.split('/')[1]));
      else {sendJson(res,404,{ok:false,code:'MESSAGE_NOT_FOUND',message:'消息接口不存在'});return true;}
      sendJson(res,200,result);
    } catch(e) {
      const status=Number(e?.status || e?.statusCode || 500);
      const message=status>=500?'消息服务暂时不可用，请稍后重试':e?.message || '消息请求失败';
      if(webhook)sendJson(res,status,{error:{code:'ERROR_UNKNOWN',message,details:null}});
      else sendJson(res,status,{ok:false,code:e?.code || 'MESSAGE_REQUEST_FAILED',message});
    }
    return true;
  }
  function schedule(lane) {
    if(!running)return;
    lane.timer=setTimeout(()=>{
      lane.active=(async()=>{try {await(await service())[lane.method]();}catch {console.error('[messages] background operation deferred; check message settings');}})();
      lane.active.finally(()=>{lane.active=null;schedule(lane);});
    },lane.delay);
    lane.timer.unref?.();
  }
  async function start() {
    if(running||(!resolveService&&!postgresEnabled()))return;
    await service();running=true;lanes.forEach(schedule);
  }
  async function stop() {
    running=false;for(const lane of lanes)clearTimeout(lane.timer);
    await Promise.allSettled(lanes.map(lane=>lane.active).filter(Boolean));
  }
  return {handleRoute,start,stop};
}
