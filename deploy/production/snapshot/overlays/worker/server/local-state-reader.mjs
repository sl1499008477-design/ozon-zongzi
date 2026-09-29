import {unprotectStateFromStorage} from './crypto-secrets.mjs';
import {currentStoreIdForAccount} from './account-context.mjs';
import {formalWarehouseCacheRow,hydratedProductRow} from './formal-persistence.mjs';

// A read model for the existing Web contract. It never writes or hydrates the
// global compatibility state, and only the selected store's products are read.
export async function readLocalStateForAccount({pool,accountId,bootstrap=false,storeId=null}) {
  if(!accountId)throw Object.assign(new Error('请先登录'),{status:401});
  const table=process.env.POSTGRES_STATE_TABLE||'local_state';
  if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table))throw new Error('状态表名不合法');
  // Expand the TOASTed compatibility snapshot once; repeated root/nested reads
  // otherwise copy the entire catalog for this small account projection.
  const result=await pool.query(`WITH snapshot AS MATERIALIZED (
    SELECT state #> '{}' AS state FROM ${table} WHERE id=$1
  ) SELECT jsonb_build_object(
    'accounts',COALESCE((SELECT jsonb_agg(a.raw || jsonb_build_object('id',a.id,'role',a.role,'status',a.status,'expiresAt',a.expires_at)) FROM accounts a WHERE a.id=$2),'[]'::jsonb),
    'stores',COALESCE((SELECT jsonb_agg(value) FROM jsonb_array_elements(COALESCE(state->'stores','[]'::jsonb)) value
      WHERE value->>'id' IN (SELECT id FROM stores WHERE owner_account_id=$2)),'[]'::jsonb),
    'currentStoreIdsByAccount',jsonb_build_object($2::text,state->'currentStoreIdsByAccount'->$2),
    'currentStoreId',state->'currentStoreId','currentAccountId',$2::text,'updatedAt',state->'updatedAt',
    'jobs',COALESCE((SELECT jsonb_object_agg(key,value) FROM jsonb_each(COALESCE(state->'jobs','{}'::jsonb)) WHERE value->>'accountId'=$2),'{}'::jsonb),
    'reports',COALESCE((SELECT jsonb_agg(recent.report) FROM (
      SELECT jsonb_build_object('status','SUCCESS','type',value->>'type','createdAt',value->'createdAt') AS report
      FROM jsonb_array_elements(COALESCE(state->'reports','[]'::jsonb)) WITH ORDINALITY AS entry(value,position)
      WHERE value->>'status'='SUCCESS' AND value->>'type' IN ('PRODUCTS','WAREHOUSES')
        AND (value->>'accountId'=$2 OR value->>'storeId' IN (SELECT id FROM stores WHERE owner_account_id=$2))
      ORDER BY position DESC LIMIT 1) AS recent),'[]'::jsonb),
    'caches',jsonb_build_object(
      'favorites',COALESCE((SELECT jsonb_agg(value) FROM jsonb_array_elements(COALESCE(state #> '{caches,favorites}','[]'::jsonb)) value
        WHERE value->>'accountId'=$2 OR value->>'storeId' IN (SELECT id FROM stores WHERE owner_account_id=$2)),'[]'::jsonb),
      'productTemplates',COALESCE((SELECT jsonb_agg(value) FROM jsonb_array_elements(COALESCE(state #> '{caches,productTemplates}','[]'::jsonb)) value
        WHERE value->>'accountId'=$2 OR value->>'storeId' IN (SELECT id FROM stores WHERE owner_account_id=$2)),'[]'::jsonb),
      'files',COALESCE((SELECT jsonb_agg(raw) FROM files WHERE created_by=$2),'[]'::jsonb),
      'announcements',COALESCE(state #> '{caches,announcements}','[]'::jsonb))
    ) AS state FROM snapshot`,['local-state',accountId]);
  const state=unprotectStateFromStorage(result.rows[0]?.state||{});
  state.currentAccountId=accountId;
  state.reports ||= [];
  state.stores=(state.stores||[]).map(store=>({...store,ownerAccountId:accountId}));
  const selected=storeId===null?currentStoreIdForAccount(state,accountId):String(storeId);
  if(selected&&!state.stores.some(store=>String(store.id)===selected))throw Object.assign(new Error('门店不存在'),{status:404});
  state.currentStoreId=selected;
  const [products,warehouses,counts]=await Promise.all([
    bootstrap?{rows:[]}:pool.query('SELECT p.* FROM products p JOIN stores s ON s.id=p.store_id WHERE s.owner_account_id=$1 AND p.store_id=$2 ORDER BY p.updated_at DESC,p.id',[accountId,selected]),
    pool.query(`SELECT w.id,w.store_id,w.warehouse_id,w.name,w.warehouse_type,w.status,w.is_active,w.is_archived,w.synced_at,
      w.raw-'timetable' AS raw FROM warehouses w JOIN stores s ON s.id=w.store_id
      WHERE s.owner_account_id=$1 ORDER BY w.store_id,w.updated_at DESC,w.id`,[accountId]),
    pool.query(`SELECT (SELECT COUNT(*)::int FROM products p JOIN stores s ON s.id=p.store_id WHERE s.owner_account_id=$1 AND p.store_id=$2) products,
      (SELECT COUNT(*)::int FROM collect_items WHERE account_id=$1 AND deleted_at IS NULL) collect_box`,[accountId,selected]),
  ]);
  state.caches={...state.caches,products:products.rows.map(hydratedProductRow),warehouses:warehouses.rows.map(formalWarehouseCacheRow),collectBox:[]};
  state.summaryCounts={products:Number(counts.rows[0]?.products||0),collectBox:Number(counts.rows[0]?.collect_box||0)};
  return state;
}
