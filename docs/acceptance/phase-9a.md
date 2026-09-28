# Phase 9A Context Hydration Acceptance

**Policy:** context-hydration@1.0.1
**Suite:** `runtime/tests/context-hydration/acceptance.test.js`
**Result:** 37 / 37 PASS
**Status:** PHASE 9A VERIFIED — 37/37 ACCEPTANCE

---

## Policy

- policy_id: `context-hydration`
- policy_version: `1.0.1`
- policy_ref: `context-hydration@1.0.1`

## Scope

Phase 9A acceptance evidence for O01–O10, H01–H17, and S01–S10 as locked by `governance/contracts/context-hydration-v1.md`.

Acceptance only — no runtime behavior changes. All runtime implementation modules (`runtime/context-hydration/*.js`) and `governance/policies/context-hydration.json` are byte-identical to the merged integrated pipeline; this work adds tests, runner registration, and implementation-status documentation.

## Environment / Determinism Boundaries

- Deterministic local Node execution. No network. No DB. No environment reads. No wall-clock reads.
- All timestamps are explicit RFC3339 UTC; the single immutable run anchor is `hydration_started_at`.
- Retrieval providers are deterministic caller-injected test doubles (the runtime's designed provider interface). No business logic is mocked or reimplemented.
- Lower-level exported runtime APIs are exercised only where an invariant concerns behavior that cannot be observed completely through the integrated ContextPackage: H03 uses the real retrieval-adapter / eligibility / ranking modules to prove the non-vacuous rankability chain; H16 uses `createOmissionStore` for the retention boundary.
- Determinism stress: 20 consecutive executions of the acceptance suite — 20/20 exit 0, identical output, 37/37 each, 0 failed.

## Acceptance Matrix

| ID | Invariant | Evidence / Assertion | Result |
|---|---|---|---|
| O01 | Explicit objective preserved | Explicit summary / intent / entities / retrieval_terms preserved through `hydrateContext()`; explicit confidence path = 1 | PASS |
| O02 | Clear request produces structured objective | All StructuredObjective fields present and valid (`objective_id`, `summary`, `intent`, `scope`, `entities`, `constraints`, `retrieval_terms`, `confidence`, `provenance`) | PASS |
| O03 | Scope extracted correctly | `objective.scope.session_id` / `.job_id` equal the active identifiers; no scope drift | PASS |
| O04 | Active constraints preserved | Deterministic active constraints appear unchanged in `objective.constraints` | PASS |
| O05 | Provenance preserved | `provenance` contains exact session_id, job_id, objective_source, checkpoint_id, policy_ref = context-hydration@1.0.1 | PASS |
| O06 | LOW confidence blocks automatic retrieval | LOW objective; all five provider spies invoked 0 times; `retrieved.length = 0` | PASS |
| O07 | LOW confidence still loads mandatory context | LOW objective; `context_package.mandatory` unchanged; retrieved/omitted empty | PASS |
| O08 | Ambiguity does not invent entities | Ambiguous free-text request; `objective.entities = []` | PASS |
| O09 | Identical input + policy produces identical objective | Two identical runs; deep-equal objective incl. objective_id, confidence, provenance, retrieval_terms | PASS |
| O10 | Explicit objective outranks inferred objective | Disagreeing request vs explicit objective; explicit summary / intent / retrieval_terms win | PASS |
| H01 | Mandatory context always loaded | Mandatory records preserved exactly in `context_package.mandatory` | PASS |
| H02 | Relevant curated item retrieved | Rankable curated candidate appears in `retrieved` with all audit fields (source_id, source_type, scope, score, rank, reason, provenance) | PASS |
| H03 | Irrelevant item excluded | Canonical non-vacuous proof: MEDIUM/HIGH confidence, explicit raw source_id, provider invoked, adapter filter passed, ELIGIBLE_EXPLICIT_RAW eligibility, candidate reaches ranking, rejected `unknown_authority`, absent from retrieved | PASS |
| H04 | Foreign-job knowledge hard rejected | Mismatched `job_id` candidate absent from final package; local candidate retrieved | PASS |
| H05 | Raw source not auto-injected | No explicit request; raw provider invoked 0 times; raw candidate absent | PASS |
| H06 | Semantic relevance dominates recency appropriately | Old high-relevance curated (score 0.95) ranks before fresh low-relevance curated (score 0.5); no relevance threshold | PASS |
| H07 | Deterministic tie-breaking | Full-tie pair ordered by `source_id` ASC; equal-total scope pair ordered by `scope_specificity` DESC before `source_id` ASC | PASS |
| H08 | Latest checkpoint bypasses candidate ranking | Checkpoint present verbatim in mandatory; not a retrieval candidate; consumes no retrieval budget; absent from omitted; no rank/score injected | PASS |
| H09 | Context budget respected | `retrieved_tokens_used` (6000) <= retrieval budget (7000); ranked-order greedy skip-and-continue; atomic records, no truncation | PASS |
| H10 | Mandatory context never silently dropped | Valid mandatory preserved unchanged; mandatory overflow fails closed with `CONTEXT_BUDGET_EXCEEDED` | PASS |
| H11 | Duplicate knowledge deduplicated | `(source_type, source_id)` duplicates collapse to one record (first in ranked order wins); cross-type same source_id retained; mandatory exempt | PASS |
| H12 | Empty retrieval produces valid ContextPackage | No providers; valid envelope with `retrieved = []`, `omitted = []`, valid budget audit | PASS |
| H13 | Provenance preserved | Candidate provenance preserved exactly in `retrieved[].provenance` | PASS |
| H14 | Omitted content not persisted | Budget-omitted candidate metadata contains only the allowlist; content/body/text/nested payload absent | PASS |
| H15 | Omitted metadata safely persisted | Successful hydration persists expected metadata through the omission store; allowlist respected; no raw content | PASS |
| H16 | Retention policy applied | `omitted_at = hydration_started_at`; `expires_at = +2,592,000s`; available before expiry; expired at `retention_current_time >= expires_at`; initialization cleanup purges expired records | PASS |
| H17 | Identical inputs/scope/policy produce identical ordering | Two identical runs; identical retrieved ordering, scores, and ranks | PASS |
| S01 | One matching skill | count = 1; ordered.length = 1 | PASS |
| S02 | Two compatible skills | Both retained, ordered by normative execution phase | PASS |
| S03 | Three compatible skills allowed by default | count = 3; override_applied = false | PASS |
| S04 | Four skills require explicit override | `SKILL_CHAIN_REQUIRES_OVERRIDE` without override | PASS |
| S05 | Five skills allowed only with override | With override: count = 5, override_applied = true; without override: `SKILL_CHAIN_REQUIRES_OVERRIDE` | PASS |
| S06 | Six skills rejected | `SKILL_CHAIN_LIMIT_EXCEEDED` with and without override (hard limit precedes override-required) | PASS |
| S07 | Chain never silently truncated | Over-limit chain fails with the hard-limit rejection; no partial/truncated five-skill result | PASS |
| S08 | Conflicting skills fail closed | `SKILL_CONFLICT`; conflict precedes chain-limit decisions (6-skill conflicting set still `SKILL_CONFLICT`) | PASS |
| S09 | Explicit user skill retained | Duplicate skill_id with later `explicit = true`; resolved unique skill retains `explicit = true` in the ordered chain | PASS |
| S10 | Skill cannot override runtime policy | `skill_override_request = { runtime_policy: true }` -> `SKILL_OVERRIDE_FORBIDDEN` | PASS |

## Objective Results

O01–O10: **10 / 10 PASS**

## Hydration Results

H01–H17: **17 / 17 PASS**

## Skill Results

S01–S10: **10 / 10 PASS**

## Runner Evidence

- `acceptance.test.js` (direct): 37 / 37 PASS, exit 0; canonical IDs exactly O01–O10, H01–H17, S01–S10.
- `contract.test.js`: 52 / 52 PASS.
- `runner.test.js`: R01–R16 PASS.
- `run-all.js`: registered 9 / executed 9 / passed 9 / skipped 0 / failed 0 —
  PASS contract, runner, objective-parser, ranking-policy, retrieval-eligibility, budget-dedup, skill-resolver, integration, acceptance.

## Regression Evidence

- `runtime-utils.test.js`: 14 / 14 PASS
- `health-runtime.test.ps1`: 12 / 12 PASS
- Oracle deterministic suites: 122 / 122 PASS
- MCP binding M01–M08: 8 / 8 PASS
- Live Oracle calls: 0

## Security Evidence

- No secret/env/profile reads; no network or database calls.
- No secret-like values in fixtures; omitted content is never persisted (allowlist-only omission metadata).
- Security-scan patterns verified locally: no private keys, no machine paths, no secret files.

## Known Non-Claims

- Architecture Freeze v1 = **NOT YET CLAIMED**.
- Phase 9B = **NOT IMPLEMENTED BY THIS WORK**.
- Phase 9C = **NOT IMPLEMENTED BY THIS WORK**.

## Final Decision

```
O01–O10 = 10/10 PASS
H01–H17 = 17/17 PASS
S01–S10 = 10/10 PASS
TOTAL   = 37/37 PASS

Policy:
context-hydration@1.0.1

Phase 9A Context Hydration acceptance:
VERIFIED
```
