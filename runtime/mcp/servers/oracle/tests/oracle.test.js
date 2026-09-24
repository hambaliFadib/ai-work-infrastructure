/**
 * Oracle MCP Test Suite — deterministic tests for policy, read, insert,
 * update, delete, DDL, evidence, and health.
 * No network. No database. No real credentials.
 */

const path = require('path');
const assert = require('assert');

const policy = require('../core/policy');
const identifiers = require('../core/identifiers');
const queryBuilder = require('../core/query-builder');
const transaction = require('../core/transaction');
const evidence = require('../core/evidence');
const { SyntheticAdapter } = require('../core/oracle-adapter');
const server = require('../server');

let passed = 0;
let failed = 0;
function test(label, fn) {
  try { fn(); passed++; console.log(`${label}: PASS`); }
  catch (e) { failed++; console.log(`${label}: FAIL — ${e.message}`); }
}

const ENV_CONFIG = {
  testprofile: { user: 'testuser', password: 'testpass', connection_string: 'localhost:1521/test', schema_allowlist: ['APP', 'REPORTING'], max_rows: '100' },
  noprod: { user: null, password: null, connection_string: null }
};

// ==================== POLICY TESTS ====================

// O1: Missing profile → REJECT
test('O1', () => {
  const r = server.handleOracleHealth({}, ENV_CONFIG);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.errors[0].category, 'VALIDATION_ERROR');
});

// O2: Schema allowlist — allowed PASS, blocked POLICY_BLOCKED
test('O2a', () => {
  const sv = policy.validateSchema('APP', ['APP', 'REPORTING']);
  assert.strictEqual(sv.valid, true);
});
test('O2b', () => {
  const sv = policy.validateSchema('SECRET', ['APP', 'REPORTING']);
  assert.strictEqual(sv.valid, false);
  assert.strictEqual(sv.error, 'POLICY_BLOCKED');
});

// O3: Identifier injection
test('O3a', () => {
  assert.strictEqual(identifiers.detectInjection('USERS; DROP TABLE X'), true);
});
test('O3b', () => {
  assert.strictEqual(identifiers.detectInjection('"USERS WHERE 1=1"'), true);
});
test('O3c', () => {
  assert.strictEqual(identifiers.detectInjection('../USERS') || !identifiers.validateIdentifier('../USERS').valid, true);
});

// O4: Raw SQL field rejected
test('O4', () => {
  assert.strictEqual(policy.blockRawSql({ sql: 'SELECT * FROM X' }), true);
  assert.strictEqual(policy.blockRawSql({ query: 'SELECT * FROM X' }), true);
  assert.strictEqual(policy.blockRawSql({}), false);
});

// O5: DELETE → POLICY_BLOCKED
test('O5a', () => { assert.strictEqual(policy.blockDelete('DELETE FROM USERS'), true); });
test('O5b', () => { assert.strictEqual(policy.blockDelete('delete from users'), true); });
test('O5c', () => { assert.strictEqual(policy.blockDelete('  DELETE FROM X'), true); });
test('O5d', () => { assert.strictEqual(policy.blockDelete('/* comment */ DELETE FROM X'), true); });
test('O5e', () => { assert.strictEqual(policy.blockDelete('-- comment\nDELETE FROM X'), true); });
test('O5f', () => { assert.strictEqual(policy.blockDelete('SELECT * FROM X'), false); });

// ==================== READ TESTS ====================

// R1: Bounded structured SELECT
test('R1', () => {
  const r = server.handleOracleRead({ profile: 'testprofile', schema: 'APP', table: 'CUSTOMERS', columns: ['ID', 'NAME'], limit: 10 }, ENV_CONFIG);
  assert.strictEqual(r.ok, true);
  assert.ok(r.sql.includes('FETCH FIRST'));
  assert.ok(r.sql.includes('APP.CUSTOMERS'));
});

