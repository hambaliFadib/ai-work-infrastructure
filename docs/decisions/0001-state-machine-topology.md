# ADR-0001: Session Recovery State Machine Topology (41-Edge Allow-List, Terminality)

Status: Accepted — locked with session-recovery@1.0.0
Related: governance/contracts/session-recovery-v1.md sections 5-6; Epic #17; Phase 9C-01 discovery; Phase 9C governance review

## Context

Epic #17 declares exactly 10 target states and the principle "No silent
recovery." The Phase 9C-01 Discovery Report proposed 28 transitions with two
open terminality questions: RESOLVED was marked "terminal: proposed yes" while
the graph contained `RESOLVED -> ARCHIVED`, and ARCHIVED's definition implied a
restore path that the graph lacked. The governance review also found 13 missing
transitions (including no completion path for sessions without mergeable
output).

## Decision

1. **Terminality:** ARCHIVED is the sole terminal state (zero outgoing edges).
   RESOLVED is non-terminal with exactly one outgoing edge
   (`RESOLVED -> ARCHIVED`). The Discovery's "RESOLVED terminal" proposal is
   rejected as self-contradictory.
2. **Same-pair revival:** after ARCHIVED, governance re-entry of the same
   `(job_id, session_key)` does not exist in v1 — any such transition fails
   `ILLEGAL_TRANSITION`. Operational `/archive` file restore is a
   command-layer convention only; continued work under a new `job_id` creates
   a fresh RecoveryObject at NEW. Same-job revival requires a future contract
   version change.
3. **Allow-list:** exactly 41 ordered pairs (contract section 6.3 is the
   normative machine-parseable form); the complement (59 of 100 ordered pairs,
   including 9 of 10 self-edges) fails closed with `ILLEGAL_TRANSITION`.
   Only `CHECKPOINTED -> CHECKPOINTED` is an allowed self-edge. No transition
   into NEW; no transition out of ARCHIVED.
4. **Corrections vs Discovery (13 added edges, none removed):**
   NEW->ARCHIVED, ACTIVE->RESOLVED, CHECKPOINTED->RESOLVED,
   CHECKPOINTED->ARCHIVED, CHECKPOINTED->CHECKPOINTED (self),
   BLOCKED->CONFLICTED, BLOCKED->RESOLVED, INTERRUPTED->CONFLICTED,
   INTERRUPTED->RESOLVED, FAILED->CONFLICTED, FAILED->RESOLVED,
   CONFLICTED->RESOLVED, MERGE_PENDING->FAILED. Rationale: lifecycle
   completeness (no dead-ends), alignment of RESOLVED's definition with the
   graph, conflict recordable from any lifecycle state, and a failure-recording
   path from MERGE_PENDING.
5. **Operation purity:** `operation` is a pure function of
   `(from_state, to_state)`; ad-hoc operation names are rejected (14 distinct
   names over the 41 edges).
6. **Hard forbiddens** are locked in contract section 6.4 (ACTIVE->ARCHIVED,
   MERGE_PENDING->ACTIVE/ARCHIVED, BLOCKED->INTERRUPTED/MERGE_PENDING/
   CHECKPOINTED, checkpoint creation outside ACTIVE/CHECKPOINTED, RESOLVED
   exit = ARCHIVE only, cross-job transitions, identity-field mutation,
   transitions without explicit audited approval-gated operations).

## Consequences

- Every state change is an explicit, audited, approval-gated operation; no
  process restart, clock, read, or heuristic can transition state.
- Lifecycle completeness holds: every non-terminal state has a path to
  ARCHIVED; no orphan states.
- Acceptance ST01-ST05 and ST10-ST11 test the matrix directly.

## Alternatives Rejected

- RESOLVED as terminal (contradicts its own outgoing edge).
- ARCHIVED -> ACTIVE restore edge in v1 (would eliminate terminal states and
  conflate operational file restore with governance re-entry).
- Deriving state from checkpoint store occupancy (breaks record-authoritative
  posture; see ADR-0003).
