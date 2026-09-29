import os from 'node:os';
import {readFile as read} from 'node:fs/promises';
const MiB=1024*1024;
// Changes admission only. Existing paid requests and local work always drain normally.
export function createAiWorkerCapacity({ceiling=3}={}) {
  let capacity=ceiling,pressureSamples=0,healthySamples=0,adaptiveEnabled=true;
  return {
    get capacity(){return capacity;},
    configure(settings){
      const next=Math.min(20,settings.ceiling);
      capacity=settings.adaptiveEnabled?Math.min(capacity,next):next;
      ceiling=next;adaptiveEnabled=settings.adaptiveEnabled;
      if(!adaptiveEnabled){pressureSamples=0;healthySamples=0;}
    },
    observe({memoryRatio,headroomBytes,cpuRatio,eventLoopDelayMs}={}) {
      if(!adaptiveEnabled)return capacity;
      if(![memoryRatio,headroomBytes,cpuRatio,eventLoopDelayMs].every(Number.isFinite)){healthySamples=0;return capacity;}
      const critical=memoryRatio>=0.90||headroomBytes<192*MiB||eventLoopDelayMs>=1000;
      const pressure=memoryRatio>=0.80||headroomBytes<384*MiB||cpuRatio>=0.90||eventLoopDelayMs>=100;
      const healthy=memoryRatio<0.70&&headroomBytes>=512*MiB&&cpuRatio<0.70&&eventLoopDelayMs<50;
      pressureSamples=pressure?pressureSamples+1:0;healthySamples=healthy?healthySamples+1:0;
      if(critical){capacity=0;pressureSamples=0;}
      else if(pressureSamples>=2){capacity=capacity>0?Math.max(1,capacity-1):0;pressureSamples=0;}
      else if(healthySamples>=6){capacity=Math.min(ceiling,capacity+1);healthySamples=0;}
      return capacity;
    },
  };
}
export async function readAiWorkerResources({platform=process.platform,readFile=read,totalmem=os.totalmem,freemem=os.freemem,
  availableParallelism=os.availableParallelism,loadavg=os.loadavg,previous,now=Date.now(),eventLoopDelayMs=0}={}) {
  const total=totalmem(),hostCpus=availableParallelism();
  let free=freemem();
  if(platform==='linux'){const info=await readFile('/proc/meminfo','utf8').catch(()=>null);const available=String(info||'').match(/^MemAvailable:\s+(\d+) kB/m);if(available)free=Number(available[1])*1024;}
  let memoryLimitBytes=total,memoryUsedBytes=total-free,memoryScope='host',cpuCores=hostCpus;
  let memoryRatio=(total-free)/total,headroomBytes=free,cpuRatio=loadavg()[0]/hostCpus,usage;
  if(platform==='linux') {
    const values=await Promise.all(['memory.max','memory.current','cpu.max','cpu.stat'].map(name=>readFile('/sys/fs/cgroup/'+name,'utf8').catch(()=>null)));
    const [limit,current]=values.slice(0,2).map(Number);
    if(values[1]!=null&&String(values[1]).trim()!==''&&Number.isFinite(limit)&&limit>0&&Number.isFinite(current)&&current>=0){memoryLimitBytes=limit;memoryUsedBytes=current;memoryScope='container';memoryRatio=Math.max(memoryRatio,current/limit);headroomBytes=Math.min(free,Math.max(0,limit-current));}
    const [quota,period]=String(values[2]||'').trim().split(/\s+/).map(Number);
    const cores=quota>0&&period>0?Math.min(hostCpus,quota/period):hostCpus;
    cpuCores=cores;
    const match=String(values[3]||'').match(/(?:^|\n)usage_usec (\d+)/);usage=match?Number(match[1]):undefined;
    if(previous&&Number.isFinite(usage)&&now>previous.at&&usage>=previous.usage)cpuRatio=Math.max(cpuRatio,(usage-previous.usage)/1000/(now-previous.at)/cores);
  }
  return {memoryRatio,headroomBytes,cpuRatio,eventLoopDelayMs,at:now,usage,memoryLimitBytes,memoryUsedBytes,memoryScope,cpuCores};
}
