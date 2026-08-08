# Local sub2API and AI Model Configuration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy an isolated local sub2API stack and add an administrator-only Web workflow that securely stores a gateway credential, synchronizes available models, recommends and verifies text/image models, and publishes an immutable AI configuration for new auto-listing jobs.

**Architecture:** Run sub2API, PostgreSQL, and Redis in a pinned, loopback-only Compose project that never shares application data stores. Add a purpose-bound encrypted connection aggregate and durable model-catalog synchronization workflow behind stable admin contracts; reuse the existing sub2API adapter, capability test, profile publication, audit, and job configuration-fence mechanisms. Keep all browser traffic behind the `ozon 粽子` backend, and keep legacy environment-backed AI profiles readable during migration.

**Tech Stack:** Node.js ESM, React 19, Ant Design 6, PostgreSQL 16, Docker Compose, AES-256-GCM, native `fetch`, Node test runner, existing sub2API gateway adapter and auto-listing runtimes.

## Global Constraints

- Follow `/Users/songliang/Documents/sonli ozon3.0/AGENTS.md`: backend permission checks, tenant boundaries, traceability, idempotency, recoverability, stable contracts, additive migrations, tests, verification, and rollback evidence are mandatory.
- Pin local sub2API to `ghcr.io/wei-shaw/sub2api:0.1.132`; never use `latest` and never upgrade during a normal start.
- Bind local sub2API, PostgreSQL, and Redis ports to `127.0.0.1` only; default dashboard address is `http://127.0.0.1:8080/`.
- sub2API must use its own Compose project, network, PostgreSQL, Redis, credentials, and named volumes; it must not reuse the application's PostgreSQL, Redis, MinIO, or secrets.
- The Web service must never mount or control the Docker socket.
- Only actors with backend `AI_CONTENT_MANAGE` permission may read or mutate AI model settings.
- Raw gateway keys, ciphertext, IVs, authentication tags, authorization headers, upstream response bodies, and encryption master keys must never appear in DTOs, logs, audit metadata, test snapshots, or Git history.
- Local credential encryption uses a generated 32-byte master-key file under ignored `server-data/sub2api-local/`; production accepts an explicit server secret or secret-file path and has no plaintext or built-in fallback.
- A model synchronized from `/v1/models` is only a candidate. Publishing requires an explicit administrator-triggered structured-text test plus one minimum-cost, decodable image-generation test.
- Catalog synchronization must not invoke paid text or image generation.
- A failed daily synchronization does not invalidate the current configuration; a successful catalog that proves the active model is absent blocks only new auto-listing jobs.
- Existing jobs retain the profile/configuration version frozen at creation; configuration changes affect new jobs only.
- Preserve existing environment-backed AI profiles during the additive migration.
- Do not add behavior to `server/index.mjs`; compose new routes and workers through focused auto-listing runtime modules to preserve the 5,215-line migration guard.
- Real upstream AI calls are manual acceptance steps only and require a clear cost warning; automated tests use controlled fakes.

---

## File and Responsibility Map

### Local deployment

- `deploy/sub2api-local/docker-compose.yml`: pinned isolated sub2API/PostgreSQL/Redis services, health checks, loopback ports, and named volumes.
- `deploy/sub2api-local/.env.example`: non-secret local defaults and documented required bootstrap values.
- `scripts/sub2api-local.mjs`: bootstrap, start, stop, status, logs, credentials, and explicit upgrade command dispatcher.
- `server/tests/sub2api-local-deployment.test.mjs`: static Compose/script safety contract without starting Docker.

### Credential and persistence boundary

- `server/auto-listing-ai-credential-crypto.mjs`: purpose-bound AES-256-GCM encryption/decryption and keyed fingerprinting.
- `server/auto-listing-ai-credential-config.mjs`: fail-closed master-key/key-file configuration.
- `server/db/migrations/053_auto_listing_ai_model_configuration.sql`: immutable connection versions, model catalogs, sync tasks/events, profile connection reference, indexes, tenant FKs, and triggers.
- `server/auto-listing-ai-settings-postgres.mjs`: tenant-scoped transactions, immutable connection persistence, catalog/task leases, idempotent commands, and audit writes.

### Gateway, synchronization, and recommendation

- `server/ai-model-catalog-port.mjs`: closed `listModels` port contract.
- `server/auto-listing-ai-credential-resolver.mjs`: resolves/decrypts one exact account/connection/version reference.
- `server/sub2api-ai-adapter.mjs`: adds bounded model discovery and asynchronous secret resolution while preserving legacy environment profiles.
- `server/auto-listing-ai-model-recommendation.mjs`: pure, explainable text/image candidate scoring.
- `server/auto-listing-ai-model-sync-service.mjs`: no-cost catalog fetch, normalization, hashing, recommendation, and durable outcome application.
- `server/auto-listing-ai-model-sync-worker.mjs`: account paging, task leasing, retry/backoff, stale-lease recovery, and daily scheduling.

### Admin use case and composition

- `server/auto-listing-ai-settings-service.mjs`: overview, connection replacement, manual sync, selection, capability test delegation, publication, and safe rollback commands.
- `server/auto-listing-ai-settings-routes.mjs`: stable `/admin/auto-listing/ai-settings` HTTP contract and safe error allowlist.
- `server/auto-listing-ai-settings-runtime.mjs`: pool, cipher, resolver, gateway, repository, service, and worker lifecycle composition.
- `server/auto-listing-web-runtime.mjs`: mounts the settings handler and starts/stops the sync worker without touching `server/index.mjs`.
- Existing profile/context/runtime files listed in Task 7: carry immutable connection references through capability tests and AI workers.

### Frontend

- `app/src/auto-listing-ai-settings-client.js`: request builders, idempotency intent reuse, polling, and abort handling.
- `app/src/auto-listing-ai-settings-view.js`: pure state/label/action projection that fails closed.
- `app/src/AiModelSettingsPage.jsx`: administrator settings UI.
- `app/src/auto-listing-ai-settings.css`: page-scoped styling.
- `app/src/AutoListingPage.jsx`: administrator-only entry button.
- `app/src/App.jsx`: route title/import/render only.

---

### Task 1: Isolated local sub2API deployment

**Files:**
- Create: `deploy/sub2api-local/docker-compose.yml`
- Create: `deploy/sub2api-local/.env.example`
- Create: `scripts/sub2api-local.mjs`
- Create: `server/tests/sub2api-local-deployment.test.mjs`
- Modify: `package.json` scripts
- Modify: `.gitignore`