// R2: Values use binds
test('R2', () => {
  const r = server.handleOracleRead({ profile: 'testprofile', schema: 'APP', table: 'T', where: { ID: { op: '=', value: 123 } }, limit: 10 }, ENV_CONFIG);
  assert.strictEqual(r.ok, true);
  assert.ok(r.sql.includes(':b'));
  assert.strictEqual(r.bind_count >= 1, true);
});

// R3: Limit below max → PASS
test('R3', () => {
  const r = server.handleOracleRead({ profile: 'testprofile', schema: 'APP', table: 'T', limit: 50 }, ENV_CONFIG);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.limit, 50);
});

// R4: Limit above configured max → REJECT
test('R4', () => {
  const r = server.handleOracleRead({ profile: 'testprofile', schema: 'APP', table: 'T', limit: 999 }, ENV_CONFIG);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.errors[0].category, 'POLICY_BLOCKED');
});

// R5: No limit → bounded safe default
test('R5', () => {
  const r = server.handleOracleRead({ profile: 'testprofile', schema: 'APP', table: 'T' }, ENV_CONFIG);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.limit, 100); // configured max from testprofile
});

// R6: Invalid filter operator
test('R6', () => {
  const r = queryBuilder.buildSelect({ schema: 'APP', table: 'T', where: { ID: { op: 'DROP', value: 1 } }, limit: 10 });
  assert.strictEqual(r.valid, false);
  assert.ok(r.message.includes('invalid filter operator'));
});

// R7: No DB connection for query-build
test('R7', () => {
  const r = queryBuilder.buildSelect({ schema: 'APP', table: 'T', limit: 10 });
  assert.strictEqual(r.valid, true);
  assert.ok(r.sql.startsWith('SELECT'));
});

// ==================== INSERT TESTS ====================

// I1: Default dry_run=true, commit=false
test('I1', () => {
  const r = server.handleOracleInsert({ profile: 'testprofile', schema: 'APP', table: 'T', values: { A: 1 } }, ENV_CONFIG);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.dry_run, true);
  assert.strictEqual(r.commit, false);
});

// I2: Structured INSERT uses binds
test('I2', () => {
  const r = server.handleOracleInsert({ profile: 'testprofile', schema: 'APP', table: 'T', values: { A: 1, B: 'x' } }, ENV_CONFIG);
  assert.strictEqual(r.ok, true);
  assert.ok(r.sql.includes(':b'));
  assert.strictEqual(r.bind_count, 2);
});

// I3: Blocked schema → POLICY_BLOCKED
test('I3', () => {
  const r = server.handleOracleInsert({ profile: 'testprofile', schema: 'SECRET', table: 'T', values: { A: 1 } }, ENV_CONFIG);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.errors[0].category, 'POLICY_BLOCKED');
});

// I4: Synthetic adapter dry_run=false commit=false → execute=1 rollback=1
test('I4', () => {
  const txn = transaction.createTransactionContext({ dryRun: false, commit: false });
  const adapter = new SyntheticAdapter();
  transaction.executeInTransaction(txn, adapter, 'INSERT INTO T VALUES (1)', {});
  assert.strictEqual(txn.execute_count, 1);
  assert.strictEqual(txn.commit_count, 0);
  assert.strictEqual(txn.rollback_count, 1);
});

// I5: Synthetic adapter dry_run=false commit=true → execute=1 commit=1
test('I5', () => {
  const txn = transaction.createTransactionContext({ dryRun: false, commit: true });
  const adapter = new SyntheticAdapter();
  transaction.executeInTransaction(txn, adapter, 'INSERT INTO T VALUES (1)', {});
  assert.strictEqual(txn.execute_count, 1);
  assert.strictEqual(txn.commit_count, 1);
});

// ==================== UPDATE TESTS ====================

// U1: UPDATE without WHERE → POLICY_BLOCKED
test('U1', () => {
  const r = server.handleOracleUpdate({ profile: 'testprofile', schema: 'APP', table: 'T', set: { A: 1 } }, ENV_CONFIG);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.errors[0].category, 'POLICY_BLOCKED');
});

