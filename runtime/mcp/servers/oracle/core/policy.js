/**
 * Oracle Policy Module — operation allowlist, schema authorization,
 * row limits, commit requirements, DDL action allowlist, DELETE/SQL blocks.
 */

const VALID_OPERATIONS = ['oracle_health', 'oracle_read', 'oracle_insert', 'oracle_update', 'oracle_ddl'];
const VALID_DDL_ACTIONS = ['CREATE_INDEX', 'ADD_COLUMN', 'MODIFY_COLUMN'];
const VALID_FILTER_OPS = ['=', '!=', '<', '<=', '>', '>=', 'IN', 'IS_NULL', 'IS_NOT_NULL', 'LIKE'];
const VALID_DIRECTIONS = ['ASC', 'DESC'];
const HARD_MAX_ROWS = 10000;
const DEFAULT_MAX_ROWS = 500;

const BLOCKED_DDL_ACTIONS = ['DROP_TABLE', 'DROP_INDEX', 'DROP_SCHEMA', 'TRUNCATE', 'DELETE'];
const VALID_DATATYPES = ['VARCHAR2', 'NVARCHAR2', 'CHAR', 'NUMBER', 'DATE', 'TIMESTAMP', 'CLOB', 'BLOB'];
const VARCHAR_MAX_LENGTH = 4000;
const NUMBER_MAX_PRECISION = 38;
const NUMBER_MAX_SCALE = 127;

function validateDatatype(dt) {
  if (!dt || typeof dt !== 'string') return { valid: false, error: 'VALIDATION_ERROR', message: 'data_type is required' };
  const upper = dt.trim().toUpperCase();
  const base = upper.split('(')[0].trim();
  if (!VALID_DATATYPES.includes(base)) {
    return { valid: false, error: 'VALIDATION_ERROR', message: `invalid data_type '${dt}'. Allowed: ${VALID_DATATYPES.join(', ')}` };
  }
  if (base === 'VARCHAR2' || base === 'NVARCHAR2' || base === 'CHAR') {
    const m = upper.match(/\((\d+)\)/);
    if (m) {
      const len = parseInt(m[1]);
      if (len <= 0 || len > VARCHAR_MAX_LENGTH) return { valid: false, error: 'VALIDATION_ERROR', message: `invalid length ${len} for ${base}` };
    }
  }
  if (base === 'NUMBER') {
    const m = upper.match(/\((\d+)(?:\s*,\s*(\d+))?\)/);
    if (m) {
      const prec = parseInt(m[1]);
      const scale = m[2] ? parseInt(m[2]) : 0;
      if (prec <= 0 || prec > NUMBER_MAX_PRECISION) return { valid: false, error: 'VALIDATION_ERROR', message: `invalid precision ${prec} for NUMBER` };
      if (scale < 0 || scale > NUMBER_MAX_SCALE) return { valid: false, error: 'VALIDATION_ERROR', message: `invalid scale ${scale} for NUMBER` };
      if (scale > prec) return { valid: false, error: 'VALIDATION_ERROR', message: `scale ${scale} exceeds precision ${prec}` };
    }
  }
  if (/[;'"\\]/.test(dt) || /\/\*|\*\/|--/.test(dt) || /\b(DROP|DELETE|INSERT|UPDATE|SELECT|UNION|EXEC)\b/i.test(dt)) {
    return { valid: false, error: 'VALIDATION_ERROR', message: 'data_type contains injection characters' };
  }
  return { valid: true };
}

function validateProfile(profile) {
  if (!profile || typeof profile !== 'string' || profile.trim() === '') {
    return { valid: false, error: 'VALIDATION_ERROR', message: 'profile is required' };
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(profile) || profile.includes('..') || /[\/\\]/.test(profile)) {
    return { valid: false, error: 'VALIDATION_ERROR', message: 'invalid profile name' };
  }
  return { valid: true };
}

function validateSchema(schema, allowlist) {
  if (!schema || typeof schema !== 'string') {
    return { valid: false, error: 'VALIDATION_ERROR', message: 'schema is required' };
  }
  if (!/^[A-Za-z][A-Za-z0-9_$#]*$/.test(schema)) {
    return { valid: false, error: 'VALIDATION_ERROR', message: 'invalid schema identifier' };
  }
  if (allowlist && allowlist.length > 0) {
    if (!allowlist.includes(schema.toUpperCase())) {
      return { valid: false, error: 'POLICY_BLOCKED', message: `schema '${schema}' not in allowlist` };
    }
  }
  return { valid: true };
}

function validateRowLimit(requested, configuredMax) {
  const max = configuredMax || DEFAULT_MAX_ROWS;
  if (max > HARD_MAX_ROWS) {
    return { valid: false, error: 'CONFIG_ERROR', message: `configured max ${max} exceeds hard limit ${HARD_MAX_ROWS}` };
  }
  const limit = (requested !== null && requested !== undefined && requested !== '') ? Number(requested) : max;
  if (isNaN(limit) || limit <= 0 || limit > HARD_MAX_ROWS) {
    return { valid: false, error: 'POLICY_BLOCKED', message: `row limit ${requested} is invalid or exceeds hard maximum ${HARD_MAX_ROWS}` };
  }
  if (limit > max) {
    return { valid: false, error: 'POLICY_BLOCKED', message: `requested limit ${limit} exceeds configured maximum ${max}` };
  }
  return { valid: true, limit };
}

function validateFilterOp(op) {
  if (!VALID_FILTER_OPS.includes(op)) {
    return { valid: false, error: 'VALIDATION_ERROR', message: `invalid filter operator '${op}'. Allowed: ${VALID_FILTER_OPS.join(', ')}` };
  }
  return { valid: true };
}

function validateDdlAction(action) {
  if (BLOCKED_DDL_ACTIONS.includes(action)) {
    return { valid: false, error: 'POLICY_BLOCKED', message: `DDL action '${action}' is blocked` };
  }
  if (!VALID_DDL_ACTIONS.includes(action)) {
    return { valid: false, error: 'VALIDATION_ERROR', message: `unsupported DDL action '${action}'. Allowed: ${VALID_DDL_ACTIONS.join(', ')}` };
  }
  return { valid: true };
}

function validateWhere(where) {
  if (!where || typeof where !== 'object' || Object.keys(where).length === 0) {
    return { valid: false, error: 'POLICY_BLOCKED', message: 'WHERE clause is required with at least one predicate' };
  }
  return { valid: true };
}

function blockDelete(sql) {
  if (!sql || typeof sql !== 'string') return false;
  const normalized = sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '').trim().toUpperCase();
  return /\bDELETE\b/.test(normalized);
}

function blockRawSql(input) {
  return !!(input && typeof input === 'object' && (input.sql || input.query || input.raw_sql || input.statement));
}

module.exports = {
  VALID_OPERATIONS, VALID_DDL_ACTIONS, VALID_FILTER_OPS, VALID_DIRECTIONS,
  HARD_MAX_ROWS, DEFAULT_MAX_ROWS, BLOCKED_DDL_ACTIONS, VALID_DATATYPES,
  validateProfile, validateSchema, validateRowLimit, validateFilterOp,
  validateDdlAction, validateWhere, validateDatatype, blockDelete, blockRawSql
};