**Interfaces:**
- Consumes: Docker Compose v2 and writable ignored `server-data/sub2api-local/`.
- Produces: commands `pnpm sub2api:bootstrap|up|down|status|logs|credentials|upgrade`, dashboard `http://127.0.0.1:8080/`, and master-key file `server-data/sub2api-local/credential-master.key` with mode `0600`.

- [ ] **Step 1: Write the failing deployment contract test**

```js
// server/tests/sub2api-local-deployment.test.mjs
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("local sub2api compose is pinned, isolated, loopback-only, and persistent", async () => {
  const compose = await readFile(new URL("../../deploy/sub2api-local/docker-compose.yml", import.meta.url), "utf8");
  assert.match(compose, /ghcr\.io\/wei-shaw\/sub2api:0\.1\.132/);
  assert.doesNotMatch(compose, /:latest\b/);
  assert.match(compose, /127\.0\.0\.1:\$\{SUB2API_PORT:-8080\}:8080/);
  assert.match(compose, /sonli_sub2api_postgres_data/);
  assert.match(compose, /sonli_sub2api_redis_data/);
  assert.doesNotMatch(compose, /sonli_postgres_data|sonli_queue|MINIO_/);
  assert.doesNotMatch(compose, /docker\.sock/);
});
```

- [ ] **Step 2: Run the test and verify the deployment files are missing**

Run: `node --test server/tests/sub2api-local-deployment.test.mjs`

Expected: FAIL with `ENOENT` for `deploy/sub2api-local/docker-compose.yml`.

- [ ] **Step 3: Implement the pinned Compose stack and bootstrap command**

Use three services named `sub2api`, `sub2api-postgres`, and `sub2api-redis`. Give each a health check; bind all published ports to loopback; use the Compose project name `sonli-sub2api-local`; keep admin password, PostgreSQL password, JWT secret, TOTP key, and application credential master key in ignored files generated with `crypto.randomBytes`.

Export pure helpers so the script can be tested without spawning Docker:

```js
export const SUB2API_IMAGE = "ghcr.io/wei-shaw/sub2api:0.1.132";
export function composeInvocation(action, rootDir) {
  const file = path.join(rootDir, "deploy/sub2api-local/docker-compose.yml");
  const envFile = path.join(rootDir, "server-data/sub2api-local/.env");
  return ["compose", "--project-name", "sonli-sub2api-local", "--env-file", envFile, "-f", file, ...action];
}
```

`bootstrap` must create files with exclusive creation and mode `0600`, never overwrite an existing secret, and print only paths plus the dashboard URL. It must atomically add these owned local settings to `.env` when they are absent, but fail with a clear conflict message instead of replacing a different existing value:

```env
AUTO_LISTING_ENABLED=true
AUTO_LISTING_AI_ENABLED=true
AUTO_LISTING_AI_ALLOW_LOCAL_GATEWAY=true
AUTO_LISTING_AI_ALLOWED_GATEWAY_BASE_URLS=http://127.0.0.1:8080/v1
AUTO_LISTING_AI_ALLOWED_GATEWAY_ORIGINS=http://127.0.0.1:8080
AUTO_LISTING_CREDENTIAL_MASTER_KEY_FILE=server-data/sub2api-local/credential-master.key
AUTO_LISTING_CREDENTIAL_KEY_VERSION=local-v1
```

Write `.env` through a same-directory temporary file plus atomic rename, preserve unrelated lines/comments, set mode `0600`, and create a timestamped ignored backup before the first change. `credentials` is the only command allowed to deliberately print the local admin email/password to the invoking terminal; it must not write them to application logs.

- [ ] **Step 4: Add package commands and ignored secret paths**

```json
{
  "sub2api:bootstrap": "node scripts/sub2api-local.mjs bootstrap",
  "sub2api:up": "node scripts/sub2api-local.mjs up",
  "sub2api:down": "node scripts/sub2api-local.mjs down",
  "sub2api:status": "node scripts/sub2api-local.mjs status",
  "sub2api:logs": "node scripts/sub2api-local.mjs logs",
  "sub2api:credentials": "node scripts/sub2api-local.mjs credentials",
  "sub2api:upgrade": "node scripts/sub2api-local.mjs upgrade"
}
```

Keep the generated directory under the already ignored `server-data/`; add an explicit `deploy/sub2api-local/.env` ignore entry to prevent accidental local copies.

- [ ] **Step 5: Verify static safety and script argument generation**

Run: `node --test server/tests/sub2api-local-deployment.test.mjs`

Expected: PASS; tests prove the image is pinned, ports are loopback-only, volumes are independent, secrets are mode `0600`, normal start does not run `pull`, and only `upgrade` can pull the pinned image.

- [ ] **Step 6: Commit the deployment unit**

```bash
git add .gitignore package.json deploy/sub2api-local scripts/sub2api-local.mjs server/tests/sub2api-local-deployment.test.mjs
git commit -m "feat(auto-listing): add isolated local sub2api runtime"
```

---

### Task 2: Purpose-bound gateway credential encryption

**Files:**
- Create: `server/auto-listing-ai-credential-config.mjs`
- Create: `server/auto-listing-ai-credential-crypto.mjs`
- Create: `server/tests/auto-listing-ai-credential-config.test.mjs`
- Create: `server/tests/auto-listing-ai-credential-crypto.test.mjs`
- Modify: `.env.example`
- Modify: `docker-compose.yml` application environment
- Modify: `server/tests/infrastructure-config.test.mjs`

**Interfaces:**
- Consumes: either `AUTO_LISTING_CREDENTIAL_MASTER_KEY` as base64url-encoded 32 bytes or `AUTO_LISTING_CREDENTIAL_MASTER_KEY_FILE`; exactly one source is active.
- Produces: `loadAutoListingCredentialKey({env, open})` and `createAutoListingCredentialCipher({key, keyVersion})` with `encrypt(scope, plaintext)`, `decrypt(scope, payload)`, and `fingerprint(plaintext)`. `open` is the sole injectable descriptor-safe file port; it must return a descriptor with `stat`, `readFile`, and `close`. The loader opens with `O_NOFOLLOW`, validates the opened descriptor, and has no `readFile`/`stat` path fallback.

