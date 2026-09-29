CREATE TABLE global_real_pricing_profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  rules JSONB NOT NULL,
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ(3) NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX global_real_pricing_one_default ON global_real_pricing_profiles((TRUE)) WHERE is_default;

-- Start with the administrator's existing profiles and default. If there are
-- several administrators, use the most recently updated administrator default.
-- Keep all account-owned profiles and all historical task snapshots intact.
WITH source_account AS (
  SELECT a.id FROM accounts a JOIN real_pricing_profiles r ON r.account_id=a.id
  WHERE a.role='admin' AND r.is_default
  ORDER BY r.updated_at DESC,a.id LIMIT 1
)
INSERT INTO global_real_pricing_profiles(id,name,rules,is_default,created_at,updated_at)
SELECT r.id,r.name,r.rules,r.is_default,r.created_at,r.updated_at
FROM real_pricing_profiles r JOIN source_account a ON r.account_id=a.id;

INSERT INTO global_real_pricing_profiles(id,name,rules,is_default)
SELECT 'global-real-default','默认竞品真实售价计算',
  jsonb_build_object('currency','CNY','realPriceFormula','IF(黑标价 < 80, 黑标价 / 1.0715, IF(有绿标价, (黑标价 - 绿标价) * 2.25 + 黑标价, 黑标价))'),TRUE
WHERE NOT EXISTS(SELECT 1 FROM global_real_pricing_profiles WHERE is_default);
