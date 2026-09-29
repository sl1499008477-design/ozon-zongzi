-- A finished request with an unknown upstream result is no longer a live request.
-- Keep its channel/billing protection separate from global request capacity.
-- Existing leases are intentionally untouched: they may still own a live request.
ALTER TABLE ai_user_channels ADD COLUMN request_hold_until TIMESTAMPTZ;
