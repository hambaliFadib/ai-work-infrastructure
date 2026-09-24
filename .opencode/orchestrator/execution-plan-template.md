# Execution Plan Template

Use this exact shape when presenting an execution plan.

PLAN:
1. Step name
2. Step name
3. Step name

ACTIONS:
- READ: description
- WRITE: description (approval required)

IMPACT:
- files affected
- tools used

APPROVAL REQUIRED:
YES/NO

## Notes

- Always show the plan before execution.
- If any `WRITE` action exists, the plan must clearly say so.
- If the task spans more than 2 evidence layers, prefer staged artifact steps instead of one large compare step.
- Diagnosis artifact generation counts as `WRITE` and requires approval before execution.
