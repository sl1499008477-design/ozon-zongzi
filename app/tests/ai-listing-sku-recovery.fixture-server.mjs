// Local UI acceptance only: all /qa-api requests terminate in this in-memory fixture.
import {createServer} from 'vite';
import {fileURLToPath} from 'node:url';
import {mkdir,writeFile} from 'node:fs/promises';

const auditFile=new URL('../../outputs/qa/2026-09-25-ai-recovery-fix/ui-retry-requests.json',import.meta.url);
const image='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="180" height="240"><rect width="180" height="240" fill="#edf4ff"/><text x="90" y="120" font-size="18" fill="#005af8" text-anchor="middle">UI QA</text></svg>');
let task={id:'sku-recovery-qa',version:1,name:'[本机验收] 混合 SKU 恢复',sku:'QA-COMPLETE',status:'GENERATION_FAILED',
  sourceType:'COLLECT_BOX',collectionSource:{type:'COLLECTOR_ASSISTANT',taskNames:['本机验收，不运行真实任务']},
  createdAt:'2026-09-25T00:00:00.000Z',updatedAt:'2026-09-25T00:00:00.000Z',thumbnail:image,
  config:{targetStoreId:'qa-store',salePricingId:'qa-pricing',generationMode:'GRID'},taskActions:{retry:true,delete:true},
  progress:{completed:2,total:5},errorMessage:'本机验收夹具；展示状态并记录请求，不执行生图或上架。',
  skuProgress:[
    {sku:'QA-COMPLETE',total:1,completed:1,status:'COMPLETED'},
    {sku:'QA-SKIP',total:1,completed:0,status:'SKIPPED',reason:'缺少绿标价，当前配置已关闭黑标价替代，仅跳过此 SKU'},
    {sku:'QA-UNKNOWN',total:1,completed:0,status:'RESULT_UNKNOWN',reason:'网关响应中断，原请求待核实'},
    {sku:'QA-GRID',total:1,completed:0,status:'GENERATION_FAILED',reason:'拼图分隔带不完整'},
    {sku:'QA-BLACK',total:1,completed:1,status:'READY',priceBasis:'BLACK_PRICE_FALLBACK',usedBlackPriceFallback:true},
  ],
  images:[
    {sku:'QA-COMPLETE',index:0,status:'COMPLETED',sourceUrl:image,generatedUrl:image},
    {sku:'QA-SKIP',index:0,status:'SKIPPED',sourceUrl:image,errorMessage:'缺少绿标价，已跳过'},
    {sku:'QA-UNKNOWN',index:0,status:'RESULT_UNKNOWN',sourceUrl:image,errorMessage:'网关响应中断',lastError:{code:'AI_GATEWAY_UNEXPECTED_EOF',diagnostic:{status:502,requestId:'qa-request-unknown'}}},
    {sku:'QA-GRID',index:0,status:'GENERATION_FAILED',sourceUrl:image,errorMessage:'拼图分隔带不完整',paidResultRetained:true,lastError:{code:'AI_LISTING_GRID_GEOMETRY_INVALID',diagnostic:{stage:'slicing',actual:{width:1536,height:1024},detected:{verticalBands:1,horizontalBands:2}}}},
    {sku:'QA-BLACK',index:0,status:'COMPLETED',sourceUrl:image,generatedUrl:image},
  ],
};
const requests=[];
let completedTask={...task,id:'sku-recovery-completed-qa',name:'[本机验收] 已上架，有跳过 SKU',status:'COMPLETED',
  progress:{completed:1,total:2},skuProgress:task.skuProgress.slice(0,2),images:task.images.slice(0,2),taskActions:{retry:true}};
const allCompletedTask={...completedTask,id:'all-completed-qa',sku:'QA-ALL-COMPLETE',name:'[本机验收] 所有 SKU 均已上架',taskActions:{},
  progress:{completed:1,total:1},skuProgress:task.skuProgress.slice(0,1),images:task.images.slice(0,1)};
