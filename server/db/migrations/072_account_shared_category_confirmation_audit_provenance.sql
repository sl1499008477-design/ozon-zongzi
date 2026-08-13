-- Close every newly written administrator-confirmation audit over the exact
-- immutable manual observation and its resulting current/shared state.

ALTER TABLE account_ozon_category_confirmation_audit
  ADD COLUMN provenance_version SMALLINT NOT NULL DEFAULT 1
    CHECK (provenance_version IN (1,2)),
  ADD CONSTRAINT account_ozon_category_confirmation_audit_manual_item_fkey
    FOREIGN KEY (account_id,manual_confirmation_evidence_id,collect_item_id)
    REFERENCES collect_ozon_category_manual_confirmation_evidence(
      account_id,id,collect_item_id
    ) ON DELETE CASCADE;

CREATE OR REPLACE FUNCTION validate_account_ozon_category_confirmation_audit_v2()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.provenance_version<>2 OR NEW.manual_confirmation_evidence_id IS NULL THEN
    RAISE EXCEPTION 'new category confirmation audit requires exact manual provenance'
      USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM collect_ozon_category_manual_confirmation_evidence AS observation
      JOIN collect_ozon_category_source_evidence AS evidence
        ON evidence.account_id=observation.account_id
       AND evidence.id=observation.source_evidence_id
       AND evidence.collect_item_id=observation.collect_item_id
       AND evidence.source_kind='MANUAL_CONFIRMATION'
       AND evidence.source_description_category_id=observation.selected_description_category_id
       AND evidence.source_type_id=observation.selected_type_id
       AND evidence.taxonomy_scope=observation.taxonomy_scope
      JOIN collect_ozon_category_current_sources AS current_source
        ON current_source.account_id=observation.account_id
       AND current_source.collect_item_id=observation.collect_item_id
       AND current_source.source_evidence_id=observation.source_evidence_id
       AND current_source.source_kind='MANUAL_CONFIRMATION'
       AND current_source.source_record_id=observation.source_record_id
       AND current_source.source_version=observation.source_version
      JOIN account_ozon_shared_categories AS shared
        ON shared.account_id=observation.account_id
       AND shared.source_description_category_id=observation.selected_description_category_id
       AND shared.source_type_id=observation.selected_type_id
       AND shared.taxonomy_scope=observation.taxonomy_scope
       AND shared.current_description_category_id=observation.selected_description_category_id
       AND shared.current_type_id=observation.selected_type_id
       AND shared.source_evidence_id=observation.source_evidence_id
       AND shared.status='ACTIVE' AND shared.source='MANUAL'
      JOIN account_ozon_shared_category_events AS shared_event
        ON shared_event.account_id=shared.account_id
       AND shared_event.shared_category_id=shared.id
       AND shared_event.source_evidence_id=observation.source_evidence_id
       AND shared_event.event_type='MANUAL_CATEGORY_CONFIRMED'
       AND shared_event.to_status='ACTIVE'
       AND shared_event.to_version=shared.version
     WHERE observation.account_id=NEW.account_id
       AND observation.id=NEW.manual_confirmation_evidence_id
       AND observation.collect_item_id=NEW.collect_item_id
       AND observation.source_evidence_id=NEW.source_evidence_id
       AND observation.selected_description_category_id=NEW.selected_description_category_id
       AND observation.selected_type_id=NEW.selected_type_id
       AND observation.taxonomy_scope=NEW.taxonomy_scope
       AND observation.actor_id=NEW.actor_id
       AND observation.correlation_id=NEW.correlation_id
       AND observation.idempotency_key=NEW.idempotency_key
       AND observation.request_hash=NEW.request_hash
       AND observation.captured_at=NEW.confirmed_at
       AND NEW.created_at=NEW.confirmed_at
       AND NEW.expected_source_version=
         'draft:' || observation.trigger_product_draft_version::TEXT
  ) THEN
    RAISE EXCEPTION 'category confirmation audit provenance does not match manual observation'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER account_ozon_category_confirmation_audit_v2_guard
BEFORE INSERT ON account_ozon_category_confirmation_audit
FOR EACH ROW EXECUTE FUNCTION validate_account_ozon_category_confirmation_audit_v2();
