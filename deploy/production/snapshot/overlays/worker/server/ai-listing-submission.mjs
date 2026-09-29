import {createProductRestrictions,restrictionItems} from "./product-restrictions.mjs";
import { aiListingItemPrice, resolveAiListingSourceCategories } from "./ai-listing-source-facts.mjs";
import { createHash, randomUUID } from "node:crypto";
import { reserveOzonWriteCapacity } from "./ozon-write-rate-limit.mjs";
import { quotaAllows } from "./ai-listing-store-routing.mjs";
import { callOzonSellerApi as defaultCallOzonSellerApi } from "./ozon-client.mjs";
import { normalizeOzonImportItems } from "./ozon-import-normalizer.mjs";
import { deriveOzonImportStatus } from "./ozon-import-status.mjs";
import { createOzonCategoryService } from "./ozon-category-service.mjs";
import { assertUsableOperatingStore, readStoreCredentialV3 } from "./listing-pipeline.mjs";
import { createAutoListingRfbsWarehouseVerifier } from "./auto-listing-rfbs-warehouse-verifier.mjs";
import { assertListingWarehouseEligible } from "./listing-warehouse-eligibility.mjs";
import { removeAiListingBrandText } from "./ai-listing-brand-text.mjs";

const error = (code, definitelyNotSubmitted = false) => Object.assign(new Error(code), { code, definitelyNotSubmitted });
const decimalMoney = minor => `${BigInt(minor) / 100n}.${String(BigInt(minor) % 100n).padStart(2, "0")}`;

function replaceRichImageReferences(value, replacements) {
  if (Array.isArray(value)) return value.map(child => replaceRichImageReferences(child, replacements));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .map(([key, child]) => [key, replaceRichImageReferences(child, replacements)]));
  if (typeof value !== "string") return value;
  if (replacements.has(value)) return replacements.get(value);
  // Ozon rich-content attributes are JSON strings, not generated/rewritten prose.
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === "object") return JSON.stringify(replaceRichImageReferences(parsed, replacements));
  } catch { /* Non-JSON text is preserved verbatim. */ }
  return value;
}