const noProfileTask={...task,id:'no-profile-recovery-qa',sku:'QA-NO-PROFILE',name:'[本机验收] 部分上架，无售价配置',config:{generationMode:'GRID',targetStoreId:'qa-store'}};
const server=await createServer({root:fileURLToPath(new URL('..',import.meta.url)),logLevel:'error',server:{host:'127.0.0.1',port:5187,strictPort:true},
  plugins:[{name:'sku-recovery-isolated-qa',configureServer(vite){vite.middlewares.use(async(req,res,next)=>{
    const url=new URL(req.url,'http://127.0.0.1');if(!url.pathname.startsWith('/qa-api/'))return next();
    const path=url.pathname.slice('/qa-api'.length);
    const send=(data,status=200)=>{res.statusCode=status;res.setHeader('Content-Type','application/json;charset=utf-8');res.end(JSON.stringify(data));};
    if(path==='/audit')return send({notice:'只记录夹具请求，不运行真实业务',requests});
    if(path==='/ai-listing/tasks'&&url.searchParams.get('view')==='completed')return send({tasks:[completedTask,allCompletedTask,task,noProfileTask],total:4,limit:5,offset:0});
    if(path==='/ai-listing/tasks')return send({tasks:url.searchParams.get('group')==='errors'?[task]:[],total:url.searchParams.get('group')==='errors'?1:0,counts:{all:1,active:0,paused:0,failed:0,errors:1,cancelled:0,deleted:0},limit:5,offset:0});
    if(path===`/ai-listing/tasks/${task.id}`)return send({task});
    if(path===`/ai-listing/tasks/${completedTask.id}`)return send({task:completedTask});
    if(path===`/ai-listing/tasks/${allCompletedTask.id}`)return send({task:allCompletedTask});
    if(path===`/ai-listing/tasks/${noProfileTask.id}`)return send({task:noProfileTask});
    if([`/ai-listing/tasks/${task.id}/retry`,`/ai-listing/tasks/${completedTask.id}/retry`,`/ai-listing/tasks/${noProfileTask.id}/retry`].includes(path)&&req.method==='POST'){
      let raw='';for await(const chunk of req)raw+=chunk;
      const body=JSON.parse(raw||'{}');requests.push({path,method:req.method,body,at:new Date().toISOString()});
      await mkdir(new URL('.',auditFile),{recursive:true});await writeFile(auditFile,JSON.stringify(requests,null,2));
      if(path.includes(completedTask.id)){
        if(body.refreshSalePricing!==true)return send({message:'恢复跳过项必须使用当前售价配置'},422);
        completedTask={...completedTask,version:completedTask.version+1};return send({task:completedTask});
      }
      if(path.includes(noProfileTask.id))return send({task:noProfileTask});
      task={...task,version:task.version+1,errorMessage:'本机验收：已记录重试参数，不执行生图或上架。'};return send({task});
    }
    if(path==='/ai-listing/capabilities')return send({grid:{available:true}});
    if(path==='/ai-listing/channels')return send({total:1,active:1,idle:1,busy:0,cooldown:0,recovery:0,manual:0,disabled:0});
    if(path==='/ai-listing/pricing-profiles')return send({items:[{id:'qa-pricing',name:'缺绿用黑',currency:'CNY',salePriceFormula:'真实售价 * 2',useBlackPriceWhenGreenMissing:true,updatedAt:'2026-09-25T00:00:00.000Z'}],defaultRealPricing:{id:'qa-real',currency:'CNY',realPriceFormula:'(黑标价 - 绿标价) * 2.25 + 黑标价',isDefault:true}});
    if(path.startsWith('/ai-listing/presets/'))return send({items:[]});
    if(path.endsWith('/quota'))return send({available:100});
    return send({message:'验收夹具未提供此操作，未调用真实 API'},404);
  });}}],
});
await server.listen();
console.log('AI recovery fixture: http://127.0.0.1:5187/tests/ai-listing-task-controls.fixture.html');
console.log('Pricing fixture: http://127.0.0.1:5187/tests/sale-pricing.fixture.html');
console.log('Completed fixture: http://127.0.0.1:5187/tests/ai-listing-completed-recovery.fixture.html');
console.log('Retry audit: http://127.0.0.1:5187/qa-api/audit');
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,async()=>{await server.close();process.exit(0);});
