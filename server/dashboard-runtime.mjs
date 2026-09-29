import {getPostgresPool} from './db/connection.mjs';
import {assertPermission,PERMISSIONS} from './permissions.mjs';
import {createDashboardService} from './dashboard-service.mjs';

export function createDashboardRuntime({authenticate,sendJson,resolvePool=getPostgresPool,resolveService}={}) {
  let initialization;
  function service() {
    if(!initialization) {
      initialization=Promise.resolve().then(async()=>resolveService?resolveService():createDashboardService({pool:await resolvePool()}));
      initialization.catch(()=>{initialization=null;});
    }
    return initialization;
  }
  async function handleRoute(req,res,url) {
    const path=url.pathname.startsWith('/api/')?url.pathname.slice(4):url.pathname;
    if(!path.startsWith('/ozon/dashboard/'))return false;
    try {
      const account=await authenticate(req);
      assertPermission(account,PERMISSIONS.TENANT_OPERATE);
      if(path!=='/ozon/dashboard/summary')throw Object.assign(Error('首页接口不存在'),{status:404,code:'DASHBOARD_NOT_FOUND'});
      if(req.method!=='GET')throw Object.assign(Error('首页统计仅支持读取'),{status:405,code:'DASHBOARD_METHOD_NOT_ALLOWED'});
      const result=await(await service()).getSummary({accountId:account.id,storeId:url.searchParams.get('storeId')||null});
      sendJson(res,200,result);
    } catch(error) {
      const candidate=Number(error.status||error.statusCode),status=candidate>=400&&candidate<=599?candidate:500;
      sendJson(res,status,{ok:false,code:error.code||'DASHBOARD_REQUEST_FAILED',message:status>=500?'首页统计暂不可用':error.message});
    }
    return true;
  }
  return {handleRoute};
}
