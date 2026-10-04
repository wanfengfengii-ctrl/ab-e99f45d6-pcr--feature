import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { allocate, buildInstance } from '../src/allocate.js';
import { solve, type SolverInstance } from '../src/solver.js';
import { validateRequest } from '../src/validation.js';
import { formatMicro, riskToMicro } from '../src/decimal.js';
import { server } from '../src/server.js';
import type { AllocateRequest, RiskValue } from '../src/types.js';

/* ------------------------------ micro-unit core ------------------------------ */

test('micro-unit conversion round-trips canonical strings exactly', () => {
  assert.equal(riskToMicro('0'), 0);
  assert.equal(riskToMicro('0.000001'), 1);
  assert.equal(riskToMicro('0.1'), 100000);
  assert.equal(riskToMicro('3.141593'), 3141593);
  assert.equal(riskToMicro('9999999.999999'), 9999999999999);
  assert.equal(riskToMicro(7), 7000000);
  assert.equal(formatMicro(0), '0');
  assert.equal(formatMicro(1), '0.000001');
  assert.equal(formatMicro(100000), '0.1');
  assert.equal(formatMicro(1000000), '1');
  assert.equal(formatMicro(3141593), '3.141593');
  assert.equal(formatMicro(9999999999999), '9999999.999999');
  const canonical = ['0', '5', '10', '0.5', '3.141593', '0.000001', '9999999.999999', '123.4'];
  for (const s of canonical) assert.equal(formatMicro(riskToMicro(s)), s);
});

test('exact decimal sums: 0.1 + 0.2 stays 0.3 (binary float would drift)', () => {
  assert.equal(riskToMicro('0.1') + riskToMicro('0.2'), riskToMicro('0.3'));
  assert.ok(0.1 + 0.2 !== 0.3, 'premise: binary floats cannot represent this sum');
  assert.equal(formatMicro(riskToMicro('0.1') + riskToMicro('0.2')), '0.3');
});

/* -------------------------------- validation -------------------------------- */

const baseAmplicons = () =>
  Array.from({ length: 8 }, (_, i) => ({ name: `A${i}`, load: 10, isControl: true }));

const decimalBody = (): Record<string, unknown> => ({
  amplicons: baseAmplicons(),
  poolCount: 2,
  loadRange: { min: 30, max: 50 },
  riskPairs: [{ a: 'A0', b: 'A1', risk: '0.5' }],
  hardThreshold: '0.5',
});

test('validation accepts canonical decimal strings and mixed integer/string requests', () => {
  for (const v of ['0', '5', '10', '0.5', '3.141593', '0.000001', '9999999.999999']) {
    const body = decimalBody();
    (body.riskPairs as any[])[0].risk = v;
    assert.deepEqual(validateRequest(body), [], `risk "${v}" should be accepted`);
    const body2 = decimalBody();
    body2.hardThreshold = v;
    assert.deepEqual(validateRequest(body2), [], `hardThreshold "${v}" should be accepted`);
  }
  // integers and strings mixed freely in one request
  const mixed = decimalBody();
  mixed.hardThreshold = 3;
  (mixed.riskPairs as any[]).push({ a: 'A2', b: 'A3', risk: 2 });
  assert.deepEqual(validateRequest(mixed), []);
});

test('validation rejects non-canonical decimal strings at the exact field', () => {
  const bad = [
    '+1', '-1', '1e3', '1E-3', '1e+2', // signs and exponents
    '01', '00', '00.5', // leading zeros
    '1.50', '1.0', '0.10', '0.000010', // insignificant trailing zeros
    '.5', '1.', '1.1234567', // missing/too many fraction digits
    '10000000', '12345678.9', // beyond the exact-decimal range
    '', 'abc', ' 1', '1 ', '1,5', 'NaN', 'Infinity',
  ];
  for (const v of bad) {
    const body = decimalBody();
    (body.riskPairs as any[])[0].risk = v;
    const issues = validateRequest(body);
    assert.ok(
      issues.some((i) => i.field === 'riskPairs[0].risk'),
      `risk ${JSON.stringify(v)}: expected issue at riskPairs[0].risk, got ${JSON.stringify(issues)}`,
    );
    const body2 = decimalBody();
    body2.hardThreshold = v;
    const issues2 = validateRequest(body2);
    assert.ok(
      issues2.some((i) => i.field === 'hardThreshold'),
      `hardThreshold ${JSON.stringify(v)}: expected issue at hardThreshold, got ${JSON.stringify(issues2)}`,
    );
  }
});

