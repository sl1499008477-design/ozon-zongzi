(function (root, factory) {
  const api = factory();
  root.JzFollowSellRequest = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : self, () => {
  function stripInternalMessageFields(message) {
    const copy = { ...(message || {}) };
    delete copy._aiwDebug;
    delete copy.applyWatermark;
    delete copy.watermarkTemplateId;
    return copy;
  }

  async function runFollowSellRequest({ message, sender, token, storeId, backendUrl }, deps) {
    const {
      apiRequest,
      importViaPortal,
      deriveImportEntry,
      aiWizardDebugMeta,
      log = console,
    } = deps;
    const targetStoreId = message.storeId || storeId;
    const importMessage = stripInternalMessageFields(message);
    importMessage.entry = deriveImportEntry(message, sender);
    const bodySize = JSON.stringify(importMessage).length;
    if (importMessage.dryRun) {
      log.log(`[followSell] Preview import: items=${importMessage.items?.length}, bodySize=${bodySize}, url=${backendUrl}/ozon/products/import/preview`);
      const previewResult = await apiRequest(
        'POST',
        `${backendUrl}/ozon/products/import/preview`,
        importMessage,
        token,
        targetStoreId,
        120_000,
        aiWizardDebugMeta(message, 'followSellPreview', {
          items: Array.isArray(importMessage.items) ? importMessage.items.length : undefined,
        }),
      );
      log.log('[followSell] Preview response:', JSON.stringify(previewResult).slice(0, 200));
      return { ok: true, data: previewResult };
    }
    if (importMessage.viaPortal) {
      log.log(`[followSell] viaPortal: items=${importMessage.items?.length}, url=${backendUrl}/ozon/products/prepare-bundle-items`);
      const portalResult = await importViaPortal(importMessage, token, targetStoreId, backendUrl, sender?.tab?.id);
      log.log('[followSell] portal response:', JSON.stringify(portalResult).slice(0, 200));
      return { ok: true, data: portalResult };
    }
    const importTimeout = 120_000;
    log.log(`[followSell] Enqueueing import: items=${importMessage.items?.length}, bodySize=${bodySize}, aiImage=${importMessage.applyAiImage}, url=${backendUrl}/ozon/products/import`);
    const followSellResult = await apiRequest(
      'POST',
      `${backendUrl}/ozon/products/import`,
      importMessage,
      token,
      targetStoreId,
      importTimeout,
      aiWizardDebugMeta(message, 'followSell', {
        items: Array.isArray(importMessage.items) ? importMessage.items.length : undefined,
        stocks: Array.isArray(importMessage.stocks) ? importMessage.stocks.length : undefined,
        applyPoster: !!importMessage.applyPoster,
      }),
    );
    log.log('[followSell] Enqueue response:', JSON.stringify(followSellResult).slice(0, 200));
    return { ok: true, data: followSellResult };
  }

  return { runFollowSellRequest };
});
