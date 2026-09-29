import {parseMinorUnits,formatMinorUnits} from '../shared/order-money.mjs';

const invalid=(message,status=400)=>Object.assign(new Error(message),{status,code:'ORDER_MANAGEMENT_COST_INVALID'});
const args=scope=>[scope.accountId,scope.storeId];
const costView=row=>({productId:row.product_id,unitCostCny:row.unit_cost_cny,autoApply:row.auto_apply});

export function normalizeUnitCostCny(value){
  if(value===null)return null;
  if(typeof value!=='string'||!/^\d{1,16}(?:\.\d{1,2})?$/.test(value.trim()))throw invalid('采购成本须为非负人民币金额字符串，最多两位小数；清空请传 null');
  return formatMinorUnits(parseMinorUnits(value.trim()));
}

// Only the order runtime exposes this service; its ownership boundary is injected
// so product costs and order operations use the same account/store policy.
export function createProductCostsService({pool,assertStore}={}){
  async function list(scope){
    await assertStore(scope);
    const {rows}=await pool.query('SELECT product_id,unit_cost_cny,auto_apply FROM ozon_product_costs WHERE account_id=$1 AND store_id=$2 ORDER BY product_id',args(scope));
    return {items:rows.map(costView)};
  }
  async function applyMissingCosts(scope,{db=pool,orderIds=null,productId=null}={}){
    // Resolve identities against the catalog first, not only the subset with a cost.
    // An ambiguous offer_id must never pick an arbitrary product's purchase price.
    await db.query(`WITH additions AS (
      SELECT o.id,jsonb_object_agg(item->>'sku',jsonb_build_object('unitCostCny',pc.unit_cost_cny::text,'costSource','PRODUCT_AUTO')) AS costs
      FROM orders o JOIN stores s ON s.id=o.store_id AND s.owner_account_id=$1
      CROSS JOIN LATERAL jsonb_array_elements(CASE
        WHEN jsonb_typeof(COALESCE(o.management_data->'products',o.raw->'products'))='array'
        THEN COALESCE(o.management_data->'products',o.raw->'products') ELSE '[]'::jsonb END) item
      JOIN LATERAL (
        SELECT CASE WHEN COUNT(*)=1 THEN MIN(p.product_id) END AS product_id FROM products p
        WHERE p.store_id=o.store_id AND (
          (NULLIF(item->>'productId','') IS NOT NULL AND p.product_id=item->>'productId') OR
          (NULLIF(item->>'productId','') IS NULL AND (
            (p.sku<>'' AND p.sku=item->>'sku') OR
            (p.offer_id<>'' AND p.offer_id=COALESCE(item->>'offerId',item->>'offer_id')
              AND NOT EXISTS(SELECT 1 FROM products exact WHERE exact.store_id=o.store_id AND exact.sku<>'' AND exact.sku=item->>'sku')))))
      ) identity ON identity.product_id IS NOT NULL
      JOIN ozon_product_costs pc ON pc.account_id=$1 AND pc.store_id=$2 AND pc.product_id=identity.product_id
      WHERE o.store_id=$2 AND ($3::text[] IS NULL OR o.id=ANY($3)) AND ($4::text IS NULL OR pc.product_id=$4)
        AND pc.auto_apply AND pc.unit_cost_cny IS NOT NULL AND COALESCE(item->>'sku','')<>''
        AND NOT (o.purchase_costs ? (item->>'sku'))
      GROUP BY o.id
    ) UPDATE orders o SET purchase_costs=additions.costs || o.purchase_costs FROM additions
      WHERE o.id=additions.id AND o.store_id=$2`,[...args(scope),orderIds,productId]);
  }
  async function save(scope,productId,input){
    await assertStore(scope);
    if(!input||typeof input.autoApply!=='boolean')throw invalid('autoApply 必须为布尔值');
    const unitCostCny=normalizeUnitCostCny(input.unitCostCny),db=await pool.connect();
    try{
      await db.query('BEGIN');
      const product=(await db.query('SELECT id FROM products WHERE store_id=$1 AND product_id=$2',[scope.storeId,productId])).rows[0];
      if(!product)throw invalid('商品不属于当前店铺或尚未同步',404);
      const {rows}=await db.query(`INSERT INTO ozon_product_costs(account_id,store_id,product_id,unit_cost_cny,auto_apply)
        VALUES($1,$2,$3,$4,$5) ON CONFLICT(account_id,store_id,product_id) DO UPDATE
        SET unit_cost_cny=EXCLUDED.unit_cost_cny,auto_apply=EXCLUDED.auto_apply,updated_at=NOW() RETURNING *`,[...args(scope),productId,unitCostCny,input.autoApply]);
      if(input.autoApply&&unitCostCny!==null)await applyMissingCosts(scope,{db,productId});
      await db.query('COMMIT');return costView(rows[0]);
    }catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}
  }
  return {list,save,applyMissingCosts};
}
