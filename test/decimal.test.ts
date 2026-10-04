import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalMicro,
  isCanonicalDecimalString,
  toMicroUnits,
} from '../src/decimal.js';

test('canonical decimal strings: accepted spellings', () => {
  for (const s of ['0', '1', '12', '9007199254740993', '0.1', '0.05', '0.000001', '12.345678', '999999.999999']) {
    assert.equal(isCanonicalDecimalString(s), true, s);
  }
});

test('canonical decimal strings: rejected spellings', () => {
  const bad = [
    '',
    '+1',
    '-0.5',
    '1e3',
    '1E0',
    '1.5e1',
    '01',
    '00.5',
    '.5',
    '1.',
    '1.0',
    '1.00',
    '0.0',
    '0.10',
    '0.0500',
    '0.000000',
    '1.0000010',
    '1.0000001', // seven fractional digits
    ' 1',
    '1 ',
    '1_000',
    'NaN',
    'Infinity',
  ];
  for (const s of bad) {
    assert.equal(isCanonicalDecimalString(s), false, JSON.stringify(s));
  }
  assert.equal(isCanonicalDecimalString(1), false);
  assert.equal(isCanonicalDecimalString(null), false);
});

test('toMicroUnits: exact micro-unit conversion, mixed int/string', () => {
  assert.equal(toMicroUnits(0), 0n);
  assert.equal(toMicroUnits(9), 9_000_000n);
  assert.equal(toMicroUnits('0'), 0n);
  assert.equal(toMicroUnits('9'), 9_000_000n);
  assert.equal(toMicroUnits('0.5'), 500_000n);
  assert.equal(toMicroUnits('0.000001'), 1n);
  assert.equal(toMicroUnits('12.345678'), 12_345_678n);
  // Integers larger than float-safe fractional handling stay exact as strings.
  assert.equal(toMicroUnits('9007199254740993'), 9_007_199_254_740_993_000_000n);
});

test('canonicalMicro: renders without meaningless zeros', () => {
  assert.equal(canonicalMicro(0n), '0');
  assert.equal(canonicalMicro(9_000_000n), '9');
  assert.equal(canonicalMicro(500_000n), '0.5');
  assert.equal(canonicalMicro(1n), '0.000001');
  assert.equal(canonicalMicro(12_345_678n), '12.345678');
  assert.equal(canonicalMicro(10_050_000n), '10.05');
});

test('parse/render round trip preserves every accepted value', () => {
  for (const s of ['0', '7', '0.1', '0.05', '0.000001', '12.345678', '999999.999999']) {
    assert.equal(canonicalMicro(toMicroUnits(s)), s);
  }
});
