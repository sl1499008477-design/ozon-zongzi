import {pinOzonCredential} from './account-ozon-route.mjs';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { defaultMessageTemplates, normalizeMessageTemplate, renderMessageTemplate, MESSAGE_VARIABLES, MESSAGE_TRIGGERS } from './message-template.mjs';
import { applyMessageEvent, canAttemptMessageChat, createMessageOzon, messageEligibility, messageFingerprint, postingStateFilter, subscriptionEligible, triggerForPosting } from './message-ozon.mjs';
import { readStoreCredentialV3 } from './listing-pipeline.mjs';

const HOUR = 3600000;
const error = (message,status = 400,code = 'MESSAGE_INVALID') => Object.assign(new Error(message),{status,code});
const parameters = ({accountId,storeId}) => [accountId,storeId];
const preparationStates=['awaiting_packaging','awaiting_deliver','delivering'];
const preparationExcluded=['posting_in_pickup_point','posting_conditionally_delivered','posting_returned_to_warehouse'];
const canPrepareChat=(p,now)=>p && !p.chatId && canAttemptMessageChat(p,now) && preparationStates.includes(p.status)
  && !preparationExcluded.includes(p.substatus) && !p.events?.PICKUP && !['CREATING','UNCERTAIN','REJECTED'].includes(p.chatPreparation?.status);
const recordView = row => ({...row.body,id:row.id,status:row.status,dueAt:Number(row.due_at),createdAt:Number(row.created_at)});
const publicRecord = row => {
  const {template,baseline,sendStartedAt,phase,...view} = recordView(row);
  return {...view,templateVersion:template?.version};
};
const safeFailure = e => /^(?:ZONGZI|OZON)_/.test(e?.code || '') ? `Ozon 请求未完成（${e.code}），请检查店铺权限或连接`
  : /^MESSAGE_/.test(e?.code || '') ? e.message : '消息处理失败，请稍后检查连接和服务状态';

