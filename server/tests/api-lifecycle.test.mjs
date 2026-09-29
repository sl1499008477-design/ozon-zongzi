import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { EventEmitter, once } from 'node:events';
const { createApiLifecycle } = await import('../api-lifecycle.mjs').catch(error => { if(error.code==='ERR_MODULE_NOT_FOUND')return {};throw error; });
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
const turn=()=>new Promise(r=>setImmediate(r));
function lifecycle(options){assert.equal(typeof createApiLifecycle,'function','API must install a graceful lifecycle');return createApiLifecycle(options);}

test('SIGTERM drains an active HTTP handler and worker before closing PG; duplicate SIGINT is harmless',async()=>{
  const requestGate=deferred(),workerGate=deferred(),entered=deferred(),events=[],signals=new EventEmitter();
  const server=http.createServer((req,res)=>{app.trackRequest(async()=>{entered.resolve();await requestGate.promise;res.end('saved');events.push('request saved');});});
  const app=lifecycle({server,signals,stopScheduling(){events.push('scheduling stopped');},drainBackground:async()=>{},closeResources:async()=>{events.push('PG closed');},logger:{error(){}}});
  await app.start({start(){},stop(){events.push('worker stopped');return workerGate.promise.then(()=>events.push('worker saved'));}});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const response=new Promise((resolve,reject)=>http.get(`http://127.0.0.1:${server.address().port}`,res=>{let body='';res.on('data',c=>body+=c);res.on('end',()=>resolve(body));}).on('error',reject));
  await entered.promise;signals.emit('SIGTERM');signals.emit('SIGINT');
  assert.equal(app.stopping,true);assert.equal(server.listening,false);assert.equal(events.filter(e=>e==='scheduling stopped').length,1);
  await turn();assert.equal(events.includes('PG closed'),false);
  requestGate.resolve();assert.equal(await response,'saved');await turn();assert.equal(events.includes('PG closed'),false);
  workerGate.resolve();await app.shutdown();assert.equal(events.at(-1),'PG closed');assert.equal(signals.exitCode,0);
});

test('late startup is stopped before its first timer and shutdown refuses new starts',async()=>{
  const gate=deferred(),signals=new EventEmitter();let timer,work=0,stops=0;
  const app=lifecycle({server:http.createServer(),signals,stopScheduling(){},drainBackground:async()=>{},closeResources:async()=>{assert.equal(work,0);},logger:{error(){}}});
  const starting=app.start({async start(){await gate.promise;timer=setTimeout(()=>work++,0);},stop(){stops++;clearTimeout(timer);}});
  const stopping=app.shutdown();assert.equal(signals.exitCode,1);
  await app.start({start(){work++;},stop(){}});gate.resolve();await starting;await stopping;await turn();
  assert.equal(work,0);assert.equal(stops,2);assert.equal(signals.exitCode,0);
});

test('failed worker drain is nonzero and cannot close the database or report success',async()=>{
  const signals=new EventEmitter();let closed=false,errors=0;
  const app=lifecycle({server:http.createServer(),signals,stopScheduling(){},drainBackground:async()=>{},closeResources:async()=>{closed=true;},logger:{error(){errors++;}}});
  await app.start({start(){},async stop(){throw Error('failed drain');}});
  await app.shutdown();assert.equal(signals.exitCode,1);assert.equal(closed,false);assert.equal(errors,1);
});

test('resource close failure remains nonzero after all work has drained',async()=>{
  const signals=new EventEmitter();const app=lifecycle({server:http.createServer(),signals,stopScheduling(){},drainBackground:async()=>{},closeResources:async()=>{throw Error('PG close failed');},logger:{error(){}}});
  await app.shutdown();assert.equal(signals.exitCode,1);
});

test('the actual API entrypoint answers health then handles SIGTERM with exit 0', {timeout:15000}, async()=>{
  const {spawn}=await import('node:child_process');
  const {mkdtemp,rm}=await import('node:fs/promises');
  const {tmpdir}=await import('node:os');
  const data=await mkdtemp(`${tmpdir()}/api-shutdown-`);
  const reservation=http.createServer();reservation.listen(0,'127.0.0.1');await once(reservation,'listening');
  const port=reservation.address().port;await new Promise(r=>reservation.close(r));
  const child=spawn(process.execPath,[fileURLToPath(new URL(process.env.API_LIFECYCLE_TEST_ENTRYPOINT || '../index.mjs',import.meta.url))],{env:{PATH:process.env.PATH,NODE_ENV:'test',QH_LOCAL_NO_DOTENV:'1',QH_LOCAL_API_PORT:String(port),QH_LOCAL_DATA_DIR:data},stdio:['ignore','pipe','pipe']});
  let output='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);
  const exited=once(child,'exit');
  try{
    const ready=await Promise.race([(async()=>{while(!output.includes('QH local API listening')){if(child.exitCode!==null||child.signalCode!==null)throw Error(output);await new Promise(r=>setTimeout(r,10));}return true;})(),exited.then(()=>{throw Error(output);})]);
    assert.equal(ready,true);
    const response=await fetch(`http://127.0.0.1:${port}/health`);assert.equal(response.status,200);await response.text();
    child.kill('SIGTERM');const [code,signal]=await exited;assert.equal(signal,null);assert.equal(code,0,output);
  }finally{if(child.exitCode===null)child.kill('SIGKILL');await rm(data,{recursive:true,force:true});}
});
