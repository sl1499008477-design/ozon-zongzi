export const AI_LISTING_HOME_STAGES=Object.freeze(['review','failed','enrichment','generating','submitting','attention']);

// Shared by the home summary and paginated task reads. Callers provide the
// account/deletion scope; nowSql is a server-owned SQL expression, never input.
export function aiListingStageSql(stage,nowSql='extract(epoch FROM now())*1000') {
  const review="status='AWAITING_REVIEW'";
  const failed="status IN ('COLLECTION_FAILED','GENERATION_FAILED','UPLOAD_FAILED','SUBMISSION_FAILED','SUBMISSION_UNCERTAIN')";
  // Older list projections omit collectionStage. Read the field only for
  // active non-box collection tasks; other states never decompress body.
  const enrichment=`CASE
    WHEN status='COLLECTING' AND list_summary->>'sourceType'='COLLECT_BOX' THEN TRUE
    WHEN status='COLLECTING' THEN body->>'collectionStage'='waiting_seller'
    ELSE status='GENERATING' AND list_summary->>'generationStage'='waiting_product' END`;
  switch(stage) {
    case 'review':return review;
    case 'failed':return failed;
    case 'enrichment':return enrichment;
    case 'generating':return `status='GENERATING' AND lease_token IS NOT NULL AND lease_expires_at>${nowSql}
      AND (list_summary->>'generationStage'='image'
        OR (COALESCE(list_summary->>'generationStage','')='' AND list_summary#>>'{_list,hasGeneratingImage}'='true'))`;
    case 'submitting':return "status IN ('READY_TO_SUBMIT','SUBMITTING','SUBMITTED')";
    case 'attention':return `(${review}) OR (${failed}) OR (${enrichment})`;
    default:throw Object.assign(Error('上架阶段筛选无效'),{status:400,code:'AI_LISTING_INVALID_INPUT'});
  }
}
