---
description: Demote main session to worker session
subtask: false
---

# Demote Session

/demote <session-name>

## Rules (REQUIRED)

1. Session must exist at `state/sessions/main/<name>/`
2. Session must have role: main (in CHARTER.md)
3. Must not be locked by /merge
4. Confirm first — demote means losing /merge access

## Steps

1. Parse: session-name
2. Find session at `state/sessions/main/<name>/`
3. Validate:
   - If not found → error: "Session '<name>' not found in state/sessions/main/"
   - If already role: worker → error: "Session '<name>' is already role: worker"
   - Check lock: if lock active and session_name = <name> → REJECT
4. Confirm:
   ```
   Demote '<name>' to worker?

   Impact:
   - This session will lose /merge access
   - Knowledge still gets merged to global
   - Folder moves from state/sessions/main/ → state/sessions/worker/

   Continue? [y/N]
   ```
5. If user declines → cancel
6. Move folder:
   - `state/sessions/main/<name>/` → `state/sessions/worker/<name>/`
7. Update CHARTER.md:
   - `role: main` → `role: worker`
   - Remove `purpose` field
8. Update `.merged` marker (if any):
   - Path inside marker may need updating
9. Verify:
   - Folder at `state/sessions/worker/` exists
   - Folder at `state/sessions/main/` does not exist
   - CHARTER.md: role = worker, purpose empty

## Output

Demote summary:
- Session: `<name>`
- From: `state/sessions/main/<name>/` (role: main, purpose: `<old purpose>`)
- To: `state/sessions/worker/<name>/` (role: worker)
