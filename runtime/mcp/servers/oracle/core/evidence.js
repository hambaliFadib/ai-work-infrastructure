/**
 * Oracle Evidence — structured result envelope, ledger path, redaction.
 */

const path = require('path');
const { newResult, addResultWarning, protectSecrets } = require('../../../../mcp/lib/runtime-utils');

function createOracleResult({ operation, profile, schema, table, dryRun, runId }) {
  const result = newResult({
    operation,
    target: schema && table ? `${schema}.${table}` : '',
    dryRun,
    runId,
    profile
  });
  result.evidence = {
    schema: schema || null,
    table: table || null,
    dry_run: dryRun,
    commit_requested: false,
    bind_count: 0,
    row_limit: null,
    affected_row_estimate: null
  };
  result.rollback = null;
  return result;
}

function getLedgerPath(profile, runId) {
  const safeName = profile.replace(/[^a-zA-Z0-9._-]/g, '_');
  return path.join('runtime', 'ledger', 'oracle', safeName, `${runId}.json`);
}

function sanitizeEvidence(result, managedSecretNames = []) {
  const serialized = JSON.stringify(result);
  const redacted = protectSecrets(serialized, managedSecretNames);
  return JSON.parse(redacted);
}

module.exports = { createOracleResult, getLedgerPath, sanitizeEvidence };
