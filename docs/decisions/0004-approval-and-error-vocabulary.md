# ADR-0004: Approval Model, Canonical 9C Error Vocabulary, and Validation Precedence

Status: Accepted — locked with session-recovery@1.0.0; unchanged and reaffirmed under session-recovery@1.0.1
Related: governance/contracts/session-recovery-v1.md sections 7, 11, 15; job-isolation-v1.md sections 16, 22, 23; governance/schemas/error-taxonomy.json

## Context

"No silent recovery" plus the tracked approval gate and safe mode require every
recovery action to be explicitly authorized. The Discovery Report proposed 9
9C-specific error codes and initially split approval into gated progress ops
versus ungated "restrict-only" recording ops. The review's correction round
found that safe mode forbids unapproved writes — including bookkeeping writes —
so a recording exemption would contradict the tracked safe-mode authority.
Merge-time conflict handling also needed a single deterministic result per
failure condition without touching the locked 18 Phase 9B codes.

## Decision

1. **Uniform approval gating:** all 41 transitions are approval-gated at P12
   (`RECOVERY_APPROVAL_REQUIRED` when operation-level approval evidence is
   missing). Recording operations remain *restrict-only in effect* (targets
   always one of BLOCKED/INTERRUPTED/FAILED/CONFLICTED; they never grant
   progress) but are gated like every other transition.
   `contract_alone_authorizes_execution = false`; approval gate + safe mode
   remain authoritative; ARCHIVE additionally requires user confirmation; 9C
   never uses DELETE-class or SECRET_ACCESS-class actions.
2. **Exactly 8 canonical 9C errors:** `SESSION_RECOVERY_INVALID`,
   `INVALID_RECOVERY_STATE`, `ILLEGAL_TRANSITION`,
   `CHECKPOINT_OWNERSHIP_MISMATCH`, `CHECKPOINT_INVALID`,
   `RECOVERY_IDENTITY_MISMATCH`, `RECOVERY_PRECONDITION_FAILED`,
   `RECOVERY_APPROVAL_REQUIRED` — exact scopes in contract section 15.
3. **Correction vs Discovery:** `RESUME_PRECONDITION_FAILED` renamed
   `RECOVERY_PRECONDITION_FAILED` (preconditions exist on 41 edges, not only
   resume); `MERGE_PENDING_CONFLICT` **dropped as unreachable** — merge-time
   conflicts are caught at P5 by the locked Phase 9B codes
   (`STALE_MAIN_BASELINE`, `LANE_OWNERSHIP_CONFLICT`, ...), whose correct
   follow-up is the `CONFLICT_RECORD` transition
   (`MERGE_PENDING -> CONFLICTED`). An unreachable code must not be locked.
4. **Reused unchanged:** the locked 18 Phase 9B errors wherever Phase 9B
   conditions fire, and the generic taxonomy's `VALIDATION_ERROR` (P1) and
   `POLICY_BLOCKED` (P6). `IDEMPOTENT_REPLAY` is a success result class, not
   an error. No Phase 9B identifier is modified or shadowed.
5. **Precedence:** the exact 13-step order P1-P13 (contract section 7.1):
   request structure → 9B JobContract → foreign boundary → record identity →
   9B lane/coordination as invoked by operation class → safe mode → record →
   state enum → replay → legality → edge evidence (ownership, integrity,
   evidence) → approval → atomic apply. First failing condition wins; Phase 9B
   isolation always precedes 9C state semantics; approval is the final gate.

## Consequences

- Deterministic single-result failure mapping (acceptance ST09, DI08, SB01,
  SB02).
- Recovery can never self-authorize: even failure recording rides the
  existing approval workflow.

## Alternatives Rejected

- Ungated recording transitions — contradicts safe mode's write prohibition.
- Keeping `MERGE_PENDING_CONFLICT` — unreachable under the locked precedence.
- A 9C wrapper code around Phase 9B detection codes — would shadow the locked
  18 and break single-result mapping.
- Approval last vs first — approval is a gate, not a state fact; evaluating
  identity/isolation first yields actionable boundary errors and mirrors 9B's
  structural-first discipline.
