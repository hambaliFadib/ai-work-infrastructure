# Context Hydration v1 — Governance Contract

**Status:** CONTRACT LOCKED
**Implementation:** PHASE 9A VERIFIED — 37/37 ACCEPTANCE
**Policy:** context-hydration@1.0.1
**Policy ID:** context-hydration
**Policy Version:** 1.0.1
**Policy Ref:** context-hydration@1.0.1
**Supersedes:** context-hydration@1.0.0 (initial merged contract)
**Supersession Reason:** Post-merge determinism corrections: scoring formulas, budget denominator, retention timestamps

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

## 5. Term Normalization

For both `StructuredObjective.retrieval_terms[]` and `candidate.retrieval_terms[]`, apply exact v1 normalization:

1. Unicode NFKC
2. lowercase
3. trim leading/trailing whitespace
4. collapse internal whitespace to one ASCII space
5. remove empty terms
6. deduplicate exact normalized terms

Set semantics are then used for semantic-relevance calculation.

---

## 6. Confidence Policy

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

## 8. Deterministic Ranking

### 8.1 Weights

| Factor | Weight |
|---|---|
| semantic relevance | 0.50 |
| scope specificity | 0.25 |
| authority | 0.20 |
| recency | 0.05 |
| **Total** | **1.00** |

### 8.2 Semantic Relevance v1

Deterministic Jaccard similarity between normalized retrieval-term sets.

Let O = normalized objective retrieval terms, C = normalized candidate retrieval terms.

```
semantic_relevance = |O ∩ C| / |O ∪ C|
```

If |O ∪ C| = 0, then semantic_relevance = 0.

Range: 0.0–1.0. Does NOT require network, LLM, or embedding provider.

### 8.3 Scope Specificity v1

Foreign-job rejection applies only when a candidate actually carries job ownership:

```
candidate.job_id is present/non-null AND candidate.job_id != active_job_id
→ HARD REJECT BEFORE SCORING
```

A valid global candidate (candidate.scope = global, candidate.job_id absent/null) is NOT a foreign-job candidate. It remains eligible with scope_specificity = 0.50.

Evaluation order:

1. if job_id present and != active_job_id → HARD REJECT
2. same active session → 1.00
3. same active job → 0.75
4. global scope + no job_id → 0.50
5. otherwise → 0.00

Same-session candidate must not escape foreign-job rejection if it carries a conflicting job_id.

### 8.4 Authority Baseline

| Source | Authority |
|---|---|
| curated | 1.00 |
| reviewed session fact | 0.90 |
| historical checkpoint | 0.80 |
| semantic memory | 0.50 |

No other source authority value may be silently invented under policy 1.0.1. Unknown authority category must fail closed or be made ineligible before ranking.

### 8.5 Recency v1

Fixed run anchor: `hydration_started_at` (RFC3339 UTC, captured exactly once per run, immutable).

Candidate age: `age_seconds = max(0, hydration_started_at - candidate.updated_at)`

| Age Bucket | Score |
|---|---|
| age <= 1 day (86400s) | 1.00 |
| age <= 7 days (604800s) | 0.75 |
| age <= 30 days (2592000s) | 0.50 |
| age <= 90 days (7776000s) | 0.25 |
| age > 90 days | 0.00 |

Future `updated_at` values are floored to age 0. No call to current wall-clock time may occur separately for each candidate.

### 8.6 Total Score Formula

```
raw_total = (semantic_relevance * 0.50) + (scope_specificity * 0.25) + (authority * 0.20) + (recency * 0.05)
```

Quantize6: `floor((x * 1000000) + 0.5) / 1000000`

Final: `total_score = quantize6(raw_total)`. Range: 0.0–1.0.

### 8.7 Tie-Break Order

1. total_score DESC
2. scope_specificity DESC
3. authority DESC
4. updated_at DESC
5. source_id ASC

### 8.8 Determinism (H17)

Identical candidate set + normalized scoring inputs + StructuredObjective + job/session scope + hydration_started_at + policy version must produce identical ordering.

