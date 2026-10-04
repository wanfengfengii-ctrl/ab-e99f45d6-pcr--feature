# PCR Pool Allocator

Multiplex-PCR panel pre-finalization service. It partitions 8–18 amplicons into
2–4 parallel reaction pools with exact (branch-and-bound) optimization — not a
greedy placement — so high-risk dimer pairs and positive-control loss cannot be
left behind by a locally reasonable but globally suboptimal assignment.

## What it guarantees

Every amplicon is assigned to exactly one pool. Hard constraints:

- each pool contains **at least one positive control**;
- each pool load lies inside the uniform inclusive interval `[loadRange.min, loadRange.max]`;
- a listed pair whose risk reaches `hardThreshold` is **never** co-located
  (unlisted pairs are treated as risk 0).

Among all feasible allocations the solver minimizes, strictly in this order:

1. the largest single-pool risk sum;
2. the sum of risk over all pools;
3. the load spread (heaviest pool load − lightest pool load);
4. the pool-number sequence flattened in amplicon recording order
   (1-based; gives one canonical, stable allocation).

The search is exhaustive (MRV + forward checking + Hall matching for controls +
subset-sum reachability + pool symmetry elimination), so `feasible: false`
proves that no allocation exists.

## Run

```bash
# host port comes from APP_PORT (default 3000)
APP_PORT=8080 docker compose up -d --build app
curl -s http://localhost:8080/health
```

### One-shot verification service

```bash
docker compose run --rm verify
```

`verify` performs, by itself, and then exits with a bit-mask code:

1. TypeScript build (`tsc`),
2. the `node:test` suite,
3. wait for the app's `/health` endpoint,
4. live API checks including a **non-greedy trap** (the greedy "emptiest pool"
   layout realizes risk 7 per pool; the service must return the exact risk-0,
   perfectly balanced allocation, independently re-verified), an
   **exact-decimal precision trap** (`0.1 + 0.2` must surface as `"0.3"` in
   pool sums, max and totals, with mixed integer/string inputs), invalid-input
   field localization and legal-but-infeasible conflict summaries.

Exit mask: `1` build, `2` tests, `4` health, `8` API — `0` means all passed.

Local (without Docker):

```bash
npm install
npm run build
npm test
APP_PORT=3000 node dist/src/server.js
# in another shell:
APP_URL=http://127.0.0.1:3000 VERIFY_CWD=$PWD node scripts/verify.mjs
```

## API

### `POST /api/pools/allocate`

```json
{
  "amplicons": [
    { "name": "X", "load": 30, "isControl": false },
    { "name": "c1", "load": 10, "isControl": true }
  ],
  "poolCount": 3,
  "loadRange": { "min": 60, "max": 80 },
  "riskPairs": [
    { "a": "X", "b": "Y", "risk": 9 }
  ],
  "hardThreshold": 9
}
```

| field | rules |
| --- | --- |
| `amplicons` | 8–18 unique non-empty names; `load` positive integer; `isControl` boolean |
| `poolCount` | integer 2–4 |
| `loadRange` | positive integers, `min <= max` |
| `riskPairs` | unordered pairs of known, distinct names; `risk` non-negative integer **or canonical decimal string** (see below); no duplicates |
| `hardThreshold` | non-negative integer **or canonical decimal string**; a listed pair with `risk >= hardThreshold` is forbidden |

### Exact-decimal risk scores

Upgraded thermodynamic evaluation emits fractional dimer risks. Any
`riskPairs[].risk` and/or `hardThreshold` may be a **canonical decimal
string** with up to six fraction digits — e.g. `"0.5"`, `"3.141593"`,
`"0.000001"`. Integers and strings may be mixed freely within one request;
unlisted pairs still count as risk 0.

Canonical means: no sign, no exponent, no leading zeros, and no
insignificant trailing zeros in the fraction (`"1.5"`, not `"1.50"`). The
integer part is limited to 7 digits (values up to `9999999.999999`) so that
every internal sum stays exactly representable. Non-canonical strings are
rejected with `400` and the usual field-located `issues`.

Once any string appears, every comparison and sum (threshold adjudication,
per-pool risk sums, max/total risk and the four-level objective order) is
computed in exact decimal — internally the values become integers in
micro-units (×10⁶), so binary floating point can never flip a forbidden-pair
decision or re-order equally good allocations. All risk figures in the
response (`pools[].riskPairs[].risk`, `pools[].riskSum`, `maxPoolRisk`,
`totalRisk` and `conflictSummary.forbiddenPairs[].risk`) are then returned
as canonical decimal strings with insignificant zeros stripped (`"3"`,
`"0.3"`); pure-integer requests keep the original numeric types, status
codes and allocation semantics unchanged.

Success (`200`):

```json
{
  "feasible": true,
  "poolCount": 3,
  "pools": [
    {
      "pool": 1,
      "members": ["X", "c1", "d"],
      "load": 70,
      "controls": ["c1"],
      "riskPairs": [],
      "riskSum": 0
    }
  ],
  "maxPoolRisk": 0,
  "totalRisk": 0,
  "loadSpread": 0,
  "assignment": [{ "amplicon": "X", "pool": 1 }]
}
```

Invalid input (`400`) pinpoints fields, including array indices:

```json
{
  "error": "validation_failed",
  "issues": [
    { "field": "amplicons[5].load", "message": "must be a positive integer" },
    { "field": "riskPairs[0].b", "message": "unknown amplicon name \"GHOST\"" }
  ]
}
```

Legal but unsatisfiable (`200`):

```json
{
  "feasible": false,
  "conflictSummary": {
    "forbiddenPairs": [{ "a": "A0", "b": "A1", "risk": 9 }],
    "overCapacityClique": ["A0", "A1", "A2"],
    "poolsWithoutControl": 2,
    "loadIssue": "..."
  }
}
```

## Layout

```
src/
  types.ts       request/response contracts
  decimal.ts     canonical decimal strings <-> exact micro-unit integers
  validation.ts  structural validation with field locators
  solver.ts      exact two-phase branch-and-bound
  allocate.ts    instance construction and response assembly
  server.ts      node:http service (/health, /api/pools/allocate)
test/            differential tests vs a brute-force oracle + HTTP tests
scripts/verify.mjs  one-shot verification entry point
```
