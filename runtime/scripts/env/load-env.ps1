<#
.SYNOPSIS
    Safe .env loader with profile isolation support.

.DESCRIPTION
    Loads environment variables from .env files with a clear precedence model:
    profile > root .env > inherited Windows/process environment.

    This script is DATA-DRIVEN, not code-execution. It parses .env files as data
    and sets process-scope environment variables only.

    The .env file itself is NEVER dot-sourced or executed as code.

.PARAMETER Profile
    Load a profile-specific .env from runtime/local-state/env/<profile>.env.

.PARAMETER DryRun
    Parse and validate without modifying process environment.

.PARAMETER Apply
    Apply loaded variables to the current process environment.

.PARAMETER ShowAll
    Show all variables including inherited ones.

.EXAMPLE
    . .\load-env.ps1 -DryRun
    . .\load-env.ps1 -Apply
    . .\load-env.ps1 -Profile myproject -Apply
#>

param(
    [string]$Profile,
    [string]$ContractPath,
    [switch]$DryRun,
    [switch]$Apply,
    [switch]$ShowAll
)

$ErrorActionPreference = "Stop"

# --- Resolve paths ---
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $ScriptDir))
$RootEnvFile = Join-Path $RepoRoot ".env"
$ContractFile = Join-Path $RepoRoot "governance\schemas\environment-contract.json"
$ProfileDir = Join-Path $RepoRoot "runtime\local-state\env"

# --- Profile name validation ---
function Test-ProfileName {
    param([string]$Name)
    if ([string]::IsNullOrWhiteSpace($Name)) { return $true }
    return $Name -match '^[A-Za-z0-9][A-Za-z0-9._-]*$' -and
           $Name -notmatch '\.\.' -and
           $Name -notmatch '[/\\]' -and
           $Name -notmatch '^[A-Za-z]:'
}

# --- Safe .env parser (FAIL_CLOSED semantics) ---
function Parse-EnvFile {
    param([string]$FilePath)

    if (-not (Test-Path $FilePath)) { return @{} }

    $vars = @{}
    $lineNum = 0
    $errors = @()

    foreach ($line in Get-Content $FilePath -Encoding UTF8) {
        $lineNum++
        $line = $line.Trim()

        # Skip blank lines and comments
        if ([string]::IsNullOrWhiteSpace($line) -or $line.StartsWith('#')) { continue }

        # Parse KEY=value
        if ($line -match '^([A-Za-z_][A-Za-z0-9_]*)=(.*)$') {
            $key = $Matches[1]
            $value = $Matches[2].Trim()

            # Strip quotes
            if (($value.StartsWith('"') -and $value.EndsWith('"')) -or
                ($value.StartsWith("'") -and $value.EndsWith("'"))) {
                $value = $value.Substring(1, $value.Length - 2)
            }

            if ($vars.ContainsKey($key)) {
                $errors += "Duplicate key: $key"
            } else {
                $vars[$key] = $value
            }
        } else {
            $errors += "Malformed line $lineNum"
        }
    }

    if ($errors.Count -gt 0) {
        Write-Error "Parse failure in $FilePath`: $($errors -join '; ')"
        return $null
    }

    return $vars
}

# --- Load contract ---
$contract = @{}
$effectiveContractPath = if ($ContractPath) { $ContractPath } else { $ContractFile }
if (Test-Path $effectiveContractPath) {
    $contract = Get-Content $effectiveContractPath -Raw | ConvertFrom-Json
}

# --- Validate profile ---
if ($Profile -and -not (Test-ProfileName $Profile)) {
    Write-Error "Invalid profile name: '$Profile'. Must match ^[A-Za-z0-9][A-Za-z0-9._-]*$ and must not contain path separators or absolute paths."
    exit 1
}

# --- Validate contract path ---
if ($ContractPath -and -not (Test-Path $ContractPath)) {
    Write-Error "Contract path not found: $ContractPath"
    exit 1
}

# --- Determine files to load (profile > root precedence) ---
$files = @()
if ($Profile) {
    $profileFile = Join-Path $ProfileDir "$Profile.env"
    $files += @{ Path = $profileFile; Label = "profile" }
}
$files += @{ Path = $RootEnvFile; Label = "root" }

# --- Load variables (profile wins over root via first-write-wins) ---
# Separate GLOBAL and PROFILE scoped variables for proper isolation
$loadedGlobal = @{}
$sourceMapGlobal = @{}
$loadedProfile = @{}
$sourceMapProfile = @{}