test('validation: integer cap applies only when mixed with decimal strings', () => {
  // pure-integer requests keep the legacy semantics: any safe integer passes
  const legacy = {
    amplicons: baseAmplicons(),
    poolCount: 2,
    loadRange: { min: 30, max: 50 },
    riskPairs: [{ a: 'A0', b: 'A1', risk: 10000000 }],
    hardThreshold: 10000000,
  };
  assert.deepEqual(validateRequest(legacy), []);
  // the same integer is rejected once a decimal string is present anywhere
  const mixed = decimalBody();
  (mixed.riskPairs as any[]).push({ a: 'A2', b: 'A3', risk: 10000000 });
  const issues = validateRequest(mixed);
  assert.ok(issues.some((i) => i.field === 'riskPairs[1].risk'));
  const mixed2 = decimalBody();
  mixed2.hardThreshold = 10000000;
  assert.ok(validateRequest(mixed2).some((i) => i.field === 'hardThreshold'));
});

test('validation: legacy integer error messages are unchanged', () => {
  const body = {
    amplicons: baseAmplicons(),
    poolCount: 2,
    loadRange: { min: 30, max: 50 },
    riskPairs: [{ a: 'A0', b: 'A1', risk: -2 }],
    hardThreshold: -1,
  };
  const issues = validateRequest(body);
  assert.ok(
    issues.some((i) => i.field === 'riskPairs[0].risk' && i.message === 'must be a non-negative integer'),
  );
  assert.ok(
    issues.some((i) => i.field === 'hardThreshold' && i.message === 'must be a non-negative integer'),
  );
});

/* --------------------------- exact decimal allocation --------------------------- */

test('decimal mode: exact sums, string outputs and detail/summary consistency', () => {
  // Cross-forbid {A0..A3} against {A4..A7} with INTEGER risks mixed into a
  // decimal request: the only feasible layout co-locates A0..A3, so the
  // 0.1 + 0.2 sum must surface exactly as "0.3" everywhere.
  const cross: { a: string; b: string; risk: RiskValue }[] = [];
  for (const x of ['A0', 'A1', 'A2', 'A3']) {
    for (const y of ['A4', 'A5', 'A6', 'A7']) cross.push({ a: x, b: y, risk: 1 });
  }
  const req: AllocateRequest = {
    amplicons: baseAmplicons(),
    poolCount: 2,
    loadRange: { min: 40, max: 40 },
    riskPairs: [
      { a: 'A0', b: 'A1', risk: '0.1' },
      { a: 'A2', b: 'A3', risk: '0.2' },
      ...cross,
    ],
    hardThreshold: '0.4',
  };
  const res = allocate(req);
  assert.equal(res.feasible, true);

  // every risk figure is a canonical string
  assert.equal(res.maxPoolRisk, '0.3');
  assert.equal(res.totalRisk, '0.3');
  assert.equal(typeof res.loadSpread, 'number');

  const heavy = res.pools!.find((p) => p.members.includes('A0'))!;
  assert.deepEqual([...heavy.members].sort(), ['A0', 'A1', 'A2', 'A3']);
  assert.equal(heavy.riskSum, '0.3');
  assert.deepEqual(heavy.riskPairs, [
    { a: 'A0', b: 'A1', risk: '0.1' },
    { a: 'A2', b: 'A3', risk: '0.2' },
  ]);

  // independent recomputation: pool detail sums, totals and max must agree
  let totalMicro = 0;
  let maxMicro = 0;
  for (const p of res.pools!) {
    const sum = p.riskPairs.reduce((t, rp) => t + riskToMicro(rp.risk), 0);
    assert.equal(riskToMicro(p.riskSum), sum, `pool ${p.pool} riskSum equals its pair sum`);
    totalMicro += sum;
    maxMicro = Math.max(maxMicro, sum);
    for (const rp of p.riskPairs) {
      assert.equal(typeof rp.risk, 'string');
      assert.ok(riskToMicro(rp.risk) < riskToMicro(req.hardThreshold), 'no forbidden pair co-located');
    }
  }
  assert.equal(riskToMicro(res.totalRisk!), totalMicro, 'totalRisk equals the pool sums');
  assert.equal(riskToMicro(res.maxPoolRisk!), maxMicro, 'maxPoolRisk equals the largest pool sum');

  // forbidden pairs really are separated
  const where = new Map(res.assignment!.map((a) => [a.amplicon, a.pool]));
  for (const rp of req.riskPairs) {
    if (riskToMicro(rp.risk) >= riskToMicro(req.hardThreshold)) {
      assert.notEqual(where.get(rp.a), where.get(rp.b), `forbidden ${rp.a}/${rp.b} separated`);
    }
  }
});

