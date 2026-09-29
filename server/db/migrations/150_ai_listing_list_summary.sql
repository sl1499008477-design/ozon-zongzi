-- List reads must not decompress the frozen source/media evidence. Compute this
-- projection once when the body is written, including writes made by the worker
-- and purge paths. Status, version, leases and deletion remain authoritative columns.
ALTER TABLE ai_image_listing_tasks ADD COLUMN list_summary JSONB;

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
  RETURN jsonb_build_object(
    'submissionStage',b->'submissionStage','importSkus',b->'importSkus','importRows',b->'importRows','generationStage',b->'generationStage',
    'sourceType',b->'sourceType','sku',b->'sku','name',b->'name','thumbnail',b->'thumbnail',
    'submissionStarted',b->'submissionStarted','submissionExternalWriteStarted',b->'submissionExternalWriteStarted',
    'purge',CASE WHEN b->'purge' IS NULL THEN NULL ELSE jsonb_build_object('state',b#>'{purge,state}',
      'requestedAt',b#>'{purge,requestedAt}','errorMessage',b#>'{purge,errorMessage}',
      'retainedObjects',b#>'{purge,retainedObjects}','retainedSources',b#>'{purge,retainedSources}') END,
    'stoppedFrom',b->'stoppedFrom','updatedAt',b->'updatedAt',
    'errorMessage',b->'errorMessage','quotaWait',b->'quotaWait','priceFailure',b->'priceFailure',
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

CREATE OR REPLACE FUNCTION ai_listing_refresh_list_summary() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.list_summary := ai_listing_list_summary(NEW.body);
  RETURN NEW;
END;
$$;
CREATE TRIGGER ai_listing_refresh_list_summary
  BEFORE INSERT OR UPDATE OF body ON ai_image_listing_tasks
  FOR EACH ROW EXECUTE FUNCTION ai_listing_refresh_list_summary();

-- Existing rows are backfilled inside PostgreSQL; complete bodies never travel
-- through the API process and their content/version/queue state stays unchanged.
UPDATE ai_image_listing_tasks SET list_summary=ai_listing_list_summary(body);
ALTER TABLE ai_image_listing_tasks ALTER COLUMN list_summary SET NOT NULL;
