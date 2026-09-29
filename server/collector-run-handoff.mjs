import {randomUUID} from 'node:crypto';

const failure=error=>({code:String(error?.code||'COLLECTOR_HANDOFF_FAILED').slice(0,120),message:String(error?.message||'自动发送未完成，请重试发送').slice(0,500)});
export function handoffSummary(body={},status='PENDING') {
  const receipts=Object.values(body.receipts||{}),errors=receipts.filter(r=>r.status==='FAILED').map(r=>r.error);
  if(body.error)errors.push(body.error);
  return{status,processed:receipts.filter(r=>r.status==='DONE').length,
    created:new Set(receipts.flatMap(r=>r.createdTaskIds||[])).size,reused:new Set(receipts.flatMap(r=>r.reusedTaskIds||[])).size,
    blocked:receipts.filter(r=>r.status==='FAILED').length,errors:errors.slice(0,50),
    collectItemIds:[...new Set(receipts.filter(r=>r.status==='DONE'&&r.collectItemId).map(r=>r.collectItemId))]};
}

export function createCollectorHandoffRepository(pool) {
  async function save(row,body,status,nextRunAt=null) {
    const client=await pool.connect();
    try{
      await client.query('BEGIN');
      const result=await client.query(`UPDATE collector_run_handoffs SET body=$4::jsonb,status=$5,updated_at=NOW(),
        next_run_at=COALESCE($6::timestamptz,NOW()+INTERVAL '1 second'),lease_token=CASE WHEN $5='PROCESSING' THEN lease_token ELSE NULL END,
        lease_expires_at=CASE WHEN $5='PROCESSING' THEN NOW()+INTERVAL '3 minutes' ELSE NULL END
        WHERE run_id=$1 AND account_id=$2 AND lease_token=$3 RETURNING run_id`,[row.runId,row.accountId,row.token,JSON.stringify(body),status,nextRunAt==null?null:new Date(nextRunAt)]);
      if(!result.rowCount){await client.query('ROLLBACK');return false;}
      await client.query(`UPDATE collector_task_runs SET result_summary=jsonb_set(result_summary,'{handoff}',$3::jsonb),updated_at=NOW()
        WHERE id=$1 AND account_id=$2`,[row.runId,row.accountId,JSON.stringify(handoffSummary(body,status))]);
      await client.query('COMMIT');return true;
    }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  }
  return{save,
    async claim(){const token=randomUUID();const row=(await pool.query(`WITH next AS (
      SELECT run_id FROM collector_run_handoffs WHERE (status='PENDING' AND next_run_at<=NOW())
        OR (status='PROCESSING' AND lease_expires_at<NOW()) ORDER BY updated_at,run_id FOR UPDATE SKIP LOCKED LIMIT 1)
      UPDATE collector_run_handoffs h SET status='PROCESSING',lease_token=$1,lease_expires_at=NOW()+INTERVAL '3 minutes',updated_at=NOW()
      FROM next WHERE h.run_id=next.run_id RETURNING h.*`,[token])).rows[0];
      return row?{runId:row.run_id,accountId:row.account_id,body:row.body,token}:null;},
    async renew(row){return Boolean((await pool.query(`UPDATE collector_run_handoffs SET lease_expires_at=NOW()+INTERVAL '3 minutes'
      WHERE run_id=$1 AND account_id=$2 AND lease_token=$3`,[row.runId,row.accountId,row.token])).rowCount);},
  };
}

