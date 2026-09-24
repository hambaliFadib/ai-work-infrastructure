<#
.SYNOPSIS
    Detect and verify OpenCode installation against the version contract.

.DESCRIPTION
    This script checks whether OpenCode is installed and compatible with
    the version contract defined in platform/opencode/VERSION.

    It does NOT install or upgrade OpenCode. It only reports status.

.PARAMETER ExpectedVersion
    The expected OpenCode version string. If not provided, reads from
    platform/opencode/VERSION.

.EXAMPLE
    .\install.ps1
    .\install.ps1 -ExpectedVersion "1.18.32"
#>

param(
    [string]$ExpectedVersion
)

$ErrorActionPreference = "Stop"

# Resolve repository root (platform/opencode/bootstrap/ -> repo root)
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $ScriptDir))

# Read version contract if not provided
if (-not $ExpectedVersion) {
    $versionFile = Join-Path $RepoRoot "platform\opencode\VERSION"
    if (Test-Path $versionFile) {
        $content = Get-Content $versionFile -Raw
        if ($content -match "OPENCODE_VERSION=(.+)") {
            $ExpectedVersion = $Matches[1].Trim()
        }
    }
}

# Detect OpenCode
$opencode = Get-Command opencode -ErrorAction SilentlyContinue
if (-not $opencode) {
    Write-Host "STATUS: NOT_INSTALLED"
    Write-Host "OpenCode is not installed or not in PATH."
    Write-Host "To install, visit: https://opencode.ai"
    exit 1
}

# Get installed version
$installedVersion = & opencode --version 2>&1
$installedVersion = $installedVersion.Trim()

# Compare versions
if ($installedVersion -eq $ExpectedVersion) {
    Write-Host "STATUS: MATCH"
    Write-Host "Installed: $installedVersion"
    Write-Host "Expected:  $ExpectedVersion"
} elseif ($installedVersion -match "^$([regex]::Escape($ExpectedVersion.Split('.')[0..1] -join '.'))") {
    Write-Host "STATUS: COMPATIBLE"
    Write-Host "Installed: $installedVersion"
    Write-Host "Expected:  $ExpectedVersion"
    Write-Host "Note: Minor version difference. Should be compatible."
} else {
    Write-Host "STATUS: MISMATCH"
    Write-Host "Installed: $installedVersion"
    Write-Host "Expected:  $ExpectedVersion"
    Write-Host "Note: Major version difference. Manual review recommended."
}

# Report paths
Write-Host ""
Write-Host "OpenCode Paths:"
$paths = & opencode debug paths 2>&1
$paths | ForEach-Object { Write-Host "  $_" }
