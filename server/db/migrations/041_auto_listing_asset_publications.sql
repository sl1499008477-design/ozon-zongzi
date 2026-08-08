CREATE UNIQUE INDEX IF NOT EXISTS ai_generation_assets_account_job_item_plan_id_key
  ON ai_generation_assets(account_id,job_id,item_id,plan_id,id);

CREATE TABLE IF NOT EXISTS auto_listing_asset_publications (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  job_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  visual_group_key TEXT NOT NULL,
  slot_key TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('MAIN','SELLING_POINT','DETAIL','SCENE','SPECIFICATION','INFOGRAPHIC')),
  content_hash TEXT NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  content_type TEXT NOT NULL CHECK (content_type IN ('image/png','image/jpeg','image/webp')),
  size_bytes BIGINT NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 33554432),
  width INTEGER NOT NULL CHECK (width > 0),
  height INTEGER NOT NULL CHECK (height > 0),
  private_object_key TEXT NOT NULL CHECK (NULLIF(BTRIM(private_object_key), '') IS NOT NULL),
  public_object_key TEXT NOT NULL CHECK (NULLIF(BTRIM(public_object_key), '') IS NOT NULL),
  public_url TEXT NOT NULL CHECK (public_url ~ '^https://[^?#]+$'),
  publication_version TEXT NOT NULL CHECK (publication_version = 'LISTING_MEDIA_V1'),
  published_by_account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (account_id,asset_id,content_hash),
  UNIQUE (account_id,public_object_key),
  FOREIGN KEY (account_id,job_id,item_id,plan_id,asset_id)
    REFERENCES ai_generation_assets(account_id,job_id,item_id,plan_id,id) ON DELETE RESTRICT,
  CHECK (published_by_account_id = account_id)
);

CREATE INDEX IF NOT EXISTS auto_listing_asset_publications_item_idx
  ON auto_listing_asset_publications(account_id,item_id,plan_id,created_at DESC);

CREATE OR REPLACE FUNCTION auto_listing_reject_asset_publication_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'auto-listing asset publications are immutable audit evidence' USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER auto_listing_asset_publications_immutable
BEFORE UPDATE OR DELETE ON auto_listing_asset_publications
FOR EACH ROW EXECUTE FUNCTION auto_listing_reject_asset_publication_mutation();
