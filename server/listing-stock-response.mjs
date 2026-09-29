import {getPostgresPool} from './db/connection.mjs';
import {projectSubmissionStockWriteCommandV3} from './listing-pipeline.mjs';

const conflict=()=>Object.assign(new Error('库存响应记录与冻结请求不匹配'),{code:'LISTING_STOCK_WRITE_IDENTITY_CONFLICT'});
async function transaction(client, action) {
  if(client)return action(client);
  const connection=await (await getPostgresPool()).connect();
  try {await connection.query('BEGIN');const result=await action(connection);await connection.query('COMMIT');return result;}
  catch(error){await connection.query('ROLLBACK');throw error;}
  finally {connection.release();}
}
async function intent(client, rawCommand, lock=false) {
  const command=projectSubmissionStockWriteCommandV3(rawCommand);
  if(!command)throw conflict();
  const result=await client.query(`SELECT id,status FROM submission_stock_write_intents
    WHERE account_id=$1 AND submission_job_id=$2 AND submission_snapshot_id=$3 AND store_id=$4
      AND import_ozon_task_id=$5 AND recovery_attempt_id IS NOT DISTINCT FROM $6::text
      AND request_hash=$7 AND correlation_id=$8 AND stock_items=$9::jsonb ${lock?'FOR UPDATE':''}`,
    [command.accountId,command.jobId,command.snapshotId,command.storeId,command.importOzonTaskId,
      command.recoveryAttemptId,command.requestHash,command.correlationId,JSON.stringify(command.stocks)]);
  if(result.rowCount!==1)throw conflict();
  return {command,row:result.rows[0]};
}
export async function resolveSubmissionStockResponseV3(rawCommand, summary, {client}={}) {
  return transaction(client,async connection=>{
    const {command,row}=await intent(connection,rawCommand,true);
    if(row.status==='RESOLVED')return {status:row.status};
    if(row.status!=='IN_FLIGHT')throw conflict();
    // Summary and receipt event commit together. Recovery never depends on an
    // uncommitted HTTP result or on a later overwrite of the mutable summary.
    const changed=await connection.query(`UPDATE submission_jobs SET result_summary=$4::jsonb
      WHERE account_id=$1 AND id=$2 AND snapshot_id=$3 AND store_id=$5
        AND ozon_task_id=$6 AND status IN ('CHECKING','RECONCILING')`,
      [command.accountId,command.jobId,command.snapshotId,JSON.stringify(summary),command.storeId,command.importOzonTaskId]);
    if(changed.rowCount!==1)throw conflict();
    await connection.query(`UPDATE submission_stock_write_intents SET status='RESOLVED',done_at=STATEMENT_TIMESTAMP(),actor_id=$3
      WHERE account_id=$1 AND id=$2`,[command.accountId,row.id,command.actorId]);
    return {status:'RESOLVED'};
  });
}
export async function readResolvedStockResponseV3(rawCommand,{client}={}) {
  const connection=client||await getPostgresPool();
  const {command,row}=await intent(connection,rawCommand);
  if(row.status!=='RESOLVED')throw conflict();
  const result=await connection.query(`SELECT payload->'stockResults' AS results FROM submission_stock_write_events
    WHERE account_id=$1 AND stock_write_intent_id=$2 AND to_status='RESOLVED' ORDER BY id DESC LIMIT 1`,[command.accountId,row.id]);
  if(!Array.isArray(result.rows[0]?.results))throw conflict();
  return result.rows[0].results;
}
export async function reprepareResolvedStockWriteV3(rawCommand,{client}={}) {
  return transaction(client,async connection=>{
    const {command,row}=await intent(connection,rawCommand,true);
    if(row.status==='PREPARED')return {status:'PREPARED'};
    if(row.status!=='RESOLVED')throw conflict();
    // The DB guard uses the prior immutable receipt, never caller-supplied retry flags.
    await connection.query(`UPDATE submission_stock_write_intents SET status='PREPARED',in_flight_at=NULL,done_at=NULL,actor_id=$3
      WHERE account_id=$1 AND id=$2`,[command.accountId,row.id,command.actorId]);
    return {status:'PREPARED'};
  });
}
