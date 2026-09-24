# Architecture

The infrastructure is general-purpose and governance-first.

## Conceptual Layers

```text
OpenCode engine
      |
OpenCode control plane
      |
workspace infrastructure
      |
project/work boundary
```

## Scope Layers

- Machine-global: host-level configuration and bootstrap state.
- Sandbox/repository: versioned control-plane contracts and reusable infrastructure.
- Project/job: isolated work, runtime state, evidence, and outputs.

The OpenCode engine remains an upstream dependency. This repository owns the control-plane contracts and workspace infrastructure around it.

## Control Plane Ownership

The repository owns these configuration artifacts:

| Artifact | Location | Purpose |
|---|---|---|
| Version contract | `platform/opencode/VERSION` | Pins verified OpenCode version |
| Global config template | `platform/opencode/global/opencode.template.json` | Sanitized provider/MCP/permission definitions |
| TUI template | `platform/opencode/global/tui.template.json` | Theme and notification settings |
| Install script | `platform/opencode/bootstrap/install.ps1` | Detect and verify OpenCode installation |
| Provision script | `platform/opencode/bootstrap/provision-global.ps1` | Deploy templates to user config |

## Configuration Precedence

```text
GLOBAL    ~/.config/opencode/opencode.json    (machine-user-wide)
PROJECT   ./opencode.json                      (repository-specific)
```

**Tracked templates → active config mapping:**

| Tracked Template | Provisioned Active File |
|---|---|
| `platform/opencode/global/opencode.template.json` | `~/.config/opencode/opencode.json` |
| `platform/opencode/global/tui.template.json` | `~/.config/opencode/tui.json` |

Templates are tracked in the repository. The provision script deploys them to the correct active filenames.

**Ownership model:**

| Component | Ownership | Location |
|---|---|---|
| Providers / Models / MCP / Permissions / Plugins | Global (machine-wide) | `opencode.template.json` → provisioned to `opencode.json` |
| TUI theme / notifications | Global (machine-wide) | `tui.template.json` → provisioned to `tui.json` |
| Instructions | Project | `./opencode.json` |
| Default agent selection | Project | `./opencode.json` |
| Engineer agent definition | Project | `.opencode/agents/engineer.md` |

The global template does NOT contain `default_agent` — it is a project-level decision.

## Secret Boundary

Templates use `{env:VAR_NAME}` placeholders for secrets.
Actual secrets are never stored in the repository.
Secrets belong to manual configuration or future `.env` loading.

## Engine vs Control Plane

```text
OpenCode engine (upstream)
  - Binary/executable
  - Core runtime
  - TUI rendering
  - Session management

Control plane (this repository)
  - Version contract
  - Configuration templates
  - Permission policy
  - MCP declarations (without credentials)
  - Plugin declarations
  - Agent definitions
  - Provisioning logic
```
