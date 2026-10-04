import type { AllocateRequest, ValidationIssue } from './types.js';
import {
  CANONICAL_DECIMAL_RE,
  MAX_DECIMAL_INT_DIGITS,
  MAX_DECIMAL_INT_VALUE,
  decimalIntDigits,
} from './decimal.js';

const isInt = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v);

/** True when any risk figure in the request uses the decimal-string format. */
function hasDecimalString(req: Record<string, unknown>): boolean {
  if (typeof req.hardThreshold === 'string') return true;
  if (Array.isArray(req.riskPairs)) {
    for (const item of req.riskPairs) {
      if (
        item !== null &&
        typeof item === 'object' &&
        !Array.isArray(item) &&
        typeof (item as Record<string, unknown>).risk === 'string'
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Validate one risk score / threshold value. Returns the issue message, or
 * null when valid. Non-string values keep the legacy integer message so
 * pure-integer requests see unchanged error semantics.
 */
function riskValueIssue(v: unknown, decimalMode: boolean): string | null {
  if (typeof v === 'string') {
    if (!CANONICAL_DECIMAL_RE.test(v)) {
      return 'must be a canonical decimal string: non-negative, no sign, no exponent, no leading zeros, with 1 to 6 fraction digits';
    }
    if (v.includes('.') && v.endsWith('0')) {
      return 'must not carry insignificant trailing zeros (write "1.5", not "1.50")';
    }
    if (decimalIntDigits(v) > MAX_DECIMAL_INT_DIGITS) {
      return `exceeds the exact-decimal limit of ${MAX_DECIMAL_INT_VALUE}.999999`;
    }
    return null;
  }
  if (!isInt(v) || v < 0) {
    return 'must be a non-negative integer';
  }
  if (decimalMode && v > MAX_DECIMAL_INT_VALUE) {
    return `exceeds the exact-decimal limit of ${MAX_DECIMAL_INT_VALUE} for integer values mixed with decimal strings`;
  }
  return null;
}

/**
 * Validate a parsed request body. Returns the list of issues with field
 * locators (array indices included); an empty list means the request is valid.
 */
export function validateRequest(body: unknown): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    issues.push({ field: '$', message: 'request body must be a JSON object' });
    return issues;
  }
  const req = body as Record<string, unknown>;
  const decimalMode = hasDecimalString(req);

  // ---- amplicons ----
  const ampliconsPath = 'amplicons';
  if (!Array.isArray(req.amplicons)) {
    issues.push({ field: ampliconsPath, message: 'must be an array' });
  } else {
    const list = req.amplicons;
    if (list.length < 8 || list.length > 18) {
      issues.push({
        field: ampliconsPath,
        message: `must contain between 8 and 18 amplicons (got ${list.length})`,
      });
    }
    const seen = new Map<string, number>();
    list.forEach((item, i) => {
      const p = `${ampliconsPath}[${i}]`;
      if (typeof item !== 'object' || item === null || Array.isArray(item)) {
        issues.push({ field: p, message: 'must be an object' });
        return;
      }
      const amp = item as Record<string, unknown>;
      if (typeof amp.name !== 'string' || amp.name.trim() === '') {
        issues.push({ field: `${p}.name`, message: 'must be a non-empty string' });
      } else if (seen.has(amp.name)) {
        issues.push({
          field: `${p}.name`,
          message: `duplicate amplicon name "${amp.name}", first seen at index ${seen.get(amp.name)}`,
        });
      } else {
        seen.set(amp.name, i);
      }
      if (!isInt(amp.load) || amp.load <= 0) {
        issues.push({ field: `${p}.load`, message: 'must be a positive integer' });
      }
      if (typeof amp.isControl !== 'boolean') {
        issues.push({ field: `${p}.isControl`, message: 'must be a boolean' });
      }
    });
  }

  // ---- poolCount ----
  if (!('poolCount' in req)) {
    issues.push({ field: 'poolCount', message: 'is required' });
  } else if (!isInt(req.poolCount) || req.poolCount < 2 || req.poolCount > 4) {
    issues.push({ field: 'poolCount', message: 'must be an integer between 2 and 4' });
  }

  // ---- loadRange ----
  if (typeof req.loadRange !== 'object' || req.loadRange === null || Array.isArray(req.loadRange)) {
    issues.push({ field: 'loadRange', message: 'must be an object {min, max}' });
  } else {
    const lr = req.loadRange as Record<string, unknown>;
    if (!isInt(lr.min) || lr.min <= 0) {
      issues.push({ field: 'loadRange.min', message: 'must be a positive integer' });
    }
    if (!isInt(lr.max) || lr.max <= 0) {
      issues.push({ field: 'loadRange.max', message: 'must be a positive integer' });
    }
    if (isInt(lr.min) && isInt(lr.max) && lr.min > lr.max) {
      issues.push({ field: 'loadRange', message: 'min must not exceed max' });
    }
  }

  // ---- hardThreshold ----
  if (!('hardThreshold' in req)) {
    issues.push({ field: 'hardThreshold', message: 'is required' });
  } else {
    const msg = riskValueIssue(req.hardThreshold, decimalMode);
    if (msg !== null) issues.push({ field: 'hardThreshold', message: msg });
  }

  // ---- riskPairs ----
  if (!('riskPairs' in req)) {
    issues.push({ field: 'riskPairs', message: 'is required' });
  } else if (!Array.isArray(req.riskPairs)) {
    issues.push({ field: 'riskPairs', message: 'must be an array' });
  } else {
    const names = new Set<string>(
      Array.isArray(req.amplicons)
        ? req.amplicons
            .map((a) => (a && typeof a === 'object' ? (a as Record<string, unknown>).name : undefined))
            .filter((n): n is string => typeof n === 'string')
        : [],
    );
    const pairKeys = new Set<string>();
    req.riskPairs.forEach((item, i) => {
      const p = `riskPairs[${i}]`;
      if (typeof item !== 'object' || item === null || Array.isArray(item)) {
        issues.push({ field: p, message: 'must be an object' });
        return;
      }
      const rp = item as Record<string, unknown>;
      for (const k of ['a', 'b'] as const) {
        if (typeof rp[k] !== 'string' || rp[k] === '') {
          issues.push({ field: `${p}.${k}`, message: 'must be a non-empty amplicon name' });
        } else if (!names.has(rp[k])) {
          issues.push({ field: `${p}.${k}`, message: `unknown amplicon name "${rp[k]}"` });
        }
      }
      const riskMsg = riskValueIssue(rp.risk, decimalMode);
      if (riskMsg !== null) {
        issues.push({ field: `${p}.risk`, message: riskMsg });
      }
      if (typeof rp.a === 'string' && typeof rp.b === 'string' && rp.a === rp.b) {
        issues.push({ field: p, message: 'a and b must reference different amplicons' });
      }
      if (typeof rp.a === 'string' && typeof rp.b === 'string' && rp.a !== rp.b) {
        const key = rp.a < rp.b ? `${rp.a}${rp.b}` : `${rp.b}${rp.a}`;
        if (pairKeys.has(key)) {
          issues.push({ field: p, message: `duplicate pair (${rp.a}, ${rp.b}); merge it into one entry` });
        } else {
          pairKeys.add(key);
        }
      }
    });
  }

  return issues;
}

export function asRequest(body: unknown): AllocateRequest {
  return body as AllocateRequest;
}
