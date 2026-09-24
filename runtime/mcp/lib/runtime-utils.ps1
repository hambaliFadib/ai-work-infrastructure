<#
.SYNOPSIS
    Shared runtime utilities for AI-Work-Infra.
.DESCRIPTION
    Provides result envelope construction, error handling, run ID generation,
    redaction, validation, and execution context management.
#>

# --- Run ID Generator ---
function New-RunId {
    <# Generate a portable, filename-safe unique run identifier. #>
    return [guid]::NewGuid().ToString("N")
}

# --- Result Envelope ---
function New-Result {
    param(
        [string]$Operation,
        [string]$Target = "",
        [bool]$DryRun = $false,
        [string]$RunId = "",
        [string]$Profile = "",
        [string]$Environment = "",
        [string]$Status = "ok"
    )
    if (-not $RunId) { $RunId = New-RunId }
    return @{
        ok = ($Status -eq "ok")
        operation = $Operation
        target = $Target
        dry_run = $DryRun
        run_id = $RunId
        timestamp = (Get-Date -Format "o")
        profile = $Profile
        environment = $Environment
        status = $Status
        summary = @{}
        warnings = @()
        errors = @()
        evidence = @{}
        rollback = $null
    }
}

function Add-ResultWarning {
    param([hashtable]$Result, [string]$Message)
    $Result.warnings += $Message
}

function Add-ResultError {
    param([hashtable]$Result, [string]$Category, [string]$Message)
    $Result.errors += @{ category = $Category; message = $Message }
    $Result.ok = $false
    $Result.status = "error"
}

function Set-ResultStatus {
    param([hashtable]$Result, [string]$Status)
    $Result.status = $Status
    $Result.ok = ($Status -eq "ok")
}

# --- Error Taxonomy ---
$script:ValidErrorCategories = @(
    "VALIDATION_ERROR", "CONFIG_ERROR", "AUTH_REQUIRED",
    "DEPENDENCY_UNAVAILABLE", "PERMISSION_DENIED", "POLICY_BLOCKED",
    "EXECUTION_ERROR", "TIMEOUT", "INTERNAL_ERROR"
)

function Test-ErrorCategory {
    param([string]$Category)
    return $script:ValidErrorCategories -contains $Category
}

# --- Redaction ---
$script:RedactPatterns = @(
    '(?i)(password|passwd|pwd)\s*[=:]\s*\S+',
    '(?i)(token|secret|apikey|api_key|authorization|credential)\s*[=:]\s*\S+',
    '(?i)Bearer\s+\S+',
    '(?i)Basic\s+\S+'
)

function Protect-Secrets {
    param([string]$Text)
    $result = $Text
    foreach ($pat in $script:RedactPatterns) {
        $result = [regex]::Replace($result, $pat, { param($m) $m.Value -replace '\S+$', '***' })
    }
    return $result
}

# --- Validation ---
function Test-ProfileName {
    param([string]$Name)
    if ([string]::IsNullOrWhiteSpace($Name)) { return $true }
    return $Name -match '^[A-Za-z0-9][A-Za-z0-9._-]*$' -and
           $Name -notmatch '\.\.' -and
           $Name -notmatch '[/\\]' -and
           $Name -notmatch '^[A-Za-z]:'
}

function Test-OperationName {
    param([string]$Name)
    return $Name -match '^[A-Za-z][A-Za-z0-9_-]*$'
}

# --- Execution Context ---
function New-ExecutionContext {
    param(
        [string]$Operation,
        [string]$Profile = "",
        [string]$Environment = "",
        [bool]$DryRun = $false,
        [string]$CorrelationId = ""
    )
    if (-not (Test-OperationName $Operation)) {
        throw "Invalid operation name: '$Operation'"
    }
    if ($Profile -and -not (Test-ProfileName $Profile)) {
        throw "Invalid profile name: '$Profile'"
    }
    return @{
        run_id = New-RunId
        operation = $Operation
        timestamp = (Get-Date -Format "o")
        profile = $Profile
        environment = $Environment
        dry_run = $DryRun
        correlation_id = $CorrelationId
    }
}
