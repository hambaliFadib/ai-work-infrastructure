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

## Not yet activated

Labels, milestones, and hosted configuration are TARGET. Public v1 release and clean-clone verification are TARGET.
