CREATE TABLE real_pricing_profiles (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  rules JSONB NOT NULL,
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ(3) NOT NULL DEFAULT NOW(),
  UNIQUE(account_id,name)
);
CREATE UNIQUE INDEX real_pricing_one_default ON real_pricing_profiles(account_id) WHERE is_default;

-- Preserve every existing formula; listing IDs and all historical snapshots stay unchanged.
INSERT INTO real_pricing_profiles(id,account_id,name,rules,is_default,created_at,updated_at)
SELECT 'real:'||id,account_id,name,
  jsonb_build_object('currency',rules->>'currency','realPriceFormula',rules->>'realPriceFormula'),
  row_number() OVER (PARTITION BY account_id ORDER BY updated_at DESC,id)=1,created_at,updated_at
FROM sale_pricing_profiles;
INSERT INTO real_pricing_profiles(id,account_id,name,rules,is_default)
SELECT 'initial-real:'||a.id,a.id,'默认真实售价',
  jsonb_build_object('currency','CNY','realPriceFormula','IF(黑标价 < 80, 黑标价 / 1.0715, IF(有绿标价, (黑标价 - 绿标价) * 2.25 + 黑标价, 黑标价))'),TRUE
FROM accounts a WHERE NOT EXISTS (SELECT 1 FROM real_pricing_profiles r WHERE r.account_id=a.id);