- [ ] **Step 1: Write failing crypto and configuration tests**

```js
test("cipher binds ciphertext to account, connection, connection version, and key version", () => {
  const cipher = createAutoListingCredentialCipher({ key: Buffer.alloc(32, 7), keyVersion: "local-v1" });
  const scope = { accountId: "account-a", connectionId: "connection-a", connectionVersion: 1 };
  const encrypted = cipher.encrypt(scope, "sk-gateway-secret");
  assert.equal(cipher.decrypt(scope, encrypted), "sk-gateway-secret");
  assert.throws(() => cipher.decrypt({ ...scope, accountId: "account-b" }, encrypted),
    (error) => error?.code === "AUTO_LISTING_AI_CREDENTIAL_DECRYPT_FAILED");
  assert.doesNotMatch(JSON.stringify(encrypted), /sk-gateway-secret/);
});
```

Add configuration tests that reject missing keys, short/invalid base64url, both env and file sources, symlinks, non-regular files, and file modes readable by group/others. In non-production local development, the configured file path may be the bootstrap-owned `server-data/sub2api-local/credential-master.key`; production must explicitly set an environment value or mounted secret-file path.

- [ ] **Step 2: Run the tests and verify missing-module failures**

Run: `node --test server/tests/auto-listing-ai-credential-config.test.mjs server/tests/auto-listing-ai-credential-crypto.test.mjs`

Expected: FAIL because both modules do not exist.

- [ ] **Step 3: Implement fail-closed key loading and AES-256-GCM**

Use canonical additional authenticated data:

```js
const aad = Buffer.from(JSON.stringify({
  purpose: "AUTO_LISTING_SUB2API_GATEWAY_KEY_V1",
  accountId: scope.accountId,
  connectionId: scope.connectionId,
  connectionVersion: scope.connectionVersion,
  keyVersion: normalizedKeyVersion,
}), "utf8");
```

Use a random 12-byte IV, `cipher.setAAD(aad)`, `aes-256-gcm`, and a keyed HMAC-SHA256 fingerprint truncated to 16 bytes for display-safe rotation comparison. Throw stable codes; never include crypto error text or input values. Do not reuse `crypto-secrets.mjs` because its development fallback and lack of purpose-bound AAD violate this contract.

- [ ] **Step 4: Add deployment configuration**

```env
# Exactly one credential master-key source. Local bootstrap creates the file under ignored server-data.
AUTO_LISTING_CREDENTIAL_MASTER_KEY=
AUTO_LISTING_CREDENTIAL_MASTER_KEY_FILE=server-data/sub2api-local/credential-master.key
AUTO_LISTING_CREDENTIAL_KEY_VERSION=local-v1
```

Pass the same variables into `api`, `worker`, and `auto-listing-ai-worker` containers. The infrastructure test must require a non-empty source whenever `AUTO_LISTING_ENABLED=true`.

- [ ] **Step 5: Run focused and infrastructure tests**

Run: `node --test server/tests/auto-listing-ai-credential-config.test.mjs server/tests/auto-listing-ai-credential-crypto.test.mjs server/tests/infrastructure-config.test.mjs`

Expected: PASS with no fallback key and no secret in serialized failures.

- [ ] **Step 6: Commit the crypto boundary**

```bash
git add .env.example docker-compose.yml server/auto-listing-ai-credential-config.mjs server/auto-listing-ai-credential-crypto.mjs server/tests/auto-listing-ai-credential-*.test.mjs server/tests/infrastructure-config.test.mjs
git commit -m "feat(auto-listing): add encrypted gateway credential boundary"
```

---

### Task 3: Additive database schema and tenant-scoped settings repository

**Files:**
- Create: `server/db/migrations/053_auto_listing_ai_model_configuration.sql`
- Create: `server/auto-listing-ai-settings-postgres.mjs`
- Create: `server/tests/auto-listing-ai-settings-migration.test.mjs`
- Create: `server/tests/auto-listing-ai-settings-postgres.test.mjs`
- Create: `server/tests/auto-listing-ai-settings-postgres.integration.test.mjs`

**Interfaces:**
- Consumes: cipher payloads from Task 2; raw secrets never reach the repository.
- Produces: `createAutoListingAiSettingsPostgres({pool})` with immutable connection, catalog, sync-task, overview, and profile-binding transactions.

- [ ] **Step 1: Write the migration contract test before the SQL exists**

Assert migration `053` creates:

```text
ai_gateway_connection_versions
ai_gateway_model_catalogs
ai_gateway_model_sync_tasks
ai_gateway_model_sync_events
```

and adds nullable `connection_id` plus `connection_version` to `ai_gateway_profiles`. Assert composite tenant FKs, append-only triggers, one active connection per account, one runnable sync per connection version, catalog JSON object/size guards, and preservation of legacy rows whose connection reference is null.

- [ ] **Step 2: Run migration contract test and verify RED**

Run: `node --test server/tests/auto-listing-ai-settings-migration.test.mjs`

Expected: FAIL because migration `053` does not exist.

- [ ] **Step 3: Implement migration 053**

Use connection versions whose identity, base URL, ciphertext, and encryption metadata are immutable. Status transitions are `PENDING → VALIDATED → ACTIVE → RETIRED`; an explicit rollback capability test may move `RETIRED → VALIDATED`, after which publication may activate it again. Reject all other transitions and audit every accepted transition. Store `ciphertext`, `iv`, `auth_tag`, `algorithm`, `key_version`, and `fingerprint`, but never raw keys. Use sync task statuses `PENDING`, `LEASED`, `SUCCEEDED`, `FAILED`, `DEAD`, with bounded attempts, lease token/version/expiry, and deterministic request hashes.

For UI-created profiles, keep legacy `api_key_env_name` populated with the non-secret sentinel `SUB2API_ENCRYPTED_KEY` and require a matching `(account_id, connection_id, connection_version)` FK. Existing environment profiles keep a null connection reference and their original environment name.

- [ ] **Step 4: Write repository RED tests for exact contracts**

```js
const connection = await repository.createPendingConnection({
  accountId: "account-a",
  actorId: "account-a",
  idempotencyKey: "connection-intent-a",
  correlationId: "corr-a",
  displayName: "本地 sub2API",
  baseUrl: "http://127.0.0.1:8080/v1",
  encryptedSecret: { algorithm: "aes-256-gcm", ciphertext: "cipher", iv: "iv", authTag: "tag", keyVersion: "local-v1", fingerprint: "fp" },
});
assert.equal(connection.accountId, "account-a");
assert.equal(Object.hasOwn(connection, "ciphertext"), false);
```

