/**
 * Exact canonical decimal arithmetic for dimer-risk values.
 *
 * Accepted risk inputs are either:
 *   - non-negative safe integers (JSON numbers, the historical format), or
 *   - canonical decimal strings with at most six fractional digits.
 *
 * A canonical decimal string is the unique short spelling of a finite,
 * non-negative decimal: no sign, no exponent, no leading zeros (other than a
 * single zero before the dot), and no meaningless trailing zeros
 * (e.g. "0", "12", "0.5", "999999.999999"; NOT "+1", "1e3", "01", "1.00").
 *
 * Internally every value is an integer count of micro-units (10^-6) carried as
 * a bigint, so threshold comparisons and risk sums are exact even when an
 * integer input is as large as Number.MAX_SAFE_INTEGER. There are at most
 * n*(n-1)/2 = 153 listed pairs per request (n <= 18), so sums stay small.
 */

export const DECIMAL_DIGITS = 6;
const MICRO = 10n ** BigInt(DECIMAL_DIGITS);

/**
 * Canonical decimal string, strict:
 *   - digits only, optional single fractional part of 1..6 digits
 *   - integer part is "0" or starts with a non-zero digit
 *   - last fractional digit is non-zero (no meaningless trailing zeros)
 */
const CANONICAL_RE = /^(?:0|[1-9][0-9]*)(?:\.[0-9]{0,5}[1-9])?$/;

export function isCanonicalDecimalString(v: unknown): v is string {
  return typeof v === 'string' && CANONICAL_RE.test(v);
}

/** Parse a validated input value into exact micro-units. */
export function toMicroUnits(v: number | string): bigint {
  if (typeof v === 'number') {
    // A non-negative safe integer by validation.
    return BigInt(v) * MICRO;
  }
  const dot = v.indexOf('.');
  if (dot === -1) return BigInt(v) * MICRO;
  const whole = v.slice(0, dot);
  const frac = v.slice(dot + 1).padEnd(DECIMAL_DIGITS, '0');
  return BigInt(whole) * MICRO + BigInt(frac);
}

/** Render exact micro-units as a canonical decimal string (no meaningless zeros). */
export function canonicalMicro(v: bigint): string {
  const whole = v / MICRO;
  const frac = v % MICRO;
  if (frac === 0n) return whole.toString();
  const fracPart = frac
    .toString()
    .padStart(DECIMAL_DIGITS, '0')
    .replace(/0+$/, '');
  return `${whole.toString()}.${fracPart}`;
}