test('decimal threshold adjudication: equality forbids, one micro below allows', () => {
  const mkReq = (risk: string, threshold: string): AllocateRequest => ({
    amplicons: baseAmplicons(),
    poolCount: 2,
    loadRange: { min: 40, max: 40 },
    riskPairs: [
      { a: 'A0', b: 'A1', risk },
      { a: 'A0', b: 'A2', risk },
      { a: 'A1', b: 'A2', risk },
    ],
    hardThreshold: threshold,
  });
  // risk == threshold -> K3 forbidden clique, cannot fit into 2 pools
  const forbidden = allocate(mkReq('0.3', '0.3'));
  assert.equal(forbidden.feasible, false);
  assert.deepEqual(
    forbidden.conflictSummary!.forbiddenPairs,
    [
      { a: 'A0', b: 'A1', risk: '0.3' },
      { a: 'A0', b: 'A2', risk: '0.3' },
      { a: 'A1', b: 'A2', risk: '0.3' },
    ],
    'conflict summary reports canonical decimal strings',
  );
  assert.deepEqual(new Set(forbidden.conflictSummary!.overCapacityClique), new Set(['A0', 'A1', 'A2']));

  // one micro below the threshold -> pairs allowed, feasible; the optimum
  // co-locates exactly one of the three pairs (pigeonhole over 2 pools)
  const allowed = allocate(mkReq('0.299999', '0.3'));
  assert.equal(allowed.feasible, true);
  assert.equal(allowed.maxPoolRisk, '0.299999');
  assert.equal(allowed.totalRisk, '0.299999');
});

test('decimal mode: unlisted pairs still count as zero risk', () => {
  // Force {A0..A3} into one pool via integer cross-forbids (mixed formats):
  // the listed decimal pair must surface while every unlisted pair stays 0.
  const cross: { a: string; b: string; risk: RiskValue }[] = [];
  for (const x of ['A0', 'A1', 'A2', 'A3']) {
    for (const y of ['A4', 'A5', 'A6', 'A7']) cross.push({ a: x, b: y, risk: 1 });
  }
  const req: AllocateRequest = {
    amplicons: baseAmplicons(),
    poolCount: 2,
    loadRange: { min: 40, max: 40 },
    riskPairs: [{ a: 'A0', b: 'A1', risk: '0.25' }, ...cross],
    hardThreshold: '0.9',
  };
  const res = allocate(req);
  assert.equal(res.feasible, true);
  assert.equal(res.totalRisk, '0.25');
  assert.equal(res.maxPoolRisk, '0.25');
  const withPair = res.pools!.find((p) => p.riskPairs.length > 0)!;
  assert.equal(withPair.riskSum, '0.25');
  assert.deepEqual(withPair.riskPairs, [{ a: 'A0', b: 'A1', risk: '0.25' }]);
  const without = res.pools!.find((p) => p.riskPairs.length === 0)!;
  assert.equal(without.riskSum, '0');
});

/* --------------------- differential test vs exact oracle --------------------- */

interface OracleResult {
  assignment: number[];
  maxRisk: number;
  totalRisk: number;
  spread: number;
}

