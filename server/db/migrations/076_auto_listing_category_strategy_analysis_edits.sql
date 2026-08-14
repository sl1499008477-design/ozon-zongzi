-- Append-only provenance for AI results and administrator-authored guidance.
-- Existing 075 rows remain AI results; manual revisions reference the exact
-- same-account/category base attempt and never carry vendor response fields.

ALTER TABLE auto_listing_category_strategy_analysis_attempts
  ADD CONSTRAINT auto_listing_category_strategy_analysis_attempts_scope_id_unique
  UNIQUE (account_id,draft_id,taxonomy_scope,description_category_id,type_id,id);

ALTER TABLE auto_listing_category_strategy_analysis_results
  ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'AI'
    CHECK (source_kind IN ('AI','MANUAL')),
  ADD COLUMN edited_by TEXT REFERENCES accounts(id) ON DELETE RESTRICT,
  ADD COLUMN edited_at TIMESTAMPTZ CHECK (edited_at IS NULL OR ISFINITE(edited_at)),
  ADD COLUMN base_analysis_attempt_id TEXT,
  ADD CONSTRAINT auto_listing_category_strategy_analysis_results_editor_account
    CHECK (edited_by=account_id),
  ADD CONSTRAINT auto_listing_category_strategy_analysis_results_source_provenance
    CHECK (
      (source_kind='AI' AND edited_by IS NULL AND edited_at IS NULL AND base_analysis_attempt_id IS NULL)
      OR
      (source_kind='MANUAL' AND edited_by IS NOT NULL AND edited_at IS NOT NULL
        AND base_analysis_attempt_id=attempt_id
        AND raw_response=JSONB_BUILD_OBJECT(
          'sourceKind','MANUAL','baseAnalysisAttemptId',base_analysis_attempt_id
        ))
    ),
  ADD CONSTRAINT auto_listing_category_strategy_analysis_results_base_attempt_fk
    FOREIGN KEY (account_id,draft_id,taxonomy_scope,description_category_id,type_id,base_analysis_attempt_id)
    REFERENCES auto_listing_category_strategy_analysis_attempts(
      account_id,draft_id,taxonomy_scope,description_category_id,type_id,id
    ) ON DELETE CASCADE;

ALTER TABLE auto_listing_category_strategy_analysis_results
  DROP CONSTRAINT IF EXISTS auto_listing_category_strategy_analys_account_id_attempt_id_key;

ALTER TABLE auto_listing_category_strategy_analysis_results
  DROP CONSTRAINT IF EXISTS auto_listing_category_strategy_analysis_results_account_id_attempt_id_key;

CREATE UNIQUE INDEX auto_listing_category_strategy_one_ai_result_per_attempt
  ON auto_listing_category_strategy_analysis_results(account_id,attempt_id)
  WHERE source_kind='AI';
