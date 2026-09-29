export function hasCompleteReviewImageGroups({ visualGroups, images } = {}) {
  if (!Array.isArray(visualGroups) || visualGroups.length < 1 || !Array.isArray(images)) return false;
  const keys = visualGroups.map((group) => group?.key);
  if (keys.some((key) => typeof key !== "string" || !key.trim())
    || new Set(keys).size !== keys.length) return false;
  const grouped = new Map(keys.map((key) => [key, []]));
  for (const image of images) {
    if (image?.accepted !== true || !grouped.has(image.visualGroupKey)) return false;
    grouped.get(image.visualGroupKey).push(image);
  }
  return [...grouped.values()].every((groupImages) => groupImages.length >= 6
    && groupImages.length <= 13
    && groupImages.filter((image) => image.role === "MAIN").length === 1);
}

export function isSourceImageConfirmationReviewEvidence(evidence = {}) {
  const item = evidence?.item;
  const analysis = evidence?.sourceImageAnalysis;
  return item?.status === "BLOCKED"
    && item.failureCode === "AUTO_LISTING_SOURCE_IMAGE_CONFIRMATION_REQUIRED"
    && typeof item.currentSourceImageAnalysisRunId === "string"
    && item.currentSourceImageAnalysisRunId.length > 0
    && analysis?.analysisRunId === item.currentSourceImageAnalysisRunId
    && analysis?.status === "CONFIRMATION_REQUIRED";
}
