import {getPostgresPool,postgresEnabled} from './db/connection.mjs';
import {runMigrations} from './db/migrate.mjs';
import {assertPermission,PERMISSIONS} from './permissions.mjs';
import {createOrderManagementService} from './order-management-service.mjs';
import {createOrderInspectionService} from './order-inspection-service.mjs';

export function createOrderInspectionRuntime({authenticate,readJson,sendJson,resolveService,resolvePool=getPostgresPool,pollIntervalMs=2000}={}){
  let initialization,running=false,timer,active;
  async function service(){
    if(!initialization){initialization=(async()=>{if(resolveService)return resolveService();const pool=await resolvePool();await runMigrations(pool);
      return createOrderInspectionService({pool,orderService:createOrderManagementService({pool})});})();initialization.catch(()=>{initialization=null;});}
    return initialization;
  }
  async function handleRoute(req,res,url){
    const path=url.pathname.startsWith('/api/')?url.pathname.slice(4):url.pathname;
    if(!path.startsWith('/ozon/order-inspection/'))return false;
    try{
      const account=await authenticate(req);assertPermission(account,PERMISSIONS.TENANT_OPERATE);
      const scope={accountId:account.id},s=await service(),route=path.slice('/ozon/order-inspection/'.length);
      const read=()=>readJson(req,{maxBytes:64*1024,requireBody:true});let result;
      if(req.method==='GET'&&route==='settings')result=await s.settings(scope);
      else if(req.method==='PUT'&&route==='settings')result=await s.saveSettings(scope,await read());
      else if(req.method==='GET'&&route==='overview')result=await s.overview(scope,Object.fromEntries(url.searchParams));
      else if(req.method==='GET'&&route==='summary')result=await s.summary(scope);
      else if(req.method==='POST'&&route==='read')result=await s.markRead(scope,await read());
      else if(req.method==='POST'&&route==='sync'){await read();result=await s.requestSync(scope);}
      else throw Object.assign(Error('质检单接口不存在'),{status:404,code:'ORDER_INSPECTION_NOT_FOUND'});
      sendJson(res,200,result);
    }catch(e){const candidate=Number(e.status||e.statusCode),status=candidate>=400&&candidate<=599?candidate:500;
      sendJson(res,status,{ok:false,code:e.code||'ORDER_INSPECTION_REQUEST_FAILED',message:status>=500?'质检单服务暂不可用':e.message});}
    return true;
  }
  function schedule(){if(!running)return;timer=setTimeout(()=>{
    active=(async()=>{try{await(await service()).processNext();}catch{console.error('[order-inspection] check deferred; see store sync status');}})();
    active.finally(()=>{active=null;schedule();});
  },pollIntervalMs);timer.unref?.();}
  async function start(){if(running||(!resolveService&&!postgresEnabled()))return;await service();running=true;schedule();}
  async function stop(){running=false;clearTimeout(timer);if(active)await active;}
  return {handleRoute,start,stop};
}
