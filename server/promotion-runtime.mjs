import {getPostgresPool,postgresEnabled} from './db/connection.mjs';
import {runMigrations} from './db/migrate.mjs';
import {assertPermission,PERMISSIONS} from './permissions.mjs';
import {createPromotionService} from './promotion-service.mjs';

export function createPromotionRuntime({authenticate,readJson,sendJson,resolveService,resolvePool=getPostgresPool}={}) {
  let initialization,running=false;
  const lanes=[{method:'pollNext',delay:5000},{method:'processNext',delay:2000}];
  async function service(){
    if(!initialization){initialization=(async()=>{if(resolveService)return resolveService();const pool=await resolvePool();await runMigrations(pool);return createPromotionService({pool});})();initialization.catch(()=>{initialization=null;});}
    return initialization;
  }
  async function handleRoute(req,res,url){
    const pathname=url.pathname.startsWith('/api/')?url.pathname.slice(4):url.pathname;
    if(!pathname.startsWith('/ozon/promotions/'))return false;
    const route=pathname.slice('/ozon/promotions/'.length);
    try{
      const account=await authenticate(req);assertPermission(account,PERMISSIONS.TENANT_OPERATE);
      const scope={accountId:account.id,storeId:url.searchParams.get('storeId')||''},s=await service();let result;
      const read=()=>readJson(req,{maxBytes:256*1024,requireBody:true});
      const rule=route.match(/^rules\/([^/]+)$/),run=route.match(/^runs\/([^/]+)\/(execute|reconcile)$/);
      if(req.method==='GET'&&route==='overview')result=await s.overview(scope);
      else if(req.method==='POST'&&route==='sync')result=await s.requestSync(scope);
      else if(req.method==='PUT'&&route==='settings')result=await s.saveSettings(scope,await read());
      else if(req.method==='POST'&&route==='rules')result=await s.saveRule(scope,await read());
      else if(req.method==='PUT'&&rule)result=await s.saveRule(scope,await read(),decodeURIComponent(rule[1]));
      else if(req.method==='DELETE'&&rule)result=await s.deleteRule(scope,decodeURIComponent(rule[1]));
      else if(req.method==='POST'&&route==='preview')result=await s.preview(scope,await read());
      else if(req.method==='POST'&&run)result=await s[run[2]](scope,decodeURIComponent(run[1]));
      else {sendJson(res,404,{ok:false,code:'PROMOTION_NOT_FOUND',message:'活动接口不存在'});return true;}
      sendJson(res,200,result);
    }catch(e){const status=Number(e.status||e.statusCode||500);sendJson(res,status,{ok:false,code:e.code||'PROMOTION_REQUEST_FAILED',message:status>=500?'活动服务暂时不可用，请查看同步状态后重试':e.message||'活动请求失败'});}
    return true;
  }
  function schedule(lane){if(!running)return;lane.timer=setTimeout(()=>{lane.active=(async()=>{try{await(await service())[lane.method]();}catch{console.error('[promotions] background operation deferred; check promotion sync status');}})();lane.active.finally(()=>{lane.active=null;schedule(lane);});},lane.delay);lane.timer.unref?.();}
  async function start(){if(running||(!resolveService&&!postgresEnabled()))return;await service();running=true;lanes.forEach(schedule);}
  async function stop(){running=false;for(const lane of lanes)clearTimeout(lane.timer);await Promise.allSettled(lanes.map(lane=>lane.active).filter(Boolean));}
  return {handleRoute,start,stop};
}
