import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';

test('production proxy preserves API and media requests after the API changes IP', {
  skip:process.env.SONLI_PROXY_TESTS!=='1',
},async t=>{
  const prefix='ozon-proxy-test-'+randomUUID().slice(0,8);
  const docker=(...args)=>execFileSync('docker',args,{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  const containers=[];
  docker('network','create',prefix);
  t.after(()=>{for(const c of containers.reverse())try{docker('rm','-f',c);}catch{}docker('network','rm',prefix);});
  const stub=`require('http').createServer((req,res)=>{let body='';req.on('data',b=>body+=b);req.on('end',()=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({generation:process.env.GENERATION,url:req.url,method:req.method,host:req.headers.host,proto:req.headers['x-forwarded-proto'],body}));});}).listen(3001,'0.0.0.0')`;
  function api(generation,ip){const name=prefix+'-'+generation;containers.push(name);docker('run','-d','--name',name,'--network',prefix,'--network-alias','api',...(ip?['--ip',ip]:[]),'-e','GENERATION='+generation,'node:22-alpine','node','-e',stub);return name;}
  const old=api('before');
  const oldIp=JSON.parse(docker('inspect',old))[0].NetworkSettings.Networks[prefix].IPAddress;
  const gateway=prefix+'-web';containers.push(gateway);
  const conf=fileURLToPath(new URL('../../deploy/production/nginx.conf',import.meta.url));
  docker('run','-d','--name',gateway,'--network',prefix,'-p','127.0.0.1::80','-v',conf+':/etc/nginx/conf.d/default.conf:ro',process.env.SONLI_TEST_NGINX_IMAGE||'nginx:1.27.5-alpine');
  const port=JSON.parse(docker('inspect',gateway))[0].NetworkSettings.Ports['80/tcp'][0].HostPort;
  const base='http://127.0.0.1:'+port;
  async function generation(want){
    // This bounds this isolated recovery assertion, never a collection job.
    for(let i=0;i<150;i++){
      try{const res=await fetch(base+'/api/local/probe');if(res.ok){const value=await res.json();if(value.generation===want)return;}}catch{}
      await delay(100);
    }
    throw new Error('proxy did not route to API generation '+want);
  }
  await generation('before');
  async function verify(want){
    const res=await fetch(base+'/api/local/probe?sku=2102713933&value=a%2Bb',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"value":"fixture"}'});
    assert.equal(res.status,200);assert.deepEqual(await res.json(),{generation:want,url:'/local/probe?sku=2102713933&value=a%2Bb',method:'POST',host:'127.0.0.1',proto:'https',body:'{"value":"fixture"}'});
    const media=await fetch(base+'/listing-media/v1/a%20b?signature=a%2Bb');assert.equal(media.status,200);const value=await media.json();assert.equal(value.url,'/listing-media/v1/a%20b?signature=a%2Bb');assert.equal(value.generation,want);
  }
  await verify('before');
  docker('network','disconnect',prefix,old);
  // Keep the old IP reachable with an identifiable response, but remove its api alias.
  docker('network','connect','--ip',oldIp,prefix,old);
  const newIp=oldIp.replace(/\.\d+$/,'.20');api('after',newIp);
  await generation('after');await verify('after');
  t.diagnostic(JSON.stringify({beforeIp:oldIp,afterIp:newIp,gatewayRecreated:false}));
});
