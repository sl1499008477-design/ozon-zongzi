-- Keep durable queue order separate from timestamps and image JSON.
ALTER TABLE ai_image_listing_tasks DROP CONSTRAINT ai_image_listing_tasks_status_check;
ALTER TABLE ai_image_listing_tasks ADD CONSTRAINT ai_image_listing_tasks_status_check CHECK (status IN (
 'QUEUED','COLLECTING','GENERATING','AWAITING_REVIEW','READY_TO_SUBMIT','SUBMITTING','SUBMITTED','COMPLETED',
 'COLLECTION_FAILED','GENERATION_FAILED','UPLOAD_FAILED','SUBMISSION_FAILED','SUBMISSION_UNCERTAIN','CANCELLED','MERGED'));
CREATE SEQUENCE ai_listing_queue_position_seq;
ALTER TABLE ai_image_listing_tasks ADD COLUMN queue_position BIGINT;
WITH ordered AS (SELECT id,row_number() OVER(ORDER BY created_at,id) n FROM ai_image_listing_tasks)
 UPDATE ai_image_listing_tasks task SET queue_position=ordered.n FROM ordered WHERE task.id=ordered.id;
SELECT setval('ai_listing_queue_position_seq',COALESCE((SELECT max(queue_position) FROM ai_image_listing_tasks),0)+1,false);
ALTER TABLE ai_image_listing_tasks ALTER COLUMN queue_position SET DEFAULT nextval('ai_listing_queue_position_seq');
ALTER TABLE ai_image_listing_tasks ALTER COLUMN queue_position SET NOT NULL;
ALTER TABLE ai_image_listing_tasks ADD COLUMN work_phase TEXT NOT NULL DEFAULT 'idle';
UPDATE ai_image_listing_tasks SET work_phase=CASE
 WHEN status NOT IN ('QUEUED','COLLECTING','GENERATING','READY_TO_SUBMIT','SUBMITTING','SUBMITTED') THEN 'idle'
 WHEN status IN ('SUBMITTING','SUBMITTED','READY_TO_SUBMIT') THEN 'finalize'
 WHEN body->'source' IS NULL OR body->'source'='null'::jsonb THEN 'prepare'
 WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(body->'images','[]'::jsonb)) image WHERE COALESCE(image->>'generatedUrl','')='') THEN 'generate'
 ELSE 'finalize' END;
CREATE INDEX ai_listing_phase_queue_idx ON ai_image_listing_tasks(work_phase,queue_position) WHERE work_phase<>'idle';
CREATE INDEX ai_listing_import_batch_idx ON ai_image_listing_tasks(account_id,(body->>'importBatchId')) WHERE body ? 'importBatchId';
CREATE SEQUENCE ai_listing_account_turn_seq;
CREATE TABLE ai_listing_account_turns(account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,last_turn BIGINT NOT NULL);
