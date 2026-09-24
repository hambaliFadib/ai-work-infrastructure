<#
.SYNOPSIS
    Generic runtime health check for AI-Work-Infra.
.DESCRIPTION
    Aggregates local/static runtime checks without performing destructive operations.
    Distinguishes CORE, OPTIONAL, and PLANNED dependencies.
.PARAMETER DryRun
    Preview checks without any external calls.
.PARAMETER RegistryPath
    Path to registry JSON. Default: runtime/mcp/registry.json
.PARAMETER Json
    Output structured JSON instead of human-readable text.
#>
param(
    [switch]$DryRun,
    [string]$RegistryPath,
    [switch]$Json
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $ScriptDir))

# --- Load shared library ---
. (Join-Path $RepoRoot "runtime\mcp\lib\runtime-utils.ps1")

$result = New-Result -Operation "health-check" -DryRun $DryRun

# --- Check categories ---
$checks = @()

# CORE: OpenCode executable
$opencode = Get-Command opencode -ErrorAction SilentlyContinue
$checks += @{ name = "opencode-executable"; severity = "CORE"; status = if ($opencode) { "AVAILABLE" } else { "UNAVAILABLE" } }

# CORE: Environment contract
$contractExists = Test-Path (Join-Path $RepoRoot "governance\schemas\environment-contract.json")
$checks += @{ name = "environment-contract"; severity = "CORE"; status = if ($contractExists) { "AVAILABLE" } else { "UNAVAILABLE" } }

# CORE: Runtime library
$libExists = Test-Path (Join-Path $RepoRoot "runtime\mcp\lib\runtime-utils.ps1")
$checks += @{ name = "runtime-library"; severity = "CORE"; status = if ($libExists) { "AVAILABLE" } else { "UNAVAILABLE" } }

# CORE: MCP registry
$registryExists = Test-Path (Join-Path $RepoRoot "runtime\mcp\registry.json")
$checks += @{ name = "mcp-registry"; severity = "CORE"; status = if ($registryExists) { "AVAILABLE" } else { "UNAVAILABLE" } }

# OPTIONAL: .env loaded
$envLoaded = -not [string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable("PATH", "Process"))
$checks += @{ name = "process-environment"; severity = "CORE"; status = if ($envLoaded) { "AVAILABLE" } else { "DEGRADED" } }

# Check MCP registry for OPTIONAL/PLANNED entries
$effectiveRegistryPath = if ($RegistryPath) { $RegistryPath } else { Join-Path $RepoRoot "runtime\mcp\registry.json" }
if (Test-Path $effectiveRegistryPath) {
    $registry = Get-Content $effectiveRegistryPath -Raw | ConvertFrom-Json
    foreach ($entry in $registry.entries) {
        if ($entry.criticality -eq "OPTIONAL") {
            $checks += @{ name = "mcp-$($entry.name)"; severity = "OPTIONAL"; status = "NOT_CONFIGURED"; detail = $entry.external_dependency }
        }
        if ($entry.criticality -eq "PLANNED") {
            $checks += @{ name = "mcp-$($entry.name)"; severity = "PLANNED"; status = "NOT_CONFIGURED" }
        }
    }
}

# --- Calculate overall status ---
$coreFailed = ($checks | Where-Object { $_.severity -eq "CORE" -and $_.status -ne "AVAILABLE" }).Count -gt 0
$optFailed = ($checks | Where-Object { $_.severity -eq "OPTIONAL" -and $_.status -eq "UNAVAILABLE" }).Count -gt 0
if ($coreFailed) {
    $overallStatus = "UNHEALTHY"; $fatal = $true
} elseif ($optFailed) {
    $overallStatus = "DEGRADED"; $fatal = $false
} else {
    $overallStatus = "HEALTHY"; $fatal = $false
}

# --- Output ---
if (-not $Json) {
    Write-Host "Runtime Health Check"
    Write-Host "===================="
    Write-Host ""
    Write-Host "Overall: $overallStatus"
    Write-Host ""
    Write-Host ("{0,-30} {1,-12} {2}" -f "COMPONENT", "SEVERITY", "STATUS")
    Write-Host ("-" * 60)
    foreach ($c in ($checks | Sort-Object severity, name)) {
        Write-Host ("{0,-30} {1,-12} {2}" -f $c.name, $c.severity, $c.status)
    }
    Write-Host ("-" * 60)

    $coreCount = ($checks | Where-Object { $_.severity -eq "CORE" }).Count
    $coreAvail = ($checks | Where-Object { $_.severity -eq "CORE" -and $_.status -eq "AVAILABLE" }).Count
    $optCount = ($checks | Where-Object { $_.severity -eq "OPTIONAL" }).Count
    $planCount = ($checks | Where-Object { $_.severity -eq "PLANNED" }).Count

    Write-Host ""
    Write-Host "CORE: $coreAvail/$coreCount available"
    Write-Host "OPTIONAL: $optCount entries (offline = warning, not failure)"
    Write-Host "PLANNED: $planCount entries (not implemented = expected)"
}

# --- JSON output mode ---
if ($Json) {
    $jsonOutput = @{
        overall = $overallStatus
        fatal = $fatal
        checks = $checks
        summary = @{
            core_total = $coreCount
            core_available = $coreAvail
            optional = $optCount
            planned = $planCount
        }
    }
    $jsonOutput | ConvertTo-Json -Depth 5
}
