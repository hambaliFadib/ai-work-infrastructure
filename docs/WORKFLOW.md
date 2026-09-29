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

RCB-01 is COMPLETE. RCB-02 through RCB-07 are VERIFIED.

Phase 9A is VERIFIED (37/37 acceptance, runner 9/9, policy `context-hydration@1.0.1`).
Phase 9B is IN PROGRESS. Governance contract: LOCKED — job-isolation@1.0.0. Runtime implementation: NOT STARTED.
Phase 9C is TARGET / NOT VERIFIED.
