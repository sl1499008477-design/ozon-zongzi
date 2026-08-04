import crypto from "node:crypto";

const HASH = /^[a-f0-9]{64}$/;
const SCOPE_KEYS = ["accountId", "jobId", "itemId", "planId"];
const TERMINAL = new Set(["ACCEPTED", "REJECTED", "FAILED"]);
const VERSION = "AUTO_LISTING_RICH_CONTENT_V1";
const clean = (value, maxLength = 240) => typeof value === "string" && value === value.trim() && value.length > 0
  && value.length <= maxLength && !/[\u0000-\u001f\u007f]/u.test(value);
const clone = (value) => structuredClone(value);
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" && !(value instanceof Date)
  ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
const same = (left, right) => JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
const scopeKey = (value) => SCOPE_KEYS.map((key) => value[key]).join("\u0001");

function attemptError(message = "富文本生成尝试无效") {
  const error = new Error(message);
  error.code = "AUTO_LISTING_RICH_CONTENT_ATTEMPT_INVALID";
  error.retryable = true;
  return error;
}

function repositoryError() {
  const error = new Error("富文本仓储暂时不可用");
  error.code = "AUTO_LISTING_RICH_CONTENT_REPOSITORY_FAILED";
  error.retryable = true;
  return error;
}

function validTimestamp(value) {
  return value instanceof Date || Number.isFinite(value)
    || (typeof value === "string" && Number.isFinite(Date.parse(value)));
}

function validModelEvidence(value, modelName) {
  return value && typeof value === "object" && !Array.isArray(value)
    && value.requestedTextModel === modelName && value.gatewayReportedTextModel === modelName
    && value.gatewayReportedTextModelPresent === true;
}

function validCheckerResult(value, assets) {
  return value && typeof value === "object" && !Array.isArray(value)
    && value.accepted === true && value.validator === VERSION
    && Array.isArray(value.sourceFactIds) && value.sourceFactIds.length > 0
    && Array.isArray(value.assetIds) && value.assetIds.length > 0
    && value.assetIds.every((assetId) => assets.some((asset) => asset.assetId === assetId));
}

function validAssetEvidence(value) {
  if (!Array.isArray(value) || value.length < 6 || value.length > 20) return false;
  const ids = new Set(); let main = 0;
  for (const asset of value) {
    if (!asset || typeof asset !== "object" || Array.isArray(asset) || !clean(asset.assetId)
      || ids.has(asset.assetId) || !clean(asset.role) || !HASH.test(asset.contentHash || "")
      || !clean(asset.objectKey, 2048) || !clean(asset.objectKeyVersion)) return false;
    ids.add(asset.assetId); if (asset.role === "MAIN") main += 1;
  }
  return main === 1;
}

function validateScope(input) {
  if (!input || !SCOPE_KEYS.every((key) => clean(input[key])) || !HASH.test(input.inputHash || "")) {
    throw attemptError();
  }
}

function validateReservation(input) {
  validateScope(input);
  for (const key of ["planHash", "sourceHash", "factRegistryHash", "assetHash", "promptHash"]) {
    if (!HASH.test(input[key] || "")) throw attemptError();
  }
  if (!clean(input.profileId) || !Number.isInteger(input.profileVersion) || input.profileVersion < 1
    || !clean(input.modelName) || !clean(input.promptTemplateVersion)
    || !Array.isArray(input.sourceFactEvidence) || input.sourceFactEvidence.length < 1
    || !validAssetEvidence(input.assetEvidence)
    || !input.requestEvidence || typeof input.requestEvidence !== "object" || Array.isArray(input.requestEvidence)
    || !clean(input.requestEvidence.requestKey) || input.requestEvidence.schemaVersion !== VERSION
    || !Number.isInteger(input.maxAttempts) || input.maxAttempts < 1 || input.maxAttempts > 3) {
    throw attemptError();
  }
}

function matchingScope(left, right) {
  return scopeKey(left) === scopeKey(right) && left.inputHash === right.inputHash;
}

