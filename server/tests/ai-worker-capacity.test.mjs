import test from 'node:test';
import assert from 'node:assert/strict';
import {createAiWorkerCapacity,readAiWorkerResources} from '../ai-worker-capacity.mjs';
const mib=1024*1024;
const healthy={memoryRatio:0.35,headroomBytes:1200*mib,cpuRatio:0.2,eventLoopDelayMs:10};
test('sustained pressure reduces admission; critical memory pauses and recovery cannot exceed configured ceiling',()=>{
  const limiter=createAiWorkerCapacity({ceiling:5});
  assert.equal(limiter.capacity,5);
  limiter.observe({...healthy,cpuRatio:0.95});assert.equal(limiter.capacity,5);
  limiter.observe({...healthy,cpuRatio:0.95});assert.equal(limiter.capacity,4);
  limiter.observe({...healthy,memoryRatio:0.93});assert.equal(limiter.capacity,0);
  for(let i=0;i<5;i++)limiter.observe(healthy);assert.equal(limiter.capacity,0);
  limiter.observe(healthy);assert.equal(limiter.capacity,1);
  for(let i=0;i<100;i++)limiter.observe(healthy);assert.equal(limiter.capacity,5);
});
test('a single short OCR CPU burst does not lower concurrency; uncertain samples never raise it',()=>{
  const limiter=createAiWorkerCapacity({ceiling:3});
  limiter.observe({...healthy,cpuRatio:1});limiter.observe(healthy);assert.equal(limiter.capacity,3);
  limiter.observe({...healthy,headroomBytes:100*mib});assert.equal(limiter.capacity,0);
  for(let i=0;i<20;i++)limiter.observe({});assert.equal(limiter.capacity,0);
});
test('resource reading respects container memory and CPU quotas including native usage',async()=>{
  const files={'memory.max':String(2048*mib),'memory.current':String(1700*mib),'cpu.max':'200000 100000','cpu.stat':'usage_usec 8000000\n'};
  const sample=await readAiWorkerResources({platform:'linux',readFile:async path=>files[path.split('/').at(-1)],totalmem:()=>8*1024*mib,freemem:()=>5*1024*mib,availableParallelism:()=>8,loadavg:()=>[0.5],now:1000,previous:{at:500,usage:7500000},eventLoopDelayMs:20});
  assert.equal(sample.memoryRatio,1700/2048);assert.equal(sample.headroomBytes,348*mib);
  assert.equal(sample.cpuRatio,0.5);assert.equal(sample.eventLoopDelayMs,20);
});
test('without cgroups, system memory and load remain usable',async()=>{
  const sample=await readAiWorkerResources({platform:'darwin',totalmem:()=>8*1024*mib,freemem:()=>2*1024*mib,availableParallelism:()=>4,loadavg:()=>[2],eventLoopDelayMs:5});
  assert.equal(sample.memoryRatio,0.75);assert.equal(sample.headroomBytes,2*1024*mib);assert.equal(sample.cpuRatio,0.5);
});

test('live ceiling changes preserve adaptive pressure and disabled mode uses the saved ceiling',()=>{
  const limiter=createAiWorkerCapacity({ceiling:3});
  assert.equal(typeof limiter.configure,'function');
  limiter.observe({...healthy,memoryRatio:0.95});assert.equal(limiter.capacity,0);
  limiter.configure({ceiling:6,adaptiveEnabled:true});assert.equal(limiter.capacity,0);
  for(let i=0;i<12;i++)limiter.observe(healthy);assert.equal(limiter.capacity,2);
  limiter.configure({ceiling:1,adaptiveEnabled:true});assert.equal(limiter.capacity,1);
  limiter.configure({ceiling:4,adaptiveEnabled:false});assert.equal(limiter.capacity,4);
  limiter.observe({...healthy,memoryRatio:0.99});assert.equal(limiter.capacity,4);
  limiter.configure({ceiling:2,adaptiveEnabled:true});assert.equal(limiter.capacity,2);
});

test('resource display reports actual container and host memory scope',async()=>{
  const sample=await readAiWorkerResources({platform:'linux',readFile:async path=>({'memory.max':'1000','memory.current':'600','cpu.max':'200000 100000'})[path.split('/').at(-1)],totalmem:()=>8000,freemem:()=>6000,availableParallelism:()=>8,loadavg:()=>[0]});
  assert.equal(sample.memoryScope,'container');assert.equal(sample.memoryLimitBytes,1000);assert.equal(sample.memoryUsedBytes,600);assert.equal(sample.cpuCores,2);
  const host=await readAiWorkerResources({platform:'darwin',totalmem:()=>8000,freemem:()=>6000,availableParallelism:()=>8,loadavg:()=>[0]});
  assert.equal(host.memoryScope,'host');assert.equal(host.memoryUsedBytes,2000);
});

