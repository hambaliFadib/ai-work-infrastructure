---
description: Bootstrap namespace memory + charter for worker session
subtask: false
---

# Session Start

User will provide a session name: $1.

## Naming Rules

- Session name: slug `[a-z0-9-]` (lowercase, hyphen, no spaces)
- Valid examples: `my-project`, `dev-work`, `analysis-batch`
- Display name: optional, for readability (store in CHARTER.md)
- Name is REQUIRED (must not be empty)

## Rules (REQUIRED)

1. A new session MUST NOT damage any other session — reads are allowed, writes to other namespaces are FORBIDDEN
2. Write ONLY to your own namespace (`state/sessions/worker/<name>/`)
3. Global memory: ONLY via `/merge` — never edit global files directly
4. Domain-specific rules: load via skill tool when needed, do not hardcode in session
5. Role default: worker — sessions from /work always have role: worker
6. Purpose is optional — not required for worker

## /main vs /work

| Command | Role | Namespace | Purpose |
|---|---|---|---|
| `/main <name>` | main | `state/sessions/main/<name>/` | Required |
| `/work <name>` | worker | `state/sessions/worker/<name>/` | Optional |

**Use `/main` when:**
- Need access to /merge
- Primary session for maintenance or workflow

**Use `/work` when:**
- Worker session for a specific task
- No need for /merge access
- Knowledge still gets merged to global via /merge

## Steps

1. Parse argument: session name (slug: lowercase-hyphen).
2. Validate:
   - Name must not be empty
   - Name must not contain characters other than `[a-z0-9-]`
3. Check location: `state/sessions/worker/<name>/`
4. Check for duplicates:
   - If ALREADY EXISTS → show the existing CHARTER.md, offer:
     - "Resume this session"
     - "Create with a new name"
   - If not exists → continue
5. Ask user: session purpose (optional for worker)
6. Copy `state/sessions/_template/CHARTER.md` → `state/sessions/worker/<name>/CHARTER.md`, fill:
   - Session name = `<name>`
   - role = `worker`
   - purpose = `<if provided>`
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
10. Confirm to user: namespace ready + role: worker + reminder that global writes are only via /merge.

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
```

## Output

Brief summary: session name, role: worker, namespace location.
Then continue receiving work instructions from the user.
