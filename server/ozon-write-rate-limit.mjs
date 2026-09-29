import {createHash} from 'node:crypto';

// Call immediately before an actual write, with an independent request key.
// The caller retains its own write journal/idempotency; this only owns capacity.
// A borrowed session-lock client still needs its own short capacity transaction.
export async function reserveOzonWriteCapacity({pool,client:borrowedClient,sellerId,operation,requestKey,units=1,pairKeys=[],limit,clock=Date.now}) {
  if(!sellerId||!requestKey||!['stock','import'].includes(operation)||!Number.isSafeInteger(units)||units<1||!Number.isSafeInteger(limit)||limit<0)throw new TypeError('Ozon write capacity identity and limit required');
  const sellerScope=createHash('sha256').update(String(sellerId)).digest('hex');
  const now=Number(clock());
  const client=borrowedClient||await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',['ozon-write:'+sellerScope+':'+operation]);
    await client.query('DELETE FROM ozon_write_rate_reservations WHERE seller_scope=$1 AND operation=$2 AND created_at<$3',[sellerScope,operation,new Date(now-86400000)]);
    const rows=(await client.query('SELECT request_key,units,pair_keys,created_at FROM ozon_write_rate_reservations WHERE seller_scope=$1 AND operation=$2 AND created_at>$3 ORDER BY created_at',[sellerScope,operation,new Date(now-60000)])).rows;
    let retryAt=0;
    if(rows.reduce((sum,r)=>sum+Number(r.units),0)+units>limit)retryAt=rows.length?new Date(rows[0].created_at).getTime()+60000:now+60000;
    if(operation==='stock')for(const row of rows){if((row.pair_keys||[]).some(key=>pairKeys.includes(key)))retryAt=Math.max(retryAt,new Date(row.created_at).getTime()+30000);}
    if(retryAt>now){await client.query('COMMIT');return {allowed:false,retryAfterMs:Math.max(1000,retryAt-now)};}
    await client.query('INSERT INTO ozon_write_rate_reservations(seller_scope,request_key,operation,units,pair_keys,created_at) VALUES($1,$2,$3,$4,$5,$6)',[sellerScope,requestKey,operation,units,pairKeys,new Date(now)]);
    await client.query('COMMIT');
    return {allowed:true};
  } catch(error) {await client.query('ROLLBACK');throw error;} finally {if(!borrowedClient)client.release();}
}
