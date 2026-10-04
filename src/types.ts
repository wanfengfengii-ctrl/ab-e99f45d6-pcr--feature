/**
 * Shared domain types for the multiplex PCR pool allocator.
 */

/** One amplicon as submitted by the caller, in recording order. */
export interface AmpliconInput {
  name: string;
  /** Positive integer reaction load. */
  load: number;
  /** Whether this amplicon carries the positive control marker. */
  isControl: boolean;
}

/**
 * Risk value as accepted on the wire: a non-negative safe integer (number), or
 * a canonical decimal string with at most six fractional digits. Integers and
 * strings may be mixed within one request.
 */
export type RiskValue = number | string;

/** Unordered amplicon pair with a non-negative dimer risk score. */
export interface RiskPairInput {
  /** Amplicon name (order of a/b does not matter). */
  a: string;
  /** Amplicon name (order of a/b does not matter). */
  b: string;
  /** Non-negative integer risk score, or a canonical decimal string (<= 6 dp). */
  risk: RiskValue;
}

export interface AllocateRequest {
  amplicons: AmpliconInput[];
  /** Number of parallel reaction pools, 2..4. */
  poolCount: number;
  /** Inclusive uniform load interval that every pool must fall into. */
  loadRange: { min: number; max: number };
  riskPairs: RiskPairInput[];
  /** Pairs whose risk reaches this value are forbidden from sharing a pool. */
  hardThreshold: RiskValue;
}

/**
 * Risk as returned on the wire: a JSON number for purely integer requests
 * (unchanged historical format), or a canonical decimal string whenever the
 * request contained any decimal-string risk value.
 */
export type RiskResult = number | string;

export interface PoolResult {
  pool: number;
  members: string[];
  load: number;
  controls: string[];
  riskPairs: { a: string; b: string; risk: RiskResult }[];
  riskSum: RiskResult;
}

export interface ConflictSummary {
  /** Forbidden pairs (risk >= hardThreshold); a feasible partition may still exist. */
  forbiddenPairs: { a: string; b: string; risk: RiskResult }[];
  /**
   * Clique (set of pairwise forbidden amplicons) that is larger than the
   * available pool count, proving impossibility of the hard constraints.
   */
  overCapacityClique: string[];
  /** Pools lacking a positive control at infeasibility, when attributable. */
  poolsWithoutControl?: number;
  /** Load-range explanation, when the interval itself can never fit. */
  loadIssue?: string;
}

export interface AllocateResponse {
  feasible: boolean;
  poolCount?: number;
  pools?: PoolResult[];
  maxPoolRisk?: RiskResult;
  totalRisk?: RiskResult;
  loadSpread?: number;
  assignment?: { amplicon: string; pool: number }[];
  conflictSummary?: ConflictSummary;
}

/** A single validation problem; field is a JSON pointer-ish locator. */
export interface ValidationIssue {
  field: string;
  message: string;
}
