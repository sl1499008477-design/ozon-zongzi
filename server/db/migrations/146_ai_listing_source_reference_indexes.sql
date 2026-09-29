-- Purge checks whether another unfinished task still owns the collected source.
-- Index the three existing reference locations to avoid repeatedly decoding every
-- large source snapshot. Completed receipts no longer retain source ownership.
CREATE INDEX ai_listing_source_id_reference_idx
 ON ai_image_listing_tasks(account_id,(body->>'sourceId'))
 WHERE body->>'permanentlyDeletedAt' IS NULL;

CREATE INDEX ai_listing_collect_id_reference_idx
 ON ai_image_listing_tasks(account_id,(body#>>'{source,collectItemId}'))
 WHERE body->>'permanentlyDeletedAt' IS NULL;

CREATE INDEX ai_listing_initial_collect_id_reference_idx
 ON ai_image_listing_tasks(account_id,(body#>>'{collectWait,initialSource,collectItemId}'))
 WHERE body->>'permanentlyDeletedAt' IS NULL;
