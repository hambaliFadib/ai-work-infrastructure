# OpenCode Bootstrap

This directory contains scripts for bootstrapping the OpenCode control plane.

## Scripts

### install.ps1

Detect and verify OpenCode installation against the version contract.

```powershell
.\platform\opencode\bootstrap\install.ps1
```

Reports: `MATCH`, `COMPATIBLE`, `MISMATCH`, or `NOT_INSTALLED`.

### provision-global.ps1

Provision repository-owned templates into the user's OpenCode config directory.

```powershell
# Preview changes
.\platform\opencode\bootstrap\provision-global.ps1 -DryRun

# Apply changes
.\platform\opencode\bootstrap\provision-global.ps1 -Apply
```

## Safety

- Dry-run makes zero writes
- Existing config is backed up before replacement
- Templates are deployed alongside existing config, not replacing it
- No secrets are ever copied
- No runtime state is touched
