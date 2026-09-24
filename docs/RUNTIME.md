# Runtime & MCP Foundation

## Overview

The runtime layer provides a portable, auditable, fail-safe foundation for repository-owned tools and MCP servers. It is domain-neutral and does not assume any specific project, client, or business domain.

## Language Boundary

| Component | Language | Role |
|---|---|---|
| MCP server implementation | **Node.js** | Actual MCP tool servers (e.g., Oracle) |
| Shared MCP library | **Node.js** | Result envelope, redaction, validation, run ID |
| Health checks | **PowerShell** | Bootstrap, local verification, orchestration |
| Environment loader | **PowerShell** | .env parsing, profile isolation |
| Schemas | **JSON** | Language-neutral contracts |

PowerShell is used for bootstrap/health/orchestration only.
Node.js is used for actual MCP server implementation and shared MCP utilities.

## Architecture

```text
runtime/
├── mcp/
│   ├── README.md           — MCP architecture documentation
│   ├── registry.json       — MCP server inventory (NOT OpenCode config)
│   └── lib/
│       ├── runtime-utils.js — Node.js shared MCP library
│       └── runtime-utils.ps1 — PowerShell bootstrap helpers
├── scripts/
│   ├── env/
│   │   └── load-env.ps1    — environment loader (Phase 5)
│   └── health/
│       └── check-runtime.ps1 — health check aggregation
├── ledger/                 — local runtime evidence (gitignored)
└── local-state/            — local runtime state (gitignored)
```

## Schemas (Language-Neutral Contracts)

| Schema | Purpose |
|---|---|
| `governance/schemas/result-envelope.json` | Structured result contract |
| `governance/schemas/error-taxonomy.json` | Error classification |
| `governance/schemas/execution-context.json` | Operation context contract |

These are the durable contracts. Runtime code in any language may consume them.

## Shared Runtime Library

### Node.js (`runtime/mcp/lib/runtime-utils.js`)

For use by repository-owned MCP servers:

| Function | Purpose |
|---|---|
| `New-RunId` | Generate portable, filename-safe unique identifier |
| `New-Result` | Construct structured result envelope |
| `Add-ResultWarning` | Append warning to result |
| `Add-ResultError` | Append categorized error to result |
| `Set-ResultStatus` | Update result status |
| `Test-ErrorCategory` | Validate error category against taxonomy |
| `Protect-Secrets` | Redact known secret patterns from diagnostic text |
| `Test-ProfileName` | Validate profile name format |
| `Test-OperationName` | Validate operation name format |
| `New-ExecutionContext` | Construct validated execution context |

## Result Envelope

Every runtime operation produces a structured result:

```json
{
  "ok": true,
  "operation": "example",
  "target": "example",
  "dry_run": false,
  "run_id": "uuid",
  "timestamp": "ISO-8601",
  "status": "ok",
  "summary": {},
  "warnings": [],
  "errors": [],
  "evidence": {},
  "rollback": null
}
```

## Error Taxonomy

| Category | Meaning |
|---|---|
| VALIDATION_ERROR | Input failed validation |
| CONFIG_ERROR | Missing/invalid configuration |
| AUTH_REQUIRED | Authentication needed |
| DEPENDENCY_UNAVAILABLE | Required dependency missing |
| PERMISSION_DENIED | Insufficient permissions |
| POLICY_BLOCKED | Blocked by governance policy |
| EXECUTION_ERROR | Operation failed |
| TIMEOUT | Time limit exceeded |
| INTERNAL_ERROR | Unexpected failure |

## Health Checks

Health checks distinguish three severity levels:

| Severity | Behavior when unavailable |
|---|---|
| CORE | System degraded, action required |
| OPTIONAL | Warning only, system continues |
| PLANNED | Expected absence, not a failure |

## Evidence & Ledger

- `runtime/ledger/` — local runtime evidence (operation summaries, dry-run evidence)
- `runtime/local-state/` — local runtime state (profile env files, locks, cache)
- Neither is Git-tracked
- Both are protected by `.gitignore`

## Oracle Deferral

Oracle database tools are deferred to Phase 7. This phase establishes the generic runtime architecture that Oracle will build upon.
