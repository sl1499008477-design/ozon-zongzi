-- Bind every persisted terminal image-group check to the exact gateway call
-- and immutable account-scoped connection version that produced it.

ALTER TABLE auto_listing_image_group_checks
  ADD COLUMN gateway_request_id TEXT,
  ADD COLUMN model_evidence JSONB,
  ADD COLUMN gateway_connection_id TEXT,
  ADD COLUMN gateway_connection_version INTEGER;

ALTER TABLE auto_listing_image_group_checks
  ADD CONSTRAINT auto_listing_image_group_check_gateway_evidence_check CHECK (
    (gateway_request_id IS NULL AND model_evidence IS NULL)
    OR (gateway_request_id IS NOT NULL AND model_evidence IS NOT NULL
      AND auto_listing_ai_runtime_safe_identifier(gateway_request_id)
      AND JSONB_TYPEOF(model_evidence)='object'
      AND OCTET_LENGTH(model_evidence::TEXT)<=16384)
  ) NOT VALID,
  ADD CONSTRAINT auto_listing_image_group_check_gateway_connection_pair_check CHECK (
    (gateway_connection_id IS NULL AND gateway_connection_version IS NULL)
    OR (gateway_connection_id IS NOT NULL AND gateway_connection_version IS NOT NULL
      AND auto_listing_ai_runtime_safe_identifier(gateway_connection_id)
      AND gateway_connection_version BETWEEN 1 AND 2147483647)
  ) NOT VALID,
  ADD CONSTRAINT auto_listing_image_group_check_gateway_connection_fk
    FOREIGN KEY (account_id, gateway_connection_id, gateway_connection_version)
    REFERENCES ai_gateway_connection_versions(account_id, id, version) ON DELETE RESTRICT NOT VALID;
