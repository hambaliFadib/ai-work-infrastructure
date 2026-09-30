# Job Isolation v1 — Governance Contract

Status: CONTRACT LOCKED
Policy: job-isolation@1.0.0
Implementation: PARTIAL
Phase: 9B (Job Isolation + Parallel Semantics)
Epic: #16
Governance issue: #37 (9B-01)

Implementation status by sub-issue:

9B-02 JobContract Runtime Core:
IMPLEMENTED / VERIFIED

9B-03 Namespace Isolation:
IMPLEMENTED / VERIFIED

9B-04 Parallel Lane:
IMPLEMENTED / VERIFIED

9B-05 Integration:
NOT IMPLEMENTED

9B-06 Acceptance:
NOT VERIFIED

This document is the normative human-readable contract for Job Isolation v1. It defines
WHAT Phase 9B means. It does NOT implement the runtime that enforces it.

---

## 1. Purpose

Lock deterministic, fail-closed job isolation semantics for multi-job and parallel work:

- a single normative `JobContract` (8 fields);
- canonical job identity and explicit profile binding;
- namespace isolation (session, knowledge, evidence, ledger, runtime-state);
- capability ceilings for execution permissions that never bypass the existing approval system;
- parallel lane semantics with one active writer per lane and a main coordination baseline;
- conflict detection with canonical fail-closed error identifiers;
- a 40-invariant Phase 9B acceptance model declared for #42.

## 2. Non-Goals

- No runtime implementation. No `runtime/job-isolation/*` module exists or is created here.
- No Context Hydration behavior change. Policy `context-hydration@1.0.1` stays frozen.
- No redesign of the approval system (`approval gate`, `safe mode` remain authoritative).
- No Phase 9C recovery/resume state machine.
- No cross-job coordination operation in v1.
- No secrets, credentials, or machine-specific state in tracked artifacts.

## 3. Definitions

| Term | Meaning |
|---|---|
| Job | One logical unit of work with one canonical `job_id` and one active `JobContract`. |
| JobContract | The normative 8-field record that binds a job to its identity, profile, namespaces, knowledge scope, and execution-permission ceiling. |
| Namespace | A logical identifier (not a filesystem path) that scopes job-owned state. |
| ParallelLane | A governance object binding one writer to one branch, one worktree, one job, and one explicit main baseline. |
| Coordination checkout | The single checkout that remains on `main` (machine-neutral reference: `<coordination-checkout>`). |
| Capability ceiling | The maximum capability a job may request; never an execution authorization. |
| Canonical error | A locked UPPER_SNAKE identifier returned by fail-closed validation. |

## 4. JobContract v1

JobContract v1 contains exactly these 8 normative fields, in canonical order:

1. `job_id`
2. `profile`
3. `session_namespace`
4. `knowledge_scope`
5. `evidence_namespace`
6. `ledger_namespace`
7. `runtime_state_namespace`
8. `execution_permissions`

Unknown JobContract fields FAIL CLOSED in v1. A future extension requires an explicit
policy/contract version change; v1 validators must reject unknown fields rather than ignore them.

## 4.1 Job Isolation Boundary vs JobContract

The Job Isolation boundary is NOT the JobContract record alone:

```text
Job Isolation Boundary
├── JobContract v1 (8 canonical fields)
├── derived working context
└── operation-specific execution context/target
```

- JobContract remains exactly 8 fields (section 4).
- Working context is a derived job-scoped view, not a JobContract field. It is derived through the
  job-scoped namespaces (`session_namespace`, `knowledge_scope`, `evidence_namespace`,
  `ledger_namespace`, `runtime_state_namespace`) plus the active operation's already-existing
  objective/constraints/context where applicable. It is not independently authoritative, not a new
  persisted identity, not caller-overridable as a JobContract field, cannot cross the `job_id`
  boundary, and cannot bypass namespace isolation.
- Database target is operation-specific execution context, not a JobContract field and not an
  isolation key. It must not override `job_id` or `profile`, must not elevate
  `execution_permissions`, and must not bypass the approval gate or safe mode. No credentials or
  connection strings are added to JobContract; operation-specific target metadata remains outside
  the strict 8-field schema.
- This does not weaken fail-closed validation: the boundary layers are either derived from the
  canonical JobContract (working context) or governed by the existing operation/execution context
  under the already-bound job identity, profile, permission ceiling, and approval/security boundary
  (database target). Neither layer can introduce new JobContract fields, and the strict
  unknown-field rejection remains unchanged: unknown JobContract fields FAIL CLOSED.

## 5. Field Semantic Matrix

