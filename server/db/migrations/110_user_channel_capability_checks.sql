ALTER TABLE ai_user_channels ADD COLUMN capability_check JSONB;
CREATE UNIQUE INDEX ai_user_channel_capability_request_once ON ai_user_channel_requests(account_id,request_key)
 WHERE request_key LIKE 'channel-capability:%';
