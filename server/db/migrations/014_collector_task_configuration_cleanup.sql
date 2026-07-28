-- Older desktop clients copied the complete server task object into the
-- user-editable configuration on every save. Remove only server-owned and
-- recursive envelope keys; keep the current outer user values unchanged.

UPDATE collector_tasks
SET configuration = configuration
      - 'configuration'
      - 'config'
      - 'taskConfig'
      - 'accountId'
      - 'createdBy'
      - 'createdAt'
      - 'updatedAt'
      - 'deletedAt'
      - 'currentRunId'
      - 'statusVersion'
      - 'lastErrorCode'
      - 'lastErrorMessage',
    updated_at = NOW()
WHERE configuration ?| ARRAY[
  'configuration',
  'config',
  'taskConfig',
  'accountId',
  'createdBy',
  'createdAt',
  'updatedAt',
  'deletedAt',
  'currentRunId',
  'statusVersion',
  'lastErrorCode',
  'lastErrorMessage'
];