Cover same-key replay, different-payload conflict, cross-account reads, concurrent activation, stale lease takeover, append-only events, and immutable ciphertext/profile binding.

- [ ] **Step 5: Implement repository transactions**

Expose these exact methods:

```js
createPendingConnection(input)
loadConnectionForSecretResolution({ accountId, connectionId, connectionVersion })
markConnectionValidated(input)
loadSettingsOverview({ accountId })
enqueueModelSync(input)
listRunnableSyncAccountIds({ afterAccountId, limit })
claimModelSync({ accountId, workerId, leaseMs })
completeModelSync(input)
failModelSync(input)
createProfileFromSelection(input)
```

Every mutation locks the account row, verifies expected versions, writes an `audit_events` record plus a domain event in the same transaction, and returns DTO-safe fields only.

- [ ] **Step 6: Run unit and disposable PostgreSQL integration tests**

Run: `node --test server/tests/auto-listing-ai-settings-migration.test.mjs server/tests/auto-listing-ai-settings-postgres.test.mjs server/tests/auto-listing-ai-settings-postgres.integration.test.mjs`

Expected: PASS, including migrations `001` through `053`, existing legacy AI profile preservation, cross-tenant FK rejection, concurrent activation serialization, task lease expiry recovery, and immutable audit/event rows.

- [ ] **Step 7: Commit schema and repository**

```bash
git add server/db/migrations/053_auto_listing_ai_model_configuration.sql server/auto-listing-ai-settings-postgres.mjs server/tests/auto-listing-ai-settings-*.test.mjs
git commit -m "feat(auto-listing): persist AI gateway connections and model catalogs"
```

---

### Task 4: Asynchronous secret resolution and bounded sub2API model discovery

**Files:**
- Create: `server/ai-model-catalog-port.mjs`
- Create: `server/auto-listing-ai-credential-resolver.mjs`
- Create: `server/tests/ai-model-catalog-port.test.mjs`
- Create: `server/tests/auto-listing-ai-credential-resolver.test.mjs`
- Modify: `server/sub2api-ai-adapter.mjs`
- Modify: `server/tests/sub2api-ai-adapter.test.mjs`
- Modify: `server/ai-gateway-port.mjs` only to compose the catalog port without changing existing method semantics

**Interfaces:**
- Consumes: `repository.loadConnectionForSecretResolution` and Task 2 cipher.
- Produces: async `resolveSecret(scope)` and `gateway.listModels({connection, correlationId, requestKey, timeoutMs, signal})` returning a bounded normalized catalog.

- [ ] **Step 1: Write RED tests for tenant-bound decryption and model response limits**

```js
test("resolver decrypts only the exact connection scope", async () => {
  const resolver = createAutoListingAiCredentialResolver({ repository, cipher });
  assert.equal(await resolver.resolveSecret({
    accountId: "account-a", connectionId: "connection-a", connectionVersion: 1,
  }), "sk-local-gateway");
  await assert.rejects(() => resolver.resolveSecret({
    accountId: "account-b", connectionId: "connection-a", connectionVersion: 1,
  }), (error) => error?.code === "AI_GATEWAY_SECRET_MISSING");
});
```

Adapter tests must reject redirects, private/public DNS boundary changes, more than 2 MiB JSON, more than 2,000 models, duplicate/conflicting model IDs, accessor/proxy payloads, invalid identifiers, and unknown response shapes.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `node --test server/tests/ai-model-catalog-port.test.mjs server/tests/auto-listing-ai-credential-resolver.test.mjs server/tests/sub2api-ai-adapter.test.mjs`

Expected: FAIL because catalog and resolver operations do not exist.

- [ ] **Step 3: Implement the catalog port and async resolver**

```js
export function createAiModelCatalogPort({ listModels } = {}) {
  if (typeof listModels !== "function") throw new TypeError("AI model catalog operation is required");
  return Object.freeze({ listModels });
}
```

The resolver loads one exact account/connection/version, rebuilds the AAD scope, decrypts, trims, and returns the secret only in memory. Map all repository/decrypt failures to stable safe codes without logging values.

- [ ] **Step 4: Extend the sub2API adapter without breaking legacy profiles**

Add optional `resolveSecret`. In authorized calls, prefer a connection reference and `await resolveSecret(scope)`; otherwise retain the current allowlisted environment `readSecret(apiKeyEnvName)` path. A UI-managed profile is valid only when `apiKeyEnvName === "SUB2API_ENCRYPTED_KEY"` and its connection ID/version are present. The encrypted credential reference replaces only the environment-name allowlist; the base URL must still match `AUTO_LISTING_AI_ALLOWED_GATEWAY_BASE_URLS` or `AUTO_LISTING_AI_ALLOWED_GATEWAY_ORIGINS`, and it must pass the existing DNS, redirect, path-prefix, protocol, and local-gateway policy on every authorized request.

`listModels` calls the exact normalized `<baseUrl>/models` path, uses the existing DNS/redirect/timeout boundary, and returns:

```js
{
  requestId: "safe-request-id-or-empty",
  models: [{ id: "model-id", ownedBy: "provider-or-empty", metadata: {} }],
}
```

Metadata must be a closed, size-bounded subset; never return unknown nested upstream data.

- [ ] **Step 5: Run adapter, capability, and external-write safety regressions**

Run: `node --test server/tests/sub2api-ai-adapter.test.mjs server/tests/ai-gateway-profile-service.test.mjs server/tests/external-write-safety.test.mjs server/tests/ai-model-catalog-port.test.mjs server/tests/auto-listing-ai-credential-resolver.test.mjs`

Expected: PASS; legacy env profiles still work, encrypted profiles resolve asynchronously, and no raw key appears in logs/errors.

- [ ] **Step 6: Commit the gateway boundary**

```bash
git add server/ai-gateway-port.mjs server/ai-model-catalog-port.mjs server/auto-listing-ai-credential-resolver.mjs server/sub2api-ai-adapter.mjs server/tests/ai-model-catalog-port.test.mjs server/tests/auto-listing-ai-credential-resolver.test.mjs server/tests/sub2api-ai-adapter.test.mjs
git commit -m "feat(auto-listing): discover sub2api models with encrypted credentials"
```

