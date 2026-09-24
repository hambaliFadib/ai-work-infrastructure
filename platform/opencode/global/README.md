# OpenCode Global Control Plane

Sanitized source-of-truth templates for machine-global OpenCode configuration.

## Contents

| File | Purpose |
|---|---|
| `opencode.template.json` | Global config template (providers, models, MCP, permissions, plugins) |
| `tui.template.json` | TUI/CLI settings template (theme, notifications) |

## What this directory IS

- Repository-owned, Git-tracked configuration templates
- Sanitized: zero secrets, zero credentials, zero personal paths
- Portable: resolves dynamically, no hardcoded machine paths
- Contract-based: MCP secrets use `{env:VAR_NAME}` placeholders

## What this directory is NOT

- Not the active user configuration
- Not a replacement for `~/.config/opencode/opencode.json`
- Not a credential store
- Not a runtime state store

## Provisioning

Use `../bootstrap/provision-global.ps1` to deploy templates to the user config directory.

Templates are deployed alongside existing config, not replacing it. Manual merge is expected.

## Secret boundary

Templates may reference environment variables via `{env:VAR_NAME}` syntax.
Templates must never contain actual secret values.
Actual secrets belong to `.env` loading or manual configuration.
