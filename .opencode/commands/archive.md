---
description: Archive session (move to state/sessions/_archived/, not permanent delete)
subtask: false
---

# Archive Session

/archive <session-name>

## Rules (REQUIRED)

1. Session must exist at `state/sessions/main/<name>/` or `state/sessions/worker/<name>/`
2. Cannot archive a session that is locked by /merge
3. Archive = move to `state/sessions/_archived/`, not permanent delete
4. User must confirm before archiving

## Steps

1. Parse: session-name
2. Find location:
   - Check `state/sessions/main/<name>/`
   - Check `state/sessions/worker/<name>/`
3. Validate:
   - If not found → error: "Session '<name>' not found"
   - If locked → error: "Session is being processed by /merge"
4. Show session info:
   - Name: `<name>`
   - Role: `<main|worker>`
   - Location: `<main|worker>/<name>/`
   - Findings: `<count> files`
   - Last active: `<date>`
5. Confirm:
   ```
   Archive session '<name>'?

   All findings will be moved to state/sessions/_archived/<name>-<timestamp>/
   This session will no longer appear in active sessions list.
   Can be restored from state/sessions/_archived/ if needed.

   Continue? [y/N]
   ```
6. If user declines → cancel
7. Create archive directory: `state/sessions/_archived/<name>-<timestamp>/`
8. Move all session contents to archive
9. Record in archive ledger (optional, for tracking)
10. Verify:
    - Folder at `state/sessions/main/` or `state/sessions/worker/` does not exist
    - Folder at `state/sessions/_archived/` exists

## Lock Check

Check if the session is locked by /merge before archiving. If lock is active for this session → REJECT.

## Restore

To restore an archived session:
1. Move folder from `state/sessions/_archived/<name>-<timestamp>/` to `state/sessions/<main|worker>/<name>/`
2. Update CHARTER.md status: `active`
3. Session can be used again

## Output

Archive summary:
- Session: `<name>`
- From: `<main|worker>/<name>/`
- To: `state/sessions/_archived/<name>-<timestamp>/`
- Findings: `<count> files archived`
