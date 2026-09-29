-- A restored database may create actor FKs before the owning account CASCADE.
-- Check the surviving actor references at transaction end, after the owning
-- account's cascade, without permitting deletion of another account's evidence.
ALTER TABLE auto_listing_category_strategy_account_settings
  DROP CONSTRAINT auto_listing_category_strategy_account_se_actor_account_id_fkey;
ALTER TABLE auto_listing_category_strategy_account_settings
  ADD CONSTRAINT auto_listing_category_strategy_account_se_actor_account_id_fkey
  FOREIGN KEY (actor_account_id) REFERENCES accounts(id)
  ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;

-- pg_restore intentionally clears search_path. This SQL function is used by
-- CHECK constraints while COPY restores data and calls another public helper.
ALTER FUNCTION public.auto_listing_ai_runtime_safe_identifier(text)
  SET search_path = public, pg_temp;