foreach ($f in $files) {
    if (-not (Test-Path $f.Path)) {
        if ($f.Label -eq "profile") {
            Write-Error "Profile file not found: $($f.Path)"
            exit 1
        }
        continue
    }

    $parsed = Parse-EnvFile -FilePath $f.Path
    if ($null -eq $parsed) {
        # FAIL_CLOSED: malformed or duplicate in file → abort entire load
        exit 1
    }
    foreach ($key in $parsed.Keys) {
        # Check if this variable is PROFILE-scoped in the contract
        $isProfileScoped = $false
        if ($contract.variables) {
            foreach ($v in $contract.variables) {
                if ($v.name -eq $key -and $v.scope -eq "PROFILE") {
                    $isProfileScoped = $true
                    break
                }
            }
        }

        if ($isProfileScoped) {
            # PROFILE variables: first-write wins (profile > root)
            # Root is a valid fallback; inherited is NOT (cleared separately)
            if (-not $loadedProfile.ContainsKey($key)) {
                $loadedProfile[$key] = $parsed[$key]
                $sourceMapProfile[$key] = $f.Label
            }
        } else {
            # GLOBAL variables: first-write wins (profile > root)
            if (-not $loadedGlobal.ContainsKey($key)) {
                $loadedGlobal[$key] = $parsed[$key]
                $sourceMapGlobal[$key] = $f.Label
            }
        }
    }
}

# Merge for output (PROFILE + GLOBAL)
$loaded = @{}
$sourceMap = @{}
foreach ($key in $loadedGlobal.Keys) { $loaded[$key] = $loadedGlobal[$key]; $sourceMap[$key] = $sourceMapGlobal[$key] }
foreach ($key in $loadedProfile.Keys) { $loaded[$key] = $loadedProfile[$key]; $sourceMap[$key] = $sourceMapProfile[$key] }

# --- Identify profile-scoped managed variables ---
$profileManagedVars = @()
if ($contract.variables) {
    foreach ($v in $contract.variables) {
        if ($v.scope -eq "PROFILE") {
            $profileManagedVars += $v.name
        }
    }
}

# --- Determine current state ---
$inherited = @{}
foreach ($key in $loaded.Keys) {
    $inherited[$key] = [Environment]::GetEnvironmentVariable($key, "Process")
}

# --- Output ---
Write-Host "Environment Loading"
Write-Host "==================="
Write-Host ""

if ($Profile) {
    Write-Host "Profile: $Profile"
    Write-Host "Profile dir: $ProfileDir"
    Write-Host ""
}

Write-Host "Variable Status:"
Write-Host ("-" * 60)
Write-Host ("{0,-40} {1,-12} {2}" -f "VARIABLE", "SOURCE", "STATUS")
Write-Host ("-" * 60)

$allKeys = @()
$allKeys += $loaded.Keys
if ($ShowAll) {
    foreach ($key in $inherited.Keys) {
        if (-not $allKeys.Contains($key)) { $allKeys += $key }
    }
}

foreach ($key in ($allKeys | Sort-Object)) {
    $source = if ($sourceMap.ContainsKey($key)) { $sourceMap[$key] } else { "inherited" }
    $status = if ($loaded.ContainsKey($key)) { "SET" } elseif ($inherited.ContainsKey($key) -and $inherited[$key]) { "SET" } else { "UNSET" }

    # Check contract sensitivity
    $isSecret = $false
    if ($contract.variables) {
        foreach ($v in $contract.variables) {
            if ($v.name -eq $key -and $v.sensitivity -in @("SECRET", "CREDENTIAL_PATH")) {
                $isSecret = $true
            }
        }
    }

    $displayValue = if ($isSecret) { "***" } else { $status }
    Write-Host ("{0,-40} {1,-12} {2}" -f $key, $source, $status)
}

Write-Host ("-" * 60)
Write-Host ""

# --- Check required variables ---
if ($contract.variables) {
    $missing = @()
    foreach ($v in $contract.variables) {
        if ($v.required -and -not $loaded.ContainsKey($v.name)) {
            $missing += $v.name
        }
    }
    if ($missing.Count -gt 0) {
        Write-Warning "Missing required variables: $($missing -join ', ')"
    }
}

# --- Dry-run mode ---
if ($DryRun) {
    Write-Host "[DRY-RUN] No process environment changes made."
    exit 0
}

# --- Apply mode ---
if (-not $Apply) {
    Write-Host "Use -DryRun to preview or -Apply to apply changes."
    exit 0
}

# --- Clear profile-scoped managed variables first ---
foreach ($varName in $profileManagedVars) {
    [Environment]::SetEnvironmentVariable($varName, $null, "Process")
}

# --- Apply loaded variables to process ---
foreach ($key in $loaded.Keys) {
    [Environment]::SetEnvironmentVariable($key, $loaded[$key], "Process")
}

Write-Host "[APPLY] $($loaded.Count) variable(s) applied to process environment."
Write-Host "Note: Changes are process-scoped only. No persistent User/Machine environment changes."
