-- Direct V3 freezes its own official warehouse evidence, independent of retired AUTO_LISTING handoffs.
ALTER TABLE submission_snapshots ADD COLUMN IF NOT EXISTS direct_rfbs_evidence JSONB;
CREATE OR REPLACE FUNCTION guard_direct_listing_rfbs_evidence()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE target RECORD; evidence JSONB; evidence_count INTEGER;
BEGIN
 IF TG_OP='UPDATE' THEN
  IF NEW.direct_rfbs_evidence IS DISTINCT FROM OLD.direct_rfbs_evidence THEN
   RAISE EXCEPTION 'direct RFBS evidence is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
 END IF;
 -- NULL preserves existing AUTO_LISTING and historical snapshot contracts.
 IF NEW.direct_rfbs_evidence IS NULL THEN RETURN NEW; END IF;
 IF JSONB_TYPEOF(NEW.direct_rfbs_evidence)<>'array' THEN
  RAISE EXCEPTION 'direct RFBS evidence must be an array' USING ERRCODE='23514';
 END IF;
 FOR target IN SELECT DISTINCT stock->>'warehouse_id' AS platform_id
  FROM JSONB_ARRAY_ELEMENTS(NEW.stocks) AS stock LOOP
  IF NOT EXISTS(SELECT 1 FROM warehouses w JOIN stores s ON s.id=w.store_id
   WHERE s.owner_account_id=NEW.account_id AND w.store_id=NEW.store_id AND w.warehouse_id=target.platform_id
    AND w.is_active AND NOT w.is_archived AND LOWER(w.status) NOT IN ('disabled','inactive','archived','deleted','blocked')
    AND UPPER(w.warehouse_type) IN ('FBS','RFBS')) THEN
   RAISE EXCEPTION 'direct stock warehouse is not eligible' USING ERRCODE='23514';
  END IF;
  IF EXISTS(SELECT 1 FROM warehouses w WHERE w.store_id=NEW.store_id AND w.warehouse_id=target.platform_id AND UPPER(w.warehouse_type)='RFBS') THEN
   SELECT COUNT(*) INTO evidence_count FROM JSONB_ARRAY_ELEMENTS(NEW.direct_rfbs_evidence) AS value WHERE value->>'platformWarehouseId'=target.platform_id;
   IF evidence_count<>1 THEN RAISE EXCEPTION 'direct RFBS evidence is missing or duplicated' USING ERRCODE='23514'; END IF;
  END IF;
 END LOOP;
 FOR evidence IN SELECT value FROM JSONB_ARRAY_ELEMENTS(NEW.direct_rfbs_evidence) LOOP
  IF evidence->>'accountId' IS DISTINCT FROM NEW.account_id OR evidence->>'storeId' IS DISTINCT FROM NEW.store_id
   OR evidence->>'fulfillmentType' IS DISTINCT FROM 'RFBS' OR evidence->>'outcome' IS DISTINCT FROM 'PASSED'
   OR COALESCE(evidence->>'evidenceHash','') !~ '^[a-f0-9]{64}$'
   OR COALESCE((evidence->>'expiresAt')::timestamptz,'-infinity')<=STATEMENT_TIMESTAMP()
   OR NOT EXISTS(SELECT 1 FROM JSONB_ARRAY_ELEMENTS(NEW.stocks) AS stock WHERE stock->>'warehouse_id'=evidence->>'platformWarehouseId')
   OR NOT EXISTS(SELECT 1 FROM warehouses w WHERE w.id=evidence->>'warehouseRecordId' AND w.store_id=NEW.store_id
     AND w.warehouse_id=evidence->>'platformWarehouseId' AND UPPER(w.warehouse_type)='RFBS') THEN
   RAISE EXCEPTION 'direct RFBS evidence does not match frozen stocks' USING ERRCODE='23514';
  END IF;
 END LOOP;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS direct_listing_rfbs_evidence_guard ON submission_snapshots;
CREATE TRIGGER direct_listing_rfbs_evidence_guard BEFORE INSERT OR UPDATE OF direct_rfbs_evidence ON submission_snapshots
 FOR EACH ROW EXECUTE FUNCTION guard_direct_listing_rfbs_evidence();
