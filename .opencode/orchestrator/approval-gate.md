# Approval Gate

Execution does not happen immediately after planning.

## Gate Logic

If any `WRITE` action exists:

- block execution
- wait for user approval

No execution without approval.

## Read-Only Plans

Even when a plan is read-only, present the execution plan first.

The user must explicitly release the plan for execution.

## Approval Commands

Accepted approval examples:

- `approve execution`
- `approve step 2 only`
- `reject`

## Behavior

### `approve execution`

- release the full current plan for execution
- execute step-by-step
- log the run

### `approve step 2 only`

- release only the approved step
- keep remaining steps blocked
- update artifacts and log state

### `reject`

- do not execute
- keep current artifacts unchanged
- optionally generate a revised plan if the user asks

## Guardrails

- approval does not bypass safety checks or design confidence
- approval does not convert provisional mismatch into bug automatically
- approval does not allow writes outside project root
