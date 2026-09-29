# Architecture Blueprint

Status vocabulary: `VERIFIED`, `IMPLEMENTED`, `PARTIAL`, `TARGET`, `BLOCKED`, `DEFERRED`.

# CURRENT VERIFIED ARCHITECTURE

```text
User
  ↓
OpenCode Engine (external/upstream, 1.18.32)
  ↓
Repository Control Plane
  ├─ .opencode agents, commands, skills, orchestration
  ├─ project configuration
  ├─ environment and secret contracts
  └─ bootstrap/templates
  ↓
Session / Context
  ↓
Generic Runtime / MCP
  ↓
Governed capability modules
```

OpenCode engine is external/upstream. The OpenCode control plane is repository-owned. `main` is the coordination authority and authoritative context, not a single execution thread. `main` and `worker` are session roles/namespaces, not manager-agent hierarchies or autonomous swarms. Parallel execution is TARGET — Phase 9B.

The nine commands are `/main`, `/work`, `/checkpoint`, `/load`, `/merge`, `/promote`, `/demote`, `/rename`, and `/archive`.

The exact 26 CORE skills are: caveman, code-reviewer, context-handoff-generator, diagnose, eco-builder, fast-happy-path, find-skills, grill-me, grill-with-docs, handoff, improve-codebase-architecture, managing-python-dependencies, post-run-memory-updater, prototype, qa, requirement-analysis, review, skill-repair, tdd, teach, to-issues, to-prd, triage, ubiquitous-language, write-a-skill, and zoom-out.

Skill != agent. Skill != permission elevation. Skill != policy override. Skill != automatic global-memory authority.

## Memory and environment

`state/sessions` = operational session state; `knowledge/sources` = raw/reference knowledge; `knowledge/curated` = reviewed reusable knowledge; `opencode-mem` = semantic/probabilistic recall; `opencode.db` = local conversation/runtime persistence.

Storage architecture = existing. Deterministic Context Hydration = VERIFIED (Phase 9A — 37/37 acceptance, runner 9/9, policy context-hydration@1.0.1).

Environment precedence is `profile > root > inherited`; stale inherited PROFILE-scoped variables are purged when a profile is selected. The managed contract has 10 variables: 3 GLOBAL and 7 PROFILE.

## Generic runtime — VERIFIED

Execution context, result envelope, error taxonomy, run IDs, redaction, MCP registry, and health aggregation are VERIFIED. CORE unavailable is unhealthy/fatal; OPTIONAL unavailable is degraded/nonfatal; PLANNED unavailable is healthy/nonfatal.

## Oracle secure read-only — VERIFIED

```text
OpenCode → Oracle MCP stdio → tool handler → policy
→ structured query builder → bind parameters → Oracle adapter
→ node-oracledb → Oracle DB
```

Oracle Core = VERIFIED. Oracle Driver = VERIFIED. Oracle MCP stdio = VERIFIED. M01–M08 = PASS. Live Read = VERIFIED. Live Write = DISABLED. The exact tools are `oracle_health`, `oracle_read`, `oracle_insert`, `oracle_update`, and `oracle_ddl`. `oracle_delete`, `oracle_raw_sql`, `oracle_execute_sql`, and `run_sql` are ABSENT. Live INSERT, UPDATE, and DDL are blocked.

# PHASE 9 ARCHITECTURE

Phase 9A is VERIFIED (37/37 acceptance, runner 9/9, policy context-hydration@1.0.1).

Phase 9B is IN PROGRESS / NOT VERIFIED under job-isolation@1.0.0.

Phase 9C remains TARGET / NOT VERIFIED.

## Context Hydration — VERIFIED (Phase 9A)

Phase 9A acceptance: 37/37 — runner: 9/9 — policy: `context-hydration@1.0.1`.

Mandatory context → deterministic; curated knowledge → relevance-based; raw sources → explicit/on-demand; semantic memory → advisory retrieval.

```text
Session Start
  ↓ Resolve Job / Session
  ↓ Mandatory Context
  ↓ Objective Parser
  ↓ Confidence Gate
  ↓ Candidate Retrieval
  ↓ Eligibility Gate
  ↓ Deterministic Scoring
  ↓ Deduplication
  ↓ Budget Enforcement
  ↓ ContextPackage
```

## Objective Parser — VERIFIED (Phase 9A)

Input: `session_id`, `job_id`, latest checkpoint, user request, active constraints, and optional explicit objective. Output: `StructuredObjective` with objective_id, summary, intent, scope, entities[], constraints[], retrieval_terms[], confidence, and provenance. HIGH >= 0.80, MEDIUM >= 0.60, LOW < 0.60. LOW confidence means mandatory-only hydration and automatic retrieval disabled.

