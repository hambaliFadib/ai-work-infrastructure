<#
.SYNOPSIS
    Deterministic health evaluation tests for AI-Work-Infra runtime.
.DESCRIPTION
    Tests H1-H4 health evaluation logic using synthetic check arrays.
    Exit 0 = all pass, non-zero = any failure.
#>

$ErrorActionPreference = "Stop"
$passed = 0
$failed = 0

function Assert($condition, $label) {
    if ($condition) {
        $script:passed++
        Write-Host "$label : PASS"
    } else {
        $script:failed++
        Write-Host "$label : FAIL"
    }
}

# --- Health evaluator function (extracted from check-runtime.ps1 logic) ---
function Evaluate-Health {
    param($checks)
    $coreFailed = ($checks | Where-Object { $_.severity -eq "CORE" -and $_.status -ne "AVAILABLE" }).Count -gt 0
    $optFailed = ($checks | Where-Object { $_.severity -eq "OPTIONAL" -and $_.status -eq "UNAVAILABLE" }).Count -gt 0
    if ($coreFailed) {
        $overall = "UNHEALTHY"; $fatal = $true
    } elseif ($optFailed) {
        $overall = "DEGRADED"; $fatal = $false
    } else {
        $overall = "HEALTHY"; $fatal = $false
    }
    return @{ overall = $overall; fatal = $fatal; checks = $checks }
}

# --- H1: CORE healthy → HEALTHY ---
$h1Checks = @(
    @{ name = "test-core"; severity = "CORE"; status = "AVAILABLE" }
    @{ name = "test-opt"; severity = "OPTIONAL"; status = "NOT_CONFIGURED" }
    @{ name = "test-plan"; severity = "PLANNED"; status = "NOT_CONFIGURED" }
)
$h1 = Evaluate-Health $h1Checks
Assert ($h1.overall -eq "HEALTHY") "H1 overall"
Assert ($h1.fatal -eq $false) "H1 fatal"

# --- H2: CORE unavailable → UNHEALTHY + fatal=true ---
$h2Checks = @(
    @{ name = "test-core"; severity = "CORE"; status = "UNAVAILABLE" }
    @{ name = "test-opt"; severity = "OPTIONAL"; status = "AVAILABLE" }
)
$h2 = Evaluate-Health $h2Checks
Assert ($h2.overall -eq "UNHEALTHY") "H2 overall"
Assert ($h2.fatal -eq $true) "H2 fatal"

# --- H3: CORE available + OPTIONAL unavailable → DEGRADED (nonfatal) ---
$h3Checks = @(
    @{ name = "test-core"; severity = "CORE"; status = "AVAILABLE" }
    @{ name = "test-opt"; severity = "OPTIONAL"; status = "UNAVAILABLE" }
)
$h3 = Evaluate-Health $h3Checks
Assert ($h3.overall -eq "DEGRADED") "H3 overall"
Assert ($h3.fatal -eq $false) "H3 fatal"

# --- H4: CORE available + PLANNED unavailable → HEALTHY ---
$h4Checks = @(
    @{ name = "test-core"; severity = "CORE"; status = "AVAILABLE" }
    @{ name = "test-plan"; severity = "PLANNED"; status = "NOT_CONFIGURED" }
)
$h4 = Evaluate-Health $h4Checks
Assert ($h4.overall -eq "HEALTHY") "H4 overall"
Assert ($h4.fatal -eq $false) "H4 fatal"

# --- H5: CORE + OPTIONAL unavailable → UNHEALTHY (CORE dominates) ---
$h5Checks = @(
    @{ name = "test-core"; severity = "CORE"; status = "UNAVAILABLE" }
    @{ name = "test-opt"; severity = "OPTIONAL"; status = "UNAVAILABLE" }
)
$h5 = Evaluate-Health $h5Checks
Assert ($h5.overall -eq "UNHEALTHY") "H5 overall"
Assert ($h5.fatal -eq $true) "H5 fatal"

# --- H6: OPTIONAL + PLANNED unavailable → DEGRADED ---
$h6Checks = @(
    @{ name = "test-core"; severity = "CORE"; status = "AVAILABLE" }
    @{ name = "test-opt"; severity = "OPTIONAL"; status = "UNAVAILABLE" }
    @{ name = "test-plan"; severity = "PLANNED"; status = "NOT_CONFIGURED" }
)
$h6 = Evaluate-Health $h6Checks
Assert ($h6.overall -eq "DEGRADED") "H6 overall"
Assert ($h6.fatal -eq $false) "H6 fatal"

# --- Summary ---
Write-Host ""
Write-Host "Results: $passed passed, $failed failed"
exit $(if ($failed -gt 0) { 1 } else { 0 })
