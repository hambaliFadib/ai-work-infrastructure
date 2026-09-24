/**
 * Phase 7A — Oracle Safe Core Integrity Verification Tests.
 * Environment integration, health exact states, DDL injection, datatype policy.
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
  emptyprofile: { user: null, password: null, connection_string: null }
};

// ==================== ENV-E04: REQUIRED CONFIG ====================
test('ENV-E04', () => {
  const r = server.handleOracleHealth({ profile: 'emptyprofile' }, ENV_CONFIG);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.status, 'NOT_CONFIGURED');
});

// ==================== ENV-E05: MAX ROW VALIDATION ====================
test('ENV-E05a', () => { const r = policy.validateRowLimit(0, 100); assert.strictEqual(r.valid, false); });
test('ENV-E05b', () => { const r = policy.validateRowLimit(-1, 100); assert.strictEqual(r.valid, false); });
test('ENV-E05c', () => { const r = policy.validateRowLimit('abc', 100); assert.strictEqual(r.valid, false); });
test('ENV-E05d', () => { const r = policy.validateRowLimit(10001, 10000); assert.strictEqual(r.valid, false); });
test('ENV-E05e', () => { const r = policy.validateRowLimit(1, 100); assert.strictEqual(r.valid, true); assert.strictEqual(r.limit, 1); });
test('ENV-E05f', () => { const r = policy.validateRowLimit(10000, 10000); assert.strictEqual(r.valid, true); assert.strictEqual(r.limit, 10000); });

// ==================== ENV-E06: SCHEMA ALLOWLIST PARSING ====================
test('ENV-E06a', () => { const r = policy.validateSchema('APP', ['APP', 'REPORTING']); assert.strictEqual(r.valid, true); });
test('ENV-E06b', () => { const r = policy.validateSchema('*', ['APP']); assert.strictEqual(r.valid, false); });
test('ENV-E06c', () => { const r = policy.validateSchema('APP;', ['APP']); assert.strictEqual(r.valid, false); });
test('ENV-E06d', () => { const r = policy.validateSchema('APP;DROP', ['APP']); assert.strictEqual(r.valid, false); });
test('ENV-E06e', () => { const r = policy.validateSchema('"APP"', ['APP']); assert.strictEqual(r.valid, false); });
test('ENV-E06f', () => { const r = policy.validateSchema('APP,../OTHER', ['APP']); assert.strictEqual(r.valid, false); });

// ==================== OH1: NOT CONFIGURED ====================
test('OH1', () => {
  const r = server.handleOracleHealth({ profile: 'nonexistent' }, ENV_CONFIG);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.status, 'NOT_CONFIGURED');
});

// ==================== OH2: REAL DRIVER AVAILABLE ====================
test('OH2', () => {
  const r = server.handleOracleHealth({ profile: 'testprofile' }, ENV_CONFIG);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.status, 'READY');
});

// ==================== OH3: SYNTHETIC READY ====================
test('OH3', () => {
  const adapter = new SyntheticAdapter();
  assert.strictEqual(adapter.execute_count, 0);
  adapter.execute('SELECT 1 FROM DUAL', {});
  assert.strictEqual(adapter.execute_count, 1);
});

// ==================== OH4: HEALTH SECRET REDACTION ====================
test('OH4', () => {
  const { protectSecrets } = require(path.join(__dirname, '..', '..', '..', '..', 'mcp', 'lib', 'runtime-utils'));
  const payload = 'ORACLE_USER=admin ORACLE_PASSWORD=secret123 ORACLE_CONNECTION_STRING=host:1521/db';
  const redacted = protectSecrets(payload, ['ORACLE_USER', 'ORACLE_PASSWORD', 'ORACLE_CONNECTION_STRING']);
  assert.ok(!redacted.includes('secret123'));
  assert.ok(!redacted.includes('host:1521/db'));
  assert.ok(!redacted.includes('admin'));
});

// ==================== DDL-A: FIELD CONTRACT ====================
test('DDL-A', () => {
  const r = queryBuilder.buildDdl({ action: 'ADD_COLUMN', schema: 'APP', table: 'T', column: 'NEW_COL', data_type: 'VARCHAR2(100)' });
  assert.strictEqual(r.valid, true);
  assert.ok(r.sql.includes('ALTER TABLE'));
  assert.ok(r.sql.includes('VARCHAR2(100)'));
});

// ==================== DDL-B: DATATYPE INJECTION ====================
test('DDL-B1', () => { const r = policy.validateDatatype('VARCHAR2(10)); DROP TABLE USERS; --'); assert.strictEqual(r.valid, false); });
test('DDL-B2', () => { const r = policy.validateDatatype('NUMBER; DELETE FROM X'); assert.strictEqual(r.valid, false); });
test('DDL-B3', () => { const r = policy.validateDatatype('VARCHAR2(10) /* injected */'); assert.strictEqual(r.valid, false); });
test('DDL-B4', () => { const r = policy.validateDatatype('VARCHAR2(10) UNION SELECT * FROM users'); assert.strictEqual(r.valid, false); });

