# Context Hydration v1 — Governance Contract

**Status:** TARGET — CONTRACT LOCKED
**Implementation:** NOT YET IMPLEMENTED
**Policy:** context-hydration@1.0.0
**Policy ID:** context-hydration
**Policy Version:** 1.0.0
**Policy Ref:** context-hydration@1.0.0

---

## 1. Purpose

This document is the normative human-readable contract for Context Hydration v1. It defines the deterministic pipeline, scoring weights, eligibility rules, budget constraints, ContextPackage envelope, omission policy, and skill resolution limits.

Behavior-affecting changes require a policy-version increment.

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

## 3. Retrieval Principles

| Principle | Behavior |
|---|---|
| Mandatory context | Deterministic — always loaded |
| Curated knowledge | Relevance-based — scored and ranked |
| Raw sources | Explicit/on-demand — never automatic |
| Semantic memory | Advisory retrieval — never authoritative |

---

## 4. StructuredObjective

### 4.1 Output Fields

| Field | Type | Description |
|---|---|---|
| objective_id | string | Unique identifier |
| summary | string | Human-readable summary |
| intent | string | Classified intent |
| scope | object | Scope boundaries |
| entities[] | array | Referenced entities |
| constraints[] | array | Active constraints |
| retrieval_terms[] | array | Terms for candidate retrieval |
| confidence | number | Confidence score [0, 1] |
| provenance | object | Origin tracking |

### 4.2 Input Sources

- session_id
- job_id
- latest checkpoint
- user request
- active constraints
- optional explicit objective

### 4.3 Rules

- Explicit objective outranks inferred objective
- Ambiguity must not invent entities

---

## 5. Confidence Policy

| Level | Threshold | Behavior |
|---|---|---|
| HIGH | >= 0.80 | Full retrieval eligible |
| MEDIUM | >= 0.60 | Full retrieval eligible |
| LOW | < 0.60 | Mandatory context only; automatic candidate retrieval disabled |

No silent guess/escalation.

---

## 6. Eligibility Contract

### 6.1 Hard Reject

| Condition | Action |
|---|---|
| Foreign job knowledge | Hard reject — never included |

### 6.2 Automatic Retrieval Eligibility

| Source | Eligibility |
|---|---|
| Mandatory context | Mandatory |
| Curated knowledge | Eligible |
| Reviewed session fact | Eligible |
| Historical checkpoint | Eligible |
| Semantic memory | Advisory only |
| Raw source | Explicit-only |

### 6.3 Checkpoint Rule

Latest valid checkpoint is mandatory and does NOT compete in candidate ranking.

---

## 7. Deterministic Ranking

### 7.1 Weights

| Factor | Weight |
|---|---|
| semantic relevance | 0.50 |
| scope specificity | 0.25 |
| authority | 0.20 |
| recency | 0.05 |
| **Total** | **1.00** |

### 7.2 Authority Baseline

| Source | Authority |
|---|---|
| curated | 1.00 |
| reviewed session fact | 0.90 |
| historical checkpoint | 0.80 |
| semantic memory | 0.50 |

### 7.3 Tie-Break Order

1. total_score DESC
2. scope_specificity DESC
3. authority DESC
4. updated_at DESC
5. source_id ASC

### 7.4 Determinism (H17)

Identical candidate set + StructuredObjective + job/session scope + policy version must produce identical ordering.

---

## 8. Budget Contract

- Retrieved knowledge maximum: <= 20% of available context

### 8.1 Protected Set (Never Silently Dropped)

- Current objective
- Job/profile identity
- Active safety constraints
- Approval state
- Latest valid checkpoint
- Mandatory project instructions

### 8.2 Overflow

If mandatory context itself exceeds its usable budget: `CONTEXT_BUDGET_EXCEEDED`

No silent mandatory-context truncation.

---

## 9. ContextPackage Envelope

| Field | Description |
|---|---|
| hydration_run_id | Run identifier |
| policy_id | Policy identifier |
| policy_version | Policy version |
| objective | StructuredObjective |
| job_id | Job identifier |
| session_id | Session identifier |
| mandatory[] | Mandatory context records |
| retrieved[] | Retrieved knowledge records |
| omitted[] | Omitted record metadata |
| budget | Budget utilization |

### 9.1 Retrieved Record Audit Fields

- source_id
- source_type
- scope
- score
- rank
- reason
- provenance

Do NOT persist secrets.

---

## 10. Omission Contract

### 10.1 Full Content Persistence