---

## 9. Budget Input Contract

Required budget inputs as explicit non-negative integer token counts:

- context_window_tokens
- response_headroom_tokens
- execution_reserve_tokens
- active_conversation_tokens
- mandatory_context_tokens

Also require: `tokenizer_id`. The runtime resolves token counts using the active model tokenizer BEFORE the budget stage.

---

## 10. Budget Reservation Order

Normatively:

1. start with context_window_tokens
2. reserve response_headroom_tokens
3. reserve execution_reserve_tokens
4. account for active_conversation_tokens
5. account for mandatory_context_tokens
6. calculate remaining available context
7. allocate retrieval budget

Formulas:

```
usable_before_mandatory = context_window_tokens - response_headroom_tokens - execution_reserve_tokens - active_conversation_tokens
```

Mandatory overflow: `mandatory_context_tokens > usable_before_mandatory → CONTEXT_BUDGET_EXCEEDED`

```
available_context_tokens = usable_before_mandatory - mandatory_context_tokens
retrieval_budget_tokens = floor(available_context_tokens * 0.20)
```

"Available context" means exactly: remaining context after response reserve, execution reserve, active conversation, and mandatory context.

### 10.1 Protected Set (Never Silently Dropped)

- Current objective
- Job/profile identity
- Active safety constraints
- Approval state
- Latest valid checkpoint
- Mandatory project instructions

### 10.2 Overflow

If mandatory context itself exceeds its usable budget: `CONTEXT_BUDGET_EXCEEDED`

No silent mandatory-context truncation.

---

## 11. ContextPackage Envelope

| Field | Description |
|---|---|
| hydration_run_id | Run identifier |
| policy_id | Policy identifier |
| policy_version | Policy version |
| hydration_started_at | Immutable run anchor (RFC3339 UTC) |
| objective | StructuredObjective |
| job_id | Job identifier |
| session_id | Session identifier |
| mandatory[] | Mandatory context records |
| retrieved[] | Retrieved knowledge records |
| omitted[] | Omitted record metadata |
| budget | Budget utilization audit |

### 11.1 Retrieved Record Audit Fields

- source_id
- source_type
- scope
- score
- rank
- reason
- provenance

### 11.2 Budget Audit Fields

- tokenizer_id
- context_window_tokens
- response_headroom_tokens
- execution_reserve_tokens
- active_conversation_tokens
- mandatory_context_tokens
- available_context_tokens
- retrieval_budget_tokens
- retrieved_tokens_used

Do NOT persist secrets.

---

## 12. Omission Contract

### 12.1 Full Content Persistence

0 — no omitted raw content is persisted.

### 12.2 Allowed Omission Metadata

- source_id
- source_type
- scope
- score
- rank
- omission_reason
- estimated_tokens
- hydration_run_id
- omitted_at (RFC3339 UTC, = hydration_started_at)
- expires_at (omitted_at + 2,592,000 seconds = 30 days)

### 12.3 Metadata Constraints

- Redacted
- Local-only
- Expiry: `expires_at = omitted_at + 2,592,000 seconds (30 days)`
- At `retention_current_time >= expires_at` the record becomes EXPIRED
- Expired records MUST NOT be returned, used by hydration, or considered active audit metadata
- Before any metadata read/list operation completes, expired records MUST be removed or irreversibly invalidated
- On storage/service initialization, expired records MUST be purged/inactivated before serving omission metadata

### 12.4 Time Anchor

`hydration_run_id` does NOT implicitly encode time. Do not rely on filesystem mtime, database insertion timestamp, process start time, or unstated storage metadata for H16.

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
| H03 | Irrelevant item excluded — policy-ineligible/final-inclusion-gate rejection; semantic relevance is a ranking factor, not an eligibility threshold (see 12.2.1) |
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

#### 12.2.1 H03 — Final-Inclusion Semantics (policy 1.0.1)

