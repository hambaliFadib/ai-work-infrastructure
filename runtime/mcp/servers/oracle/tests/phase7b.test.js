/**
 * Phase 7B — Oracle Environment & Health Closure Tests.
 */

const path = require('path');
const fs = require('fs');
const assert = require('assert');
const { execSync } = require('child_process');

const policy = require('../core/policy');
const server = require('../server');
const { SyntheticAdapter } = require('../core/oracle-adapter');

let passed = 0;
let failed = 0;
function test(label, fn) {
  try { fn(); passed++; console.log(`${label}: PASS`); }
  catch (e) { failed++; console.log(`${label}: FAIL — ${e.message}`); }
}

const REPO = path.resolve(__dirname, '..', '..', '..', '..', '..');
const LOADER = path.join(REPO, 'runtime', 'scripts', 'env', 'load-env.ps1').replace(/\\/g, '\\\\');
const CONTRACT = path.join(REPO, 'governance', 'schemas', 'environment-contract.json').replace(/\\/g, '\\\\');
const PDIR = path.join(REPO, 'runtime', 'local-state', 'env');
const ROOT = REPO.replace(/\\/g, '\\\\');

const ENV_CONFIG = {
  tp: { user: 'tu', password: 'tp', connection_string: 'h:1521/d', schema_allowlist: ['APP'], max_rows: '100' },
  ep: { user: null, password: null, connection_string: null }
};

function mkProfile(name, vars) {
  fs.mkdirSync(PDIR, { recursive: true });
  fs.writeFileSync(path.join(PDIR, name + '.env'), Object.entries(vars).map(([k,v]) => `${k}=${v}`).join('\n'), 'utf8');
}

function runPs(script) {
  fs.mkdirSync(PDIR, { recursive: true });
  const f = path.join(PDIR, '_test_' + Date.now() + '.ps1');
  fs.writeFileSync(f, script, 'utf8');
  try {
    const out = execSync(`powershell -ExecutionPolicy Bypass -File "${f}" 2>$null`, { encoding: 'utf8', stdio: 'pipe' });
    const lines = out.trim().split('\n');
    const jsonLine = lines.reverse().find(l => l.trim().startsWith('{'));
    return jsonLine || out.trim();
  } finally { try { fs.unlinkSync(f); } catch {} }
}

const OV = ['ORACLE_USER','ORACLE_PASSWORD','ORACLE_CONNECTION_STRING','ORACLE_MAX_ROWS','ORACLE_SCHEMA_ALLOWLIST'];

// E01: Profile isolation
test('ENV-E01', () => {
  mkProfile('oa', { ORACLE_USER:'ua', ORACLE_PASSWORD:'pa', ORACLE_CONNECTION_STRING:'ha:1521/da', ORACLE_MAX_ROWS:'50', ORACLE_SCHEMA_ALLOWLIST:'SA' });
  mkProfile('ob', { ORACLE_USER:'ub', ORACLE_PASSWORD:'pb', ORACLE_CONNECTION_STRING:'hb:1521/db', ORACLE_MAX_ROWS:'75', ORACLE_SCHEMA_ALLOWLIST:'SB' });
  const out = runPs(`$ErrorActionPreference='SilentlyContinue'
. '${LOADER}' -Profile oa -ContractPath '${CONTRACT}' -Apply *>$null
. '${LOADER}' -Profile ob -ContractPath '${CONTRACT}' -Apply *>$null
$r=@{}; foreach($v in @('${OV[0]}','${OV[1]}','${OV[2]}')){$r[$v]=[Environment]::GetEnvironmentVariable($v,'Process')}
$r|ConvertTo-Json -Compress`);
  const r = JSON.parse(out);
  assert.strictEqual(r.ORACLE_USER, 'ub');
  assert.strictEqual(r.ORACLE_PASSWORD, 'pb');
  assert.strictEqual(r.ORACLE_CONNECTION_STRING, 'hb:1521/db');
  fs.unlinkSync(path.join(PDIR, 'oa.env'));
  fs.unlinkSync(path.join(PDIR, 'ob.env'));
});