export function createAiListingSubmissionPorts({ pool, callOzonSellerApi = defaultCallOzonSellerApi,
  readCredential = ({ accountId, targetStoreId }) => readStoreCredentialV3(targetStoreId, accountId),
  validateTarget: injectedValidateTarget, normalizeItems: injectedNormalizeItems,
  prepareMedia = async ({items}) => items, clock = Date.now, reserveCapacity = reserveOzonWriteCapacity } = {}) {
  const category = createOzonCategoryService({ callOzonSellerApi });
  async function loadTarget({ accountId, targetStoreId, targetWarehouseId }) {
    return (await pool.query(`SELECT w.id,s.owner_account_id AS account_id,w.store_id,w.warehouse_id,
      w.warehouse_type,w.status,w.is_active,w.is_archived,
      EXISTS (SELECT 1 FROM product_stocks ps JOIN products p ON p.id=ps.product_id
        WHERE ps.warehouse_id=w.id AND ps.store_id=w.store_id AND p.store_id=w.store_id
          AND p.is_archived=FALSE AND LOWER(ps.source)='fbs') AS has_active_product_association
      FROM warehouses w JOIN stores s ON s.id=w.store_id
      WHERE s.owner_account_id=$1 AND w.store_id=$2 AND w.id=$3`, [accountId, targetStoreId, targetWarehouseId])).rows[0] || null;
  }
  const verifier = createAutoListingRfbsWarehouseVerifier({ callOzonSellerApi, readCredential, loadTarget });
  const validateTarget = injectedValidateTarget || (async ({ accountId, config, validateWarehouse = true }) => {
    const store = await assertUsableOperatingStore({ accountId, storeId: config.targetStoreId, client: pool });
    if (!validateWarehouse) return { store };
    const record = await loadTarget({ accountId, targetStoreId: config.targetStoreId, targetWarehouseId: config.targetWarehouseId });
    if (String(record?.warehouse_type || "").trim().toUpperCase() !== "RFBS") {
      assertListingWarehouseEligible({ warehouse: record, accountId, targetStoreId: config.targetStoreId,
        hasActiveProductAssociation: record?.has_active_product_association === true });
      if (!/^[1-9]\d{0,15}$/.test(record.warehouse_id) || !Number.isSafeInteger(Number(record.warehouse_id))) {
        throw Object.assign(error("LISTING_WAREHOUSE_NOT_ELIGIBLE"), { status: 422 });
      }
      return { store, warehouse: { platformWarehouseId: record.warehouse_id, fulfillmentType: "FBS" } };
    }
    const warehouse = await verifier.verifyRfbsWarehouse({ accountId, actorAccountId: accountId,
      targetStoreId: config.targetStoreId, targetWarehouseId: config.targetWarehouseId, correlationId: "ai-image-listing" });
    return { store, warehouse };
  });
  const save = (client, accountId, id, body) => client.query(
    "UPDATE ai_image_listing_submissions SET body=$3::jsonb,updated_at=NOW() WHERE account_id=$1 AND id=$2", [accountId, id, JSON.stringify(body)]);
  const load = async (client, accountId, id) => (await client.query(
    "SELECT * FROM ai_image_listing_submissions WHERE account_id=$1 AND id=$2", [accountId, id])).rows[0];
  async function locked(accountId, id, work) {
    const client = await pool.connect(); let acquired = false;
    try {
      acquired = (await client.query("SELECT pg_try_advisory_lock(hashtext($1),hashtext($2)) AS locked", [accountId, id])).rows[0].locked;
      if (!acquired) throw error("AI_LISTING_SUBMISSION_BUSY");
      return await work(client);
    } finally {
      if (acquired) await client.query("SELECT pg_advisory_unlock(hashtext($1),hashtext($2))", [accountId, id]);
      client.release();
    }
  }
  const safeCodes = errors => (Array.isArray(errors) ? errors : []).map(value => String(value?.code || value || ""))
    .filter(code => /^[A-Za-z0-9_:-]{1,100}$/.test(code));
  const transportCode = caught => /^(?:ZONGZI|OZON)_HTTP_\d{3}$/.test(caught?.code || "") ? caught.code : "ZONGZI_REQUEST_UNCERTAIN";
  const productRows = response => response?.items || response?.result?.items || [];
  const productId = value => Number.isSafeInteger(Number(value)) && Number(value)>0 ? String(value) : null;
  const stockReady = item => item?.statuses?.status === "price_sent";
  const stockPair = item => `${item.offer_id}:${item.warehouse_id}`;
  function journal(body) {
    if (!body.results) body.results = (body.items || body.stocks || []).map(item => ({
      sku: item.scraped_sku || item.offer_id, offerId: item.offer_id,
      importStatus: ["COMPLETED","STOCKING","STOCK_FAILED"].includes(body.status) ? "SUCCEEDED" : "PENDING",
      stockStatus: body.stocks?.find(stock=>stock.offer_id===item.offer_id)?.completed ? "COMPLETED" : "PENDING", errors: [],
    }));
    if (!body.attempts) body.attempts = body.ozonTaskId || ["IMPORTING","UNCERTAIN"].includes(body.status) ? [{
      id: "legacy", offerIds: body.results.map(item=>item.offerId), ozonTaskId: body.ozonTaskId || null,
      status: body.ozonTaskId ? (["COMPLETED","STOCKING","STOCK_FAILED"].includes(body.status)?"DONE":"ACCEPTED") : "UNCERTAIN",
      // A legacy unknown request has no before-write observation; don't pretend
      // an existing offer proves this particular request succeeded.
      preexistingOfferIds: null,
    }] : [];
    return body;
  }
  function view(body) {
    const active = body.attempts.some(a=>["WAITING","IMPORTING","ACCEPTED"].includes(a.status));
    const uncertain = body.attempts.some(a=>a.status==="UNCERTAIN");
    const pendingStock = body.results.some(r=>r.importStatus==="SUCCEEDED" && r.stockStatus==="PENDING");
    const failed = body.results.some(r=>r.importStatus==="FAILED" || r.stockStatus==="FAILED");
    const status = uncertain ? "UNCERTAIN" : active || pendingStock ? "SUBMITTED" : failed ? "FAILED" :
      body.results.length && body.results.every(r=>r.importStatus==="SUCCEEDED" && r.stockStatus==="COMPLETED") ? "COMPLETED" : "UNCERTAIN";
    return {status, items: structuredClone(body.results), ...(body.retryAt>clock()?{retryAfterMs:body.retryAt-clock()}:{}),
      ...(failed?{errorMessage:body.results.filter(r=>r.errors?.length).map(r=>`${r.sku}: ${r.errors.join("、")}`).join("；")}:{}),
      ...(uncertain?{errorMessage:"上次请求结果未知，已按商品货号核对；未确认部分不会自动重发，请核实远端商品后处理"}:{}),
    };
  }
  async function reconcileImports(client, accountId, id, body, credential) {
    for (const attempt of body.attempts) {
      if(attempt.status==="IMPORTING") attempt.status="UNCERTAIN";
      if (attempt.status === "UNCERTAIN" && !attempt.ozonTaskId) {
        const rows=productRows(await callOzonSellerApi(credential,"/v3/product/info/list",{offer_id:attempt.offerIds},60_000));
        for(const result of body.results.filter(r=>attempt.offerIds.includes(r.offerId))){
          const matches=rows.filter(row=>row.offer_id===result.offerId);
          if(Array.isArray(attempt.preexistingOfferIds)&&!attempt.preexistingOfferIds.includes(result.offerId)&&matches.length===1&&productId(matches[0].id||matches[0].product_id)){
            result.importStatus="SUCCEEDED";result.productId=productId(matches[0].id||matches[0].product_id);result.errors=[];
          } else if(result.importStatus!=="SUCCEEDED") result.importStatus="UNKNOWN";
        }
        if(body.results.filter(r=>attempt.offerIds.includes(r.offerId)).every(r=>r.importStatus==="SUCCEEDED"))attempt.status="DONE";
        await save(client,accountId,id,body);
        continue;
      }
      if (!["ACCEPTED","UNCERTAIN"].includes(attempt.status) || !attempt.ozonTaskId) continue;
      const response=await callOzonSellerApi(credential,"/v1/product/import/info",{task_id:Number(attempt.ozonTaskId)},60_000,{maxResponseBytes:4*1024*1024});
      const parsed=deriveOzonImportStatus(response,{expectedOfferIds:attempt.offerIds});
      for(const item of parsed.items){
        const result=body.results.find(r=>r.offerId===item.offerId);
        if(!result||result.importStatus==="SUCCEEDED")continue;
        if(item.status==="SUCCEEDED"){result.importStatus="SUCCEEDED";result.productId=item.productId;result.errors=[];}
        else if(["FAILED","SKIPPED"].includes(item.status)){result.importStatus="FAILED";result.errors=safeCodes(item.response?.errors);if(!result.errors.length)result.errors=["ZONGZI_IMPORT_FAILED"];}
      }
      attempt.status=parsed.done?"DONE":"ACCEPTED";
      await save(client,accountId,id,body);
    }
  }
  async function sendImport(client, accountId, id, body, credential, attempt) {
    if(attempt.status!=="WAITING"||attempt.retryAt>clock())return;
    const items=body.items.filter(item=>attempt.offerIds.includes(item.offer_id));
    const quota=await callOzonSellerApi(credential,"/v4/product/info/limit",{},20_000);
    if(!quotaAllows(quota,items)){attempt.retryAt=clock()+60_000;body.retryAt=attempt.retryAt;await save(client,accountId,id,body);return;}
    // Observe existing offers before the first write; only newly appearing exact
    // identities can later resolve a lost response without a task ID.
    const existing=productRows(await callOzonSellerApi(credential,"/v3/product/info/list",{offer_id:attempt.offerIds},60_000));
    attempt.preexistingOfferIds=existing.map(item=>item.offer_id).filter(id=>attempt.offerIds.includes(id));
    if(quota.operation_limits?.limit_type==="RATE_LIMIT_PER_MINUTE"){
      const capacity=await reserveCapacity({pool,sellerId:credential.clientId,operation:"import",requestKey:randomUUID(),units:items.length,pairKeys:[],limit:quota.operation_limits.limit,clock});
      if(!capacity.allowed){attempt.retryAt=clock()+capacity.retryAfterMs;body.retryAt=attempt.retryAt;await save(client,accountId,id,body);return;}
    }
    attempt.status="IMPORTING";attempt.startedAt=clock();attempt.retryAt=null;body.retryAt=null;body.status="IMPORTING";
    await save(client,accountId,id,body);
    try {
      const response=await callOzonSellerApi(credential,"/v3/product/import",{items},60_000,{maxResponseBytes:4*1024*1024});
      const taskId=response?.result?.task_id??response?.task_id;
      if(!/^[1-9]\d{0,15}$/.test(String(taskId||""))||!Number.isSafeInteger(Number(taskId)))throw error("AI_LISTING_IMPORT_UNCERTAIN");
      attempt.ozonTaskId=String(taskId);attempt.status="ACCEPTED";body.ozonTaskId=String(taskId);body.status="IMPORTED";
      await save(client,accountId,id,body);
    } catch(caught) {
      const status=Number(caught.status);
      attempt.errorCode=transportCode(caught);
      if(status===429){attempt.status="WAITING";attempt.retryAt=clock()+60_000;body.retryAt=attempt.retryAt;body.status="IMPORT_WAIT";}
      else if([400,401,403,404,422].includes(status)){
        attempt.status="REJECTED";body.status="FAILED";
        for(const result of body.results.filter(r=>attempt.offerIds.includes(r.offerId))){result.importStatus="FAILED";result.errors=[attempt.errorCode];}
      } else {attempt.status="UNCERTAIN";body.status="UNCERTAIN";}
      await save(client,accountId,id,body);
    }
  }
  async function writeStocks(client,accountId,id,body,credential) {
    if(body.retryAt>clock())return;
    const pending=body.stocks.filter(stock=>!stock.completed&&body.results.some(r=>r.offerId===stock.offer_id&&r.importStatus==="SUCCEEDED"&&r.stockStatus==="PENDING"));
    if(!pending.length)return;
    await validateTarget({accountId,config:body.config});
    const rows=productRows(await callOzonSellerApi(credential,"/v3/product/info/list",{offer_id:pending.map(s=>s.offer_id)},60_000));
    const rejected=new Set();
    for(const stock of pending){
      const item=rows.find(row=>row.offer_id===stock.offer_id);
      const status=item?.statuses;
      const result=body.results.find(r=>r.offerId===stock.offer_id);
      // Import/stock success does not mean Ozon fetched every photo. Retain the
      // warnings from this existing product-info read, independently of stock errors.
      const warnings=[...new Set(safeCodes(item?.errors?.filter(e=>e.level==="ERROR_LEVEL_WARNING")))];
      if(warnings.length){
        result.publicationWarnings=warnings;
        result.warningMessage=warnings.includes("pics_reading_timeout")
          ? "Ozon 下载部分商品图片超时，请重新上传图片"
          : warnings.some(code=>["primary_image_load_failed","some_image_failed"].includes(code))
            ? "Ozon 未能完整接收商品图片，请重新上传图片" : warnings.join("、");
      } else {delete result.publicationWarnings;delete result.warningMessage;}
      // variant_wait alone is normal moderation. Only an explicit declined,
      // not-created product is a user-correctable terminal publication result.
      if(status?.is_created===false && [status.moderate_status,status.status_failed].includes("declined")){
        // An unchanged rejection timestamp still belongs to the previous
        // publication attempt; elapsed time cannot turn it into a new result.
        if(result.previousPublicationRejectedAt && status.status_updated_at===result.previousPublicationRejectedAt){
          result.publicationStatus="PENDING";
          result.statusMessage="资料修正已提交，等待 Ozon 更新审核结果";
          continue;
        }
        delete result.statusMessage;
        result.publicationStatus="REJECTED";result.stockStatus="FAILED";
        result.publicationRejectedAt=status.status_updated_at||null;
        result.errors=safeCodes(item.errors);if(!result.errors.length)result.errors=["ZONGZI_PUBLICATION_DECLINED"];
        result.failureReason=item.errors?.some(error=>error.code==="DESCRIPTION_DECLINE"&&Number(error.attribute_id)===11254)
          ? "富内容（属性 11254）未通过 Ozon 审核，请修正文字内容后重试；成功图片已保留"
          : item.errors?.some(error=>error.code==="DESCRIPTION_DECLINE"&&Number(error.attribute_id)===4180)
            ? "商品名称（属性 4180）未通过 Ozon 审核，请修正名称后重试；成功图片已保留"
            : "商品资料未通过 Ozon 审核，请修正被拒绝的资料后重试；成功图片已保留";
        rejected.add(stock.offer_id);
      }
    }
    const ready=pending.filter(stock=>!rejected.has(stock.offer_id)&&rows.some(item=>item.offer_id===stock.offer_id&&stockReady(item)));
    if(ready.length+rejected.size<pending.length)body.retryAt=clock()+60_000;
    for(let offset=0;offset<ready.length;offset+=100){
      const batch=ready.slice(offset,offset+100);
      const capacity=await reserveCapacity({pool,sellerId:credential.clientId,operation:"stock",requestKey:randomUUID(),units:1,pairKeys:batch.map(stockPair),limit:80,clock});
      if(!capacity.allowed){body.retryAt=Math.max(body.retryAt||0,clock()+capacity.retryAfterMs);break;}
      body.stockRequest={id:randomUUID(),pairKeys:batch.map(stockPair),startedAt:clock()};
      await save(client,accountId,id,body);
      try {
        const stocks=batch.map(({offer_id,warehouse_id,stock})=>({offer_id,warehouse_id,stock}));
        const response=await callOzonSellerApi(credential,"/v2/products/stocks",{stocks},60_000,{maxResponseBytes:1024*1024});
        for(const stock of batch){
          const result=body.results.find(r=>r.offerId===stock.offer_id);
          const matches=response?.result?.filter?.(item=>item.offer_id===stock.offer_id&&String(item.warehouse_id)===String(stock.warehouse_id))||[];
          const outcome=matches.length===1?matches[0]:null;
          const codes=safeCodes(outcome?.errors);
          if(outcome?.updated===true&&!codes.length){stock.completed=true;result.stockStatus="COMPLETED";result.errors=[];delete result.failureReason;delete result.previousPublicationRejectedAt;delete result.statusMessage;delete result.publicationStatus;}
          else if(!outcome||codes.length&&codes.every(code=>["PRODUCT_HAS_NOT_BEEN_TAGGED_YET","TOO_MANY_REQUESTS"].includes(code))){body.retryAt=clock()+60_000;result.errors=codes.length?codes:["ZONGZI_STOCK_RESULT_PENDING"];}
          else {result.stockStatus="FAILED";result.errors=codes.length?codes:["ZONGZI_STOCK_FAILED"];}
        }
      } catch(caught) {
        if(!caught.status||Number(caught.status)===429||Number(caught.status)>=500)body.retryAt=clock()+60_000;
        else for(const stock of batch){const result=body.results.find(r=>r.offerId===stock.offer_id);result.stockStatus="FAILED";result.errors=[transportCode(caught)];}
      }
      delete body.stockRequest;
      await save(client,accountId,id,body);
    }
    await save(client,accountId,id,body);
  }
  async function prepare(input,client) {
    const {accountId,config}=input;
    try {
      const target=await validateTarget({accountId,config});
      const credential={...await readCredential({accountId,targetStoreId:config.targetStoreId}),ownerAccountId:accountId};
      const scope={accountId,store:credential,language:"DEFAULT"};
      const preparedInput={...input,source:await resolveAiListingSourceCategories({accountId,source:input.source,pool:client,getCategoryTree:injectedNormalizeItems?undefined:async()=>(await category.getCategoryTree(scope)).items})};
      let itemWarnings=[];
      const items=await prepareAiListingItems(preparedInput,target.store,{
        onWarnings:warnings=>{itemWarnings=warnings;},
        async resolveNoBrand(item){const values=await category.searchCategoryAttributeValuesExact({...scope,descriptionCategoryId:item.description_category_id,typeId:item.type_id,attributeId:85,value:"Нет бренда"});const value=values.items.length===1?values.items[0]:null;return value?{dictionary_value_id:Number(value.id),value:"Нет бренда"}:null;},
        normalizeItems:injectedNormalizeItems||(items=>normalizeOzonImportItems(items,{strictTypeMatch:true,
          getCategoryTree:async()=>(await category.getCategoryTree(scope)).items,
          getCategoryAttributes:async(descriptionCategoryId,typeId)=>(await category.getCategoryAttributes({...scope,descriptionCategoryId,typeId})).items,
          getCategoryAttributeValues:async(descriptionCategoryId,typeId,attributeId,dictionaryOptions={})=>(await category.getCategoryAttributeValues({...scope,descriptionCategoryId,typeId,attributeId,...dictionaryOptions})).items,
          searchCategoryAttributeValuesExact:async(descriptionCategoryId,typeId,attributeId,value)=>(await category.searchCategoryAttributeValuesExact({...scope,descriptionCategoryId,typeId,attributeId,value})).items,
        })),
      });
      await createProductRestrictions(client).assertAllowed({accountId,items:restrictionItems({items:items.map(listingItem=>({sku:listingItem.offer_id,listingItem}))}),config,stage:"submit"});
      const preparedItems=await prepareMedia({accountId,taskId:input.taskId,items});
      return {target,credential,items:preparedItems,itemWarnings};
    } catch(caught){caught.definitelyNotSubmitted=true;throw caught;}
  }
  async function submitListing(input) {
    const {accountId,config,idempotencyKey}=input;
    const id=`ail_${createHash("sha256").update(JSON.stringify([accountId,idempotencyKey])).digest("hex")}`;
    return locked(accountId,id,async client=>{
      let row=await load(client,accountId,id),body,credential;
      if(row){
        if(row.task_id&&row.task_id!==input.taskId)throw error("AI_LISTING_SUBMISSION_IDENTITY_MISMATCH",true);
        body=journal(row.body);
        for (const result of body.results) {
          const group=input.source.items.find(group=>group.listingItem?.offer_id===result.offerId);
          if(group)result.sku=group.sku;
        }
        if(body.config.targetStoreId!==config.targetStoreId)throw error("AI_LISTING_SUBMISSION_IDENTITY_MISMATCH",true);
        credential=await readCredential({accountId,targetStoreId:body.config.targetStoreId});
        await reconcileImports(client,accountId,id,body,credential);
        if(Number(input.retryAttempt||0)>Number(body.retryAttempt||0)&&!body.attempts.some(a=>["WAITING","IMPORTING","ACCEPTED","UNCERTAIN"].includes(a.status))){
          const failed=body.results.filter(r=>r.importStatus==="FAILED"||r.publicationStatus==="REJECTED");
          if(failed.length){
            const selected=new Set(failed.map(r=>r.sku));
            const fresh=await prepare({...input,source:{...input.source,items:input.source.items.filter(g=>selected.has(g.sku))},images:input.images.filter(image=>selected.has(image.sku))},client);
            const oldOffers=new Set(failed.map(r=>r.offerId));
            if(fresh.items.length!==failed.length||fresh.items.some(item=>!oldOffers.has(item.offer_id)))throw error("AI_LISTING_SUBMISSION_IDENTITY_MISMATCH",true);
            body.items=body.items.map(old=>fresh.items.find(item=>item.offer_id===old.offer_id)||old);
            for(const result of failed){
              result.importStatus="PENDING";result.errors=[];
              result.normalizationWarnings=fresh.itemWarnings.find(row=>row.offerId===result.offerId)?.warnings||[];
              if(result.publicationStatus==="REJECTED"){
                result.previousPublicationRejectedAt=result.publicationRejectedAt;
                delete result.publicationStatus;delete result.failureReason;
              }
            }
            body.attempts.push({id:randomUUID(),status:"WAITING",offerIds:failed.map(r=>r.offerId),retryAt:0});
          }
          for(const result of body.results)if(result.stockStatus==="FAILED"){result.stockStatus="PENDING";result.errors=[];}
          body.retryAttempt=Number(input.retryAttempt);body.retryAt=null;
          await save(client,accountId,id,body);
        }
      } else {
        const prepared=await prepare(input,client);credential=prepared.credential;
        body={status:"PREPARED",config,items:prepared.items,ozonTaskId:null,retryAttempt:Number(input.retryAttempt||0),
          stocks:prepared.items.map(item=>({offer_id:item.offer_id,warehouse_id:Number(prepared.target.warehouse.platformWarehouseId),stock:config.stock,completed:false})),
          results:prepared.items.map((item,index)=>({sku:input.source.items[index].sku,offerId:item.offer_id,importStatus:"PENDING",stockStatus:"PENDING",errors:[],
            normalizationWarnings:prepared.itemWarnings.find(row=>row.offerId===item.offer_id)?.warnings||[]})),
          attempts:[{id:randomUUID(),status:"WAITING",offerIds:prepared.items.map(item=>item.offer_id),retryAt:0}]};
        await client.query('INSERT INTO ai_image_listing_submissions(id,account_id,task_id,idempotency_key,body) VALUES($1,$2,$3,$4,$5::jsonb)',[id,accountId,input.taskId,idempotencyKey,JSON.stringify(body)]);
      }
      for(const attempt of body.attempts)await sendImport(client,accountId,id,body,credential,attempt);
      return {submissionId:id};
    });
  }
  async function readSubmission({accountId,submissionId}) {
    return locked(accountId,submissionId,async client=>{
      const row=await load(client,accountId,submissionId);
      if(!row)throw Object.assign(error("AI_LISTING_SUBMISSION_NOT_FOUND"),{statusCode:404});
      const body=journal(row.body);
      if(body.status==="COMPLETED")return view(body);
      await validateTarget({accountId,config:body.config,validateWarehouse:false});
      const credential=await readCredential({accountId,targetStoreId:body.config.targetStoreId});
      await reconcileImports(client,accountId,submissionId,body,credential);
      for(const attempt of body.attempts)await sendImport(client,accountId,submissionId,body,credential,attempt);
      await writeStocks(client,accountId,submissionId,body,credential);
      const result=view(body);body.status=result.status==="SUBMITTED"?"STOCKING":result.status;
      await save(client,accountId,submissionId,body);
      return result;
    });
  }
  return {submitListing,readSubmission,validateTarget};
}

