import assert from "node:assert/strict";
import test from "node:test";

import { isCompatibleAiModelIdentity } from "../auto-listing-ai-model-identity.mjs";

test("accepts only an exact requested model or its dated provider snapshot", () => {
  assert.equal(isCompatibleAiModelIdentity("gpt-5.4", "gpt-5.4"), true);
  assert.equal(isCompatibleAiModelIdentity("gpt-5.4", "gpt-5.4-2026-03-05"), true);
  assert.equal(isCompatibleAiModelIdentity("gpt-image-2", "gpt-image-2-2026-03-05"), true);
  for (const reported of [
    "gpt-5.4-mini", "gpt-5.4-2026-3-5", "gpt-5.4-2026-03-05-extra", "gpt-5.5", "",
  ]) assert.equal(isCompatibleAiModelIdentity("gpt-5.4", reported), false);
  assert.equal(isCompatibleAiModelIdentity("gpt-5.4-2026-03-05", "gpt-5.4-2026-03-05-extra"), false);
});
