import { normalizeAutoListingCurrency } from "./auto-listing-currency.mjs";

const PRICE_CURRENCY_UNSUPPORTED = "PRICE_CURRENCY_UNSUPPORTED";
const PRICE_INPUT_MISSING = "PRICE_INPUT_MISSING";
const PRICE_INPUT_INVALID = "PRICE_INPUT_INVALID";
const PRICE_FINAL_NOT_POSITIVE = "PRICE_FINAL_NOT_POSITIVE";

const POSTGRES_BIGINT_MIN = -9_223_372_036_854_775_808n;
const POSTGRES_BIGINT_MAX = 9_223_372_036_854_775_807n;
const MULTIPLIER_SCALE = 1_000_000n;

const priceError = (code) => {
  const error = new Error(code);
  error.code = code;
  return error;
};

const isMissing = (value) => value === undefined || value === null || value === "";

const parseIntegerKopecks = (value, { required, positive }) => {
  if (isMissing(value)) {
    if (required) throw priceError(PRICE_INPUT_MISSING);
    return 0n;
  }
  if (typeof value !== "string") throw priceError(PRICE_INPUT_INVALID);
  const text = String(value).trim();
  if (!/^[+-]?\d{1,19}$/.test(text)) throw priceError(PRICE_INPUT_INVALID);
  const parsed = BigInt(text);
  if (parsed < POSTGRES_BIGINT_MIN || parsed > POSTGRES_BIGINT_MAX) {
    throw priceError(PRICE_INPUT_INVALID);
  }
  if (positive && parsed <= 0n) throw priceError(PRICE_INPUT_INVALID);
  return parsed;
};

const roundHalfUp = (numerator, denominator) =>
  (numerator + denominator / 2n) / denominator;

function finalizePrice({ currency, branch, realPriceKopecks, adjustmentKopecks, priceMultiplierMicros, facts }) {
  const adjustment = parseIntegerKopecks(adjustmentKopecks, { required: false, positive: false });
  const multiplier = parseIntegerKopecks(
    priceMultiplierMicros ?? String(MULTIPLIER_SCALE), { required: true, positive: true },
  );
  const preMultiplierPriceKopecks = realPriceKopecks + adjustment;
  if (preMultiplierPriceKopecks <= 0n) throw priceError(PRICE_FINAL_NOT_POSITIVE);
  const finalPriceKopecks = roundHalfUp(preMultiplierPriceKopecks * multiplier, MULTIPLIER_SCALE);
  if (finalPriceKopecks <= 0n) throw priceError(PRICE_FINAL_NOT_POSITIVE);
  if (finalPriceKopecks > POSTGRES_BIGINT_MAX) throw priceError(PRICE_INPUT_INVALID);
  return {
    currency,
    branch,
    ...facts,
    realPriceKopecks: String(realPriceKopecks),
    adjustmentKopecks: String(adjustment),
    preMultiplierPriceKopecks: String(preMultiplierPriceKopecks),
    priceMultiplierMicros: String(multiplier),
    finalPriceKopecks: String(finalPriceKopecks),
  };
}

export function calculateAutoListingPrice(input = {}) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw priceError(PRICE_INPUT_INVALID);
  }
  if (isMissing(input.currency)) throw priceError(PRICE_INPUT_MISSING);
  const currency = normalizeAutoListingCurrency(input.currency);
  if (!currency || currency !== input.currency) throw priceError(PRICE_CURRENCY_UNSUPPORTED);

  const blackKopecks = parseIntegerKopecks(input.blackKopecks, { required: true, positive: true });
  let branch;
  let greenKopecks;
  let realPriceKopecks;
  if (blackKopecks >= 8_000n) {
    branch = "BLACK_GTE_80";
    greenKopecks = parseIntegerKopecks(input.greenKopecks, { required: true, positive: true });
    if (greenKopecks > blackKopecks) throw priceError(PRICE_INPUT_INVALID);
    realPriceKopecks = roundHalfUp((blackKopecks - greenKopecks) * 225n, 100n) + blackKopecks;
  } else {
    branch = "BLACK_LT_80";
    realPriceKopecks = roundHalfUp(blackKopecks * 10_000n, 10_715n);
  }

  return finalizePrice({
    currency,
    branch,
    realPriceKopecks,
    adjustmentKopecks: input.adjustmentKopecks,
    priceMultiplierMicros: input.priceMultiplierMicros,
    facts: {
      blackKopecks: String(blackKopecks),
      ...(greenKopecks === undefined ? {} : { greenKopecks: String(greenKopecks) }),
    },
  });
}

export function calculateAutoListingActualPrice(input = {}) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw priceError(PRICE_INPUT_INVALID);
  }
  if (isMissing(input.currency)) throw priceError(PRICE_INPUT_MISSING);
  const currency = normalizeAutoListingCurrency(input.currency);
  if (!currency || currency !== input.currency) throw priceError(PRICE_CURRENCY_UNSUPPORTED);
  const sourcePriceKopecks = parseIntegerKopecks(input.sourcePriceKopecks, { required: true, positive: true });
  return finalizePrice({
    currency,
    branch: "SOURCE_PRICE_ONLY",
    realPriceKopecks: sourcePriceKopecks,
    adjustmentKopecks: input.adjustmentKopecks,
    priceMultiplierMicros: input.priceMultiplierMicros,
    facts: { sourcePriceKopecks: String(sourcePriceKopecks) },
  });
}

export function calculateAutoListingPriceFromEvidence(input = {}) {
  if (input?.greenKopecks === null
    && typeof input.blackKopecks === "string"
    && /^\d{1,19}$/u.test(input.blackKopecks)
    && BigInt(input.blackKopecks) >= 8_000n) {
    return calculateAutoListingActualPrice({
      currency: input.currency,
      sourcePriceKopecks: input.blackKopecks,
      adjustmentKopecks: input.adjustmentKopecks,
      priceMultiplierMicros: input.priceMultiplierMicros,
    });
  }
  return calculateAutoListingPrice(input);
}
