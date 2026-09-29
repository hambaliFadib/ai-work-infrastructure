# Repository Collaboration Governance

Status: VERIFIED. All collaboration workflows are active and enforced.

Issue templates = IMPLEMENTED
PR template = IMPLEMENTED
CI baseline = ACTIVE (4 required checks)
GitHub remote activation = ACTIVE / VERIFIED
GitHub ruleset = ACTIVE (main-protection)
Remote issue workflow = VERIFIED
Branch workflow = VERIFIED
PR workflow = VERIFIED

## Main Protection Ruleset

```text
main-protection = ACTIVE
PR required = yes
required approvals = 0
conversation resolution = required
branch up-to-date = required
linear history = required
force pushes = blocked
main deletion = blocked

required checks:
- policy-check
- runtime-tests
- security-scan
- docs-contract

merge method = squash only
```

## Rules

```text
one issue → one concern → one branch → one pull request
one active writer per branch
main = authoritative truth
squash merge preferred
documentation drift = merge blocker
architecture change = ADR
no issue → no branch
no branch → no implementation
no test → no merge
no required documentation update → no merge
```

The initial clean baseline commit is the only bootstrap exception to the normal issue/branch/PR flow. After that commit, direct feature work on `main` is prohibited.

## Branch model

Use `feat/<issue>-<slug>`, `fix/<issue>-<slug>`, `test/<issue>-<slug>`, `docs/<issue>-<slug>`, or `chore/<issue>-<slug>`. Do not use generic phase or temporary branches.

## Documentation and architecture

Every issue declares documentation impact: `NONE`, `UPDATE_EXISTING`, or `NEW_DOCUMENT`. Fundamental architecture changes require an ADR under `docs/decisions/`.

## Phase 9 Issue Governance

```text
19-label taxonomy = ACTIVE
3 Phase 9 milestones = ACTIVE
issue contract = ACTIVE
dependency/status model = ACTIVE
Phase 9 backlog = ACTIVE
```

Status semantics:

```text
status:ready       safe to start
status:blocked     dependency or gate unresolved
status:integration waiting for cross-cutting integration/closure
```

GitHub issues remain authoritative backlog. Documentation reflects verified state only.

### Phase 9A — Context Hydration

```text
VERIFIED / CLOSED

#7    epic                                    CLOSED / COMPLETED
#8    9A-01 governance contract               CLOSED
#20   9A-01C determinism contract correction  CLOSED
#22   9A-01D parallel test-runner gate        CLOSED
#24   9A-01E runner concurrency correction    CLOSED
#9    9A-02 objective parser                  CLOSED
#10   9A-03 ranking policy                    CLOSED
#11   9A-04 retrieval adapters                CLOSED
#12   9A-05 budget + ContextPackage           CLOSED
#13   9A-06 skill resolver                    CLOSED
#31   9A-06C pre-integration semantics lock   CLOSED
#14   9A-07 integration                       CLOSED
#34   9A-08P H03 acceptance semantics lock    CLOSED
#15   9A-08 acceptance closure                CLOSED / COMPLETED

acceptance: 37/37
runner:     9/9
policy:     context-hydration@1.0.1
```

### Phase 9B — Job Isolation + Parallelism

```text
#43  9B-00C Phase 9 architecture status truth sync  — CLOSED / VERIFIED

#16  epic  — OPEN — IN PROGRESS / PARTIAL
children: 6

#37  9B-01 Job Isolation Governance Contract  — CLOSED / VERIFIED
#38  9B-02 JobContract Runtime Core           — CLOSED / VERIFIED
#39  9B-03 Namespace Isolation Enforcement    — status:ready
#40  9B-04 Parallel Lane Semantics            — CLOSED / VERIFIED
#41  9B-05 Main Coordination Integration      — status:blocked
#42  9B-06 Acceptance Closure                 — status:blocked

policy: job-isolation@1.0.0 — CONTRACT_LOCKED / PARTIAL
```

### Phase 9C — Session Recovery

```text
epic:     #17 status:blocked (blocked until Phase 9B VERIFIED)
children: 0
```

## Not yet activated

Public v1 release and clean-clone verification are TARGET.
