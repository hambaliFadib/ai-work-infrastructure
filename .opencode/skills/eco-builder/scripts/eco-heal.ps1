# Eco-Heal wrapper - runs the python doctor.
# Usage:
#   eco-heal.ps1              -> diagnose (safe anytime)
#   eco-heal.ps1 -Mode heal   -> wait for desktop close, backup, repair
#   eco-heal.ps1 -Mode auto   -> scheduled task entry point
param(
    [ValidateSet("diagnose", "heal", "auto")]
    [string]$Mode = "diagnose"
)

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$py = "python"
if (-not (Get-Command $py -ErrorAction SilentlyContinue)) {
    Write-Host "Python not found in PATH. Please install Python or add it to PATH."
    exit 1
}

& $py (Join-Path $scriptDir "eco-heal.py") --mode $Mode
