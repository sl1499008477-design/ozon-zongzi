import {getPostgresPool,postgresEnabled} from './db/connection.mjs';
import {runMigrations} from './db/migrate.mjs';
import {assertPermission,PERMISSIONS} from './permissions.mjs';
import {createStockService} from './stock-service.mjs';

export function createStockRuntime({authenticate,readJson,sendJson,resolveService,resolvePool=getPostgresPool}={}){
  let initialization,running=false,timer,active;
  async function service(){
    if(!initialization){initialization=(async()=>{if(resolveService)return resolveService();const pool=await resolvePool();await runMigrations(pool);return createStockService({pool});})();initialization.catch(()=>{initialization=null;});}
    return initialization;
  }
  async function handleRoute(req,res,url){
    const path=url.pathname.replace(/^\/api\//,'/'),action=path.match(/^\/ozon\/stocks\/changes\/([^/]+)\/(reconcile|close)$/);
    if(!['/ozon/stocks/product','/ozon/stocks/changes','/ozon/stocks/batch-preview','/ozon/stocks/batch','/ozon/stocks/batch-status'].includes(path)&&!action)return false;
    try{
      const account=await authenticate(req);assertPermission(account,PERMISSIONS.TENANT_OPERATE);
      const scope={accountId:account.id,storeId:url.searchParams.get('storeId')||''},s=await service();let result;
      if(req.method==='GET'&&path==='/ozon/stocks/product')result=await s.product(scope,url.searchParams.get('productId')||'');
      else if(req.method==='GET'&&path==='/ozon/stocks/changes')result=await s.changes(scope,url.searchParams.get('productId')||'');
      else if(req.method==='POST'&&path==='/ozon/stocks/changes')result=await s.submit(scope,await readJson(req,{maxBytes:64*1024,requireBody:true}));
      else if(req.method==='GET'&&path==='/ozon/stocks/batch-status')result=await s.batchStatus(scope,(url.searchParams.get('ids')||'').split(',').filter(Boolean));
      else if(req.method==='POST'&&path==='/ozon/stocks/batch')result=await s.batchSubmit(scope,await readJson(req,{maxBytes:128*1024,requireBody:true}));
      else if(req.method==='POST'&&path==='/ozon/stocks/batch-preview')result=await s.batchPreview(scope,await readJson(req,{maxBytes:64*1024,requireBody:true}));
      else if(req.method==='POST'&&action)result=await s[action[2]](scope,decodeURIComponent(action[1]));
      else{sendJson(res,405,{message:'此库存接口不支持该操作'});return true;}
      sendJson(res,200,result);
    }catch(e){const status=Number(e.status||e.statusCode||500);sendJson(res,status,{ok:false,code:e.code||'STOCK_REQUEST_FAILED',message:status>=500?'暂时无法读取或提交库存，请刷新修改记录后重试':e.message||'库存请求失败'});}
    return true;
  }
  function schedule(){if(!running)return;timer=setTimeout(()=>{active=(async()=>{try{await(await service()).processNext();}catch{console.error('[stocks] background operation deferred; inspect stock change records');}})();active.finally(()=>{active=null;schedule();});},2000);timer.unref?.();}
  async function start(){if(running||(!resolveService&&!postgresEnabled()))return;await service();running=true;schedule();}
  async function stop(){running=false;clearTimeout(timer);await active;}
  return {handleRoute,start,stop};
}
