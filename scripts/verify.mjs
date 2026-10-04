#!/usr/bin/env node
/**
 * One-shot verification entry point (service "verify" in docker-compose).
 *
 * Stages:
 *   1. TypeScript build
 *   2. node:test suite
 *   3. wait for the application /health endpoint
 *   4. exercise POST /api/pools/allocate:
 *        - a non-greedy trap request (greedy placement is suboptimal; the
 *          exact answer must be returned and re-checked client-side)
 *        - an invalid request (field-located errors)
 *        - a legal-but-infeasible request (conflict summary)
 *        - determinism: the same feasible request twice yields the same body
 *
 * Exit code is a bit mask (0 = everything passed):
 *   1  build failure
 *   2  test failure
 *   4  application never became healthy
 *   8  API verification failure
 *
 * The process exits by itself; compose runs it with restart: "no".
 */
import { spawnSync } from 'node:child_process';

const APP_URL = process.env.APP_URL ?? 'http://app:3000';
const HEALTH_TIMEOUT_MS = Number.parseInt(process.env.HEALTH_TIMEOUT_MS ?? '60000', 10);
let failures = 0;

const log = (stage, msg) => console.log(`[verify:${stage}] ${msg}`);
const fail = (stage, msg) => {
  console.error(`[verify:${stage}] FAIL ${msg}`);
};

const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: process.env.VERIFY_CWD ?? '/app' });
  if (r.error) throw r.error;
  return r.status ?? 1;
};

/* ------------------------------- stage 1: build ------------------------------- */
log('build', 'running TypeScript build...');
if (run('npx', ['tsc', '-p', 'tsconfig.json']) !== 0) {
  fail('build', 'TypeScript build failed');
  failures |= 1;
}

/* -------------------------------- stage 2: tests ------------------------------- */
if ((failures & 1) === 0) {
  log('test', 'running node:test suite...');
  if (run('node', ['--test', 'dist/test/solver.test.js', 'dist/test/api.test.js', 'dist/test/scale.test.js', 'dist/test/decimal.test.js', 'dist/test/decimal-api.test.js']) !== 0) {
    fail('test', 'test suite failed');
    failures |= 2;
  }
} else {
  fail('test', 'skipped because the build failed');
  failures |= 2;
}

