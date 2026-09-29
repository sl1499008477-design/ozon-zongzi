-- Normal collection writes inspect only unfinished purge intents, not every
-- historical task's potentially large source snapshot.
CREATE INDEX ai_listing_active_purge_idx ON ai_image_listing_tasks(account_id,id)
 WHERE body->'purge' IS NOT NULL AND body->>'permanentlyDeletedAt' IS NULL;

-- Fifteen-day polling can reject recent deleted tasks from the scalar timestamp
-- index before loading their source/media JSON.
CREATE INDEX ai_listing_due_purge_idx ON ai_image_listing_tasks(deleted_at,id)
 WHERE deleted_at IS NOT NULL AND status='CANCELLED' AND control_action IS NULL
   AND body->'purge' IS NULL AND body->>'permanentlyDeletedAt' IS NULL;
