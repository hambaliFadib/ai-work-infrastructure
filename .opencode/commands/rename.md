---
description: Rename session (folder + CHARTER + references)
subtask: false
---

# Rename Session

/rename <old-name> <new-name>

## Rules (REQUIRED)

1. Both parameters are REQUIRED
2. `<old-name>` must exist in `state/sessions/main/` or `state/sessions/worker/`
3. `<new-name>` must not already exist
4. `<new-name>` must be valid: `[a-z0-9-]` (slug)
5. Cannot rename a session that is locked by /merge

## Steps

1. Parse: old-name and new-name
2. Validate:
   - Both are non-empty
   - new-name is valid: `[a-z0-9-]`
   - Find old-name at `state/sessions/main/<old>/` or `state/sessions/worker/<old>/`
3. Check for duplicates:
   - If old-name not found → error: "Session '<old>' not found"
   - If new-name already exists → error: "Session '<new>' already exists"
4. Check lock:
   - Read `state/sessions/_merge-draft/.merge.lock`
   - If lock active and session_name = old-name → REJECT: "Session is being processed by /merge"
5. Rename folder:
   - `state/sessions/<role>/<old>/` → `state/sessions/<role>/<new>/`
6. Update CHARTER.md:
   - `Session name` = new-name
7. Update references:
   - Search `state/sessions/_merge-draft/*.md` → replace old-name with new-name
   - Search `state/sessions/_merge-queue/*.md` → replace old-name with new-name
   - Search log files → replace old-name with new-name
8. Verify:
   - New folder exists
   - CHARTER.md updated
   - No remaining references to old-name

## Output

Rename summary:
- Old: `<old-name>` at `<old location>`
- New: `<new-name>` at `<new location>`
- Files updated: <list>
