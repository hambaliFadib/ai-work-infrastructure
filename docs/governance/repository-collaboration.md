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
epic:     #7  status:ready
9A-01:    #8  status:ready     (governance contract)
9A-02:    #9  status:blocked   (objective parser)
9A-03:    #10 status:blocked   (ranking policy)
9A-04:    #11 status:blocked   (retrieval adapters)
9A-05:    #12 status:blocked   (budget + ContextPackage)
9A-06:    #13 status:blocked   (skill resolver)
9A-07:    #14 status:blocked   (integration)
9A-08:    #15 status:blocked   (acceptance 37/37)
```

### Phase 9B — Job Isolation + Parallelism

```text
epic:     #16 status:blocked (blocked until Phase 9A VERIFIED)
children: 0
```

### Phase 9C — Session Recovery

```text
epic:     #17 status:blocked (blocked until Phase 9B VERIFIED)
children: 0
```

## Not yet activated

Labels, milestones, and hosted configuration are TARGET. Public v1 release and clean-clone verification are TARGET.
