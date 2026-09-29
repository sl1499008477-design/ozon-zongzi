-- Ozon collection can run independently of the retired desktop pricing flow.
-- Keep the foreign key and every historical reference; new unpriced runs use NULL.
ALTER TABLE collector_task_runs
  ALTER COLUMN pricing_config_version_id DROP NOT NULL;
