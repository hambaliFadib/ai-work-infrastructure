# Runtime MCP Foundation

This directory contains the repository-owned MCP infrastructure layer.

## Structure

```text
runtime/mcp/
├── README.md           — this file
├── registry.json       — MCP server inventory and metadata
└── lib/
    ├── runtime-utils.js  — Node.js shared MCP library (for MCP servers)
    └── runtime-utils.ps1 — PowerShell bootstrap helpers (for health/orchestration)
```

## Design Principles

- **Fail closed** — unknown states default to restricted behavior
- **No silent destructive action** — all writes require explicit approval
- **No implicit environment target** — operation must specify target
- **No client assumptions** — generic, project-neutral
- **No hardcoded machine paths** — resolve dynamically
- **No credential logging** — redact secrets in diagnostics
- **Explicit dry-run** — preview before apply
- **Bounded outputs** — no unbounded data dumps
- **Auditable result shape** — structured evidence envelopes

## MCP Registry

`registry.json` is an infrastructure inventory, NOT an OpenCode configuration replacement.

It catalogs:
- Repository-owned MCP implementations
- External MCP dependencies
- Planned/future MCP servers
- Health check metadata

It does NOT contain:
- Credentials
- Secrets
- Runtime state
- OpenCode-specific configuration

## Classification

| Classification | Meaning |
|---|---|
| REPOSITORY_OWNED | Built and maintained in this repository |
| EXTERNAL_LOCAL | External tool, runs locally via npx/node |
| EXTERNAL_REMOTE | External service, accessed via network |
| OPTIONAL | May be offline without system failure |
| PLANNED | Documented but not yet implemented |

## Adding a New MCP

1. Add entry to `registry.json` with classification
2. Implement in `servers/<name>/` if REPOSITORY_OWNED
3. Add health check if CORE
4. Update this README