Every field specifies: meaning, required, type, source of truth, normalization, immutability,
collision behavior, cross-job behavior, auditability.

| Field | Meaning | Required | Type | Source of truth | Normalization | Immutability | Collision behavior | Cross-job behavior | Auditability |
|---|---|---|---|---|---|---|---|---|---|
| `job_id` | canonical job identity | yes | string | main coordination authority at job creation | NFKC, trim, lowercase; pattern `^[a-z0-9][a-z0-9._-]{0,63}$`; length 1-64 | immutable while the job is active | `JOB_ID_COLLISION` (create collision; reuse with different immutable fields); exact persisted reuse is idempotent | foreign `job_id` fails closed (`FOREIGN_JOB_REJECT`) | recorded in JobContract, provenance, and ledger |
| `profile` | bound profile identity | yes | string | explicit profile selection; or explicitly declared + audited default | trim only; case preserved | immutable while the job is active | `PROFILE_BINDING_MISMATCH` on change; `PROFILE_BINDING_INVALID` on malformed | profile is per-job; no cross-job profile bleed | recorded in JobContract, provenance, and ledger |
| `session_namespace` | session operational state namespace | yes | string (derived) | deterministic derivation from canonical `job_id` | derived; caller override forbidden | derived and immutable | `NAMESPACE_COLLISION` / `NAMESPACE_OVERRIDE_FORBIDDEN` | scoped to the owning job only | namespace recorded in JobContract |
| `knowledge_scope` | knowledge eligibility boundary | yes | array | caller-declared from canonical enum | deduplicate; canonical order `JOB_LOCAL`, `SESSION_LOCAL`, `GLOBAL` | immutable while the job is active | `INVALID_KNOWLEDGE_SCOPE` on empty/unknown | foreign job knowledge fails closed; session equality never overrides foreign-job isolation | recorded in JobContract |
| `evidence_namespace` | execution/test evidence ownership | yes | string (derived) | deterministic derivation from canonical `job_id` | derived; caller override forbidden | derived and immutable | `NAMESPACE_COLLISION` / `NAMESPACE_OVERRIDE_FORBIDDEN` | evidence for Job A never satisfies Job B | namespace recorded in JobContract |
| `ledger_namespace` | execution records / decisions / audit / coordination entries | yes | string (derived) | deterministic derivation from canonical `job_id` | derived; caller override forbidden | derived and immutable | `NAMESPACE_COLLISION` / `NAMESPACE_OVERRIDE_FORBIDDEN` | no shared mutable ledger state between jobs | namespace recorded in JobContract |
| `runtime_state_namespace` | mutable runtime state boundary | yes | string (derived) | deterministic derivation from canonical `job_id` | derived; caller override forbidden | derived and immutable | `NAMESPACE_COLLISION` / `NAMESPACE_OVERRIDE_FORBIDDEN` | Job A never reads/writes Job B runtime state as its own | namespace recorded in JobContract |
| `execution_permissions` | capability ceiling bound to the job | yes | array | caller-declared from canonical enum | deduplicate; canonical order `READ_ONLY`, `LOW_RISK_WRITE`, `CONFIG_WRITE`, `DELETE`, `SECRET_ACCESS` | immutable while the job is active | `INVALID_EXECUTION_PERMISSIONS` on empty/unknown | capability never bypasses foreign-job isolation; no cross-job bleed | recorded in JobContract |

## 6. Job Identity

- `job_id` is required, non-empty, and canonicalized exactly as: Unicode NFKC, trim, lowercase.
- Canonical pattern: `^[a-z0-9][a-z0-9._-]{0,63}$`. Length: 1-64. Anything outside the pattern is rejected.
- Creation authority: main coordination authority. Creation occurs before any job-scoped namespace write.
- Caller-supplied IDs are allowed only during creation.
- A generated ID may be used only as an explicit one-time creation strategy and MUST be persisted before reuse.
- Resolution/reuse MUST NOT generate another identity.
- Forbidden identity sources: path separators, absolute paths, whitespace, probabilistic memory,
  free-text-objective-only derivation, LLM-generated resolution keys, wall-clock-dependent identity.
- `INVALID_JOB_ID` is introduced by Job Isolation v1 as a new canonical fail-closed error identifier.
  Its naming style follows the repository's existing UPPER_SNAKE error convention. No existing
  runtime implementation is claimed.

## 7. Creation vs Reuse

- CREATE: if the canonical `job_id` already belongs to another active job creation: `JOB_ID_COLLISION`.
- RESOLVE / REUSE: re-resolving the exact persisted JobContract for the same canonical job is
  allowed and idempotent. Deterministic reuse is NOT duplicate creation.