test('missing container usage does not become a fabricated zero reading',async()=>{
  const sample=await readAiWorkerResources({platform:'linux',readFile:async path=>path.endsWith('memory.max')?'1000':null,totalmem:()=>8000,freemem:()=>6000,availableParallelism:()=>8,loadavg:()=>[0]});
  assert.equal(sample.memoryScope,'host');assert.equal(sample.memoryUsedBytes,2000);
});

test('cgroup v1 memory at 95 percent pauses admission despite idle 8 GiB host',async()=>{
  const files={
    '/proc/self/cgroup':'5:memory:/docker/test\n4:cpu,cpuacct:/docker/test\n',
    '/sys/fs/cgroup/memory/memory.limit_in_bytes':String(2048*mib),
    '/sys/fs/cgroup/memory/memory.usage_in_bytes':String(1946*mib),
    '/sys/fs/cgroup/cpu/cpu.cfs_quota_us':'200000',
    '/sys/fs/cgroup/cpu/cpu.cfs_period_us':'100000',
    '/sys/fs/cgroup/cpuacct/cpuacct.usage':'9500000000',
  };
  const sample=await readAiWorkerResources({platform:'linux',readFile:async path=>files[path]??null,totalmem:()=>8192*mib,freemem:()=>7000*mib,availableParallelism:()=>8,loadavg:()=>[0],now:1000,previous:{at:500,usage:8500000}});
  assert.equal(sample.memoryLimitBytes,2048*mib);assert.equal(sample.memoryUsedBytes,1946*mib);assert.equal(sample.cpuCores,2);assert.equal(sample.cpuRatio,1);
  assert.equal(sample.memoryScope,'container');assert.equal(sample.cgroupVersion,'v1');
  assert.equal(createAiWorkerCapacity().observe(sample),0);
});

test('nested cgroup v2 path is read, and missing limits are observable',async()=>{
  const files={'/proc/self/cgroup':'0::/user.slice/worker\n','/sys/fs/cgroup/user.slice/worker/memory.max':'1000','/sys/fs/cgroup/user.slice/worker/memory.current':'950','/sys/fs/cgroup/user.slice/worker/cpu.max':'50000 100000'};
  const options={platform:'linux',totalmem:()=>8000,freemem:()=>7000,availableParallelism:()=>8,loadavg:()=>[0]};
  const sample=await readAiWorkerResources({...options,readFile:async path=>files[path]??null});
  assert.equal(sample.memoryScope,'container');assert.equal(sample.memoryLimitBytes,1000);assert.equal(sample.cpuCores,.5);assert.equal(sample.cgroupVersion,'v2');
  const missing=await readAiWorkerResources({...options,readFile:async()=>null});
  assert.equal(missing.memoryScope,'host');assert.equal(missing.resourceWarnings.includes('CGROUP_MEMORY_UNAVAILABLE'),true);
  assert.equal(missing.resourceWarnings.includes('CGROUP_CPU_UNAVAILABLE'),true);
});

test('v2 inherited limits constrain a nested worker whose own cgroup is unlimited',async()=>{
 const files={'/proc/self/cgroup':'0::/slice/worker\n',
 '/sys/fs/cgroup/slice/worker/memory.max':'max','/sys/fs/cgroup/slice/worker/memory.current':String(100*mib),
 '/sys/fs/cgroup/slice/memory.max':String(2048*mib),'/sys/fs/cgroup/slice/memory.current':String(1946*mib),
 '/sys/fs/cgroup/slice/worker/cpu.max':'max 100000','/sys/fs/cgroup/slice/cpu.max':'100000 100000','/sys/fs/cgroup/slice/cpu.stat':'usage_usec 1500000'};
 const sample=await readAiWorkerResources({platform:'linux',readFile:async path=>files[path]??null,totalmem:()=>8192*mib,freemem:()=>7000*mib,availableParallelism:()=>8,loadavg:()=>[0],now:1000,previous:{at:500,usage:1000000}});
 assert.equal(sample.memoryLimitBytes,2048*mib);assert.equal(sample.memoryUsedBytes,1946*mib);assert.equal(sample.cpuCores,1);assert.equal(sample.cpuRatio,1);assert.equal(createAiWorkerCapacity().observe(sample),0);
});
