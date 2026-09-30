# Phase 9B Job Isolation + Parallel Semantics Acceptance

**Policy:** job-isolation@1.0.0
**Suite:** `runtime/tests/job-isolation/acceptance.test.js`
**Result:** 40 / 40 PASS
**Status:** PHASE 9B VERIFIED - 40/40 ACCEPTANCE
**Baseline main:** `3ed4fc4e08d9aa6e829d024d4eeadca13f8cc3a2`

---

## Policy

- policy_id: `job-isolation`
- policy_version: `1.0.0`
- policy_ref: `job-isolation@1.0.0`

## Scope

Phase 9B acceptance evidence for JC01-JC10, NS01-NS10, PL01-PL10, and EP01-EP10 as locked by `governance/contracts/job-isolation-v1.md` (section 28). The acceptance model is consumed exactly: 40 invariants, no renamed IDs, no additional invariant IDs, no skipped required cases.

Acceptance only - no runtime behavior changes. All Phase 9B runtime modules (`runtime/job-isolation/*.js`) are byte-identical to the merged implementation verified through 9B-02 (#38), 9B-03 (#39), 9B-04 (#40), and 9B-05 (#41); this work adds the acceptance suite, runner registration, and implementation-status documentation.

## Environment / Determinism Boundaries

- Deterministic local Node execution. No network. No DB. No environment/profile reads. No memory reads/writes. No live external data. No wall clock. No randomness.
- Fixtures are reusable deterministic infrastructure data only; worktree references use machine-neutral placeholders (`<worktree-root>/issue-42`, `<coordination-checkout>`).
- Determinism stress (fixed repeat counts, no time-based loops):
  - 100x JobContract canonicalization (JC10)
  - 100x namespace derivation (NS10)
  - 100x lane identity resolution (PL02)
  - 100x validation/error outcome (EP08)
- Every repetition uses identical deterministic input; outputs are identical across iterations.

## Acceptance Matrix

| ID | Invariant | Test Evidence | Result |
|---|---|---|---|
| JC01 | required JobContract fields enforced | `policy.job_contract.required_fields` deep-equals the 8 canonical fields; created contract exposes exactly those 8 keys; unknown field and missing field both fail `JOB_CONTRACT_INVALID` | PASS |
| JC02 | job_id normalization deterministic | NFKC + trim + lowercase proven (`'  ACC.JC02.Core  '` -> `acc.jc02.core`; fullwidth input -> `acc-jc02`); 100 identical resolutions; creation and derivation bind the canonical ID | PASS |
| JC03 | invalid job_id rejected | 13 boundary-invalid IDs (non-string, empty, separators, leading `-`/`.`, 65 chars) fail `INVALID_JOB_ID` at canonicalization and creation; 64-char ID accepted | PASS |
| JC04 | create collision fails while exact persisted reuse is idempotent | duplicate creation -> `JOB_ID_COLLISION` (including differently-cased duplicate); exact persisted reuse idempotent (deep-equal, frozen); differing immutable field -> `JOB_ID_COLLISION`; reuse without persisted entry -> `JOB_CONTRACT_INVALID` | PASS |
| JC05 | profile required and valid | missing profile fails structurally; valid identifiers accepted with trim-only case preservation (`PGNAnalyst` preserved, `pgnanalyst` distinct); 9 malformed profiles fail `PROFILE_BINDING_INVALID` | PASS |
| JC06 | active profile binding immutable | exact and trim-equal binding accepted; different valid profile -> `PROFILE_BINDING_MISMATCH`; malformed -> `PROFILE_BINDING_INVALID`; reuse with different profile -> `PROFILE_BINDING_MISMATCH` | PASS |
| JC07 | namespace fields derived and caller override rejected | all five namespace kinds derive deterministically from canonical job identity; caller supply of any derived namespace -> `NAMESPACE_OVERRIDE_FORBIDDEN`; persisted tamper -> `NAMESPACE_OVERRIDE_FORBIDDEN` | PASS |
| JC08 | knowledge scopes explicit and canonically ordered | duplicates canonicalize to `JOB_LOCAL, SESSION_LOCAL, GLOBAL`; `JOB_LOCAL` required; empty/unknown/malformed fail `INVALID_KNOWLEDGE_SCOPE`; persisted non-canonical order and duplicates fail without repair | PASS |
| JC09 | execution permissions explicit and canonically ordered | permissions deduplicate to `READ_ONLY, LOW_RISK_WRITE, CONFIG_WRITE, DELETE, SECRET_ACCESS`; `READ_ONLY` required; empty/unknown fail `INVALID_EXECUTION_PERMISSIONS`; persisted non-canonical form fails | PASS |
| JC10 | identical canonical input produces identical JobContract | 100x identical creation and 100x identical reuse/validation produce byte-identical results; suite source contains no `Math.random`, `Date.now`, `new Date`, `process.env`, `process.hrtime`, `performance.now` | PASS |
| NS01 | same session + same job stays inside job boundary | same job + same session resolves inside the owning job namespace for `JOB_SCOPED` and `SESSION_LOCAL` (frozen allow decisions) | PASS |
| NS02 | different sessions + same job share only job-scoped state | `JOB_SCOPED` shared across sessions of the same job; `SESSION_LOCAL` denied for a different session (frozen decision, no domain code); no silent substitution of session-local state | PASS |
| NS03 | same session + different job rejects foreign-job access | same session + foreign job -> `FOREIGN_JOB_REJECT` for both resource scopes | PASS |
| NS04 | different session + different job fully isolated | different session + foreign job -> `FOREIGN_JOB_REJECT` (read) and `FOREIGN_NAMESPACE_WRITE_REJECTED` (write) for both scopes; no shared/default fallthrough | PASS |
| NS05 | JOB_LOCAL knowledge rejects foreign job | foreign `JOB_LOCAL` source -> `FOREIGN_JOB_REJECT` (with either namespace supplied); same-job source eligible | PASS |
| NS06 | SESSION_LOCAL requires same job + same session | same job + same session eligible; different session -> `{eligible:false}`; foreign job (same or different session) -> `FOREIGN_JOB_REJECT`; session identity never overrides the job boundary | PASS |
| NS07 | GLOBAL requires explicit job capability + explicitly global source | GLOBAL eligible only with explicit `GLOBAL` capability and an explicitly global/unowned source; missing capability -> `{eligible:false}`; foreign source -> `FOREIGN_JOB_REJECT` even with GLOBAL; unowned source carrying a namespace -> `NAMESPACE_COLLISION`; no knowledge-write API exists | PASS |
| NS08 | evidence from Job A cannot satisfy Job B | same-job evidence allowed; Job B reading Job A evidence -> `FOREIGN_JOB_REJECT` (with either namespace); foreign write -> `FOREIGN_NAMESPACE_WRITE_REJECTED`; same-job namespace mismatch -> `NAMESPACE_COLLISION` | PASS |
| NS09 | ledger/runtime mutable state reject foreign-job access/write | same-job ledger/runtime writes allowed; foreign ledger read/write and foreign runtime read/write/cleanup -> `FOREIGN_JOB_REJECT` / `FOREIGN_NAMESPACE_WRITE_REJECTED`; same-job cleanup ownership allowed | PASS |
| NS10 | namespace derivation deterministic; ambiguity fails closed | 100x identical derivation; no unresolved placeholders; no default/shared fallback prefix; namespaces pairwise distinct; unknown template kinds -> `NAMESPACE_DERIVATION_FAILED`; invalid identity -> `INVALID_JOB_ID`; integrity deviation -> `NAMESPACE_OVERRIDE_FORBIDDEN`; collision error `NAMESPACE_COLLISION`, fallback `NONE` | PASS |
| PL01 | one active writer per lane | second distinct writer on the same lane -> `LANE_OWNERSHIP_CONFLICT` at registration and ownership evaluation; the owning writer remains valid | PASS |
| PL02 | multiple independent lanes may operate concurrently | two independent lanes coexist with distinct identity, ownership, and baselines; 100x identical lane identity resolution | PASS |
| PL03 | lane job binding immutable | lane job rebinding -> `LANE_ID_COLLISION`; `job_id` listed among locked immutable fields; empty job binding fails closed | PASS |
| PL04 | cross-lane write ownership violation rejected | cross-lane claims rejected `CROSS_LANE_WRITE_REJECTED` in both directions; same-lane claim allowed; forged writer on the same lane -> `LANE_OWNERSHIP_CONFLICT` | PASS |
| PL05 | coordination checkout remains main-only | policy `MAIN_ONLY`; `main` accepted; non-main -> `COORDINATION_CHECKOUT_VIOLATION`; malformed -> `LANE_CONTRACT_INVALID`; coordinator state enforces the main-only checkout | PASS |
| PL06 | writer lane branch cannot be main | writer lane on `main` -> `COORDINATION_CHECKOUT_VIOLATION` at creation and registration; structural validity precedes the coordination constraint | PASS |
| PL07 | baseline_main_sha required | missing and 8 malformed baselines -> `LANE_CONTRACT_INVALID`; canonical all-zero 40-character lowercase hex accepted; pattern `^[0-9a-f]{40}$` | PASS |
| PL08 | stale main baseline detected | fresh baseline ok; changed authoritative main -> `STALE_MAIN_BASELINE`; caller assertions cannot clear staleness; governed coordinator audited synchronization clears it explicitly (`synchronized = true`, `audit_ref` recorded) | PASS |
| PL09 | tracked worktree representation remains machine-neutral | 14 tracked Phase 9B sources contain no machine-specific absolute paths (drive-letter forms and known machine path fragments); fixtures use `<worktree-root>/`; policy machine-neutral examples preserved | PASS |
| PL10 | stale lane state never becomes authoritative main implicitly | stale lane not merge-eligible; no implicit synchronization (synchronizations remain empty); original stale state unchanged after a governed synchronization elsewhere; main remains authoritative | PASS |
| EP01 | execution permissions explicit and READ_ONLY present | `READ_ONLY` required; sets without it -> `INVALID_EXECUTION_PERMISSIONS`; full canonical set accepted in canonical order | PASS |
| EP02 | unknown permission fails closed | unknown/empty/malformed permission sets -> `INVALID_EXECUTION_PERMISSIONS` at creation and persisted validation | PASS |
| EP03 | JobContract permissions are capability ceilings, not approvals | `capability_ceiling_not_authorization = true`; every approval mapping has `contract_alone_authorizes_execution = false`; returned ceiling is data-only (no functions, no approval/token fields) | PASS |
| EP04 | WRITE-class capability still requires approval gate | `LOW_RISK_WRITE` and `CONFIG_WRITE` remain WRITE-class with `approval_required = true`; tracked approval gate and safe mode phrases intact; ceiling remains a frozen data record | PASS |
| EP05 | DELETE is not authorized by JobContract alone | DELETE mapping: separate explicit governing authority required, otherwise fail closed; contract exposes no authorization fields (exactly 8 fields); ceiling data-only | PASS |
| EP06 | SECRET_ACCESS is not authorized by JobContract alone | SECRET_ACCESS mapping: separate explicit governing authority required, otherwise fail closed; `secret_reads = NOT_REQUIRED`; declared SECRET_ACCESS yields only a data ceiling; no secret is read | PASS |
| EP07 | declared capability never bypasses foreign-job isolation | broad declared capability (GLOBAL + all permissions) cannot cross foreign job boundaries: knowledge/evidence/runtime all fail closed; foreign lane -> `FOREIGN_JOB_REJECT` regardless of presented writer | PASS |
| EP08 | validation/error precedence deterministic | first-failing condition follows the locked 10-level precedence across 6 stacked invalid combinations; job-identity boundary precedes lane checks; lane structural precedes ownership; ownership precedes baseline; 100x identical outcome battery | PASS |
| EP09 | unresolved identity/namespace ambiguity never falls back to shared/default scope | invalid/ambiguous identities fail `INVALID_JOB_ID`; missing namespace identity -> `NAMESPACE_DERIVATION_FAILED`; `job:default:*` / `job:shared:*` never resolve (-> `NAMESPACE_COLLISION`); no shared/default fallback appears in derivation output | PASS |
| EP10 | public tracked artifacts contain no secrets, private state, or machine-specific runtime data | policy public-artifact boundary declared (11 forbidden content classes); `docs/SECURITY-BOUNDARY.md` invariants asserted; existing security scanner remains the authority; 10 tracked acceptance artifacts pass the prohibited-pattern scan; fixtures contain no secret-like material | PASS |

## Determinism Evidence

- 100x JobContract canonicalization (JC10): identical byte-for-byte results across all iterations.
- 100x namespace derivation (NS10): identical byte-for-byte results across all iterations.
- 100x lane identity resolution (PL02): identical byte-for-byte results across all iterations.
- 100x validation/error outcome (EP08): identical canonical error codes across all iterations.
- The acceptance suite source contains no `Math.random`, `Date.now`, `new Date`, `process.env`, `process.hrtime`, or `performance.now`.

## Foreign-Job / Cross-Job Evidence

- Session, knowledge, evidence, ledger, and runtime-state boundaries all reject foreign-job access with the locked canonical errors (`FOREIGN_JOB_REJECT`, `FOREIGN_NAMESPACE_WRITE_REJECTED`).
- Session equality never overrides the foreign-job boundary (NS03, NS06, NS07, EP07).
- GLOBAL capability never promotes foreign job-local or session-local data (NS07, EP07).
- Job A evidence cannot satisfy Job B; no shared/global evidence namespace exists in v1 (NS08).
- Coordinator merge eligibility rejects a foreign contract/lane job mismatch before writer-ownership evaluation (EP07).

## Namespace Evidence

- All five namespace kinds derive deterministically from the canonical job identity; no caller override, no default/shared fallback, no unresolved placeholders (JC07, NS10, EP09).
- Session scopes (`JOB_SCOPED`, `SESSION_LOCAL`) resolve inside the owning job namespace only; cross-job access fails closed (NS01-NS04).
- Namespace integrity deviations and derivation ambiguity fail closed with the locked canonical errors (NS10).

## Parallel-Lane Evidence

- One active writer per lane; independent lanes coexist; lane identity immutable; cross-lane claims rejected (PL01-PL04).
- Coordination checkout remains main-only; writer branches cannot be `main`; baseline SHA required; stale baselines detected and never implicitly authoritative (PL05-PL08, PL10).
- Tracked representations remain machine-neutral (PL09).

## Main Coordination Evidence

- Stale lane baselines are rejected with `STALE_MAIN_BASELINE` until an explicit audited synchronization is recorded through the governed coordinator transition; caller-supplied synchronization assertions are ignored (PL08, PL10).
- Stale lane state never becomes the authoritative coordination state; `main` remains the authoritative merged state (PL10).

## Runner Evidence

- `acceptance.test.js` (direct): 40 / 40 PASS, exit 0; canonical IDs exactly JC01-JC10, NS01-NS10, PL01-PL10, EP01-EP10.
- Full Job Isolation runner (`run-all.js`): registered 9 / executed 9 / passed 9 / skipped 0 / failed 0 - PASS contract, runner, job-contract, namespace-derivation, parallel-lane, namespace-isolation, knowledge-scope, integration, acceptance.
- Existing suites: contract 33/33, runner 8/8, job-contract 34/34, namespace-derivation 12/12, parallel-lane 35/35, namespace-isolation 30/30, knowledge-scope 18/18, integration 24/24.

## Regression Evidence

- `runtime-utils.test.js`: 14 / 14 PASS
- `health-runtime.test.ps1`: 12 / 12 PASS
- Oracle deterministic suites: 122 / 122 PASS
- MCP binding M01-M08: 8 / 8 PASS
- Context Hydration runner: 9/9 (registered 9 / executed 9 / passed 9 / skipped 0 / failed 0)
- Live Oracle calls: 0

## Security Evidence

- Security scanner fail-closed controls: SEC01-SEC09 PASS (9/9).
- Actual tracked-pattern scan: PASS (no prohibited tracked content; no prohibited tracked filenames).
- No secret/env/profile reads; no network; no database; no memory reads/writes; no live external data.
- Tracked acceptance artifacts contain no secrets, client data, private state, or machine-specific paths.

## Known Non-Claims

- Architecture Freeze v1 = NOT CLAIMED.
- Phase 9C = NOT VERIFIED.
- Runtime = PARTIAL (broader runtime/roadmap remains beyond Phase 9B).

## Final Decision

```text
JC01-JC10 = 10/10 PASS
NS01-NS10 = 10/10 PASS
PL01-PL10 = 10/10 PASS
EP01-EP10 = 10/10 PASS
TOTAL     = 40/40 PASS

Policy:
job-isolation@1.0.0

Baseline main:
3ed4fc4e08d9aa6e829d024d4eeadca13f8cc3a2

9B-06 Acceptance: VERIFIED

Phase 9B Job Isolation + Parallel Semantics acceptance:
PHASE 9B VERIFIED
```
