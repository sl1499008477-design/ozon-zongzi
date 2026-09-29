import os from 'node:os';
import {readFile as read} from 'node:fs/promises';
import {posix} from 'node:path';
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
  let cgroupVersion=null;const resourceWarnings=[];
  if(platform==='linux') {
    const readSafe=path=>Promise.resolve().then(()=>readFile(path,'utf8')).catch(()=>null);
    const [membership,mountinfo]=await Promise.all([readSafe('/proc/self/cgroup'),readSafe('/proc/self/mountinfo')]);
    const members=String(membership||'').trim().split('\n').map(line=>line.split(':'));
    function directories(controller,version){
      const member=members.find(parts=>version==='v2'?parts[0]==='0'&&parts[1]==='':parts[1]?.split(',').includes(controller));
      const path=member?.slice(2).join(':')||'/';const dirs=[];
      function ancestors(start,root){for(let dir=start,n=0;n<64;n++,dir=posix.dirname(dir)){dirs.push(dir);if(dir===root||dir==='/')break;}}
      for(const line of String(mountinfo||'').split('\n')){
        const [left,right]=line.split(' - ');if(!right)continue;
        const fields=left.split(' '),[type,,options]=right.split(' ');
        if(type!==(version==='v2'?'cgroup2':'cgroup')||(version==='v1'&&!options?.split(',').includes(controller)))continue;
        const [root,mount]=fields.slice(3,5).map(value=>value.replace(/\\040/g,' '));
        if(path===root||path.startsWith(root==='/'?'/':root+'/'))ancestors(posix.join(mount,posix.relative(root,path)),mount);
      }
      const base=version==='v2'?'/sys/fs/cgroup':`/sys/fs/cgroup/${controller}`;
      if(path!=='/'&&!path.split('/').includes('..'))ancestors(posix.join(base,path),base);
      dirs.push(base);
      if(version==='v1'&&['cpu','cpuacct'].includes(controller))dirs.push('/sys/fs/cgroup/cpu,cpuacct');
      return [...new Set(dirs)];
    }
    async function groups(dirs,names){
      const values=await Promise.all(dirs.map(dir=>Promise.all(names.map(name=>readSafe(`${dir}/${name}`)))));
      return values.filter(value=>value[0]!=null&&String(value[0]).trim()!=='');
    }
    const v2dirs=directories('', 'v2');
    let memories=await groups(v2dirs,['memory.max','memory.current']);
    if(memories.length)cgroupVersion='v2';
    else {memories=await groups(directories('memory','v1'),['memory.limit_in_bytes','memory.usage_in_bytes']);if(memories.length)cgroupVersion='v1';}
    const memory=memories.filter(value=>Number(value[0])>0&&Number(value[0])<=total).sort((a,b)=>Number(a[0])-Number(b[0]))[0]||memories[0]||[];
    const [limit,current]=memory.map(Number);
    if(memory[1]!=null&&String(memory[1]).trim()!==''&&Number.isFinite(limit)&&limit>0&&limit<=total&&Number.isFinite(current)&&current>=0){memoryLimitBytes=limit;memoryUsedBytes=current;memoryScope='container';memoryRatio=Math.max(memoryRatio,current/limit);headroomBytes=Math.min(free,Math.max(0,limit-current));}
    else if(!memory.length||memory[1]==null)resourceWarnings.push('CGROUP_MEMORY_UNAVAILABLE');
    const cpus=await groups(v2dirs,['cpu.max','cpu.stat']);
    const cpuLimit=value=>{const [quota,period]=String(value).trim().split(/\s+/).map(Number);return quota>0&&period>0?quota/period:Infinity;};
    let cpu=cpus.toSorted((a,b)=>cpuLimit(a[0])-cpuLimit(b[0]))[0]||[];
    let quota,period;
    if(cpu.length){
      cgroupVersion ||= 'v2';[quota,period]=String(cpu[0]).trim().split(/\s+/).map(Number);
      const match=String(cpu[1]||'').match(/(?:^|\n)usage_usec (\d+)/);usage=match?Number(match[1]):undefined;
    }else{
      const v1=await groups(directories('cpu','v1'),['cpu.cfs_quota_us','cpu.cfs_period_us']);
      cpu=v1.toSorted((a,b)=>cpuLimit(a.join(' '))-cpuLimit(b.join(' ')))[0]||[];
      if(cpu.length)cgroupVersion ||= 'v1';[quota,period]=cpu.map(Number);
      const [nanos]=((await groups(directories('cpuacct','v1'),['cpuacct.usage']))[0]||[]);
      if(nanos!=null&&Number.isFinite(Number(nanos)))usage=Number(nanos)/1000;
    }
    if(!cpu.length)resourceWarnings.push('CGROUP_CPU_UNAVAILABLE');
    cpuCores=quota>0&&period>0?Math.min(hostCpus,quota/period):hostCpus;
    if(previous&&Number.isFinite(usage)&&now>previous.at&&usage>=previous.usage)cpuRatio=Math.max(cpuRatio,(usage-previous.usage)/1000/(now-previous.at)/cpuCores);
  }
  return {memoryRatio,headroomBytes,cpuRatio,eventLoopDelayMs,at:now,usage,memoryLimitBytes,memoryUsedBytes,memoryScope,cpuCores,cgroupVersion,resourceWarnings};
}
