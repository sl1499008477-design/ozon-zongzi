# Plan 2 Task 2: verified sub2api gateway boundary

## Scope

Create the stable AI gateway port, a profile-driven sub2api adapter, the explicit administrator capability-test service, and the disabled-by-default runtime gate. Do not add routes, UI, workers, planners, object-storage writes, or Ozon calls.

## Verified upstream evidence

Evidence was read from `Wei-Shaw/sub2api` main commit `825ca7b1fc9335f904bc077f051de815fb61e47f` on 2026-08-04:

- `backend/internal/server/routes/gateway.go` registers authenticated `POST /v1/responses` and `POST /v1/images/generations` routes.
- `backend/internal/service/openai_images_test.go` and `openai_images_responses.go` show final Responses image bytes in `response.output_item.done.item` or `response.completed.response.output` entries with `type: image_generation_call` and base64 `result`.
- The same source recognizes `response.image_generation_call.partial_image`, but a partial event is not accepted as a final asset by this adapter.
- `README.md` and `docs/ASYNC_IMAGE_TASKS.md` describe OpenAI-compatible image results as `data[].b64_json` or `data[].url`, and explicitly note that image support depends on deployment platform/group permissions and optional storage configuration.

Therefore each saved profile selects one closed text protocol and one closed image protocol. A business call never probes or silently falls back to another protocol. Production enablement requires an explicit, cost-bearing administrator capability test against the exact profile version and models.

## Stable behavior

- Text output is parsed into an internal structured value.
- Image output is normalized to decoded bytes, format, width, height, model, request ID, usage, and safe diagnostics.
- Secrets are resolved only at call time from `api_key_env_name`; no secret value, auth/cookie header, prompt, source bytes/data URL, image bytes, or full upstream body is logged or returned as diagnostics.
- Gateway paths remain under the configured origin and base path. Redirects cannot carry authorization outside that boundary. Returned image URLs are downloaded without authorization and only within the same configured boundary.
- Stable errors classify authentication, retryable gateway statuses, invalid success bodies, timeout, cancellation, blocked redirects, and missing configuration.
- Deterministic request and correlation values are sent unchanged on every attempt.
- Capability-test persistence is account/profile/version scoped and uses compare-and-swap so an old test cannot enable a newer configuration.
- `AUTO_LISTING_AI_ENABLED` defaults off. Turning it on requires a configured profile reference, an enabled exact profile, and a present referenced environment secret; no key-length policy is added.
