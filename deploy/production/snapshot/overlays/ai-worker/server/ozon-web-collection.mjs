import { randomUUID } from 'node:crypto';
import { postgresConfig, getPostgresPool } from './db/connection.mjs';
import { ingestCollectRequestV4, prepareCollectRequestV4 } from './collection-pipeline.mjs';
import {findCollectedSku} from './collection-sku-rules.mjs';
import {collectCaptureSkus} from './collect-enrichment-recovery.mjs';
import {admitCollectedItem} from './collection-admission.mjs';
import { sanitizeCollectorText } from './collector-auth-service.mjs';

const error = (message, status = 400, code = 'WEB_COLLECTION_INVALID') => Object.assign(new Error(message), { status, code });
const sourceUrl = sku => `https://www.ozon.ru/product/${sku}/`;
const cleanMessage = value => sanitizeCollectorText(String(value || ''), { max: 300 });
const iso = value => value ? new Date(value).toISOString() : null;

export function parseWebCollectionInput(body = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).some(key => !['sku', 'scope', 'requestId'].includes(key))) {
    throw error('采集请求只能包含 SKU、采集范围和请求编号');
  }
  const sku = String(body.sku || '').trim();
  const scope = body.scope ?? 'ALL';
  const requestId = String(body.requestId || '').trim();
  if (!/^\d{1,20}$/.test(sku)) throw error('请输入有效的 Ozon 商品链接或 SKU');
  if (!['ALL', 'CURRENT'].includes(scope)) throw error('采集范围无效');
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(requestId)) throw error('采集请求编号无效，请刷新后重试');
  return { sku, scope, requestId };
}

function publicJob(row) {
  return { id: row.id, sku: row.sku, scope: row.scope, sourceUrl: sourceUrl(row.sku), status: row.status,
    message: row.message, errorCode: row.error_code, result: row.result,
    createdAt: iso(row.created_at), updatedAt: iso(row.updated_at), leaseExpiresAt: iso(row.claim_expires_at) };
}

async function prepareWebCollectionAdmission({accountId,input}) {
  const pool=await getPostgresPool();
  const {normalizedItem}=prepareCollectRequestV4({authenticatedAccount:{id:accountId},input});
  if(await findCollectedSku(pool,accountId,input.sourceSku,collectCaptureSkus(normalizedItem)))return null;
  return admitCollectedItem({accountId,item:normalizedItem},{pool});
}