- If the same `job_id` is presented with different immutable fields: `JOB_ID_COLLISION`.

## 8. Profile Binding

- `profile` is required. Pattern (reused from the existing execution-context rule):
  `^[A-Za-z0-9][A-Za-z0-9._-]*$`. No path separators. No absolute paths.
- Normalization: trim only. Case is preserved; profile identifiers are NOT case-folded here
  because existing profile resolution semantics are not redesigned by this contract.
- The profile must be fully resolved BEFORE JobContract activation.
- Allowed sources: explicit profile selection; or an explicitly declared and audited default/inherited
  selection. Silent inheritance is FORBIDDEN.
- Once the JobContract is active, `profile` is immutable. Mismatch: `PROFILE_BINDING_MISMATCH`.
- This contract does NOT read profile files or secrets.

## 9. Namespace Derivation

Namespace identifiers are logical identifiers, NOT filesystem paths. Callers may not override
derived namespace fields. For canonical job ID `{job_id}`:

```text
session_namespace        = job:{job_id}:sessions
evidence_namespace       = job:{job_id}:evidence
ledger_namespace         = job:{job_id}:ledger
runtime_state_namespace  = job:{job_id}:runtime-state
knowledge job-local      = job:{job_id}:knowledge
```

Session-specific runtime derivation later appends a canonical session key:

```text
job:{job_id}:sessions:{session_key}
```

Derivation must be deterministic, pure, collision-safe, and job-bound. No runtime implementation
exists in this issue.

## 10. Session Namespace

| Session | Job | Behavior |
|---|---|---|
| same | same | job-local operational state |
| different | same | job-scoped state per contract; session-local state stays with its owning session |
| same | different | job isolation still applies; session identity MUST NOT bypass foreign-job isolation |
| different | different | fully isolated; cross access fails closed |

## 11. Knowledge Scope

- `knowledge_scope` is required and explicit. Type: array.
- Canonical enum: `JOB_LOCAL`, `SESSION_LOCAL`, `GLOBAL`.
- `JOB_LOCAL` must always be present. `SESSION_LOCAL` is explicit. `GLOBAL` is explicit opt-in.
- Duplicates are removed during canonicalization; canonical order: `JOB_LOCAL`, `SESSION_LOCAL`, `GLOBAL`.
- Empty scope is invalid. Unknown scope: `INVALID_KNOWLEDGE_SCOPE`.
- Isolation:
  - JOB_LOCAL requires the same canonical job. Foreign explicit `job_id`: `FOREIGN_JOB_REJECT`.
  - SESSION_LOCAL requires same canonical job AND same canonical session identity.
    Session equality NEVER overrides foreign-job isolation.
  - GLOBAL is eligible only when `GLOBAL` exists in the JobContract knowledge_scope AND the source
    itself is explicitly global/unowned by another job. GLOBAL permission MUST NOT make foreign
    job-local data global. Global scope provides read eligibility only; it does NOT grant global writes.
- Context Hydration scoring remains unchanged: `context-hydration@1.0.1`.

## 12. Evidence Namespace

- Invariant: evidence created for Job A MUST NOT silently satisfy Job B.
- Same-job access: allowed, subject to later runtime operation policy.
- Cross-job access: `FOREIGN_JOB_REJECT`. Cross-job writes: `FOREIGN_NAMESPACE_WRITE_REJECTED`.
- No shared/global evidence namespace exists in v1 unless a later governance contract explicitly adds one.

## 13. Ledger Namespace

- Ledger owns job-scoped execution records, decisions, audit events, and coordination entries.
- Different jobs MUST NOT share mutable ledger state.
- Ledger isolation only. No recovery state transitions belong here.

## 14. Runtime-State Namespace

- Runtime state is mutable and strictly job-bound.
- Invariant: Job A cannot read/write Job B mutable runtime state as if it were its own.
- Foreign write: `FOREIGN_NAMESPACE_WRITE_REJECTED`.
- Cleanup ownership: the owning canonical job namespace only.
- Cross-job coordination does not exist implicitly; any future cross-job coordination operation
  must be explicitly governed.

## 15. Execution Permissions

- Type: array. Canonical values, in canonical order: `READ_ONLY`, `LOW_RISK_WRITE`, `CONFIG_WRITE`,
  `DELETE`, `SECRET_ACCESS`.
- `READ_ONLY` must always be present. Unknown capability: `INVALID_EXECUTION_PERMISSIONS`.
- Duplicates are canonicalized to one occurrence. Empty is invalid.
- Crucially: this array is a capability ceiling, never an approval token.

