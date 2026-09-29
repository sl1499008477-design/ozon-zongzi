const routes=Object.freeze({
 CN:Object.freeze({route:'CN',sellerOrigin:'https://seller.ozonru.cn',apiBase:'https://api-seller.ozonru.cn'}),
 RU:Object.freeze({route:'RU',sellerOrigin:'https://seller.ozon.ru',apiBase:'https://api-seller.ozon.ru'}),
});
const invalid=(message,status=400,code='OZON_ROUTE_INVALID')=>Object.assign(new Error(message),{status,code});
export function ozonRouteSettings(route='CN'){
 if(!Object.hasOwn(routes,route))throw invalid('Ozon 线路必须为 CN 或 RU');
 return {...routes[route]};
}
function view(row){return {...ozonRouteSettings(row?.route||'CN'),revision:Number(row?.revision||0),updatedAt:row?.updated_at?new Date(row.updated_at).toISOString():row?.updatedAt||null};}
function validateInput(input){
 if(!input||Array.isArray(input)||typeof input!=='object'||Object.keys(input).some(key=>!['route','revision'].includes(key)))throw invalid('线路设置只能包含 route 和 revision');
 if(!Object.hasOwn(routes,input.route))throw invalid('Ozon 线路必须为 CN 或 RU');
 if(!Number.isSafeInteger(input.revision)||input.revision<0)throw invalid('缺少有效的线路版本，请刷新后重试');
}
export function pinOzonCredential(credential,body){
 if(!credential)return credential;
 if(!body.ozonRoute&&credential.ozonRoute)body.ozonRoute=credential.ozonRoute;
 return body.ozonRoute&&body.ozonRoute!==credential.ozonRoute?{...credential,ozonRoute:body.ozonRoute}:credential;
}
export function assertOzonRouteScope(url,req){
 if(url.searchParams.size||req?.headers?.['x-ozon-store-id']||req?.headers?.['x-account-id'])throw invalid('账号线路由登录账号确定，不接受账号或店铺范围');
}
export function createAccountOzonRouteService({pool,loadState,saveState,transaction=fn=>fn()}={}){
 const database=async()=>typeof pool==='function'?pool():pool;
 async function read(accountId){
  if(!accountId)throw invalid('请先登录',401,'WEB_AUTH_REQUIRED');
  if(pool)return view((await (await database()).query('SELECT route,revision,updated_at FROM account_ozon_routes WHERE account_id=$1',[accountId])).rows[0]);
  return view((await loadState()).ozonRoutesByAccount?.[accountId]);
 }
 async function save(accountId,input){
  if(!accountId)throw invalid('请先登录',401,'WEB_AUTH_REQUIRED');
  validateInput(input);
  if(pool){
   const db=await database();
   const result=input.revision===0
    ?await db.query('INSERT INTO account_ozon_routes(account_id,route,revision) VALUES($1,$2,1) ON CONFLICT(account_id) DO NOTHING RETURNING route,revision,updated_at',[accountId,input.route])
    :await db.query('UPDATE account_ozon_routes SET route=$2,revision=revision+1,updated_at=NOW() WHERE account_id=$1 AND revision=$3 RETURNING route,revision,updated_at',[accountId,input.route,input.revision]);
   if(result.rows[0])return view(result.rows[0]);
   throw invalid('线路已在其他页面修改，请刷新后重试',409,'OZON_ROUTE_CONFLICT');
  }
  return transaction(async()=>{
   const state=await loadState(),current=view(state.ozonRoutesByAccount?.[accountId]);
   if(current.revision!==input.revision)throw invalid('线路已在其他页面修改，请刷新后重试',409,'OZON_ROUTE_CONFLICT');
   const value={route:input.route,revision:current.revision+1,updatedAt:new Date().toISOString()};
   state.ozonRoutesByAccount={...state.ozonRoutesByAccount,[accountId]:value};
   await saveState(state);return view(value);
  });
 }
 return {read,save};
}
export function createAccountOzonRouteHandler({service,authenticate,readJson,sendJson}){
 return async function handle(req,res){
  const url=new URL(req.url||'/','http://local');if(!/^\/account\/ozon-route\/?$/.test(url.pathname))return false;
  try{
   if(!['GET','PUT'].includes(req.method))throw invalid('请求方法不被允许',405,'OZON_ROUTE_METHOD_NOT_ALLOWED');
   const account=await authenticate(req);assertOzonRouteScope(url,req);
   const value=req.method==='GET'?await service.read(account.id):await service.save(account.id,await readJson(req));
   sendJson(res,200,{ok:true,...value});
  }catch(error){sendJson(res,error.status||500,{ok:false,message:error.message,code:error.code||'OZON_ROUTE_FAILED'});}
  return true;
 };
}
