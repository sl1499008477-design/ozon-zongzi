// Counts first confirmed listing success, never mutable task update or billing time.
export async function readDailyListingSummary({pool,accountId,now=Date.now()}) {
  const instant=new Date(now).getTime();
  const date=new Date(instant+8*60*60*1000).toISOString().slice(0,10);
  const start=new Date(`${date}T00:00:00+08:00`);
  const end=new Date(start.getTime()+24*60*60*1000);
  const [coverage,counts]=await Promise.all([
    pool.query('SELECT started_at FROM listing_success_tracking WHERE singleton=TRUE'),
    pool.query(`SELECT success.store_id,COALESCE(NULLIF(store.label,''),NULLIF(MAX(success.store_name),''),success.store_id) AS store_name,
        COUNT(*)::int AS count
      FROM listing_successes success
      LEFT JOIN stores store ON store.id=success.store_id AND store.owner_account_id=success.account_id
      WHERE success.account_id=$1 AND success.succeeded_at >= $2 AND success.succeeded_at < $3
      GROUP BY success.store_id,store.label ORDER BY count DESC,success.store_id`,[accountId,start,end]),
  ]);
  const byStore=counts.rows.map(row=>({storeId:row.store_id,storeName:row.store_name,count:Number(row.count)}));
  const complete=!!coverage.rows[0]&&new Date(coverage.rows[0].started_at).getTime()<=start.getTime();
  return {count:byStore.reduce((sum,row)=>sum+row.count,0),date,timeZone:'Asia/Shanghai',byStore,complete,
    note:complete?'':'历史成功时间不明的 SKU 不计入日统计，以免将重试误算为首次成功；本日数据覆盖不完整。'};
}
