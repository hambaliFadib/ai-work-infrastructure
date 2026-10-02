# ADR-0006: Phase 9C Acceptance Model — 70 Declared Invariants

Status: Accepted — locked with session-recovery@1.0.0
Related: governance/contracts/session-recovery-v1.md section 20; job-isolation-v1.md section 28

## Context

Phase 9A and 9B followed a contract-first pattern: the full acceptance model
is declared inside the locked contract before any runtime exists, then
executed by a later acceptance issue against the locked IDs. The Discovery
Report suggested 8 categories x 10 = 80 as a placeholder; the governance
review was required to derive the count from actual normative semantics
instead of assuming it.

## Decision

1. **Exactly 70 invariants in 8 categories**, declared in contract
   section 20:
   `RC01-RC08` (8), `ST01-ST12` (12), `CP01-CP10` (10), `ID01-ID07` (7),
   `IF01-IF07` (7), `MP01-MP08` (8), `DI01-DI08` (8), `SB01-SB10` (10).
2. **Derived, not assumed:** the correction round split CP09 into the
   forward invariant (`CHECKPOINTED => store non-empty`) and the new CP10
   (resume durability / `store non-empty ⇏ CHECKPOINTED`), taking CP from 9
   to 10 and the total from 69 to 70. No category carries filler invariants;
   each ID is independently testable against a normative clause.
3. **Declared, not executed:** no ID is authoritative until the contract
   lock; docs/acceptance/phase-9c.md does not exist yet; execution belongs to
   the future acceptance issue (9C-07) with the Phase 9B runner shape
   (explicit registry, all suites required, skipped = 0, non-zero exit on
   failure) and fixed 100x determinism repeats with no wall clock,
   randomness, or environment reads in suite sources.
4. **Phase 9B untouched:** acceptance remains exactly JC01-JC10,
   NS01-NS10, PL01-PL10, EP01-EP10 (40/40 VERIFIED).

## Consequences

- The contract lock fixes the invariant vocabulary; later runtime and
  acceptance work consumes it without renaming IDs or adding IDs.
- Any future semantic change requires a contract version change and an ADR.

## Alternatives Rejected

- Keeping 80 (8 x 10) — assumes symmetry the semantics do not have; the
  review's derivation (69) plus the consistency correction (CP10) yields 70.
- Executing acceptance at lock time — contradicts contract-first governance
  and the "declared not executed" status.
- Placing IDs in docs/acceptance/phase-9c.md before lock — acceptance IDs
  become authoritative only through the locked contract.