---

### Task 5: Explainable, non-billing model recommendation

**Files:**
- Create: `server/auto-listing-ai-model-recommendation.mjs`
- Create: `server/tests/auto-listing-ai-model-recommendation.test.mjs`

**Interfaces:**
- Consumes: normalized catalog `{models:[{id,ownedBy,metadata}]}`.
- Produces: `recommendAutoListingModels(catalog)` returning ranked text/image candidates and stable reason codes; performs no I/O.

- [ ] **Step 1: Write failing deterministic recommendation tests**

```js
test("declared capabilities outrank name hints and remain unverified", () => {
  const result = recommendAutoListingModels({ models: [
    { id: "generic-a", ownedBy: "gateway", metadata: { capabilities: ["structured_text"] } },
    { id: "image-looking-name", ownedBy: "gateway", metadata: {} },
    { id: "generic-b", ownedBy: "gateway", metadata: { capabilities: ["image_generation", "image_edit"] } },
  ] });
  assert.equal(result.textCandidates[0].modelId, "generic-a");
  assert.equal(result.imageCandidates[0].modelId, "generic-b");
  assert.equal(result.verified, false);
  assert.deepEqual(result.imageCandidates[0].reasonCodes,
    ["DECLARED_IMAGE_GENERATION", "DECLARED_REFERENCE_IMAGE"]);
});
```

Cover deterministic tie-breaking by model ID, explicit incompatibility disqualification, name-hint-only low confidence, no candidate, duplicate catalog rejection, maximum candidate count, and no mutation of inputs.

- [ ] **Step 2: Run the test and verify RED**

Run: `node --test server/tests/auto-listing-ai-model-recommendation.test.mjs`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement a pure scoring table**

Use stable reason codes and weights:

```js
const WEIGHTS = Object.freeze({
  DECLARED_STRUCTURED_TEXT: 100,
  DECLARED_RESPONSES_PROTOCOL: 60,
  DECLARED_IMAGE_GENERATION: 100,
  DECLARED_REFERENCE_IMAGE: 40,
  DECLARED_TARGET_RESOLUTION: 20,
  MODEL_ID_TEXT_HINT: 10,
  MODEL_ID_IMAGE_HINT: 10,
});
```

Explicit metadata incompatibility disqualifies a model. Name hints only rank otherwise unknown candidates; they never set `verified=true`. Limit each returned candidate list to 50 and include human-display reason labels in the later view layer, not this business module.

- [ ] **Step 4: Run recommendation and mutation-safety tests**

Run: `node --test server/tests/auto-listing-ai-model-recommendation.test.mjs`

Expected: PASS with deterministic output hashes for identical catalogs.

- [ ] **Step 5: Commit the recommendation unit**

```bash
git add server/auto-listing-ai-model-recommendation.mjs server/tests/auto-listing-ai-model-recommendation.test.mjs
git commit -m "feat(auto-listing): recommend text and image model candidates"
```

---

### Task 6: Durable model synchronization and daily worker

**Files:**
- Create: `server/auto-listing-ai-model-sync-service.mjs`
- Create: `server/auto-listing-ai-model-sync-worker.mjs`
- Create: `server/tests/auto-listing-ai-model-sync-service.test.mjs`
- Create: `server/tests/auto-listing-ai-model-sync-worker.test.mjs`
- Modify: `server/tests/auto-listing-ai-settings-postgres.integration.test.mjs`

**Interfaces:**
- Consumes: Task 3 repository, Task 4 `gateway.listModels`, Task 5 recommendation.
- Produces: `syncModelCatalog(command)` plus worker `{start(), stop(), runOnce()}`; no capability or image-generation call is permitted.

- [ ] **Step 1: Write RED service tests proving synchronization has no paid operations**

```js
const gateway = {
  async listModels() { return { requestId: "models-1", models: [{ id: "text-a", ownedBy: "x", metadata: {} }] }; },
  async createTextResponse() { throw new Error("paid text call forbidden"); },
  async generateImage() { throw new Error("paid image call forbidden"); },
};
const result = await service.syncModelCatalog(command);
assert.equal(result.status, "SUCCEEDED");
assert.equal(result.modelCount, 1);
```

Cover catalog hashing, same-task replay, stale connection version, successful empty catalog, timeout retry, non-retryable auth failure, response loss after commit, and active-model absence only after a successful catalog.

- [ ] **Step 2: Write RED worker lease and scheduling tests**

Test account paging, strict cursor progress, one task per active connection per 24 hours, manual task precedence, expired lease takeover, exponential backoff, maximum attempts to `DEAD`, graceful stop, and no auto-resurrection of `DEAD` tasks.

- [ ] **Step 3: Run service/worker tests and verify RED**

Run: `node --test server/tests/auto-listing-ai-model-sync-service.test.mjs server/tests/auto-listing-ai-model-sync-worker.test.mjs`

Expected: FAIL because service and worker modules do not exist.

- [ ] **Step 4: Implement synchronization outcome hashing**

Normalize and sort models by ID before hashing. Persist the catalog, recommendations, request ID hash, connection version, and sync timestamp in one transaction. Never persist authorization headers or arbitrary upstream response bodies.

Return a safe DTO:

```js
{
  taskId,
  status: "SUCCEEDED",
  modelCount,
  catalogId,
  syncedAt,
  activeSelectionState: "AVAILABLE" | "MISSING" | "NOT_SELECTED",
}
```

- [ ] **Step 5: Implement the worker lifecycle**

Use PostgreSQL time for leases, `SKIP LOCKED`, bounded concurrency `2`, lease `120 seconds`, attempts `5`, and delays `5s, 15s, 45s, 135s`. Schedule daily work only for active connection versions whose last successful sync is at least 24 hours old. Manual enqueue uses an idempotency key supplied by the browser intent.

- [ ] **Step 6: Run unit and real PostgreSQL recovery tests**

Run: `node --test server/tests/auto-listing-ai-model-sync-service.test.mjs server/tests/auto-listing-ai-model-sync-worker.test.mjs server/tests/auto-listing-ai-settings-postgres.integration.test.mjs`

Expected: PASS, including concurrent claims, expired lease recovery, committed-response replay, daily de-duplication, and active-model missing state.

- [ ] **Step 7: Commit synchronization**

