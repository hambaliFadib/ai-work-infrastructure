/**
 * Oracle MCP Server — generic profile-based architecture.
 * No raw SQL. No DELETE. Structured tools only.
 */

const policy = require('./core/policy');
const identifiers = require('./core/identifiers');
const queryBuilder = require('./core/query-builder');
const transaction = require('./core/transaction');
const evidence = require('./core/evidence');

const LIVE_WRITE_ENABLED = process.env.ORACLE_LIVE_WRITE_ENABLED === 'true';

const TOOLS = [
  { name: 'oracle_health', description: 'Check Oracle configuration and connectivity readiness.' },
  { name: 'oracle_read', description: 'Structured SELECT query with bind parameters.' },
  { name: 'oracle_insert', description: 'Structured INSERT with bind parameters. Default dry_run=true.' },
  { name: 'oracle_update', description: 'Structured UPDATE with bind parameters. WHERE required. Default dry_run=true.' },
  { name: 'oracle_ddl', description: 'Bounded DDL actions (CREATE_INDEX, ADD_COLUMN, MODIFY_COLUMN). Default dry_run=true.' }
];

function handleOracleHealth({ profile, adapter }, envConfig) {
  if (!profile) return { ok: false, status: 'error', fatal: false, errors: [{ category: 'VALIDATION_ERROR', message: 'profile is required' }] };
  const pv = policy.validateProfile(profile);
  if (!pv.valid) return { ok: false, status: 'error', fatal: false, errors: [{ category: pv.error, message: pv.message }] };
  const config = envConfig[profile];
  if (!config || !config.user || !config.connection_string) {
    return { ok: false, status: 'NOT_CONFIGURED', fatal: false, warnings: config ? ['missing required Oracle connection variables'] : ['profile not found in environment config'] };
  }
  // If a synthetic adapter is provided, test connectivity through it
  if (adapter) {
    try {
      adapter.connect(profile);
      return { ok: true, status: 'READY', fatal: false, adapter: 'synthetic', connect_count: adapter.connect_count };
    } catch (e) {
      return { ok: false, status: 'DEPENDENCY_UNAVAILABLE', fatal: false, warnings: [e.message] };
    }
  }
  // Try to load real oracledb driver
  try {
    require('oracledb');
    return { ok: true, status: 'READY', fatal: false, adapter: 'real' };
  } catch (e) {
    return { ok: false, status: 'DEPENDENCY_UNAVAILABLE', fatal: false, warnings: ['node-oracledb not installed: ' + e.message] };
  }
}

function handleOracleRead({ profile, schema, table, columns, where, order_by, limit }, envConfig) {
  if (!profile) return { ok: false, status: 'error', errors: [{ category: 'VALIDATION_ERROR', message: 'profile is required' }] };
  const pv = policy.validateProfile(profile);
  if (!pv.valid) return { ok: false, status: 'error', errors: [{ category: pv.error, message: pv.message }] };
  // Raw SQL not accepted in structured interface
  const config = envConfig[profile];
  const allowlist = config ? config.schema_allowlist : [];
  const sv = policy.validateSchema(schema, allowlist);
  if (!sv.valid) return { ok: false, status: 'error', errors: [{ category: sv.error, message: sv.message }] };
  const maxRows = config ? parseInt(config.max_rows || '500') : 500;
  const rv = policy.validateRowLimit(limit, maxRows);
  if (!rv.valid) return { ok: false, status: 'error', errors: [{ category: rv.error, message: rv.message }] };
  const qb = queryBuilder.buildSelect({ schema, table, columns, where, order_by, limit: rv.limit });
  if (!qb.valid) return { ok: false, status: 'error', errors: [{ category: qb.error, message: qb.message }] };
  return { ok: true, status: 'ok', sql: qb.sql, binds: qb.binds, bind_count: qb.bindCount, limit: rv.limit };
}

