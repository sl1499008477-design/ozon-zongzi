import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {isolatedTestEnvironment} from '../../scripts/test-environment.mjs';

const dataDir = await mkdtemp(path.join(tmpdir(), 'collect-progress-route-'));
const env = isolatedTestEnvironment(process.env, dataDir);
for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
Object.assign(process.env,env);
const {handleFastCollectionRoute} = await import('../index.mjs');
test.after(() => rm(dataDir,{recursive:true,force:true}));

function response() {
  return {status:0,body:null,writeHead(status){this.status=status;},end(body){this.body=JSON.parse(body);}};
}
const categoryEvidencePort = {recordCollectionResult(){throw new Error('read must not record evidence');}};

test('summary uses authenticated account, supports filters and never loads full local state', async () => {
  const res=response(),calls=[];
  const handled=await handleFastCollectionRoute({method:'GET',headers:{}},res,
    new URL('http://fixture.invalid/ozon/collect-box/summary?accountId=other&limit=20&offset=40&status=%E5%BE%85%E5%A4%84%E7%90%86&source=Ozon&variant=%E5%A4%9A%E5%8F%98%E4%BD%93'),{
      pipelineEnabled:()=>true,categoryEvidencePort,authenticateMutationRequest:async()=>({id:'owned-account'}),
      readCollectSummary:async input=>{calls.push(input);return {items:[{id:'owned-item'}],total:45,counts:{'全部':45},sources:['Ozon']};},
    });
  assert.equal(handled,true);assert.equal(res.status,200);assert.equal(res.body.total,45);
  assert.deepEqual(calls,[{accountId:'owned-account',limit:'20',offset:'40',status:'待处理',source:'Ozon',variant:'多变体'}]);
});

test('summary rejects missing authentication before reading any item', async()=>{
  const res=response();let read=false;
  await handleFastCollectionRoute({method:'GET',headers:{}},res,new URL('http://fixture.invalid/ozon/collect-box/summary'),{
    pipelineEnabled:()=>true,categoryEvidencePort,authenticateMutationRequest:async()=>{throw Object.assign(new Error('请登录'),{status:401});},
    readCollectSummary:async()=>{read=true;},
  });
  assert.equal(res.status,401);assert.equal(read,false);
});

test('progress is a fast authenticated read and never falls through to global state', async () => {
  const res = response(), calls=[];
  const handled = await handleFastCollectionRoute({method:'GET',headers:{}},res,
    new URL('http://fixture.invalid/ozon/collect-box/progress?ids=a&ids=b&accountId=other'), {
      pipelineEnabled:()=>true,categoryEvidencePort,
      authenticateMutationRequest:async()=>({id:'current-account'}),
      readCollectProgress:async input=>{calls.push(input);return {data:[{id:'a',enrichment:{status:'COMPLETE'},draftVersion:2}]};},
    });
  assert.equal(handled,true,'polling must return before the global state transaction');
  assert.equal(res.status,200);
  assert.deepEqual(calls,[{accountId:'current-account',ids:['a','b']}]);
  assert.equal(res.body.data[0].draftVersion,2);
});

test('unauthenticated progress reads return 401 without reading any collection', async () => {
  const res=response();let read=false;
  assert.equal(await handleFastCollectionRoute({method:'GET',headers:{}},res,
    new URL('http://fixture.invalid/ozon/collect-box/progress?ids=a'),{
      pipelineEnabled:()=>true,categoryEvidencePort,
      authenticateMutationRequest:async()=>{throw Object.assign(new Error('login required'),{status:401});},
      readCollectProgress:async()=>{read=true;},
    }),true);
  assert.equal(res.status,401);assert.equal(read,false);
});

test('database failure reports failure and never returns an empty successful progress list', async () => {
  const res=response();
  assert.equal(await handleFastCollectionRoute({method:'GET',headers:{}},res,
    new URL('http://fixture.invalid/ozon/collect-box/progress?ids=a'),{
      pipelineEnabled:()=>true,categoryEvidencePort,
      authenticateMutationRequest:async()=>({id:'current-account'}),
      readCollectProgress:async()=>{throw Object.assign(new Error('connection lost'),{code:'08006'});},
    }),true);
  assert.equal(res.status,500);assert.equal(res.body.data,undefined);
});

test('a driver disconnect without a code remains traceable and is not a collection failure', async () => {
  const res=response(), logs=[], originalLog=console.error;
  const error=new Error('Connection terminated unexpectedly');
  error.client={password:'fixture-secret-that-must-not-be-logged'};
  console.error=(...args)=>logs.push(args);
  try {
    await handleFastCollectionRoute({method:'GET',headers:{}},res,
      new URL('http://fixture.invalid/ozon/collect-box/progress?ids=a'),{
        pipelineEnabled:()=>true,categoryEvidencePort,
        authenticateMutationRequest:async()=>({id:'current-account'}),
        readCollectProgress:async()=>{throw error;},
      });
  } finally {console.error=originalLog;}
  assert.equal(res.status,500);
  assert.equal(res.body.code,'DB_CONNECTION_LOST');
  assert.equal(res.body.data,undefined);
  assert.equal(logs.length,1);
  assert.equal(logs[0][1].message,error.message);
  assert.equal(JSON.stringify(logs).includes('fixture-secret-that-must-not-be-logged'),false);
  assert.equal(logs[0][1].code,'DB_CONNECTION_LOST');
});
