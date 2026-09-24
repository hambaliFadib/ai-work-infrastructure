# Post Run Memory Updater

## Goal

Persist the latest operational learning so the next model or session can continue without a recap.

## Read First

- `runtime/scripts/*/docs/LAST_RUN_SUMMARY.md`
- `runtime/scripts/*/docs/ACTIVE_MODULE.md`
- `runtime/scripts/*/docs/BLOCKERS.md`
- `runtime/scripts/*/docs/CONTEXT_HANDOFF.md`
- `knowledge/curated/RECALL_INDEX.md`
- `knowledge/curated/USER_WORKING_PREFERENCES.md`
- `knowledge/curated/*.md`
- `knowledge/sources/legacy-distilled/per-module/*/`

## Required Updates

- Update CURRENT_MISSION.md, NEXT_ACTIONS.md, BLOCKERS.md and HANDOFF.md in the explicitly selected state/sessions/<role>/<name>/ namespace as appropriate.
- Record candidate reusable observations under that session's findings/ with evidence and validation status.
- Read source documents and curated knowledge for context; do not automatically overwrite either.
- Promote only reviewed reusable findings via /merge, with approval, PID locking and backup-before-apply.

## Rules

1. Operational state is session-local; a project directory is not a session.
2. Never place temporary TODOs, blockers, raw summaries or unfinished hypotheses in curated knowledge.
3. Automatic memory helper calls require OPENCODE_SESSION_DIR selecting an existing main/worker session.
4. Learning-ledger history is observability, not automatic approval for curated promotion.