export function createMessageService({pool,ozon = createMessageOzon(),readCredential = readStoreCredentialV3,clock = Date.now} = {}) {
  const controlKey=scope=>`ozon-message-control:${scope.accountId}:${scope.storeId}`;
  async function assertStore(scope,db=pool) {
    if (!scope.accountId || !scope.storeId || String(scope.storeId).length > 240) throw error('请选择当前账号的店铺',400);
    const {rows} = await db.query(`SELECT s.* FROM stores s JOIN accounts a ON a.id=s.owner_account_id
      WHERE s.id=$1 AND s.owner_account_id=$2 AND s.status<>'disabled' AND a.status='active'
      AND (a.expires_at IS NULL OR a.expires_at>NOW())`,[scope.storeId,scope.accountId]);
    if (!rows[0]) throw error('店铺不属于当前账号或账号不可用',403,'MESSAGE_STORE_FORBIDDEN');
    return rows[0];
  }
  async function transaction(work) {
    const client = await pool.connect();
    try {await client.query('BEGIN');const result=await work(client);await client.query('COMMIT');return result;}
    catch(e) {await client.query('ROLLBACK');throw e;}
    finally {client.release();}
  }
  async function sendingLock(scope,work) {
    const client=await pool.connect();const key=controlKey(scope);
    try {await client.query('SELECT pg_advisory_lock(hashtextextended($1,0))',[key]);return await work(client);}
    finally {try {await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[key]);} finally {client.release();}}
  }
  async function pendingChatCreation(scope,number,db,exceptId='') {
    return (await db.query(`SELECT status FROM ozon_message_records WHERE account_id=$1 AND store_id=$2
      AND body->>'postingNumber'=$3 AND id<>$4 AND body->>'phase' IN ('CHAT_START','CHAT_READY')
      AND status IN ('SENDING','PENDING','UNCERTAIN') ORDER BY (status='UNCERTAIN') DESC LIMIT 1`,
      [...parameters(scope),number,exceptId])).rows[0];
  }
  async function settingsRow(scope,db=pool) {
    let row=(await db.query('SELECT * FROM ozon_message_settings WHERE account_id=$1 AND store_id=$2',parameters(scope))).rows[0];
    if (!row) await transaction(async client=>{
      const created=await client.query(`INSERT INTO ozon_message_settings(account_id,store_id,webhook_token) VALUES($1,$2,$3)
        ON CONFLICT DO NOTHING RETURNING store_id`,[...parameters(scope),randomBytes(32).toString('hex')]);
      if (created.rowCount) for (const template of defaultMessageTemplates()) await client.query(
        'INSERT INTO ozon_message_templates(id,account_id,store_id,body,created_at) VALUES($1,$2,$3,$4,$5)',
        [randomUUID(),...parameters(scope),template,clock()]);
    });
    return row || (await db.query('SELECT * FROM ozon_message_settings WHERE account_id=$1 AND store_id=$2',parameters(scope))).rows[0];
  }
  async function updateState(scope,patch,nextSyncAt) {
    await pool.query(`UPDATE ozon_message_settings SET state=state || $3::jsonb,
      next_sync_at=COALESCE($4,next_sync_at) WHERE account_id=$1 AND store_id=$2`,[...parameters(scope),patch,nextSyncAt ?? null]);
  }
  async function settings(scope) {
    const row=await settingsRow(scope);
    const counts=(await pool.query(`SELECT status,COUNT(*)::integer AS count FROM ozon_message_records
      WHERE account_id=$1 AND store_id=$2 GROUP BY status`,parameters(scope))).rows;
    const prepared=(await pool.query(`SELECT CASE WHEN COALESCE(body->>'chatId','')<>'' THEN 'READY'
      ELSE body->'chatPreparation'->>'status' END AS status,COUNT(*)::integer AS count FROM ozon_message_postings
      WHERE account_id=$1 AND store_id=$2 AND body ? 'chatPreparation' GROUP BY 1`,parameters(scope))).rows;
    const {sync,chatTodo,...state}=row.state;
    return {...row.config,...state,subscriptionEligible:state.subscriptionEligible === true,
      webhookUrl:row.config.webhookBaseUrl ? `${row.config.webhookBaseUrl}/ozon/messages/webhook/${encodeURIComponent(scope.storeId)}/${row.webhook_token}` : '',
      counts:Object.fromEntries(counts.map(r=>[r.status,r.count])),chatPreparationCounts:Object.fromEntries(prepared.map(r=>[r.status,r.count]))};
  }
  async function templates(scope) {
    return (await pool.query(`SELECT t.id,t.body,COALESCE(s.count,0)::integer AS sent_count FROM ozon_message_templates t
      LEFT JOIN (SELECT template_id,COUNT(*) AS count FROM ozon_message_records WHERE account_id=$1 AND store_id=$2 AND status='SENT' GROUP BY template_id) s ON s.template_id=t.id
      WHERE t.account_id=$1 AND t.store_id=$2 ORDER BY t.created_at,t.id`,parameters(scope))).rows.map(r=>({...r.body,id:r.id,sentCount:r.sent_count}));
  }
  async function records(scope,{status='',trigger='',page=1,pageSize} = {}) {
    await assertStore(scope);
    const paged=pageSize!==undefined;
    if(paged&&(![5,10,20,50].includes(Number(pageSize))||!Number.isInteger(Number(page))||Number(page)<1))throw error('分页参数无效');
    const values=[...parameters(scope),status,trigger],source=`FROM ozon_message_records WHERE account_id=$1 AND store_id=$2
      AND ($3='' OR status=$3) AND ($4='' OR body->>'trigger'=$4)`;
    const rows=(await pool.query(`SELECT * ${source} ORDER BY created_at DESC,id DESC LIMIT $5 OFFSET $6`,[...values,paged?Number(pageSize):100,paged?(Number(page)-1)*Number(pageSize):0])).rows.map(publicRecord);
    return paged?{items:rows,total:(await pool.query(`SELECT COUNT(*)::int AS total ${source}`,values)).rows[0].total}:rows;
  }
  async function postings(scope,{q='',trigger='',page=1,pageSize} = {}) {
    await assertStore(scope);
    const paged=pageSize!==undefined;
    if(paged&&(![5,10,20,50].includes(Number(pageSize))||!Number.isInteger(Number(page))||Number(page)<1))throw error('分页参数无效');
    const filter=postingStateFilter(trigger);
    if(trigger&&!filter)return paged?{items:[],total:0}:[];
    const values=[...parameters(scope),String(q).slice(0,120),`%${String(q).slice(0,120)}%`,filter?.status||'',filter?.substatuses||[]];
    const source=`FROM ozon_message_postings WHERE account_id=$1 AND store_id=$2
      AND ($3='' OR posting_number ILIKE $4 OR body->>'orderNumber' ILIKE $4)
      AND ($5='' OR (body->>'status'=$5 AND COALESCE(body->>'substatus','')=ANY($6::text[])))`;
    const rows=(await pool.query(`SELECT body ${source} ORDER BY updated_at DESC,posting_number LIMIT $7 OFFSET $8`,[...values,paged?Number(pageSize):100,paged?(Number(page)-1)*Number(pageSize):0])).rows;
    const items=rows.map(({body})=>({...body,trigger:triggerForPosting(body),reason:messageEligibility(body,trigger||triggerForPosting(body),clock()).reason}));
    return paged?{items,total:(await pool.query(`SELECT COUNT(*)::int AS total ${source}`,values)).rows[0].total}:items;
  }
  async function overview(scope,{summaryOnly=false}={}) {
    await assertStore(scope);await settingsRow(scope);
    const [configuration,templateList,postingList,recordList]=await Promise.all([settings(scope),templates(scope),summaryOnly?[]:postings(scope),summaryOnly?[]:records(scope)]);
    return {settings:configuration,templates:templateList,postings:postingList,records:recordList,variables:MESSAGE_VARIABLES,triggers:MESSAGE_TRIGGERS};
  }
  async function saveSettings(scope,input) {
    if(!input||typeof input!=='object'||Array.isArray(input))throw error('消息设置必须是对象');
    await assertStore(scope);await settingsRow(scope);let config;
    await transaction(async client=>{
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[controlKey(scope)]);
    const row=await settingsRow(scope,client);config={...row.config};
    if ('enabled' in input) {if(typeof input.enabled!=='boolean')throw error('发送开关无效');config.enabled=input.enabled;}
    if ('displayName' in input) {if(typeof input.displayName!=='string'||input.displayName.trim().length>100)throw error('店铺名称最多 100 字');config.displayName=input.displayName.trim();}
    if ('timeZone' in input) {try {new Intl.DateTimeFormat('ru-RU',{timeZone:input.timeZone}).format();} catch {throw error('时区无效');} config.timeZone=input.timeZone;}
    if ('webhookBaseUrl' in input) {
      const value=typeof input.webhookBaseUrl==='string' ? input.webhookBaseUrl.trim().replace(/\/+$/,'') : '';
      if (value) {let url;try {url=new URL(value);}catch {throw error('请填写公开 HTTPS API 地址');}
        if (url.protocol!=='https:'||url.username||url.password||url.search||url.hash||value.length>500)throw error('请填写不含凭证或查询参数的 HTTPS API 地址');}
      config.webhookBaseUrl=value;
    }
    if (config.enabled && !row.state.subscriptionEligible) throw error('请先同步并确认店铺具有 Premium Plus 或 Premium Pro',409,'MESSAGE_SUBSCRIPTION_REQUIRED');
    await client.query('UPDATE ozon_message_settings SET config=$3 WHERE account_id=$1 AND store_id=$2',[...parameters(scope),config]);
    if (!config.enabled) await client.query(`UPDATE ozon_message_records SET status='CANCELLED',body=body || '{"reason":"店铺自动发送已关闭"}'
      WHERE account_id=$1 AND store_id=$2 AND status='PENDING'`,parameters(scope));
    });
    if (config.enabled)await enqueue(scope);
    return settings(scope);
  }
  async function saveTemplate(scope,input,id) {
    await assertStore(scope);await settingsRow(scope);
    let saved;
    await transaction(async client=>{
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[controlKey(scope)]);
      const previous=id ? (await client.query('SELECT body FROM ozon_message_templates WHERE account_id=$1 AND store_id=$2 AND id=$3',[...parameters(scope),id])).rows[0]?.body : undefined;
      if (id&&!previous)throw error('模板不存在',404,'MESSAGE_NOT_FOUND');
      const template=normalizeMessageTemplate(input,previous);
      if (template.enabled) {
        const other=await client.query(`SELECT id FROM ozon_message_templates WHERE account_id=$1 AND store_id=$2 AND body->>'trigger'=$3
          AND body->>'enabled'='true' AND id<>$4`,[...parameters(scope),template.trigger,id || '']);
        if (other.rowCount)throw error('每种触发状态只能启用一个模板，请先停用同类型模板',409,'MESSAGE_TEMPLATE_CONFLICT');
      }
      const templateId=id || randomUUID();
      await client.query(`INSERT INTO ozon_message_templates(id,account_id,store_id,body,created_at) VALUES($1,$2,$3,$4,$5)
        ON CONFLICT(id) DO UPDATE SET body=EXCLUDED.body`,[templateId,...parameters(scope),template,clock()]);
      await client.query(`UPDATE ozon_message_records SET status='CANCELLED',body=body || '{"reason":"模板已修改，等待按新配置重新计算"}'
        WHERE account_id=$1 AND store_id=$2 AND template_id=$3 AND status='PENDING'`,[...parameters(scope),templateId]);
      saved={...template,id:templateId};
    });
    await enqueue(scope);return saved;
  }
  async function deleteTemplate(scope,id) {
    await assertStore(scope);
    await transaction(async client=>{
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[controlKey(scope)]);
    const result=await client.query('DELETE FROM ozon_message_templates WHERE account_id=$1 AND store_id=$2 AND id=$3',[...parameters(scope),id]);
    if (!result.rowCount)throw error('模板不存在',404,'MESSAGE_NOT_FOUND');
    await client.query(`UPDATE ozon_message_records SET status='CANCELLED',body=body || '{"reason":"模板已删除"}'
      WHERE account_id=$1 AND store_id=$2 AND template_id=$3 AND status='PENDING'`,[...parameters(scope),id]);
    });
    return {ok:true};
  }
  async function getPosting(scope,postingNumber,db=pool) {
    return (await db.query('SELECT body FROM ozon_message_postings WHERE account_id=$1 AND store_id=$2 AND posting_number=$3',[...parameters(scope),postingNumber])).rows[0]?.body;
  }
  async function preview(scope,{template,postingNumber}) {
    await assertStore(scope);const normalized=normalizeMessageTemplate(template);
    const posting=await getPosting(scope,postingNumber);
    if(!posting)throw error('当前店铺中找不到该包裹，请先同步订单',404,'MESSAGE_NOT_FOUND');
    const row=await settingsRow(scope);const rendered=renderMessageTemplate(normalized,posting,row.config);
    const eligibility=messageEligibility(posting,normalized.trigger,clock());
    return {...rendered,reason:rendered.reason || eligibility.reason,reasons:[...new Set([rendered.reason,...eligibility.reasons].filter(Boolean))],eligible:eligibility.allowed,posting};
  }
  async function storeSnapshots(scope,items,fetchedAt) {
    if (!items.length)return;
    await pool.query(`INSERT INTO ozon_message_postings AS p(account_id,store_id,posting_number,body,updated_at)
      SELECT $1,$2,item->>'postingNumber',item,$4 FROM jsonb_array_elements($3::jsonb) item
      ON CONFLICT(account_id,store_id,posting_number) DO UPDATE SET
      body=CASE WHEN COALESCE((p.body->>'fetchedAt')::bigint,0)>$5 THEN p.body ELSE
        p.body || EXCLUDED.body || jsonb_build_object('events',EXCLUDED.body->'events' || COALESCE(p.body->'events','{}'::jsonb)) ||
        CASE WHEN COALESCE((p.body->>'eventReceivedAt')::bigint,0)>$5
          THEN jsonb_build_object('status',p.body->'status','substatus',p.body->'substatus') ELSE '{}'::jsonb END END,
      updated_at=EXCLUDED.updated_at`,[...parameters(scope),JSON.stringify(items.map(p=>({...p,fetchedAt}))),clock(),fetchedAt]);
  }
  async function rememberChat(scope,chatId,history) {
    if (!history.orderNumbers.length)return;
    await pool.query(`UPDATE ozon_message_postings SET body=body || $4::jsonb,updated_at=$5
      WHERE account_id=$1 AND store_id=$2 AND body->>'orderNumber'=ANY($3::text[])
      AND (COALESCE(body->>'lastBuyerAt','')<=$6 OR body->>'chatId'=$7 OR COALESCE(body->>'chatId','')='')`,
      [...parameters(scope),history.orderNumbers,{chatId,lastBuyerAt:history.lastBuyerAt},clock(),history.lastBuyerAt,chatId]);
  }
  async function requestSync(scope) {
    await assertStore(scope);await settingsRow(scope);
    await updateState(scope,{syncing:true,syncError:'',syncProgress:'等待同步订单与聊天'},clock());
    return overview(scope);
  }
  async function syncStore(scope) {
    await assertStore(scope);const client=await pool.connect();const lock=`ozon-message-sync:${scope.accountId}:${scope.storeId}`;
    let locked=false;
    try {
      locked=(await client.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired',[lock])).rows[0].acquired;
      if(!locked)return;
      const row=await settingsRow(scope);const credential=await readCredential(scope.storeId,scope.accountId);
      if(!credential)throw error('店铺 API 凭证不可用',409,'MESSAGE_CREDENTIALS_REQUIRED');
      let sync=row.state.sync;
      if(!sync) {
        const subscription=await ozon.subscription(credential);
        sync={phase:'FBS',since:new Date(clock()-90*24*HOUR).toISOString(),to:new Date(clock()).toISOString(),cursor:''};
        await updateState(scope,{subscriptionType:subscription.type || 'UNKNOWN',subscriptionEligible:subscriptionEligible(subscription),syncing:true,syncError:'',chatScanComplete:false,sync});
      }
      // Bounded batches resume a persisted cursor, so large shops never silently
      // stop at the first page or tie up a foreground HTTP request.
      for(let step=0;step<12 && sync;step++) {
        if(sync.phase==='FBS'||sync.phase==='FBO') {
          const started=clock();const result=await ozon.listPostings(credential,sync.phase,sync);
          await storeSnapshots(scope,result.postings,started);
          sync=result.hasNext ? {...sync,cursor:result.cursor} : { ...sync,phase:sync.phase==='FBS'?'FBO':'CHATS',cursor:''};
        } else if(sync.todo?.length) {
          const chatId=sync.todo[0];const history=await ozon.history(credential,chatId);await rememberChat(scope,chatId,history);
          sync={...sync,todo:sync.todo.slice(1)};
          if(!sync.todo.length&&sync.lastPage)sync=null;
        } else {
          const result=await ozon.chats(credential,sync.cursor);
          sync={...sync,cursor:result.cursor,todo:result.chats.map(c=>c.chat_id),lastPage:!result.hasNext};
          if(!sync.todo.length&&sync.lastPage)sync=null;
        }
        await updateState(scope,{sync,syncing:Boolean(sync),syncProgress:sync ? `正在同步 ${sync.phase==='CHATS'?'买家会话':sync.phase+' 订单'}，分页进度已保存` : '',
          ...(sync?{}:{lastSyncAt:clock(),chatScanComplete:true,syncError:''})},sync ? clock()+1000 : clock()+5*60000);
      }
      // A callback may reference an older order outside the initial 90-day
      // snapshot. Fetch those placeholders by posting number, never fake fields.
      const unknown=(await pool.query(`SELECT body FROM ozon_message_postings WHERE account_id=$1 AND store_id=$2
        AND COALESCE(body->>'fetchedAt','')='' ORDER BY updated_at LIMIT 10`,parameters(scope))).rows;
      for(const {body} of unknown) {const started=clock();await storeSnapshots(scope,[await ozon.getPosting(credential,body)],started);}
      const pending=(await settingsRow(scope)).state.chatTodo || [];
      for(const chatId of pending.slice(0,10)) {
        await rememberChat(scope,chatId,await ozon.history(credential,chatId));
        await pool.query(`UPDATE ozon_message_settings SET state=jsonb_set(state,'{chatTodo}',COALESCE(state->'chatTodo','[]'::jsonb)-$3)
          WHERE account_id=$1 AND store_id=$2`,[...parameters(scope),chatId]);
      }
      await enqueue(scope);
    } catch(e) {await updateState(scope,{syncing:false,syncError:safeFailure(e),syncProgress:'同步未完成；下次从已保存的位置继续'},clock()+60000);throw e;}
    finally {if(locked)await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[lock]);client.release();}
  }
  async function syncNext() {
    const row=(await pool.query(`SELECT m.account_id,m.store_id FROM ozon_message_settings m
      JOIN stores s ON s.id=m.store_id AND s.owner_account_id=m.account_id JOIN accounts a ON a.id=m.account_id
      WHERE m.next_sync_at<=$1 AND (m.config->>'enabled'='true' OR m.state->>'syncing'='true' OR m.state->'sync' IS NOT NULL AND m.state->'sync'<>'null'::jsonb)
        AND s.status<>'disabled' AND a.status='active' AND (a.expires_at IS NULL OR a.expires_at>NOW())
      ORDER BY m.next_sync_at LIMIT 1`,[clock()])).rows[0];
    if(row)await syncStore({accountId:row.account_id,storeId:row.store_id});
  }
  async function prepareChatNext() {
    await pool.query(`UPDATE ozon_message_postings SET body=jsonb_set(body,'{chatPreparation}',
      (body->'chatPreparation') || '{"status":"UNCERTAIN","reason":"创建聊天时服务中断，等待同步核对；不会重复创建"}'::jsonb)
      WHERE body->'chatPreparation'->>'status'='CREATING' AND (body->'chatPreparation'->>'at')::bigint<$1`,[clock()-5*60000]);
    const candidate=(await pool.query(`SELECT p.* FROM ozon_message_postings p
      JOIN ozon_message_settings m USING(account_id,store_id)
      JOIN stores s ON s.id=p.store_id AND s.owner_account_id=p.account_id JOIN accounts a ON a.id=p.account_id
      WHERE m.config->>'enabled'='true' AND m.state->>'subscriptionEligible'='true' AND m.state->>'chatScanComplete'='true'
        AND s.status<>'disabled' AND a.status='active' AND (a.expires_at IS NULL OR a.expires_at>NOW())
        AND p.body->>'scheme' IN ('FBS','rFBS') AND COALESCE(p.body->>'chatId','')=''
        AND (p.body->>'canCreateChat'='true' OR
          (EXTRACT(EPOCH FROM (p.body->>'inProcessAt')::timestamptz)*1000)>$3::bigint-259200000
          AND (EXTRACT(EPOCH FROM (p.body->>'inProcessAt')::timestamptz)*1000)<=$3::bigint)
        AND p.body->>'status'=ANY($1::text[]) AND NOT(COALESCE(p.body->>'substatus','')=ANY($2::text[]))
        AND NOT(p.body->'events' ? 'PICKUP') AND COALESCE(p.body->'chatPreparation'->>'status','') IN ('','RETRY')
        AND COALESCE((p.body->'chatPreparation'->>'nextAttemptAt')::bigint,0)<=$3
        AND NOT EXISTS(SELECT 1 FROM ozon_message_records r WHERE r.account_id=p.account_id AND r.store_id=p.store_id
          AND r.body->>'postingNumber'=p.posting_number AND r.body->>'phase' IN ('CHAT_START','CHAT_READY')
          AND r.status IN ('SENDING','PENDING','UNCERTAIN'))
        AND EXISTS(SELECT 1 FROM ozon_message_templates t WHERE t.account_id=p.account_id AND t.store_id=p.store_id
          AND t.body->>'trigger'='PICKUP' AND t.body->>'enabled'='true')
      ORDER BY p.updated_at DESC,p.posting_number LIMIT 1`,[preparationStates,preparationExcluded,clock()])).rows[0];
    if(!candidate)return false;
    const scope={accountId:candidate.account_id,storeId:candidate.store_id};
    const number=candidate.posting_number;
    const save=async(db,preparation,chatId)=>db.query(`UPDATE ozon_message_postings SET body=body || $4::jsonb
      WHERE account_id=$1 AND store_id=$2 AND posting_number=$3`,[...parameters(scope),number,
      {chatPreparation:preparation,...(chatId?{chatId}:{})}]);
    let credential;
    try {
      credential=await readCredential(scope.storeId,scope.accountId);
      if(!credential)throw error('店铺 API 凭证不可用',409,'MESSAGE_CREDENTIALS_REQUIRED');
      const subscription=await ozon.subscription(credential);
      await updateState(scope,{subscriptionType:subscription.type||'UNKNOWN',subscriptionEligible:subscriptionEligible(subscription)});
      if(!subscriptionEligible(subscription))return true;
      const started=clock();await storeSnapshots(scope,[await ozon.getPosting(credential,candidate.body)],started);
    } catch(e) {
      await sendingLock(scope,async client=>{
        const latest=await getPosting(scope,number,client);
        if(canPrepareChat(latest,clock()))await save(client,{status:'RETRY',at:clock(),nextAttemptAt:clock()+5*60000,reason:safeFailure(e)});
      });
      return true;
    }
    await sendingLock(scope,async client=>{
      await assertStore(scope,client);
      const configuration=await settingsRow(scope,client);
      if(!configuration.config.enabled||!configuration.state.subscriptionEligible||!configuration.state.chatScanComplete)return;
      const pickup=await client.query(`SELECT 1 FROM ozon_message_templates WHERE account_id=$1 AND store_id=$2
        AND body->>'trigger'='PICKUP' AND body->>'enabled'='true' LIMIT 1`,parameters(scope));
      const latest=await getPosting(scope,number,client);
      if(!pickup.rowCount||!canPrepareChat(latest,clock())||await pendingChatCreation(scope,number,client))return;
      const at=clock();
      // Commit before the external write. A crash must never lead to blind recreation.
      await save(client,{status:'CREATING',at,reason:'正在准备买家会话'});
      try {
        const chatId=await ozon.startChat(credential,number);
        await save(client,{status:'READY',at,preparedAt:clock(),reason:'会话已准备，到店后按模板发送'},chatId);
      } catch(e) {
        const rejected=/^ZONGZI_HTTP_4\d\d$/.test(e?.code||'');
        const retry=e?.code==='ZONGZI_HTTP_429';
        await save(client,{status:retry?'RETRY':rejected?'REJECTED':'UNCERTAIN',at,
          ...(retry?{nextAttemptAt:clock()+5*60000}:{}),
          reason:rejected?safeFailure(e):'创建聊天结果不明，等待同步核对；不会重复创建'});
      }
    });
    return true;
  }
  async function webhook(storeId,token,event) {
    const row=(await pool.query(`SELECT m.*,s.client_id FROM ozon_message_settings m JOIN stores s ON s.id=m.store_id AND s.owner_account_id=m.account_id
      WHERE m.store_id=$1 AND s.status<>'disabled'`,[storeId])).rows[0];
    if(!row || typeof token!=='string' || Buffer.byteLength(token)!==Buffer.byteLength(row.webhook_token) || !timingSafeEqual(Buffer.from(token),Buffer.from(row.webhook_token)))throw error('回调地址不存在',404,'MESSAGE_NOT_FOUND');
    const ack={version:'1.0',name:'sonli-messages',time:new Date(clock()).toISOString()};
    if(event?.message_type==='TYPE_PING')return ack;
    if(String(event?.seller_id)!==String(row.client_id))throw error('回调店铺不匹配',403,'MESSAGE_EVENT_FORBIDDEN');
    const scope={accountId:row.account_id,storeId};
    if(['TYPE_STATE_CHANGED','TYPE_FBO_POSTING_STATE_CHANGED'].includes(event.message_type)) {
      if(typeof event.posting_number!=='string'||!event.posting_number||event.posting_number.length>100)throw error('包裹编号无效');
      if(!Number.isFinite(Date.parse(event.changed_state_date))||Date.parse(event.changed_state_date)>clock()+5*60000)throw error('状态时间无效');
      await transaction(async client=>{
        await client.query(`INSERT INTO ozon_message_postings(account_id,store_id,posting_number,body,updated_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
          [...parameters(scope),event.posting_number,{postingNumber:event.posting_number,orderNumber:event.order_number||'',scheme:event.message_type.includes('FBO')?'FBO':'FBS',events:{}},clock()]);
        const posting=(await client.query(`SELECT body FROM ozon_message_postings WHERE account_id=$1 AND store_id=$2 AND posting_number=$3 FOR UPDATE`,[...parameters(scope),event.posting_number])).rows[0].body;
        const next=applyMessageEvent(posting,event);
        // A late callback can fill missing timestamps, but must not regress a
        // newer authoritative GET snapshot (e.g. signed back to pickup).
        if(posting.fetchedAt && Date.parse(event.changed_state_date)<posting.fetchedAt)Object.assign(next,{status:posting.status,substatus:posting.substatus});
        const advancesState=(!posting.stateEventAt||Date.parse(event.changed_state_date)>Date.parse(posting.stateEventAt))
          && (!posting.fetchedAt||Date.parse(event.changed_state_date)>=posting.fetchedAt);
        if(advancesState)next.eventReceivedAt=clock();
        await client.query('UPDATE ozon_message_postings SET body=$4,updated_at=$5 WHERE account_id=$1 AND store_id=$2 AND posting_number=$3',[...parameters(scope),event.posting_number,next,clock()]);
      });
    } else if(event.message_type==='TYPE_NEW_MESSAGE' && event.chat_type==='Buyer_Seller' && event.user?.type==='Customer') {
      if(typeof event.chat_id!=='string'||event.chat_id.length>100)throw error('聊天编号无效');
      if(typeof event.created_at==='string'&&Number.isFinite(Date.parse(event.created_at))&&Date.parse(event.created_at)<=clock()+5*60000) {
        await pool.query(`UPDATE ozon_message_postings SET body=body || $4::jsonb WHERE account_id=$1 AND store_id=$2 AND body->>'chatId'=$3
          AND (COALESCE(body->>'lastBuyerAt','')='' OR (body->>'lastBuyerAt')::timestamptz<$5::timestamptz)`,
          [...parameters(scope),event.chat_id,{lastBuyerAt:event.created_at},event.created_at]);
      }
      await pool.query(`UPDATE ozon_message_settings SET state=jsonb_set(state,'{chatTodo}',(COALESCE(state->'chatTodo','[]'::jsonb)-$3) || to_jsonb($3::text))
        WHERE account_id=$1 AND store_id=$2`,[...parameters(scope),event.chat_id]);
    } else if(event.message_type==='TYPE_CHAT_CLOSED' && typeof event.chat_id==='string') {
      await pool.query(`UPDATE ozon_message_postings SET body=body-'chatId'-'lastBuyerAt' WHERE account_id=$1 AND store_id=$2 AND body->>'chatId'=$3`,[...parameters(scope),event.chat_id]);
    }
    await updateState(scope,{lastEventAt:clock()},clock());
    if(['TYPE_STATE_CHANGED','TYPE_FBO_POSTING_STATE_CHANGED'].includes(event.message_type))await enqueue(scope,event.posting_number);
    return {result:true};
  }
  async function enqueue(scope,postingNumber='') {
    const row=await settingsRow(scope);if(!row.config.enabled||!row.state.subscriptionEligible)return;
    await pool.query(`UPDATE ozon_message_records r SET
      due_at=GREATEST((EXTRACT(EPOCH FROM (p.body->'events'->>(r.body->>'trigger'))::timestamptz)*1000)::bigint
        + ((r.body->'template'->>'delayHours')::numeric*3600000)::bigint,COALESCE((r.body->>'retryAt')::bigint,0)),
      body=jsonb_set(r.body,'{eventAt}',to_jsonb((EXTRACT(EPOCH FROM (p.body->'events'->>(r.body->>'trigger'))::timestamptz)*1000)::bigint))
      FROM ozon_message_postings p WHERE r.account_id=$1 AND r.store_id=$2 AND r.status='PENDING'
        AND ($3='' OR p.posting_number=$3)
        AND p.account_id=r.account_id AND p.store_id=r.store_id AND p.posting_number=r.body->>'postingNumber'
        AND p.body->'events' ? (r.body->>'trigger')
        AND (r.body->>'eventAt')::bigint<>(EXTRACT(EPOCH FROM (p.body->'events'->>(r.body->>'trigger'))::timestamptz)*1000)::bigint`,[...parameters(scope),postingNumber]);
    const candidates=(await pool.query(`SELECT p.body AS posting,t.id AS template_id,t.body AS template FROM ozon_message_postings p
      JOIN ozon_message_templates t ON t.account_id=p.account_id AND t.store_id=p.store_id
      WHERE p.account_id=$1 AND p.store_id=$2 AND t.body->>'enabled'='true' AND p.body->'events' ? (t.body->>'trigger')
      AND ($3='' OR p.posting_number=$3)
      AND NOT EXISTS (SELECT 1 FROM ozon_message_records r WHERE r.account_id=p.account_id AND r.store_id=p.store_id
        AND r.dedupe_key=(t.body->>'trigger') || ':' || CASE WHEN t.body->>'trigger'='REVIEW' THEN p.body->>'orderNumber' ELSE p.posting_number END
        AND (r.status<>'CANCELLED' OR r.body ? 'sendStartedAt'))`,[...parameters(scope),postingNumber])).rows;
    const inserts=[];
    for(const {posting,template_id,template} of candidates) {
      if(!messageEligibility(posting,template.trigger,clock()).allowed || (template.trigger==='REVIEW'&&!posting.orderNumber))continue;
      const eventAt=Date.parse(posting.events[template.trigger]);
      const dueAt=eventAt+template.delayHours*HOUR;
      if(template.trigger==='REVIEW'&&dueAt>=eventAt+72*HOUR)continue;
      const dedupeKey=`${template.trigger}:${template.trigger==='REVIEW'?posting.orderNumber:posting.postingNumber}`;
      if(inserts.some(i=>i.dedupe_key===dedupeKey))continue;
      inserts.push({id:randomUUID(),dedupe_key:dedupeKey,template_id,due_at:dueAt,body:{template,templateName:template.name,trigger:template.trigger,
        postingNumber:posting.postingNumber,orderNumber:posting.orderNumber,eventAt,reason:'',text:''}});
    }
    if(inserts.length)await pool.query(`INSERT INTO ozon_message_records AS r(id,account_id,store_id,dedupe_key,template_id,status,due_at,created_at,body)
      SELECT i.id,$1,$2,i.dedupe_key,i.template_id,'PENDING',i.due_at,$4,i.body FROM jsonb_to_recordset($3::jsonb) i(id text,dedupe_key text,template_id text,due_at bigint,body jsonb)
      ON CONFLICT(account_id,store_id,dedupe_key) DO UPDATE SET status='PENDING',template_id=EXCLUDED.template_id,due_at=EXCLUDED.due_at,body=EXCLUDED.body
      WHERE r.status='CANCELLED' AND NOT(r.body ? 'sendStartedAt')`,[...parameters(scope),JSON.stringify(inserts),clock()]);
  }
  async function finish(scope,id,status,patch={},db=pool) {
    await db.query('UPDATE ozon_message_records SET status=$4,body=body || $5::jsonb WHERE account_id=$1 AND store_id=$2 AND id=$3',[...parameters(scope),id,status,patch]);
  }
  async function processNext() {
    await pool.query(`UPDATE ozon_message_records SET status=CASE WHEN body->>'phase' IN ('SEND','CHAT_START') THEN 'UNCERTAIN' ELSE 'PENDING' END,
      body=body || '{"reason":"任务中断；未执行发送的任务重新检查，写入结果不明的任务需核对"}'
      WHERE status='SENDING' AND claimed_at<$1`,[clock()-5*60000]);
    const row=(await pool.query(`UPDATE ozon_message_records r SET status='SENDING',claimed_at=$1 WHERE r.id=(
      SELECT j.id FROM ozon_message_records j JOIN ozon_message_settings m ON m.account_id=j.account_id AND m.store_id=j.store_id
      WHERE j.status='PENDING' AND j.due_at<=$1 AND m.config->>'enabled'='true' ORDER BY j.due_at,j.id FOR UPDATE OF j SKIP LOCKED LIMIT 1)
      AND r.status='PENDING' RETURNING r.*`,[clock()])).rows[0];
    if(!row)return false;
    const scope={accountId:row.account_id,storeId:row.store_id};const job=recordView(row);let ambiguousWrite=false;
    async function ownedFinish(status,patch={},db=pool,dueAt=null) {
      const result=await db.query(`UPDATE ozon_message_records SET status=$4,body=body || $5::jsonb,due_at=COALESCE($7,due_at)
        WHERE account_id=$1 AND store_id=$2 AND id=$3 AND status='SENDING' AND claimed_at=$6 RETURNING id`,
        [...parameters(scope),job.id,status,{...patch,...(job.ozonRoute?{ozonRoute:job.ozonRoute}:{})},row.claimed_at,dueAt]);
      return result.rowCount===1;
    }
    async function allowedConfiguration(client) {
      await assertStore(scope,client);
      const configuration=await settingsRow(scope,client);
      const current=(await client.query('SELECT body FROM ozon_message_templates WHERE account_id=$1 AND store_id=$2 AND id=$3',[...parameters(scope),row.template_id])).rows[0]?.body;
      return configuration.config.enabled && current?.enabled && current.version===job.template.version ? configuration : null;
    }
    async function finishIneligible(eligibility,posting,db=pool) {
      if(triggerForPosting(posting)!==job.trigger)return ownedFinish('CANCELLED',{reason:eligibility.reason},db);
      if(eligibility.waitingForChat) {
        const retryAt=clock()+15000;
        return ownedFinish('PENDING',{retryAt,reason:'正在准备买家会话，稍后复用并重新检查发送条件'},db,retryAt);
      }
      return ownedFinish('SKIPPED',{reason:eligibility.reason},db);
    }
    try {
      await assertStore(scope);const credential=pinOzonCredential(await readCredential(scope.storeId,scope.accountId),job);
      if(!credential)throw error('店铺 API 凭证不可用',409,'MESSAGE_CREDENTIALS_REQUIRED');
      const subscription=await ozon.subscription(credential);
      await updateState(scope,{subscriptionType:subscription.type||'UNKNOWN',subscriptionEligible:subscriptionEligible(subscription)});
      if(!subscriptionEligible(subscription))return await ownedFinish('SKIPPED',{reason:'当前店铺没有 Premium Plus/Pro 消息权限'});
      let posting=await getPosting(scope,job.postingNumber);
      if(!posting)throw error('找不到消息对应的包裹',404,'MESSAGE_NOT_FOUND');
      const started=clock();await storeSnapshots(scope,[await ozon.getPosting(credential,posting)],started);posting=await getPosting(scope,job.postingNumber);
      if(!posting.chatId&&job.phase==='CHAT_READY'&&job.chatId)posting={...posting,chatId:job.chatId};
      if(posting.chatId) {
        const history=await ozon.history(credential,posting.chatId,{since:clock()-48*HOUR});
        posting={...posting,lastBuyerAt:history.lastBuyerAt};
      }
      let eligibility=messageEligibility(posting,job.trigger,clock());
      if(!eligibility.allowed)return await finishIneligible(eligibility,posting);
      let configuration=await allowedConfiguration(pool);
      if(!configuration)return await ownedFinish('CANCELLED',{reason:'发送开关或模板已修改，停止本次发送'});
      const rendered=renderMessageTemplate(job.template,posting,configuration.config);
      if(!rendered.valid)return await ownedFinish('SKIPPED',{text:rendered.text,reason:rendered.reason});
      let chatId=posting.chatId || job.chatId;
      if(!chatId) {
        await sendingLock(scope,async client=>{
          if(!await allowedConfiguration(client))return;
          const prepared=await getPosting(scope,posting.postingNumber,client);
          if(prepared.chatId){chatId=prepared.chatId;return;}
          const permission=messageEligibility(prepared,job.trigger,clock());
          if(!permission.allowed){await finishIneligible(permission,prepared,client);return;}
          const existing=await pendingChatCreation(scope,posting.postingNumber,client,job.id);
          if(existing) {
            const uncertain=existing.status==='UNCERTAIN',retryAt=clock()+15000;
            await ownedFinish(uncertain?'SKIPPED':'PENDING',{
              reason:uncertain?'其他提醒创建聊天的结果待核对，暂不重复创建':'其他提醒正在创建聊天，稍后复用',
              ...(uncertain?{}:{retryAt})},client,uncertain?null:retryAt);
            return;
          }
          if(!await ownedFinish('SENDING',{phase:'CHAT_START',text:rendered.text},client))return;
          ambiguousWrite=true;
          chatId=await ozon.startChat(credential,posting.postingNumber);
          if(!await ownedFinish('SENDING',{phase:'CHAT_READY',chatId,text:rendered.text},client))return;
          ambiguousWrite=false;
          await client.query(`UPDATE ozon_message_postings SET body=body || $4::jsonb WHERE account_id=$1 AND store_id=$2 AND posting_number=$3`,[...parameters(scope),posting.postingNumber,{chatId}]);
        });
        if(!chatId)return await ownedFinish('CANCELLED',{reason:'发送开关、模板或任务领取权已变化，停止建聊'});
      }
      const history=await ozon.history(credential,chatId,{since:clock()-48*HOUR});
      // The same lock protects settings/template changes. Once a close request
      // returns, no not-yet-started message can enter this stage using stale data.
      await sendingLock(scope,async client=>{
        configuration=await allowedConfiguration(client);
        const latest=await getPosting(scope,job.postingNumber,client);
        eligibility=messageEligibility({...latest,chatId,lastBuyerAt:history.lastBuyerAt},job.trigger,clock());
        if(!configuration||!eligibility.allowed)return ownedFinish('CANCELLED',{reason:eligibility.reason||'发送开关或模板已修改，停止发送'},client);
        const finalText=renderMessageTemplate(job.template,latest,configuration.config);
        if(!finalText.valid)return ownedFinish('SKIPPED',{text:finalText.text,reason:finalText.reason},client);
        const sendStartedAt=clock();
        if(!await ownedFinish('SENDING',{chatId,text:finalText.text,phase:'SEND',sendStartedAt,baseline:history.messages.map(messageFingerprint)},client))return;
        ambiguousWrite=true;
        await ozon.send(credential,chatId,finalText.text);
        await ownedFinish('SENT',{sentAt:clock(),reason:'Ozon 已确认发送成功'},client);
      });
    } catch(e) {
      const rejected=/^ZONGZI_HTTP_4\d\d$/.test(e?.code || '');
      const transient=/^(?:ZONGZI|OZON)_(TIMEOUT|NETWORK_ERROR|HTTP_5\d\d|HTTP_429)$/.test(e?.code || '') || e?.body?.network===true;
      if(!ambiguousWrite&&transient&&(job.readRetries || 0)<5) {
        const retries=(job.readRetries || 0)+1;
        const retryAt=clock()+Math.min(2**(retries-1),10)*60000;
        await ownedFinish('PENDING',{readRetries:retries,retryAt,reason:'读取 Ozon 暂时失败，消息尚未发送，稍后自动复核'},pool,retryAt);
      } else await ownedFinish(ambiguousWrite&&!rejected?'UNCERTAIN':'FAILED',{reason:ambiguousWrite&&!rejected?'Ozon 返回结果不明；请核对聊天历史，系统不会自动重发':safeFailure(e)});
    }
    return true;
  }
  async function reconcile(scope,id) {
    await assertStore(scope);
    const row=(await pool.query('SELECT * FROM ozon_message_records WHERE account_id=$1 AND store_id=$2 AND id=$3',[...parameters(scope),id])).rows[0];
    if(!row)throw error('发送记录不存在',404,'MESSAGE_NOT_FOUND');
    if(row.status!=='UNCERTAIN')return publicRecord(row);
    const job=recordView(row);
    if(!job.chatId||job.phase!=='SEND')return publicRecord(row);
    const credential=pinOzonCredential(await readCredential(scope.storeId,scope.accountId),job);if(!credential)throw error('店铺 API 凭证不可用',409,'MESSAGE_CREDENTIALS_REQUIRED');
    const history=await ozon.history(credential,job.chatId,{since:job.sendStartedAt-5000});const baseline=new Set(job.baseline || []);
    const match=history.messages.filter(m=>m.user?.type==='Seller'&&!m.is_image&&Array.isArray(m.data)&&m.data.join('\n')===job.text
      &&Date.parse(m.created_at)>=job.sendStartedAt-5000&&!baseline.has(messageFingerprint(m)));
    if(history.complete&&match.length===1) {
      const remote=match[0],fingerprint=messageFingerprint(remote);
      const candidates=(await pool.query(`SELECT id FROM ozon_message_records WHERE account_id=$1 AND store_id=$2
        AND body->>'phase'='SEND' AND body->>'chatId'=$3 AND body->>'text'=$4
        AND (body->>'sendStartedAt')::bigint<=$5 AND NOT(COALESCE(body->'baseline','[]'::jsonb) ? $6)`,
        [...parameters(scope),job.chatId,job.text,Date.parse(remote.created_at)+5000,fingerprint])).rows;
      if(candidates.length===1&&candidates[0].id===id) {
        try {
          await pool.query(`UPDATE ozon_message_records SET status='SENT',confirmed_message_fingerprint=$4,body=body || $5::jsonb
            WHERE account_id=$1 AND store_id=$2 AND id=$3 AND status='UNCERTAIN'`,[...parameters(scope),id,`${job.chatId}:${fingerprint}`,
            {sentAt:Date.parse(remote.created_at),reason:'已在 Ozon 聊天历史中唯一核对到本次内容'}]);
        } catch(e) {if(e.code!=='23505')throw e;await finish(scope,id,'UNCERTAIN',{reason:'该远端消息已归属于另一任务，仍需人工核对'});}
      } else await finish(scope,id,'UNCERTAIN',{reason:'多个任务可能对应同一条远端消息，不能唯一确认；不会自动重发'});
    } else await finish(scope,id,'UNCERTAIN',{reason:history.complete?'最近聊天历史尚不能唯一确认发送结果；不会自动重发':'历史分页尚未覆盖发送时间，不能确认发送结果；不会自动重发'});
    return publicRecord((await pool.query('SELECT * FROM ozon_message_records WHERE account_id=$1 AND store_id=$2 AND id=$3',[...parameters(scope),id])).rows[0]);
  }
  return {overview,settings,templates,postings,records,saveSettings,saveTemplate,deleteTemplate,preview,requestSync,syncStore,syncNext,prepareChatNext,webhook,enqueue,processNext,reconcile};
}