```bash
git add server/auto-listing-ai-model-sync-service.mjs server/auto-listing-ai-model-sync-worker.mjs server/tests/auto-listing-ai-model-sync-*.test.mjs server/tests/auto-listing-ai-settings-postgres.integration.test.mjs
git commit -m "feat(auto-listing): synchronize sub2api model catalogs durably"
```

---

### Task 7: Administrator settings use case, profile binding, and runtime composition

**Files:**
- Create: `server/auto-listing-ai-settings-service.mjs`
- Create: `server/auto-listing-ai-settings-routes.mjs`
- Create: `server/auto-listing-ai-settings-runtime.mjs`
- Create: `server/tests/auto-listing-ai-settings-service.test.mjs`
- Create: `server/tests/auto-listing-ai-settings-routes.test.mjs`
- Create: `server/tests/auto-listing-ai-settings-runtime.test.mjs`
- Modify: `server/auto-listing-ai-admin-postgres.mjs`
- Modify: `server/auto-listing-ai-admin-service.mjs`
- Modify: `server/ai-gateway-profile-service.mjs`
- Modify: `server/auto-listing-ai-phase-context-postgres.mjs`
- Modify: `server/auto-listing-ai-runtime-composition.mjs`
- Modify: `server/auto-listing-web-runtime.mjs`
- Modify: `server/auto-listing-repository.mjs`
- Modify: `server/tests/auto-listing-repository.test.mjs`
- Modify: corresponding existing tests for every modified module

**Interfaces:**
- Consumes: Tasks 2-6; existing `createAiGatewayProfileService`, profile capability attempts, profile publication, `AI_CONTENT_MANAGE`, and job profile-version fences.
- Produces: admin settings HTTP API, UI-managed profile creation with immutable connection reference, and worker/admin/runtime secret resolution.

- [ ] **Step 1: Write the closed settings service contract tests**

Define exact use cases:

```js
getOverview({ actor })
createConnection({ actor, idempotencyKey, correlationId, displayName, baseUrl, gatewayKey })
requestModelSync({ actor, connectionId, connectionVersion, idempotencyKey, correlationId })
createProfileSelection({ actor, connectionId, connectionVersion, catalogId, displayName, textModel, imageModel, textProtocol, imageProtocol, idempotencyKey, correlationId })
testProfile({ actor, profileId, configVersion, correlationId })
publishProfile({ actor, profileId, configVersion, idempotencyKey, correlationId })
rollbackProfile({ actor, profileId, configVersion, idempotencyKey, correlationId })
```

Tests must prove ordinary users are rejected before repository/decryption/network work; raw `gatewayKey` is encrypted before persistence and absent from outputs; selected models belong to the exact catalog; untested/stale/failed profiles cannot publish; rollback re-runs capability checks; and repeated commands replay safely.

- [ ] **Step 2: Write HTTP route RED tests**

Use these routes:

```text
GET  /admin/auto-listing/ai-settings
POST /admin/auto-listing/ai-settings/connections
POST /admin/auto-listing/ai-settings/connections/:id/sync
POST /admin/auto-listing/ai-settings/profiles
POST /admin/auto-listing/ai-settings/profiles/:id/test
POST /admin/auto-listing/ai-settings/profiles/:id/publish
POST /admin/auto-listing/ai-settings/profiles/:id/rollback
```

Require closed JSON bodies, maximum 64 KiB, fixed safe-code allowlists, method rejection, authentication, backend permission checks, proxy/accessor rejection, and no raw secrets in any response.

- [ ] **Step 3: Run service/routes tests and verify RED**

Run: `node --test server/tests/auto-listing-ai-settings-service.test.mjs server/tests/auto-listing-ai-settings-routes.test.mjs`

Expected: FAIL because settings service and routes do not exist.

- [ ] **Step 4: Implement the service using existing profile capability/publication logic**

Do not duplicate capability validation. Extend profile persistence and normalization with nullable `connectionId`/`connectionVersion`. UI-managed profile creation sets `apiKeyEnvName: "SUB2API_ENCRYPTED_KEY"`; legacy profile creation keeps its environment reference. Before capability testing or publishing, require the exact connection version to be `VALIDATED`, the selected catalog to match it, and selected model IDs to exist in that catalog.

When a capability test completes with `PASSED`, mark its exact connection version `VALIDATED` in the same account-locked transaction. On profile publication, activate that connection version and retire the prior active connection in the same transaction. Do not revoke the old Key in sub2API.

- [ ] **Step 5: Carry connection evidence into admin and worker gateway calls**

Update every profile SELECT/DTO/context path to include `connection_id` and `connection_version`. In `auto-listing-ai-runtime-composition.mjs`, parse `AUTO_LISTING_AI_ALLOW_LOCAL_GATEWAY` with the same production prohibition used by the admin runtime, pass it into `createSub2ApiGatewayPolicy` and `createSub2ApiAdapter`, then build the cipher and `createAutoListingAiCredentialResolver({repository,cipher})` after obtaining the pool. Pass async `resolveSecret` to the adapter and preserve the legacy allowlisted environment reader for profiles without a connection reference. Add a local-loopback worker regression so a profile that passes admin testing cannot later fail only because the worker forgot the local-gateway flag.

Add an explicit regression asserting an existing job created with profile A/config version 1 still resolves profile A's connection version after profile B is published.

Update `auto-listing-repository.mjs` so new job creation accepts a legacy enabled profile unchanged, but for a connection-backed profile it also requires the latest successful catalog for that exact connection version to contain both selected model IDs. If a successful sync proves either model absent, return `AUTO_LISTING_AI_ACTIVE_MODEL_UNAVAILABLE` and create no job/outbox rows. A failed sync must not replace the latest successful catalog or block job creation by itself.

- [ ] **Step 6: Compose routes and worker lifecycle outside server/index.mjs**

`createAutoListingAiSettingsRuntime` returns:

```js
Object.freeze({ getService, startWorker, stopWorker })
```

Mount its handler in `createAutoListingWebRuntime`, and start/stop the model-sync worker with the existing user/upload/reconciliation worker lifecycle. If settings worker startup fails, unwind already-started components in reverse order. With feature flags off, do not connect to PostgreSQL, decrypt secrets, or call sub2API.

- [ ] **Step 7: Run focused runtime, capability, context, wiring, and module-boundary tests**

