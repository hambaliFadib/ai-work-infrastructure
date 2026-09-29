# Job Isolation — Architecture Document

Status: CONTRACT LOCKED
RUNTIME IMPLEMENTATION: IN PROGRESS / PARTIAL
Policy: job-isolation@1.0.0
Phase: 9B
Governance issue: #37 (9B-01)

This document describes the architecture of Job Isolation v1 as locked by
`governance/contracts/job-isolation-v1.md`. The JobContract core and namespace derivation
primitives are implemented runtime modules; remaining stages are conceptual.

All flow descriptions below are:

CONCEPTUAL / PARTIAL — see section 5

---

## 1. Conceptual Flow

```text
Job creation/resolution
        |
        v
JobContract validation
        |
        v
Canonical identity
        |
        v
Namespace derivation
        |
        v
Knowledge + permission binding
        |
        v
ParallelLane resolution
        |
        v
Isolation / ownership gates
        |
        v
eligible execution context
```

## 2. Job Isolation Boundary (Conceptual)

```text
Job Isolation Boundary
├── JobContract v1 (8 canonical fields)
├── Derived working context
└── Operation-specific execution context/target
```

CONCEPTUAL / PARTIAL — see section 5

- The JobContract record is exactly 8 canonical fields; unknown fields fail closed.
- Working context is a derived job-scoped view, not a JobContract field.
- Database targets (and similar operation-specific targets) are execution context outside the
  JobContract schema; they cannot override job/profile, elevate permissions, or bypass
  approval/security boundaries. Database target handling is NOT implemented runtime behavior.

## 3. Stage Notes (Conceptual)

1. Job creation/resolution
   - Creation authority: main coordination authority, before any job-scoped namespace write.
   - Creation vs reuse is explicit; deterministic reuse of the exact persisted contract is idempotent.

2. JobContract validation
   - Exactly 8 required fields; unknown fields fail closed.
   - Deterministic validation precedence (see contract section 23).

3. Canonical identity
   - `job_id`: NFKC, trim, lowercase; `^[a-z0-9][a-z0-9._-]{0,63}$`; length 1-64.
   - Profile binding: explicit, trim-only, case-preserving, immutable while active.

4. Namespace derivation
   - Namespaces are logical identifiers derived purely from canonical job identity:
     `job:{job_id}:sessions`, `job:{job_id}:evidence`, `job:{job_id}:ledger`,
     `job:{job_id}:runtime-state`, `job:{job_id}:knowledge`.
   - Caller override is forbidden; derivation failure and collision fail closed.

5. Knowledge + permission binding
   - Knowledge scope: `JOB_LOCAL` (always), `SESSION_LOCAL`, `GLOBAL` (explicit opt-in), canonically ordered.
   - Execution permissions: `READ_ONLY`, `LOW_RISK_WRITE`, `CONFIG_WRITE`, `DELETE`, `SECRET_ACCESS` -
     a capability ceiling, never an approval token.

6. ParallelLane resolution
   - Fields: `lane_id`, `job_id`, `branch`, `worktree`, `writer_identity`, `baseline_main_sha`.
   - One active writer per lane; lane identity is immutable; `baseline_main_sha` is required.

7. Isolation / ownership gates
   - Foreign job access and foreign namespace writes fail closed.
   - Cross-lane writes fail closed; coordination checkout remains main-only.
   - Stale main baselines are detected, never treated as authoritative main.

8. Eligible execution context
   - The result is a validated, isolated job context. Actual execution authorization continues to
     come exclusively from the existing approval system (approval gate + safe mode).

## 4. Boundary Notes

- Context Hydration: policy `context-hydration@1.0.1` remains frozen; Phase 9B adds isolation
  semantics only and does not modify the verified 9A pipeline.
- Phase 9C: recovery/resume states (NEW, ACTIVE, CHECKPOINTED, BLOCKED, INTERRUPTED, FAILED,
  CONFLICTED, MERGE_PENDING, RESOLVED, ARCHIVED) are out of scope; Phase 9B defines detection
  and fail-closed outcomes only.
- Public repository boundary: no secrets, private state, or machine-specific runtime data in
  tracked artifacts; worktree references use machine-neutral forms
  (`<coordination-checkout>`, `<worktree-root>/<issue-id>`).

## 5. Implementation Status

CONTRACT LOCKED. RUNTIME IMPLEMENTATION: IN PROGRESS / PARTIAL.

Implemented:
- JobContract Runtime Core (runtime/job-isolation/job-contract.js, 9B-02 / #38)
- deterministic namespace derivation primitives (runtime/job-isolation/namespace-derivation.js, 9B-02 / #38)

Pending:
- namespace isolation enforcement (9B-03 / #39)
- merged ParallelLane semantics (9B-04 / #40)
- main coordination integration (9B-05 / #41)
- Phase 9B acceptance (9B-06 / #42)

Isolation enforcement is NOT implemented. Parallel-lane semantics are NOT merged.
Acceptance executions are declared for 9B-06 (#42) and are NOT VERIFIED.