// E02: Profile > root
test('ENV-E02', () => {
  fs.writeFileSync(path.join(REPO.replace(/\\\\/g, '\\'), '.env'), 'ORACLE_USER=ru\nORACLE_MAX_ROWS=200\nORACLE_SCHEMA_ALLOWLIST=RS\n', 'utf8');
  mkProfile('op', { ORACLE_USER:'pu', ORACLE_MAX_ROWS:'50', ORACLE_SCHEMA_ALLOWLIST:'PS' });
  const out = runPs(`$ErrorActionPreference='SilentlyContinue'
. '${LOADER}' -Profile op -ContractPath '${CONTRACT}' -Apply *>$null
$r=@{}; foreach($v in @('ORACLE_USER','ORACLE_MAX_ROWS','ORACLE_SCHEMA_ALLOWLIST')){$r[$v]=[Environment]::GetEnvironmentVariable($v,'Process')}
$r|ConvertTo-Json -Compress`);
  const r = JSON.parse(out);
  assert.strictEqual(r.ORACLE_USER, 'pu');
  assert.strictEqual(r.ORACLE_MAX_ROWS, '50');
  assert.strictEqual(r.ORACLE_SCHEMA_ALLOWLIST, 'PS');
  fs.unlinkSync(path.join(REPO.replace(/\\\\/g, '\\'), '.env'));
  fs.unlinkSync(path.join(PDIR, 'op.env'));
});

// E03: Stale inherited purge
test('ENV-E03', () => {
  mkProfile('onp', { ORACLE_USER:'unp', ORACLE_CONNECTION_STRING:'h:1521/d' });
  fs.writeFileSync(path.join(REPO.replace(/\\\\/g, '\\'), '.env'), 'ORACLE_USER=ru\n', 'utf8');
  const out = runPs(`$ErrorActionPreference='SilentlyContinue'
[Environment]::SetEnvironmentVariable('ORACLE_PASSWORD','stale_inherited','Process')
. '${LOADER}' -Profile onp -ContractPath '${CONTRACT}' -Apply *>$null
@{ORACLE_PASSWORD=[Environment]::GetEnvironmentVariable('ORACLE_PASSWORD','Process')}|ConvertTo-Json -Compress`);
  const r = JSON.parse(out);
  assert.ok(!r.ORACLE_PASSWORD || r.ORACLE_PASSWORD === '');
  fs.unlinkSync(path.join(REPO.replace(/\\\\/g, '\\'), '.env'));
  fs.unlinkSync(path.join(PDIR, 'onp.env'));
});

// E03B: Root fallback
test('ENV-E03B', () => {
  mkProfile('onp2', { ORACLE_USER:'unp2' });
  fs.writeFileSync(path.join(REPO.replace(/\\\\/g, '\\'), '.env'), 'ORACLE_PASSWORD=root_pass\n', 'utf8');
  const out = runPs(`$ErrorActionPreference='SilentlyContinue'
[Environment]::SetEnvironmentVariable('ORACLE_PASSWORD','stale_val','Process')
. '${LOADER}' -Profile onp2 -ContractPath '${CONTRACT}' -Apply *>$null
@{ORACLE_PASSWORD=[Environment]::GetEnvironmentVariable('ORACLE_PASSWORD','Process')}|ConvertTo-Json -Compress`);
  const r = JSON.parse(out);
  assert.strictEqual(r.ORACLE_PASSWORD, 'root_pass');
  fs.unlinkSync(path.join(REPO.replace(/\\\\/g, '\\'), '.env'));
  fs.unlinkSync(path.join(PDIR, 'onp2.env'));
});

