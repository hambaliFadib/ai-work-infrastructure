# Session Recovery v1 — Governance Contract

Status: CONTRACT LOCKED
Policy: session-recovery@1.0.1
Policy Version: 1.0.1
Policy Ref: session-recovery@1.0.1
Supersedes: session-recovery@1.0.0 (initial merged contract, PR #53)
Supersession Reason: Post-merge governance review corrections — P1 deterministic
idempotency precedence for duplicate checkpoint retry; P2a START cold-entry
resolution; P2b architecture diagram accuracy. The 10 states, the 41-edge
allow-list, the 8 canonical errors, P1-P13, and the 70 acceptance IDs are
unchanged.
Implementation: PARTIAL (9C-03 core)
Phase: 9C (Session Recovery)
Epic: #17
Governance issues: 9C-01 (discovery + governance review), 9C-02 (contract lock),
9C-02 review-findings fix-forward

Acceptance model: DECLARED — 70 invariants, not executed. Acceptance evidence
file docs/acceptance/phase-9c.md belongs to the future acceptance phase and does
not exist yet.

This document is the normative human-readable contract for Session Recovery v1.
It defines WHAT Phase 9C means. It was introduced as a governance-only act by
9C-02 and does not authorize execution; no runtime implementation exists.

---

## 1. Purpose

Lock deterministic, fail-closed session recovery semantics for durable work
sessions:

- a single normative 10-state recovery model with exactly one terminal state;
- a 41-edge allow-list transition machine with `operation = f(from_state, to_state)`;
- a normative RecoveryObject identified by exactly `(canonical job_id, opaque session_key)`;
- an immutable, append-only checkpoint model with deterministic identity and
  one-directional state consistency;
- a canonical 9C error set of exactly 8 identifiers with a locked 13-step
  validation precedence;
- approval-gated transitions with no self-authorizing recovery;
- a 70-invariant Phase 9C acceptance model declared for future execution.

Core principle (repository-declared, Epic #17): No silent recovery.

## 2. Non-Goals

- No runtime implementation in 9C-02. Implementation status: NONE.
- No Context Hydration behavior change. Policy `context-hydration@1.0.1` stays
  frozen; H08 is unchanged.
- No Phase 9B change. `job-isolation@1.0.0` contract, policy, runtime, and
  acceptance remain untouched; the locked 18 Phase 9B errors remain untouched.
- No redesign of the approval system (`approval gate`, `safe mode` remain
  authoritative).
- No merge execution by 9C. Merge application remains an external coordination
  act; 9C only records and verifies by reference.
- No cross-job recovery operation in v1.
- No secrets, credentials, or machine-specific state in tracked artifacts.
- No claim of Phase 9C VERIFIED, Architecture Freeze, or Production Readiness.

## 3. Definitions

| Term | Meaning |
|---|---|
| RecoveryObject | The normative record binding one `(job_id, session_key)` pair to its recovery state, `transition_seq`, `checkpoint_seq`, and `policy_ref`. |
| session_key | The opaque canonical session identity of Phase 9B; exact string match only; never normalized, derived, or parsed by 9C. |
| State | One of exactly 10 canonical recovery states; record-authoritative posture; never derived from store occupancy. |
| Transition | A change from one allowed `(from_state, to_state)` pair to another, applied only by an explicit operation. |
| Operation | The canonical action named by the pure function `f(from_state, to_state)` over the 41-edge allow-list. |
| Allow-list | The exact set of 41 ordered state pairs in section 6. Every other ordered pair fails closed. |
| Terminal state | A state with zero allowed outgoing edges. ARCHIVED is the sole terminal state. |
| Checkpoint | An immutable artifact storing a canonical payload and its `payload_digest`, identified by `checkpoint_id`. |
| Latest valid checkpoint | The checkpoint with the maximum `checkpoint_seq` that passes integrity validation. |
| Cold entry / cold resume | An `->ACTIVE` transition with zero checkpoints in store, recorded explicitly: `START` cold entry is recorded by its own applied transition record (sections 6.5-6.6); re-entry cold entry/resume additionally requires the edge evidence reference of section 6.5. |
| Evidence reference | A canonical non-empty reference identifier recorded in a transition record; free-text bodies are never identity inputs. |
| Replay | An operation identical to the most recently applied transition `(from_state, to_state, operation, arg_fingerprint)`; returns `IDEMPOTENT_REPLAY`. |
| Canonical error | A locked UPPER_SNAKE identifier returned by fail-closed validation. |
| Logical identifier | A derived string for write/compare only; never parsed or decomposed. |

## 4. RecoveryObject v1

### 4.1 Identity

- Identity is exactly the pair `(canonical job_id, opaque session_key)`.
  `job_id` is canonicalized by Phase 9B rules (NFKC, trim, lowercase,
  `^[a-z0-9][a-z0-9._-]{0,63}$`, length 1-64).
- Exactly one RecoveryObject exists per pair, forever.
- `CREATE` on an existing exact pair is idempotent and returns the existing
  record. A `policy_ref` mismatch or malformed persisted record fails closed
  with `SESSION_RECOVERY_INVALID`; no repair, no replacement record.
- Identity fields (`job_id`, `session_key`) are immutable after creation.

### 4.2 Record schema (strict)

Fields, exact, canonical order:

```text
1. job_id
2. session_key
3. current_state
4. transition_seq      (monotonic integer, starts 0)
5. checkpoint_seq      (monotonic integer, starts 0)
6. policy_ref          (session-recovery@1.0.1)
```

Unknown fields FAIL CLOSED with `SESSION_RECOVERY_INVALID`. No timestamps,
no random values, no machine-specific content. A future schema extension
requires an explicit `session-recovery` policy version change.

### 4.3 Persisted policy_ref compatibility

- Current policy ref: a persisted RecoveryObject must carry exactly
  `session-recovery@1.0.1`. Compatibility is exact-current: the sole
  compatible value is the exact current ref; there is no version range, no
  alias, and no compatibility window.
- Superseded ref: a persisted RecoveryObject carrying
  `session-recovery@1.0.0` is incompatible with the current policy.
- Result: reading or validating a superseded-policy record under 1.0.1 fails
  closed at P7 with `SESSION_RECOVERY_INVALID` — identical to every other
  `policy_ref` mismatch (sections 4.1 and 15).
- No implicit migration: 9C never rewrites `policy_ref`, never rebinds
  `@1.0.0` to `@1.0.1`, never repairs or rewrites the record, never aliases
  the superseded ref, never auto-migrates persisted records, and never
  creates a replacement RecoveryObject.
- `session-recovery@1.0.0` had Implementation: NONE; no historical runtime
  migration event exists and none is asserted.
- Future migration: any migration from a superseded persisted policy version
  is a separate, explicit, reviewed governance change with its own versioning
  and acceptance. It is not part of 9C-02 or this review-findings
  clarification, and no migration path exists under 1.0.1.

## 5. State Model

Exactly these 10 states, in declared order:

```text
NEW, ACTIVE, CHECKPOINTED, BLOCKED, INTERRUPTED, FAILED,
CONFLICTED, MERGE_PENDING, RESOLVED, ARCHIVED
```

| State | Definition | Terminal? |
|---|---|---|
| NEW | RecoveryObject created via explicit `CREATE`; JobContract validated at creation; `transition_seq=0`; zero execution progress; empty checkpoint store (`checkpoint_seq=0`). | No |
| ACTIVE | Execution in progress under a valid JobContract and owning session; checkpoint creation permitted; a non-empty checkpoint store is legal (for example after RESUME). | No |
| CHECKPOINTED | Execution posture "paused at a checkpoint". Entered only by an applied `CHECKPOINT_CREATE`, which appends exactly one checkpoint. | No |
| BLOCKED | Progress halted by an explicit recorded governance/approval/dependency block; no automatic unblock. | No |
| INTERRUPTED | Execution stopped by external interruption with no fault assigned; durable across restarts; resume only by explicit human `RESUME`. | No |
| FAILED | Execution ended with a recorded canonical fail-closed error code as evidence; never auto-retried. | No |
| CONFLICTED | A Phase 9B conflict detection (or operational merge-lock conflict) recorded with its canonical code; work halted pending explicit audited resolution. | No |
| MERGE_PENDING | A frozen Phase 9B merge-eligibility decision with `merge_eligible=true` recorded by reference; merge NOT applied; the state never implies or authorizes merge execution. | No |
| RESOLVED | Formal closure of the lifecycle with recorded evidence and approval; no further execution or reopening; its only outgoing edge is `RESOLVED -> ARCHIVED`. | **No** |
| ARCHIVED | Session moved out of active namespaces (move, never delete), user-confirmed; same-pair governance re-entry does not exist in v1. | **Yes — sole terminal state** |

Terminality rules:

- ARCHIVED is the sole terminal state: zero allowed outgoing edges.
- RESOLVED is non-terminal: exactly one outgoing edge, `RESOLVED -> ARCHIVED`.
- State is record-authoritative posture. Store occupancy is never read as state
  (section 8.5 states the consistency invariants precisely).

## 6. Transition Model

### 6.1 Allow-list semantics

- Exactly 41 ordered pairs are allowed (section 6.2 and 6.3).
- Every other ordered pair (59 of the 100 ordered pairs, including 9 self-edges)
  fails closed with `ILLEGAL_TRANSITION`.
- No transition into NEW. NEW is reachable only by `CREATE`.
- No transition out of ARCHIVED.
- The only allowed self-edge is `CHECKPOINTED -> CHECKPOINTED`.
- `operation` is a pure function of `(from_state, to_state)`. Ad-hoc operation
  names are rejected.
- No transition occurs without an explicit, audited, precondition-checked,
  approval-gated operation. No automatic transition on process restart, wall
  clock, reads, validations, or staleness heuristics.

### 6.2 Transition matrix (cell = canonical operation)

| from \ to | NEW | ACTIVE | CHECKPOINTED | BLOCKED | INTERRUPTED | FAILED | CONFLICTED | MERGE_PENDING | RESOLVED | ARCHIVED |
|---|---|---|---|---|---|---|---|---|---|---|
| **NEW** | — | `START` | — | — | — | — | — | — | — | `ARCHIVE` |
| **ACTIVE** | — | — | `CHECKPOINT_CREATE` | `BLOCK_RECORD` | `INTERRUPT_RECORD` | `FAILURE_RECORD` | `CONFLICT_RECORD` | `MERGE_ELIGIBLE_RECORD` | `CLOSE` | — |
| **CHECKPOINTED** | — | `RESUME` | `CHECKPOINT_CREATE` | `BLOCK_RECORD` | `INTERRUPT_RECORD` | `FAILURE_RECORD` | `CONFLICT_RECORD` | `MERGE_ELIGIBLE_RECORD` | `CLOSE` | `ARCHIVE` |
| **BLOCKED** | — | `UNBLOCK` | — | — | — | `FAILURE_RECORD` | `CONFLICT_RECORD` | — | `CLOSE` | `ARCHIVE` |
| **INTERRUPTED** | — | `RESUME` | — | — | — | `FAILURE_RECORD` | `CONFLICT_RECORD` | — | `CLOSE` | `ARCHIVE` |
| **FAILED** | — | `REOPEN` | — | — | — | — | `CONFLICT_RECORD` | — | `CLOSE` | `ARCHIVE` |
| **CONFLICTED** | — | `CONFLICT_RESOLVE` | — | — | — | `FAILURE_RECORD` | — | — | `CLOSE` | `ARCHIVE` |
| **MERGE_PENDING** | — | — | — | `BLOCK_RECORD` | — | `FAILURE_RECORD` | `CONFLICT_RECORD` | — | `INTEGRATE_CLOSE` | — |
| **RESOLVED** | — | — | — | — | — | — | — | — | — | `ARCHIVE` |
| **ARCHIVED** | — | — | — | — | — | — | — | — | — | — |

### 6.3 Canonical allow-list (normative machine-parseable form)

Exactly these 41 lines; the matrix in 6.2 is the same set:

```text
NEW -> ACTIVE : START
NEW -> ARCHIVED : ARCHIVE
ACTIVE -> CHECKPOINTED : CHECKPOINT_CREATE
ACTIVE -> BLOCKED : BLOCK_RECORD
ACTIVE -> INTERRUPTED : INTERRUPT_RECORD
ACTIVE -> FAILED : FAILURE_RECORD
ACTIVE -> CONFLICTED : CONFLICT_RECORD
ACTIVE -> MERGE_PENDING : MERGE_ELIGIBLE_RECORD
ACTIVE -> RESOLVED : CLOSE
CHECKPOINTED -> ACTIVE : RESUME
CHECKPOINTED -> CHECKPOINTED : CHECKPOINT_CREATE
CHECKPOINTED -> BLOCKED : BLOCK_RECORD
CHECKPOINTED -> INTERRUPTED : INTERRUPT_RECORD
CHECKPOINTED -> FAILED : FAILURE_RECORD
CHECKPOINTED -> CONFLICTED : CONFLICT_RECORD
CHECKPOINTED -> MERGE_PENDING : MERGE_ELIGIBLE_RECORD
CHECKPOINTED -> RESOLVED : CLOSE
CHECKPOINTED -> ARCHIVED : ARCHIVE
BLOCKED -> ACTIVE : UNBLOCK
BLOCKED -> FAILED : FAILURE_RECORD
BLOCKED -> CONFLICTED : CONFLICT_RECORD
BLOCKED -> RESOLVED : CLOSE
BLOCKED -> ARCHIVED : ARCHIVE
INTERRUPTED -> ACTIVE : RESUME
INTERRUPTED -> FAILED : FAILURE_RECORD
INTERRUPTED -> CONFLICTED : CONFLICT_RECORD
INTERRUPTED -> RESOLVED : CLOSE
INTERRUPTED -> ARCHIVED : ARCHIVE
FAILED -> ACTIVE : REOPEN
FAILED -> CONFLICTED : CONFLICT_RECORD
FAILED -> RESOLVED : CLOSE
FAILED -> ARCHIVED : ARCHIVE
CONFLICTED -> ACTIVE : CONFLICT_RESOLVE
CONFLICTED -> FAILED : FAILURE_RECORD
CONFLICTED -> RESOLVED : CLOSE
CONFLICTED -> ARCHIVED : ARCHIVE
MERGE_PENDING -> RESOLVED : INTEGRATE_CLOSE
MERGE_PENDING -> CONFLICTED : CONFLICT_RECORD
MERGE_PENDING -> BLOCKED : BLOCK_RECORD
MERGE_PENDING -> FAILED : FAILURE_RECORD
RESOLVED -> ARCHIVED : ARCHIVE
```

### 6.4 Hard forbiddens (beyond the complement rule)

- No transition into NEW; no transition out of ARCHIVED; no self-edge except
  `CHECKPOINTED -> CHECKPOINTED`.
- `ACTIVE -> ARCHIVED` is forbidden: running work must be concluded or
  interrupted first.
- `MERGE_PENDING -> ACTIVE` is forbidden (deferral only via `BLOCKED`) and
  `MERGE_PENDING -> ARCHIVED` is forbidden (pending integration must never
  vanish silently).
- `BLOCKED -> INTERRUPTED`, `BLOCKED -> MERGE_PENDING`, and
  `BLOCKED -> CHECKPOINTED` are forbidden (root cause not masked; no progress
  while blocked).
- `INTERRUPTED/FAILED/CONFLICTED -> CHECKPOINTED` are forbidden (no checkpoint
  creation outside ACTIVE/CHECKPOINTED).
- `RESOLVED` exits only to ARCHIVED (closure is final).
- No cross-job transition; no transition mutating any JobContract field, lane
  field, writer identity, profile, or namespace.
- No silent transition of any kind: state changes only through an applied
  operation with a transition record.

### 6.5 Edge-specific evidence requirements

| Operation(s) | Additional evidence precondition (beyond global P1-P13) |
|---|---|
| `START` | none — explicitly exempt from the cold-entry evidence requirement (JobContract validity at P2 + approval at P12 apply). The store is empty by invariant I2, and the applied START transition record is itself the recorded cold entry of section 6.6; no separate cold-entry evidence reference exists for START. P11 resolves START to exactly one deterministic outcome: pass (`RECOVERY_PRECONDITION_FAILED` is not producible by START) |
| `CHECKPOINT_CREATE` | canonical payload; `payload_digest` computable; payload is a new checkpoint for this object — duplicate content is evaluated here at P11 (after P9 and P10, before P12) and is `IDEMPOTENT_REPLAY`, section 8.4, applying no transition |
| `RESUME` (from CHECKPOINTED) | target checkpoint exists (store non-empty by invariant I1), owned by the pair, integrity-valid; default target is latest valid; explicit `checkpoint_id` must validate |
| `RESUME` (from INTERRUPTED), `REOPEN`, `CONFLICT_RESOLVE`, `UNBLOCK` | validate latest checkpoint if the store is non-empty; if the store is empty, cold entry/resume is allowed only with recorded cold-entry evidence |
| `BLOCK_RECORD` | block reason reference |
| `INTERRUPT_RECORD` | interruption reference (external stop; no fault code) |
| `FAILURE_RECORD` | exactly one canonical error code (locked 9B or one of the 8 9C codes) as evidence |
| `CONFLICT_RECORD` | exactly one conflict evidence reference per section 12 |
| `MERGE_ELIGIBLE_RECORD` | a fresh frozen Phase 9B merge-eligibility decision with `merge_eligible=true`, stored by canonical fields; stale baseline requires a Phase 9B audited synchronization record first (`STALE_MAIN_BASELINE` otherwise) |
| `CLOSE` | closure outcome reference; if the session is merge-locked, the lock must be free |
| `INTEGRATE_CLOSE` | merge-applied evidence + post-merge verification evidence; if the lane was stale, a Phase 9B audited synchronization record; approval |
| `ARCHIVE` | user confirmation; merge lock free |

### 6.6 Checkpoint rule on every `->ACTIVE` edge

- If the store is non-empty, the target checkpoint (default: latest valid;
  or an explicitly supplied `checkpoint_id`) is validated for ownership and
  integrity before entry. Integrity failure fails closed with
  `CHECKPOINT_INVALID`; there is no fallback to an older checkpoint.
  This branch is unreachable for `START`: `NEW` implies an empty store (I2).
- If the store is empty, entry is allowed as recorded cold entry or recorded
  cold resume, with exactly one deterministic rule per edge class:
  - `START` (first entry from NEW): always cold by invariant I2. START is
    explicitly exempt from the separate cold-entry evidence reference (6.5);
    the applied START transition record — after JobContract validity at P2
    and approval at P12 — is itself the recorded cold entry. P11 for START
    therefore has exactly one outcome: pass.
  - re-entry edges (`UNBLOCK`, `RESUME` from INTERRUPTED, `REOPEN`,
    `CONFLICT_RESOLVE`): allowed only with the recorded cold-entry /
    cold-resume evidence reference of section 6.5; missing evidence fails
    closed with `RECOVERY_PRECONDITION_FAILED` at P11.
- `CHECKPOINTED -> ACTIVE` can never be cold: invariant I1 guarantees a
  non-empty store.
- Validation never deletes, mutates, repairs, or replaces a checkpoint.

## 7. Global Preconditions, Postconditions, Validation Precedence

### 7.1 Validation precedence (P1-P13, exact order; first failing condition wins)

```text
P1   request structural validation -> VALIDATION_ERROR (existing generic taxonomy)
P2   Phase 9B JobContract validity (structural -> job_id -> profile ->
     namespace -> knowledge_scope -> execution_permissions)
     -> Phase 9B locked errors (JOB_CONTRACT_INVALID, INVALID_JOB_ID,
     PROFILE_BINDING_*, NAMESPACE_*, INVALID_KNOWLEDGE_SCOPE,
     INVALID_EXECUTION_PERMISSIONS)
P3   foreign-job / foreign-namespace boundary -> FOREIGN_JOB_REJECT /
     FOREIGN_NAMESPACE_WRITE_REJECTED (Phase 9B); session equality never
     overrides the foreign-job boundary
P4   record identity vs caller (same job, session mismatch or tampered
     identity fields) -> RECOVERY_IDENTITY_MISMATCH
P5   Phase 9B lane / coordination checks AS INVOKED BY THE OPERATION CLASS:
       ->ACTIVE ops and MERGE ops: writer ownership when a lane exists
          -> LANE_OWNERSHIP_CONFLICT / CROSS_LANE_WRITE_REJECTED (Phase 9B)
       MERGE_ELIGIBLE_RECORD / INTEGRATE_CLOSE: eligibility + staleness
          -> STALE_MAIN_BASELINE (Phase 9B) or required audited synchronization
       recording ops (BLOCK_RECORD, INTERRUPT_RECORD, FAILURE_RECORD,
       CONFLICT_RECORD): neither lane-ownership nor eligibility is invoked
P6   safe mode (mode-level block on gated operations) -> POLICY_BLOCKED
     (existing generic taxonomy)
P7   recovery record present + strict schema + policy_ref match
     -> SESSION_RECOVERY_INVALID
P8   state value within the canonical 10 -> INVALID_RECOVERY_STATE
P9   replay gate: identical to the most recently applied transition
     (from_state, to_state, operation, arg_fingerprint)
     -> IDEMPOTENT_REPLAY (success result, short-circuit; no approval needed)
P10  edge legality: (from_state, to_state) in the 41-edge allow-list AND
     current_state == from_state -> ILLEGAL_TRANSITION
P11  edge-specific preconditions, in this order:
       checkpoint ownership -> CHECKPOINT_OWNERSHIP_MISMATCH
       checkpoint integrity/availability -> CHECKPOINT_INVALID
       edge evidence (section 6.5) -> RECOVERY_PRECONDITION_FAILED;
       for CHECKPOINT_CREATE, edge evidence first evaluates duplicate
       checkpoint content (section 8.4) -> IDEMPOTENT_REPLAY
       short-circuit: existing checkpoint_id returned, no checkpoint_seq
       consumed, no transition record, no state change, no approval
       required (nothing is applied, so P12 does not attach)
P12  approval gate (operation-level approval evidence)
     -> RECOVERY_APPROVAL_REQUIRED
P13  atomic apply: state update and transition record commit together,
     or not at all
```

Phase 9B checks (P2-P5) always precede Phase 9C checks: isolation outranks
state semantics. Identity (P4) precedes state semantics (P7-P10). Replay (P9)
precedes legality (P10). Approval (P12) is the final gate before apply.
A rejected operation changes nothing: no state, no sequence, no record.

The two idempotency mechanisms never compete and their precedence is exact:
P9 is transition-head-scoped (identical to the most recently applied
transition only, section 14.3); the duplicate-content dedup is
checkpoint-store-scoped (section 8.4) and is evaluated only after P9 does not
fire and P10 passes. A request can short-circuit at P9 first; otherwise the
dedup is reached at P11. Both return the result class `IDEMPOTENT_REPLAY`.

### 7.2 Global postconditions (applied transitions only)

1. `current_state := to_state`; `transition_seq += 1`
   (`checkpoint_seq += 1` only for an applied new `CHECKPOINT_CREATE`).
2. Exactly one immutable transition record written at that sequence
   (section 14).
3. `job_id` and `session_key` byte-identical; JobContract 8 fields
   byte-identical (Phase 9B revalidation at P2 passed before apply).
4. No lane, writer, profile, or namespace field mutated by 9C, ever.
5. Deterministic frozen result envelope: no wall clock, no randomness, no
   machine paths, no LLM-derived content in identity or outcome.
6. Any failure anywhere has no partial effect (P13 atomicity).

## 8. Checkpoint Model

### 8.1 Identity

```text
checkpoint_id = job:{job_id}:sessions:{session_key}:checkpoint:{checkpoint_seq}
```

- Derived from the canonical tuple `(job_id, session_key, checkpoint_seq)`.
- `checkpoint_seq` is a persisted monotonic integer on the RecoveryObject:
  starts at 0, increments by exactly 1 per applied new checkpoint.
- Forbidden identity sources (Phase 9B discipline inherited): wall clock,
  randomness, probabilistic memory, LLM output, unordered iteration,
  machine-specific paths.
- Uniqueness is structural: one RecoveryObject owns the counter per pair, so a
  `checkpoint_id` is issued at most once.
- Logical identifiers are write/compare only and are never parsed.

### 8.2 Ordering and latest valid checkpoint

- Numeric order on `checkpoint_seq`.
- **Latest valid checkpoint** = maximum `checkpoint_seq` that passes integrity
  validation.
- The maximum-`checkpoint_seq` checkpoint failing integrity fails closed with
  `CHECKPOINT_INVALID`. There is no fallback to any older checkpoint
  (silent fallback would be silent recovery).
- Resume target = explicit `checkpoint_id` if supplied (validated for
  ownership and integrity), else latest valid.

### 8.3 Immutability and validation on resume

- Checkpoints are immutable and append-only: never mutated, repaired,
  replaced, or deleted by 9C.
- Resume recomputes `payload_digest` and compares it to the stored value, and
  validates the ownership tuple and `checkpoint_seq` existence. Any failure is
  `CHECKPOINT_OWNERSHIP_MISMATCH` or `CHECKPOINT_INVALID`, fail-closed, never
  silently repaired.

### 8.4 Duplicate content

- Creating a checkpoint whose canonical `payload_digest` equals any existing
  checkpoint of the same pair is an idempotent no-op: returns the existing
  `checkpoint_id`, consumes no `checkpoint_seq`, writes no transition record,
  does not change state, result class `IDEMPOTENT_REPLAY`.
- A duplicate-content `CHECKPOINT_CREATE` never applies a transition from any
  source state; therefore an applied entry into CHECKPOINTED always appends
  exactly one new checkpoint.
- Different payload: `checkpoint_seq += 1`, new `checkpoint_id`, exactly one
  transition record.
- Exact evaluation precedence (normative — no rule overlap): the head-scoped
  replay gate P9 (section 14.3) is evaluated first. If P9 does not fire, edge
  legality P10 must pass; an intervening transition that no longer satisfies
  `from_state` fails there with `ILLEGAL_TRANSITION` and never reaches this
  section. Only after P10 is duplicate content evaluated, at P11, before P12.
- Duplicate checkpoint content therefore remains idempotent after any number
  of intervening transitions whenever P10 passes: the content comparison is
  checkpoint-store-scoped, not transition-head-scoped. The dedup short-circuit
  requires no approval (P12) because it applies no transition and changes
  nothing.
- Deterministic outcomes for `CHECKPOINT_CREATE`:
  a) immediate identical retry of the most recently applied transition
     -> P9 fires -> `IDEMPOTENT_REPLAY` (original transition record returned,
     `transition_seq` unchanged, original `checkpoint_id` in the result).
  b) same payload after an intervening transition, current state still the
     edge's `from_state` (e.g. `CHECKPOINT_CREATE(A) -> RESUME ->
     CHECKPOINT_CREATE(A)` with state ACTIVE) -> P9 does not fire, P10 passes,
     P11 dedup matches -> `IDEMPOTENT_REPLAY` with the existing
     `checkpoint_id`, no `checkpoint_seq` consumed, no transition record, no
     state change (state stays ACTIVE), no approval required. This is NOT
     `ILLEGAL_TRANSITION`.
  b') same attempt while the current state no longer satisfies `from_state`
     -> P10 -> `ILLEGAL_TRANSITION`, zero state change, no record.
  c) new payload, all preconditions and approval satisfied -> applied:
     `checkpoint_seq += 1`, state `-> CHECKPOINTED`, exactly one transition
     record.

### 8.5 State/store consistency invariants

```text
I1  FORWARD: current_state = CHECKPOINTED => |checkpoint_store| >= 1.
    Contrapositive (fail-closed): empty store while in CHECKPOINTED fails
    CHECKPOINT_INVALID (record/store inconsistency, never repaired).