function mapRow(row) {
  if (!row) return null;
  const mapped = {};
  for (const [key, value] of Object.entries(row)) {
    mapped[key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
  }
  return mapped;
}

function verifyTerminalEcho(record, input, status) {
  if (!record || record.status !== status || SCOPE_KEYS.some((key) => record[key] !== input[key])
    || record.inputHash !== input.inputHash || record.attemptNo !== input.attemptNo
    || !clean(record.id) || record.leaseOwner !== null || record.leaseToken !== null || record.leaseExpiresAt !== null) return false;
  for (const key of ["planHash", "sourceHash", "factRegistryHash", "assetHash", "promptHash",
    "profileId", "profileVersion", "modelName", "promptTemplateVersion"]) {
    if (record[key] !== input[key]) return false;
  }
  if (!["sourceFactEvidence", "assetEvidence", "requestEvidence"].every((key) => same(record[key], input[key]))) return false;
  return status === "ACCEPTED"
    ? validTimestamp(record.acceptedAt) && record.errorCode === null && record.errorRetryable === null
      && record.outputHash === input.outputHash && record.gatewayRequestId === input.gatewayRequestId
      && same(record.richContent, input.richContent) && same(record.checkerResult, input.checkerResult)
      && same(record.modelEvidence, input.modelEvidence)
    : record.acceptedAt == null && record.errorCode === input.errorCode && record.errorRetryable === input.errorRetryable;
}

/** In-memory reference implementation of the durable fenced attempt port. */
export function createMemoryRichContentRepository({
  now = () => Date.now(),
  leaseMs = 60_000,
  token = () => crypto.randomUUID(),
} = {}) {
  if (typeof now !== "function" || typeof token !== "function" || !Number.isInteger(leaseMs) || leaseMs < 1) {
    throw attemptError();
  }
  const rows = [];

  const owned = (input) => {
    validateScope(input);
    if (!Number.isInteger(input.attemptNo) || input.attemptNo < 1 || !clean(input.leaseToken)) throw attemptError();
    const row = rows.find((candidate) => matchingScope(candidate, input)
      && candidate.attemptNo === input.attemptNo);
    if (!row || row.status !== "GENERATING" || row.leaseToken !== input.leaseToken
      || row.leaseExpiresAt <= now()) throw attemptError();
    for (const key of ["planHash", "sourceHash", "factRegistryHash", "assetHash", "promptHash",
      "profileId", "profileVersion", "modelName", "promptTemplateVersion"]) {
      if (input[key] !== undefined && input[key] !== row[key]) throw attemptError();
    }
    for (const key of ["sourceFactEvidence", "assetEvidence", "requestEvidence"]) {
      if (input[key] !== undefined && !same(input[key], row[key])) throw attemptError();
    }
    return row;
  };

  const terminalize = (input, status) => {
    validateReservation(input);
    const row = owned(input);
    Object.assign(row, status === "ACCEPTED" ? clone({
      richContent: input.richContent,
      outputHash: input.outputHash,
      checkerResult: input.checkerResult,
      gatewayRequestId: input.gatewayRequestId,
      modelEvidence: input.modelEvidence,
      usage: input.usage ?? null,
    }) : clone({ errorCode: input.errorCode, errorRetryable: input.errorRetryable }), {
      status,
      leaseOwner: null,
      leaseToken: null,
      leaseExpiresAt: null,
      updatedAt: now(),
      ...(status === "ACCEPTED" ? { acceptedAt: now() } : {}),
    });
    return clone(row);
  };

  const repository = {
    async reserveRichContentAttempt(input) {
      validateReservation(input);
      const related = rows.filter((row) => matchingScope(row, input));
      const accepted = related.find((row) => row.status === "ACCEPTED");
      if (accepted) return { status: "EXISTING_ACCEPTED", record: clone(accepted) };
      const timestamp = now();
      const active = related.find((row) => row.status === "GENERATING" && row.leaseExpiresAt > timestamp);
      if (active) return { status: "IN_PROGRESS" };
      for (const row of related) {
        if (row.status === "GENERATING" && row.leaseExpiresAt <= timestamp) {
          Object.assign(row, {
            status: "FAILED", errorCode: "LEASE_EXPIRED", errorRetryable: true,
            leaseOwner: null, leaseToken: null, leaseExpiresAt: null, updatedAt: timestamp,
          });
        }
      }
      const attemptNo = related.reduce((highest, row) => Math.max(highest, row.attemptNo), 0) + 1;
      if (attemptNo > input.maxAttempts) return { status: "ATTEMPTS_EXHAUSTED" };
      const leaseToken = token();
      if (!clean(leaseToken)) throw attemptError();
      const leaseOwner = clean(input.leaseOwner) ? input.leaseOwner : "rich-content-generator";
      rows.push({
        id: crypto.randomUUID(), ...clone(input), attemptNo, status: "GENERATING",
        richContent: {}, outputHash: "", checkerResult: {}, gatewayRequestId: null,
        modelEvidence: null, errorCode: null, errorRetryable: null,
        leaseOwner, leaseToken, leaseExpiresAt: timestamp + leaseMs,
        createdAt: timestamp, updatedAt: timestamp, acceptedAt: null,
      });
      return { status: "RESERVED", attemptNo, leaseToken, inputHash: input.inputHash, promptHash: input.promptHash };
    },
    async completeRichContentAttempt(input) {
      if (!validCheckerResult(input?.checkerResult, input?.assetEvidence || [])
        || !validModelEvidence(input?.modelEvidence, input?.modelName) || !clean(input.gatewayRequestId)
        || !HASH.test(input.outputHash || "") || !input.richContent || typeof input.richContent !== "object") {
        throw attemptError();
      }
      const record = terminalize(input, "ACCEPTED");
      if (!verifyTerminalEcho(record, input, "ACCEPTED")) throw attemptError();
      return record;
    },
    async rejectRichContentAttempt(input) {
      if (!clean(input?.errorCode) || input.errorRetryable !== false) throw attemptError();
      return terminalize(input, "REJECTED");
    },
    async failRichContentAttempt(input) {
      if (!clean(input?.errorCode) || typeof input.errorRetryable !== "boolean") throw attemptError();
      return terminalize(input, "FAILED");
    },
    snapshot() { return clone(rows); },
  };
  repository.reserveRichContent = repository.reserveRichContentAttempt;
  repository.completeRichContent = repository.completeRichContentAttempt;
  repository.rejectRichContent = repository.rejectRichContentAttempt;
  repository.failRichContent = repository.failRichContentAttempt;
  return Object.freeze(repository);
}

/** PostgreSQL implementation; all transitions use the complete tenant/input/attempt/lease fence. */
export function createPostgresRichContentRepository({
  pool,
  leaseMs = 60_000,
  token = () => crypto.randomUUID(),
  id = () => crypto.randomUUID(),
  leaseOwner = "rich-content-generator",
} = {}) {
  if (!pool || typeof pool.query !== "function" || !Number.isInteger(leaseMs) || leaseMs < 1
    || typeof token !== "function" || typeof id !== "function" || !clean(leaseOwner)) throw attemptError();

  async function reserveRichContentAttempt(input) {
    validateReservation(input);
    const leaseToken = token();
    const rowId = id();
    if (![leaseToken, rowId].every((value) => clean(value))) throw attemptError();
    const values = SCOPE_KEYS.map((key) => input[key]);
    const client = typeof pool.connect === "function" ? await pool.connect() : pool;
    try {
      await client.query("BEGIN");
      const boundary = await client.query(
        `SELECT id FROM auto_listing_job_items
         WHERE account_id=$1 AND job_id=$2 AND id=$3 FOR UPDATE`,
        values.slice(0, 3),
      );
      if (boundary.rowCount !== 1) throw attemptError();
      await client.query(
        `UPDATE ai_rich_content_results
         SET status='FAILED',error_code='LEASE_EXPIRED',error_retryable=TRUE,
             lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=NOW()
         WHERE account_id=$1 AND job_id=$2 AND item_id=$3 AND plan_id=$4 AND input_hash=$5
           AND status='GENERATING' AND lease_expires_at <= NOW()`,
        [...values, input.inputHash],
      );
      const accepted = await client.query(
        `SELECT * FROM ai_rich_content_results
         WHERE account_id=$1 AND job_id=$2 AND item_id=$3 AND plan_id=$4 AND input_hash=$5 AND status='ACCEPTED'
         LIMIT 1 FOR SHARE`,
        [...values, input.inputHash],
      );
      if (accepted.rows[0]) {
        await client.query("COMMIT");
        return { status: "EXISTING_ACCEPTED", record: mapRow(accepted.rows[0]) };
      }
      const active = await client.query(
        `SELECT 1 FROM ai_rich_content_results
         WHERE account_id=$1 AND job_id=$2 AND item_id=$3 AND plan_id=$4 AND input_hash=$5
           AND status='GENERATING' AND lease_expires_at > NOW() LIMIT 1 FOR SHARE`,
        [...values, input.inputHash],
      );
      if (active.rows[0]) {
        await client.query("COMMIT");
        return { status: "IN_PROGRESS" };
      }
      const attempts = await client.query(
        `SELECT COALESCE(MAX(attempt_no),0)::INTEGER AS attempt_no FROM ai_rich_content_results
         WHERE account_id=$1 AND job_id=$2 AND item_id=$3 AND plan_id=$4 AND input_hash=$5`,
        [...values, input.inputHash],
      );
      const attemptNo = Number(attempts.rows[0]?.attempt_no || 0) + 1;
      if (attemptNo > input.maxAttempts) {
        await client.query("COMMIT");
        return { status: "ATTEMPTS_EXHAUSTED" };
      }
      await client.query(
        `INSERT INTO ai_rich_content_results (
           id,account_id,job_id,item_id,plan_id,profile_id,source_hash,asset_hash,input_hash,attempt_no,
           model_name,profile_version,prompt_template_version,rich_content,output_hash,checker_result,status,
           plan_hash,fact_registry_hash,prompt_hash,request_evidence,model_evidence,source_fact_evidence,
           asset_evidence,gateway_request_id,lease_owner,lease_token,lease_expires_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'{}'::JSONB,'','{}'::JSONB,'GENERATING',
           $14,$15,$16,$17::JSONB,NULL,$18::JSONB,$19::JSONB,NULL,$20,$21,NOW()+($22 * INTERVAL '1 millisecond'))`,
        [rowId, ...values, input.profileId, input.sourceHash, input.assetHash, input.inputHash, attemptNo,
          input.modelName, input.profileVersion, input.promptTemplateVersion, input.planHash,
          input.factRegistryHash, input.promptHash, JSON.stringify(input.requestEvidence),
          JSON.stringify(input.sourceFactEvidence), JSON.stringify(input.assetEvidence), leaseOwner, leaseToken, leaseMs],
      );
      await client.query("COMMIT");
      return { status: "RESERVED", attemptNo, leaseToken, inputHash: input.inputHash, promptHash: input.promptHash };
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch {}
      if (error?.code === "AUTO_LISTING_RICH_CONTENT_ATTEMPT_INVALID") throw error;
      throw repositoryError();
    } finally {
      if (client !== pool) client.release();
    }
  }

  async function transition(input, status) {
    validateReservation(input);
    if (!Number.isInteger(input.attemptNo) || input.attemptNo < 1 || !clean(input.leaseToken)) throw attemptError();
    const accepted = status === "ACCEPTED";
    if (accepted) {
      if (!validCheckerResult(input?.checkerResult, input?.assetEvidence || [])
        || !validModelEvidence(input?.modelEvidence, input?.modelName) || !clean(input.gatewayRequestId)
        || !HASH.test(input.outputHash || "") || !input.richContent || typeof input.richContent !== "object"
        || !input.modelEvidence || typeof input.modelEvidence !== "object") throw attemptError();
    } else if (!clean(input.errorCode) || typeof input.errorRetryable !== "boolean"
      || (status === "REJECTED" && input.errorRetryable !== false)) throw attemptError();
    let result;
    try {
      result = await pool.query(
      `UPDATE ai_rich_content_results SET
         status=$7,rich_content=$8::JSONB,output_hash=$9,checker_result=$10::JSONB,
         gateway_request_id=$11,model_evidence=$12::JSONB,error_code=$13,error_retryable=$14,
         lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=NOW(),accepted_at=$15
       WHERE account_id=$1 AND job_id=$2 AND item_id=$3 AND plan_id=$4 AND input_hash=$5
         AND attempt_no=$6 AND status='GENERATING' AND lease_token=$16 AND lease_expires_at > NOW()
         AND plan_hash=$17 AND source_hash=$18 AND fact_registry_hash=$19 AND asset_hash=$20 AND prompt_hash=$21
         AND profile_id=$22 AND profile_version=$23 AND model_name=$24 AND prompt_template_version=$25
         AND source_fact_evidence=$26::JSONB AND asset_evidence=$27::JSONB AND request_evidence=$28::JSONB
       RETURNING *`,
      [...SCOPE_KEYS.map((key) => input[key]), input.inputHash, input.attemptNo, status,
        JSON.stringify(accepted ? input.richContent : {}), accepted ? input.outputHash : "",
        JSON.stringify(accepted ? input.checkerResult : {}), accepted ? input.gatewayRequestId : null,
        accepted ? JSON.stringify(input.modelEvidence) : null, accepted ? null : input.errorCode,
        accepted ? null : input.errorRetryable, accepted ? new Date() : null, input.leaseToken,
        input.planHash, input.sourceHash, input.factRegistryHash, input.assetHash, input.promptHash,
        input.profileId, input.profileVersion, input.modelName, input.promptTemplateVersion,
        JSON.stringify(input.sourceFactEvidence), JSON.stringify(input.assetEvidence), JSON.stringify(input.requestEvidence)],
      );
    } catch {
      throw repositoryError();
    }
    if (result.rowCount !== 1) throw attemptError();
    const record = mapRow(result.rows[0]);
    if (!verifyTerminalEcho(record, input, status)) throw attemptError();
    return record;
  }

  const repository = {
    reserveRichContentAttempt,
    completeRichContentAttempt: (input) => transition(input, "ACCEPTED"),
    rejectRichContentAttempt: (input) => transition(input, "REJECTED"),
    failRichContentAttempt: (input) => transition(input, "FAILED"),
  };
  repository.reserveRichContent = repository.reserveRichContentAttempt;
  repository.completeRichContent = repository.completeRichContentAttempt;
  repository.rejectRichContent = repository.rejectRichContentAttempt;
  repository.failRichContent = repository.failRichContentAttempt;
  return Object.freeze(repository);
}

export const createPostgresRichContentAttemptRepository = createPostgresRichContentRepository;