/** Brute-force oracle over the instance's (already scaled) risk matrix. */
function oracle(inst: SolverInstance): OracleResult | null {
  const { n, k, loads, isControl, risk, forbidden, minLoad, maxLoad } = inst;
  let best: OracleResult | null = null;
  const assign = new Array<number>(n).fill(0);
  const enumerate = (u: number): void => {
    if (u === n) {
      const pl = new Array<number>(k).fill(0);
      const pr = new Array<number>(k).fill(0);
      const pc = new Array<number>(k).fill(0);
      const used = new Array<boolean>(k).fill(false);
      for (let i = 0; i < n; i++) {
        const j = assign[i]!;
        pl[j]! += loads[i]!;
        pc[j]! += isControl[i] ? 1 : 0;
        used[j] = true;
        for (let w = 0; w < i; w++) {
          if (assign[w] === j) pr[j]! += risk[i * n + w]!;
        }
      }
      for (let j = 0; j < k; j++) {
        if (!used[j] || pl[j]! < minLoad || pl[j]! > maxLoad || pc[j] === 0) return;
        for (let i = 0; i < n; i++) {
          if (assign[i] !== j) continue;
          for (let w = i + 1; w < n; w++) {
            if (assign[w] === j && forbidden[i * n + w]) return;
          }
        }
      }
      const maxRisk = Math.max(...pr);
      const totalRisk = pr.reduce((a, b) => a + b, 0);
      const spread = Math.max(...pl) - Math.min(...pl);
      const cand: OracleResult = { assignment: [...assign], maxRisk, totalRisk, spread };
      if (
        best === null ||
        cand.maxRisk < best.maxRisk ||
        (cand.maxRisk === best.maxRisk && cand.totalRisk < best.totalRisk) ||
        (cand.maxRisk === best.maxRisk &&
          cand.totalRisk === best.totalRisk &&
          cand.spread < best.spread) ||
        (cand.maxRisk === best.maxRisk &&
          cand.totalRisk === best.totalRisk &&
          cand.spread === best.spread &&
          lex(cand.assignment, best.assignment) < 0)
      ) {
        best = cand;
      }
      return;
    }
    for (let j = 0; j < k; j++) {
      assign[u] = j;
      enumerate(u + 1);
    }
  };
  enumerate(0);
  return best;
}

function lex(a: number[], b: number[]): number {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i]! - b[i]!;
  }
  return 0;
}

function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

test('decimal solver matches exact oracle on random mixed integer/string instances', () => {
  const rng = makeRng(20261004);
  let feasibleCount = 0;
  const randRisk = (): RiskValue => {
    if (rng() < 0.4) return 1 + Math.floor(rng() * 9); // legacy integer
    const intPart = Math.floor(rng() * 10);
    const fracLen = 1 + Math.floor(rng() * 6);
    let frac = '';
    for (let i = 0; i < fracLen; i++) frac += Math.floor(rng() * 10);
    frac = frac.replace(/0+$/, '');
    return frac === '' ? String(intPart) : `${intPart}.${frac}`;
  };
  for (let t = 0; t < 300; t++) {
    const n = 4 + Math.floor(rng() * 5); // 4..8
    const k = 2 + Math.floor(rng() * 2); // 2..3
    const names = Array.from({ length: n }, (_, i) => `A${i}`);
    const loads = Array.from({ length: n }, () => 1 + Math.floor(rng() * 6));
    const isControl = Array.from({ length: n }, () => rng() < 0.45);
    if (!isControl.some(Boolean)) isControl[0] = true;
    const total = loads.reduce((a, b) => a + b, 0);
    const minLoad = 1 + Math.floor(rng() * Math.min(4, Math.floor(total / k)));
    const maxLoad = Math.max(minLoad, Math.floor(total / k) + Math.floor(rng() * 8));
    const threshold: RiskValue = rng() < 0.5 ? 5 : randRisk();
    const riskPairs: { a: string; b: string; risk: RiskValue }[] = [];
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        if (rng() < 0.45) {
          riskPairs.push({ a: names[i]!, b: names[j]!, risk: randRisk() });
        }
      }
    }
    // guarantee decimal mode for this test
    if (!riskPairs.some((p) => typeof p.risk === 'string') && typeof threshold !== 'string') {
      riskPairs.push({ a: names[0]!, b: names[1]!, risk: '0.5' });
    }
    const req: AllocateRequest = {
      amplicons: names.map((name, i) => ({ name, load: loads[i]!, isControl: isControl[i]! })),
      poolCount: k,
      loadRange: { min: minLoad, max: maxLoad },
      riskPairs,
      hardThreshold: threshold,
    };
    const inst = buildInstance(req);
    assert.equal(inst.decimal, true, 'test premise: decimal mode active');
    const expected = oracle(inst);
    const actual = solve(inst);
    if (expected === null) {
      assert.equal(actual, null, `case ${t}: solver should report infeasible`);
    } else {
      feasibleCount++;
      assert.ok(actual, `case ${t}: solver should find a solution`);
      assert.deepEqual(
        [actual!.maxRisk, actual!.totalRisk, actual!.spread, actual!.assignment],
        [expected.maxRisk, expected.totalRisk, expected.spread, expected.assignment],
        `case ${t}: objective mismatch`,
      );
    }
  }
  assert.ok(feasibleCount > 50, `expected many feasible random cases, got ${feasibleCount}`);
});