Run: `node --test server/tests/auto-listing-ai-settings-*.test.mjs server/tests/auto-listing-ai-admin-*.test.mjs server/tests/ai-gateway-profile-service.test.mjs server/tests/auto-listing-ai-phase-context-postgres.test.mjs server/tests/auto-listing-ai-runtime-composition.test.mjs server/tests/module-boundaries.test.mjs`

Expected: PASS; `server/index.mjs` is unchanged, legacy and encrypted profiles both work, and disabled configuration causes no external work.

- [ ] **Step 8: Commit the administrator backend closure**

```bash
git add server/auto-listing-ai-settings-service.mjs server/auto-listing-ai-settings-routes.mjs server/auto-listing-ai-settings-runtime.mjs server/auto-listing-ai-admin-postgres.mjs server/auto-listing-ai-admin-service.mjs server/ai-gateway-profile-service.mjs server/auto-listing-ai-phase-context-postgres.mjs server/auto-listing-ai-runtime-composition.mjs server/auto-listing-web-runtime.mjs server/tests
git commit -m "feat(auto-listing): add administrator AI model settings workflow"
```

---

### Task 8: Frontend client contract and fail-closed view model

**Files:**
- Create: `app/src/auto-listing-ai-settings-client.js`
- Create: `app/src/auto-listing-ai-settings-view.js`
- Create: `app/tests/auto-listing-ai-settings-client.test.mjs`
- Create: `app/tests/auto-listing-ai-settings-view.test.mjs`

**Interfaces:**
- Consumes: Task 7 HTTP routes and existing `apiRequest`.
- Produces: typed-by-contract request functions and pure `aiSettingsPresentation(overview)` for the React page.

- [ ] **Step 1: Write RED client tests for intent reuse and secret non-retention**

```js
test("connection intent is reused across timeout retry and cleared only after confirmed success", async () => {
  const intents = createAiSettingsIntentStore(memoryStorage);
  const first = intents.connectionIntent({ displayName: "本地 sub2API", baseUrl: "http://127.0.0.1:8080/v1" });
  const second = intents.connectionIntent({ displayName: "本地 sub2API", baseUrl: "http://127.0.0.1:8080/v1" });
  assert.equal(first.idempotencyKey, second.idempotencyKey);
  assert.doesNotMatch(JSON.stringify(memoryStorage.dump()), /gateway-secret/);
});
```

Test exact paths/bodies, abort behavior, 64 KiB limit, polling terminal states, no Key in local/session storage, and clearing the input value after confirmed connection creation.

- [ ] **Step 2: Write RED view tests for action gating**

The pure projection must show `canSync`, `canTest`, `canPublish`, and `canRollback` only when the server-provided action contract explicitly allows each action. Missing/malformed `actions` fails closed. Map safe codes to Chinese messages without inspecting arbitrary backend text.

- [ ] **Step 3: Run tests and verify RED**

Run: `node --test app/tests/auto-listing-ai-settings-client.test.mjs app/tests/auto-listing-ai-settings-view.test.mjs`

Expected: FAIL because client/view modules do not exist.

- [ ] **Step 4: Implement client and presentation modules**

Expose:

```js
loadAiSettings()
createGatewayConnection(input, intent)
requestModelSync(input, intent)
createModelProfile(input, intent)
testModelProfile(input)
publishModelProfile(input, intent)
rollbackModelProfile(input, intent)
pollAiSettingsUntil(predicate, { signal, timeoutMs })
```

The view maps recommendation reason codes to labels such as `支持结构化输出`, `支持图片生成`, and `支持参考图`. It labels all synchronized candidates `待验证`; only a current PASSED capability result displays `已验证`.

- [ ] **Step 5: Run client/view and transport regressions**

Run: `node --test app/tests/auto-listing-ai-settings-client.test.mjs app/tests/auto-listing-ai-settings-view.test.mjs app/tests/client-transport.test.mjs app/tests/auto-listing-view.test.mjs`

Expected: PASS with no storage of the raw Key and no status-derived action guessing.

- [ ] **Step 6: Commit the frontend contract**

```bash
git add app/src/auto-listing-ai-settings-client.js app/src/auto-listing-ai-settings-view.js app/tests/auto-listing-ai-settings-*.test.mjs
git commit -m "feat(auto-listing): add AI settings frontend contract"
```

---

### Task 9: Administrator AI model settings page and auto-listing entry

**Files:**
- Create: `app/src/AiModelSettingsPage.jsx`
- Create: `app/src/auto-listing-ai-settings.css`
- Create: `app/tests/auto-listing-ai-settings-page-contract.test.mjs`
- Modify: `app/src/AutoListingPage.jsx` header actions
- Modify: `app/src/App.jsx` import, title map, and route render
- Modify: `app/tests/auto-listing-page-contract.test.mjs`
- Modify: `app/tests/web-runtime-contract.test.mjs`

**Interfaces:**
- Consumes: Task 8 client/view and `account.role`/navigation props already passed by `App.jsx`.
- Produces: route `/ozon/tools/auto-listing/ai-settings` and administrator-only entry button.

- [ ] **Step 1: Write RED page contract tests**

Assert:

```text
AutoListingPage renders “AI 模型配置” only for an admin account.
AiModelSettingsPage never sets a gateway Key from overview data.
The password input uses autoComplete="new-password" and is cleared after confirmed save.
The page includes connection, synchronization, selection, paid-test warning, publication, and history regions.
Buttons are driven by server actions and disabled during an active request.
The page does not write gatewayKey to localStorage/sessionStorage.
```

- [ ] **Step 2: Run page contract tests and verify RED**

Run: `node --test app/tests/auto-listing-ai-settings-page-contract.test.mjs app/tests/auto-listing-page-contract.test.mjs app/tests/web-runtime-contract.test.mjs`

Expected: FAIL because the page, route, and button do not exist.

- [ ] **Step 3: Implement the page with four focused sections**

Build:

1. `sub2API 连接`: status, base URL, one-way Key input, test/open-dashboard actions.
2. `模型同步与选择`: last sync, immediate sync, ranked text/image selects, recommendation reasons.
3. `能力测试与发布`: explicit cost warning, separate text/image/decode results, publish action.
4. `当前配置与历史版本`: active version, operator/time, safe rollback.

Do not call sub2API from the browser. Keep draft form state stable when the application's 15-second background account/store refresh creates new props; initialize server data only when the settings version changes and the form is not dirty.

- [ ] **Step 4: Add administrator-only navigation**

