# Context Handoff Generator

## Goal

Create a concise, reliable handoff for the next run.

## Output

- `runtime/scripts/*/docs/CONTEXT_HANDOFF.md`

## Required Sections

- Current App
- Access Status
- Active Module
- Confirmed Knowledge
- Current Blocker
- Important API
- Next Best Action

## Rules

- Use current runtime truth, not stale chat context.
- Mention exact file or module references when they matter.
- Keep it short enough to scan before a rerun.
