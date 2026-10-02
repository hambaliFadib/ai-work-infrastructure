# ADR-0003: Checkpoint Identity, Ordering, and One-Directional State Consistency

Status: Accepted — locked with session-recovery@1.0.0
Related: governance/contracts/session-recovery-v1.md section 8; Phase 9C governance review correction round

## Context

The Discovery Report left checkpoint identity as two alternatives (monotonic
sequence OR content hash) with an open decision on namespace placement. The
governance review initially wrote a store/state biconditional ("CHECKPOINTED
if and only if store non-empty") which the correction round proved false:
`ACTIVE -> CHECKPOINTED -> ACTIVE (RESUME)` legally leaves a non-empty store
under ACTIVE while checkpoints remain immutable and undeleted. The lock must
choose ONE identity strategy and the correct consistency invariant.

## Decision

1. **Identity (single strategy):**
   `checkpoint_id = job:{job_id}:sessions:{session_key}:checkpoint:{checkpoint_seq}`
   where `checkpoint_seq` is a persisted monotonic integer on the
   RecoveryObject (starts 0, +1 per applied new checkpoint). No wall clock,
   no randomness, no LLM-derived identity; uniqueness is structural by tuple;
   identifiers are never parsed.
2. **Ordering / latest valid:** numeric order on `checkpoint_seq`; latest
   valid = maximum seq passing integrity validation; a corrupted maximum
   fails `CHECKPOINT_INVALID` with **no fallback to any older checkpoint**
   (silent fallback would be silent recovery).
3. **Immutability:** checkpoints are append-only and immutable; resume
   validates `payload_digest` + ownership and never deletes, mutates, repairs,
   or replaces anything.
4. **Duplicates:** identical `payload_digest` for the same pair is
   `IDEMPOTENT_REPLAY` — existing id returned, no seq consumed, no transition
   record, no state change; a duplicate-content `CHECKPOINT_CREATE` never
   applies a transition, so an applied entry into CHECKPOINTED always appends
   exactly one checkpoint.
5. **One-directional consistency invariant (the correction):**
   - I1 `CHECKPOINTED => store non-empty` (empty store while CHECKPOINTED
     fails `CHECKPOINT_INVALID`);
   - I2 `NEW => empty store and checkpoint_seq = 0`;
   - I3 append-only durability across every transition (RESUME preserves the
     store byte-identically);
   - I4 **explicitly not an invariant:** `store non-empty ⇏ CHECKPOINTED` —
     non-empty stores are legal in every state except NEW (e.g. ACTIVE after
     RESUME). Store occupancy is never read as state.
6. **Namespace:** checkpoints live under the session subtree (ADR-0002).
7. **H08:** 9C defines and may supply "latest valid checkpoint";
   `context-hydration@1.0.1` scoring and H08 behavior are unchanged.

## Consequences

- Deterministic, testable identity and ordering (CP01-CP08); the resume
  durability trace `ACTIVE -> CHECKPOINTED -> ACTIVE` is CP10.
- The state machine stays posture-authoritative; checkpoint facts never
  drive state resolution.

## Alternatives Rejected

- Content-hash-only identity — no natural ordering for "latest"; would need a
  separate counter anyway.
- Wall-clock or random checkpoint ids — violates Phase 9B forbidden identity
  sources.
- Keeping the biconditional — falsified by the legal RESUME lifecycle; would
  make every resumed ACTIVE state an invariant violation.
- Deleting/pruning checkpoints on RESUME, or forbidding
  `CHECKPOINTED -> ACTIVE`, to preserve the biconditional — both violate the
  required immutability and resume semantics (silent lifecycle change).
- Deriving `current_state` from store occupancy — breaks record-authoritative
  state and determinism.
