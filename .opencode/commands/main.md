---
description: Create a new main session with namespace
subtask: false
---

# New Session

User will provide a session name: $1.

## Naming Rules

- Session name: slug `[a-z0-9-]` (lowercase, hyphen, no spaces)
- Valid examples: `my-project`, `dev-work`, `analysis-batch`
- Display name: optional, for readability (store in CHARTER.md)
- Name is REQUIRED (must not be empty)

## Rules (REQUIRED)

1. A new session MUST NOT damage any other session — reads are allowed, writes to other namespaces are FORBIDDEN
2. Write ONLY to your own namespace (`state/sessions/main/<name>/`)
3. Global memory: ONLY via `/merge` — never edit global files directly
4. Domain-specific rules: load via skill tool when needed, do not hardcode in session
5. Role is automatically: main — sessions from /main always have role: main
6. Purpose is required — must ask the user for the session purpose

## Steps

1. Parse argument: session name (slug: lowercase-hyphen).
2. Validate:
   - Name must not be empty
   - Name must not contain characters other than `[a-z0-9-]`
3. Check location: `state/sessions/main/<name>/`
4. Check for duplicates:
   - If ALREADY EXISTS → show the existing CHARTER.md, offer:
     - "Resume this session"
     - "Create with a new name"
   - If not exists → continue
5. Ask user: session purpose (REQUIRED for main)
6. Copy `state/sessions/_template/CHARTER.md` → `state/sessions/main/<name>/CHARTER.md`, fill:
   - Session name = `<name>`
   - role = `main`
   - purpose = `<from user>`
   - Created = current ISO timestamp
   - Status = `active`
7. Create structure:
   - `CHARTER.md`
   - `CURRENT_MISSION.md` (header + mission, if any)
   - `NEXT_ACTIONS.md` (header only)
   - `HANDOFF.md` (5-layer handoff template)
   - `findings/` (empty folder + `.gitkeep`)
8. **Findings discipline (REQUIRED)**: write findings to `findings/<topic>-<date>.md` during the session.
   Every finding MUST have YAML frontmatter:
   ```yaml
   ---
   written_at: <ISO-8601 timestamp>
   expires_at: <written_at + 90 days>
   tier: L2
   source: observed
   confidence: medium
   validity_basis: <what this depends on>
   ---
   ```
9. Read global memory for context: `knowledge/curated/RECALL_INDEX.md`, `knowledge/curated/USER_WORKING_PREFERENCES.md` (brief).
10. Confirm to user: namespace ready + role: main + purpose + reminder that global writes are only via /merge.

## HANDOFF.md Template

When session ends or long idle, update `HANDOFF.md`:

```markdown
# HANDOFF — <session name>

**Last updated:** <ISO-8601 timestamp>
**Session status:** active | paused | completed

## 1. State Snapshot
<!-- Current values: what files are open, what tools are active -->

## 2. Narrative Context
<!-- 3-5 sentences explaining WHY we're doing what we're doing -->

## 3. Decision Log
<!-- What was decided, what was deferred, and why -->

## 4. Priority Queue
<!-- What next session should do first/second/third -->

## 5. Warnings and Gotchas
<!-- Institutional knowledge: things that look obvious but aren't -->
```

## Output

Brief summary: session name, role: main, purpose, namespace location.
Then continue receiving work instructions from the user.