export function createOzonWebCollectionService({ getPool: injectedPool, ingestCollection = ingestCollectRequestV4, categoryEvidencePort,
  prepareAdmission=prepareWebCollectionAdmission } = {}) {
  // Result handling holds a job lock while V4 uses the application's pool.
  // Keep these two connections separate so waiting uploads cannot exhaust the
  // same pool that they need to finish their product transaction.
  let jobPool;
  const getPool = injectedPool || (() => jobPool ||= import('pg').then(({ Pool }) => {
    const pool = new Pool({ ...postgresConfig(), max: 2, idleTimeoutMillis: 30000 });
    pool.on('error', () => console.warn('[web-collection] 数据库连接中断，等待重连'));
    return pool;
  }));
  async function transaction(fn) {
    const client = await (await getPool()).connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (failure) {
      await client.query('ROLLBACK').catch(() => {});
      if (failure.code === '23505') throw error('相同 SKU 已有待处理任务，请先处理原任务', 409, 'WEB_COLLECTION_CONFLICT');
      throw failure;
    } finally { client.release(); }
  }
  async function owned(client, accountId, id, lock=true) {
    const result = await client.query(`SELECT * FROM ozon_web_collection_jobs WHERE account_id=$1 AND id=$2${lock?' FOR UPDATE':''}`, [accountId, id]);
    if (!result.rows[0]) throw error('采集任务不存在', 404, 'WEB_COLLECTION_NOT_FOUND');
    return result.rows[0];
  }
  function requireClaim(row, input, replay = false) {
    const same = row.claimed_session_id === input.collectorSessionId && row.claim_fence && row.claim_fence === input.claimFence;
    if (same && replay && row.status === 'COMPLETED') return;
    if (!same || row.status !== 'PROCESSING' || new Date(row.claim_expires_at).getTime() <= Date.now()) {
      throw error('任务已取消或领取已过期，请重新领取', 409, 'WEB_COLLECTION_CLAIM_LOST');
    }
  }

  async function create({ accountId, sku, scope, requestId }) {
    return transaction(async client => {
      // Serialize repeated Web submissions as well as retries for this account.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`web-collect:${accountId}`]);
      const existing = (await client.query('SELECT * FROM ozon_web_collection_jobs WHERE account_id=$1 AND request_id=$2', [accountId, requestId])).rows[0];
      if (existing) {
        if (existing.sku !== sku || existing.scope !== scope) throw error('请求编号已经用于另一件商品', 409, 'WEB_COLLECTION_CONFLICT');
        return publicJob(existing);
      }
      const saved = await client.query(`INSERT INTO ozon_web_collection_jobs(id,account_id,request_id,sku,scope,message)
        VALUES($1,$2,$3,$4,$5,'等待已登录的扩展领取')
        ON CONFLICT(account_id,sku,scope) WHERE status IN ('QUEUED','PROCESSING','WAITING')
        DO UPDATE SET updated_at=ozon_web_collection_jobs.updated_at RETURNING *`,
      [`wc_${randomUUID()}`, accountId, requestId, sku, scope]);
      return publicJob(saved.rows[0]);
    });
  }
  async function list({ accountId, page = 1 }) {
    const pageNumber = Math.max(1, Math.min(10000, Math.trunc(Number(page) || 1)));
    const pool = await getPool();
    const [rows, count] = await Promise.all([
      pool.query('SELECT * FROM ozon_web_collection_jobs WHERE account_id=$1 ORDER BY created_at DESC,id DESC LIMIT 20 OFFSET $2', [accountId, (pageNumber - 1) * 20]),
      pool.query('SELECT COUNT(*)::int AS total FROM ozon_web_collection_jobs WHERE account_id=$1', [accountId]),
    ]);
    return { items: rows.rows.map(publicJob), total: count.rows[0].total, page: pageNumber, pageSize: 20 };
  }
  async function get({ accountId, id }) {
    const row = (await (await getPool()).query('SELECT * FROM ozon_web_collection_jobs WHERE account_id=$1 AND id=$2', [accountId, id])).rows[0];
    if (!row) throw error('采集任务不存在', 404, 'WEB_COLLECTION_NOT_FOUND');
    return publicJob(row);
  }
  async function claim({ accountId, collectorSessionId }) {
    return transaction(async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`web-collect:${accountId}`]);
      const busy = await client.query(`SELECT id FROM ozon_web_collection_jobs WHERE account_id=$1 AND
        (status='WAITING' OR (status='PROCESSING' AND claim_expires_at>NOW())) LIMIT 1`, [accountId]);
      if (busy.rowCount) return null;
      const next = await client.query(`SELECT id FROM ozon_web_collection_jobs WHERE account_id=$1 AND
        (status='QUEUED' OR (status='PROCESSING' AND claim_expires_at<=NOW()))
        ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED`, [accountId]);
      if (!next.rowCount) return null;
      const claimed = await client.query(`UPDATE ozon_web_collection_jobs SET status='PROCESSING',claimed_session_id=$3,
        claim_fence=$4,claim_expires_at=NOW()+INTERVAL '90 seconds',message='扩展正在打开商品页面',error_code='',updated_at=NOW()
        WHERE account_id=$1 AND id=$2 RETURNING *`, [accountId, next.rows[0].id, collectorSessionId, randomUUID()]);
      return { ...publicJob(claimed.rows[0]), claimFence: claimed.rows[0].claim_fence };
    });
  }
  async function progress(input) {
    return transaction(async client => {
      const row = await owned(client, input.accountId, input.id);
      requireClaim(row, input);
      const result = await client.query(`UPDATE ozon_web_collection_jobs SET claim_expires_at=NOW()+INTERVAL '90 seconds',
        message=$3,updated_at=NOW() WHERE account_id=$1 AND id=$2 RETURNING *`,
      [input.accountId, input.id, cleanMessage(input.message) || row.message]);
      return publicJob(result.rows[0]);
    });
  }
  async function complete(input) {
    const snapshot=await owned(await getPool(),input.accountId,input.id,false);
    requireClaim(snapshot,input,true);
    if(snapshot.status==='COMPLETED')return publicJob(snapshot);
    const payload=input.payload;
    if(!payload || String(payload.sku||'')!==snapshot.sku)throw error('回传商品与任务 SKU 不一致',422,'WEB_COLLECTION_SKU_MISMATCH');
    const variants=Array.isArray(payload.variantData?.variants)?payload.variantData.variants:Array.isArray(payload.variants)?payload.variants:[];
    if(snapshot.scope==='CURRENT' && variants.some(value=>String(value.sku)!==snapshot.sku))throw error('本任务只采当前 SKU，不能回传其他变体',422,'WEB_COLLECTION_SKU_MISMATCH');
    const collectionInput={source:'ozon',sourceSku:snapshot.sku,sourceUrl:sourceUrl(snapshot.sku),
      requestId:`web-collect-${snapshot.id}-${snapshot.claim_fence}`,payload,capturedAt:input.capturedAt};
    const admitted=await prepareAdmission({accountId:input.accountId,input:collectionInput});
    return transaction(async client => {
      const row = await owned(client, input.accountId, input.id);
      requireClaim(row, input, true);
      if (row.status === 'COMPLETED') return publicJob(row);
      // V4 owns product validation, deduplication, draft preservation and Seller
      // enrichment. Holding only this job row prevents cancellation/old claims
      // from racing its result. A lost DB commit is recoverable via V4 requestId.
      const ingested = await ingestCollection({ authenticatedAccount: { id: input.accountId },
        input:collectionInput,categoryEvidencePort,checkAdmission:async()=>{
          if(!admitted)throw error('已有采集记录已变化，请重试保存',409,'COLLECT_ADMISSION_RETRY');
          return admitted;
        } });
      const collectItemId = String(ingested?.collectItemId || ingested?.item?.id || '');
      if (!collectItemId) throw error('商品资料未确认入库，请重试', 503, 'WEB_COLLECTION_UPLOAD_UNCONFIRMED');
      const savedVariants = ingested?.item?.listingDraft?.variants || ingested?.item?.variantData?.variants || ingested?.item?.variants || [];
      const countedVariants = savedVariants.length ? savedVariants : ingested.duplicate === true ? [] : variants;
      const receipt = { collectItemId, duplicate: ingested.duplicate === true,
        variantCount: new Set(countedVariants.length ? countedVariants.map(value => String(value.sku)) : [row.sku]).size };
      const saved = await client.query(`UPDATE ozon_web_collection_jobs SET status='COMPLETED',result=$3::jsonb,
        message=$4,error_code='',claim_expires_at=NULL,updated_at=NOW() WHERE account_id=$1 AND id=$2 RETURNING *`,
      [input.accountId, input.id, JSON.stringify(receipt), receipt.duplicate ? '商品已存在，已保留原资料' : '资料已回传采集箱，类目与包装按需继续补全']);
      return publicJob(saved.rows[0]);
    });
  }
  async function fail(input) {
    return transaction(async client => {
      const row = await owned(client, input.accountId, input.id);
      requireClaim(row, input);
      const code = /^[A-Z][A-Z0-9_]{0,100}$/.test(String(input.code || '')) ? input.code : 'WEB_COLLECTION_CAPTURE_FAILED';
      const saved = await client.query(`UPDATE ozon_web_collection_jobs SET status=$3,message=$4,error_code=$5,
        claim_expires_at=NULL,updated_at=NOW() WHERE account_id=$1 AND id=$2 RETURNING *`,
      [input.accountId, input.id, input.waiting === true ? 'WAITING' : 'FAILED', cleanMessage(input.message) || '商品采集失败，请重试', code]);
      return publicJob(saved.rows[0]);
    });
  }
  async function retry({ accountId, id }) {
    return transaction(async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`web-collect:${accountId}`]);
      const row = await owned(client, accountId, id);
      if (!['WAITING','FAILED','CANCELLED'].includes(row.status)) throw error('任务仍在处理或已完成', 409, 'WEB_COLLECTION_CONFLICT');
      const saved = await client.query(`UPDATE ozon_web_collection_jobs SET status='QUEUED',message='等待扩展继续采集',
        error_code='',claimed_session_id=NULL,claim_fence='',claim_expires_at=NULL,updated_at=NOW()
        WHERE account_id=$1 AND id=$2 RETURNING *`, [accountId, id]);
      return publicJob(saved.rows[0]);
    });
  }
  async function cancel({ accountId, id }) {
    return transaction(async client => {
      const row = await owned(client, accountId, id);
      if (row.status === 'COMPLETED') throw error('资料已经回传，不能取消已完成任务', 409, 'WEB_COLLECTION_CONFLICT');
      const saved = await client.query(`UPDATE ozon_web_collection_jobs SET status='CANCELLED',message='任务已取消',
        claim_fence='',claim_expires_at=NULL,updated_at=NOW() WHERE account_id=$1 AND id=$2 RETURNING *`, [accountId, id]);
      return publicJob(saved.rows[0]);
    });
  }
  return { create, get, list, claim, progress, complete, fail, retry, cancel,
    close: async () => { if (jobPool) await (await jobPool).end(); },
  };
}