I2  NEW-side fact: current_state = NEW => |checkpoint_store| = 0
    and checkpoint_seq = 0.

I3  Durability: checkpoint_store is append-only; |store| and checkpoint_seq
    never decrease across any transition; content is immutable. RESUME never
    deletes, mutates, repairs, or replaces checkpoints.

I4  EXPLICITLY NOT AN INVARIANT: |checkpoint_store| >= 1 does NOT imply
    current_state = CHECKPOINTED. A non-empty store is legal in every state
    except NEW (for example ACTIVE after RESUME). Store occupancy is never
    read as state.
```

### 8.6 Ownership

- Exactly one owning `(job_id, session_key)`.
- Foreign job: `FOREIGN_JOB_REJECT` (Phase 9B, precedence P3).
- Same job, foreign session: `CHECKPOINT_OWNERSHIP_MISMATCH` (P11).

### 8.7 Context Hydration H08 interaction

- 9C defines "latest valid checkpoint" (section 8.2) and may supply it as an
  input to hydration. `context-hydration@1.0.1` scoring, ranking, and H08
  behavior are unchanged.

## 9. Identity Preservation

- The JobContract remains exactly the 8 Phase 9B fields. 9C adds no field,
  reads no field into its own schema except validating them at P2, and never
  modifies them: byte-identical before and after every transition.
- `job_id` is preserved and immutable in the RecoveryObject.
- `profile` is preserved through per-transition Phase 9B revalidation;
  drift surfaces as `PROFILE_BINDING_MISMATCH`.
- Session identity is opaque exact-match (Phase 9B semantics); 9C performs no
  session normalization.
- Namespace fields remain derived and immutable (Phase 9B); caller override
  remains `NAMESPACE_OVERRIDE_FORBIDDEN`.
- Lane and writer identity are never created, mutated, reassigned, or
  destroyed by 9C. Where a lane exists for the job, writer conflicts surface
  unchanged as `LANE_OWNERSHIP_CONFLICT` / `CROSS_LANE_WRITE_REJECTED`.
- Recovery record identity fields are immutable after creation; tampering
  fails closed without repair.

## 10. Namespace and Ledger Isolation

- All Phase 9C artifacts live only under the owning `session_namespace`
  subtree (logical layout under the Phase 9B root `job:{job_id}:sessions`):

```text
job:{job_id}:sessions:{session_key}
    recovery/          (RecoveryObject record)
    transitions/       (append-only transition records)
    checkpoints/{seq}  (immutable checkpoints)
