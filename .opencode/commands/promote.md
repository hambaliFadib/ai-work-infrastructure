---
description: Promote worker session to main session
subtask: false
---

# Promote Session

/promote <session-name>

## Rules (REQUIRED)

1. Session must exist at `state/sessions/worker/<name>/`
2. Session must have role: worker (in CHARTER.md)
3. Must not be locked by /merge
4. Purpose is REQUIRED (required for main session)

## Steps

1. Parse: session-name
2. Find session at `state/sessions/worker/<name>/`
3. Validate:
   - If not found → error: "Session '<name>' not found in state/sessions/worker/"
   - If already role: main → error: "Session '<name>' is already role: main"
   - Check lock: if lock active and session_name = <name> → REJECT
4. Ask user: session purpose (REQUIRED for main)
5. Confirm: "Promote '<name>' to main? This session will gain /merge access."
6. Move folder:
   - `state/sessions/worker/<name>/` → `state/sessions/main/<name>/`
7. Update CHARTER.md:
   - `role: worker` → `role: main`
   - Add `purpose: <from user>`
8. Update `.merged` marker (if any):
   - Path inside marker may need updating
9. Verify:
   - Folder at `state/sessions/main/` exists
   - Folder at `state/sessions/worker/` does not exist
   - CHARTER.md: role = main, purpose filled

## Output

Promote summary:
- Session: `<name>`
- From: `state/sessions/worker/<name>/` (role: worker)
- To: `state/sessions/main/<name>/` (role: main)
- Purpose: `<purpose>`