## 16. Approval-System Compatibility

The existing tracked authority (`.opencode/orchestrator/approval-gate.md`,
`.opencode/orchestrator/safe-mode.md`) remains authoritative.

| Job permission | Existing action class | JobContract alone authorizes execution? |
|---|---|---|
| READ_ONLY | READ | NO |
| LOW_RISK_WRITE | WRITE | NO |
| CONFIG_WRITE | WRITE | NO |
| DELETE | WRITE / destructive | NO |
| SECRET_ACCESS | protected access | NO |

- JobContract `execution_permissions` define the maximum capability a job may request.
  They are NOT execution authorization.
- READ still requires plan presentation and explicit user release.
- WRITE still requires explicit approval.
- DELETE and SECRET_ACCESS remain ineffective unless separately governed; otherwise fail closed.
- No job can self-elevate by adding a permission to its own contract.
- Job Isolation MUST NOT bypass: the approval gate, safe mode, security checks, project-root boundaries.

## 17. ParallelLane v1

ParallelLane is a governance object. Required fields:

```text
lane_id
job_id
branch
worktree
writer_identity
baseline_main_sha
```

This is a governance contract only. No runtime code is created.

## 18. Lane Ownership

- Invariant: one active writer per lane.
- Two distinct writer identities claiming the same mutable lane: `LANE_OWNERSHIP_CONFLICT`.
- A lane cannot silently change its owning job.
- A lane is immutable with respect to: `job_id`, `branch`, `worktree` ownership, writer identity,
  and `baseline_main_sha` at creation. Intentional baseline synchronization must be explicit and audited.
- Cross-lane writes: a writer assigned to Lane A must not claim or mutate Lane B-owned files as
  Lane B's writer. Violation: `CROSS_LANE_WRITE_REJECTED`. Detection/outcome only; no recovery semantics.

## 19. Coordination Main Authority

Main is: authoritative merged state; integration baseline; dependency coordination authority;
merge-eligibility source; post-merge verification baseline.

Main is NOT: the only execution thread; an agent manager; a forced delegation hierarchy.

Writer lanes may operate concurrently after their dependency gates allow them. The coordination
checkout remains main-only. Writer lane branches MUST NOT be `main`; attempts are
`COORDINATION_CHECKOUT_VIOLATION`. Tracked examples use machine-neutral forms such as
`<coordination-checkout>` and `<worktree-root>/<issue-id>`.

## 20. Stale Baseline Detection

- `baseline_main_sha` is required for every writer lane. Pattern: `^[0-9a-f]{40}$`.
- Purpose: record the exact authoritative main state from which lane work began.
- At integration/merge eligibility evaluation, if authoritative main differs and the lane has not
  intentionally synchronized: `STALE_MAIN_BASELINE`.
- A stale lane is never authoritative main.

## 21. Conflict Detection

Phase 9B detects: branch divergence; namespace collision; lane ownership collision; job identity
collision; foreign-job write attempt. Detection and fail-closed outcomes only. Recovery belongs
to Phase 9C.

## 22. Canonical Errors

Exactly these 18 identifiers are normative for Phase 9B. They are introduced by this contract;
no existing runtime implementation is claimed.

```text
JOB_CONTRACT_INVALID
INVALID_JOB_ID
JOB_ID_COLLISION

PROFILE_BINDING_INVALID
PROFILE_BINDING_MISMATCH

NAMESPACE_DERIVATION_FAILED
NAMESPACE_OVERRIDE_FORBIDDEN
NAMESPACE_COLLISION

FOREIGN_JOB_REJECT
FOREIGN_NAMESPACE_WRITE_REJECTED
INVALID_KNOWLEDGE_SCOPE
INVALID_EXECUTION_PERMISSIONS

LANE_CONTRACT_INVALID
LANE_ID_COLLISION
LANE_OWNERSHIP_CONFLICT
CROSS_LANE_WRITE_REJECTED

COORDINATION_CHECKOUT_VIOLATION
STALE_MAIN_BASELINE
```

## 23. Validation Precedence

Deterministic fail precedence (first failing condition wins; no nondeterministic error selection):

```text
1. structural JobContract validity
2. canonical job_id
3. profile binding
4. namespace integrity
5. knowledge_scope
6. execution_permissions
7. job identity/collision/foreign-job boundary
8. ParallelLane structural validity
9. lane identity/collision/ownership
10. coordination/main-baseline constraints
```

## 24. Determinism

Identical canonical inputs MUST produce identical: JobContract representation; namespace roots;
knowledge-scope order; execution-permission order; ParallelLane identity resolution; validation
outcome; canonical error result.

