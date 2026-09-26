# Context Hydration — Architecture Document

**Status:** TARGET — CONTRACT LOCKED
**Implementation:** NOT YET IMPLEMENTED
**Policy:** context-hydration@1.0.1
**Supersedes:** context-hydration@1.0.0 (initial merged contract, historical)

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

Foreign-job rejection: candidate.job_id present AND != active_job_id → HARD REJECT. Global candidates (scope=global, no job_id) are eligible.

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

Term normalization: NFKC, lowercase, trim, collapse whitespace, deduplicate. Semantic relevance: Jaccard similarity of normalized term sets. Scope specificity: same_session=1.00, same_job=0.75, global=0.50. Authority: curated 1.00, reviewed session fact 0.90, historical checkpoint 0.80, semantic memory 0.50. Recency: hydration_started_at anchor, buckets (1d=1.00, 7d=0.75, 30d=0.50, 90d=0.25). Total score: quantize6 of weighted sum.

Tie-break: total_score DESC, scope_specificity DESC, authority DESC, updated_at DESC, source_id ASC.

**Ownership:** #10 (9A-03)

---

## 7. Budget

Available context = context_window - response_headroom - execution_reserve - active_conversation - mandatory_context. Retrieval budget = floor(available_context * 0.20). tokenizer_id required.

Protected set (never dropped): objective, job/profile identity, safety constraints, approval state, latest checkpoint, mandatory project instructions.

Overflow: CONTEXT_BUDGET_EXCEEDED.

**Ownership:** #12 (9A-05)

---

## 8. ContextPackage

Envelope fields: hydration_run_id, policy_id, policy_version, hydration_started_at, objective, job_id, session_id, mandatory[], retrieved[], omitted[], budget.

Each retrieved record preserves: source_id, source_type, scope, score, rank, reason, provenance.

Budget audit: tokenizer_id, context_window_tokens, response_headroom_tokens, execution_reserve_tokens, active_conversation_tokens, mandatory_context_tokens, available_context_tokens, retrieval_budget_tokens, retrieved_tokens_used.

No secrets persisted.

**Ownership:** #12 (9A-05)

---

## 9. Omission

Full content persistence: 0.

Allowed metadata: source_id, source_type, scope, score, rank, omission_reason, estimated_tokens, hydration_run_id, omitted_at, expires_at.

Metadata: redacted, local-only, 30-day expiry. Expired records MUST NOT be returned or used. Cleanup enforced before post-expiry reads and on store initialization.

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

Identical candidate records + normalized scoring inputs + StructuredObjective + job/session scope + hydration_started_at + policy version must produce identical ordering.

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

Live implementation status and dependency state are authoritative in GitHub issues and are intentionally not duplicated here.

| Issue | Ownership |
|---|---|
| #8 (9A-01) | This contract |
| #9 (9A-02) | Objective Parser |
| #10 (9A-03) | Ranking Policy |
| #11 (9A-04) | Retrieval Adapters |
| #12 (9A-05) | Budget + ContextPackage |
| #13 (9A-06) | Skill Resolver |
| #14 (9A-07) | Integration |
| #15 (9A-08) | Acceptance Closure |
