import {getPostgresPool,postgresEnabled} from './db/connection.mjs';
import {runMigrations} from './db/migrate.mjs';
import {assertPermission,PERMISSIONS} from './permissions.mjs';
import {createOrderManagementService} from './order-management-service.mjs';

export function createOrderManagementRuntime({authenticate,readJson,sendJson,resolveService,resolvePool=getPostgresPool,pollIntervalMs=2000}={}){
  let initialization,running=false,timer,active;
  async function service(){
    if(!initialization){
      initialization=(async()=>{if(resolveService)return resolveService();const pool=await resolvePool();await runMigrations(pool);return createOrderManagementService({pool});})();
      initialization.catch(()=>{initialization=null;});
    }
    return initialization;
  }
  async function handleRoute(req,res,url){
    const pathname=url.pathname.startsWith('/api/')?url.pathname.slice(4):url.pathname;
    if(!pathname.startsWith('/ozon/order-management/')&&pathname!=='/ozon/product-costs'&&!pathname.startsWith('/ozon/product-costs/'))return false;
    try{
      const account=await authenticate(req);assertPermission(account,PERMISSIONS.TENANT_OPERATE);
      const scope={accountId:account.id,storeId:url.searchParams.get('storeId')||''},s=await service();
      const posting=pathname.match(/^\/ozon\/order-management\/postings\/([^/]+)(\/costs)?$/),product=pathname.match(/^\/ozon\/product-costs\/([^/]+)$/);
      const read=()=>readJson(req,{maxBytes:256*1024,requireBody:true});let result;
      if(req.method==='GET'&&pathname==='/ozon/order-management/overview')result=await s.overview(scope,Object.fromEntries(url.searchParams));
      else if(req.method==='GET'&&pathname==='/ozon/order-management/sync')result=await s.syncStatus(scope);
      else if(req.method==='POST'&&pathname==='/ozon/order-management/sync')result=await s.requestSync(scope,await read());
      else if(req.method==='GET'&&posting&&!posting[2])result=await s.getPosting(scope,decodeURIComponent(posting[1]),url.searchParams.get('scheme'));
      else if(req.method==='PUT'&&posting&&posting[2])result=await s.saveCosts(scope,decodeURIComponent(posting[1]),url.searchParams.get('scheme'),await read());
      else if(req.method==='GET'&&pathname==='/ozon/product-costs')result=await s.productCosts(scope);
      else if(req.method==='PUT'&&product)result=await s.saveProductCost(scope,decodeURIComponent(product[1]),await read());
      else{sendJson(res,404,{ok:false,code:'ORDER_MANAGEMENT_NOT_FOUND',message:'订单或采购成本接口不存在'});return true;}
      sendJson(res,200,result);
    }catch(e){
      const candidate=Number(e.status||e.statusCode),status=Number.isInteger(candidate)&&candidate>=400&&candidate<=599?candidate:500;
      sendJson(res,status,{ok:false,code:e.code||'ORDER_MANAGEMENT_REQUEST_FAILED',message:status>=500?'订单服务暂时不可用，请查看同步状态后重试':e.message||'订单请求失败'});
    }
    return true;
  }
  function schedule(){
    if(!running)return;
    timer=setTimeout(()=>{
      active=(async()=>{try{await(await service()).processNext();}catch{console.error('[order-management] background page deferred; check sync status');}})();
      active.finally(()=>{active=null;schedule();});
    },pollIntervalMs);timer.unref?.();
  }
  async function start(){if(running||(!resolveService&&!postgresEnabled()))return;await service();running=true;schedule();}
  async function stop(){running=false;clearTimeout(timer);if(active)await active;}
  return {handleRoute,start,stop};
}