0 — no omitted raw content is persisted.

### 10.2 Allowed Omission Metadata

- source_id
- source_type
- scope
- score
- rank
- omission_reason
- estimated_tokens
- hydration_run_id

### 10.3 Metadata Constraints

- Redacted
- Local-only
- Default retention = 30 days

---

## 11. Skill Resolution Contract

### 11.1 Classes

- PRIMARY
- SUPPORTING
- CONFLICTING

### 11.2 Execution Order

1. UNDERSTAND
2. DESIGN/PLAN
3. EXECUTE
4. VALIDATE

### 11.3 Limits

| Limit | Value |
|---|---|
| Default maximum | 3 |
| Explicit-user override | max 5 |
| Hard maximum | 5 |

### 11.4 Decision Rules

| Skills | Override | Result |
|---|---|---|
| 1–3 | none needed | Allowed |
| 4 | none | SKILL_CHAIN_REQUIRES_OVERRIDE |
| 5 | none | SKILL_CHAIN_REQUIRES_OVERRIDE |
| 4–5 | explicit override | Allowed |
| >5 | any | SKILL_CHAIN_LIMIT_EXCEEDED |
| conflict | any | SKILL_CONFLICT |

Hard-limit evaluation MUST take precedence over override-required evaluation. Therefore 6 skills without override resolves to SKILL_CHAIN_LIMIT_EXCEEDED, NOT SKILL_CHAIN_REQUIRES_OVERRIDE.

### 11.5 Error Conditions

| Condition | Error |
|---|---|
| 4–5 skills without explicit override | SKILL_CHAIN_REQUIRES_OVERRIDE |
| >5 skills regardless of override | SKILL_CHAIN_LIMIT_EXCEEDED |
| Conflict detected | SKILL_CONFLICT |

### 11.6 Invariants

- Never silently truncate
- Explicit user-selected skill has highest skill-selection priority
- Skill can NEVER override: runtime policy, permissions, security constraints

---

## 12. Acceptance Invariants

### 12.1 Objective — O01–O10

| ID | Invariant |
|---|---|
| O01 | Explicit objective preserved |
| O02 | Clear request produces structured objective |
| O03 | Scope extracted correctly |
| O04 | Active constraints preserved |
| O05 | Provenance preserved |
| O06 | LOW confidence blocks automatic retrieval |
| O07 | LOW confidence still loads mandatory context |
| O08 | Ambiguity does not invent entities |
| O09 | Identical input + policy produces identical objective |
| O10 | Explicit objective outranks inferred objective |

### 12.2 Hydration — H01–H17

| ID | Invariant |
|---|---|
| H01 | Mandatory context always loaded |
| H02 | Relevant curated item retrieved |
| H03 | Irrelevant item excluded |
| H04 | Foreign-job knowledge hard rejected |
| H05 | Raw source not auto-injected |
| H06 | Semantic relevance dominates recency appropriately |
| H07 | Deterministic tie-breaking |
| H08 | Latest checkpoint bypasses candidate ranking |
| H09 | Context budget respected |
| H10 | Mandatory context never silently dropped |
| H11 | Duplicate knowledge deduplicated |
| H12 | Empty retrieval produces valid ContextPackage |
| H13 | Provenance preserved |
| H14 | Omitted content not persisted |
| H15 | Omitted metadata safely persisted |
| H16 | Retention policy applied |
| H17 | Identical inputs/scope/policy produce identical ordering |

### 12.3 Skill — S01–S10

| ID | Invariant |
|---|---|
| S01 | One matching skill |
| S02 | Two compatible skills |
| S03 | Three compatible skills allowed by default |
| S04 | Four skills require explicit override |
| S05 | Five skills allowed only with override |
| S06 | Six skills rejected |
| S07 | Chain never silently truncated |
| S08 | Conflicting skills fail closed |
| S09 | Explicit user skill retained |
| S10 | Skill cannot override runtime policy |

### 12.4 Total

10 + 17 + 10 = **37**

---

## 13. Issue Ownership

| Issue | Scope |
|---|---|
| #8 (9A-01) | This contract |
| #9 (9A-02) | Objective Parser |
| #10 (9A-03) | Ranking Policy |
| #11 (9A-04) | Retrieval Adapters |
| #12 (9A-05) | Budget + ContextPackage |
| #13 (9A-06) | Skill Resolver |
| #14 (9A-07) | Integration |
| #15 (9A-08) | Acceptance Closure |