// U2: Empty WHERE → POLICY_BLOCKED
test('U2', () => {
  const r = server.handleOracleUpdate({ profile: 'testprofile', schema: 'APP', table: 'T', set: { A: 1 }, where: {} }, ENV_CONFIG);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.errors[0].category, 'POLICY_BLOCKED');
});

// U3: Structured UPDATE with valid WHERE uses binds
test('U3', () => {
  const r = server.handleOracleUpdate({ profile: 'testprofile', schema: 'APP', table: 'T', set: { A: 1 }, where: { ID: { op: '=', value: 42 } } }, ENV_CONFIG);
  assert.strictEqual(r.ok, true);
  assert.ok(r.sql.includes(':b'));
  assert.ok(r.sql.includes('WHERE'));
});

// U4: Dry-run → execute=0 commit=0
test('U4', () => {
  const r = server.handleOracleUpdate({ profile: 'testprofile', schema: 'APP', table: 'T', set: { A: 1 }, where: { ID: { op: '=', value: 1 } }, dry_run: true }, ENV_CONFIG);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.dry_run, true);
});

// U5: Non-commit synthetic → execute=1 rollback=1
test('U5', () => {
  const txn = transaction.createTransactionContext({ dryRun: false, commit: false });
  const adapter = new SyntheticAdapter();
  transaction.executeInTransaction(txn, adapter, 'UPDATE T SET A=1 WHERE ID=1', {});
  assert.strictEqual(txn.execute_count, 1);
  assert.strictEqual(txn.commit_count, 0);
  assert.strictEqual(txn.rollback_count, 1);
});

// U6: Explicit commit synthetic → execute=1 commit=1
test('U6', () => {
  const txn = transaction.createTransactionContext({ dryRun: false, commit: true });
  const adapter = new SyntheticAdapter();
  transaction.executeInTransaction(txn, adapter, 'UPDATE T SET A=1 WHERE ID=1', {});
  assert.strictEqual(txn.execute_count, 1);
  assert.strictEqual(txn.commit_count, 1);
});

// U7: No path to unrestricted UPDATE
test('U7', () => {
  const r = server.handleOracleUpdate({ profile: 'testprofile', schema: 'APP', table: 'T', set: { A: 1 } }, ENV_CONFIG);
  assert.strictEqual(r.ok, false);
});

// ==================== DELETE TESTS ====================

// D1-D5: DELETE blocked in all forms
test('D1', () => { assert.strictEqual(policy.blockDelete('DELETE FROM USERS'), true); });
test('D2', () => { assert.strictEqual(policy.blockDelete('delete from users'), true); });
test('D3', () => { assert.strictEqual(policy.blockDelete('  DELETE FROM X'), true); });
test('D4', () => { assert.strictEqual(policy.blockDelete('/* comment */ DELETE FROM X'), true); });
test('D5', () => { assert.strictEqual(policy.blockDelete('-- comment\nDELETE FROM X'), true); });

// ==================== DDL TESTS ====================

// L1: Unsupported raw DDL → REJECT
test('L1', () => {
  const r = server.handleOracleDdl({ profile: 'testprofile', action: 'DROP_TABLE', schema: 'APP', table: 'T' }, ENV_CONFIG);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.errors[0].category, 'POLICY_BLOCKED');
});

// L2: Supported bounded DDL → statement generated, dry_run=true
test('L2', () => {
  const r = server.handleOracleDdl({ profile: 'testprofile', action: 'CREATE_INDEX', schema: 'APP', table: 'T', column: 'ID' }, ENV_CONFIG);
  assert.strictEqual(r.ok, true);
  assert.ok(r.sql.includes('CREATE INDEX'));
  assert.strictEqual(r.dry_run, true);
});

// L3: DROP TABLE → POLICY_BLOCKED
test('L3', () => {
  const r = policy.validateDdlAction('DROP_TABLE');
  assert.strictEqual(r.valid, false);
  assert.strictEqual(r.error, 'POLICY_BLOCKED');
});

// L4: TRUNCATE → POLICY_BLOCKED
test('L4', () => {
  const r = policy.validateDdlAction('TRUNCATE');
  assert.strictEqual(r.valid, false);
  assert.strictEqual(r.error, 'POLICY_BLOCKED');
});

