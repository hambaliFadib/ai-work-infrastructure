# Environment & Secret Contract

## Overview

This infrastructure loads configuration and secrets from local `.env` sources predictably, without depending on persistent Windows environment variables and without leaking credentials between jobs/profiles.

## Precedence Model

For **managed variables**, the loading precedence is:

```
1. selected profile .env      highest
2. repository root .env
3. inherited process/Windows env
4. unset                      lowest
```

### Security Exception for PROFILE-Scoped Variables

When a profile is explicitly selected, stale inherited values for PROFILE-scoped variables are **discarded** before precedence is evaluated. This prevents credentials from a previous profile or job from leaking into the current session.

However, root `.env` remains a valid fallback — it is an explicit, repository-local configuration layer. Only inherited process state is considered stale.

```
PROFILE variable with profile selected:
  1. selected profile .env      (first-write wins)
  2. root .env                  (valid fallback)
  3. inherited process          CLEARED (stale — may belong to different profile)
  4. unset
```

This distinction is important:
- **Root `.env`** = explicit configuration → trusted fallback
- **Inherited process state** = potentially stale credential → discarded when profile is selected

## Files

| File | Purpose | Git-tracked |
|---|---|---|
| `.env.example` | Contract/names only, no real values | Yes |
| `.env` | Shared machine/user configuration | No (gitignored) |
| `runtime/local-state/env/<profile>.env` | Job/profile-specific configuration | No (gitignored) |
| `governance/schemas/environment-contract.json` | Variable metadata, scope, sensitivity | Yes |
| `runtime/scripts/env/load-env.ps1` | Safe .env loader with profile isolation | Yes |

## Usage

The loader must be **dot-sourced** to affect the calling shell's environment:

```powershell
# Dry-run (preview without changes, no env mutation)
. .\runtime\scripts\env\load-env.ps1 -DryRun

# Apply to current shell
. .\runtime\scripts\env\load-env.ps1 -Apply

# Load with profile isolation
. .\runtime\scripts\env\load-env.ps1 -Profile <name> -Apply
```

> **Important:** Running the script as a child process (`.\load-env.ps1`) will NOT
> modify the parent shell's environment. You MUST dot-source it (`. .\load-env.ps1`).
> The trusted loader script is dot-sourced. `.env` files themselves are parsed as
> data and are never dot-sourced or executed.

## Profile Isolation

Profile-scoped managed variables are cleared from process scope before loading the selected profile. This prevents credentials from one profile leaking into another.

## Security Rules

- `.env` files are NEVER dot-sourced or executed as code
- Secret values are NEVER printed in diagnostic output
- No persistent Windows environment variable changes
- Process-scope mutation only during explicit `-Apply`
- Duplicate keys in the same file cause safe failure
- Path traversal in profile names is rejected

## Migration Strategy

1. Define tracked variable contract (done)
2. Implement consumer against new source
3. Validate consumer against local `.env`
4. Migrate value manually into local-only `.env`
5. Test
6. Only then retire old Windows environment source

Phase 5 does NOT perform steps 4-6 for actual secrets.
