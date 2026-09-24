# Migration Manifest

This document preserves migration history while separating historical context from current operational truth. Historical source workspaces are represented as `<legacy-workspace>` and are non-operational references.

## Current status

Phase 2–8 are VERIFIED. RCB-01 is COMPLETE and RCB-02 is CURRENT. RCB-03 through RCB-07 are PENDING. Phase 9A Context Hydration, Phase 9B Job Isolation + Parallelism, and Phase 9C Session Recovery are TARGET.

## Migration principles

- The repository is general-purpose infrastructure, not a client- or project-specific application.
- Legacy project names and datasets were migration inputs only; they are not runtime dependencies.
- Credentials, runtime state, sessions, ledgers, databases, logs, browser state, and work artifacts remain local-only.
- Templates and bootstrap logic resolve repository/configuration paths dynamically.
- The OpenCode engine remains an external dependency; this repository owns its control plane.

## Phase 2 — Foundation — VERIFIED

Fresh destination architecture, repository boundaries, contracts, and neutral identity established.

## Phase 3 — General-Purpose OpenCode Core — VERIFIED

The reviewed agent, command, and CORE skill surfaces are present under `.opencode/`. Historical client-specific material is excluded or generalized.

## Phase 4 — OpenCode Control Plane — VERIFIED

Version contract, sanitized global templates, project configuration, permissions, and bootstrap/provisioning boundaries are present under `platform/` and the repository root.

## Phase 5 — Environment and Secret Contract — VERIFIED

The authoritative loader, profile isolation, precedence rules, stale inherited PROFILE cleanup, and redaction boundaries are implemented and tested. Secret values are not part of this repository.

## Phase 6 — Generic Runtime and MCP — VERIFIED

Runtime result envelopes, error taxonomy, execution context, run IDs, redaction, registry, health aggregation, and deterministic tests are present.

## Phase 7 — Oracle Safe Core — VERIFIED

Structured policy, identifiers, query builders, transaction semantics, evidence, adapter boundaries, and deterministic Oracle tests are present.

## Phase 8 — Oracle Secure Read-Only — VERIFIED

Oracle Core, driver, MCP stdio binding, M01–M08, portability, secret boundary, and fixed read-only connectivity are VERIFIED. The exact tools are `oracle_health`, `oracle_read`, `oracle_insert`, `oracle_update`, and `oracle_ddl`. `oracle_delete` and raw SQL tools are absent. Live INSERT, UPDATE, and DDL remain disabled.

## Historical references

Historical references to client workflows, legacy workspaces, project names, and migration findings are documentation context only. They are not operational code, runtime configuration, credentials, or supported project data.

## Current boundary

Local-only state is excluded by ignore rules. No GitHub remote, public release, clean-clone verification, or Phase 9 implementation is claimed. These remain future activation or target work.
