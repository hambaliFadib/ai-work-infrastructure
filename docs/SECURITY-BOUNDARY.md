# Security Boundary

This repository assumes public visibility.

## Required Invariants

- Zero real secrets.
- Zero client data.
- Zero personal memory.
- Zero auth state.
- Zero machine runtime state.

Credentials, runtime databases, browser profiles, session outputs, generated logs, ledgers, and local evidence are excluded from Git by policy and ignore rules.
