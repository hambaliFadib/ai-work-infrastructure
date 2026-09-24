# Oracle Safe Core

## Status

- Oracle core: VERIFIED
- `node-oracledb`: PROVISIONED / VERIFIED
- MCP stdio: VERIFIED
- M01–M08: PASS
- Live read: VERIFIED
- Live write: DISABLED

The module provides governance-first, structured Oracle access through the repository-owned MCP server. The current environment has validated read-only connectivity using the fixed `SELECT 1 FROM DUAL` probe.

## Architecture

```text
OpenCode → Oracle MCP stdio → tool handler → policy
→ structured query builder → bind parameters → Oracle adapter
→ node-oracledb → Oracle DB
```

The authoritative stdio entrypoint is `mcp-server.js`. Startup registers tools and does not connect to Oracle.

## Tool surface

| Tool | Status | Purpose |
|---|---|---|
| `oracle_health` | allowed | Profile readiness and health |
| `oracle_read` | allowed | Bounded structured SELECT |
| `oracle_insert` | live blocked | Structured INSERT; dry-run default |
| `oracle_update` | live blocked | Structured UPDATE; WHERE required |
| `oracle_ddl` | live blocked | Bounded DDL actions |

Absent by design: `oracle_delete`, `oracle_raw_sql`, `oracle_execute_sql`, and `run_sql`.

## Safety rules

- Explicit profile required; no default database profile.
- Schema allowlist and row limits are enforced.
- Identifiers are validated and values use bind parameters.
- Live INSERT, UPDATE, and DDL are blocked before adapter/database execution.
- Dry-run defaults to true and commit defaults to false.
- Oracle DDL has no universal rollback guarantee.

## Environment contract

Oracle uses PROFILE-scoped variables: `ORACLE_USER`, `ORACLE_PASSWORD`, `ORACLE_CONNECTION_STRING`, `ORACLE_CLIENT_DIR`, `ORACLE_MODE`, `ORACLE_MAX_ROWS`, and `ORACLE_SCHEMA_ALLOWLIST`. Secret values and machine-specific client paths are never documented here; `ORACLE_CLIENT_DIR` is the configuration concept.

## Evidence

The core suite, Phase 7A, Phase 7B, and the MCP M01–M08 binding suite pass. The final smoke validation connects, runs only `SELECT 1 FROM DUAL`, and closes without writes, commits, or DDL.

## Tests

```text
node runtime/mcp/servers/oracle/tests/oracle.test.js
node runtime/mcp/servers/oracle/tests/phase7a.test.js
node runtime/mcp/servers/oracle/tests/phase7b.test.js
node runtime/mcp/servers/oracle/tests/mcp-binding.test.js
```
