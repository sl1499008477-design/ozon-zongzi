import test from 'node:test';
import assert from 'node:assert/strict';
import {createAccountOzonRouteService,createAccountOzonRouteHandler,ozonRouteSettings} from '../account-ozon-route.mjs';
import {createCollectorHttpHandler} from '../collector-routes.mjs';
import {createCollectorAuthRuntime} from '../collector-auth-runtime.mjs';
import {hashCollectorSecret} from '../collector-auth-service.mjs';
import {requireAuth} from '../account-context.mjs';
import {callOzonSellerApi} from '../ozon-client.mjs';

function fixture(){
 const state={accounts:['a','b'].map(id=>({id,status:'active'})),sessions:{a:{accountId:'a'},b:{accountId:'b'}},collectorSessions:[{id:'c',accountId:'a',tokenHash:hashCollectorSecret('c'),parentSessionToken:'a',permissions:['collector.config.read'],expiresAt:'2099-01-01T00:00:00Z'}]};
 const sendJson=(res,status,body)=>Object.assign(res,{status,body});
 const service=createAccountOzonRouteService({loadState:async()=>state,saveState:async()=>{},transaction:fn=>fn()});
 const auth=createCollectorAuthRuntime({loadState:async()=>state,saveState:async()=>{},persistenceMode:()=> 'json',stateTransaction:{run:fn=>fn()},readJson:async req=>req.body,sendJson});
 const web=createAccountOzonRouteHandler({service,authenticate:req=>requireAuth(req,state),readJson:async req=>req.body,sendJson});
 const collector=createCollectorHttpHandler({authenticate:auth.authenticateRequest,ozonRouteService:service,sendJson});
 const request=async(method,url,token='Bearer a',body)=>{const res={};await (url.startsWith('/collector')?collector:web)({method,url,headers:{authorization:token},body},res);return res;};
 return {service,request,state};
}

test('account default CN and revision save are shared across clients but account-isolated',async()=>{
 const f=fixture();assert.deepEqual((await f.request('GET','/account/ozon-route')).body,{ok:true,...ozonRouteSettings('CN'),revision:0,updatedAt:null});
 const saved=await f.request('PUT','/account/ozon-route','Bearer a',{route:'RU',revision:0});assert.equal(saved.status,200);assert.equal(saved.body.revision,1);
 assert.equal((await f.request('GET','/collector/ozon-route','Collector c')).body.route,'RU');
 assert.equal((await f.request('GET','/account/ozon-route','Bearer b')).body.route,'CN');
 assert.equal((await f.request('PUT','/account/ozon-route','Bearer a',{route:'CN',revision:0})).status,409);
});

test('only Web may save; Collector requires config permission and rejects caller scope',async()=>{
 const f=fixture();
 assert.equal((await f.request('PUT','/collector/ozon-route','Collector c',{route:'RU',revision:0})).status,405);
 assert.equal((await f.request('PUT','/account/ozon-route','Collector c',{route:'RU',revision:0})).status,401);
 assert.equal((await f.request('GET','/collector/ozon-route','Bearer a')).status,401);
 for(const path of ['/account/ozon-route','/collector/ozon-route'])assert.equal((await f.request('GET',path+'?accountId=b',path.startsWith('/collector')?'Collector c':'Bearer a')).status,400);
 for(const body of [{route:'RU',revision:0,accountId:'b'},{route:'CN',revision:0,storeId:'s'},{route:'https://other.test',revision:0},{route:'RU'},{route:'ru',revision:0}])assert.equal((await f.request('PUT','/account/ozon-route','Bearer a',body)).status,400);
 f.state.collectorSessions[0].permissions=['collector.job.read'];assert.equal((await f.request('GET','/collector/ozon-route','Collector c')).status,403);
});

test('account route stays frozen while the API outage override uses RU once without retrying uncertain writes',async()=>{
 const f=fixture();const before=await f.service.read('a'),urls=[];
 const original=globalThis.fetch;globalThis.fetch=async url=>{urls.push(url);if(urls.length===3)throw new TypeError('connection lost');return new Response('{}');};
 try{
  const credential={clientId:'fixture',apiKey:'fixture',ozonRoute:before.route};
  await callOzonSellerApi(credential,'/read',{});
  await f.service.save('a',{route:'RU',revision:0});
  await callOzonSellerApi(credential,'/write',{});
  await assert.rejects(callOzonSellerApi({...credential,ozonRoute:(await f.service.read('a')).route},'/write',{}));
  assert.deepEqual(urls,['https://api-seller.ozon.ru/read','https://api-seller.ozon.ru/write','https://api-seller.ozon.ru/write']);
  assert.equal(credential.ozonRoute,'CN');
 }finally{globalThis.fetch=original;}
});

test('legacy in-flight tasks keep previous configured host; loopback test transport remains local',async()=>{
 const before=process.env.OZON_API_BASE;
 try{
  process.env.OZON_API_BASE='https://api-seller.ozonru.cn';
  const configured=await import('../ozon-client.mjs?legacy-cn');
  assert.equal(configured.ozonApiBase({ozonRoute:'LEGACY'}),'https://api-seller.ozonru.cn');
  assert.equal(configured.ozonApiBase({ozonRoute:'RU'}),'https://api-seller.ozon.ru');
  process.env.OZON_API_BASE='http://127.0.0.1:61399';
  const fixture=await import('../ozon-client.mjs?loopback');
  assert.equal(fixture.ozonApiBase({ozonRoute:'CN'}),'http://127.0.0.1:61399');
  assert.equal(fixture.ozonApiBase({ozonRoute:'RU'}),'http://127.0.0.1:61399');
 }finally{if(before===undefined)delete process.env.OZON_API_BASE;else process.env.OZON_API_BASE=before;}
});
