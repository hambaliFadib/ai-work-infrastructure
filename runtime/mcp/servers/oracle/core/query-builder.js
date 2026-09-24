/**
 * Oracle Query Builder — structured SELECT/INSERT/UPDATE generation with bind parameters.
 * No raw SQL. All values use binds.
 */

const { validateIdentifier, validateIdentifierList } = require('./identifiers');
const { validateFilterOp, VALID_DIRECTIONS } = require('./policy');

function buildSelect({ schema, table, columns, where, order_by, limit }) {
  const errors = [];

  const schemaV = validateIdentifier(schema, 'schema');
  if (!schemaV.valid) errors.push(schemaV.message);

  const tableV = validateIdentifier(table, 'table');
  if (!tableV.valid) errors.push(tableV.message);

  if (columns) {
    const colsV = validateIdentifierList(columns, 'column');
    if (!colsV.valid) errors.push(colsV.message);
  }

  if (where) {
    for (const [col, filter] of Object.entries(where)) {
      const colV = validateIdentifier(col, 'column');
      if (!colV.valid) errors.push(colV.message);
      if (filter.op) {
        const opV = validateFilterOp(filter.op);
        if (!opV.valid) errors.push(opV.message);
      }
    }
  }

  if (errors.length > 0) {
    return { valid: false, error: 'VALIDATION_ERROR', message: errors.join('; ') };
  }

  const binds = {};
  let bindIdx = 0;
  const colList = columns && columns.length > 0 ? columns.join(', ') : '*';
  let sql = `SELECT ${colList} FROM ${schema}.${table}`;

  if (where && Object.keys(where).length > 0) {
    const conditions = [];
    for (const [col, filter] of Object.entries(where)) {
      const bName = `b${++bindIdx}`;
      if (filter.op === 'IS_NULL') {
        conditions.push(`${col} IS NULL`);
      } else if (filter.op === 'IS_NOT_NULL') {
        conditions.push(`${col} IS NOT NULL`);
      } else if (filter.op === 'IN' && Array.isArray(filter.value)) {
        const inBinds = filter.value.map((_, i) => `b${++bindIdx}`);
        conditions.push(`${col} IN (${inBinds.map(b => `:${b}`).join(', ')})`);
        inBinds.forEach((b, i) => { binds[b] = filter.value[i]; });
      } else {
        conditions.push(`${col} ${filter.op} :${bName}`);
        binds[bName] = filter.value;
      }
    }
    sql += ` WHERE ${conditions.join(' AND ')}`;
  }

  if (order_by && order_by.length > 0) {
    const orderParts = order_by.map(o => `${o.column} ${o.direction || 'ASC'}`);
    sql += ` ORDER BY ${orderParts.join(', ')}`;
  }

  sql += ` FETCH FIRST ${limit} ROWS ONLY`;

  return { valid: true, sql, binds, bindCount: Object.keys(binds).length };
}

function buildInsert({ schema, table, values }) {
  const errors = [];
  const schemaV = validateIdentifier(schema, 'schema');
  if (!schemaV.valid) errors.push(schemaV.message);
  const tableV = validateIdentifier(table, 'table');
  if (!tableV.valid) errors.push(tableV.message);

  if (!values || typeof values !== 'object' || Object.keys(values).length === 0) {
    errors.push('values object is required with at least one column');
  }

  if (errors.length > 0) {
    return { valid: false, error: 'VALIDATION_ERROR', message: errors.join('; ') };
  }

  const cols = Object.keys(values);
  const colsV = validateIdentifierList(cols, 'column');
  if (!colsV.valid) return { valid: false, error: 'VALIDATION_ERROR', message: colsV.message };

  const binds = {};
  const bindNames = cols.map((c, i) => {
    const bName = `b${i + 1}`;
    binds[bName] = values[c];
    return `:${bName}`;
  });

  const sql = `INSERT INTO ${schema}.${table} (${cols.join(', ')}) VALUES (${bindNames.join(', ')})`;
  return { valid: true, sql, binds, bindCount: Object.keys(binds).length };
}

function buildUpdate({ schema, table, set, where }) {
  const errors = [];
  const schemaV = validateIdentifier(schema, 'schema');
  if (!schemaV.valid) errors.push(schemaV.message);
  const tableV = validateIdentifier(table, 'table');
  if (!tableV.valid) errors.push(tableV.message);

  if (!set || typeof set !== 'object' || Object.keys(set).length === 0) {
    errors.push('set object is required with at least one column');
  }

  if (!where || typeof where !== 'object' || Object.keys(where).length === 0) {
    return { valid: false, error: 'POLICY_BLOCKED', message: 'UPDATE requires WHERE clause with at least one predicate' };
  }

  if (errors.length > 0) {
    return { valid: false, error: 'VALIDATION_ERROR', message: errors.join('; ') };
  }

  const binds = {};
  let bindIdx = 0;
  const setParts = Object.entries(set).map(([col, val]) => {
    const colV = validateIdentifier(col, 'column');
    if (!colV.valid) errors.push(colV.message);
    const bName = `b${++bindIdx}`;
    binds[bName] = val;
    return `${col} = :${bName}`;
  });

  const whereParts = [];
  for (const [col, filter] of Object.entries(where)) {
    const colV = validateIdentifier(col, 'column');
    if (!colV.valid) errors.push(colV.message);
    const bName = `b${++bindIdx}`;
    if (filter.op === 'IS_NULL') {
      whereParts.push(`${col} IS NULL`);
    } else if (filter.op === 'IS_NOT_NULL') {
      whereParts.push(`${col} IS NOT NULL`);
    } else {
      whereParts.push(`${col} ${filter.op} :${bName}`);
      binds[bName] = filter.value;
    }
  }

  if (errors.length > 0) {
    return { valid: false, error: 'VALIDATION_ERROR', message: errors.join('; ') };
  }

  const sql = `UPDATE ${schema}.${table} SET ${setParts.join(', ')} WHERE ${whereParts.join(' AND ')}`;
  return { valid: true, sql, binds, bindCount: Object.keys(binds).length };
}

function buildDdl({ action, schema, table, column, data_type }) {
  const { validateDdlAction, validateDatatype } = require('./policy');
  const actionV = validateDdlAction(action);
  if (!actionV.valid) return { valid: false, error: actionV.error, message: actionV.message };

  const errors = [];
  if (schema) { const v = validateIdentifier(schema, 'schema'); if (!v.valid) errors.push(v.message); }
  if (table) { const v = validateIdentifier(table, 'table'); if (!v.valid) errors.push(v.message); }
  if (column) { const v = validateIdentifier(column, 'column'); if (!v.valid) errors.push(v.message); }
  if (data_type) { const v = validateDatatype(data_type); if (!v.valid) errors.push(v.message); }
  if (errors.length > 0) return { valid: false, error: 'VALIDATION_ERROR', message: errors.join('; ') };

  let sql = '';
  if (action === 'CREATE_INDEX') {
    sql = `CREATE INDEX ${schema}.${table}_${column}_idx ON ${schema}.${table} (${column})`;
  } else if (action === 'ADD_COLUMN') {
    sql = `ALTER TABLE ${schema}.${table} ADD ${column} ${data_type || 'VARCHAR2(255)'}`;
  } else if (action === 'MODIFY_COLUMN') {
    sql = `ALTER TABLE ${schema}.${table} MODIFY ${column} ${data_type || 'VARCHAR2(255)'}`;
  }

  return { valid: true, sql, binds: {}, bindCount: 0, rollback: { available: false } };
}

module.exports = { buildSelect, buildInsert, buildUpdate, buildDdl };
