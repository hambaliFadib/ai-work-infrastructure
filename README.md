# AI Work Infrastructure

AI-Work-Infra is reusable, governance-first OpenCode work infrastructure for software engineering, QA, system analysis, research, automation, and other technical workflows.

It owns the OpenCode control plane: contracts, governance boundaries, bootstrap surfaces, reusable commands and skills, runtime/MCP foundations, and workspace isolation. The OpenCode engine is an external upstream dependency and is not vendored here.

## Verified today

| Capability | Status |
|---|---|
| OpenCode control plane | VERIFIED |
| Agent, command, and 26 CORE skills | VERIFIED |
| Environment and secret isolation | VERIFIED |
| Generic runtime and MCP foundation | VERIFIED |
| Oracle safe core | VERIFIED |
| Oracle secure read-only integration | VERIFIED |
| Oracle live writes | DISABLED |
| Context Hydration (Phase 9A) | VERIFIED |

Phase 2 through Phase 9A are VERIFIED. See [the architecture blueprint](docs/ARCHITECTURE-BLUEPRINT.md) for the evidence boundary.

Phase 9A acceptance: 37/37 — runner: 9/9 — policy: `context-hydration@1.0.1`.

## In progress

Phase 9B — Job Isolation + Parallelism: IN PROGRESS / NOT VERIFIED

Governance: CONTRACT LOCKED — job-isolation@1.0.0

Runtime: PARTIAL

Implemented:
- JobContract Runtime Core
- deterministic namespace derivation primitives

Remaining:
- namespace isolation
- parallel-lane merge/integration
- main coordination integration
- acceptance closure

## Target architecture

- Session recovery — TARGET (Phase 9C)
- Zero-state bootstrap — PARTIAL
- Clean-clone verification — TARGET
- Public v1 release — TARGET

Phase 9A is VERIFIED.
Phase 9B is IN PROGRESS / NOT VERIFIED.
Phase 9C remains TARGET.

## Safety posture

Runtime state, credentials, sessions, browser profiles, generated logs, databases, and work artifacts remain outside the public source boundary. Oracle exposes structured tools only; `oracle_delete`, raw SQL tools, and live INSERT/UPDATE/DDL execution are absent or blocked.

## Repository map

- `.opencode/` — project agent, command, and skill surfaces
- `platform/` — OpenCode version, templates, and bootstrap scripts
- `runtime/` — environment loading, generic runtime, and MCP modules
- `governance/` — machine-readable contracts and taxonomies
- `docs/` — architecture, operations, security, and collaboration documentation
- `knowledge/`, `state/`, `work/`, and runtime local state — local-only boundaries

## Documentation

- [Architecture blueprint](docs/ARCHITECTURE-BLUEPRINT.md)
- [Workflow](docs/WORKFLOW.md)
- [Repository collaboration](docs/governance/repository-collaboration.md)
- [Security boundary](docs/SECURITY-BOUNDARY.md)
- [Environment and secret contract](docs/ENVIRONMENT.md)

Repository collaboration activation is VERIFIED. RCB-01 through RCB-07 are COMPLETE / VERIFIED; the protected GitHub issue/branch/PR/CI workflow is active.
