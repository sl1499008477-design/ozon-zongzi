-- Extend the existing write-time projection; leave task bodies and queue state intact.
CREATE OR REPLACE FUNCTION ai_listing_list_summary(task_body JSONB) RETURNS JSONB
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  -- Materialize the potentially TOASTed input once before extracting its fields.
  b JSONB := task_body || '{}'::jsonb;
  images JSONB := COALESCE(b->'images','[]'::jsonb);
  results JSONB := COALESCE(b->'submissionResults','[]'::jsonb);
  snapshot JSONB := COALESCE(b#>'{source,sourceSnapshot}',b#>'{collectWait,initialSource,sourceSnapshot}','{}'::jsonb);
  progress JSONB;
  sku_progress JSONB;
  generating BOOLEAN;
  completed_skus INTEGER;
  failed_skus INTEGER;
  failed_images INTEGER;
  pending_skus INTEGER;
  warning_skus INTEGER;
  created_skus INTEGER;
  total_skus INTEGER;
BEGIN
  SELECT jsonb_build_object('total',count(*),'completed',count(*) FILTER(WHERE COALESCE(image->>'generatedUrl','')<>'')),
    COALESCE(bool_or(image->>'status'='GENERATING' AND COALESCE(image->>'generatedUrl','')=''),false)
    INTO progress,generating FROM jsonb_array_elements(images) image;
  sku_progress := b->'skuProgress';
  IF sku_progress IS NULL THEN
    SELECT COALESCE(jsonb_agg(item ORDER BY first_index),'[]'::jsonb) INTO sku_progress FROM (
      SELECT jsonb_build_object('sku',image->>'sku','total',count(*),
        'completed',count(*) FILTER(WHERE COALESCE(image->>'generatedUrl','')<>'')) item,min(position) first_index
      FROM jsonb_array_elements(images) WITH ORDINALITY AS rows(image,position)
      GROUP BY image->>'sku'
    ) grouped;
  END IF;
  SELECT count(*) FILTER(WHERE result->>'stockStatus'='COMPLETED'),
    count(*) FILTER(WHERE result->>'stockStatus'='FAILED' OR result->>'importStatus'='FAILED'),
    count(*) FILTER(WHERE result->>'publicationStatus'='IMAGE_FAILED'),
    count(*) FILTER(WHERE result->>'stockStatus' IS DISTINCT FROM 'FAILED' AND result->>'importStatus' IS DISTINCT FROM 'FAILED'
      AND (result->>'stockStatus'='PENDING' OR result->>'importStatus'='PENDING')),
    count(*) FILTER(WHERE CASE WHEN jsonb_typeof(result->'publicationWarnings')='array' THEN jsonb_array_length(result->'publicationWarnings')>0 ELSE false END
      OR result#>'{publicationCheck,isCreated}'='false'::jsonb OR result#>'{publicationCheck,isArchived}'='true'::jsonb)
    INTO completed_skus,failed_skus,failed_images,pending_skus,warning_skus FROM jsonb_array_elements(results) result;
  SELECT count(*),count(*) FILTER(WHERE EXISTS (
    SELECT 1 FROM jsonb_array_elements(results) result
    WHERE result->>'sku'=eligible.sku AND (result->>'importStatus'='SUCCEEDED'
      OR result->'isCreated'='true'::jsonb OR COALESCE(result->>'productId','') ~ '^[1-9][0-9]*$')
  )) INTO total_skus,created_skus FROM (
    SELECT DISTINCT item->>'sku' AS sku
    FROM jsonb_array_elements(COALESCE(b#>'{source,items}','[]'::jsonb)) item
    WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(b#>'{source,skuPricing}','[]'::jsonb)) price
      WHERE price->>'sku'=item->>'sku' AND price->>'status'='SKIPPED')
  ) eligible;
  RETURN jsonb_build_object(
    'submissionStage',b->'submissionStage','importSkus',b->'importSkus','importRows',b->'importRows','generationStage',b->'generationStage',
    'sourceType',b->'sourceType','sku',b->'sku','name',b->'name','thumbnail',b->'thumbnail',
    'submissionStarted',b->'submissionStarted','submissionExternalWriteStarted',b->'submissionExternalWriteStarted',
    'purge',CASE WHEN b->'purge' IS NULL THEN NULL ELSE jsonb_build_object('state',b#>'{purge,state}',
      'requestedAt',b#>'{purge,requestedAt}','errorMessage',b#>'{purge,errorMessage}',
      'retainedObjects',b#>'{purge,retainedObjects}','retainedSources',b#>'{purge,retainedSources}') END,
    'stoppedFrom',b->'stoppedFrom','updatedAt',b->'updatedAt',
    'errorMessage',b->'errorMessage','quotaWait',b->'quotaWait','priceFailure',b->'priceFailure',
    'submissionWait',b->'submissionWait','createdSkuCount',created_skus,'totalSkuCount',total_skus,
    'submissionId',b->'submissionId','submissionTarget',b->'submissionTarget',
    'completedSkuCount',completed_skus,'failedSubmissionSkuCount',failed_skus,'imageFailedSkuCount',failed_images,
    'pendingSubmissionSkuCount',pending_skus,'publicationWarningSkuCount',warning_skus,
    'config',jsonb_build_object('targetStoreId',b#>'{config,targetStoreId}','salePricingId',b#>'{config,salePricingId}',
      'autoSwitchStores',b#>'{config,autoSwitchStores}','generationMode',b#>'{config,generationMode}'),
    'progress',progress,'skuProgress',sku_progress,
    '_list',jsonb_build_object('permanentlyDeletedAt',b->'permanentlyDeletedAt',
      'submissionResultCount',jsonb_array_length(results),'hasGeneratingImage',generating,
      'collectionSource',jsonb_build_object('collectId',b->'sourceId',
        'runId',COALESCE(NULLIF(b#>>'{collectorAuto,runId}',''),NULLIF(b#>>'{source,sourceSnapshot,collectorRunId}',''),
          NULLIF(b#>>'{collectWait,initialSource,sourceSnapshot,collectorRunId}','')),
        'source',snapshot->'source','extensionVersion',snapshot->'extensionVersion'))
  );
END;
$$;

-- Only current active pages need a backfill. Paused, failed, deleted and completed
-- history is left untouched; a later body write refreshes it through the existing trigger.
UPDATE ai_image_listing_tasks SET list_summary=ai_listing_list_summary(body)
WHERE deleted_at IS NULL AND status IN (
  'QUEUED','COLLECTING','GENERATING','AWAITING_REVIEW','READY_TO_SUBMIT','SUBMITTING','SUBMITTED'
);
