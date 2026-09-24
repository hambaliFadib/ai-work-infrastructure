---
description: Promote validated reusable findings from state/sessions to knowledge/curated (draft → approval → apply). ONLY run from a session with role: main.
subtask: false
---

# Merge

## Prerequisites (HARD GATE)

1. Check CHARTER.md for this session — the `role` field must be `main`. If `role: worker` or the field is missing → reject and explain: "Only a main session (role: main) may run /merge."
   - **IMPORTANT:** `role: main` = may RUN /merge. `role: worker` = may NOT run, but their knowledge STILL gets merged to global.

2. Check lock file: `state/sessions/_merge-draft/.merge.lock`
   - If lock exists and process is alive (PID valid) → REJECT: "Merge is running from session X"
   - If lock exists but process is dead (stale) → offer `-Force` to release
   - If no lock → create new lock

3. Scan `state/sessions/main/` AND `state/sessions/worker/` — list namespaces with status:
   - `active` (CHARTER status=active)
   - `merged` (previously merged, `.merged` marker exists)
   - `stale` (no content activity > 7 days) — use content dates, not mtime

## Lock Mechanism

### Lock File
**Location:** `state/sessions/_merge-draft/.merge.lock`

**Contents:**
```json
{
  "session_name": "<name of session running merge>",
  "started_at": "<ISO-8601 timestamp>",
  "pid": <process ID>,
  "status": "running"
}
```

### Lock Lifecycle
1. **Acquire:** When /merge starts, create lock file
2. **Hold:** Lock remains active while process runs
3. **Release:** Update status → "completed" or "failed", then remove lock file
4. **Stale Detection:** Check if PID is alive. If dead → lock is stale

### Stale Lock Handling
If lock is stale (process dead), offer `-Force` to release. Force requires user approval.

### Force Override
- `-Force` may only be used when lock is STALE (process dead)
- If lock is ACTIVE → force is REJECTED
- Force must be approved by user

## Merge Scope

/merge processes ALL namespaces in `state/sessions/main/` AND `state/sessions/worker/`:

| Session Role | Can Run /merge | Knowledge Merged |
|---|---|---|
| `main` | Yes | Yes (incremental if already merged) |
| `worker` | No | Yes (full) |

**Principle:** Knowledge must be unified to global from ALL sessions, regardless of role. Role only determines WHO runs it, not WHAT gets merged.

## Knowledge promotion gate

- Only validated reusable findings, stable rules/preferences, procedures, known failure patterns, and architectural decisions are eligible.
- Reject NEXT_ACTIONS, temporary TODOs/blockers, CURRENT_MISSION, raw conversation summaries, unfinished hypotheses, and ephemeral execution state.
- A draft must identify evidence, validation status, provenance, and its specific knowledge/curated destination.
- Revalidate existing drafts against this gate; preserve all pending drafts and never auto-apply them.
- Review approval is required for each selected draft. Acquire the PID lock before apply, retain it through backup and writes, and release it on completion/failure.
- Back up every affected curated file before applying. Preserve relative paths in state/sessions/_merge-backup/<timestamp>/ and record newly created files for rollback.
- Never promote the contents of a session state file merely because its draft was previously approved. Re-review any incompatible legacy draft.

## Mode

### Mode 1: Draft (default — also used by scheduled task)

1. **Acquire lock** — create `state/sessions/_merge-draft/.merge.lock`
2. Scan ALL namespaces in `state/sessions/main/` and `state/sessions/worker/`:
   - `active` and not yet merged → full processing
   - `active` and already merged → incremental processing (content after `merged_at`)
   - `stale` → offer to merge or skip
3. For EACH namespace being processed:
   a. Read CHARTER for role/provenance and findings/* for candidates. Do not use operational state as promotion input.
   b. If findings/ is EMPTY → mark "namespace not maintained"
4. For each candidate finding:
   a. Check eligibility against the knowledge promotion gate
   b. Draft promotion entry with: source path, evidence summary, validation status, target location in knowledge/curated
   c. Present drafts to user for review
5. User approves/rejects each draft
6. For approved drafts:
   a. Back up affected files in knowledge/curated/
   b. Apply changes
   c. Mark namespace as merged (update `.merged` marker)
7. Release lock
8. Report: what was promoted, what was rejected, what was skipped

### Mode 2: Force (-Force flag)

Only when lock is stale. Acquire lock, then follow Mode 1 steps.

## Output

Summary:
- Namespaces processed
- Findings promoted (count + targets)
- Findings rejected (count + reasons)
- Namespaces skipped
- Any errors encountered
