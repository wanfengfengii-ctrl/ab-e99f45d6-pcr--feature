import {
  obviousInfeasibility,
  solve,
  type SolverInstance,
} from './solver.js';
import { canonicalMicro, toMicroUnits } from './decimal.js';
import type {
  AllocateRequest,
  AllocateResponse,
  PoolResult,
  RiskResult,
} from './types.js';

export function buildInstance(req: AllocateRequest): SolverInstance {
  const n = req.amplicons.length;
  const k = req.poolCount;
  const names = req.amplicons.map((a) => a.name);
  const loads = req.amplicons.map((a) => a.load);
  const isControl = req.amplicons.map((a) => a.isControl);

  const risk = new BigInt64Array(n * n);
  const forbidden = new Uint8Array(n * n);
  const index = new Map<string, number>(names.map((name, i) => [name, i]));

  // Any decimal-string input switches the response's risk values to canonical
  // strings; a purely integer request keeps the historical JSON numbers.
  const decimalMode =
    typeof req.hardThreshold === 'string' ||
    req.riskPairs.some((p) => typeof p.risk === 'string');

  // Threshold comparisons use the exact decimal values.
  const threshold = toMicroUnits(req.hardThreshold);
  for (const p of req.riskPairs) {
    const i = index.get(p.a)!;
    const j = index.get(p.b)!;
    const r = toMicroUnits(p.risk);
    risk[i * n + j] = r;
    risk[j * n + i] = r;
    if (r >= threshold) {
      forbidden[i * n + j] = 1;
      forbidden[j * n + i] = 1;
    }
  }

  return {
    n,
    k,
    names,
    loads,
    isControl,
    risk,
    minLoad: req.loadRange.min,
    maxLoad: req.loadRange.max,
    forbidden,
    decimalMode,
  };
}

export function allocate(req: AllocateRequest): AllocateResponse {
  const inst = buildInstance(req);
  const sol = solve(inst);

  if (!sol) {
    return { feasible: false, conflictSummary: buildConflictSummary(inst) };
  }

  // Any decimal-string input switches the entire response's risk values to
  // canonical strings; a purely integer request keeps the historical numbers.
  const out = (v: bigint): RiskResult =>
    inst.decimalMode ? canonicalMicro(v) : Number(v / 1_000_000n);

  const pools: PoolResult[] = [];
  for (let j = 0; j < inst.k; j++) {
    const memberIdx: number[] = [];
    for (let i = 0; i < inst.n; i++) {
      if (sol.assignment[i] === j) memberIdx.push(i);
    }
    // Recording order for stable, deterministic output.
    memberIdx.sort((a, b) => a - b);
    const members = memberIdx.map((i) => inst.names[i]!);
    const controls = memberIdx.filter((i) => inst.isControl[i]).map((i) => inst.names[i]!);
    const riskPairs = [];
    for (let x = 0; x < memberIdx.length; x++) {
      for (let y = x + 1; y < memberIdx.length; y++) {
        const i = memberIdx[x]!;
        const w = memberIdx[y]!;
        const r = inst.risk[i * inst.n + w]!;
        if (r > 0n) riskPairs.push({ a: inst.names[i]!, b: inst.names[w]!, risk: out(r) });
      }
    }
    pools.push({
      pool: j + 1,
      members,
      load: sol.poolLoads[j]!,
      controls,
      riskPairs,
      riskSum: out(sol.poolRisk[j]!),
    });
  }

  return {
    feasible: true,
    poolCount: inst.k,
    pools,
    maxPoolRisk: out(sol.maxRisk),
    totalRisk: out(sol.totalRisk),
    loadSpread: sol.spread,
    assignment: sol.assignment.map((p, i) => ({ amplicon: inst.names[i]!, pool: p + 1 })),
  };
}

function buildConflictSummary(inst: SolverInstance) {
  // Integer numbers for purely integer requests, canonical decimal strings
  // whenever the request contained any string risk value.
  const out = (v: bigint): RiskResult =>
    inst.decimalMode ? canonicalMicro(v) : Number(v / 1_000_000n);

  const forbiddenPairs: { a: string; b: string; risk: RiskResult }[] = [];
  for (let i = 0; i < inst.n; i++) {
    for (let j = i + 1; j < inst.n; j++) {
      if (inst.forbidden[i * inst.n + j]) {
        forbiddenPairs.push({
          a: inst.names[i]!,
          b: inst.names[j]!,
          risk: out(inst.risk[i * inst.n + j]!),
        });
      }
    }
  }

  const reason = obviousInfeasibility(inst);
  const summary: NonNullable<AllocateResponse['conflictSummary']> = {
    forbiddenPairs,
    overCapacityClique: [],
  };

  const controlCount = inst.isControl.filter(Boolean).length;
  if (controlCount < inst.k) summary.poolsWithoutControl = inst.k - controlCount;
  if (reason?.kind === 'load') summary.loadIssue = reason.detail;
  if (reason?.kind === 'clique' && reason.clique) {
    summary.overCapacityClique = reason.clique.map((i) => inst.names[i]!);
  }
  return summary;
}
