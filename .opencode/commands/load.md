---
description: Load durable memory + session namespace context
---

Load durable memory before continuing work.

Current git context: !`git log --oneline -3 --no-decorate`

## 1. Session namespace (if any)

Check `state/sessions/` — if this session's namespace exists (created via `/main` or `/work`), read first:

- `state/sessions/<main|worker>/<name>/CHARTER.md` — ownership boundary of this session
- `state/sessions/<main|worker>/<name>/CURRENT_MISSION.md`
- `state/sessions/<main|worker>/<name>/NEXT_ACTIONS.md`

If no namespace exists → suggest `/main <name>` (main) or `/work <name>` (worker) to the user, but continue loading global context below.

## 2. Global memory (merge points)

- `knowledge/curated/RECALL_INDEX.md`
- `knowledge/curated/USER_WORKING_PREFERENCES.md`
- `state/sessions/<role>/<name>/CURRENT_MISSION.md`
- `knowledge/sources/legacy-memory/LEARNED_FLOW.md`
- `knowledge/sources/legacy-memory/BUG_PATTERNS.md`

## 3. Runtime handoff (if any)

Check for runtime context documents in the workspace:
- `runtime/scripts/*/docs/CONTEXT_HANDOFF.md`
- `runtime/scripts/*/docs/ACTIVE_MODULE.md`
- `runtime/scripts/*/docs/LAST_RUN_SUMMARY.md`
- `runtime/scripts/*/docs/BLOCKERS.md`
- `runtime/scripts/*/docs/SESSION_HEALTH.md`

## 4. Semantic memory (opencode-mem)

If the `memory` tool is available (opencode-mem plugin), run `memory({ mode: "search", query: "<topic of this session>" })` to retrieve cross-session context.

---

Then summarize the current mission, active module, next action, and any blocker in no more than 10 bullets. Do not edit files unless the user asks for work to continue.

**Write rule:** this session may only write to its own namespace. Update global files ONLY via `/merge`.
