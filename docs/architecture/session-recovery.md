# Session Recovery — Architecture Document

Status: CONTRACT LOCKED
RUNTIME IMPLEMENTATION: PARTIAL (9C-03 core)
Phase 9C: CONTRACT LOCKED / NOT VERIFIED
Policy: session-recovery@1.0.1
Phase: 9C
Epic: #17

This document describes the architecture of Session Recovery v1 as specified by
`governance/contracts/session-recovery-v1.md`. No runtime module exists: there
is no `runtime/session-recovery/*`, no transition engine, no checkpoint store
implementation, and no acceptance suite. Everything below is

CONTRACTUAL / NOT IMPLEMENTED — see section 5

---

## 1. Conceptual Flow

```text
RecoveryObject CREATE (valid JobContract required)
        |
        v
explicit operation request (one of 41 allow-listed edges)
        |
        v
validation precedence P1-P13
  (9B identity/isolation -> record -> replay -> legality ->
   edge evidence -> approval)
        |
        v
atomic apply: state update + immutable transition record
        |
        v
deterministic result envelope
  (APPLIED | IDEMPOTENT_REPLAY | canonical error)
```

No other path changes recovery state. Reads, restarts, and validations never
transition. No silent recovery.

## 2. State Model (Conceptual)

```text
NEW \
|    \
|     v
|     ACTIVE --CHECKPOINT_CREATE--> CHECKPOINTED
|     ACTIVE <--RESUME------------- CHECKPOINTED
|       |                                 |  \
|ARCHIVE| record ops         v------------+   \
|   +-------------------------+                \
|   | BLOCKED   INTERRUPTED   |                 |
|   | FAILED    CONFLICTED    |                 |
|   | MERGE_PENDING           |                 |
|   +---------|---------|-----+                 |
|             v         |                       |
|         +---------+   |                       |
|         | RESOLVED|   |                       |
|         +----|----+   |                       |
|              |ARCHIVE | ARCHIVE               | ARCHIVE
|              |        |                       |
+--------------+--------+-----------------------+--> ARCHIVED
                                                     (terminal)
```

Figure notes (the figure is intentionally non-exhaustive):

- **Normative source: contract section 6.3 (the 41-edge allow-list) and
  section 6.4 (hard forbiddens). Where this diagram and sections 6.3/6.4
  disagree in any way, sections 6.3/6.4 win.**
- `NEW -> ARCHIVED` (left ARCHIVE lane) and `RESOLVED -> ARCHIVED` are drawn
  and accurate.
- **`ACTIVE -> ARCHIVED` does not exist and is not drawn** — hard forbidden
  (section 6.4): running work must be concluded or interrupted first.
  `MERGE_PENDING -> ARCHIVED` is likewise forbidden; the halt-states box
  feeds ARCHIVE from every member except MERGE_PENDING.
- Edges not drawn (all legal, section 6.3): `ACTIVE -> RESOLVED` (CLOSE),
  `CHECKPOINTED -> RESOLVED` (CLOSE), `CHECKPOINTED -> CHECKPOINTED`
  (self-edge), halt-state returns to ACTIVE (`UNBLOCK`, `RESUME`, `REOPEN`,
  `CONFLICT_RESOLVE`).
- Exactly 10 states; ARCHIVED is the sole terminal state (zero outgoing
  edges); RESOLVED is non-terminal with exactly one outgoing edge
  (`RESOLVED -> ARCHIVED`).
- Only self-edge: `CHECKPOINTED -> CHECKPOINTED` (checkpoint creation).
- No transition into NEW; no transition out of ARCHIVED.
- State is record-authoritative posture; store occupancy is never read as
  state.

## 3. Storage Map (Conceptual, logical identifiers only)

```text
Phase 9B session_namespace root:   job:{job_id}:sessions
RecoveryObject subtree:            job:{job_id}:sessions:{session_key}
    recovery/                      RecoveryObject record (strict schema)
    transitions/                   append-only transition records
    checkpoints/{seq}              immutable checkpoints (append-only)

Not written by 9C:
    job:{job_id}:ledger            (Phase 9B section 13: no recovery
                                    state transitions belong here)
    job:{job_id}:runtime-state     (Phase 9B mutable runtime boundary)
```

Checkpoints and recovery records are local-only state (`state/sessions/*`
ignored); tracked artifacts are governance documents only.

