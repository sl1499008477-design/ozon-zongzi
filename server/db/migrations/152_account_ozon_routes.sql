CREATE TABLE account_ozon_routes (
 account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
 route TEXT NOT NULL CHECK(route IN ('CN','RU')),
 revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Existing task bodies retain their selected route across retries and restarts.
ALTER TABLE submission_jobs ADD COLUMN ozon_route TEXT CHECK(ozon_route IN ('CN','RU','LEGACY'));
-- Keep requests that already started on the pre-upgrade transport configuration.
-- LEGACY is internal only and resolves the original OZON_API_BASE (default RU).
UPDATE submission_jobs SET ozon_route='LEGACY' WHERE status NOT IN ('QUEUE_PENDING','QUEUED') AND ozon_route IS NULL;
UPDATE ozon_promotion_runs SET body=body || '{"ozonRoute":"LEGACY"}'::jsonb
 WHERE NOT body ? 'ozonRoute' AND (status IN ('RUNNING','UNCERTAIN') OR EXISTS (
   SELECT 1 FROM jsonb_array_elements(COALESCE(body->'items','[]'::jsonb)) item
   WHERE item->>'status' IN ('SUBMITTED','UNCERTAIN','SUCCEEDED') OR NULLIF(item->>'submittedAt','') IS NOT NULL
 ));
UPDATE ozon_stock_changes SET body=body || '{"ozonRoute":"LEGACY"}'::jsonb
 WHERE status<>'QUEUED' AND NOT body ? 'ozonRoute';
UPDATE ai_image_listing_submissions SET body=jsonb_set(body,'{config,ozonRoute}','"LEGACY"'::jsonb)
 WHERE NOT (body->'config') ? 'ozonRoute';
UPDATE ai_image_listing_tasks SET body=jsonb_set(body,'{config,ozonRoute}','"LEGACY"'::jsonb)
 WHERE (body->>'submissionStarted'='true' OR body->>'submissionExternalWriteStarted'='true'
   OR NULLIF(body->>'submissionId','') IS NOT NULL) AND NOT (body->'config') ? 'ozonRoute';
UPDATE ozon_order_management_sync SET state=state || '{"ozonRoute":"LEGACY"}'::jsonb
 WHERE state->>'status'='RUNNING' AND NOT state ? 'ozonRoute';
UPDATE ozon_message_records SET body=body || '{"ozonRoute":"LEGACY"}'::jsonb
 WHERE NOT body ? 'ozonRoute' AND (status IN ('SENDING','UNCERTAIN')
   OR body->>'phase' IN ('CHAT_START','CHAT_READY','SEND') OR body ? 'sendStartedAt');
