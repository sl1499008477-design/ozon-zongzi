-- Add an append-only pre-send upload-attempt state. Existing rows and terminal
-- outcomes remain unchanged; RFBS upload reservations use this row to bind the
-- fresh evidence authorized for one claimed submission link before side effects.

ALTER TABLE auto_listing_upload_attempts
  DROP CONSTRAINT IF EXISTS auto_listing_upload_attempts_outcome_check;

ALTER TABLE auto_listing_upload_attempts
  ADD CONSTRAINT auto_listing_upload_attempts_outcome_check
  CHECK (
    outcome IN ('RESERVED','SUCCEEDED','FAILED','UNCERTAIN','BLOCKED')
    AND (outcome <> 'RESERVED' OR warehouse_validation_evidence_id IS NOT NULL)
  )
  NOT VALID;

ALTER TABLE auto_listing_upload_attempts
  VALIDATE CONSTRAINT auto_listing_upload_attempts_outcome_check;