## Scoring and policy versioning — VERIFIED (Phase 9A)

Weights: semantic relevance = 0.50, scope specificity = 0.25, authority = 0.20, recency = 0.05. Foreign-job knowledge is a hard reject before scoring. Tie-break: 1) total_score DESC, 2) scope_specificity DESC, 3) authority DESC, 4) updated_at DESC, 5) source_id ASC. Behavior-affecting changes require a policy version increment. Policy identity: `context-hydration@1.0.1`. 1.0.0 is the initial merged contract; 1.0.1 supersedes it after post-merge determinism corrections.

## Context budget and omitted retention — VERIFIED (Phase 9A)

Mandatory context protected; active conversation protected/bounded; retrieved knowledge bounded; execution results bounded; response headroom reserved. Retrieved knowledge <= 20% available context. Never silently drop current objective, job/profile identity, active safety constraints, approval state, latest valid checkpoint, or mandatory project instructions.

Full omitted content retention = 0. Allowed metadata: source_id, source_type, scope, score, rank, omission_reason, estimated_tokens, hydration_run_id. Default metadata retention = 30 days, local-only, redacted.

## Skill chain — VERIFIED (Phase 9A)

Classify skills as PRIMARY, SUPPORTING, or CONFLICTING. DEFAULT MAX = 3. USER EXPLICIT OVERRIDE MAX = 5. HARD LIMIT = 5. Conflicts fail closed. Never silently truncate.

## Phase 9A acceptance contract — VERIFIED (Phase 9A)

O01 explicit objective preserved; O02 clear request produces structured objective; O03 scope extracted correctly; O04 active constraints preserved; O05 provenance preserved; O06 low-confidence objective blocks retrieval; O07 low-confidence still loads mandatory context; O08 ambiguous objective does not invent entities; O09 identical input + policy produces identical objective; O10 explicit objective outranks inferred objective.

H01 mandatory context always loaded; H02 relevant curated item retrieved; H03 irrelevant item excluded; H04 foreign-job knowledge hard rejected; H05 raw source not auto-injected; H06 semantic relevance dominates recency appropriately; H07 deterministic tie-breaking; H08 latest checkpoint bypasses candidate ranking; H09 context budget respected; H10 mandatory context never silently dropped; H11 duplicate knowledge deduplicated; H12 empty retrieval produces valid context; H13 provenance preserved; H14 omitted content not persisted; H15 omitted metadata safely persisted; H16 retention policy applied; H17 identical input + identical policy produces identical ordering.

S01 one matching skill; S02 two compatible skills chain correctly; S03 three skills allowed by default; S04 four skills require explicit override; S05 five skills allowed only with override; S06 six skills hard rejected; S07 chain never silently truncated; S08 conflicting skills fail closed; S09 explicit user skill retained; S10 skill cannot override runtime policy.

Total: 37 locked Phase 9A acceptance invariants. Acceptance result: 37/37 VERIFIED (O 10/10, H 17/17, S 10/10); runner 9/9.

## Multi-job isolation and parallel semantics — Phase 9B

Governance contract: CONTRACT LOCKED — job-isolation@1.0.0

Runtime implementation: IN PROGRESS / PARTIAL

Implemented:
- JobContract Runtime Core
- deterministic namespace derivation primitives
- ParallelLane runtime semantics

Pending:
- namespace isolation enforcement
- parallel-lane main-coordination integration
- main coordination integration
- Phase 9B acceptance

Phase 9B acceptance: NOT VERIFIED

JobContract v1: exactly 8 canonical fields:
job_id, profile, session_namespace, knowledge_scope, evidence_namespace, ledger_namespace, runtime_state_namespace, execution_permissions.

The broader Job Isolation boundary also includes:

- working context as a derived job-scoped view, not a JobContract field;
- operation-specific execution targets such as database targets, outside the JobContract schema and unable to override job/profile/permissions or approval/security boundaries.

## Session recovery — TARGET — Phase 9C

Target states: NEW, ACTIVE, CHECKPOINTED, BLOCKED, INTERRUPTED, FAILED, CONFLICTED, MERGE_PENDING, RESOLVED, ARCHIVED. No silent recovery is claimed.

# V1 DEFINITION OF DONE

Phase 2–9A are VERIFIED. Phase 9B–9C must reach VERIFIED with acceptance evidence before Architecture Freeze v1 is eligible. Architecture Freeze v1 = NOT CLAIMED. Zero-state bootstrap is PARTIAL; clean-clone verification and public v1 release remain TARGET.