```

- `ledger_namespace`: 9C writes zero bytes. Phase 9B contract section 13
  states "No recovery state transitions belong here"; Phase 9B decisions
  (eligibility, synchronization, coordination) are consumed **by reference**
  only, never duplicated as recovery state.
- `runtime_state_namespace`: 9C writes nothing; it remains the Phase 9B
  job-scoped mutable runtime boundary.
- Phase 9B namespace roots, derivation, and foreign-job/session enforcement
  are preserved exactly; 9C adds no namespace template and changes no
  Phase 9B schema.
- Foreign access follows Phase 9B errors unchanged (P3).

## 11. Approval Model

- All 41 transitions are approval-gated (P12). Recording operations
  (`BLOCK_RECORD`, `INTERRUPT_RECORD`, `FAILURE_RECORD`, `CONFLICT_RECORD`)
  are restrict-only — their targets are always one of BLOCKED, INTERRUPTED,
  FAILED, CONFLICTED and they never grant progress — yet they are gated like
  every other transition: recovery and bookkeeping are never self-authorizing.
- `contract_alone_authorizes_execution = false`. Capability ceilings,
  execution permissions, and JobContracts never authorize a transition.
- `approval gate` and `safe mode` remain the tracked authorities; safe mode
  blocks at P6 with `POLICY_BLOCKED`; missing operation-level approval fails
  at P12 with `RECOVERY_APPROVAL_REQUIRED`.
- `ARCHIVE` additionally requires user confirmation (move, not delete).
- 9C never uses DELETE-class or SECRET_ACCESS-class actions.
- No bypass path exists for the approval gate, safe mode, security checks, or
  project-root boundaries.

## 12. INTERRUPTED, FAILED, CONFLICTED

| | Entering | Resumable? | Human action | Exact exits |
|---|---|---|---|---|
| INTERRUPTED | `INTERRUPT_RECORD` citing an external stop; no fault code; never entered by restart detection | Yes (`RESUME`) | Approval + evidence; cold resume when the store is empty must be recorded | ACTIVE, FAILED, CONFLICTED, RESOLVED, ARCHIVED |
| FAILED | `FAILURE_RECORD` citing exactly one canonical error code | Yes (`REOPEN`) only | Reopen/close/archive each require approval + recorded decision; never auto-retried; restart changes nothing | ACTIVE, CONFLICTED, RESOLVED, ARCHIVED |
| CONFLICTED | `CONFLICT_RECORD` citing exactly one conflict evidence reference (below) | Yes, after recorded resolution (`CONFLICT_RESOLVE`) | Approval + resolution evidence + owning-writer identity where a lane exists | ACTIVE, FAILED, RESOLVED, ARCHIVED |

Conflict evidence mapping (Phase 9B detects and fails closed first at P5/P10;
the recorded detection then enters CONFLICTED from the current state):

| Phase 9B detection kind | Required canonical code in evidence |
|---|---|
| branch divergence | `STALE_MAIN_BASELINE` |
| namespace collision | `NAMESPACE_COLLISION` |
| lane ownership collision | `LANE_OWNERSHIP_CONFLICT` |
| job identity collision | `JOB_ID_COLLISION` |
| foreign-job write attempt | `FOREIGN_NAMESPACE_WRITE_REJECTED` |
| operational merge-lock conflict | merge-lock reference (evidence only; not an error code) |

## 13. MERGE_PENDING

- Entering (`MERGE_ELIGIBLE_RECORD`) requires a fresh frozen Phase 9B
  merge-eligibility decision with `merge_eligible=true`, stored by its
  canonical fields (`lane_id`, `job_id`, `authoritative_main_sha`,
  `synchronized`, `audit_ref`). Eligibility is a pure decision and authorizes
  nothing.
- MERGE_PENDING never executes or implies merge execution. 9C has no
  merge-execution capability; the record asserts merge not applied.
- `INTEGRATE_CLOSE` (the only path to RESOLVED from MERGE_PENDING) requires,
  simultaneously: merge-applied evidence, post-merge verification evidence,
  a Phase 9B audited synchronization record when the lane was stale, and
  approval. Missing evidence fails with `RECOVERY_PRECONDITION_FAILED`;
  missing approval fails with `RECOVERY_APPROVAL_REQUIRED`.
- A stale baseline surfaces `STALE_MAIN_BASELINE` unchanged at P5; 9C never
  clears staleness and never auto-synchronizes; a stale lane never becomes
  authoritative main.
- Merge-time conflict: Phase 9B code fires first at P5; the correct follow-up
  is `CONFLICT_RECORD` (`MERGE_PENDING -> CONFLICTED`). No
  `MERGE_PENDING_CONFLICT` identifier exists.
- `MERGE_PENDING -> ACTIVE` and `MERGE_PENDING -> ARCHIVED` are forbidden;
  deferral records why via `BLOCKED`.
- The operational merge lock is an external gate signal: `ARCHIVE` fails with
  `RECOVERY_PRECONDITION_FAILED` while the session merge lock is held. 9C does
  not own, reimplement, or release the lock.

## 14. Audit and Idempotency

### 14.1 Transition record (canonical, immutable, append-only)

```text
{
  job_id,
  session_key,
  transition_seq,     (unique per RecoveryObject, monotonic)
  from_state,
  to_state,
  operation,          (pure function of (from_state, to_state))
  arg_fingerprint,    (deterministic hash of canonical argument fields)
  evidence_refs[],    (canonical reference identifiers)
  approval_ref,       (canonical approval reference)
  policy_ref,         (session-recovery@1.0.1)
  outcome             (APPLIED)
}
```

No timestamps. No randomness. No machine-specific paths.

### 14.2 Two-layer identity

- **Transition identity** = `(job_id, session_key, transition_seq)` — unique,
  monotonic, the exactly-once audit key.
- **Operation fingerprint** =
  `op:{sha256(job_id | session_key | from_state | to_state | operation | arg_fingerprint)}`
  where `arg_fingerprint` is the deterministic hash of canonical argument
  fields only (checkpoint `payload_digest`, `checkpoint_id`, evidence
  **reference identifiers**, 9B decision fields, `approval_ref`). Free-text
  evidence bodies and human prose are never identity inputs.

### 14.3 Idempotency rules

- An operation identical to the **most recently applied** transition
  `(from_state, to_state, operation, arg_fingerprint)` returns
  `IDEMPOTENT_REPLAY`: the original record is returned, `transition_seq` is
  unchanged, no second record is written, no approval is required (P9).
- A retry after an intervening transition is **not** a P9 replay: the head no
  longer matches, so the request re-enters normal evaluation at P10. It fails
  with `ILLEGAL_TRANSITION` (P10) **if and only if** the current state no
  longer satisfies `from_state`, or the pair is not allow-listed: zero state
  change, no record. If `from_state` still holds (e.g. a same-payload
  `CHECKPOINT_CREATE` after a `CHECKPOINTED -> ACTIVE` RESUME), evaluation
  continues to P11, where duplicate checkpoint content remains
  `IDEMPOTENT_REPLAY` (section 8.4) regardless of the intervening
  transition. This scoping is exact: "retry after intervening transition ->
  `ILLEGAL_TRANSITION`" is never itself a rule; `ILLEGAL_TRANSITION` comes
  only from the P10 conditions in section 15.
- Rejected operations write no record and do not change `state` or any
  sequence; identical inputs re-derive the identical error.
- Exactly one transition record exists per applied transition; records are
  append-only and immutable; `transition_seq` is unique and monotonic.
- Apply is atomic (P13): state and record commit together or not at all.
  Concurrent/stale losers observe the advanced `from_state` and fail with
  `ILLEGAL_TRANSITION`.

## 15. Canonical Errors

Exactly these 8 identifiers are normative for Phase 9C:

```text
SESSION_RECOVERY_INVALID
INVALID_RECOVERY_STATE
ILLEGAL_TRANSITION
CHECKPOINT_OWNERSHIP_MISMATCH
CHECKPOINT_INVALID
RECOVERY_IDENTITY_MISMATCH
RECOVERY_PRECONDITION_FAILED
RECOVERY_APPROVAL_REQUIRED
```

Exact scopes:

| Error | Scope |
|---|---|
| SESSION_RECOVERY_INVALID | Recovery record absent, structurally malformed (schema/fields/counters), or `policy_ref` incompatible. Record-level, not state-level. |
| INVALID_RECOVERY_STATE | A present `current_state` value outside the canonical 10. |
| ILLEGAL_TRANSITION | Pair not in the 41-edge allow-list; current state != from_state (stale/concurrent loser); any transition from ARCHIVED; any transition into NEW; any disallowed self-edge. |
| CHECKPOINT_OWNERSHIP_MISMATCH | Referenced checkpoint belongs to a different session of the same job (cross-job never reaches this error: P3 returns `FOREIGN_JOB_REJECT` first). |
| CHECKPOINT_INVALID | Checkpoint reference absent; payload digest/integrity failure; missing `checkpoint_seq`; or CHECKPOINTED with an empty checkpoint store. |
| RECOVERY_IDENTITY_MISMATCH | Caller `(job_id, session_key)` differs from the RecoveryObject identity (same job), or record identity fields are tampered. |
| RECOVERY_PRECONDITION_FAILED | Edge-specific evidence precondition unmet and not covered by a more specific code (block-clearance, failure-evidence, closure-evidence, conflict-resolution, merge-applied/post-merge-verification evidence; merge lock held at ARCHIVE; fresh eligibility decision absent at MERGE_ELIGIBLE_RECORD; recorded cold-entry/cold-resume evidence missing on a re-entry edge — `START` carries no cold-entry evidence precondition, sections 6.5-6.6). |
| RECOVERY_APPROVAL_REQUIRED | Gated transition attempted while operation-level approval evidence is missing (P12). |

Rules:

- `MERGE_PENDING_CONFLICT` is NOT introduced. Merge-time conflicts surface
  Phase 9B codes at P5 and are recorded via `CONFLICT_RECORD`.
- The locked 18 Phase 9B identifiers are reused unchanged wherever Phase 9B
  conditions fire; none is modified, shadowed, or re-defined.
- The existing generic taxonomy (`governance/schemas/error-taxonomy.json`) is
  reused: `VALIDATION_ERROR` at P1, `POLICY_BLOCKED` at P6. Mode-level vs
  op-level split: safe mode returns `POLICY_BLOCKED` at P6; missing
  operation-level approval with the mode permitting returns
  `RECOVERY_APPROVAL_REQUIRED` at P12.
- `IDEMPOTENT_REPLAY` is a success result class, not an error.
- Deterministic precedence: the P1-P13 order in section 7.1 maps every
  failure condition to exactly one canonical result (first failing condition
  wins; no nondeterministic error selection).

## 16. Determinism and Fail-Closed

```text
determinism:  identical canonical inputs + identical policy =>
              identical transition outcome, error result, and envelope.
              Forbidden identity/decision sources: wall clock, randomness
              after persisted creation, probabilistic memory, LLM output,
              unordered object iteration, machine-specific paths.

