ALTER TABLE ai_user_channels ADD COLUMN pricing JSONB;
ALTER TABLE ai_user_channel_requests
  ADD COLUMN pricing_snapshot JSONB,
  ADD COLUMN usage JSONB,
  ADD COLUMN estimated_cost NUMERIC(30,12),
  ADD COLUMN cost_currency TEXT CHECK (cost_currency IN ('CNY','USD'));

-- Preserve historical estimates; failed/incomplete attempts have unknown charges.
UPDATE ai_user_channel_requests SET estimated_cost=estimated_cost_cny,cost_currency='CNY'
WHERE status='SUCCEEDED' AND estimated_cost_cny IS NOT NULL;
CREATE INDEX ai_user_channel_requests_channel ON ai_user_channel_requests(channel_id,account_id);
