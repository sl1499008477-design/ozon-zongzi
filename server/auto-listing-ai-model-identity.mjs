const DATED_MODEL = /^(.*)-(\d{4})-(\d{2})-(\d{2})$/u;

function validDate(year, month, day) {
  const value = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return value.getUTCFullYear() === Number(year)
    && value.getUTCMonth() === Number(month) - 1
    && value.getUTCDate() === Number(day);
}

export function isCompatibleAiModelIdentity(requestedModel, reportedModel) {
  if (typeof requestedModel !== "string" || typeof reportedModel !== "string"
    || !requestedModel || !reportedModel) return false;
  if (reportedModel === requestedModel) return true;
  // Deployment compatibility exception for the exact response observed on 2026-09-07.
  // This is not a general provider identity guarantee: do not normalize names or suffixes.
  if (requestedModel === "gpt-5.6-luna" && reportedModel === "gpt-56-luna-2026-07-09-datazone") return true;
  if (DATED_MODEL.test(requestedModel)) return false;
  const snapshot = reportedModel.match(DATED_MODEL);
  return snapshot !== null && snapshot[1] === requestedModel
    && validDate(snapshot[2], snapshot[3], snapshot[4]);
}