fail-closed:  unknown state / unknown transition / ambiguous identity /
              absent or malformed record / missing or corrupt checkpoint
              => canonical error; never a fallback to shared/default scope,
              never silent repair, never silent resume.

no silent recovery: resume, unblock, re-open, conflict resolution, merge
              closure, and archive are explicit, approval-gated, audited
              operations. Reads, restarts, and validations never change
              state.
```

## 17. Context Hydration Compatibility

- Policy `context-hydration@1.0.1` remains frozen. No scoring-weight,
  ranking, or H08 behavior change. H08 "latest checkpoint bypasses candidate
  ranking" consumes the 9C definition of latest valid checkpoint (section 8.2)
  without modification to the hydration pipeline.

## 18. Phase 9B Boundary

- `job-isolation@1.0.0` remains unchanged: contract, policy, runtime, and
  acceptance. The locked 18 errors remain exactly 18.
- Phase 9B contract section 27 reserves these 10 states for Phase 9C; this
  contract owns them and writes none of them into Phase 9B artifacts.
- 9C consumes Phase 9B authorities read-only: JobContract validation,
  namespace isolation, ParallelLane ownership, conflict detection, merge
  eligibility, audited synchronization, main coordination.

## 19. Security / Public Repository Boundary

- No secret/env/profile reads are required or performed by this contract.
- Never track: client data, PGN data, credentials, secret profiles, runtime
  auth state, private personal memory, opencode.db, browser profiles,
  machine-specific evidence, machine-specific runtime databases, or
  machine-specific absolute paths.
- Recovery state, transition records, and checkpoints are local-only state
  (`state/sessions/*` remains ignored); tracked artifacts are contract,
  policy, architecture, ADRs, and future tests only — reusable infrastructure,
  machine-neutral.

## 20. Phase 9C Acceptance Model

Exactly 70 future acceptance invariants are declared here. They are NOT
runtime acceptance executions. No ID is authoritative until this contract is
locked. Phase 9B acceptance remains exactly JC01-JC10, NS01-NS10, PL01-PL10,
EP01-EP10 (40/40 VERIFIED).

### Recovery Contract — RC01-RC08

```text
RC01 canonical state set = exactly the 10 states (policy deep-equal; no 11th, none missing)
RC02 recovery record strict schema: exact fields; unknown field -> SESSION_RECOVERY_INVALID
RC03 CREATE idempotent on exact (job_id, session_key); policy_ref version skew -> SESSION_RECOVERY_INVALID; no repair
RC04 one record per pair; record identity fields immutable post-create; tamper fails closed
RC05 absent record -> SESSION_RECOVERY_INVALID; unknown state value -> INVALID_RECOVERY_STATE; no fallback/default
RC06 policy_ref session-recovery@1.0.1 bound on record and every result envelope
RC07 100x identical create/validate produce byte-identical outputs
RC08 record scope = (job_id, session_key); same-job cross-session access -> RECOVERY_IDENTITY_MISMATCH
```

### State Transitions — ST01-ST12

```text
ST01 all 41 allow-listed edges apply with satisfied preconditions (positive sweep)
ST02 all 59 forbidden ordered pairs -> ILLEGAL_TRANSITION
ST03 self-edge policy: only CHECKPOINTED -> CHECKPOINTED; the other 9 self-edges rejected
ST04 terminality: ARCHIVED has zero outgoing edges; RESOLVED non-terminal (RESOLVED -> ARCHIVED allowed)
ST05 nothing enters NEW; NEW reachable only by CREATE
ST06 edge preconditions enforced (RESUME checkpoint validation, UNBLOCK clearance,
    REOPEN failure evidence, INTEGRATE_CLOSE merge evidence) -> RECOVERY_PRECONDITION_FAILED
ST07 postconditions on every edge: state = to, seq + 1, one record, identity unchanged, deterministic envelope
ST08 no silent auto-transition: restart/read/validate probes change neither state nor seq;
    every rejected op leaves state, seq, and records untouched
ST09 all 41 transitions approval-gated -> RECOVERY_APPROVAL_REQUIRED when unsatisfied;
    safe mode -> POLICY_BLOCKED; no bypass
ST10 supersession hard rules hold (ACTIVE -> ARCHIVED, MERGE_PENDING -> ACTIVE/ARCHIVED,
    BLOCKED -> INTERRUPTED/MERGE_PENDING/CHECKPOINTED, RESOLVED exit = ARCHIVE only all rejected)
ST11 operation = pure function of (from_state, to_state); unknown/ad-hoc operation rejected
ST12 atomic apply: induced mid-apply failure leaves zero partial effect
```

### Checkpoint Identity — CP01-CP10

```text
CP01 checkpoint_id deterministic from (job_id, session_key, checkpoint_seq); 100x identical
CP02 no wall clock/randomness/LLM/machine-path in checkpoint identity (source scan + derivation)
CP03 checkpoint_seq monotonic +1 per new checkpoint; no id issued twice for a tuple
CP04 ordering: latest valid = maximum checkpoint_seq passing integrity; deterministic across 100x
CP05 duplicate content (evaluated at P11 after P9/P10, valid regardless of
    intervening transitions) -> IDEMPOTENT_REPLAY: existing id returned, no seq consumed,
    no record, no state change
CP06 resume integrity: digest mismatch/absent reference -> CHECKPOINT_INVALID; no silent repair
CP07 latest-valid: corrupt maximum-seq checkpoint -> CHECKPOINT_INVALID; never fallback
    to an older checkpoint
CP08 ownership: foreign job -> FOREIGN_JOB_REJECT; foreign session -> CHECKPOINT_OWNERSHIP_MISMATCH
CP09 CHECKPOINTED => checkpoint store contains >= 1 checkpoint; empty store while
    CHECKPOINTED -> CHECKPOINT_INVALID; an applied CHECKPOINT_CREATE entry appends exactly
    one new checkpoint (forward direction only)
CP10 checkpoint durability across resume: for ACTIVE -> CHECKPOINTED -> ACTIVE (RESUME),
    store contents, ids, digests, and checkpoint_seq byte-identical before/after RESUME;
    ACTIVE with a non-empty store is accepted without error or mutation
    (store non-empty does NOT imply CHECKPOINTED)
```

### Identity Preservation — ID01-ID07

```text
ID01 JobContract exactly 8 fields, byte-identical before/after all 41 edges (sweep)
ID02 job_id preserved and immutable across transitions
ID03 profile preserved via per-transition revalidation; drift -> PROFILE_BINDING_MISMATCH
ID04 session identity opaque exact-match; no normalization; mismatch -> RECOVERY_IDENTITY_MISMATCH
ID05 namespace fields unchanged; caller override -> NAMESPACE_OVERRIDE_FORBIDDEN (Phase 9B unchanged)
ID06 9C never mutates lane/writer fields; writer conflict -> LANE_OWNERSHIP_CONFLICT /
    CROSS_LANE_WRITE_REJECTED (Phase 9B unchanged)
ID07 recovery record identity fields immutable post-create; tamper fails closed without repair
```

### Interrupted / Failed / Conflict — IF01-IF07

```text
IF01 three states distinct: entry evidence requirements and exit sets differ pairwise
IF02 INTERRUPTED -> ACTIVE validates latest checkpoint when present; empty store allowed
    only as recorded cold resume
IF03 FAILED never auto-reopens: without REOPEN evidence+approval -> RECOVERY_APPROVAL_REQUIRED;
    restart probe leaves state FAILED
IF04 CONFLICT_RECORD evidence cites exactly one of the five Phase 9B detection kinds with its
    locked code; no 9C re-definition/variant of any Phase 9B code
IF05 CONFLICT_RESOLVE writes audited resolution evidence and requires approval
IF06 recording transitions are restrict-only: targets subset of {BLOCKED, INTERRUPTED,
    FAILED, CONFLICTED}; never {ACTIVE, CHECKPOINTED, MERGE_PENDING, RESOLVED}
IF07 exit sets exactly as section 12 for all three states
```

### Merge-Pending / Main Authority — MP01-MP08

```text
MP01 MERGE_ELIGIBLE_RECORD requires a fresh frozen Phase 9B decision with merge_eligible=true,
    stored by canonical fields; ineligible -> Phase 9B error, no state change
MP02 MERGE_PENDING never implies execution: no merge-execution capability exists in 9C;
    record asserts merge not applied
MP03 INTEGRATE_CLOSE requires merge-applied evidence + post-merge verification evidence +
    approval; missing -> RECOVERY_PRECONDITION_FAILED / RECOVERY_APPROVAL_REQUIRED
MP04 stale baseline: STALE_MAIN_BASELINE propagates unchanged; no auto-synchronization;
    9C never clears staleness; audited synchronization only via Phase 9B coordinator
MP05 merge-time conflict: Phase 9B code first, then CONFLICT_RECORD (MERGE_PENDING -> CONFLICTED);
    INTEGRATE_CLOSE never proceeds over a live detection
MP06 eligibility authorizes nothing: entering MERGE_PENDING does not satisfy INTEGRATE_CLOSE approval
MP07 MERGE_PENDING -> ACTIVE and MERGE_PENDING -> ARCHIVED -> ILLEGAL_TRANSITION
    (deferral only via BLOCKED)
MP08 non-merge closures use CLOSE from the six non-merge states; INTEGRATE_CLOSE exists only
    on MERGE_PENDING -> RESOLVED (edge/operation binding)
```

### Determinism / Idempotency / Audit — DI01-DI08

```text
DI01 100x identical transition battery -> identical outcomes, errors, envelopes
DI02 replay: immediate identical retry of the most recently applied transition -> IDEMPOTENT_REPLAY
    + original record + unchanged seq + no second record; a retry after an intervening transition
    re-enters P10 -> ILLEGAL_TRANSITION iff the current state no longer satisfies from_state (zero
    state change); if from_state still holds, duplicate checkpoint content -> IDEMPOTENT_REPLAY per CP05/section 8.4
DI03 exactly one record per applied transition; seq unique, monotonic, append-only across
    long batteries
DI04 rejected ops: no record, no seq change; identical inputs re-derive identical error (100x)
DI05 transition/operation identity excludes wall clock/randomness/LLM (scan + derivation)
DI06 canonical records contain no timestamps (record scan)
DI07 stale/concurrent loser -> deterministic ILLEGAL_TRANSITION (100x)
DI08 error precedence deterministic: stacked failures yield the first-failing code per the
    locked P1-P13 order
```

### Boundaries / Safety — SB01-SB10

```text
SB01 approval gate: tracked approval-gate/safe-mode phrases intact; gated op without approval
    -> RECOVERY_APPROVAL_REQUIRED; contract_alone_authorizes_execution = false preserved
SB02 safe mode: no bypass path -> POLICY_BLOCKED holds at P6
SB03 foreign-job rejection at every 9C entry point (foreign identity sweep -> FOREIGN_JOB_REJECT)
SB04 namespace boundary: 9C write paths subset of session_namespace subtree only;
    zero ledger_namespace and runtime_state_namespace writes asserted
SB05 no secret/env/profile reads in acceptance (source scan)
SB06 no live DB/network in acceptance (source scan + suite assertions)
SB07 context-hydration@1.0.1 byte-identical (hash vs baseline)
SB08 Phase 9B contract/policy/runtime byte-identical vs baseline bde97e7 (hash)
SB09 ledger isolation: no recovery transition record under ledger_namespace
    (Phase 9B section 13 respected; write-path assertion)
SB10 public tracked artifacts contain no secrets/machine paths; state/sessions/* and
    runtime/local-state/ remain ignored (scanner + ignore-rule assertion)
```

Total: 70 (RC 8 + ST 12 + CP 10 + ID 7 + IF 7 + MP 8 + DI 8 + SB 10).

Runner shape (future, 9C-07): explicit registry, all suites required,
skipped = 0, non-zero exit on failure — the Phase 9B `run-all.js` pattern.
Determinism stress uses fixed 100x repeats; suite sources must contain no
`Math.random`, `Date.now`, `new Date`, `process.env`, `process.hrtime`,
`performance.now`.

## 21. Implementation Status and Non-Claims

- Status: CONTRACT LOCKED.
- Policy: session-recovery@1.0.1 (supersedes 1.0.0; see header
  Supersession Reason — review-findings correction, no allow-list/error/
  acceptance-count change).
- Implementation: PARTIAL (9C-03 core) — `runtime/session-recovery/core/`
  implements RecoveryObject identity, strict schema, CREATE/idempotency,
  policy_ref enforcement, checkpoint identity/sequence/dedup, latest-valid
  resolution, and ownership verification. No transition engine, no lifecycle
  operations (9C-04+).
- Acceptance: DECLARED, not executed — 70 invariants;
  docs/acceptance/phase-9c.md does not exist yet.
- Phase 9C: NOT VERIFIED.
- Phase 9B: VERIFIED (40/40) and byte-unchanged by this contract.
- Runtime: PARTIAL (Phase 9B modules; no 9C contribution).
- Architecture Freeze v1: NOT CLAIMED (still requires 9C VERIFIED).
- Production Readiness: NOT PROVEN.