export function createCollectorRunHandoffWorker({repository,readRun,listItems,addSelected,createTasks,batchSize=10,clock=Date.now}) {
  let running=false,timer,active;
  async function work(){
    const row=await repository.claim();if(!row)return;
    const body=structuredClone(row.body||{receipts:{}});body.receipts||={};let leaseLost=false,renewal=Promise.resolve();
    const heartbeat=repository.renew?setInterval(()=>{renewal=renewal.then(async()=>{if(!await repository.renew(row))leaseLost=true;}).catch(()=>{leaseLost=true;});},30000):null;
    heartbeat?.unref?.();
    const save=async (status,nextRunAt)=>{if(leaseLost||!await repository.save(row,body,status,nextRunAt))throw Object.assign(new Error('交接执行权已转移'),{code:'COLLECTOR_HANDOFF_LEASE_LOST'});};
    try{
      const run=await readRun({accountId:row.accountId,runId:row.runId});
      if(run?.status!=='COMPLETED'||run.configurationSnapshot?.configuration?.autoSendToAiListing!==true){
        body.error={code:'COLLECTOR_HANDOFF_NOT_ELIGIBLE',message:'采集运行未完成或未启用自动发送'};await save('FAILED');return;
      }
      const all=[];
      for(let offset=0;;offset+=500){const page=await listItems({accountId:row.accountId,runId:row.runId,status:'QUALIFIED',view:'identity',offset,limit:500});all.push(...page);if(page.length<500)break;}
      delete body.error;
      const pending=all.filter(item=>!['DONE','FAILED'].includes(body.receipts[item.id]?.status));
      for(const item of pending.slice(0,batchSize)){
        if(leaseLost)break;
        let receipt=body.receipts[item.id];
        try{
          if(!receipt?.collectItemId){
            const imported=await addSelected({accountId:row.accountId,runId:row.runId,itemIds:[item.id]});
            if(imported.errors?.length||imported.missing?.length)throw Object.assign(new Error(imported.errors?.[0]?.message||'采集商品尚未完整入库'),{code:imported.errors?.[0]?.code});
            const result=imported.results?.find(result=>result.collectorItemId===item.id);
            if(result?.skipped){body.receipts[item.id]={status:'DONE',skipped:true};await save('PROCESSING');continue;}
            if(!result?.collectItemId)throw new Error('采集入库回执缺少商品 ID');
            receipt=body.receipts[item.id]={status:'COLLECTED',collectItemId:result.collectItemId};await save('PROCESSING');
          }
          if(run.configurationSnapshot.configuration.autoStartAiGeneration!==true){receipt.status='DONE';await save('PROCESSING');continue;}
          if(leaseLost)break;
          const result=await createTasks({accountId:row.accountId,runId:row.runId,collectItemIds:[receipt.collectItemId]});
          receipt.createdTaskIds=[...new Set([...(receipt.createdTaskIds||[]),...(result.results||[]).flatMap(source=>source.createdTaskIds||[])])];
          receipt.reusedTaskIds=[...new Set([...(receipt.reusedTaskIds||[]),...(result.results||[]).flatMap(source=>source.reusedTaskIds||[])])];
          if(result.errors?.length)throw Object.assign(new Error(result.errors[0].message||'AI 任务尚未创建'),{code:result.errors[0].code});
          receipt.status='DONE';delete receipt.error;delete body.attempts;
        }catch(error){
          if(error.code==='COLLECTOR_HANDOFF_LEASE_LOST')throw error;
          if(error?.code==='RFBS_VALIDATION_REQUIRED' && error.retryable===true && error.definitelyNotCreated===true){
            body.attempts=(Number(body.attempts)||0)+1;body.error=failure(error);
            body.receipts[item.id]={...receipt,status:'COLLECTED',error:body.error};
            if(body.attempts<3){await save('PENDING',clock()+(body.attempts===1?5000:30000));return;}
            body.error.message='RFBS 仓库连续 3 次验证未完成，自动发送已停止；商品已保留，请核查仓库后重试发送';
            body.receipts[item.id].status='FAILED';
            await save(Object.values(body.receipts).some(receipt=>receipt.status==='DONE')?'PARTIAL':'FAILED');return;
          }
          body.receipts[item.id]={...receipt,status:'FAILED',error:failure(error)};
        }
        await save('PROCESSING');
      }
      const remains=all.some(item=>!['DONE','FAILED'].includes(body.receipts[item.id]?.status));
      const failed=Object.values(body.receipts).some(receipt=>receipt.status==='FAILED');
      await save(remains?'PENDING':failed?(Object.values(body.receipts).some(r=>r.status==='DONE')?'PARTIAL':'FAILED'):'COMPLETED');
    }catch(error){
      if(error.code!=='COLLECTOR_HANDOFF_LEASE_LOST'){
        body.attempts=(body.attempts||0)+1;body.error=failure(error);
        await save(body.attempts<3?'PENDING':'FAILED').catch(()=>{});
      }
    }finally{clearInterval(heartbeat);await renewal;}
  }
  async function tick(){if(active)return active;active=work();try{await active;}finally{active=null;}}
  async function loop(){try{await tick();}catch{console.warn('[collector-handoff] recovery deferred');}finally{if(running){timer=setTimeout(loop,1000);timer.unref?.();}}}
  return{tick,start(){if(running)return;running=true;void loop();},async stop(){running=false;clearTimeout(timer);await active;}};
}
