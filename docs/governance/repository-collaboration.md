# Repository Collaboration Governance

Status: IMPLEMENTED for local collaboration files. GitHub-hosted configuration remains TARGET.

Issue templates = IMPLEMENTED
PR template = IMPLEMENTED
CI baseline = IMPLEMENTED
GitHub remote activation = ACTIVE / VERIFIED
GitHub ruleset = TARGET
Remote issue workflow = TARGET

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

GitHub rulesets, remote issue workflow, labels, milestones, and hosted configuration are TARGET. Public v1 release and clean-clone verification are TARGET.