Extend the existing `AutoListingPage` props to accept the already supplied `navigate` function. Replace the header tag-only extra with a space containing the existing tag and an admin-only button that calls `navigate("/ozon/tools/auto-listing/ai-settings")`. In `App.jsx`, import/render `AiModelSettingsPage` and add the route title; do not add a left-menu child.

- [ ] **Step 5: Run frontend tests and production build**

Run: `node --test app/tests/auto-listing-ai-settings-*.test.mjs app/tests/auto-listing-page-contract.test.mjs app/tests/web-runtime-contract.test.mjs app/tests/client-transport.test.mjs`

Run: `pnpm --dir app build`

Expected: all tests PASS and Vite production build completes without warnings that expose secret values.

- [ ] **Step 6: Commit the administrator UI**

```bash
git add app/src/AiModelSettingsPage.jsx app/src/auto-listing-ai-settings.css app/src/AutoListingPage.jsx app/src/App.jsx app/tests/auto-listing-ai-settings-page-contract.test.mjs app/tests/auto-listing-page-contract.test.mjs app/tests/web-runtime-contract.test.mjs
git commit -m "feat(auto-listing): add AI model settings page"
```

---

### Task 10: End-to-end verification, documentation, and rollback evidence

**Files:**
- Create: `docs/architecture/local-sub2api-operations.md`
- Create: `docs/superpowers/verification/2026-08-08-local-sub2api-ai-model-configuration.md`
- Modify: `README.md` local development section

**Interfaces:**
- Consumes: all previous tasks.
- Produces: reproducible operator instructions, full verification evidence, explicit unverified real-provider scope, and rollback procedure.

- [ ] **Step 1: Write an end-to-end controlled gateway integration test**

Use an in-process loopback fake sub2API that implements `/v1/models`, `/v1/responses`, and `/v1/images/edits`. Exercise:

```text
admin creates encrypted connection
manual sync commits catalog and recommendations
admin confirms text/image models
capability test returns structured text and a decodable PNG
profile publish activates the connection
new auto-listing job freezes the published profile/connection version
rotating to a new connection does not change the existing job
```

The test must inspect logs/audits/DTOs and fail if the raw test key appears.

- [ ] **Step 2: Run all focused backend and frontend suites**

Run:

```bash
node --test server/tests/auto-listing-ai-credential-*.test.mjs \
  server/tests/auto-listing-ai-settings-*.test.mjs \
  server/tests/auto-listing-ai-model-*.test.mjs \
  server/tests/sub2api-ai-adapter.test.mjs \
  server/tests/ai-gateway-profile-service.test.mjs \
  server/tests/auto-listing-ai-runtime-composition.test.mjs \
  app/tests/auto-listing-ai-settings-*.test.mjs \
  app/tests/auto-listing-page-contract.test.mjs
```

Expected: all PASS with zero unconfigured skips in the focused feature suite.

- [ ] **Step 3: Run project-wide gates**

Run: `pnpm verify`

Run: `pnpm build`

Run: `git diff --check`

Expected: project verification and frontend production build PASS; only explicitly configured PostgreSQL/external-service skips remain, and each is listed in the verification document.

- [ ] **Step 4: Run local Docker smoke without real AI calls**

Run:

```bash
pnpm sub2api:bootstrap
pnpm sub2api:up
pnpm sub2api:status
```

Verify the dashboard returns HTTP 200 on `http://127.0.0.1:8080/`, containers are healthy, published ports are loopback-only, restarting the stack preserves its database, and `pnpm sub2api:down` stops only the `sonli-sub2api-local` project.

- [ ] **Step 5: Perform the explicitly approved real capability acceptance test**

After the user configures an upstream account and creates a dedicated gateway Key in sub2API:

1. Enter the Key through the Web page; confirm it cannot be read back.
2. Synchronize models; confirm synchronization itself produces no text/image charge.
3. Confirm the recommended text and image models.
4. Acknowledge the cost warning and run one capability test.
5. Publish the profile only if structured text, image generation, and image decode all pass.
6. Create one REVIEW-mode auto-listing job; do not enable DIRECT upload as part of this acceptance test.

Record model IDs, safe result codes, timings, and configuration versions. Do not record the gateway Key, authorization headers, raw prompts, or upstream response bodies.

- [ ] **Step 6: Write operations and verification documents**

Document exact start/stop/status/credentials/upgrade/backup steps, local URLs, secret locations and permissions, model sync behavior, cost boundary, common safe errors, production replacement rules, and rollback:

```text
disable AUTO_LISTING_AI_ENABLED and AUTO_LISTING_ENABLED
stop sonli-sub2api-local Compose project
retain additive migration data and audits
reactivate the last verified profile when its credential still passes
revert application commits without deleting immutable evidence rows
```

- [ ] **Step 7: Request an independent code review and close all Critical/Important findings**

The reviewer must inspect tenant FKs, encryption AAD, Key non-disclosure, SSRF/DNS rebinding, idempotency, task recovery, capability cost boundaries, profile/job version freezing, disabled-mode side effects, Compose isolation, and old-feature regression. Re-run focused tests after every repair.

- [ ] **Step 8: Commit final verification and documentation**

```bash
git add README.md docs/architecture/local-sub2api-operations.md docs/superpowers/verification/2026-08-08-local-sub2api-ai-model-configuration.md
git commit -m "docs(auto-listing): verify local sub2api model configuration"
```

---

## Definition of Done

- Local sub2API starts reproducibly from a pinned, isolated, loopback-only stack and survives restart.
- An administrator can configure a one-way encrypted gateway Key without editing `.env` or calling HTTP APIs manually.
- The Web backend synchronizes `/v1/models`, returns explainable recommendations, and never performs paid generation during sync.
- An administrator confirms text/image models and explicitly runs one real capability test before publication.
- Published profiles carry immutable connection evidence; legacy environment profiles continue to work.
- Existing jobs retain their frozen profile/connection version across model or Key rotation.
- All backend permissions, tenant boundaries, idempotency, audit, recovery, and stable error contracts pass unit and real PostgreSQL tests.
- The new page is administrator-only, does not lose drafts during background refresh, and never stores or displays the raw Key.
- sub2API failure affects only AI auto-listing; collection, stores, products, orders, and the browser extension pass regression checks.
- Full verification, build, `git diff --check`, independent review, unverified scope, and rollback evidence are documented.
