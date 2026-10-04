/**
 * Exact-decimal risk support (thermodynamic-upgrade format).
 *
 * Upgraded thermodynamic evaluation emits fractional dimer risks. To keep
 * every threshold comparison, per-pool sum, max/total aggregation and the
 * four-level adjudication exact — no binary floating-point rounding may flip
 * a forbidden-pair decision or re-order equally good allocations — canonical
 * decimal strings are converted to integers in micro-units (value × 1e6).
 *
 * Input limits (at most 7 integer digits, at most 6 fraction digits) keep
 * every reachable sum far below 2^53 (a pool can hold at most C(17,2)=136
 * listed pairs; 136 × 9999999.999999 × 1e6 ≈ 1.4e15 << 9.0e15), so plain
 * number arithmetic on the scaled integers stays exact end to end.
 */

/** Micro-units per unit: six fraction digits are represented exactly. */
export const DECIMAL_SCALE = 1_000_000;

/** Largest accepted integer-part digit count for decimal-string values. */
export const MAX_DECIMAL_INT_DIGITS = 7;

/** Largest accepted value: 9999999.999999. */
export const MAX_DECIMAL_INT_VALUE = 9_999_999;

/**
 * Canonical decimal shape: no sign, no exponent, no leading zeros, and when a
 * fraction is present it carries 1..6 digits. Insignificant trailing zeros in
 * the fraction are rejected separately for a clearer message.
 */
export const CANONICAL_DECIMAL_RE = /^(0|[1-9]\d*)(\.\d{1,6})?$/;

/** True when the string is canonical AND carries no insignificant trailing zero. */
export function isCanonicalDecimalString(v: unknown): v is string {
  return (
    typeof v === 'string' &&
    CANONICAL_DECIMAL_RE.test(v) &&
    !(v.includes('.') && v.endsWith('0'))
  );
}

/** Number of integer-part digits of a regex-valid decimal string. */
export function decimalIntDigits(s: string): number {
  const dot = s.indexOf('.');
  return dot === -1 ? s.length : dot;
}

/** Parse a canonical decimal string into exact micro-units. */
export function parseDecimalToMicro(s: string): number {
  const dot = s.indexOf('.');
  if (dot === -1) return Number(s) * DECIMAL_SCALE;
  const intPart = Number(s.slice(0, dot));
  const fracStr = s.slice(dot + 1);
  const frac = Number(fracStr) * 10 ** (6 - fracStr.length);
  return intPart * DECIMAL_SCALE + frac;
}

/** Convert an accepted risk/threshold input (integer or string) to micro-units. */
export function riskToMicro(v: number | string): number {
  return typeof v === 'string' ? parseDecimalToMicro(v) : v * DECIMAL_SCALE;
}

/**
 * Render micro-units as the canonical response string: insignificant zeros
 * are stripped, integral values come back without a fraction (e.g. "3",
 * "0.3", "0.000001").
 */
export function formatMicro(micro: number): string {
  const frac = micro % DECIMAL_SCALE;
  const intPart = (micro - frac) / DECIMAL_SCALE;
  if (frac === 0) return String(intPart);
  const fracStr = String(frac).padStart(6, '0').replace(/0+$/, '');
  return `${intPart}.${fracStr}`;
}
