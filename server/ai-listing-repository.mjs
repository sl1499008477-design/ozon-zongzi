import { taskActions, taskActionReason } from './ai-listing-task-controls.mjs';
import {skuProgress} from './ai-listing-sku-state.mjs';
import {aiListingStageSql} from './ai-listing-stages.mjs';
// This feature owns its task records and generation-account turn ledger.
function fromRow(row) {
  if (!row) return null;
  return { ...row.body, id: row.id, accountId: row.account_id, dedupeKey: row.dedupe_key,
    workPhase: row.work_phase, queuePosition: Number(row.queue_position), status: row.status, version: row.version, nextRunAt: Number(row.next_run_at),
    controlAction: row.control_action || null, deletedAt: row.deleted_at == null ? null : Number(row.deleted_at),
    leaseToken: row.lease_token, leaseExpiresAt: row.lease_expires_at == null ? null : Number(row.lease_expires_at) };
}
function body(task) {
  const { version, leaseToken, leaseExpiresAt, workPhase, queuePosition, controlAction, deletedAt, ...record } = task;
  return JSON.stringify({...record,skuProgress:skuProgress(task)});
}
const runnable = new Set(['QUEUED','COLLECTING','GENERATING','READY_TO_SUBMIT','SUBMITTING','SUBMITTED']);
const taskGroup = `CASE
  WHEN deleted_at IS NOT NULL THEN 'deleted'
  WHEN status IN ('QUEUED','COLLECTING','GENERATING','AWAITING_REVIEW','READY_TO_SUBMIT','SUBMITTING','SUBMITTED') THEN 'active'
  WHEN status='PAUSED' THEN 'paused'
  WHEN status='SUBMISSION_FAILED' AND NOT COALESCE((list_summary#>>'{priceFailure,code}'='PRICE_FINAL_NOT_POSITIVE' AND COALESCE(list_summary->>'submissionId','')='' AND COALESCE((list_summary#>>'{_list,submissionResultCount}')::int,0)=0),false) THEN 'failed'
  WHEN status='CANCELLED' THEN 'cancelled' ELSE 'errors' END`;
