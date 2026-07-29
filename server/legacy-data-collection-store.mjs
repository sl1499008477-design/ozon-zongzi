function accountScopeRequired() {
  const error = new Error("历史数据采集店铺查询必须指定 sonli 账号");
  error.code = "ACCOUNT_SCOPE_REQUIRED";
  return error;
}

function purgePolicyRequired(field) {
  const error = new Error(`历史数据采集店铺清理策略缺少 ${field}`);
  error.code = "LEGACY_PURGE_POLICY_REQUIRED";
  return error;
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
}

function jsonClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizedId(value) {
  return String(value || "").trim();
}

function legacyStoreId(value) {
  return normalizedId(value?.id || value?.dataCollectionStoreId);
}

function sourceTimestamp(store, state) {
  return normalizedId(store?.updatedAt || store?.createdAt || state?.updatedAt);
}

function archiveKey(accountId, dataCollectionStoreId) {
  return `${encodeURIComponent(accountId)}:${encodeURIComponent(dataCollectionStoreId)}`;
}

const LEGACY_ACCOUNT_OWNER_FIELDS = new Set([
  "accountId",
  "account_id",
  "ownerAccountId",
  "owner_account_id",
  "createdBy",
  "created_by",
  "updatedBy",
  "updated_by",
]);

function accountIdFromArchiveKey(value) {
  const rawAccountId = normalizedId(value).split(":", 1)[0];
  if (!rawAccountId) return "";
  try {
    return normalizedId(decodeURIComponent(rawAccountId));
  } catch {
    return rawAccountId;
  }
}

function dataStoreIdFromArchiveKey(value) {
  const rawKey = normalizedId(value);
  const separator = rawKey.indexOf(":");
  const rawStoreId = separator >= 0 ? rawKey.slice(separator + 1) : "";
  if (!rawStoreId) return "";
  try {
    return normalizedId(decodeURIComponent(rawStoreId));
  } catch {
    return rawStoreId;
  }
}

function archiveOwnershipEvidence(record) {
  const owners = [];
  const remember = (value) => {
    const ownerId = normalizedId(value);
    if (ownerId && !owners.includes(ownerId)) owners.push(ownerId);
  };
  const visit = (value) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    for (const [field, child] of Object.entries(value)) {
      if (LEGACY_ACCOUNT_OWNER_FIELDS.has(field)) remember(child);
      if (field === "archiveKey") remember(accountIdFromArchiveKey(child));
      if (child && typeof child === "object") visit(child);
    }
  };
  visit(record);
  return owners;
}

function archiveOwnerForCount(record) {
  for (const source of [record, objectValue(record?.legacySnapshot)]) {
    for (const field of LEGACY_ACCOUNT_OWNER_FIELDS) {
      const ownerId = normalizedId(source?.[field]);
      if (ownerId) return ownerId;
    }
  }
  return archiveOwnershipEvidence(record)[0] || "";
}

function archiveRecordIdentity(record) {
  const accountId = archiveOwnerForCount(record);
  const dataCollectionStoreId = normalizedId(record?.dataCollectionStoreId)
    || legacyStoreId(record?.legacySnapshot)
    || dataStoreIdFromArchiveKey(record?.archiveKey);
  return accountId && dataCollectionStoreId
    ? archiveKey(accountId, dataCollectionStoreId)
    : "";
}

