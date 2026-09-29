ALTER TABLE ai_user_channels ADD COLUMN failure_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ai_user_channels ADD COLUMN needs_attention BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE ai_user_channels ADD COLUMN last_error_code TEXT;
-- Existing failed channels enter recovery after healthy channels, without erasing history.
UPDATE ai_user_channels c SET failure_count=1,last_error_code=r.error_code
FROM (SELECT DISTINCT ON(channel_id) channel_id,status,error_code FROM ai_user_channel_requests ORDER BY channel_id,created_at DESC) r
WHERE c.id=r.channel_id AND r.status='FAILED';
