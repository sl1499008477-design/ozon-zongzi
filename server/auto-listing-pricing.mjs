const PRICE_CURRENCY_NOT_RUB = "PRICE_CURRENCY_NOT_RUB";
const PRICE_INPUT_MISSING = "PRICE_INPUT_MISSING";
const PRICE_INPUT_INVALID = "PRICE_INPUT_INVALID";
const PRICE_FINAL_NOT_POSITIVE = "PRICE_FINAL_NOT_POSITIVE";

const POSTGRES_BIGINT_MIN = -9_223_372_036_854_775_808n;
const POSTGRES_BIGINT_MAX = 9_223_372_036_854_775_807n;

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

export function calculateAutoListingPrice(input = {}) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw priceError(PRICE_INPUT_INVALID);
  }
  if (isMissing(input.currency)) throw priceError(PRICE_INPUT_MISSING);
  if (input.currency !== "RUB") throw priceError(PRICE_CURRENCY_NOT_RUB);

  const blackKopecks = parseIntegerKopecks(input.blackKopecks, { required: true, positive: true });
  const adjustmentKopecks = parseIntegerKopecks(input.adjustmentKopecks, { required: false, positive: false });

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

  const finalPriceKopecks = realPriceKopecks + adjustmentKopecks;
  if (finalPriceKopecks <= 0n) throw priceError(PRICE_FINAL_NOT_POSITIVE);

  return {
    currency: "RUB",
    branch,
    blackKopecks: String(blackKopecks),
    ...(greenKopecks === undefined ? {} : { greenKopecks: String(greenKopecks) }),
    realPriceKopecks: String(realPriceKopecks),
    adjustmentKopecks: String(adjustmentKopecks),
    finalPriceKopecks: String(finalPriceKopecks),
  };
}