export function aiListingWorkPhase(task) {
  if (!runnable.has(task.status)) return 'idle';
  if (['SUBMITTING','SUBMITTED','READY_TO_SUBMIT'].includes(task.status)) return 'finalize';
  if (!task.source || (task.importBatchId && !task.importGrouped)) return 'prepare';
  return task.images.some(image => !image.generatedUrl) ? 'generate' : 'finalize';
}
// A slow count, page or provenance lookup shares the same eight-second budget.
// PostgreSQL cancels the running statement; a timed-out HTTP client must not leave
// a query scanning in the background. ROLLBACK also restores the pooled session.
async function readListingWithinDeadline(pool, run) {
  const deadline=Date.now()+8000;
  const timeoutError=()=>Object.assign(new Error('AI listing read deadline exceeded'),{code:'57014'});
  let acquisitionExpired=false,acquisitionTimer,client;
  try {
    client=await Promise.race([
      Promise.resolve().then(()=>pool.connect()).then(acquired=>{
        if(acquisitionExpired){acquired.release();return null;}
        return acquired;
      }),
      new Promise((_,reject)=>{acquisitionTimer=setTimeout(()=>{
        acquisitionExpired=true;reject(timeoutError());
      },Math.max(1,deadline-Date.now()));}),
    ]);
  } finally {clearTimeout(acquisitionTimer);}
  let cleanupError;
  try {
    await client.query('BEGIN READ ONLY');
    const query=async (sql,values)=>{
      const remaining=deadline-Date.now();
      if(remaining<=0)throw timeoutError();
      await client.query("SELECT set_config('statement_timeout',$1,true)",[`${remaining}ms`]);
      return client.query(sql,values);
    };
    return await run({query});
  } finally {
    try {await client.query('ROLLBACK');}catch(error){cleanupError=error;}
    client.release(cleanupError);
  }
}
export function createAiListingRepository({ pool }) {
  // A borrowed submission/purge session has a lock, but no open transaction.
  // Keep this transaction atomic without checking out or releasing another slot.
  async function transaction(run, borrowedClient) {
    const client = borrowedClient || await pool.connect();
    try { await client.query('BEGIN'); const result = await run(client); await client.query('COMMIT'); return result; }
    catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { if(!borrowedClient)client.release(); }
  }
  async function insert(client, task) {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`ai-listing-purge-admission:${task.accountId}`]);
    const purging = await client.query(`SELECT 1 FROM ai_image_listing_tasks WHERE account_id=$1
      AND body->'purge' IS NOT NULL AND body->>'permanentlyDeletedAt' IS NULL
      AND (body->>'sourceId'=$2 OR body#>>'{source,collectItemId}'=$2) LIMIT 1`, [task.accountId,task.source?.collectItemId || task.sourceId]);
    if(purging.rowCount) throw Object.assign(new Error('来源商品正在永久清理'),{code:'AI_LISTING_TASK_CONFLICT',statusCode:409});
    const result = await client.query(`INSERT INTO ai_image_listing_tasks
      (id,account_id,dedupe_key,status,body,next_run_at,created_at,work_phase)
      VALUES ($1,$2,$3,$4,jsonb_set($5::jsonb,'{config,ozonRoute}',to_jsonb(COALESCE((SELECT route FROM account_ozon_routes WHERE account_id=$2),'CN')::text)),$6,$7,$8)
      ON CONFLICT (account_id,dedupe_key) DO NOTHING RETURNING *`,
    [task.id,task.accountId,task.dedupeKey,task.status,body(task),task.nextRunAt,task.createdAt,aiListingWorkPhase(task)]);
    return fromRow(result.rows[0] || (await client.query('SELECT * FROM ai_image_listing_tasks WHERE account_id=$1 AND dedupe_key=$2',[task.accountId,task.dedupeKey])).rows[0]);
  }
  async function readCollectorAutomaticOwners(client, { accountId, skus }) {
    if (!skus.length) return new Map();
    const saved = await client.query(`SELECT owner.source_sku,task.* FROM collector_ai_sku_owners owner
      JOIN ai_image_listing_tasks task ON task.id=owner.task_id AND task.account_id=owner.account_id
      WHERE owner.account_id=$1 AND owner.source_sku=ANY($2::text[])`, [accountId, skus]);
    const owners = new Map(saved.rows.map(row => [row.source_sku, fromRow(row)]));
    const mergedIds = [...new Set([...owners.values()].filter(task => task.status === 'MERGED').map(task => task.mergedTaskId).filter(Boolean))];
    if (mergedIds.length) {
      const canonical = new Map((await client.query('SELECT * FROM ai_image_listing_tasks WHERE account_id=$1 AND id=ANY($2::text[])',
        [accountId, mergedIds])).rows.map(row => [row.id, fromRow(row)]));
      for (const [sku, task] of owners) {
        const merged = canonical.get(task.mergedTaskId);
        if (task.status === 'MERGED' && merged && merged.status !== 'MERGED' && merged.importBatchId === task.importBatchId) owners.set(sku, merged);
      }
    }
    const missing = skus.filter(sku => !owners.has(sku));
    if (!missing.length) return owners;
    // Historical tasks predate automatic-owner metadata. Their exact Ozon SKU, including an admitted
    // Seller wait or Ozon-only Excel request, protects work even when its old collect root differs.
    const history = await client.query(`SELECT task.* FROM ai_image_listing_tasks task
      LEFT JOIN collect_items collect ON collect.id=task.body->>'sourceId' AND collect.account_id=task.account_id
      WHERE task.account_id=$1 AND task.status<>'MERGED' AND task.body->>'permanentlyDeletedAt' IS NULL
        AND (task.body#>'{source,items}' @> ANY($3::jsonb[])
          OR task.body#>'{collectWait,selectedSkus}' ?| $2::text[]
          OR (task.body->>'sourceType'='EXCEL' AND task.body->>'sourceId'=ANY($2::text[])))
        AND lower(COALESCE(NULLIF(task.body#>>'{source,sourceSnapshot,source}',''),
          NULLIF(task.body#>>'{collectWait,initialSource,sourceSnapshot,source}',''),collect.source,
          CASE WHEN task.body->>'sourceType'='EXCEL' THEN 'ozon' END)) IN ('ozon','auto_listing_excel_sku')
      ORDER BY task.created_at,task.id`, [accountId, missing, missing.map(sku => JSON.stringify([{sku}]))]);
    const candidates = new Map(), requested = new Set(missing);
    for (const row of history.rows) {
      const task = fromRow(row);
      const taskSkus = new Set([...(task.source?.items || []).map(item => item.sku), ...(task.collectWait?.selectedSkus || []),
        ...(task.sourceType === 'EXCEL' ? [task.sourceId] : [])]);
      for (const sku of taskSkus) {
        if (!requested.has(sku)) continue;
        const images = (task.images || []).filter(image => image.sku === sku);
        const rank = images.length && images.every(image => image.generatedUrl) ? 0 : runnable.has(task.status) ? 1 : 2;
        if (!candidates.has(sku) || rank < candidates.get(sku).rank) candidates.set(sku, { task, rank });
      }
    }
    for (const [sku, {task}] of candidates) owners.set(sku, task);
    return owners;
  }
  async function readCollectionSources(client, { accountId, taskIds }) {
    if (!taskIds.length) return new Map();
    const {rows} = await client.query(`WITH sources AS MATERIALIZED (
      SELECT id,list_summary->>'sourceType' AS source_type,
        list_summary#>>'{_list,collectionSource,collectId}' AS collect_id,created_at,
        list_summary#>>'{_list,collectionSource,runId}' AS run_id,
        list_summary#>'{_list,collectionSource}' AS snapshot
      FROM ai_image_listing_tasks WHERE account_id=$1 AND id=ANY($2::text[])
    ), desktop AS MATERIALIZED (
      SELECT s.id,t.name FROM sources s
      JOIN collector_task_runs r ON r.id=s.run_id AND r.account_id=$1
      JOIN collector_tasks t ON t.id=r.task_id AND t.account_id=$1
      UNION
      SELECT s.id,t.name FROM sources s
      JOIN collector_task_items i ON i.collect_item_id=s.collect_id AND i.account_id=$1
        AND i.created_at<=to_timestamp(s.created_at/1000.0)
      JOIN collector_tasks t ON t.id=i.task_id AND t.account_id=$1
      WHERE s.run_id IS NULL AND s.source_type='COLLECT_BOX'
    ) SELECT s.id,
      CASE WHEN s.source_type='EXCEL' OR upper(s.snapshot->>'source')='AUTO_LISTING_EXCEL_SKU' THEN 'EXCEL'
        WHEN EXISTS(SELECT 1 FROM desktop d WHERE d.id=s.id) THEN 'COLLECTOR_ASSISTANT'
        WHEN EXISTS(SELECT 1 FROM ozon_web_collection_jobs w WHERE w.account_id=$1 AND w.status='COMPLETED'
          AND w.result->>'collectItemId'=s.collect_id AND w.created_at<=to_timestamp(s.created_at/1000.0)) THEN 'WEB_EXTENSION'
        WHEN NULLIF(s.snapshot->>'extensionVersion','') IS NOT NULL THEN 'EXTENSION'
        ELSE 'COLLECT_BOX' END AS type,
      ARRAY(SELECT DISTINCT d.name FROM desktop d WHERE d.id=s.id ORDER BY d.name) AS task_names
      FROM sources s`, [accountId, taskIds]);
    return new Map(rows.map(row => [row.id, {type:row.type,taskNames:row.task_names}]));
  }
  return {
    async create(task) { return transaction(client=>insert(client, task)); },
    async readCollectorAutomaticOwners(input) { return readCollectorAutomaticOwners(pool, input); },
    async createCollectorAutomatic({ accountId, skus, prepare }) {
      return transaction(async client => {
        // The lock covers only local preparation and inserts, never source reads or external requests.
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`collector-auto-ai:${accountId}:ozon`]);
        const owners = await readCollectorAutomaticOwners(client, { accountId, skus });
        const prepared = await prepare(skus.filter(sku => !owners.has(sku)), owners);
        const createdTaskIds = [];
        for (const task of prepared) {
          const saved = await insert(client, task);
          if (saved.requestHash !== task.requestHash) throw Object.assign(new Error('相同自动任务的配置不能更改'), {code:'AI_LISTING_IDEMPOTENCY_CONFLICT',statusCode:409});
          createdTaskIds.push(saved.id);
          for (const sku of task.collectorAuto.skus) owners.set(sku, saved);
        }
        if (owners.size) await client.query(`INSERT INTO collector_ai_sku_owners(account_id,source_sku,task_id)
          SELECT $1,source_sku,task_id FROM unnest($2::text[],$3::text[]) AS owner(source_sku,task_id)
          ON CONFLICT(account_id,source_sku) DO UPDATE SET task_id=EXCLUDED.task_id
          WHERE collector_ai_sku_owners.task_id<>EXCLUDED.task_id`, [accountId, [...owners.keys()], [...owners.values()].map(task => task.id)]);
        return { owners, createdTaskIds };
      });
    },
    async createBatch(tasks) {
      return transaction(async client => {
        const first=tasks[0];
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`ai-import:${first.accountId}:${first.importBatchId}`]);
        const existing=(await client.query("SELECT body FROM ai_image_listing_tasks WHERE account_id=$1 AND body->>'importBatchId'=$2 LIMIT 1",[first.accountId,first.importBatchId])).rows[0];
        if(existing && existing.body.importRequestHash!==first.importRequestHash) throw Object.assign(new Error('相同请求标识的 SKU 或配置不能更改'),{code:'AI_LISTING_IDEMPOTENCY_CONFLICT',statusCode:409});
        const saved=[];
        for(const task of tasks) {
          const row=await insert(client,task);
          if(row.requestHash!==task.requestHash) throw Object.assign(new Error('相同请求标识的配置不能更改'),{code:'AI_LISTING_IDEMPOTENCY_CONFLICT',statusCode:409});
          saved.push(row);
        }
        return saved;
      });
    },
    async finalizeImportBatch({accountId,importBatchId,now,merge}) {
      return transaction(async client=>{
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`ai-import:${accountId}:${importBatchId}`]);
        const rows=(await client.query("SELECT * FROM ai_image_listing_tasks WHERE account_id=$1 AND body->>'importBatchId'=$2 ORDER BY queue_position FOR UPDATE",[accountId,importBatchId])).rows.map(fromRow);
        // Each row was inserted in one transaction. No network work happens under these locks.
        if(rows.some(row=>!row.importGrouped && runnable.has(row.status) && (!row.source || (row.leaseToken && row.leaseExpiresAt>now))))return;
        const changed=merge(rows);
        for(const task of changed) await client.query(`UPDATE ai_image_listing_tasks SET status=$3,
          body=$4::jsonb || CASE WHEN body ? 'mediaKeys' THEN jsonb_build_object('mediaKeys',body->'mediaKeys') ELSE '{}'::jsonb END,
          work_phase=$5,next_run_at=$6,version=version+1
          WHERE account_id=$1 AND id=$2 AND version=$7`,[accountId,task.id,task.status,body(task),aiListingWorkPhase(task),task.nextRunAt,task.version]);
      });
    },
    async get({ accountId, taskId, client=pool }) {
      return fromRow((await client.query("SELECT * FROM ai_image_listing_tasks WHERE account_id=$1 AND id=$2", [accountId, taskId])).rows[0]);
    },
    async getMany({ accountId, taskIds }) {
      if (!taskIds.length) return [];
      return (await pool.query("SELECT * FROM ai_image_listing_tasks WHERE account_id=$1 AND id=ANY($2::text[])",
        [accountId, taskIds])).rows.map(fromRow);
    },
    async list({ accountId }) {
      return (await pool.query("SELECT * FROM ai_image_listing_tasks WHERE account_id=$1 AND status<>'MERGED' AND deleted_at IS NULL ORDER BY created_at DESC,id", [accountId])).rows.map(fromRow);
    },
    async listActionCandidates({ accountId, group }) {
      const {rows} = await pool.query(`SELECT id,version,status,control_action AS "controlAction",
        body->>'submissionId' AS "submissionId",body->'submissionStarted' AS "submissionStarted",
        body->>'submissionStage' AS "submissionStage",body->'submissionExternalWriteStarted' AS "submissionExternalWriteStarted",
        deleted_at AS "deletedAt",body->>'stoppedFrom' AS "stoppedFrom"
        FROM ai_image_listing_tasks WHERE account_id=$1
          AND status NOT IN ('MERGED','COMPLETED') AND body->'purge' IS NULL AND body->>'permanentlyDeletedAt' IS NULL AND (${taskGroup})=$2 ORDER BY queue_position,id`, [accountId, group]);
      return rows;
    },
    async readCollectionSources(input) { return readCollectionSources(pool, input); },
    async listPage({ accountId, view = 'tasks', storeId = '', group = 'all', stage = '', limit = 50, offset = 0, includeCollectionSources = false }) {
      limit = Math.max(1, Math.min(100, Number.parseInt(limit, 10) || 50));
      offset = Math.max(0, Math.min(2147483647, Number.parseInt(offset, 10) || 0));
      if(stage&&view!=='tasks')throw Object.assign(Error('仅任务列表支持阶段筛选'),{status:400,code:'AI_LISTING_INVALID_INPUT'});
      const stageFilter=stage?aiListingStageSql(stage):null;
      const readPage = async client => {
        const where = `account_id=$1 AND list_summary#>>'{_list,permanentlyDeletedAt}' IS NULL AND status<>'MERGED' AND ${view === 'completed' ? `(status='COMPLETED' OR (list_summary->>'completedSkuCount')::int>0) AND deleted_at IS NULL AND COALESCE(list_summary#>>'{submissionTarget,targetStoreId}',list_summary#>>'{config,targetStoreId}')=$2` : "status<>'COMPLETED' AND ($2::text='' OR TRUE)"}`;
        const purging="deleted_at IS NOT NULL AND COALESCE(list_summary#>>'{purge,state}','') IN ('PENDING','RUNNING')";
        if(view==='completed')group='all';
        const selectedCount=stageFilter?`,COUNT(*) FILTER(WHERE deleted_at IS NULL AND (${stageFilter}) AND ($3='all' OR (${taskGroup})=$3))::int AS stage_total`:'';
        const count = await client.query(`SELECT COUNT(*) FILTER(WHERE deleted_at IS NULL)::int AS total, COUNT(*) FILTER(WHERE (${taskGroup})='active')::int AS active, COUNT(*) FILTER(WHERE (${taskGroup})='paused')::int AS paused, COUNT(*) FILTER(WHERE (${taskGroup})='failed')::int AS failed, COUNT(*) FILTER(WHERE (${taskGroup})='errors')::int AS errors, COUNT(*) FILTER(WHERE (${taskGroup})='cancelled')::int AS cancelled, COUNT(*) FILTER(WHERE deleted_at IS NOT NULL)::int AS deleted, COUNT(*) FILTER(WHERE ${purging})::int AS purging${selectedCount} FROM ai_image_listing_tasks WHERE ${where}`, stageFilter?[accountId, storeId,group]:[accountId, storeId]);
        const page = await client.query(`SELECT (list_summary - '_list') || jsonb_build_object(
            'id',id,'status',status,'version',version,'controlAction',control_action,'deletedAt',deleted_at,
            'createdAt',to_timestamp(created_at/1000.0),'updatedAt',to_timestamp((list_summary->>'updatedAt')::numeric/1000.0)
          ) AS summary FROM ai_image_listing_tasks WHERE ${where} AND NOT(${purging}) AND (($5::text='all' AND deleted_at IS NULL) OR (${taskGroup})=$5)
          ${stageFilter?`AND deleted_at IS NULL AND (${stageFilter})`:''}
          ORDER BY ${view === 'tasks' ? `CASE
            WHEN status='GENERATING' AND lease_token IS NOT NULL
              AND lease_expires_at>extract(epoch FROM now())*1000
              AND (list_summary->>'generationStage' IN ('preparing','image','slicing','saving')
                OR (COALESCE(list_summary->>'generationStage','')='' AND (list_summary#>>'{_list,hasGeneratingImage}')::boolean))
              THEN 0
            WHEN status IN ('GENERATING','COLLECTING','QUEUED') THEN 1 ELSE 2 END,
            CASE WHEN status IN ('GENERATING','COLLECTING','QUEUED') THEN queue_position END,` : ''}
            created_at DESC,id LIMIT $3 OFFSET $4`, [accountId, storeId, limit, offset, group]);
        const row=count.rows[0]||{};
        const counts={all:Number(row.total||0),active:Number(row.active||0),paused:Number(row.paused||0),failed:Number(row.failed||0),errors:Number(row.errors||0),cancelled:Number(row.cancelled||0),deleted:Number(row.deleted||0)-Number(row.purging||0),purging:Number(row.purging||0)};
        return { tasks: page.rows.map(({summary})=>{
          const {submissionStarted,submissionExternalWriteStarted,stoppedFrom,...item}=summary;
          // The stage predicate proves this omitted historical projection field.
          if(['enrichment','attention'].includes(stage)&&item.status==='COLLECTING'&&item.sourceType!=='COLLECT_BOX')item.collectionStage='waiting_seller';
          return {...item,taskActions:taskActions(summary)};
        }), total: stageFilter?Number(row.stage_total):counts[group]??counts.all, counts, limit, offset };
      };
      if (!includeCollectionSources) return readPage(pool);
      return readListingWithinDeadline(pool, async client => {
        const page=await readPage(client);
        const sources=await readCollectionSources(client,{accountId,taskIds:page.tasks.map(task=>task.id)});
        return {...page,tasks:page.tasks.map(task=>({...task,collectionSource:sources.get(task.id)}))};
      });
    },
    async claimNext({ now, leaseMs, leaseToken, phase = 'all' }) {
      if (!['all','prepare','generate','media','finalize'].includes(phase)) throw new Error('Invalid AI listing phase');
      return transaction(async client=>{
        // Serialize only the small claim, so concurrent workers record distinct account turns.
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended('ai-listing-claim',0))");
        const result=await client.query(`SELECT task.* FROM ai_image_listing_tasks task
          LEFT JOIN ai_listing_account_turns turns ON turns.account_id=task.account_id
          WHERE work_phase<>'idle' AND deleted_at IS NULL AND ($2='all' OR work_phase=CASE WHEN $2='media' THEN 'finalize' ELSE $2 END)
            AND ($2 NOT IN ('media','finalize') OR
              ($2='media') = (status NOT IN ('SUBMITTED')
                AND (status<>'SUBMITTING' OR COALESCE(body->>'submissionStage','')='preparing_media')
                AND COALESCE(body->>'submissionStage','')<>'prepared'))
            AND (next_run_at<=$1 OR (status='GENERATING' AND control_action IS NULL
              AND body->>'generationStage'='waiting_quota' AND COALESCE(body->>'submissionId','')=''
              AND body->'submissionExternalWriteStarted' IS DISTINCT FROM 'true'::jsonb))
            AND (lease_token IS NULL OR lease_expires_at<=$1)
            AND ($2<>'finalize' OR NOT EXISTS (
              SELECT 1 FROM ai_image_listing_tasks other
              WHERE other.account_id=task.account_id AND other.id<>task.id AND other.deleted_at IS NULL
                AND other.work_phase='finalize' AND other.lease_token IS NOT NULL AND other.lease_expires_at>$1
                AND (other.status='SUBMITTED' OR other.body->>'submissionStage'='prepared'
                  OR (other.status='SUBMITTING' AND COALESCE(other.body->>'submissionStage','')<>'preparing_media'))
                AND COALESCE(other.body#>>'{submissionTarget,targetStoreId}',other.body#>>'{config,targetStoreId}','')
                  =COALESCE(task.body#>>'{submissionTarget,targetStoreId}',task.body#>>'{config,targetStoreId}','')
            ))
          ORDER BY CASE WHEN work_phase='generate' THEN COALESCE(turns.last_turn,0) ELSE 0 END,
            CASE WHEN work_phase='generate' AND EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(body->'images','[]'::jsonb)) image WHERE COALESCE(image->>'generatedUrl','')<>'') THEN 0 ELSE 1 END,queue_position
          LIMIT 1 FOR UPDATE OF task SKIP LOCKED`,[now,phase]);
        const row=result.rows[0];if(!row)return null;
        if(row.work_phase==='generate') await client.query(`INSERT INTO ai_listing_account_turns(account_id,last_turn)
          VALUES($1,nextval('ai_listing_account_turn_seq')) ON CONFLICT(account_id) DO UPDATE SET last_turn=EXCLUDED.last_turn`,[row.account_id]);
        return fromRow((await client.query(`UPDATE ai_image_listing_tasks SET lease_token=$3,lease_expires_at=$4::bigint+$5::bigint,version=version+1
          WHERE account_id=$1 AND id=$2 RETURNING *`,[row.account_id,row.id,leaseToken,now,leaseMs])).rows[0]);
      });
    },
    async ownsLease({accountId,taskId,leaseToken,now,expectedVersion}) {
      return (await pool.query(`SELECT 1 FROM ai_image_listing_tasks WHERE account_id=$1 AND id=$2
        AND lease_token=$3 AND lease_expires_at>$4 AND version=$5 AND status NOT IN ('CANCELLED','MERGED')`,
      [accountId,taskId,leaseToken,now,expectedVersion])).rowCount===1;
    },
    async leaseState({accountId,taskId,leaseToken,now,expectedVersion,client=pool}) {
      const row=(await client.query(`SELECT control_action FROM ai_image_listing_tasks WHERE account_id=$1 AND id=$2
        AND lease_token=$3 AND lease_expires_at>$4 AND version=$5 AND deleted_at IS NULL`,
      [accountId,taskId,leaseToken,now,expectedVersion])).rows[0];
      return {owned:Boolean(row),controlAction:row?.control_action};
    },
    async requestControl({task,action,expectedVersion,now}) {
      return transaction(async client=>{
        const row=(await client.query(`SELECT * FROM ai_image_listing_tasks WHERE account_id=$1 AND id=$2
          AND version=$3 AND control_action IS NULL AND deleted_at IS NULL FOR UPDATE`,[task.accountId,task.id,expectedVersion])).rows[0];
        if(!row)return null;
        if(row.lease_token && Number(row.lease_expires_at)>now) {
          return fromRow((await client.query(`UPDATE ai_image_listing_tasks SET control_action=$3 WHERE account_id=$1 AND id=$2 RETURNING *`,
            [task.accountId,task.id,action])).rows[0]);
        }
        return fromRow((await client.query(`UPDATE ai_image_listing_tasks SET status=$3,
          body=$4::jsonb || CASE WHEN body ? 'mediaKeys' THEN jsonb_build_object('mediaKeys',body->'mediaKeys') ELSE '{}'::jsonb END,
          work_phase='idle',version=version+1,deleted_at=$5,lease_token=NULL,lease_expires_at=NULL
          WHERE account_id=$1 AND id=$2 RETURNING *`,[task.accountId,task.id,task.status,body(task),task.deletedAt || null])).rows[0]);
      });
    },
    async renewLease({ accountId, taskId, leaseToken, now, leaseMs }) {
      const result = await pool.query(`UPDATE ai_image_listing_tasks SET lease_expires_at=$4::bigint+$5::bigint
        WHERE account_id=$1 AND id=$2 AND lease_token=$3 AND lease_expires_at>$4 RETURNING id`,
      [accountId, taskId, leaseToken, now, leaseMs]);
      return result.rowCount === 1;
    },
    async recordMediaKey({accountId,taskId,key}) {
      if(!/^listing-media\/v1\/ai-image-listing\/[a-f0-9]{64}\.(?:jpg|png|webp)$/.test(key))throw new Error('Invalid generated media key');
      const saved=await pool.query(`UPDATE ai_image_listing_tasks SET body=jsonb_set(body,'{mediaKeys}',
        COALESCE(body->'mediaKeys','[]'::jsonb) || CASE WHEN COALESCE(body->'mediaKeys','[]'::jsonb) ? $3 THEN '[]'::jsonb ELSE jsonb_build_array($3::text) END)
        WHERE account_id=$1 AND id=$2 AND deleted_at IS NULL AND body->'purge' IS NULL RETURNING id`,[accountId,taskId,key]);
      if(!saved.rowCount)throw Object.assign(new Error('Task media ownership changed'),{code:'AI_LISTING_TASK_CONFLICT'});
    },
    async requestPurge({accountId,taskId,expectedVersion,now,client:borrowedClient}) {
      return transaction(async client=>{
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`ai-listing-purge-admission:${accountId}`]);
        const row=(await client.query('SELECT * FROM ai_image_listing_tasks WHERE account_id=$1 AND id=$2 AND version=$3 FOR UPDATE',[accountId,taskId,expectedVersion])).rows[0];
        const task=fromRow(row);
        if(!task || taskActionReason(task,'permanentDelete') || task.leaseToken && task.leaseExpiresAt>now) return null;
        const purge={...task.purge,state:'PENDING',requestedAt:task.purge?.requestedAt || now,nextAttemptAt:now};
        delete purge.errorMessage;
        return fromRow((await client.query(`UPDATE ai_image_listing_tasks SET body=jsonb_set(body,'{purge}',$3::jsonb),
          version=version+1,work_phase='idle',lease_token=NULL,lease_expires_at=NULL WHERE account_id=$1 AND id=$2 RETURNING *`,[accountId,taskId,JSON.stringify(purge)])).rows[0]);
      },borrowedClient);
    },
    async restoreDeleted({task,expectedVersion,now}) {
      return fromRow((await pool.query(`UPDATE ai_image_listing_tasks SET status=$4,body=$5::jsonb,
        deleted_at=NULL,version=version+1,work_phase='idle',lease_token=NULL,lease_expires_at=NULL
        WHERE account_id=$1 AND id=$2 AND version=$3 AND deleted_at IS NOT NULL AND control_action IS NULL
          AND body->'purge' IS NULL AND body->>'permanentlyDeletedAt' IS NULL
          AND (lease_token IS NULL OR lease_expires_at<=$6) RETURNING *`,
      [task.accountId,task.id,expectedVersion,task.status,body(task),now])).rows[0]);
    },
    async saveProgress({accountId,taskId,expectedVersion,leaseToken,now,patch}) {
      if (!patch || Object.keys(patch).some(key=>!['generationStage','updatedAt'].includes(key))) throw new Error('Invalid AI progress patch');
      const row=(await pool.query(`UPDATE ai_image_listing_tasks SET body=body || $6::jsonb,version=version+1
        WHERE account_id=$1 AND id=$2 AND version=$3 AND lease_token=$4 AND lease_expires_at>$5 AND deleted_at IS NULL
        RETURNING version,control_action`,[accountId,taskId,expectedVersion,leaseToken,now,JSON.stringify(patch)])).rows[0];
      return row ? {version:row.version,controlAction:row.control_action || null} : null;
    },
    async save({ task, expectedVersion, leaseToken = null, now, releaseLease = true, requeue = false, finishControl = null, guardControl = false, client=pool }) {
      return fromRow((await client.query(`UPDATE ai_image_listing_tasks
        SET status=$4,body=$5::jsonb || CASE WHEN body ? 'mediaKeys' THEN jsonb_build_object('mediaKeys',body->'mediaKeys') ELSE '{}'::jsonb END,version=version+1,
          next_run_at=CASE WHEN control_action IS NOT NULL AND $12::text IS NULL THEN LEAST($6::bigint,$8::bigint) ELSE $6 END,
          work_phase=CASE WHEN control_action IS NOT NULL AND $12::text IS NULL THEN work_phase ELSE $10 END,
          lease_token=CASE WHEN $9 AND (control_action IS NULL OR $12::text IS NOT NULL) THEN NULL ELSE lease_token END,
          lease_expires_at=CASE WHEN $9 AND (control_action IS NULL OR $12::text IS NOT NULL) THEN NULL ELSE lease_expires_at END,
          queue_position=CASE WHEN $11 THEN nextval('ai_listing_queue_position_seq') ELSE queue_position END,
          control_action=CASE WHEN $12::text IS NOT NULL THEN NULL ELSE control_action END,deleted_at=COALESCE($14,deleted_at)
        WHERE account_id=$1 AND id=$2 AND version=$3
          AND ($7::text IS NULL OR (lease_token=$7 AND lease_expires_at>$8))
          AND body->'purge' IS NULL AND body->>'permanentlyDeletedAt' IS NULL
          AND ($12::text IS NULL OR control_action=$12) AND (NOT $13 OR control_action IS NULL) RETURNING *`,
      [task.accountId, task.id, expectedVersion, task.status, body(task), task.nextRunAt, leaseToken, now, releaseLease, aiListingWorkPhase(task),requeue,finishControl,guardControl,task.deletedAt || null])).rows[0]);
    },
  };
}