No resolution identity may depend on: wall clock; randomness after persisted creation;
probabilistic memory; LLM output; unordered object iteration; machine-specific paths.

## 25. Security / Public Repository Boundary

- No secret/env/profile reads are required or performed by this contract.
- Never track: client data, PGN data, credentials, secret profiles, runtime auth state, private
  personal memory, opencode.db, browser profiles, machine-specific evidence, machine-specific
  runtime databases, or machine-specific absolute paths.
- Tracked artifacts are reusable infrastructure only.

## 26. Context Hydration Compatibility

- Policy `context-hydration@1.0.1` remains frozen. No scoring-weight changes.
- Phase 9B adds isolation semantics only; it does not modify the verified 9A pipeline.

## 27. Phase 9C Boundary

Phase 9B may detect stale baseline, ownership conflict, namespace collision, job collision, and
foreign-job attempts. Phase 9B MUST NOT define transitions such as: NEW, ACTIVE, CHECKPOINTED,
BLOCKED, INTERRUPTED, FAILED, CONFLICTED, MERGE_PENDING, RESOLVED, ARCHIVED. Those belong to
Phase 9C. No recovery/resume state machine appears in this contract, its policy, the architecture
doc, or its tests.

## 28. Phase 9B Acceptance Model

Exactly 40 future acceptance invariants are declared here for #42. They are NOT runtime acceptance
executions in #37.

### JobContract — JC01–JC10

```text
JC01 required JobContract fields enforced
JC02 job_id normalization deterministic
JC03 invalid job_id rejected
JC04 create collision fails while exact persisted reuse is idempotent
JC05 profile required and valid
JC06 active profile binding immutable
JC07 namespace fields derived and caller override rejected
JC08 knowledge scopes explicit and canonically ordered
JC09 execution permissions explicit and canonically ordered
JC10 identical canonical input produces identical JobContract
```

### Namespace Isolation — NS01–NS10

```text
NS01 same session + same job stays inside job boundary
NS02 different sessions + same job share only job-scoped state
NS03 same session + different job rejects foreign-job access
NS04 different session + different job fully isolated
NS05 JOB_LOCAL knowledge rejects foreign job
NS06 SESSION_LOCAL requires same job + same session
NS07 GLOBAL requires explicit job capability + explicitly global source
NS08 evidence from Job A cannot satisfy Job B
NS09 ledger/runtime mutable state reject foreign-job access/write
NS10 namespace derivation deterministic; collision/derivation ambiguity fails closed
```

### Parallel Lanes — PL01–PL10

```text
PL01 one active writer per lane
PL02 multiple independent lanes may operate concurrently
PL03 lane job binding immutable
PL04 cross-lane write ownership violation rejected
PL05 coordination checkout remains main-only
PL06 writer lane branch cannot be main
PL07 baseline_main_sha required
PL08 stale main baseline detected
PL09 tracked worktree representation remains machine-neutral
PL10 stale lane state never becomes authoritative main implicitly
```

### Execution / Policy — EP01–EP10

```text
EP01 execution permissions explicit and READ_ONLY present
EP02 unknown permission fails closed
EP03 JobContract permissions are capability ceilings, not approvals
EP04 WRITE-class capability still requires approval gate
EP05 DELETE is not authorized by JobContract alone
EP06 SECRET_ACCESS is not authorized by JobContract alone
EP07 declared capability never bypasses foreign-job isolation
EP08 validation/error precedence deterministic
EP09 unresolved identity/namespace ambiguity never falls back to shared/default scope
EP10 public tracked artifacts contain no secrets, private state, or machine-specific runtime data
```

Total: 40.

## 29. Implementation Status

- Status: CONTRACT LOCKED
- Policy: job-isolation@1.0.0
- Implementation: PARTIAL
- Implemented runtime modules: `runtime/job-isolation/job-contract.js` (JobContract Runtime Core, 9B-02 / #38), `runtime/job-isolation/namespace-derivation.js` (deterministic namespace derivation primitives, 9B-02 / #38), `runtime/job-isolation/parallel-lane.js` (ParallelLane runtime semantics, 9B-04 / #40), `runtime/job-isolation/namespace-isolation.js` (namespace isolation enforcement, 9B-03 / #39), and `runtime/job-isolation/knowledge-scope.js` (knowledge-scope read eligibility, 9B-03 / #39).
- Pending: parallel lane main integration (9B-05), main coordination integration (9B-05), Phase 9B acceptance (9B-06).
- Acceptance executions: declared for 9B-06 (#42); NOT VERIFIED.
- Architecture Freeze: NOT CLAIMED.