/* --------------------------------- HTTP layer -------------------------------- */

async function startServer(): Promise<number> {
  server.listen(0);
  await once(server, 'listening');
  const addr = server.address();
  if (typeof addr === 'object' && addr) return addr.port;
  throw new Error('no port');
}

async function post(port: number, body: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`http://127.0.0.1:${port}/api/pools/allocate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

test('HTTP: decimal mode returns canonical strings, bad strings get field-located 400s', async () => {
  const port = await startServer();

  const ok = await post(port, decimalBody());
  assert.equal(ok.status, 200);
  assert.equal(ok.json.feasible, true);
  assert.equal(typeof ok.json.maxPoolRisk, 'string');
  assert.equal(typeof ok.json.totalRisk, 'string');
  for (const p of ok.json.pools) {
    assert.equal(typeof p.riskSum, 'string');
    for (const rp of p.riskPairs) assert.equal(typeof rp.risk, 'string');
  }

  // malformed decimal strings are located precisely
  const bad = await post(port, {
    ...decimalBody(),
    riskPairs: [{ a: 'A0', b: 'A1', risk: '+1.5' }],
    hardThreshold: '0.50',
  });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error, 'validation_failed');
  const fields = new Set(bad.json.issues.map((i: any) => i.field));
  assert.ok(fields.has('riskPairs[0].risk'));
  assert.ok(fields.has('hardThreshold'));

  // pure-integer requests keep numeric risk fields (regression guard)
  const legacy = await post(port, {
    amplicons: baseAmplicons(),
    poolCount: 2,
    loadRange: { min: 30, max: 50 },
    riskPairs: [{ a: 'A0', b: 'A1', risk: 2 }],
    hardThreshold: 5,
  });
  assert.equal(legacy.status, 200);
  assert.equal(typeof legacy.json.maxPoolRisk, 'number');
  assert.equal(typeof legacy.json.totalRisk, 'number');
  for (const p of legacy.json.pools) assert.equal(typeof p.riskSum, 'number');

  // decimal infeasible: conflict summary carries canonical strings
  const infeasible = await post(port, {
    amplicons: baseAmplicons(),
    poolCount: 2,
    loadRange: { min: 40, max: 40 },
    riskPairs: [
      { a: 'A0', b: 'A1', risk: '0.5' },
      { a: 'A0', b: 'A2', risk: '0.5' },
      { a: 'A1', b: 'A2', risk: '0.5' },
    ],
    hardThreshold: '0.5',
  });
  assert.equal(infeasible.status, 200);
  assert.equal(infeasible.json.feasible, false);
  assert.ok(
    infeasible.json.conflictSummary.forbiddenPairs.every(
      (p: any) => typeof p.risk === 'string' && p.risk === '0.5',
    ),
  );

  after(() => server.close());
});
