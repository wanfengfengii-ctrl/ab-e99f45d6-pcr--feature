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
   **exact-decimal precision trap** (six-dp risks where float64 summation picks
   the wrong partition; the response must report the exact canonical result),
   invalid-input field localization and legal-but-infeasible conflict summaries.

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
| `riskPairs` | unordered pairs of known, distinct names; `risk` non-negative integer **or canonical decimal string**; no duplicates |
| `hardThreshold` | non-negative integer **or canonical decimal string**; a listed pair with `risk >= hardThreshold` is forbidden |

### Exact decimal risks (six decimal places)

Thermodynamic dimer-risk values may carry up to six fractional digits. Such a
value is sent as a **canonical decimal string**: digits with an optional single
`.` followed by 1–6 digits, no sign, no exponent, no leading zeros and no
meaningless trailing zeros (`"0.05"`, `"0.3"`, `"9.999999"` — not `"+.5"`,
`"5e-1"`, `"0.30"` or `"01"`). Integer risks stay plain JSON numbers, and the
two formats may be mixed in one request:

```json
"riskPairs": [
  { "a": "X", "b": "Y", "risk": "0.07" },
  { "a": "X", "b": "Z", "risk": 9 }
],
"hardThreshold": "9.5"
```

As soon as **any** risk value (a pair risk or `hardThreshold`) is a string,
threshold comparisons, per-pool risk sums, the maximum/total risk and the
four-level objective decision all use **exact decimal arithmetic** — never
float64, which would otherwise mis-rank layouts (e.g. accumulating a worse
`0.5700000000000001` above the true optimum `0.56`). Every risk value in the
response is then a canonical decimal string with meaningless zeros removed
(including `"0"`), so a laboratory can independently re-add the pair lists
digit-for-digit. A request containing only integer numbers behaves exactly as
before: numeric JSON fields, same status codes and the same allocation.
Malformed decimal strings are rejected at the precise field
(`riskPairs[3].risk`, `hardThreshold`). Unlisted pairs remain risk `0`.

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
  decimal.ts     canonical decimal parsing/rendering + exact micro-unit math
  validation.ts  structural validation with field locators
  solver.ts      exact two-phase branch-and-bound (exact bigint risk sums)
  allocate.ts    instance construction and response assembly
  server.ts      node:http service (/health, /api/pools/allocate)
test/            differential tests vs a brute-force oracle + HTTP tests
scripts/verify.mjs  one-shot verification entry point
```