/* ------------------------------ stage 3: health wait --------------------------- */
async function waitForHealth() {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  let lastErr = '';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${APP_URL}/health`);
      if (res.ok) {
        const body = await res.json();
        if (body && body.status === 'ok') return true;
      }
      lastErr = `status ${res.status}`;
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  fail('health', `application not healthy after ${HEALTH_TIMEOUT_MS}ms (${lastErr})`);
  return false;
}

const healthy = await waitForHealth();
if (!healthy) failures |= 4;

/* ------------------------------ stage 4: API checks ---------------------------- */
if (healthy) {
  log('api', `verifying allocation API at ${APP_URL}`);

  // Non-greedy trap. A naive "emptiest pool" strategy places a with X, b with
  // Y and d with Z, realising risk 7 per pool. The exact optimum deranges the
  // heavy items and reaches zero listed risk with perfectly balanced loads.
  const trap = {
    amplicons: [
      { name: 'X', load: 30, isControl: false },
      { name: 'Y', load: 30, isControl: false },
      { name: 'Z', load: 30, isControl: false },
      { name: 'c1', load: 10, isControl: true },
      { name: 'c2', load: 10, isControl: true },
      { name: 'c3', load: 10, isControl: true },
      { name: 'a', load: 30, isControl: false },
      { name: 'b', load: 30, isControl: false },
      { name: 'd', load: 30, isControl: false },
    ],
    poolCount: 3,
    loadRange: { min: 60, max: 80 },
    riskPairs: [
      { a: 'X', b: 'Y', risk: 9 },
      { a: 'X', b: 'Z', risk: 9 },
      { a: 'Y', b: 'Z', risk: 9 },
      { a: 'a', b: 'X', risk: 7 },
      { a: 'b', b: 'Y', risk: 7 },
      { a: 'd', b: 'Z', risk: 7 },
    ],
    hardThreshold: 9,
  };

  const post = async (body) => {
    const res = await fetch(`${APP_URL}/api/pools/allocate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() };
  };

  const apiChecks = [];
  const expect = (cond, msg) => apiChecks.push({ ok: Boolean(cond), msg });

  try {
    const r1 = await post(trap);
    expect(r1.status === 200, `trap HTTP status 200 (got ${r1.status})`);
    const j = r1.json;
    expect(j.feasible === true, 'trap is feasible');
    if (j.feasible) {
      expect(j.poolCount === 3, 'three pools returned');
      expect(Array.isArray(j.pools) && j.pools.length === 3, 'three pool objects');

      // Re-verify every hard constraint and reported number client-side.
      const where = new Map();
      let loads = [0, 0, 0];
      let controls = [0, 0, 0];
      for (const p of j.pools) {
        expect(typeof p.pool === 'number' && p.pool >= 1 && p.pool <= 3, `pool id valid (${p.pool})`);
        for (const m of p.members) {
          expect(!where.has(m), `amplicon ${m} assigned exactly once`);
          where.set(m, p.pool);
        }
        const wantLoad = p.members
          .map((m) => trap.amplicons.find((a) => a.name === m).load)
          .reduce((x, y) => x + y, 0);
        expect(p.load === wantLoad, `pool ${p.pool} reported load ${p.load} equals recomputed ${wantLoad}`);
        loads[p.pool - 1] = p.load;
        expect(p.load >= 60 && p.load <= 80, `pool ${p.pool} load ${p.load} inside [60,80]`);
        expect(p.controls.length >= 1, `pool ${p.pool} has a positive control`);
        controls[p.pool - 1] = p.controls.length;
        for (const c of p.controls) {
          const amp = trap.amplicons.find((a) => a.name === c);
          expect(amp && amp.isControl, `pool ${p.pool} control ${c} really is a control`);
        }
        let riskSum = 0;
        for (const rp of p.riskPairs) {
          expect(rp.risk < trap.hardThreshold, `pool ${p.pool} pair (${rp.a},${rp.b}) below hard threshold`);
          riskSum += rp.risk;
        }
        expect(p.riskSum === riskSum, `pool ${p.pool} riskSum ${p.riskSum} equals recomputed ${riskSum}`);
      }
      expect(where.size === 9, `all 9 amplicons assigned (got ${where.size})`);
      for (const rp of trap.riskPairs) {
        if (rp.risk >= trap.hardThreshold) {
          expect(where.get(rp.a) !== where.get(rp.b), `forbidden pair ${rp.a}/${rp.b} separated`);
        }
      }
      // Exact-optimum assertions that defeat the greedy layout.
      expect(j.maxPoolRisk === 0, `maximum pool risk is 0 (got ${j.maxPoolRisk}; greedy yields 7)`);
      expect(j.totalRisk === 0, `total risk is 0 (got ${j.totalRisk})`);
      expect(j.loadSpread === 0, `load spread is 0 (got ${j.loadSpread})`);
      expect(Math.max(...loads) - Math.min(...loads) === 0, 'reported spread matches pool loads');

      // Determinism: repeat the request and compare bodies.
      const r1b = await post(trap);
      expect(JSON.stringify(r1b.json) === JSON.stringify(j), 'repeated request gives byte-identical allocation');

      // assignment list respects recording order
      expect(
        Array.isArray(j.assignment) &&
          j.assignment.every((x, i) => x.amplicon === trap.amplicons[i].name),
        'assignment follows amplicon recording order',
      );
    }

    // Invalid input must be rejected with field-located issues.
    const bad = await post({
      amplicons: [{ name: 'only', load: -1, isControl: true }],
      poolCount: 9,
      loadRange: { min: 50, max: 10 },
      riskPairs: [{ a: 'only', b: 'ghost', risk: -2 }],
      hardThreshold: -3,
    });
    expect(bad.status === 400, `invalid request HTTP 400 (got ${bad.status})`);
    const badFields = new Set((bad.json.issues ?? []).map((i) => i.field));
    for (const f of ['amplicons', 'amplicons[0].load', 'poolCount', 'loadRange', 'riskPairs[0].b', 'riskPairs[0].risk', 'hardThreshold']) {
      expect(badFields.has(f), `validation issue located at ${f}`);
    }

    // Legal but impossible: one control for three pools.
    const infeasible = await post({
      amplicons: Array.from({ length: 9 }, (_, i) => ({
        name: `A${i}`,
        load: 10,
        isControl: i === 0,
      })),
      poolCount: 3,
      loadRange: { min: 10, max: 200 },
      riskPairs: [],
      hardThreshold: 5,
    });
    expect(infeasible.status === 200, `infeasible request HTTP 200 (got ${infeasible.status})`);
    expect(infeasible.json.feasible === false, 'feasible=false reported');
    expect(
      infeasible.json.conflictSummary && infeasible.json.conflictSummary.poolsWithoutControl === 2,
      'conflict summary explains 2 pools without a possible control',
    );

    // Forbidden clique larger than the pool count.
    const clique = await post({
      amplicons: Array.from({ length: 8 }, (_, i) => ({ name: `A${i}`, load: 10, isControl: true })),
      poolCount: 2,
      loadRange: { min: 10, max: 400 },
      riskPairs: [
        { a: 'A0', b: 'A1', risk: 9 },
        { a: 'A0', b: 'A2', risk: 9 },
        { a: 'A1', b: 'A2', risk: 9 },
      ],
      hardThreshold: 9,
    });
    expect(clique.json.feasible === false, 'K3-into-2-pools reported infeasible');
    const cq = new Set(clique.json.conflictSummary?.overCapacityClique ?? []);
    expect(cq.size === 3 && ['A0', 'A1', 'A2'].every((x) => cq.has(x)), 'conflict summary lists the K3 clique');

    /* ---------- six-decimal-place exact decimal risk (precision trap) ---------- */
    // Values such as 0.07/0.2/0.3 are not exactly representable in float64.
    // A double-based optimizer accumulates a competing partition as
    // 0.5700000000000001 and wrongly prefers it; exact decimal comparison must
    // instead find the partition with true total 0.56 (pool maxima 0.30/0.26).
    const decEdges = [
      ['A0', 'A1', '0.05'], ['A0', 'A3', '0.07'], ['A0', 'A6', '0.2'], ['A0', 'A7', '0.07'],
      ['A1', 'A6', '0.3'], ['A2', 'A3', '0.3'], ['A2', 'A4', '0.05'], ['A2', 'A6', '0.05'],
      ['A2', 'A7', '0.2'], ['A3', 'A4', '0.2'], ['A3', 'A5', '0.2'], ['A3', 'A7', '0.07'],
      ['A4', 'A7', '0.07'], ['A5', 'A6', '0.2'], ['A6', 'A7', '0.3'],
    ];
    const decimalReq = {
      amplicons: Array.from({ length: 8 }, (_, i) => ({ name: `A${i}`, load: 10, isControl: true })),
      poolCount: 2,
      loadRange: { min: 40, max: 40 },
      riskPairs: [
        ...decEdges.map(([a, b, risk]) => ({ a, b, risk })),
        { a: 'A0', b: 'A4', risk: 5 }, // integer number mixed with decimal strings
      ],
      hardThreshold: '9',
    };
    const dec = await post(decimalReq);
    expect(dec.status === 200, `decimal request HTTP status 200 (got ${dec.status})`);
    const dj = dec.json;
    expect(dj.feasible === true, 'decimal request feasible');
    if (dj.feasible) {
      // Every risk value in the response is a canonical, zero-trimmed string.
      const canonical = /^(?:0|[1-9][0-9]*)(?:\.[0-9]{0,5}[1-9])?$/;
      expect(typeof dj.maxPoolRisk === 'string' && canonical.test(dj.maxPoolRisk), `maxPoolRisk canonical string (${dj.maxPoolRisk})`);
      expect(typeof dj.totalRisk === 'string' && canonical.test(dj.totalRisk), `totalRisk canonical string (${dj.totalRisk})`);

      // Recompute all sums with exact integer micro-units, client-side.
      const micro = (v) => {
        if (typeof v === 'number') return BigInt(Math.round(v * 1e6));
        const d = v.indexOf('.');
        return d === -1 ? BigInt(v) * 1000000n : BigInt(v.slice(0, d)) * 1000000n + BigInt(v.slice(d + 1).padEnd(6, '0'));
      };
      let decTotal = 0n;
      let decMax = 0n;
      for (const p of dj.pools) {
        expect(typeof p.riskSum === 'string', `pool ${p.pool} riskSum is a string`);
        let sum = 0n;
        for (const rp of p.riskPairs) {
          expect(typeof rp.risk === 'string' && canonical.test(rp.risk), `pair risk canonical (${rp.risk})`);
          sum += micro(rp.risk);
        }
        expect(sum === micro(p.riskSum), `pool ${p.pool} riskSum ${p.riskSum} equals recomputed pairs`);
        decTotal += sum;
        if (sum > decMax) decMax = sum;
      }
      expect(decTotal === micro(dj.totalRisk), `totalRisk ${dj.totalRisk} equals sum of pool sums`);
      expect(decMax === micro(dj.maxPoolRisk), `maxPoolRisk ${dj.maxPoolRisk} equals largest pool sum`);

      // The precision-sensitive optimum: 0.56, not float64's 0.57.
      expect(dj.totalRisk === '0.56', `exact decimal totalRisk is 0.56 (got ${dj.totalRisk}; float64 yields 0.57)`);
      expect(dj.maxPoolRisk === '0.3', `exact decimal maxPoolRisk is 0.3 (got ${dj.maxPoolRisk})`);

      // Determinism holds for decimal requests too.
      const dec2 = await post(decimalReq);
      expect(JSON.stringify(dec2.json) === JSON.stringify(dj), 'decimal request is byte-identical on repeat');
    }

    // Non-canonical decimal strings are rejected at the precise field.
    const badDec = await post({
      amplicons: Array.from({ length: 8 }, (_, i) => ({ name: `A${i}`, load: 10, isControl: true })),
      poolCount: 2,
      loadRange: { min: 40, max: 40 },
      riskPairs: [
        { a: 'A0', b: 'A1', risk: '1.50' },   // meaningless trailing zeros
        { a: 'A2', b: 'A3', risk: '0.1e1' },   // exponent
      ],
      hardThreshold: '+9',                     // sign
    });
    expect(badDec.status === 400, `non-canonical decimals HTTP 400 (got ${badDec.status})`);
    const badDecFields = new Set((badDec.json.issues ?? []).map((i) => i.field));
    for (const f of ['riskPairs[0].risk', 'riskPairs[1].risk', 'hardThreshold']) {
      expect(badDecFields.has(f), `non-canonical decimal located at ${f}`);
    }

    // Legal but infeasible with a fractional threshold: the conflict summary
    // echoes canonical decimal strings.
    const decClique = await post({
      amplicons: Array.from({ length: 8 }, (_, i) => ({ name: `A${i}`, load: 10, isControl: true })),
      poolCount: 2,
      loadRange: { min: 10, max: 400 },
      riskPairs: [
        { a: 'A0', b: 'A1', risk: '9.5' },
        { a: 'A0', b: 'A2', risk: '9.5' },
        { a: 'A1', b: 'A2', risk: '9.5' },
      ],
      hardThreshold: '9.5',
    });
    expect(decClique.json.feasible === false, 'fractional-threshold clique infeasible');
    const dcp = decClique.json.conflictSummary?.forbiddenPairs ?? [];
    expect(dcp.length === 3 && dcp.every((p) => p.risk === '9.5'), 'conflict summary risks are canonical "9.5" strings');
  } catch (err) {
    expect(false, `API check threw: ${err instanceof Error ? err.stack : err}`);
  }

  let failedChecks = 0;
  for (const c of apiChecks) {
    if (!c.ok) {
      fail('api', c.msg);
      failedChecks++;
    }
  }
  log('api', `${apiChecks.length - failedChecks}/${apiChecks.length} checks passed`);
  if (failedChecks > 0) failures |= 8;
}

/* ---------------------------------- summary ---------------------------------- */
if (failures === 0) {
  log('result', 'ALL STAGES PASSED (build, tests, health, API incl. non-greedy trap)');
} else {
  fail('result', `verification failed with exit mask ${failures} (build=1 tests=2 health=4 api=8)`);
}
process.exit(failures);