Non-behavior-changing governance clarification (issue #34).

Under policy 1.0.1, H03 "Irrelevant item excluded" means a candidate that fails the locked final-inclusion gates must not appear in `ContextPackage.retrieved`. Semantic relevance is a ranking factor, not an eligibility threshold. A semantic relevance score of 0 alone does not make an otherwise eligible candidate ineligible.

Explicit normative statements:

- semantic relevance threshold = NONE in policy 1.0.1
- Final inclusion requires the candidate to survive the applicable locked gates:
  - retrieval access boundary
  - eligibility gates
  - ranking/rankability rules
  - budget selection
- A candidate rejected by those gates must not appear in `ContextPackage.retrieved`.
- H03 MUST NOT mean: `semantic_relevance == 0 → reject`.

Canonical deterministic H03 acceptance proof (correction for finding 4123353421):

Deterministic preconditions — a canonical H03 acceptance case is INVALID unless all of the following hold:

- P1 — Confidence permits candidate retrieval: the objective classifies as MEDIUM or HIGH (`objective.confidence >= 0.60`). LOW confidence is explicitly invalid for the canonical H03 proof because LOW disables all candidate retrieval before ranking.
- P2 — Concrete raw request: `raw_source_request.explicit === true` and `raw_source_request.source_ids` contains the exact test candidate's `source_id` (example identity: `raw-h03-1`).
- P3 — Provider available and invoked: a raw_source provider exists and MUST be invoked exactly as allowed by the existing retrieval contract; it returns the candidate carrying the concrete requested `source_id`.
- P4 — Candidate survives retrieval filtering: the candidate passes the raw adapter's explicit source-id filter and is present in the retrieved candidate input to eligibility.
- P5 — Candidate passes eligibility: eligibility MUST produce `eligible = true` with reason `ELIGIBLE_EXPLICIT_RAW`. The candidate is not LOW_CONFIDENCE_MANDATORY_ONLY, RAW_SOURCE_EXPLICIT_ONLY, FOREIGN_JOB_HARD_REJECT, or INVALID_CANDIDATE.
- P6 — Candidate reaches ranking: the exact raw candidate MUST be passed to ranking. This is mandatory evidence.
- P7 — Ranking rejects for authority: policy 1.0.1 defines no raw_source authority baseline, so ranking MUST fail-close the candidate with the existing `unknown_authority` rankability result.
- P8 — Final ContextPackage exclusion: the candidate MUST NOT appear in `ContextPackage.retrieved`.

Canonical flow (normative — MUST, never "may"):

```
objective confidence MEDIUM/HIGH (>= 0.60)
        ↓
explicit raw_source request
        ↓
concrete requested source_id
        ↓
raw provider MUST be invoked
        ↓
provider returns requested raw candidate
        ↓
candidate survives explicit source-id filtering
        ↓
eligibility MUST PASS
reason = ELIGIBLE_EXPLICIT_RAW
        ↓
candidate MUST reach ranking
        ↓
raw_source has no authority baseline
under context-hydration@1.0.1
        ↓
ranking rejects candidate:
unknown_authority
        ↓
candidate MUST NOT appear in
ContextPackage.retrieved
```

H03 vs H05 distinction (strengthened):

- H03 canonical proof: provider invoked = YES; eligibility passed = YES; candidate reaches ranking = YES; final exclusion occurs at rankability with reason `unknown_authority`.
- H05: provider invocation = NO for non-explicit raw access.

A canonical H03 acceptance case is invalid if the raw provider is not invoked, the raw candidate does not pass eligibility, or the raw candidate does not reach ranking. H03 cannot be satisfied by an H05-style early absence. H05 remains unchanged: a non-explicit raw source is never automatically injected/retrieved.

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

Phase 9A acceptance status: VERIFIED — O 10/10, H 17/17, S 10/10, TOTAL 37/37

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

---

## 14. Pre-Integration Semantics Lock (D1–D7)

> These pre-integration clarifications formalize already-implemented behavior and do not change runtime semantics under policy 1.0.1.

This section is a non-behavior-changing governance clarification resolving normative gaps D1–D7 before #14 (integration) may proceed. Runtime behavior is already merged and verified (component runner 7/7). Any required runtime behavior change invalidates this section's assumptions and requires STOP + a separate policy-version decision.

### 14.1 D1 — Knowledge Dedup Identity

Duplicate retrieved knowledge identity is the pair `(source_type, source_id)`. Both components are required non-empty strings. `source_id` alone is NOT the identity.

- Malformed identity: fail closed.
- When duplicate candidate identities occur in deterministic ranked input: keep the first occurrence. Because upstream input is ranked, this preserves the highest-ranked duplicate.
- Mandatory context is outside this dedup process.
- Machine policy: `budget.dedup`.

### 14.2 D2 — Retrieval Fitting Order

Retrieval-budget fitting is deterministic ranked-order greedy skip-and-continue:

1. Input candidate order is already deterministic ranked order.
2. Candidate is atomic.
3. If `estimated_tokens <= remaining_tokens`: retrieve it.
4. Otherwise: omit it.
5. Continue evaluating later candidates against the remaining budget.
6. Never reorder candidates.
7. Never solve a packing/knapsack optimization.
8. Never split/truncate candidate content to force it to fit.

This matches the merged `applyRetrievalBudget()` behavior exactly. Machine policy: `budget.retrieval_fitting`.

### 14.3 D3 — Conflict Precedence

A validated `CONFLICTING` skill record fails the chain with `SKILL_CONFLICT` before:

- duplicate identity collapse;
- hard-chain-limit evaluation;
- override-required evaluation.

This does not change the existing rule that hard-limit precedes override-required. Both rules coexist:

```
conflict
    ↓
dedup
    ↓
hard limit
    ↓
override requirement
```

Protected override boundary checks and structural validation remain earlier fail-closed guards. Machine policy: `skills.decision_rules.conflict_precedes_chain_limits`.

### 14.4 D4 — Duplicate skill_id Semantics

Skill Resolver duplicate identity is `skill_id`. For duplicate `skill_id` records:

- first occurrence retains `class`;
- first occurrence retains `phase`;
- `explicit` becomes logical OR across all occurrences;
- first-occurrence input position is preserved;
- conflict detection occurs BEFORE duplicate collapse.

Therefore, if any duplicate occurrence is class `CONFLICTING`, the chain fails with `SKILL_CONFLICT` before collapse. Machine policy: `skills.duplicate_resolution`.

### 14.5 D5 — Empty Skill Chain

An otherwise-valid empty chain is a valid no-op. For `skills = []`:

- `count = 0`
- `ordered = []`
- `override_applied = false`

provided no structural/protected-override validation fails. An empty chain does NOT require an override. This behavior is distinct from S01, which tests a one-skill match. Machine policy: `skills.empty_chain`.

### 14.6 D6 — Resolver Guard Errors

The policy decision errors remain:

- `SKILL_CHAIN_REQUIRES_OVERRIDE`
- `SKILL_CHAIN_LIMIT_EXCEEDED`
- `SKILL_CONFLICT`

Resolver-level fail-closed guard errors are formalized separately:

- `SKILL_INVALID_INPUT` — used for malformed resolver structures/records/flags that cannot safely enter policy decision evaluation.
- `SKILL_OVERRIDE_FORBIDDEN` — used when `override_request` contains any truthy attempted override. Skills may never override runtime policy, permissions, or security constraints. Unknown truthy override keys also fail closed because they cannot be verified safe.

Guard errors are not chain decision outcomes. Machine policy: `skills.guard_errors`.

### 14.7 D7 — Implementation Status

Status: CONTRACT LOCKED
Implementation: PHASE 9A VERIFIED — 37/37 ACCEPTANCE

- Objective Parser implemented
- Ranking implemented
- Retrieval/Eligibility implemented
- Budget/ContextPackage implemented
- Skill Resolver implemented
- hydrateContext integration orchestrator implemented (#14)
- H03 acceptance semantics lock implemented (#34)
- Component + integration + acceptance runner verified 9/9
- Acceptance 37/37 VERIFIED — O 10/10, H 17/17, S 10/10
