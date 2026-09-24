# Workflow

## Repository delivery workflow

After collaboration activation:

```text
Issue → Branch → Implementation → Tests → Documentation → Pull Request → Checks → Merge
```

One issue is one concern, one branch, and normally one pull request. Squash merge is preferred. `main` is authoritative truth and direct feature work on `main` is prohibited after the bootstrap baseline.

## OpenCode/session workflow

OpenCode sessions use `main` and `worker` as namespaces/roles. This is separate from Git branches and does not imply manager agents, subagent hierarchies, or forced delegation. `main` coordinates authoritative context; workers execute bounded work.

## Evidence and safety

Changes require tests, security evidence, and documentation impact review. Runtime state, credentials, sessions, databases, logs, and work artifacts remain local-only. Oracle live writes are disabled.

## Current activation state

RCB-01 is complete. RCB-02 is current. RCB-03 collaboration files, RCB-04 baseline commit, RCB-05 remote activation, RCB-06 branch rules, and RCB-07 project metadata are pending. Phase 9A, 9B, and 9C remain TARGET.