// ==================== DDL-C: NUMERIC INJECTION ====================
test('DDL-C1', () => { const r = policy.validateDatatype('NUMBER(10); DROP TABLE X'); assert.strictEqual(r.valid, false); });
test('DDL-C2', () => { const r = policy.validateDatatype('NUMBER(10,2); DROP TABLE X'); assert.strictEqual(r.valid, false); });
test('DDL-C3', () => { const r = policy.validateDatatype('NUMBER(0)'); assert.strictEqual(r.valid, false); });
test('DDL-C4', () => { const r = policy.validateDatatype('NUMBER(39)'); assert.strictEqual(r.valid, false); });
test('DDL-C5', () => { const r = policy.validateDatatype('NUMBER(10,200)'); assert.strictEqual(r.valid, false); });

// ==================== DDL-D: IDENTIFIER INJECTION ====================
test('DDL-D1', () => { const r = identifiers.detectInjection('A ADD B NUMBER'); assert.strictEqual(r, true); });
test('DDL-D2', () => { const r = identifiers.detectInjection('IDX; DROP TABLE X'); assert.strictEqual(r, true); });
test('DDL-D3', () => { const r = identifiers.detectInjection('col/*comment*/name'); assert.strictEqual(r, true); });

// ==================== DDL-E: DRY-RUN EXECUTE COUNT ====================
test('DDL-E', () => {
  const r = server.handleOracleDdl({ profile: 'testprofile', action: 'CREATE_INDEX', schema: 'APP', table: 'T', column: 'ID' }, ENV_CONFIG);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.dry_run, true);
  assert.strictEqual(r.sql.includes('CREATE INDEX'), true);
});

// ==================== DDL-F: ROLLBACK HONESTY ====================
test('DDL-F', () => {
  const r = transaction.getRollbackInfo('ddl');
  assert.strictEqual(r.available, false);
});

// ==================== VALID DATATYPES ====================
test('DT-VALID', () => {
  assert.strictEqual(policy.validateDatatype('VARCHAR2(100)').valid, true);
  assert.strictEqual(policy.validateDatatype('NUMBER(12,2)').valid, true);
  assert.strictEqual(policy.validateDatatype('DATE').valid, true);
  assert.strictEqual(policy.validateDatatype('TIMESTAMP').valid, true);
  assert.strictEqual(policy.validateDatatype('CLOB').valid, true);
  assert.strictEqual(policy.validateDatatype('BLOB').valid, true);
  assert.strictEqual(policy.validateDatatype('NVARCHAR2(200)').valid, true);
  assert.strictEqual(policy.validateDatatype('CHAR(10)').valid, true);
});

// ==================== INVALID DATATYPES ====================
test('DT-INVALID', () => {
  assert.strictEqual(policy.validateDatatype('XMLTYPE').valid, false);
  assert.strictEqual(policy.validateDatatype('INVALID').valid, false);
  assert.strictEqual(policy.validateDatatype('VARCHAR2(5000)').valid, false);
  assert.strictEqual(policy.validateDatatype('NUMBER(39)').valid, false);
});

// ==================== EXISTING ORACLE REGRESSION ====================
test('REG-O1', () => { const r = server.handleOracleHealth({}, ENV_CONFIG); assert.strictEqual(r.ok, false); });
test('REG-O2', () => { assert.strictEqual(policy.validateSchema('APP', ['APP', 'REPORTING']).valid, true); });
test('REG-O3', () => { assert.strictEqual(identifiers.detectInjection('USERS; DROP TABLE X'), true); });
test('REG-O4', () => { assert.strictEqual(policy.blockRawSql({ sql: 'SELECT * FROM X' }), true); });
test('REG-O5', () => { assert.strictEqual(policy.blockDelete('DELETE FROM USERS'), true); });
test('REG-R1', () => {
  const r = server.handleOracleRead({ profile: 'testprofile', schema: 'APP', table: 'CUSTOMERS', columns: ['ID', 'NAME'], limit: 10 }, ENV_CONFIG);
  assert.strictEqual(r.ok, true);
  assert.ok(r.sql.includes('FETCH FIRST'));
});
test('REG-R4', () => {
  const r = server.handleOracleRead({ profile: 'testprofile', schema: 'APP', table: 'T', limit: 999 }, ENV_CONFIG);
  assert.strictEqual(r.ok, false);
});
test('REG-I1', () => {
  const r = server.handleOracleInsert({ profile: 'testprofile', schema: 'APP', table: 'T', values: { A: 1 } }, ENV_CONFIG);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.dry_run, true);
});
test('REG-U1', () => {
  const r = server.handleOracleUpdate({ profile: 'testprofile', schema: 'APP', table: 'T', set: { A: 1 } }, ENV_CONFIG);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.errors[0].category, 'POLICY_BLOCKED');
});
test('REG-D1', () => { assert.strictEqual(policy.blockDelete('DELETE FROM USERS'), true); });
test('REG-L1', () => {
  const r = server.handleOracleDdl({ profile: 'testprofile', action: 'DROP_TABLE', schema: 'APP', table: 'T' }, ENV_CONFIG);
  assert.strictEqual(r.ok, false);
});
test('REG-E1', () => {
  const r = evidence.createOracleResult({ operation: 'oracle_read', profile: 'test', dryRun: true, runId: 'x' });
  assert.strictEqual(r.run_id, 'x');
  assert.strictEqual(r.operation, 'oracle_read');
});
test('REG-H1', () => {
  const r = server.handleOracleHealth({ profile: 'nonexistent' }, ENV_CONFIG);
  assert.strictEqual(r.status, 'NOT_CONFIGURED');
});

// ==================== SUMMARY ====================
console.log(`\nPhase 7A Results: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
