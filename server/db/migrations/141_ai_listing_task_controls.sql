ALTER TABLE ai_image_listing_tasks DROP CONSTRAINT ai_image_listing_tasks_status_check;
ALTER TABLE ai_image_listing_tasks ADD CONSTRAINT ai_image_listing_tasks_status_check CHECK (status IN (
 'QUEUED','COLLECTING','GENERATING','AWAITING_REVIEW','READY_TO_SUBMIT','SUBMITTING','SUBMITTED','COMPLETED',
 'COLLECTION_FAILED','GENERATION_FAILED','UPLOAD_FAILED','SUBMISSION_FAILED','SUBMISSION_UNCERTAIN','CANCELLED','MERGED','PAUSED'));
-- Control requests do not revoke the worker lease: an already paid response must be saved first.
ALTER TABLE ai_image_listing_tasks ADD COLUMN control_action TEXT CHECK (control_action IN ('pause','cancel','delete'));
-- Retain source evidence, submitted history and billing references when removing a task from the list.
ALTER TABLE ai_image_listing_tasks ADD COLUMN deleted_at BIGINT;
