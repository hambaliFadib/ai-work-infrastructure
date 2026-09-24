/**
 * Oracle Transaction Semantics — dry-run, commit, rollback contracts.
 */

const { newResult, addResultError, addResultWarning } = require('../../../../mcp/lib/runtime-utils');

function createTransactionContext({ dryRun = true, commit = false } = {}) {
  return {
    dry_run: dryRun,
    commit: commit,
    execute_count: 0,
    commit_count: 0,
    rollback_count: 0
  };
}

function executeInTransaction(txn, adapter, sql, binds) {
  if (txn.dry_run) {
    txn.execute_count++;
    return { ok: true, affected_rows: 0, message: 'dry_run — no execution' };
  }
  const result = adapter.execute(sql, binds);
  txn.execute_count++;
  if (!txn.commit) {
    txn.rollback_count++;
    adapter.rollback();
    return { ok: true, affected_rows: result.affected_rows, message: 'executed and rolled back (commit=false)' };
  }
  txn.commit_count++;
  adapter.commit();
  return { ok: true, affected_rows: result.affected_rows, message: 'executed and committed' };
}

function getRollbackInfo(operation) {
  if (operation === 'ddl') {
    return { available: false, reason: 'DDL may auto-commit in Oracle; no transactional rollback' };
  }
  return { available: false, reason: 'post-commit rollback not supported; use before-image evidence for compensation' };
}

module.exports = { createTransactionContext, executeInTransaction, getRollbackInfo };
