/**
 * Job Isolation test runner — runs all deterministic Job Isolation contract tests.
 * Exit 0 = all pass, non-zero = any failure.
 * No network. No DB. No install.
 *
 * Uses an explicit suite registry. No glob. No directory scan.
 * All registered suites are required: a missing suite is a FAILURE.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

/**
 * Explicit suite registry. All suites are required.
 */
const SUITE_REGISTRY = [
  { name: 'contract', file: 'contract.test.js', required: true },
  { name: 'runner', file: 'runner.test.js', required: true },
  { name: 'job-contract', file: 'job-contract.test.js', required: true },
  { name: 'namespace-derivation', file: 'namespace-derivation.test.js', required: true },
  { name: 'parallel-lane', file: 'parallel-lane.test.js', required: true },
  { name: 'namespace-isolation', file: 'namespace-isolation.test.js', required: true },
  { name: 'knowledge-scope', file: 'knowledge-scope.test.js', required: true },
  { name: 'integration', file: 'integration.test.js', required: true },
];

const DIR = __dirname;

/**
 * Resolve and validate suite path stays inside the expected directory.
 * Never accepts arbitrary input from environment.
 */
function resolveSuitePath(filename) {
  const resolved = path.resolve(DIR, filename);
  const normalizedDir = path.resolve(DIR) + path.sep;
  if (!resolved.startsWith(normalizedDir)) {
    throw new Error(`Suite path escapes job-isolation directory: ${filename}`);
  }
  return resolved;
}

/**
 * Validate a registry deterministically.
 * Returns an array of error strings (empty = valid).
 */
function validateRegistry(registry) {
  const errors = [];
  if (!Array.isArray(registry) || registry.length === 0) {
    return ['registry must be a non-empty array'];
  }
  const names = new Set();
  const files = new Set();
  for (const suite of registry) {
    if (!suite || typeof suite.name !== 'string' || suite.name.length === 0) {
      errors.push('suite name must be a non-empty string');
      continue;
    }
    if (typeof suite.file !== 'string' || suite.file.length === 0) {
      errors.push(`suite file must be a non-empty string: ${suite.name}`);
      continue;
    }
    if (names.has(suite.name)) errors.push(`duplicate suite name: ${suite.name}`);
    if (files.has(suite.file)) errors.push(`duplicate suite file: ${suite.file}`);
    names.add(suite.name);
    files.add(suite.file);
    if (typeof suite.required !== 'boolean') errors.push(`required flag must be boolean: ${suite.name}`);
    if (path.isAbsolute(suite.file) || suite.file.includes('..') || suite.file.includes('/') || suite.file.includes('\\')) {
      errors.push(`unsafe suite path: ${suite.file}`);
    }
  }
  return errors;
}

/**
 * Run a single suite. Returns { name, status, output }.
 * status: 'PASS' | 'FAIL'
 * All suites are required: a missing suite fails.
 */
function runSuite(suite) {
  const suitePath = resolveSuitePath(suite.file);
  if (!fs.existsSync(suitePath)) {
    return { name: suite.name, status: 'FAIL', output: `Required suite missing: ${suite.file}` };
  }
  try {
    const output = execSync(`node "${suitePath}"`, { encoding: 'utf8', stdio: 'pipe' });
    return { name: suite.name, status: 'PASS', output };
  } catch (e) {
    const stdout = e.stdout || '';
    const stderr = e.stderr || '';
    return { name: suite.name, status: 'FAIL', output: stdout + stderr };
  }
}

/**
 * Run all registered suites in registry order. Returns array of results.
 */
function runSuites(registry) {
  const results = [];
  for (const suite of registry) {
    results.push(runSuite(suite));
  }
  return results;
}

/**
 * Print results and compute summary.
 */
function printResults(results) {
  let executed = 0;
  let passedCount = 0;
  const skipped = 0;
  let failedCount = 0;

  console.log('');
  for (const r of results) {
    if (r.status === 'PASS') {
      console.log(`PASS ${r.name}`);
      executed += 1;
      passedCount += 1;
    } else {
      console.log(`FAIL ${r.name}`);
      console.log(r.output);
      executed += 1;
      failedCount += 1;
    }
  }

  console.log('');
  console.log('=== Job Isolation Contract Test Summary ===');
  console.log(`registered: ${results.length}`);
  console.log(`executed:   ${executed}`);
  console.log(`passed:     ${passedCount}`);
  console.log(`skipped:    ${skipped}`);
  console.log(`failed:     ${failedCount}`);

  return { failed: failedCount };
}

/**
 * Main entry point.
 */
function main() {
  const registryErrors = validateRegistry(SUITE_REGISTRY);
  if (registryErrors.length > 0) {
    for (const err of registryErrors) console.error(`registry error: ${err}`);
    process.exit(1);
  }
  const results = runSuites(SUITE_REGISTRY);
  const summary = printResults(results);
  process.exit(summary.failed > 0 ? 1 : 0);
}

// Only run when executed directly, not when required.
if (require.main === module) {
  main();
}

module.exports = { SUITE_REGISTRY, validateRegistry, runSuites, runSuite, resolveSuitePath, main };