// E04: Required config
test('ENV-E04a', () => { assert.strictEqual(server.handleOracleHealth({profile:'ep'},ENV_CONFIG).status, 'NOT_CONFIGURED'); });
test('ENV-E04b', () => { assert.strictEqual(server.handleOracleHealth({profile:'nonexistent'},ENV_CONFIG).status, 'NOT_CONFIGURED'); });

// E05: Max rows
test('ENV-E05a', () => { assert.strictEqual(policy.validateRowLimit(0,100).valid, false); });
test('ENV-E05b', () => { assert.strictEqual(policy.validateRowLimit(-1,100).valid, false); });
test('ENV-E05c', () => { assert.strictEqual(policy.validateRowLimit('abc',100).valid, false); });
test('ENV-E05d', () => { assert.strictEqual(policy.validateRowLimit(10001,10000).valid, false); });
test('ENV-E05e', () => { assert.strictEqual(policy.validateRowLimit(1,100).valid, true); });
test('ENV-E05f', () => { assert.strictEqual(policy.validateRowLimit(10000,10000).valid, true); });

// E06: Allowlist
test('ENV-E06a', () => { assert.strictEqual(policy.validateSchema('APP',['APP','REPORTING']).valid, true); });
test('ENV-E06b', () => { assert.strictEqual(policy.validateSchema('*',['APP']).valid, false); });
test('ENV-E06c', () => { assert.strictEqual(policy.validateSchema('APP;',['APP']).valid, false); });
test('ENV-E06d', () => { assert.strictEqual(policy.validateSchema('APP;DROP',['APP']).valid, false); });
test('ENV-E06e', () => { assert.strictEqual(policy.validateSchema('"APP"',['APP']).valid, false); });
test('ENV-E06f', () => { assert.strictEqual(policy.validateSchema('APP,../OTHER',['APP']).valid, false); });

// OH1: NOT_CONFIGURED
test('OH1', () => { const r=server.handleOracleHealth({profile:'nonexistent'},ENV_CONFIG); assert.strictEqual(r.status,'NOT_CONFIGURED'); assert.strictEqual(r.fatal,false); });

// OH2: READY (driver installed)
test('OH2', () => { const r=server.handleOracleHealth({profile:'tp'},ENV_CONFIG); assert.strictEqual(r.status,'READY'); assert.strictEqual(r.fatal,false); });

// OH3: READY with synthetic adapter
test('OH3', () => { const a=new SyntheticAdapter(); const r=server.handleOracleHealth({profile:'tp',adapter:a},ENV_CONFIG); assert.strictEqual(r.status,'READY'); assert.strictEqual(r.fatal,false); assert.strictEqual(r.adapter,'synthetic'); assert.strictEqual(a.connect_count,1); });

// OH4: Secret safety
test('OH4', () => { const r=server.handleOracleHealth({profile:'tp',adapter:new SyntheticAdapter()},ENV_CONFIG); const s=JSON.stringify(r); assert.ok(!s.includes('tp')); assert.ok(!s.includes('localhost')); });

// DDL regression
test('DDL-REG', () => {
  assert.strictEqual(policy.validateDatatype('VARCHAR2(100)').valid, true);
  assert.strictEqual(policy.validateDatatype('VARCHAR2(10); DROP TABLE X').valid, false);
  assert.strictEqual(policy.validateDatatype('NUMBER(0)').valid, false);
  const r=require('../core/query-builder').buildDdl({action:'ADD_COLUMN',schema:'APP',table:'T',column:'A;DROP',data_type:'VARCHAR2(100)'});
  assert.strictEqual(r.valid, false);
  const d=server.handleOracleDdl({profile:'tp',action:'CREATE_INDEX',schema:'APP',table:'T',column:'ID'},ENV_CONFIG);
  assert.strictEqual(d.dry_run, true);
  assert.strictEqual(require('../core/transaction').getRollbackInfo('ddl').available, false);
});

console.log(`\nPhase 7B: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
