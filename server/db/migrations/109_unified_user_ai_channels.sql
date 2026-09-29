ALTER TABLE ai_user_channels ADD COLUMN image_protocol TEXT NOT NULL DEFAULT 'SUB2API_RESPONSES_IMAGE_TOOL'
 CHECK(image_protocol IN ('SUB2API_RESPONSES_IMAGE_TOOL','SUB2API_OPENAI_IMAGES'));
ALTER TABLE ai_user_channels ADD COLUMN connection_check JSONB;
-- Immutable internal model snapshots support existing listing plan foreign keys.
-- They are not an alternative configuration source and never contain a Key.
INSERT INTO ai_gateway_profiles(id,account_id,display_name,base_url,api_key_env_name,text_protocol,image_protocol,
 text_model,image_model,config_version,enabled,created_by)
SELECT 'user-channel-'||id,account_id,name,base_url,'USER_AI_CHANNEL_KEY','SUB2API_RESPONSES',image_protocol,
 text_model,image_model,1,FALSE,created_by FROM ai_user_channels ON CONFLICT DO NOTHING;
ALTER TABLE ai_user_channels ADD COLUMN profile_id TEXT REFERENCES ai_gateway_profiles(id);
UPDATE ai_user_channels SET profile_id='user-channel-'||id;
ALTER TABLE ai_user_channels ALTER CONSTRAINT ai_user_channels_profile_id_fkey DEFERRABLE INITIALLY DEFERRED;
