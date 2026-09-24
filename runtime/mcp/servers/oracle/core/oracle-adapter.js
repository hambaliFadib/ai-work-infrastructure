/**
 * Oracle Adapter Interface — contract for real and synthetic adapters.
 */

class OracleAdapter {
  constructor() {
    this.execute_count = 0;
    this.commit_count = 0;
    this.rollback_count = 0;
    this.connect_count = 0;
    this.close_count = 0;
    this.last_sql = null;
    this.last_binds = null;
  }

  connect(profile) { this.connect_count++; return this; }
  execute(sql, binds) { this.execute_count++; this.last_sql = sql; this.last_binds = binds; return { affected_rows: 0, rows: [] }; }
  commit() { this.commit_count++; }
  rollback() { this.rollback_count++; }
  close() { this.close_count++; }
  reset() {
    this.execute_count = 0;
    this.commit_count = 0;
    this.rollback_count = 0;
    this.connect_count = 0;
    this.close_count = 0;
    this.last_sql = null;
    this.last_binds = null;
  }
}

class SyntheticAdapter extends OracleAdapter {
  constructor() {
    super();
    this._rows = [];
    this._affectedRows = 0;
  }

  setRows(rows) { this._rows = rows; this._affectedRows = rows.length; return this; }

  execute(sql, binds) {
    super.execute(sql, binds);
    return { affected_rows: this._affectedRows, rows: this._rows };
  }
}

class RealOracleAdapter extends OracleAdapter {
  constructor() {
    super();
    this._connection = null;
    this._oracledb = null;
  }

  async init(mode = 'thin') {
    this._oracledb = require('oracledb');
    if (mode === 'thick' && process.env.ORACLE_CLIENT_DIR) {
      this._oracledb.initOracleClient({ libDir: process.env.ORACLE_CLIENT_DIR });
    }
    this._oracledb.outFormat = this._oracledb.OUT_FORMAT_OBJECT;
    return this;
  }

  async connect(profile, config) {
    if (!this._oracledb) await this.init(config?.mode || 'thin');
    this._connection = await this._oracledb.getConnection({
      user: config.user,
      password: config.password,
      connectString: config.connection_string
    });
    this.connect_count++;
    return this;
  }

  async execute(sql, binds) {
    if (!this._connection) throw new Error('Not connected');
    const result = await this._connection.execute(sql, binds || {});
    this.execute_count++;
    this.last_sql = sql;
    this.last_binds = binds;
    return { affected_rows: result.rowsAffected || 0, rows: result.rows || [] };
  }

  async commit() {
    if (this._connection) await this._connection.commit();
    this.commit_count++;
  }

  async rollback() {
    if (this._connection) await this._connection.rollback();
    this.rollback_count++;
  }

  async close() {
    if (this._connection) {
      await this._connection.close();
      this._connection = null;
    }
    this.close_count++;
  }
}

module.exports = { OracleAdapter, SyntheticAdapter, RealOracleAdapter };
