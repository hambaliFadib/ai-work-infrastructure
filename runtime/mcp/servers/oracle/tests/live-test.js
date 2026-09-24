/**
 * Phase 8A — Live Oracle connectivity test.
 * Loads oracle-dev profile, connects with thick mode, executes fixed read-only probe.
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..', '..', '..');
const CONTRACT = path.join(REPO, 'governance', 'schemas', 'environment-contract.json').replace(/\\/g, '\\\\');
const LOADER = path.join(REPO, 'runtime', 'scripts', 'env', 'load-env.ps1').replace(/\\/g, '\\\\');

// Step 1: Load oracle-dev profile through Phase 5 loader
console.log('=== Step 1: Load oracle-dev profile ===');
const loadScript = `$ErrorActionPreference='SilentlyContinue'\n. '${LOADER}' -Profile oracle-dev -ContractPath '${CONTRACT}' -Apply *>$null\n@{ORACLE_USER=[Environment]::GetEnvironmentVariable('ORACLE_USER','Process');ORACLE_PASSWORD=[Environment]::GetEnvironmentVariable('ORACLE_PASSWORD','Process');ORACLE_CONNECTION_STRING=[Environment]::GetEnvironmentVariable('ORACLE_CONNECTION_STRING','Process');ORACLE_CLIENT_DIR=[Environment]::GetEnvironmentVariable('ORACLE_CLIENT_DIR','Process');ORACLE_MODE=[Environment]::GetEnvironmentVariable('ORACLE_MODE','Process');ORACLE_MAX_ROWS=[Environment]::GetEnvironmentVariable('ORACLE_MAX_ROWS','Process');ORACLE_SCHEMA_ALLOWLIST=[Environment]::GetEnvironmentVariable('ORACLE_SCHEMA_ALLOWLIST','Process')}|ConvertTo-Json -Compress`;
fs.writeFileSync(path.join(REPO, '_test8a_env.ps1'), loadScript, 'utf8');
let envConfig;
try {
  const result = execSync(`powershell -ExecutionPolicy Bypass -File "${path.join(REPO, '_test8a_env.ps1')}"`, { encoding: 'utf8', stdio: 'pipe' });
  envConfig = JSON.parse(result.trim());
  console.log('ORACLE_USER:', envConfig.ORACLE_USER ? 'SET' : 'UNSET');
  console.log('ORACLE_PASSWORD:', envConfig.ORACLE_PASSWORD ? 'SET' : 'UNSET');
  console.log('ORACLE_CONNECTION_STRING:', envConfig.ORACLE_CONNECTION_STRING ? 'SET' : 'UNSET');
  console.log('ORACLE_CLIENT_DIR:', envConfig.ORACLE_CLIENT_DIR ? 'SET' : 'UNSET');
} finally { try { fs.unlinkSync(path.join(REPO, '_test8a_env.ps1')); } catch {} }

// Step 2: Connect with thick mode (required for older Oracle password verifiers)
console.log('\n=== Step 2: Live connection ===');
async function testLiveConnection() {
  let oracledb;
  let connection;

  // Initialize thick mode first (before requiring oracledb)
  if (envConfig.ORACLE_CLIENT_DIR) {
    try {
      oracledb = require('oracledb');
      oracledb.initOracleClient({ libDir: envConfig.ORACLE_CLIENT_DIR });
      console.log('Oracle Client initialized (thick mode)');
    } catch (e) {
      console.log('Client init warning:', e.message.substring(0, 120));
      oracledb = require('oracledb');
    }
  } else {
    oracledb = require('oracledb');
  }

  try {
    connection = await oracledb.getConnection({
      user: envConfig.ORACLE_USER,
      password: envConfig.ORACLE_PASSWORD,
      connectString: envConfig.ORACLE_CONNECTION_STRING
    });
    console.log('Connection: SUCCESS');

    // Fixed read-only probe
    const result = await connection.execute('SELECT 1 FROM DUAL');
    console.log('Fixed probe: SUCCESS');
    console.log('Probe result:', result.rows[0][0] === 1 ? 'PASS' : 'FAIL');

    await connection.close();
    console.log('Close: SUCCESS');
    console.log('\n=== LIVE VALIDATION PASSED ===');
  } catch (e) {
    console.log('Connection failed:', e.message.substring(0, 200));
    console.log('\n=== LIVE VALIDATION BLOCKED ===');
    if (connection) try { await connection.close(); } catch {}
    process.exit(1);
  }
}

testLiveConnection().catch(e => {
  console.error('Fatal:', e.message);
  process.exit(1);
});
