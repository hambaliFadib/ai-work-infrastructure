/**
 * Shared runtime utilities for AI-Work-Infra MCP servers.
 *
 * Provides: result envelope, error taxonomy, execution context, run ID,
 * redaction, and validation.
 *
 * Language-neutral contracts are in governance/schemas/.
 * This file is the Node.js implementation of those contracts.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// --- Error Taxonomy ---
const VALID_ERROR_CATEGORIES = [
  'VALIDATION_ERROR', 'CONFIG_ERROR', 'AUTH_REQUIRED',
  'DEPENDENCY_UNAVAILABLE', 'PERMISSION_DENIED', 'POLICY_BLOCKED',
  'EXECUTION_ERROR', 'TIMEOUT', 'INTERNAL_ERROR'
];

function isValidErrorCategory(category) {
  return VALID_ERROR_CATEGORIES.includes(category);
}

// --- Run ID ---
function newRunId() {
  // Random 32-char hex string, filename-safe, no UUID version claims
  return crypto.randomBytes(16).toString('hex');
}

// --- Result Envelope ---
function newResult({ operation, target = '', dryRun = false, runId = '', profile = '', environment = '', status = 'ok' } = {}) {
  if (!operation) throw new Error('operation is required');
  return {
    ok: status === 'ok',
    operation,
    target,
    dry_run: dryRun,
    run_id: runId || newRunId(),
    timestamp: new Date().toISOString(),
    profile,
    environment,
    status,
    summary: {},
    warnings: [],
    errors: [],
    evidence: {},
    rollback: null
  };
}

function addResultWarning(result, message) {
  result.warnings.push(message);
}

function addResultError(result, category, message) {
  if (!isValidErrorCategory(category)) {
    throw new Error(`Invalid error category: ${category}`);
  }
  result.errors.push({ category, message });
  result.ok = false;
  result.status = 'error';
}

function setResultStatus(result, status) {
  result.status = status;
  result.ok = status === 'ok';
}

// --- Result Validation ---
function validateResult(result) {
  const errors = [];
  if (!result || typeof result !== 'object') return { valid: false, errors: ['Result must be an object'] };
  if (typeof result.ok !== 'boolean') errors.push('ok must be boolean');
  if (typeof result.operation !== 'string' || !result.operation) errors.push('operation must be non-empty string');
  if (typeof result.status !== 'string') errors.push('status must be string');
  if (typeof result.dry_run !== 'boolean') errors.push('dry_run must be boolean');
  if (!Array.isArray(result.warnings)) errors.push('warnings must be array');
  if (!Array.isArray(result.errors)) errors.push('errors must be array');
  if (result.errors) {
    for (const e of result.errors) {
      if (!e.category || !isValidErrorCategory(e.category)) errors.push(`invalid error category: ${e.category}`);
      if (!e.message) errors.push('error message required');
    }
  }
  return { valid: errors.length === 0, errors };
}

// --- Redaction ---
const REDACT_PATTERNS = [
  /password\s*[=:]\s*\S+/gi,
  /token\s*[=:]\s*\S+/gi,
  /secret\s*[=:]\s*\S+/gi,
  /apikey\s*[=:]\s*\S+/gi,
  /api_key\s*[=:]\s*\S+/gi,
  /authorization\s*[=:]\s*\S+/gi,
  /credential\s*[=:]\s*\S+/gi,
  /Bearer\s+\S+/gi,
  /Basic\s+\S+/gi
];

function loadManagedSecretNames(contractPath) {
  try {
    const raw = fs.readFileSync(contractPath, 'utf8');
    const contract = JSON.parse(raw);
    if (!contract.variables) return [];
    return contract.variables
      .filter(v => v.sensitivity === 'SECRET')
      .map(v => v.name);
  } catch { return []; }
}

function protectSecrets(text, managedSecretNames = []) {
  let result = text;
  for (const pat of REDACT_PATTERNS) {
    result = result.replace(pat, m => m.replace(/\S+$/, '***'));
  }
  for (const name of managedSecretNames) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pat = new RegExp(`${escaped}\\s*[=:]\\s*\\S+`, 'gi');
    result = result.replace(pat, `${name}=***`);
  }
  return result;
}

// --- Validation ---
function testProfileName(name) {
  if (!name || name.length === 0) return true;
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) &&
         !name.includes('..') &&
         !/[\/\\]/.test(name) &&
         !/^[A-Za-z]:/.test(name);
}

function testOperationName(name) {
  return /^[A-Za-z][A-Za-z0-9_-]*$/.test(name);
}

// --- Execution Context ---
function newExecutionContext({ operation, profile = '', environment = '', dryRun = false, correlationId = '' } = {}) {
  if (!testOperationName(operation)) throw new Error(`Invalid operation name: ${operation}`);
  if (profile && !testProfileName(profile)) throw new Error(`Invalid profile name: ${profile}`);
  return {
    run_id: newRunId(),
    operation,
    timestamp: new Date().toISOString(),
    profile,
    environment,
    dry_run: dryRun,
    correlation_id: correlationId
  };
}

module.exports = {
  VALID_ERROR_CATEGORIES,
  isValidErrorCategory,
  newRunId,
  newResult,
  addResultWarning,
  addResultError,
  setResultStatus,
  validateResult,
  protectSecrets,
  loadManagedSecretNames,
  testProfileName,
  testOperationName,
  newExecutionContext
};