export async function prepareAiListingItems(input, store, { resolveNoBrand, normalizeItems, onWarnings }) {
  try {
    const { source, images, config } = input;
    const items = [];
    for (const group of source.items) {
      const item = structuredClone(group.listingItem);
      const outputs = images.filter(image => image.sku === group.sku).sort((a, b) => a.index - b.index);
      if (outputs.length !== group.images.length || !outputs.length || outputs.some((image, index) => image.index !== index || !image.generatedUrl)) {
        throw error("AI_LISTING_IMAGES_INCOMPLETE");
      }
      item.images = outputs.map(image => image.generatedUrl);
      delete item.primary_image;
      const {record,fallback,variant,evidence,pricing}=aiListingItemPrice(source,group,config,store);
      // Independent media use only the frozen own-SKU facts. Empty edits stay empty.
      for (const key of ["color_image", "videoCoverUrl", "contentDiagnostics"]) {
        if (Object.hasOwn(item, key) && item[key] !== undefined) continue;
        const original = source.sourceSnapshot || {};
        const carrier = [variant, item._sourceVariant,
          ...(String(source.sku) === String(group.sku) ? [original.listingDraft, original] : [])]
          .find(value => value && Object.hasOwn(value, key) && value[key] !== undefined);
        if (carrier) item[key] = structuredClone(carrier[key]);
      }
      // Recover full frozen media before replacing this SKU's image references.
      for (const key of ["descriptionHTML", "richContent", "rich_content"]) {
        const raw = variant[key] ?? fallback[key];
        const full = typeof raw === "string" ? raw.trim() : "";
        const current = typeof item[key] === "string" ? item[key].trim() : "";
        if (full && (item[key] === undefined || (current && full.startsWith(current)))) item[key] = full;
      }
      const rawDescription = variant.description || fallback.description;
      const fullDescription = typeof rawDescription === "string" ? rawDescription.trim() : "";
      const currentDescription = String(item.scraped_description || item.description || "").trim();
      if (item.contentDiagnostics?.description?.source !== "manual" && fullDescription && (!currentDescription || fullDescription.startsWith(currentDescription))) item.scraped_description = fullDescription;
      for (const key of ["videoUrl", "videoCover"]) {
        if (item[key] === undefined && (variant[key] ?? fallback[key]) !== undefined) item[key] = variant[key] ?? fallback[key];
      }
      for (const key of ["complex_attributes", "bundleComplexAttrs"]) {
        const raw = variant[key] || fallback[key];
        if (!item[key]?.length && Array.isArray(raw) && raw.length) item[key] = structuredClone(raw);
      }
      if (item.videos === undefined) {
        const raw = variant.videos ?? fallback.videos;
        if (Array.isArray(raw)) item.videos = structuredClone(raw);
      }
      const replacements = new Map(group.images.map((url, index) => [url, outputs[index].generatedUrl]));
      for (const carrier of [item, item._sourceVariant, item._bundleItem, item._sourceVariant?._bundleItem]) {
        if (!carrier) continue;
        for (const key of ["richContent", "rich_content"]) {
          if (carrier[key] !== undefined) carrier[key] = replaceRichImageReferences(carrier[key], replacements);
        }
        if (Array.isArray(carrier.attributes)) carrier.attributes = carrier.attributes.map(attribute =>
          Number(attribute.id || attribute.key || attribute.attribute_id) === 11254
            ? replaceRichImageReferences(attribute, replacements) : attribute);
      }
      const color = variant.aspectValues?.["Цвет"] || record.aspectValues?.["Цвет"];
      if (typeof color === "string" && color.trim()) {
        item.attributes = (item.attributes || []).filter(attribute => Number(attribute.id || attribute.key) !== 10096);
        item.attributes.push({ id: 10096, complex_id: 0, values: [{ value: color.trim() }] });
      }
      item.price = decimalMoney(pricing.finalPriceKopecks);
      item.currency_code = evidence.currency;
      delete item.old_price;
      if (config.brandMode === "FORCE_NO_BRAND") {
        removeAiListingBrandText(item, record, variant, fallback);
        const value = await resolveNoBrand(item);
        if (!Number.isSafeInteger(value?.dictionary_value_id) || value.dictionary_value_id <= 0) throw error("AI_LISTING_NO_BRAND_UNRESOLVED");
        item.brand = "Нет бренда";
        item.attributes = (item.attributes || []).filter(attribute => Number(attribute.id) !== 85);
        item.attributes.push({ id: 85, complex_id: 0, values: [value] });
      }
      items.push(item);
    }
    const normalized = await normalizeItems(items);
    if (normalized.items.length !== items.length || !items.length) throw error("AI_LISTING_IMPORT_INVALID");
    onWarnings?.(normalized.itemWarnings || []);
    return normalized.items;
  } catch (caught) {
    if (caught.code === "AUTO_LISTING_SOURCE_CURRENCY_MISMATCH") throw error("AI_LISTING_CURRENCY_CONVERSION_REQUIRED", true);
    caught.definitelyNotSubmitted = true;
    throw caught;
  }
}
