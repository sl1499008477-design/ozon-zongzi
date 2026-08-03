# Task 2: verified sub2api gateway adapter report

## Implementation

- Added a stable `AiGatewayPort` with structured text, image generation, image inspection, and explicit capability-test operations. Business callers receive internal values, decoded image bytes/metadata, upstream request IDs, normalized usage, and a closed safe diagnostics object; no sub2api response body escapes the adapter.
- Added a profile-driven sub2api adapter with exactly one text protocol (`SUB2API_RESPONSES`) and two image protocols (`SUB2API_RESPONSES_IMAGE_TOOL`, `SUB2API_OPENAI_IMAGES`). A selected protocol never probes or silently falls back to another protocol during a business call.
- Added stable error classification for authentication, retryable gateway statuses, invalid success bodies, timeout, cancellation, blocked redirects, missing secrets, invalid profiles, and model mismatch.
- Added administrator-only capability testing. It checks an authenticated models endpoint for reachability, requires the text model to satisfy the fixed `{ok:true}` JSON-schema probe, spends one image generation, and uses `sharp` to decode the returned image rather than trusting a file signature. Only the outcome, closed feature list, latency, selected model IDs, check time, and stable error code are persisted; an exact `config_version` compare-and-swap prevents a stale result from enabling a changed profile.
- Added `AUTO_LISTING_AI_ENABLED`, which defaults off. When enabled, the runtime check requires an explicit profile reference, the exact enabled profile version, a valid environment-variable reference, and a present nonblank secret. No minimum or arbitrary API-key length policy was added.

## Verified sub2api evidence

The implementation was based only on the official `Wei-Shaw/sub2api` repository at main commit `825ca7b1fc9335f904bc077f051de815fb61e47f`, inspected on 2026-08-04:

- `backend/internal/server/routes/gateway.go` registers authenticated `POST /v1/responses` and `POST /v1/images/generations` endpoints.
- `backend/internal/service/openai_images_responses.go` and `openai_images_test.go` show complete image-tool results in `response.output_item.done.item.result` and `response.completed.response.output[].result`, with `type: image_generation_call`. They also show `response.image_generation_call.partial_image`; this adapter deliberately does not accept a partial image as the final asset.
- `README.md` and `docs/ASYNC_IMAGE_TASKS.md` describe OpenAI-compatible Images responses using `data[].b64_json` or `data[].url`, and document that protocol availability depends on the deployed platform, account group permissions, and storage configuration. This is why profile protocols are explicit and must pass a real capability test.

## Security boundaries and compatibility limit

- The API key is looked up from `api_key_env_name` for every call and is never stored, returned, logged, or included in diagnostics. Secret-reader errors are converted to a stable safe code. Environment-reference names reject malformed and prototype-sensitive keys.
- Ordinary remote gateways must use HTTPS. Plain HTTP is allowed only for loopback development addresses (`localhost`, `127.0.0.1`, `[::1]`).
- Gateway endpoints and redirects must remain under the configured origin and base path. Authorization is never forwarded outside that boundary.
- `data[].url` is supported only when the URL remains under the same configured gateway origin and base path. The download sends no Authorization header, follows only bounded in-boundary redirects, enforces a byte limit, and validates the decoded image format/dimensions. This is intentionally stricter than some sub2api object-storage deployments: a profile that returns a different-origin CDN/S3 URL will fail its capability test and remain disabled. Supporting external object-storage origins later requires an explicit persisted allowlist plus DNS/IP/rebinding defenses; it is not silently permitted here.
- Logs contain only account-safe identifiers, protocol, operation, correlation/request IDs, HTTP status, and stable error code. Prompts, source image references/data URLs, image bytes, Authorization/Cookie values, and complete upstream responses are excluded.

## TDD and verification

Initial RED: both new test files failed with `ERR_MODULE_NOT_FOUND` because the adapter and profile service did not exist. Additional focused RED cases proved that oversized base64 images were initially not constrained, remote HTTP/env-name safety was missing, secret-reader errors were not normalized, fake PNG headers were not truly decoded, and whitespace secrets/prototype-sensitive environment names were not rejected.

Final focused GREEN: 25 adapter/profile/runtime tests passed. The broader auto-listing suite passed 165 tests with 2 dedicated-PostgreSQL tests safely skipped. The exact 9-file legacy regression passed 42 tests. App production build succeeded with the existing large-chunk warning only. Node syntax checks and `git diff --check` passed.

No real sub2api call was made. Therefore the actual deployment's gateway version, selected models, quota cost, and protocol compatibility remain intentionally unverified until an administrator explicitly runs the cost-bearing capability test. No dedicated PostgreSQL URL is configured, so live migration/trigger/foreign-key behavior remains gated and was not run against any ordinary or production database.

## Rollback

Set `AUTO_LISTING_AI_ENABLED=0`. The new adapter and profile service have no call site in existing business paths yet, so disabling the flag prevents future generation composition without changing current collection, listing, store, order, or extension behavior. Preserve the non-secret profile and capability evidence for audit rather than deleting it.