// L5: DDL rollback available = false
test('L5', () => {
  const r = transaction.getRollbackInfo('ddl');
  assert.strictEqual(r.available, false);
});

// ==================== EVIDENCE TESTS ====================

// E1: Evidence contains run_id, operation, profile, dry_run, status
test('E1', () => {
  const r = evidence.createOracleResult({ operation: 'oracle_read', profile: 'test', schema: 'APP', table: 'T', dryRun: true, runId: 'test123' });
  assert.strictEqual(r.run_id, 'test123');
  assert.strictEqual(r.operation, 'oracle_read');
  assert.strictEqual(r.profile, 'test');
  assert.strictEqual(r.dry_run, true);
  assert.strictEqual(r.status, 'ok');
});

// E2: Evidence contains no password/token/connection secret
test('E2', () => {
  const r = evidence.createOracleResult({ operation: 'oracle_read', profile: 'test', dryRun: true, runId: 'x' });
  const serialized = JSON.stringify(r);
  assert.ok(!serialized.includes('password'));
  assert.ok(!serialized.includes('token'));
  assert.ok(!serialized.includes('connection_string'));
});

// E3: Bind values do not leak into diagnostics
test('E3', () => {
  const { protectSecrets } = require(path.join(__dirname, '..', '..', '..', '..', 'mcp', 'lib', 'runtime-utils'));
  const diagnosticLine = 'b1=token=supersecret123 b2=normal_value';
  const redacted = protectSecrets(diagnosticLine);
  assert.ok(!redacted.includes('supersecret123'));
  assert.ok(redacted.includes('normal_value'));
});

// E4: Ledger path is profile namespaced
test('E4', () => {
  const p = evidence.getLedgerPath('myprofile', 'run123');
  assert.ok(p.includes('myprofile'));
  assert.ok(p.includes('run123'));
  assert.ok(p.includes('oracle'));
});

// E5: Profile traversal rejected
test('E5', () => {
  const pv = policy.validateProfile('../escape');
  assert.strictEqual(pv.valid, false);
});

// ==================== HEALTH TESTS ====================

// H1: Missing profile config → NOT_CONFIGURED
test('H1', () => {
  const r = server.handleOracleHealth({ profile: 'nonexistent' }, ENV_CONFIG);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.status, 'NOT_CONFIGURED');
});

// H2: Config present but no real driver → CONFIGURED (static check)
test('H2', () => {
  const r = server.handleOracleHealth({ profile: 'testprofile' }, ENV_CONFIG);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.status, 'READY');
});

// H3: Config missing required vars → NOT_CONFIGURED
test('H3', () => {
  const r = server.handleOracleHealth({ profile: 'noprod' }, ENV_CONFIG);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.status, 'NOT_CONFIGURED');
});

// ==================== REGISTRY VALIDATION ====================

test('REG', () => {
  const reg = require(path.join(__dirname, '..', '..', '..', '..', 'mcp', 'registry.json'));
  const oracle = reg.entries.find(e => e.name === 'oracle-readonly');
  assert.ok(oracle);
  assert.strictEqual(oracle.ownership, 'REPOSITORY_OWNED');
  assert.ok(oracle.criticality === 'OPTIONAL' || oracle.criticality === 'PLANNED');
  assert.strictEqual(oracle.enabled_by_default, false);
});

// ==================== REDACTION ====================

test('RED', () => {
  const { protectSecrets } = require(path.join(__dirname, '..', '..', '..', '..', 'mcp', 'lib', 'runtime-utils'));
  const payload = 'ORACLE_USER=admin ORACLE_PASSWORD=secret123 ORACLE_CONNECTION_STRING=host:1521/db';
  const redacted = protectSecrets(payload, ['ORACLE_USER', 'ORACLE_PASSWORD', 'ORACLE_CONNECTION_STRING']);
  assert.ok(!redacted.includes('secret123'));
  assert.ok(!redacted.includes('host:1521/db'));
});

// ==================== SUMMARY ====================
console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
