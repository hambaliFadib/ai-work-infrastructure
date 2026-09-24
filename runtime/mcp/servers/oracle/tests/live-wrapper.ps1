# Phase 8A live test wrapper
# Loads oracle-dev profile and runs Node.js connectivity test

$ErrorActionPreference = "SilentlyContinue"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..\..\..')).Path
$LoaderPath = Join-Path $RepoRoot "runtime\scripts\env\load-env.ps1"
$ContractPath = Join-Path $RepoRoot "governance\schemas\environment-contract.json"

# Load the profile
. $LoaderPath -Profile oracle-dev -ContractPath $ContractPath -Apply *>$null

# Verify loaded
$vars = @('ORACLE_USER','ORACLE_PASSWORD','ORACLE_CONNECTION_STRING','ORACLE_MODE','ORACLE_MAX_ROWS','ORACLE_SCHEMA_ALLOWLIST')
Write-Host "Profile loaded:"
foreach ($v in $vars) {
    $val = [Environment]::GetEnvironmentVariable($v, 'Process')
    Write-Host "  $v = $(if($val){'SET'}else{'UNSET'})"
}

# Run Node.js live test
Set-Location $RepoRoot
node .\runtime\mcp\servers\oracle\tests\live-test.js 2>&1
