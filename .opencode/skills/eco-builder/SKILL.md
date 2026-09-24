---
name: eco-builder
description: Command center for setup, maintenance, and upgrade of the opencode ecosystem (desktop + CLI). Use when user reports opencode desktop/CLI errors, asks about opencode state/config/upgrade, wants health checks or repairs, or mentions "eco builder", "eco heal", or opencode maintenance.
metadata:
  version: "1.0.0"
  last-audited: "2026-09-16"
---

# Eco Builder

Command center for the opencode ecosystem.

## Working Principles (REQUIRED)

1. **Confirm before executing** — all destructive/impactful actions (file deletion, DB edits, task registration) must show the command and get user approval first.
2. **Research before acting** — for anything outside certain knowledge (new errors, new APIs, new update behaviors), research from official docs (opencode.ai/docs) and GitHub issues (github.com/anomalyco/opencode/issues) before proposing a fix.
3. **Backup before repair** — every repair action must backup affected files/DB to a temporary backup location.
4. **Heal only when app is closed** — desktop rewrites in-memory state to disk on exit; repairing state while app is running will be overwritten (pattern from issue #19085).
5. **Workspace root is home** — all default workspace/project/lastProject point to the workspace root.
6. **Circuit breaker** — 3 consecutive failures on the same issue → stop, ask human for help.

## References

No reference files are bundled with this skill yet. The following are planned as optional future diagnostics:

- **state-map** — map of all opencode state locations (REQUIRES_FUTURE_COMPONENT)
- **procedures** — proven repair playbooks, to be added after real repairs are validated (REQUIRES_FUTURE_COMPONENT)
- **incident-log** — maintenance chronology, to be added when runtime observability is established (REQUIRES_FUTURE_COMPONENT)
- **known-issues** — known issues list, to be populated from real incidents (REQUIRES_FUTURE_COMPONENT)

These are optional diagnostic aids. The skill operates without them.

## Standard Workflow

1. Collect evidence (read-only): desktop logs, server logs, Windows Event Log (WER), DB (`opencode.db`).
2. If a previous incident log exists at `observability/logs/`, scan it for similar cases. If not, skip this step.
3. Compose RCA + plan, request confirmation.
4. Execute with backup, verify. Record the incident to `observability/logs/` if that directory exists.

## Auto-Heal

`scripts/eco-heal.ps1` — ecosystem doctor with 3 modes:
- `diagnose` (default): scan + report, no changes. Safe anytime.
- `heal`: waits for OpenCode.exe to close, backs up, then repairs known-safe catalog.
- `auto`: for Scheduled Task logon — heal if app not running, diagnose if running.

Known-safe repair catalog (never touches sessions/messages):
- `project.worktree` dead path → re-point to workspace root
- `project_directory` / `sandboxes` dead path → remove line
- `lastProject` dead path → set to workspace root
- `.dat` workspace/window with dead path → remove (with backup)
- localStorage leveldb (heal mode only, app closed) → clean if containing dead paths
