export async function handoffCategoryStrategySampling({ client, extensionBridge, draft, identity }) {
  await extensionBridge.ready();
  const session = await client.startSession(draft.draftId, {
    expectedDraftVersion: draft.draftVersion,
    ...identity,
  });
  await extensionBridge.open(session.browserUrl);
  return session;
}

export async function startCategoryStrategySampling({ client, intents, extensionBridge, draft }) {
  const fingerprint = { draftId: draft.draftId, expectedDraftVersion: draft.draftVersion };
  const identity = await intents.identity("category-sampling", fingerprint);
  const session = await handoffCategoryStrategySampling({ client, extensionBridge, draft, identity });
  await intents.settle("category-sampling", fingerprint);
  return session;
}

export function findResumableCategoryStrategyDraftId({ strategies, resume }) {
  if (!resume?.required?.scope || !Array.isArray(strategies)) return "";
  const required = resume.required.scope;
  return strategies.find((entry) => entry?.scope?.taxonomyScope === required.taxonomyScope
    && entry.scope.descriptionCategoryId === required.descriptionCategoryId
    && entry.scope.typeId === required.typeId)?.draftId || "";
}

export async function loadCategoryStrategyBootstrap({ client, intents, extensionBridge, resume = null,
  routeDraftId = "", autoStartSampling = false, onDraftReady = () => {} }) {
  let draftId = routeDraftId || resume?.required?.draftId || "";
  if (!draftId && resume?.required?.canManage) {
    const source = resume.sourceVersions.find((entry) =>
      entry.collectItemId === resume.required.sourceCollectItemId);
    if (!source) throw new Error("来源版本不可用，请刷新采集箱后重试");
    const fingerprint = {
      scope: resume.required.scope,
      sourceCollectItemId: source.collectItemId,
      expectedSourceVersion: source.expectedSourceVersion,
    };
    const identity = await intents.identity("category-draft", fingerprint);
    const created = await client.createDraft({ ...fingerprint, ...identity });
    await intents.settle("category-draft", fingerprint);
    draftId = created.draftId;
  }
  if (!draftId) return null;

  const bundle = await client.getDraft(draftId);
  await onDraftReady(Object.freeze({ draftId, bundle }));
  let session = bundle.session;
  if (autoStartSampling && !session) {
    session = await startCategoryStrategySampling({ client, intents, extensionBridge, draft: bundle.draft });
  } else if (autoStartSampling && session) {
    await extensionBridge.open(session.browserUrl);
  }
  return Object.freeze({
    draftId,
    bundle,
    session,
    browserUrl: autoStartSampling ? session?.browserUrl || "" : "",
  });
}
