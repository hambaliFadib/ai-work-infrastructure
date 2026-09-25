# Context Hydration — Architecture Document

**Status:** TARGET — CONTRACT LOCKED
**Implementation:** NOT YET IMPLEMENTED
**Policy:** context-hydration@1.0.0

---

## 1. Overview

Context Hydration v1 defines the deterministic pipeline for assembling session context. This document explains the contract without claiming implementation.

---

## 2. Pipeline

```
Session Start
    ↓
Resolve Job / Session
    ↓
Mandatory Context
    ↓
Objective Parser
    ↓
Confidence Gate
    ↓
Candidate Retrieval
    ↓
Eligibility Gate
    ↓
Deterministic Scoring
    ↓
Deduplication
    ↓
Budget Enforcement
    ↓
ContextPackage
```

---

## 3. Objective Contract

The Objective Parser produces a `StructuredObjective` from:

- session_id
- job_id
- latest checkpoint
- user request
- active constraints
- optional explicit objective

Output fields: objective_id, summary, intent, scope, entities[], constraints[], retrieval_terms[], confidence, provenance.

Explicit objective outranks inferred objective. Ambiguity does not invent entities.

**Ownership:** #9 (9A-02)

---

## 4. Confidence Gate

| Level | Threshold | Behavior |
|---|---|---|
| HIGH | >= 0.80 | Full retrieval |
| MEDIUM | >= 0.60 | Full retrieval |
| LOW | < 0.60 | Mandatory only; no auto retrieval |

---

## 5. Eligibility

Hard reject: foreign job knowledge.

| Source | Eligibility |
|---|---|
| Mandatory context | Mandatory |
| Curated knowledge | Eligible |
| Reviewed session fact | Eligible |
| Historical checkpoint | Eligible |
| Semantic memory | Advisory |
| Raw source | Explicit-only |

Latest valid checkpoint is mandatory and bypasses ranking.

---

## 6. Ranking

Weights: semantic 0.50, scope 0.25, authority 0.20, recency 0.05. Sum = 1.00.

Authority: curated 1.00, reviewed session fact 0.90, historical checkpoint 0.80, semantic memory 0.50.

Tie-break: total_score DESC, scope_specificity DESC, authority DESC, updated_at DESC, source_id ASC.

**Ownership:** #10 (9A-03)

---

## 7. Budget

Retrieved knowledge <= 20% of available context.

Protected set (never dropped): objective, job/profile identity, safety constraints, approval state, latest checkpoint, mandatory project instructions.

Overflow: CONTEXT_BUDGET_EXCEEDED.

**Ownership:** #12 (9A-05)

---

## 8. ContextPackage

Envelope fields: hydration_run_id, policy_id, policy_version, objective, job_id, session_id, mandatory[], retrieved[], omitted[], budget.

Each retrieved record preserves: source_id, source_type, scope, score, rank, reason, provenance.

No secrets persisted.

**Ownership:** #12 (9A-05)

---

## 9. Omission

Full content persistence: 0.

Allowed metadata: source_id, source_type, scope, score, rank, omission_reason, estimated_tokens, hydration_run_id.

Metadata: redacted, local-only, 30-day retention.

**Ownership:** #12 (9A-05)

---

## 10. Skill Resolver

Classes: PRIMARY, SUPPORTING, CONFLICTING.

Order: UNDERSTAND → DESIGN/PLAN → EXECUTE → VALIDATE.

Limits: default 3, override max 5, hard max 5.

Skills cannot override runtime policy, permissions, or security constraints.

**Ownership:** #13 (9A-06)

---

## 11. Determinism (H17)

Identical candidate set + StructuredObjective + job/session scope + policy version must produce identical ordering.

---

## 12. Acceptance Matrix

| Category | IDs | Count |
|---|---|---|
| Objective | O01–O10 | 10 |
| Hydration | H01–H17 | 17 |
| Skill | S01–S10 | 10 |
| **Total** | | **37** |

---

## 13. Issue Ownership

| Issue | Scope | Status |
|---|---|---|
| #8 (9A-01) | This contract | READY |
| #9 (9A-02) | Objective Parser | BLOCKED |
| #10 (9A-03) | Ranking Policy | BLOCKED |
| #11 (9A-04) | Retrieval Adapters | BLOCKED |
| #12 (9A-05) | Budget + ContextPackage | BLOCKED |
| #13 (9A-06) | Skill Resolver | BLOCKED |
| #14 (9A-07) | Integration | BLOCKED |
| #15 (9A-08) | Acceptance Closure | BLOCKED |
