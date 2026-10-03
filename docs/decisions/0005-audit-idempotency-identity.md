# ADR-0005: Transition Audit Record, Two-Layer Identity, and Idempotency Semantics

Status: Accepted — locked with session-recovery@1.0.0; corrected under session-recovery@1.0.1 (post-merge review: retry-after-intervening-transition scoping)
Related: governance/contracts/session-recovery-v1.md section 14; job-isolation-v1.md sections 13, 24

## Context

The lock requires a canonical recovery transition record, a canonical
transition/operation identity, duplicate-transition behavior, retry safety,
and testable exactly-once or explicit idempotent audit semantics — all without
wall clock, randomness, or LLM output in identity, and without writing
recovery transitions into the Phase 9B ledger (contract section 13).

## Decision

1. **Canonical transition record:** immutable, append-only, stored under the
   session subtree (`transitions/`), fields exactly:
   `job_id, session_key, transition_seq, from_state, to_state, operation,
   arg_fingerprint, evidence_refs[], approval_ref, policy_ref, outcome`.
   No timestamps anywhere.
2. **Two-layer identity:**
   - *Transition identity* = `(job_id, session_key, transition_seq)` —
     unique, monotonic, the exactly-once audit key.
   - *Operation fingerprint* =
     `op:{sha256(job_id|session_key|from_state|to_state|operation|arg_fingerprint)}`
     where `arg_fingerprint` hashes canonical argument **reference** fields
     only (checkpoint payload digest, checkpoint_id, evidence reference
     identifiers, 9B decision fields, approval_ref). Free-text evidence
     bodies are never identity inputs.
3. **Replay gate (P9, before legality P10):** an operation identical to the
   *most recently applied* transition returns `IDEMPOTENT_REPLAY` — original
   record returned, `transition_seq` unchanged, no second record, no approval
   required. A retry after an intervening transition is **not** a P9 replay
   and re-enters normal evaluation at P10: it fails `ILLEGAL_TRANSITION` if
   and only if the current state no longer satisfies `from_state` (zero state
   change, no record). If `from_state` still holds — e.g. a same-payload
   `CHECKPOINT_CREATE` after `CHECKPOINTED -> ACTIVE` RESUME — evaluation
   continues to P11, where duplicate checkpoint content remains
   `IDEMPOTENT_REPLAY` (contract section 8.4) regardless of intervening
   transitions. "Retry after intervening transition -> `ILLEGAL_TRANSITION`"
   is therefore not a standalone rule; `ILLEGAL_TRANSITION` originates only
   from the P10 conditions (1.0.1 correction).
4. **Rejected operations** write no record and change neither state nor any
   sequence; identical inputs re-derive the identical error. Concurrent or
   stale losers observe the advanced `from_state` and fail
   `ILLEGAL_TRANSITION`.
5. **Exactly-once + atomicity:** exactly one record per applied transition;
   `transition_seq` unique and monotonic; apply is atomic (P13) — state and
   record commit together or not at all.
6. **Ledger isolation:** 9C writes zero bytes to `ledger_namespace`; Phase 9B
   decisions are referenced by canonical fields, never copied into recovery
   state.

## Consequences

- Retry storms cannot create duplicate records or inconsistent state
  (acceptance DI02-DI04, DI07).
- Deterministic envelopes with no time dependence (DI01, DI05, DI06).

## Alternatives Rejected

- Caller-supplied idempotency keys — pushes event-distinctness onto callers
  and risks LLM-generated keys (forbidden identity source).
- Sequence-derived prospective keys without the latest-record rule — immediate
  retries after apply would mis-derive (state advanced) and return
  `ILLEGAL_TRANSITION` instead of replay.
- Recording rejected attempts as audit entries — makes retry behavior
  unbounded and non-deterministic; rejected outcomes are re-derivable from
  inputs instead.
- Timestamp-ordered records — wall-clock identity/order is forbidden by Phase
  9B determinism discipline.
