-- A user-approved retry advances auto_listing_job_items.status_version while
-- keeping the same immutable image input.  The original table constraint did
-- not include that version, so binding attempt 1..3 in the new retry cycle
-- collided with terminal attempts from the previous cycle.
ALTER TABLE ai_generation_assets
  DROP CONSTRAINT IF EXISTS ai_generation_assets_item_id_slot_key_input_hash_attempt_no_key;

CREATE UNIQUE INDEX IF NOT EXISTS ai_generation_assets_versioned_input_attempt_key
  ON ai_generation_assets(item_id,slot_key,input_hash,expected_status_version,attempt_no)
  WHERE expected_status_version IS NOT NULL;

-- Preserve the original uniqueness rule for pre-runtime rows that have no
-- status-version fence.
CREATE UNIQUE INDEX IF NOT EXISTS ai_generation_assets_legacy_input_attempt_key
  ON ai_generation_assets(item_id,slot_key,input_hash,attempt_no)
  WHERE expected_status_version IS NULL;
