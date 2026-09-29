-- Product ownership is separate from the lease of an individual paid request.
ALTER TABLE ai_user_channels ADD COLUMN product_task_id TEXT;
ALTER TABLE ai_user_channels ADD COLUMN product_token TEXT;
ALTER TABLE ai_user_channels ADD COLUMN product_lease_until TIMESTAMPTZ;
ALTER TABLE ai_user_channels ADD CONSTRAINT ai_user_channels_product_complete CHECK (
  (product_task_id IS NULL AND product_token IS NULL AND product_lease_until IS NULL) OR
  (product_task_id IS NOT NULL AND product_token IS NOT NULL AND product_lease_until IS NOT NULL)
);
CREATE UNIQUE INDEX ai_user_channels_product_task ON ai_user_channels(account_id,product_task_id) WHERE product_task_id IS NOT NULL;
CREATE UNIQUE INDEX ai_user_channels_product_token ON ai_user_channels(product_token) WHERE product_token IS NOT NULL;
