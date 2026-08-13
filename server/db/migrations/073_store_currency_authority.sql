-- Record whether a store currency was observed from the store's own Ozon
-- seller profile. Historical default currency values stay readable but are
-- not promoted to verified authority.

ALTER TABLE stores
  ADD COLUMN currency_source TEXT,
  ADD COLUMN currency_synced_at TIMESTAMPTZ,
  ADD CONSTRAINT stores_currency_authority_check CHECK (
    (currency_source IS NULL AND currency_synced_at IS NULL)
    OR (
      currency_source='OZON_SELLER_INFO'
      AND currency_synced_at IS NOT NULL
      AND currency_code IN ('RUB','CNY')
    )
  );
