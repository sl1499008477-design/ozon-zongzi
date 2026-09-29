// Explicit, transactional migration. Default is a dry run; --apply commits.
import '../server/env.mjs';
import {createHash} from 'node:crypto';
import {getPostgresPool} from '../server/db/connection.mjs';
import {loadAutoListingCredentialKey} from '../server/auto-listing-ai-credential-config.mjs';
import {createAutoListingCredentialCipher} from '../server/auto-listing-ai-credential-crypto.mjs';
const pool=await getPostgresPool();const db=await pool.connect();
const cipher=createAutoListingCredentialCipher({key:await loadAutoListingCredentialKey({env:process.env}),keyVersion:process.env.AUTO_LISTING_CREDENTIAL_KEY_VERSION});
await db.query('BEGIN');
try {
 const rows=(await db.query(`SELECT p.*,c.connection_id AS route_connection_id,c.connection_version AS route_connection_version,c.display_name AS channel_name,c.enabled AS channel_enabled
  FROM ai_gateway_profiles p LEFT JOIN auto_listing_ai_profile_channels c
  ON c.account_id=p.account_id AND c.profile_id=p.id AND c.profile_version=p.config_version
  WHERE p.enabled=TRUE ORDER BY p.account_id,c.channel_order NULLS FIRST`)).rows;
 let inserted=0;
 for(const row of rows){
  const connectionId=row.route_connection_id||row.connection_id;const version=row.route_connection_version||row.connection_version;
  let key;
  if(connectionId){
   const connection=(await db.query('SELECT * FROM ai_gateway_connection_versions WHERE account_id=$1 AND id=$2 AND version=$3',[row.account_id,connectionId,version])).rows[0];
   if(!connection)throw new Error('旧连接不存在，迁移已回滚');
   row.base_url=connection.base_url;
   key=cipher.decrypt({accountId:row.account_id,connectionId,connectionVersion:version},{ciphertext:connection.ciphertext,iv:connection.iv,authTag:connection.auth_tag,algorithm:connection.algorithm,keyVersion:connection.key_version});
  }else key=process.env[row.api_key_env_name];
  if(!key)throw new Error('旧凭据不可用，迁移已回滚');
  const fingerprint=cipher.fingerprint(key);
  const existing=(await db.query('SELECT account_id FROM ai_user_channels WHERE key_fingerprint=$1',[fingerprint])).rows[0];
  if(existing){if(existing.account_id!==row.account_id)throw new Error('旧Key跨账号共享，不能自动分配，请先拆分网关账户');continue;}
  const id='migrated-'+createHash('sha256').update(row.account_id+fingerprint).digest('hex').slice(0,32);
  const profileId='user-channel-'+id;
  const credential=cipher.encrypt({accountId:row.account_id,connectionId:id,connectionVersion:1},key);
  await db.query(`INSERT INTO ai_gateway_profiles(id,account_id,display_name,base_url,api_key_env_name,text_protocol,image_protocol,text_model,image_model,config_version,enabled,created_by)
   VALUES($1,$2,$3,$4,'USER_AI_CHANNEL_KEY','SUB2API_RESPONSES',$5,$6,$7,1,FALSE,$2)`,[profileId,row.account_id,row.channel_name||row.display_name,row.base_url,row.image_protocol,row.text_model,row.image_model]);
  await db.query(`INSERT INTO ai_user_channels(id,account_id,created_by,name,base_url,text_model,image_model,billing_account,credential,key_fingerprint,enabled,image_protocol,profile_id)
   VALUES($1,$2,$2,$3,$4,$5,$6,'原账户（待核对网关计费账户）',$7::jsonb,$8,$9,$10,$11)`,
   [id,row.account_id,row.channel_name||row.display_name,row.base_url,row.text_model,row.image_model,JSON.stringify(credential),fingerprint,row.channel_enabled!==false,row.image_protocol,profileId]);
  inserted++;
 }
 await db.query(process.argv.includes('--apply')?'COMMIT':'ROLLBACK');
 console.log(JSON.stringify({inserted,committed:process.argv.includes('--apply'),originalRecordsPreserved:true}));
}catch(error){await db.query('ROLLBACK');console.error(error.code||'迁移失败，所有写入已回滚');process.exitCode=1;}
finally{db.release();await pool.end();}
