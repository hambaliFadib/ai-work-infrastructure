---
name: fast-happy-path
description: Quick validation of the most common happy-path scenario. Use when user wants a fast smoke test or sanity check of primary functionality.
metadata:
  version: "1.0.0"
  last-audited: "2026-09-16"
---

# Fast Happy Path

Quick validation of the most common happy-path scenario.

## Purpose

Run the simplest, most common use case end-to-end to confirm the system works at a basic level. This is a smoke test, not comprehensive coverage.

## Process

1. Identify the primary user journey or core function
2. Execute it with standard/valid inputs
3. Verify the expected output or state change
4. Report pass/fail with evidence

## When to Use

- After a deployment or major change
- Before starting deeper testing
- As a quick sanity check
- When time is limited and you need a confidence signal

## Rules

- Keep it fast — under 5 minutes
- Use real paths, not mocked ones
- Report evidence for each step
- If it fails, stop and report — do not attempt fixes within this skill
