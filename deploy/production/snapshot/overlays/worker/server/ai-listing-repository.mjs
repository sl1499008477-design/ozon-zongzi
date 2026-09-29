// This feature owns its task records and generation-account turn ledger.
function fromRow(row) {
  if (!row) return null;
  return { ...row.body, id: row.id, accountId: row.account_id, dedupeKey: row.dedupe_key,
    workPhase: row.work_phase, queuePosition: Number(row.queue_position), status: row.status, version: row.version, nextRunAt: Number(row.next_run_at),
    leaseToken: row.lease_token, leaseExpiresAt: row.lease_expires_at == null ? null : Number(row.lease_expires_at) };
}
function body(task) {
  const { version, leaseToken, leaseExpiresAt, workPhase, queuePosition, ...record } = task;
  return JSON.stringify(record);
}
const runnable = new Set(['QUEUED','COLLECTING','GENERATING','READY_TO_SUBMIT','SUBMITTING','SUBMITTED']);
export function aiListingWorkPhase(task) {
  if (!runnable.has(task.status)) return 'idle';
  if (['SUBMITTING','SUBMITTED','READY_TO_SUBMIT'].includes(task.status)) return 'finalize';
  if (!task.source || (task.importBatchId && !task.importGrouped)) return 'prepare';
  return task.images.some(image => !image.generatedUrl) ? 'generate' : 'finalize';
}
export function createAiListingRepository({ pool }) {
  async function transaction(run) {
    const client = await pool.connect();
    try { await client.query('BEGIN'); const result = await run(client); await client.query('COMMIT'); return result; }
    catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  async function insert(client, task) {
    const result = await client.query(`INSERT INTO ai_image_listing_tasks
      (id,account_id,dedupe_key,status,body,next_run_at,created_at,work_phase)
      VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8)
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
      WHERE task.account_id=$1 AND task.status<>'MERGED'
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
  return {
    async create(task) { return insert(pool, task); },
    async readCollectorAutomaticOwners(input) { return readCollectorAutomaticOwners(pool, input); },
    async createCollectorAutomatic({ accountId, skus, prepare }) {
      return transaction(async client => {
        // The lock covers only local preparation and inserts, never source reads or external requests.
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`collector-auto-ai:${accountId}:ozon`]);
        const owners = await readCollectorAutomaticOwners(client, { accountId, skus });
        const prepared = await prepare(skus.filter(sku => !owners.has(sku)));
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
        for(const task of changed) await client.query(`UPDATE ai_image_listing_tasks SET status=$3,body=$4::jsonb,work_phase=$5,next_run_at=$6,version=version+1
          WHERE account_id=$1 AND id=$2 AND version=$7`,[accountId,task.id,task.status,body(task),aiListingWorkPhase(task),task.nextRunAt,task.version]);
      });
    },
    async get({ accountId, taskId }) {
      return fromRow((await pool.query("SELECT * FROM ai_image_listing_tasks WHERE account_id=$1 AND id=$2", [accountId, taskId])).rows[0]);
    },
    async getMany({ accountId, taskIds }) {
      if (!taskIds.length) return [];
      return (await pool.query("SELECT * FROM ai_image_listing_tasks WHERE account_id=$1 AND id=ANY($2::text[])",
        [accountId, taskIds])).rows.map(fromRow);
    },
    async list({ accountId }) {
      return (await pool.query("SELECT * FROM ai_image_listing_tasks WHERE account_id=$1 AND status<>'MERGED' ORDER BY created_at DESC,id", [accountId])).rows.map(fromRow);
    },
    async readCollectionSources({ accountId, taskIds }) {
      if (!taskIds.length) return new Map();
      const {rows} = await pool.query(`WITH sources AS (
        SELECT id,body->>'sourceType' AS source_type,body->>'sourceId' AS collect_id,created_at,
          COALESCE(NULLIF(body#>>'{collectorAuto,runId}',''),NULLIF(body#>>'{source,sourceSnapshot,collectorRunId}',''),
            NULLIF(body#>>'{collectWait,initialSource,sourceSnapshot,collectorRunId}','')) AS run_id,
          COALESCE(body#>'{source,sourceSnapshot}',body#>'{collectWait,initialSource,sourceSnapshot}','{}'::jsonb) AS snapshot
        FROM ai_image_listing_tasks WHERE account_id=$1 AND id=ANY($2::text[])
      ), desktop AS (
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
    },
    async listPage({ accountId, view = 'tasks', storeId = '', limit = 50, offset = 0 }) {
      limit = Math.max(1, Math.min(100, Number.parseInt(limit, 10) || 50));
      offset = Math.max(0, Math.min(2147483647, Number.parseInt(offset, 10) || 0));
      const where = `account_id=$1 AND status<>'MERGED' AND ${view === 'completed' ? "status='COMPLETED' AND COALESCE(body->'submissionTarget'->>'targetStoreId',body->'config'->>'targetStoreId')=$2" : "status<>'COMPLETED' AND ($2::text='' OR TRUE)"}`;
      const [count, page] = await Promise.all([
        pool.query(`SELECT COUNT(*)::int AS total FROM ai_image_listing_tasks WHERE ${where}`, [accountId, storeId]),
        pool.query(`SELECT jsonb_build_object(
          'importSkus',body->'importSkus','importRows',body->'importRows','generationStage',body->'generationStage',
          'id',id,'sourceType',body->'sourceType','sku',body->'sku','name',body->'name','thumbnail',body->'thumbnail','status',status,
          'createdAt',to_timestamp(created_at/1000.0),'updatedAt',to_timestamp((body->>'updatedAt')::numeric/1000.0),
          'errorMessage',body->'errorMessage','priceFailure',body->'priceFailure','submissionId',body->'submissionId','submissionTarget',body->'submissionTarget',
          'config',jsonb_build_object('targetStoreId',body->'config'->'targetStoreId',
            'autoSwitchStores',body->'config'->'autoSwitchStores','generationMode',body->'config'->'generationMode'),
          'progress',jsonb_build_object('total',jsonb_array_length(COALESCE(body->'images','[]'::jsonb)),
            'completed',(SELECT count(*) FROM jsonb_array_elements(COALESCE(body->'images','[]'::jsonb)) image WHERE COALESCE(image->>'generatedUrl','')<>'')),
          'skuProgress',COALESCE((SELECT jsonb_agg(progress ORDER BY first_index) FROM (
            SELECT jsonb_build_object('sku',image->>'sku','total',count(*),
              'completed',count(*) FILTER(WHERE COALESCE(image->>'generatedUrl','')<>'')) progress,min(position) first_index
            FROM jsonb_array_elements(COALESCE(body->'images','[]'::jsonb)) WITH ORDINALITY AS images(image,position)
            GROUP BY image->>'sku') grouped),'[]'::jsonb)
        ) AS summary FROM ai_image_listing_tasks WHERE ${where}
        ORDER BY ${view === 'tasks' ? `CASE
          WHEN status='GENERATING' AND lease_token IS NOT NULL
            AND lease_expires_at>extract(epoch FROM now())*1000
            AND (body->>'generationStage' IN ('preparing','image','slicing','saving')
              OR (COALESCE(body->>'generationStage','')='' AND EXISTS (
                SELECT 1 FROM jsonb_array_elements(COALESCE(body->'images','[]'::jsonb)) image
                WHERE image->>'status'='GENERATING' AND COALESCE(image->>'generatedUrl','')='')))
            THEN 0
          WHEN status IN ('GENERATING','COLLECTING','QUEUED') THEN 1 ELSE 2 END,
          CASE WHEN status IN ('GENERATING','COLLECTING','QUEUED') THEN queue_position END,` : ''}
          created_at DESC,id LIMIT $3 OFFSET $4`, [accountId, storeId, limit, offset]),
      ]);
      return { tasks: page.rows.map(row=>row.summary), total: Number(count.rows[0]?.total || 0), limit, offset };
    },
    async claimNext({ now, leaseMs, leaseToken, phase = 'all' }) {
      if (!['all','prepare','generate','finalize'].includes(phase)) throw new Error('Invalid AI listing phase');
      return transaction(async client=>{
        // Serialize only the small claim, so concurrent workers record distinct account turns.
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended('ai-listing-claim',0))");
        const result=await client.query(`SELECT task.* FROM ai_image_listing_tasks task
          LEFT JOIN ai_listing_account_turns turns ON turns.account_id=task.account_id
          WHERE work_phase<>'idle' AND ($2='all' OR work_phase=$2)
            AND next_run_at<=$1 AND (lease_token IS NULL OR lease_expires_at<=$1)
          ORDER BY CASE WHEN work_phase='generate' THEN COALESCE(turns.last_turn,0) ELSE 0 END,queue_position
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
    async renewLease({ accountId, taskId, leaseToken, now, leaseMs }) {
      const result = await pool.query(`UPDATE ai_image_listing_tasks SET lease_expires_at=$4::bigint+$5::bigint
        WHERE account_id=$1 AND id=$2 AND lease_token=$3 AND lease_expires_at>$4 RETURNING id`,
      [accountId, taskId, leaseToken, now, leaseMs]);
      return result.rowCount === 1;
    },
    async save({ task, expectedVersion, leaseToken = null, now, releaseLease = true }) {
      return fromRow((await pool.query(`UPDATE ai_image_listing_tasks
        SET status=$4,body=$5::jsonb,next_run_at=$6,version=version+1,work_phase=$10,
          lease_token=CASE WHEN $9 THEN NULL ELSE lease_token END,
          lease_expires_at=CASE WHEN $9 THEN NULL ELSE lease_expires_at END
        WHERE account_id=$1 AND id=$2 AND version=$3
          AND ($7::text IS NULL OR (lease_token=$7 AND lease_expires_at>$8)) RETURNING *`,
      [task.accountId, task.id, expectedVersion, task.status, body(task), task.nextRunAt, leaseToken, now, releaseLease, aiListingWorkPhase(task)])).rows[0]);
    },
  };
}
