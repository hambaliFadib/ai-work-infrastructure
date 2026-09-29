#!/usr/bin/env bash
# security-scan.sh — fail-closed prohibited tracked content and filename scan.
#
# Contract:
#   exit 0    = all security rules executed successfully AND no prohibited tracked state found
#   exit != 0 = prohibited state found OR any scanner rule could not execute reliably
#
# Usage: bash .github/scripts/security-scan.sh [repo-dir]
#   repo-dir defaults to the current directory.
#
# No network. No env/profile reads. No secret reads. No repository mutation.
# Uses explicit result handling only; never relies on shell `!` negation.

set -Eeuo pipefail

REPO_DIR="${1:-.}"

if ! cd "$REPO_DIR" 2>/dev/null; then
  echo "security-scan: cannot enter repository directory: $REPO_DIR" >&2
  exit 2
fi

if [ "$(git rev-parse --is-inside-work-tree 2>/dev/null)" != "true" ]; then
  echo "security-scan: not a git work tree: $REPO_DIR" >&2
  exit 2
fi

# --- Rule 1: prohibited tracked content -------------------------------------
CONTENT_PATTERN='BEGIN (RSA|OPENSSH|EC) PRIVATE KEY|D:\\AI-Work-Infra|D:\\Sandbox AI|C:\\Users\\'

if content_matches="$(git grep -nE "$CONTENT_PATTERN" -- ':!runtime/mcp/servers/oracle/node_modules/**' 2>&1)"; then
  printf '%s\n' "$content_matches" >&2
  echo "security-scan: prohibited tracked content found" >&2
  exit 1
else
  content_rc=$?
  if [ "$content_rc" -ne 1 ]; then
    printf '%s\n' "$content_matches" >&2
    echo "security-scan: content scan failed with rc=$content_rc" >&2
    exit "$content_rc"
  fi
fi

# --- Rule 2: prohibited tracked filenames -----------------------------------
if tracked_files="$(git ls-files 2>&1)"; then
  true
else
  ls_rc=$?
  printf '%s\n' "$tracked_files" >&2
  echo "security-scan: git ls-files failed with rc=$ls_rc" >&2
  exit "$ls_rc"
fi

if filename_matches="$(printf '%s\n' "$tracked_files" | grep -E '(^|/)(\.env|.*\.pem|.*\.key|credentials|secrets)(/|$)' 2>&1)"; then
  printf '%s\n' "$filename_matches" >&2
  echo "security-scan: prohibited tracked filename found" >&2
  exit 1
else
  filename_rc=$?
  if [ "$filename_rc" -ne 1 ]; then
    printf '%s\n' "$filename_matches" >&2
    echo "security-scan: filename scan failed with rc=$filename_rc" >&2
    exit "$filename_rc"
  fi
fi

echo "security-scan: PASS (no prohibited tracked content; no prohibited tracked filenames)"
exit 0
