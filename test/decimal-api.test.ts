import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { server } from '../src/server.js';
import { validateRequest } from '../src/validation.js';
import type { AllocateRequest } from '../src/types.js';

const baseBody = (): AllocateRequest => ({
  amplicons: Array.from({ length: 8 }, (_, i) => ({
    name: `A${i}`,
    load: 10,
    isControl: true,
  })),
  poolCount: 2,
  loadRange: { min: 40, max: 40 },
  riskPairs: [],
  hardThreshold: '9',
});

async function startServer(): Promise<number> {
  server.listen(0);
  await once(server, 'listening');
  const addr = server.address();
  if (typeof addr === 'object' && addr) return addr.port;
  throw new Error('no port');
}

async function post(port: number, body: unknown) {
  const res = await fetch(`http://127.0.0.1:${port}/api/pools/allocate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

test('validation accepts canonical decimal risks and a decimal threshold', () => {
  const body = baseBody();
  body.riskPairs = [
    { a: 'A0', b: 'A1', risk: '0.05' },
    { a: 'A2', b: 'A3', risk: 5 }, // integer numbers may be mixed with strings
    { a: 'A4', b: 'A5', risk: '0.000001' },
  ];
  assert.deepEqual(validateRequest(body), []);
});

test('validation locates non-canonical risk strings at their fields', () => {
  const cases: { risk: unknown; fields: string[] }[] = [
    { risk: '+2', fields: ['riskPairs[0].risk'] },
    { risk: '-0.5', fields: ['riskPairs[0].risk'] },
    { risk: '1e1', fields: ['riskPairs[0].risk'] },
    { risk: '01', fields: ['riskPairs[0].risk'] },
    { risk: '1.50', fields: ['riskPairs[0].risk'] },
    { risk: '0.0500', fields: ['riskPairs[0].risk'] },
    { risk: '0.0000001', fields: ['riskPairs[0].risk'] },
  ];
  for (const { risk, fields } of cases) {
    const body = baseBody();
    (body.riskPairs as unknown[]).push({ a: 'A0', b: 'A1', risk });
    const issues = validateRequest(body);
    for (const f of fields) {
      assert.ok(issues.some((i) => i.field === f), `${String(risk)}: missing issue at ${f}`);
    }
  }

  for (const t of ['+2', '-0.5', '1e1', '01', '1.0', '1.50']) {
    const body = baseBody();
    body.hardThreshold = t as never;
    assert.ok(
      validateRequest(body).some((i) => i.field === 'hardThreshold'),
      `threshold ${t} must be rejected at hardThreshold`,
    );
  }
});

/* Exact decimal parsing for client-side re-computation (mirrors the service). */
function toMicro(v: string | number): bigint {
  if (typeof v === 'number') return BigInt(Math.round(v * 1e6));
  const d = v.indexOf('.');
  if (d === -1) return BigInt(v) * 1_000_000n;
  return (
    BigInt(v.slice(0, d)) * 1_000_000n +
    BigInt(v.slice(d + 1).padEnd(6, '0'))
  );
}

test('decimal mode: risk values come back as canonical strings, exactly summed',
  async () => {
    const port = await startServer();
    const body = baseBody();
    body.riskPairs = [
      { a: 'A0', b: 'A1', risk: '0.1' },
      { a: 'A0', b: 'A2', risk: '0.2' },
      { a: 'A1', b: 'A2', risk: 7 }, // integers may be mixed in
      { a: 'A3', b: 'A4', risk: '0.000001' },
    ];
    body.hardThreshold = '9';
    const r = await post(port, body);
    assert.equal(r.status, 200);
    assert.equal(r.json.feasible, true);

    assert.equal(typeof r.json.maxPoolRisk, 'string');
    assert.equal(typeof r.json.totalRisk, 'string');
    for (const p of r.json.pools) {
      assert.equal(typeof p.riskSum, 'string');
      for (const rp of p.riskPairs) assert.equal(typeof rp.risk, 'string');
    }

    // Detail and summary must agree, recomputed exactly from the pair list.
    let total = 0n;
    let max = 0n;
    for (const p of r.json.pools) {
      let sum = 0n;
      for (const rp of p.riskPairs) {
        assert.match(rp.risk, /^(?:0|[1-9][0-9]*)(?:\.[0-9]{0,5}[1-9])?$/);
        sum += toMicro(rp.risk);
      }
      assert.equal(sum, toMicro(p.riskSum), `pool ${p.pool} riskSum matches its pairs`);
      if (sum > max) max = sum;
      total += sum;
    }
    assert.equal(total, toMicro(r.json.totalRisk), 'totalRisk equals sum of pool sums');
    assert.equal(max, toMicro(r.json.maxPoolRisk), 'maxPoolRisk equals largest pool sum');

    after(() => server.close());
  });

test('precision trap: exact decimal beats float64 accumulation', async () => {
  const port = await startServer();
  // Values like 0.07/0.2/0.3 mis-order under float64 summation: a naive
  // double-based optimizer selects a partition whose true total is 0.57, while
  // exact decimal comparison finds 0.56.
  const edges: [number, number, string][] = [
    [0, 1, '0.05'], [0, 3, '0.07'], [0, 6, '0.2'], [0, 7, '0.07'],
    [1, 6, '0.3'], [2, 3, '0.3'], [2, 4, '0.05'], [2, 6, '0.05'],
    [2, 7, '0.2'], [3, 4, '0.2'], [3, 5, '0.2'], [3, 7, '0.07'],
    [4, 7, '0.07'], [5, 6, '0.2'], [6, 7, '0.3'],
  ];
  const body = baseBody();
  body.riskPairs = edges.map(([a, b, risk]) => ({ a: `A${a}`, b: `A${b}`, risk }));
  const r = await post(port, body);
  assert.equal(r.status, 200);
  assert.equal(r.json.feasible, true);
  assert.equal(r.json.maxPoolRisk, '0.3');
  assert.equal(r.json.totalRisk, '0.56');
  assert.deepEqual(
    r.json.assignment.map((x: { pool: number }) => x.pool),
    [1, 1, 2, 1, 2, 2, 2, 1],
  );

  // Independent exact re-verification of forbidden separation and summaries.
  const threshold = toMicro(body.hardThreshold);
  for (const p of r.json.pools) {
    for (const rp of p.riskPairs) assert.ok(toMicro(rp.risk) < threshold);
  }

  after(() => server.close());
});

test('threshold comparisons are exact at the fractional boundary', async () => {
  const port = await startServer();

  // A 3-clique into 2 pools: feasible exactly when the edges are NOT forbidden.
  // 8.999999 is one micro-unit below 9 and must stay a soft pair.
  const justBelow: AllocateRequest = {
    amplicons: Array.from({ length: 8 }, (_, i) => ({
      name: `A${i}`,
      load: 10,
      isControl: true,
    })),
    poolCount: 2,
    loadRange: { min: 10, max: 400 },
    riskPairs: [
      { a: 'A0', b: 'A1', risk: '8.999999' },
      { a: 'A0', b: 'A2', risk: '8.999999' },
      { a: 'A1', b: 'A2', risk: '8.999999' },
    ],
    hardThreshold: '9',
  };
  const rb = await post(port, justBelow);
  assert.equal(rb.status, 200);
  assert.equal(rb.json.feasible, true, '8.999999 < 9 is not forbidden');
  // One edge of the triangle must share a pool; its risk is echoed at full
  // precision, proving no rounding promoted it to the threshold.
  const shared = rb.json.pools.flatMap((p: any) => p.riskPairs);
  assert.ok(shared.some((rp: any) => rp.risk === '8.999999'));

  // Equality forbids: a 0.3 edge against a 0.3 threshold must separate the pair.
  const equal = baseBody();
  equal.riskPairs = [{ a: 'A0', b: 'A1', risk: '0.3' }];
  equal.hardThreshold = '0.3';
  const re = await post(port, equal);
  assert.equal(re.status, 200);
  assert.equal(re.json.feasible, true);
  const whereE = new Map(re.json.assignment.map((x: any) => [x.amplicon, x.pool]));
  assert.notEqual(whereE.get('A0'), whereE.get('A1'), 'risk == threshold is forbidden');

  after(() => server.close());
});

test('decimal infeasible response uses canonical strings in the conflict summary',
  async () => {
    const port = await startServer();
    const body: AllocateRequest = {
      amplicons: Array.from({ length: 8 }, (_, i) => ({
        name: `A${i}`,
        load: 10,
        isControl: true,
      })),
      poolCount: 2,
      loadRange: { min: 10, max: 400 },
      riskPairs: [
        { a: 'A0', b: 'A1', risk: '9.5' },
        { a: 'A0', b: 'A2', risk: '9.5' },
        { a: 'A1', b: 'A2', risk: '9.5' },
      ],
      hardThreshold: '9.5',
    };
    const r = await post(port, body);
    assert.equal(r.status, 200);
    assert.equal(r.json.feasible, false);
    const pairs = r.json.conflictSummary.forbiddenPairs;
    assert.equal(pairs.length, 3);
    for (const p of pairs) {
      assert.equal(typeof p.risk, 'string');
      assert.equal(p.risk, '9.5', 'no meaningless trailing zeros');
    }
    assert.deepEqual(
      new Set(r.json.conflictSummary.overCapacityClique),
      new Set(['A0', 'A1', 'A2']),
    );

    after(() => server.close());
  });

test('pure integer requests keep numeric response fields', async () => {
  const port = await startServer();
  const body = baseBody();
  body.hardThreshold = 9;
  body.riskPairs = [{ a: 'A0', b: 'A1', risk: 3 }];
  const r = await post(port, body);
  assert.equal(r.status, 200);
  assert.equal(typeof r.json.maxPoolRisk, 'number');
  assert.equal(typeof r.json.totalRisk, 'number');
  for (const p of r.json.pools) {
    assert.equal(typeof p.riskSum, 'number');
    for (const rp of p.riskPairs) assert.equal(typeof rp.risk, 'number');
  }
  after(() => server.close());
});
