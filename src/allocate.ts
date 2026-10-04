import {
  obviousInfeasibility,
  solve,
  type SolverInstance,
} from './solver.js';
import { formatMicro, riskToMicro } from './decimal.js';
import type { AllocateRequest, AllocateResponse, PoolResult, RiskValue } from './types.js';

export function buildInstance(req: AllocateRequest): SolverInstance {
  const n = req.amplicons.length;
  const k = req.poolCount;
  const names = req.amplicons.map((a) => a.name);
  const loads = req.amplicons.map((a) => a.load);
  const isControl = req.amplicons.map((a) => a.isControl);

  // Decimal mode: any string risk figure switches every comparison and sum
  // to exact micro-units (integers are scaled up too, so mixed requests stay
  // consistent). Pure-integer requests keep the legacy Int32 representation.
  const decimal =
    typeof req.hardThreshold === 'string' || req.riskPairs.some((p) => typeof p.risk === 'string');

  const risk: Int32Array | Float64Array = decimal
    ? new Float64Array(n * n)
    : new Int32Array(n * n);
  const forbidden = new Uint8Array(n * n);
  const threshold = decimal ? riskToMicro(req.hardThreshold) : (req.hardThreshold as number);
  const index = new Map<string, number>(names.map((name, i) => [name, i]));

  for (const p of req.riskPairs) {
    const i = index.get(p.a)!;
    const j = index.get(p.b)!;
    const r = decimal ? riskToMicro(p.risk) : (p.risk as number);
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
    decimal,
  };
}

export function allocate(req: AllocateRequest): AllocateResponse {
  const inst = buildInstance(req);
  const sol = solve(inst);

  // Decimal mode reports every risk figure as a canonical string with
  // insignificant zeros stripped; integer mode keeps plain numbers.
  const fmt = (v: number): RiskValue => (inst.decimal ? formatMicro(v) : v);

  if (!sol) {
    return { feasible: false, conflictSummary: buildConflictSummary(inst, fmt) };
  }

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
    const riskPairs: { a: string; b: string; risk: RiskValue }[] = [];
    for (let x = 0; x < memberIdx.length; x++) {
      for (let y = x + 1; y < memberIdx.length; y++) {
        const i = memberIdx[x]!;
        const w = memberIdx[y]!;
        const r = inst.risk[i * inst.n + w]!;
        if (r > 0) riskPairs.push({ a: inst.names[i]!, b: inst.names[w]!, risk: fmt(r) });
      }
    }
    pools.push({
      pool: j + 1,
      members,
      load: sol.poolLoads[j]!,
      controls,
      riskPairs,
      riskSum: fmt(sol.poolRisk[j]!),
    });
  }

  return {
    feasible: true,
    poolCount: inst.k,
    pools,
    maxPoolRisk: fmt(sol.maxRisk),
    totalRisk: fmt(sol.totalRisk),
    loadSpread: sol.spread,
    assignment: sol.assignment.map((p, i) => ({ amplicon: inst.names[i]!, pool: p + 1 })),
  };
}

function buildConflictSummary(inst: SolverInstance, fmt: (v: number) => RiskValue) {
  const forbiddenPairs: { a: string; b: string; risk: RiskValue }[] = [];
  for (let i = 0; i < inst.n; i++) {
    for (let j = i + 1; j < inst.n; j++) {
      if (inst.forbidden[i * inst.n + j]) {
        forbiddenPairs.push({
          a: inst.names[i]!,
          b: inst.names[j]!,
          risk: fmt(inst.risk[i * inst.n + j]!),
        });
      }
    }
  }

  const reason = obviousInfeasibility(inst);
  const out: NonNullable<AllocateResponse['conflictSummary']> = {
    forbiddenPairs,
    overCapacityClique: [],
  };

  const controlCount = inst.isControl.filter(Boolean).length;
  if (controlCount < inst.k) out.poolsWithoutControl = inst.k - controlCount;
  if (reason?.kind === 'load') out.loadIssue = reason.detail;
  if (reason?.kind === 'clique' && reason.clique) {
    out.overCapacityClique = reason.clique.map((i) => inst.names[i]!);
  }
  return out;
}
