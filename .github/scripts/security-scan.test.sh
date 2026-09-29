#!/usr/bin/env bash
# security-scan.test.sh — deterministic fail-closed controls for security-scan.sh.
#
# Runs against temporary isolated Git repositories only. Never mutates the actual
# repository. No network. No env/profile reads. No secret reads.
#
# Exit 0 only when all tests pass (6/6).

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCANNER="$SCRIPT_DIR/security-scan.sh"

WORK_ROOT="$(mktemp -d)"
trap 'rm -rf "$WORK_ROOT"' EXIT

passed=0
failed=0

pass() { echo "$1 PASS"; passed=$((passed + 1)); }
fail() { echo "$1 FAIL: $2"; failed=$((failed + 1)); }

make_repo() {
  mkdir -p "$1"
  git -C "$1" init -q
}

track_file() {
  # $1 = repo, $2 = relative path, $3 = content
  mkdir -p "$(dirname "$1/$2")"
  printf '%s\n' "$3" > "$1/$2"
  git -C "$1" add -- "$2"
}

scanner_out=""
scanner_rc=0

run_scanner() {
  # $1 = repo dir; sets scanner_rc and scanner_out
  if scanner_out="$(bash "$SCANNER" "$1" 2>&1)"; then
    scanner_rc=0
  else
    scanner_rc=$?
  fi
}

echo '=== Security Scan Tests ==='
echo ''

# SEC01 — clean repository passes
repo="$WORK_ROOT/sec01"
make_repo "$repo"
track_file "$repo" "safe.txt" "hello world"
run_scanner "$repo"
if [ "$scanner_rc" -eq 0 ]; then
  pass SEC01
else
  fail SEC01 "scanner rejected a clean repository: $scanner_out"
fi

# SEC02 — private-key marker rejects (marker constructed dynamically)
repo="$WORK_ROOT/sec02"
make_repo "$repo"
marker="$(printf 'BEGIN %s PRIVATE KEY' 'RSA')"
track_file "$repo" "leak.txt" "$marker"
run_scanner "$repo"
if [ "$scanner_rc" -eq 0 ]; then
  fail SEC02 "scanner accepted prohibited private-key marker"
else
  pass SEC02
fi

# SEC03 — machine-specific path rejects (path constructed dynamically)
repo="$WORK_ROOT/sec03"
make_repo "$repo"
mpath="$(printf 'D:\\%s' 'AI-Work-Infra')"
track_file "$repo" "leak.txt" "$mpath"
run_scanner "$repo"
if [ "$scanner_rc" -eq 0 ]; then
  fail SEC03 "scanner accepted prohibited machine-specific path"
else
  pass SEC03
fi

# SEC04 — tracked .env filename rejects (synthetic content)
repo="$WORK_ROOT/sec04"
make_repo "$repo"
track_file "$repo" ".env" "SYNTHETIC=placeholder-value"
run_scanner "$repo"
if [ "$scanner_rc" -eq 0 ]; then
  fail SEC04 "scanner accepted a tracked .env filename"
else
  pass SEC04
fi

# SEC05 — scanner operational error fails closed
notgit="$WORK_ROOT/sec05-notgit"
mkdir -p "$notgit"
run_scanner "$notgit"
if [ "$scanner_rc" -eq 0 ]; then
  fail SEC05 "scanner treated an operational failure as a clean result"
else
  pass SEC05
fi

# SEC06 — categories are independent (original defect regression proof)
repo_a="$WORK_ROOT/sec06-content"
make_repo "$repo_a"
marker="$(printf 'BEGIN %s PRIVATE KEY' 'EC')"
track_file "$repo_a" "safe.txt" "$marker"
repo_b="$WORK_ROOT/sec06-filename"
make_repo "$repo_b"
track_file "$repo_b" "secrets" "safe synthetic content"
sec06_ok=1
run_scanner "$repo_a"
if [ "$scanner_rc" -eq 0 ]; then sec06_ok=0; fi
run_scanner "$repo_b"
if [ "$scanner_rc" -eq 0 ]; then sec06_ok=0; fi
if [ "$sec06_ok" -eq 1 ]; then
  pass SEC06
else
  fail SEC06 "content violation and/or prohibited filename did not fail independently"
fi

echo ''
echo "Passed: $passed"
echo "Failed: $failed"

if [ "$failed" -ne 0 ]; then
  exit 1
fi
exit 0
