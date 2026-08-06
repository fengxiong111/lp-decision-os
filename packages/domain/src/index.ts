import Decimal from "decimal.js";

export type DecimalInput = Decimal.Value;

export function decimal(value: DecimalInput): Decimal {
  return new Decimal(value);
}

export function decimalString(value: DecimalInput, decimalPlaces = 12): string {
  return decimal(value).toDecimalPlaces(decimalPlaces, Decimal.ROUND_HALF_UP).toFixed(decimalPlaces);
}

export function safeRatio(numerator: DecimalInput, denominator: DecimalInput): string | null {
  const denominatorValue = decimal(denominator);
  if (denominatorValue.isZero()) return null;
  return decimalString(decimal(numerator).div(denominatorValue));
}

export type CapacityStatus = "SAFE" | "WARNING" | "TOO_LARGE";

export type CapacityResult = {
  status: CapacityStatus;
  currentTvl: string;
  postDepositTvl: string;
  capitalShare: string | null;
  dilution: string | null;
  recommendedMaxCapital: string;
};

export function calculateCapacity(currentTvl: DecimalInput, capital: DecimalInput): CapacityResult {
  const tvl = decimal(currentTvl);
  const deposit = decimal(capital);
  const post = tvl.plus(deposit);
  const share = tvl.isZero() ? null : deposit.div(tvl).toFixed(12);
  const dilution = tvl.isZero() ? null : deposit.div(post).toFixed(12);
  const status: CapacityStatus = tvl.isZero() || deposit.div(tvl).gt(5) ? "TOO_LARGE" : deposit.div(tvl).gt(1.2) ? "WARNING" : "SAFE";
  return {
    status,
    currentTvl: decimalString(tvl),
    postDepositTvl: decimalString(post),
    capitalShare: share,
    dilution,
    recommendedMaxCapital: decimalString(tvl.times("1.2")),
  };
}

export function estimateLpFee(lpFee: DecimalInput, currentTvl: DecimalInput, capital: DecimalInput): string | null {
  const tvl = decimal(currentTvl);
  if (tvl.lte(0)) return null;
  const capitalValue = decimal(capital);
  return decimalString(decimal(lpFee).times(capitalValue).div(tvl.plus(capitalValue)));
}

