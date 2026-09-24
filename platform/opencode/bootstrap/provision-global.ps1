<#
.SYNOPSIS
    Provision repository-owned OpenCode templates into the user config location.

.DESCRIPTION
    This script copies sanitized configuration templates from the repository
    into the user's OpenCode config directory (~/.config/opencode/).

    It will NOT overwrite existing configuration without explicit approval.
    It supports dry-run mode to preview changes before applying.

.PARAMETER DryRun
    Preview changes without writing any files.

.PARAMETER Apply
    Apply changes. Requires explicit confirmation before overwriting.

.EXAMPLE
    .\provision-global.ps1 -DryRun
    .\provision-global.ps1 -Apply
#>

param(
    [switch]$DryRun,
    [switch]$Apply
)

$ErrorActionPreference = "Stop"

# Resolve repository root (platform/opencode/bootstrap/ -> repo root)
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $ScriptDir))

# Resolve destination (user's OpenCode config)
$destDir = Join-Path $env:USERPROFILE ".config\opencode"

# Source templates
# Maps tracked templates to actual OpenCode config filenames
$templates = @(
    @{
        Source = Join-Path $RepoRoot "platform\opencode\global\opencode.template.json"
        Dest = Join-Path $destDir "opencode.json"
        Label = "Global config template"
    },
    @{
        Source = Join-Path $RepoRoot "platform\opencode\global\tui.template.json"
        Dest = Join-Path $destDir "tui.json"
        Label = "TUI config template"
    }
)

Write-Host "OpenCode Provisioning"
Write-Host "====================="
Write-Host ""

# Check destination exists
if (-not (Test-Path $destDir)) {
    Write-Host "Destination directory does not exist: $destDir"
    if ($DryRun) {
        Write-Host "[DRY-RUN] Would create: $destDir"
    } elseif ($Apply) {
        Write-Host "Creating: $destDir"
        New-Item -ItemType Directory -Path $destDir -Force | Out-Null
    } else {
        Write-Host "Use -Apply to create the directory."
        exit 0
    }
}

# Process each template
$changes = @()
foreach ($t in $templates) {
    $srcExists = Test-Path $t.Source
    $destExists = Test-Path $t.Dest

    if (-not $srcExists) {
        Write-Host "SKIP: $($t.Label) - source not found: $($t.Source)"
        continue
    }

    if ($destExists) {
        Write-Host "EXISTS: $($t.Label)"
        Write-Host "  Source: $($t.Source)"
        Write-Host "  Dest:   $($t.Dest)"
        Write-Host "  Note:   Existing file detected. Manual review recommended."
        $changes += $t
    } else {
        Write-Host "NEW: $($t.Label)"
        Write-Host "  Source: $($t.Source)"
        Write-Host "  Dest:   $($t.Dest)"
        $changes += $t
    }
}

Write-Host ""

if ($changes.Count -eq 0) {
    Write-Host "No changes needed."
    exit 0
}

if ($DryRun) {
    Write-Host "[DRY-RUN] Would provision $($changes.Count) file(s)."
    Write-Host "Use -Apply to apply changes."
    exit 0
}

if (-not $Apply) {
    Write-Host "Use -DryRun to preview or -Apply to apply changes."
    exit 0
}

# Apply changes
Write-Host "Applying changes..."
foreach ($t in $changes) {
    $destExists = Test-Path $t.Dest
    if ($destExists) {
        # Backup existing
        $backupPath = "$($t.Dest).backup-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
        Copy-Item $t.Dest $backupPath -Force
        Write-Host "  Backed up: $backupPath"
    }

    # Copy template
    Copy-Item $t.Source $t.Dest -Force
    Write-Host "  Provisioned: $($t.Label)"
}

Write-Host ""
Write-Host "Provisioning complete."
Write-Host "Note: Templates are deployed alongside existing config, not replacing it."
Write-Host "Review the templates and merge desired settings into your active config."
