/**
 * Browser Agent listing actions.
 *
 * Draft generation currently runs through the backend collect-box draft API.
 * Keeping it as an allow-listed agent action lets the server orchestrator keep
 * one queue and one progress model for the full AI listing workflow.
 */
(() => {
  if (!globalThis.JzBrowserAgentActions) {
    throw new Error('JzBrowserAgentActions must be loaded before listing-actions');
  }

  function draftPayload(params) {
    const out = {};
    if (params.targetMarginPercent !== undefined) {
      out.targetMarginPercent = Number(params.targetMarginPercent);
    }
    if (params.priceRub !== undefined) {
      out.priceRub = Number(params.priceRub);
    }
    if (params.notes !== undefined) {
      out.notes = String(params.notes);
    }
    if (params.applyPoster !== undefined) out.applyPoster = coerceBool(params.applyPoster);
    if (params.posterRenderText !== undefined) out.posterRenderText = coerceBool(params.posterRenderText);
    if (params.posterPrimaryOnly !== undefined) out.posterPrimaryOnly = coerceBool(params.posterPrimaryOnly);
    return out;
  }

  function coerceBool(value) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    return !['false', '0', 'off', 'no', ''].includes(String(value).trim().toLowerCase());
  }

  function publishPayload(params) {
    const out = {};
    if (params.offerId !== undefined) out.offerId = String(params.offerId);
    if (params.priceRub !== undefined) out.priceRub = Number(params.priceRub);
    if (params.oldPriceRub !== undefined) out.oldPriceRub = Number(params.oldPriceRub);
    if (params.applyPoster !== undefined) out.applyPoster = coerceBool(params.applyPoster);
    if (params.posterRenderText !== undefined) out.posterRenderText = coerceBool(params.posterRenderText);
    if (params.posterPrimaryOnly !== undefined) out.posterPrimaryOnly = coerceBool(params.posterPrimaryOnly);
    if (params.posterPrimaryUploadOnly !== undefined) {
      out.posterPrimaryUploadOnly = coerceBool(params.posterPrimaryUploadOnly);
    }
    if (params.applyAiRewrite !== undefined) out.applyAiRewrite = coerceBool(params.applyAiRewrite);
    if (params.applyWatermark !== undefined) out.applyWatermark = coerceBool(params.applyWatermark);
    if (params.watermarkTemplateId !== undefined) {
      out.watermarkTemplateId = String(params.watermarkTemplateId);
    }
    if (params.stock !== undefined) out.stock = Number(params.stock);
    if (params.warehouseId !== undefined) out.warehouseId = params.warehouseId;
    return out;
  }

  globalThis.JzBrowserAgentActions.register(
    'listing.create_draft',
    async (job, context) => {
      const params = job?.params || {};
      const candidateId = String(params.candidateId || '').trim();
      if (!candidateId) throw new Error('candidateId is required');

      await context.reportProgress?.({
        stage: 'creating_ai_draft',
        message: 'Generating AI listing draft',
        percent: 20,
        payload: { candidateId },
      });
      context.throwIfCancelled?.();

      const draft = await globalThis.JzBackendClient.createAiListingDraft({
        candidateId,
        draft: draftPayload(params),
        storeId: job.storeId || undefined,
      });

      await context.reportProgress?.({
        stage: 'draft_ready',
        message: 'AI listing draft is ready for price confirmation',
        percent: 100,
        payload: { candidateId },
      });

      return {
        candidateId,
        draftId: candidateId,
        draft,
      };
    },
  );

  globalThis.JzBrowserAgentActions.register(
    'listing.publish_draft',
    async (job, context) => {
      const params = job?.params || {};
      const draftId = String(params.draftId || params.candidateId || '').trim();
      if (!draftId) throw new Error('draftId is required');

      await context.reportProgress?.({
        stage: 'publishing_draft',
        message: 'Submitting confirmed listing draft',
        percent: 20,
        payload: { draftId },
      });
      context.throwIfCancelled?.();

      const published = await globalThis.JzBackendClient.publishAiListingDraft({
        draftId,
        publish: publishPayload(params),
        storeId: job.storeId || undefined,
      });

      await context.reportProgress?.({
        stage: 'publish_queued',
        message: 'Listing publish task has been queued',
        percent: 100,
        payload: {
          draftId,
          localTaskId: published?.ozonTaskId || published?.draft?.publish?.localTaskId,
        },
      });

      return {
        draftId,
        localTaskId: published?.ozonTaskId || published?.draft?.publish?.localTaskId || null,
        publish: published?.draft?.publish || null,
      };
    },
  );
})();