function archiveCountsByOwnership(records) {
  const counts = {};
  for (const record of records) {
    const accountId = archiveOwnerForCount(record);
    if (!accountId) continue;
    counts[accountId] = (counts[accountId] || 0) + 1;
  }
  return Object.fromEntries(
    Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function currentLegacyMappings(state) {
  const mappings = new Map();
  const add = (accountId, storeId, sourceField) => {
    const ownerId = normalizedId(accountId);
    const dataStoreId = normalizedId(storeId);
    if (!ownerId || !dataStoreId) return;
    const previous = mappings.get(dataStoreId) || [];
    if (!previous.some((item) => item.accountId === ownerId)) {
      previous.push({ accountId: ownerId, sourceField });
    }
    mappings.set(dataStoreId, previous);
  };

  for (const [accountId, storeId] of Object.entries(
    objectValue(state?.currentDataCollectionStoreIdsByAccount) || {},
  )) {
    add(accountId, storeId, "currentDataCollectionStoreIdsByAccount");
  }
  add(
    state?.currentAccountId,
    state?.currentDataCollectionStoreId,
    "currentDataCollectionStoreId",
  );
  for (const session of Object.values(objectValue(state?.sessions) || {})) {
    add(
      session?.accountId,
      session?.currentDataCollectionStoreId,
      "sessions.currentDataCollectionStoreId",
    );
  }
  return mappings;
}

function hasLegacyJsonRuntimeFields(state) {
  return [
    "currentDataCollectionStoreId",
    "currentDataCollectionStoreIdsByAccount",
    "dataCollectionStore",
    "dataCollectionStores",
  ].some((field) => Object.hasOwn(state, field))
    || Object.values(objectValue(state?.sessions) || {}).some((session) =>
      Object.hasOwn(objectValue(session) || {}, "currentDataCollectionStoreId"));
}

/**
 * One-way JSON fallback migration. The archive is persisted but intentionally
 * omitted from every runtime/public state projection. No normal runtime path
 * mutates archived records.
 */
export function migrateLegacyDataCollectionStoreStateForAudit(
  state,
  { archivedAt = new Date().toISOString() } = {},
) {
  if (!objectValue(state)) return state;
  const existing = state.legacyDataCollectionStoreAuditArchive;
  if (existing !== undefined && (
    !objectValue(existing)
    || existing.schemaVersion !== 1
    || existing.readOnly !== true
    || !Array.isArray(existing.records)
  )) {
    const error = new Error("历史数据采集店铺 JSON 审计归档格式无效");
    error.code = "LEGACY_DATA_STORE_AUDIT_ARCHIVE_INVALID";
    throw error;
  }

  if (hasLegacyJsonRuntimeFields(state)) {
    const currentMappings = currentLegacyMappings(state);
    const snapshots = new Map();
    const rememberSnapshot = (value, sourceField) => {
      const snapshot = objectValue(value);
      const id = legacyStoreId(snapshot);
      if (!snapshot || !id) return;
      const previous = snapshots.get(id);
      snapshots.set(id, {
        snapshot: previous
          ? { ...previous.snapshot, ...jsonClone(snapshot) }
          : jsonClone(snapshot),
        sourceFields: [...new Set([
          ...(previous?.sourceFields || []),
          sourceField,
        ])].sort(),
      });
    };
    for (const store of Array.isArray(state.dataCollectionStores)
      ? state.dataCollectionStores
      : []) {
      rememberSnapshot(store, "dataCollectionStores");
    }
    rememberSnapshot(state.dataCollectionStore, "dataCollectionStore");

    for (const [storeId] of currentMappings) {
      if (!snapshots.has(storeId)) {
        snapshots.set(storeId, {
          snapshot: { id: storeId },
          sourceFields: [],
        });
      }
    }

    const existingRecords = (existing?.records || []).map(jsonClone);
    const existingKeys = new Set(
      existingRecords.map(archiveRecordIdentity).filter(Boolean),
    );
    const migratedRecordsByKey = new Map();
    const onlyAccountId = Array.isArray(state.accounts) && state.accounts.length === 1
      ? normalizedId(state.accounts[0]?.id)
      : "";

    for (const [storeId, entry] of snapshots) {
      const snapshot = entry.snapshot;
      const owners = new Set([
        normalizedId(
          snapshot.ownerAccountId
          || snapshot.accountId
          || snapshot.createdBy,
        ),
        ...(currentMappings.get(storeId) || []).map((item) => item.accountId),
      ]);
      owners.delete("");
      if (owners.size === 0 && onlyAccountId) owners.add(onlyAccountId);
      if (owners.size === 0) owners.add("");

      for (const accountId of owners) {
        const key = archiveKey(accountId, storeId);
        if (existingKeys.has(key)) continue;
        const previous = migratedRecordsByKey.get(key);
        const mappingFields = (currentMappings.get(storeId) || [])
          .filter((item) => item.accountId === accountId)
          .map((item) => item.sourceField);
        migratedRecordsByKey.set(key, {
          archiveKey: key,
          accountId,
          dataCollectionStoreId: storeId,
          sourceTimestamp:
            sourceTimestamp(snapshot, state)
            || previous?.sourceTimestamp
            || "",
          archivedAt: previous?.archivedAt || archivedAt,
          wasCurrent: Boolean(previous?.wasCurrent || mappingFields.length > 0),
          sourceFields: [...new Set([
            ...(previous?.sourceFields || []),
            ...entry.sourceFields,
            ...mappingFields,
          ])].sort(),
          legacySnapshot: previous?.legacySnapshot
            ? { ...previous.legacySnapshot, ...jsonClone(snapshot) }
            : jsonClone(snapshot),
        });
      }
    }

    const migratedRecords = [...migratedRecordsByKey.values()].sort((left, right) =>
      normalizedId(left.accountId).localeCompare(normalizedId(right.accountId))
      || normalizedId(left.dataCollectionStoreId)
        .localeCompare(normalizedId(right.dataCollectionStoreId)));
    const records = [...existingRecords, ...migratedRecords];
    state.legacyDataCollectionStoreAuditArchive = {
      schemaVersion: 1,
      readOnly: true,
      records,
      accountRecordCounts: archiveCountsByOwnership(records),
    };
  }

  delete state.currentDataCollectionStoreId;
  delete state.currentDataCollectionStoreIdsByAccount;
  delete state.dataCollectionStore;
  delete state.dataCollectionStores;
  for (const session of Object.values(objectValue(state.sessions) || {})) {
    if (objectValue(session)) delete session.currentDataCollectionStoreId;
  }
  return state;
}

/**
 * Privacy-erasure boundary for the persisted JSON audit archive. Migration
 * runs first so retired runtime fields cannot recreate deleted-account records
 * during a later protect/save cycle.
 */
export function purgeLegacyDataCollectionStoreArchiveForAccount(
  state,
  { accountId, archivedAt = new Date().toISOString() } = {},
) {
  const ownerId = normalizedId(accountId);
  if (!ownerId) throw purgePolicyRequired("accountId");
  migrateLegacyDataCollectionStoreStateForAudit(state, { archivedAt });

  const archive = objectValue(state?.legacyDataCollectionStoreAuditArchive);
  if (!archive) return { purgedCount: 0, remainingCount: 0 };
  const records = archive.records.filter(
    (record) => !archiveOwnershipEvidence(record).includes(ownerId),
  );
  const purgedCount = archive.records.length - records.length;
  state.legacyDataCollectionStoreAuditArchive = {
    ...archive,
    records,
    accountRecordCounts: archiveCountsByOwnership(records),
  };
  return {
    purgedCount,
    remainingCount: records.length,
  };
}

function publicLegacyRecord(row = {}) {
  return {
    id: row.data_collection_store_id || "",
    accountId: row.account_id || "",
    sellerCompanyId: row.seller_company_id || "",
    label: row.label || "",
    status: row.status || "",
    note: row.note || "",
    isCurrent: row.is_current === true,
    lastVerifiedAt: row.last_verified_at || "",
    createdAt: row.membership_created_at || "",
    updatedAt: row.membership_updated_at || "",
    readOnly: true,
  };
}

export async function readLegacyDataCollectionStoresForAudit(pool, { accountId } = {}) {
  const ownerId = String(accountId || "").trim();
  if (!ownerId) throw accountScopeRequired();
  if (!pool || typeof pool.query !== "function") {
    throw new TypeError("历史数据采集店铺查询需要 PostgreSQL 连接池");
  }
  const result = await pool.query(
    `SELECT m.account_id, m.data_collection_store_id, m.label, m.status, m.note,
            m.is_current, m.last_verified_at, m.created_at AS membership_created_at,
            m.updated_at AS membership_updated_at, s.seller_company_id
     FROM account_data_collection_stores m
     JOIN data_collection_stores s ON s.id=m.data_collection_store_id
     WHERE m.account_id=$1
     ORDER BY m.updated_at DESC, m.data_collection_store_id`,
    [ownerId],
  );
  return (result.rows || []).map(publicLegacyRecord);
}

/**
 * Explicit privacy-erasure exception to the otherwise read-only legacy module.
 * The caller must already hold an outer transaction; this savepoint makes the
 * legacy evidence deletion and audit event atomic within that transaction.
 */
export async function purgeLegacyDataCollectionStoresForAccount(
  client,
  { accountId, reason, actor, occurredAt } = {},
) {
  const ownerId = normalizedId(accountId);
  const purgeReason = normalizedId(reason);
  const actorType = normalizedId(actor?.type);
  const actorId = normalizedId(actor?.id);
  const at = normalizedId(occurredAt);
  if (!ownerId) throw purgePolicyRequired("accountId");
  if (!purgeReason) throw purgePolicyRequired("reason");
  if (!actorType || !actorId) throw purgePolicyRequired("actor");
  if (!at || Number.isNaN(new Date(at).getTime())) {
    throw purgePolicyRequired("occurredAt");
  }
  if (!client || typeof client.query !== "function") {
    throw new TypeError("历史数据采集店铺清理需要 PostgreSQL 事务连接");
  }

  const savepoint = "legacy_data_store_account_purge";
  await client.query(`SAVEPOINT ${savepoint}`);
  try {
    const records = await readLegacyDataCollectionStoresForAudit(client, {
      accountId: ownerId,
    });
    const dataCollectionStoreIds = [...new Set(
      records.map((record) => normalizedId(record.id)).filter(Boolean),
    )];
    const verifications = await client.query(
      `DELETE FROM collection_store_verifications
       WHERE account_id=$1`,
      [ownerId],
    );
    const memberships = await client.query(
      `DELETE FROM account_data_collection_stores
       WHERE account_id=$1
       RETURNING data_collection_store_id`,
      [ownerId],
    );
    const orphanStores = await client.query(
      `DELETE FROM data_collection_stores
       WHERE id=ANY($1::text[])
         AND NOT EXISTS (
           SELECT 1 FROM account_data_collection_stores membership
           WHERE membership.data_collection_store_id=data_collection_stores.id
         )
       RETURNING id`,
      [dataCollectionStoreIds],
    );
    const result = {
      accountId: ownerId,
      legacyRecordCount: records.length,
      verificationDeletedCount: Number(verifications.rowCount || 0),
      membershipDeletedCount: Number(memberships.rowCount || 0),
      orphanStoreDeletedCount: Number(orphanStores.rowCount || 0),
      auditEventId: `legacy-data-store-purge:${ownerId}:${new Date(at).toISOString()}`,
    };
    await client.query(
      `INSERT INTO audit_events (
         event_id, account_id, action, status, actor_type, actor_id, source,
         entity_type, entity_id, correlation_id, metadata, occurred_at, created_at
       )
       VALUES (
         $1,$2,$3,$4,$5,$6,'formal-account-deletion',
         $7,$8,$1,$9::jsonb,$10,$10
       )
       ON CONFLICT (event_id) WHERE event_id IS NOT NULL DO NOTHING`,
      [
        result.auditEventId,
        ownerId,
        "LEGACY_DATA_COLLECTION_STORE_PURGED",
        "SUCCESS",
        actorType,
        actorId,
        "account",
        ownerId,
        JSON.stringify({
          reason: purgeReason,
          legacyRecordCount: result.legacyRecordCount,
          verificationDeletedCount: result.verificationDeletedCount,
          membershipDeletedCount: result.membershipDeletedCount,
          orphanStoreDeletedCount: result.orphanStoreDeletedCount,
        }),
        new Date(at).toISOString(),
      ],
    );
    await client.query(`RELEASE SAVEPOINT ${savepoint}`);
    return result;
  } catch (error) {
    await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    await client.query(`RELEASE SAVEPOINT ${savepoint}`);
    throw error;
  }
}
