---
description: Persist current run into session namespace (merge to global via /merge)
---

Persist the latest run so a future OpenCode reset or new session can continue from durable memory.

Reference findings from this session: @state/sessions/

## Storage Mode (check first if this session has a namespace)

### If session has a namespace (`state/sessions/<main|worker>/<name>/` exists):

1. Update `state/sessions/<main|worker>/<name>/CURRENT_MISSION.md` — mission + progress from this run
2. Update `state/sessions/<main|worker>/<name>/NEXT_ACTIONS.md` — next actions
3. Write reusable findings to `state/sessions/<main|worker>/<name>/findings/<topic>-<ts>.md` (one finding per file, concise)
4. DO NOT write to global memory files (`knowledge/curated/RECALL_INDEX.md`, etc.) — that is /merge territory

## Additional (both modes)

- If the `memory` tool is available (opencode-mem), push important findings: `memory({ mode: "add", content: "..." })` — so cross-session semantic search works immediately.
- Keep only reusable operational learning. Do not store raw secrets, OTP, cookies, DB passwords, or tokens.
