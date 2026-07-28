ALTER TABLE pricing_config_versions
  ADD COLUMN IF NOT EXISTS rule_confirmation_status TEXT NOT NULL DEFAULT 'UNCONFIRMED'
  CHECK (rule_confirmation_status IN ('UNCONFIRMED', 'CONFIRMED'));

UPDATE pricing_config_versions
SET rule_confirmation_status='UNCONFIRMED',
    updated_at=NOW()
WHERE rule_confirmation_status IS NULL
   OR id='pricing_builtin_default';
