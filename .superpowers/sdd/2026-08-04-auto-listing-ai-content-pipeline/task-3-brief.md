# Plan 2 Task 3: deterministic visual groups and content plans

## Stable source-evidence contract

The foundation snapshot deliberately preserves `variant.evidence` and `variant.media` as frozen JSON without guessing their business meaning. This task consumes only the following explicit V1 evidence shape:

- `variant.evidence.contractVersion = 1`
- `variant.evidence.variantId`: immutable source variant identity
- `variant.evidence.appearanceStatus`: `COMPLETE | AMBIGUOUS`
- `appearanceFacts[]`: closed `{ factId, kind, value }`, where kind is `COLOR | PATTERN | SHAPE | MATERIAL | ACCESSORY_COUNT`
- `sizeFacts[]`: closed `{ factId, kind: "SIZE", value }`
- `variant.media[]`: either the current canonical HTTP(S) URL string, normalized to a deterministic `SOURCE_URL` reference with `contentHash: null`, or closed `{ assetId, contentHash }` evidence normalized to `CONTENT_HASH`. URL text is retained only in the internal group record and is omitted from the AI planner prompt. Before Task 4, a separate idempotent materialization worker must safely download, decode, persist, and calculate the real content hash, then create a new visual-group/ContentPlan version. Task 4 itself accepts only `CONTENT_HASH` and never mutates the original plan.

Unknown V1 evidence/media object keys are rejected. Missing or legacy appearance evidence is not guessed: that variant becomes a conservative singleton group. Product-level logistics/package dimensions are never visual or claim facts.

## Grouping

- COMPLETE variants share a group only when their complete visible-appearance fact signatures match. Size facts are deliberately excluded from that signature.
- Any color, pattern, shape, or accessory-count difference splits groups.
- Missing, conflicting, duplicate, or AMBIGUOUS visual evidence splits variants conservatively.
- Groups have deterministic keys, ordering, hashes, source SKUs/variant IDs, reference asset IDs/content hashes, fact evidence, and reason codes.

## Planner contract

The planner receives only a read-only fact registry, verified frozen strategy/config references, effective role counts, visual groups, Russian language, image ratio/resolution/quality, prohibited claims, and non-secret profile/model/template references. It never receives writable listing fields, credentials, price, category mutation fields, stock, store/warehouse, package dimensions, or variant mutation fields. SKU appears only in visual-group trace evidence.

Every visual group gets its own configured image set. Missing reliable product measurements removes `SPECIFICATION` and deterministically reallocates within the confirmed role maxima. At the fully saturated 13-image configuration, the safe maximum without `SPECIFICATION` is 12; the planner records an explicit capacity downgrade instead of violating the confirmed role maxima.

The returned ContentPlan is a closed JSON contract. Local validation follows gateway schema validation and checks group coverage, slot identity/order/counts, density, Russian copy, fact/asset ownership, preserve/prohibited constraints, numeric evidence, and claim-type suitability.

## Idempotency

`inputHash` covers source, strategy, frozen config, visual groups, template, profile/version, planner model, and a typed regeneration request. The repository atomically reserves an account/job/item/input hash before the gateway call. Exact reuse verifies the stored scope, hash, canonical plan body, and plan hash. Regeneration requires a stable reason and a unique request ID so one action is idempotent while a later action creates an immutable new version.