## 4. Stage Notes (Conceptual)

1. RecoveryObject CREATE
   - Identity: exactly `(canonical job_id, opaque session_key)`; one object
     per pair forever; exact-pair reuse is idempotent; identity immutable.
   - Requires a valid Phase 9B JobContract (8 fields, unchanged).

2. State transitions
   - Allow-list of exactly 41 ordered pairs; `operation = f(from, to)`;
     everything else fails `ILLEGAL_TRANSITION`.
   - Preconditions, postconditions, and P1-P13 precedence are normative in
     contract sections 6-7.

3. Checkpoints
   - `checkpoint_id = job:{job_id}:sessions:{session_key}:checkpoint:{seq}`;
     persisted monotonic `checkpoint_seq`; no wall clock, no randomness, no
     LLM-derived identity.
   - Immutable, append-only; duplicate content is `IDEMPOTENT_REPLAY`
     (content-scoped: evaluated at P11 after P9 head-replay and P10
     legality, before P12; remains idempotent across intervening
     transitions — contract section 8.4); latest valid = maximum seq
     passing integrity; corrupted maximum fails `CHECKPOINT_INVALID` with
     no fallback to older.
   - Consistency: `CHECKPOINTED => store non-empty`; a non-empty store does
     NOT imply CHECKPOINTED (ACTIVE after RESUME may hold checkpoints);
     `NEW => empty store, checkpoint_seq = 0`.

4. Resume / recovery edges
   - Every `->ACTIVE` edge validates the target checkpoint when the store is
     non-empty; for re-entry edges (`UNBLOCK`, `RESUME` from INTERRUPTED,
     `REOPEN`, `CONFLICT_RESOLVE`) an empty store requires recorded cold
     entry/resume evidence. `START` is exempt: NEW implies an empty store
     (invariant I2) and the applied START transition record is itself the
     recorded cold entry (contract sections 6.5-6.6). Validation never
     deletes, mutates, repairs, or replaces checkpoints.
   - Resume, unblock, re-open, conflict resolution, merge closure, and
     archive are explicit and approval-gated.

5. Merge composition
   - MERGE_PENDING consumes a frozen Phase 9B merge-eligibility decision by
     reference; eligibility authorizes nothing; 9C never executes a merge;
     `INTEGRATE_CLOSE` requires merge-applied evidence, post-merge
     verification evidence, audited synchronization when stale, and approval;
     `STALE_MAIN_BASELINE` propagates unchanged.

6. Approval / safety
   - All 41 transitions approval-gated; `contract_alone_authorizes_execution
     = false`; approval gate + safe mode remain authoritative; no bypass of
     approval gate, safe mode, security checks, or project-root boundaries.

## 5. Implementation Status

CONTRACT LOCKED. RUNTIME IMPLEMENTATION: PARTIAL (9C-03). PHASE 9C: NOT
VERIFIED.

Implemented (9C-03):
- `runtime/session-recovery/core/recovery-object.js` — RecoveryObject
  identity, strict schema validation, CREATE/idempotency, policy_ref
  enforcement, tamper detection.
- `runtime/session-recovery/core/checkpoint.js` — Checkpoint identity
  derivation, monotonic sequence, latest-valid resolution, duplicate-content
  idempotency, ownership verification.
- `runtime/session-recovery/core/index.js` — Deterministic facade combining
  RecoveryObject + Checkpoint into a single module API.
- `runtime/tests/session-recovery/` — 40 integration test cases covering
  the locked Phase 9C-03 semantics. 3 suites, all passing.

Pending (9C-04+):
- transition engine, lifecycle operations (START, RESUME, CLOSE, ARCHIVE),
  approval/security enforcement, acceptance suite (future child issues)

Acceptance:
- DECLARED, not executed — 70 invariants (RC01-RC08, ST01-ST12, CP01-CP10,
  ID01-ID07, IF01-IF07, MP01-MP08, DI01-DI08, SB01-SB10);
  docs/acceptance/phase-9c.md does not exist yet

Boundary notes:
- Policy `context-hydration@1.0.1` frozen; H08 unchanged.
- `job-isolation@1.0.0` unchanged; locked 18 Phase 9B errors unchanged.
- Architecture Freeze v1: NOT CLAIMED (still requires Phase 9C VERIFIED).
- Production Readiness: NOT PROVEN.