function handleOracleInsert({ profile, schema, table, values, dry_run = true, commit = false }, envConfig) {
  if (!LIVE_WRITE_ENABLED && !dry_run) {
    return { ok: false, status: 'error', errors: [{ category: 'POLICY_BLOCKED', message: 'live INSERT disabled' }] };
  }
  if (!profile) return { ok: false, status: 'error', errors: [{ category: 'VALIDATION_ERROR', message: 'profile is required' }] };
  const pv = policy.validateProfile(profile);
  if (!pv.valid) return { ok: false, status: 'error', errors: [{ category: pv.error, message: pv.message }] };
  const config = envConfig[profile];
  const allowlist = config ? config.schema_allowlist : [];
  const sv = policy.validateSchema(schema, allowlist);
  if (!sv.valid) return { ok: false, status: 'error', errors: [{ category: sv.error, message: sv.message }] };
  const ib = queryBuilder.buildInsert({ schema, table, values });
  if (!ib.valid) return { ok: false, status: 'error', errors: [{ category: ib.error, message: ib.message }] };
  const txn = transaction.createTransactionContext({ dryRun: dry_run, commit });
  return { ok: true, status: 'ok', sql: ib.sql, binds: ib.binds, bind_count: ib.bindCount, dry_run: txn.dry_run, commit: txn.commit };
}

function handleOracleUpdate({ profile, schema, table, set, where, dry_run = true, commit = false }, envConfig) {
  if (!LIVE_WRITE_ENABLED && !dry_run) {
    return { ok: false, status: 'error', errors: [{ category: 'POLICY_BLOCKED', message: 'live UPDATE disabled' }] };
  }
  if (!profile) return { ok: false, status: 'error', errors: [{ category: 'VALIDATION_ERROR', message: 'profile is required' }] };
  const pv = policy.validateProfile(profile);
  if (!pv.valid) return { ok: false, status: 'error', errors: [{ category: pv.error, message: pv.message }] };
  const wv = policy.validateWhere(where);
  if (!wv.valid) return { ok: false, status: 'error', errors: [{ category: wv.error, message: wv.message }] };
  const config = envConfig[profile];
  const allowlist = config ? config.schema_allowlist : [];
  const sv = policy.validateSchema(schema, allowlist);
  if (!sv.valid) return { ok: false, status: 'error', errors: [{ category: sv.error, message: sv.message }] };
  const ub = queryBuilder.buildUpdate({ schema, table, set, where });
  if (!ub.valid) return { ok: false, status: 'error', errors: [{ category: ub.error, message: ub.message }] };
  const txn = transaction.createTransactionContext({ dryRun: dry_run, commit });
  return { ok: true, status: 'ok', sql: ub.sql, binds: ub.binds, bind_count: ub.bindCount, dry_run: txn.dry_run, commit: txn.commit };
}

function handleOracleDdl({ profile, action, schema, table, column, data_type, dry_run = true }, envConfig) {
  if (!LIVE_WRITE_ENABLED && !dry_run) {
    return { ok: false, status: 'error', errors: [{ category: 'POLICY_BLOCKED', message: 'live DDL disabled' }] };
  }
  if (!profile) return { ok: false, status: 'error', errors: [{ category: 'VALIDATION_ERROR', message: 'profile is required' }] };
  const pv = policy.validateProfile(profile);
  if (!pv.valid) return { ok: false, status: 'error', errors: [{ category: pv.error, message: pv.message }] };
  const db = queryBuilder.buildDdl({ action, schema, table, column, data_type });
  if (!db.valid) return { ok: false, status: 'error', errors: [{ category: db.error, message: db.message }] };
  return { ok: true, status: 'ok', sql: db.sql, dry_run, rollback: db.rollback };
}

module.exports = { TOOLS, handleOracleHealth, handleOracleRead, handleOracleInsert, handleOracleUpdate, handleOracleDdl, LIVE_WRITE_ENABLED };
