# ADR-0002: RecoveryObject Identity and Namespace Home

Status: Accepted — locked with session-recovery@1.0.0; unchanged and reaffirmed under session-recovery@1.0.1
Related: governance/contracts/session-recovery-v1.md sections 4, 9, 10; job-isolation-v1.md sections 9, 13, 14

## Context

Phase 9B binds state to jobs through five derived namespaces and treats
session identity as opaque exact-match. Phase 9C must store a recovery record,
transition records, and checkpoints somewhere without changing any Phase 9B
schema, without writing recovery state into the ledger (contract section 13:
"No recovery state transitions belong here"), and without inventing a second
identity axis.

## Decision

1. **Identity:** a RecoveryObject is keyed by exactly
   `(canonical job_id, opaque session_key)`. One record per pair, forever.
   `CREATE` on an exact pair is idempotent; identity fields are immutable
   after creation; `policy_ref` skew fails `SESSION_RECOVERY_INVALID`.
2. **Scope axis:** states are session-scoped within a job (both axes
   preserved); the record schema is strict (6 fields, unknown fields fail
   closed) and contains no timestamps.
3. **Namespace home:** all 9C artifacts live only under the owning
   `session_namespace` subtree — logical layout
   `job:{job_id}:sessions:{session_key}` containing `recovery/`,
   `transitions/`, and `checkpoints/{seq}`. Logical identifiers are
   write/compare-only and are never parsed.
4. **Exclusions:** 9C writes zero bytes to `ledger_namespace` (9B section 13)
   and nothing to `runtime_state_namespace` (9B job-scoped mutable runtime
   boundary). Phase 9B decisions (eligibility, synchronization, coordination)
   are consumed **by reference only**, never duplicated as recovery state.
5. **Identity preservation:** the JobContract stays exactly 8 fields,
   byte-identical across every transition; `job_id`, `profile`, session
   identity, namespace fields, and lane/writer fields are never mutated by
   9C (contract section 9).
6. **policy_ref compatibility:** persisted-record compatibility is
   exact-current — a persisted RecoveryObject must carry exactly
   `session-recovery@1.0.1`, the sole compatible value. A persisted record
   carrying the superseded `session-recovery@1.0.0` ref is incompatible with
   the current policy and fails closed with `SESSION_RECOVERY_INVALID`
   (contract sections 4.1/4.3, P7). No implicit migration exists: 9C never
   rewrites, rebinds, repairs, or aliases a persisted ref, never
   auto-migrates persisted records, and never creates a replacement record.
   Any migration from a superseded persisted policy version is explicitly
   out of scope here; it requires a separate, reviewed governance change
   with its own versioning and acceptance.

## Consequences

- No Phase 9B contract, policy, or runtime change is required or allowed for
  9C storage: 9B defines namespace roots, 9C owns its internal layout under
  them.
- Superseded-ref persisted records (`session-recovery@1.0.0`) are rejected
  fail-closed (`SESSION_RECOVERY_INVALID`); no compatibility window, alias,
  or in-place migration path exists.
- Foreign-job/session access reuses Phase 9B errors unchanged
  (`FOREIGN_JOB_REJECT`, `FOREIGN_NAMESPACE_WRITE_REJECTED`,
  `NAMESPACE_OVERRIDE_FORBIDDEN`).
- Acceptance ID01-ID07, SB04, and SB09 test these boundaries.

## Alternatives Rejected

- Storing recovery audit in `ledger_namespace` audit events (Discovery
  proposal) — violates 9B contract section 13's explicit exclusion.
- Storing the record in `runtime_state_namespace` — it is job-scoped, not
  session-scoped, and would dilute its Phase 9B meaning.
- A new `checkpoint_namespace` root — requires a Phase 9B contract change,
  forbidden at this stage.
- Copying JobContract fields into the record — duplication risks divergence;
  preservation is enforced by per-transition revalidation instead.
