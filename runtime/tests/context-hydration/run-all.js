/**
 * Context Hydration test runner — runs all deterministic Context Hydration tests.
 * Exit 0 = all pass, non-zero = any failure.
 * No network. No DB. No install.
 *
 * Uses an explicit suite registry. No glob. No directory scan.
 * Required suites fail if missing. Optional suites skip if missing.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

/**
 * Explicit suite registry.
 * required: true  — suite MUST exist, missing = FAIL
 * required: false — suite MAY exist, missing = SKIP
 */
const SUITE_REGISTRY = [
  { name: 'contract',                file: 'contract.test.js',              required: true  },
  { name: 'runner',                  file: 'runner.test.js',                required: true  },
  { name: 'objective-parser',        file: 'objective-parser.test.js',      required: false },
  { name: 'ranking-policy',          file: 'ranking-policy.test.js',        required: false },
  { name: 'retrieval-eligibility',   file: 'retrieval-eligibility.test.js', required: false },
  { name: 'budget-dedup',            file: 'budget-dedup.test.js',          required: false },
  { name: 'skill-resolver',          file: 'skill-resolver.test.js',        required: false },
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
    throw new Error(`Suite path escapes context-hydration directory: ${filename}`);
  }
  return resolved;
}

/**
 * Run a single suite. Returns { name, status, output }.
 * status: 'PASS' | 'SKIP' | 'FAIL'
 */
function runSuite(suite) {
  const suitePath = resolveSuitePath(suite.file);
  const exists = fs.existsSync(suitePath);

  if (!exists) {
    if (suite.required) {
      return { name: suite.name, status: 'FAIL', output: `Required suite missing: ${suite.file}` };
    }
    return { name: suite.name, status: 'SKIP', output: `${suite.file} — not implemented yet` };
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
 * Run all registered suites. Returns summary object.
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
  let passed = 0;
  let skipped = 0;
  let failed = 0;

  console.log('');
  for (const r of results) {
    if (r.status === 'PASS') {
      console.log(`PASS ${r.name}`);
      executed++;
      passed++;
    } else if (r.status === 'SKIP') {
      console.log(`SKIP ${r.name} — ${r.output}`);
      skipped++;
    } else {
      console.log(`FAIL ${r.name}`);
      console.log(r.output);
      executed++;
      failed++;
    }
  }

  console.log('');
  console.log('=== Context Hydration Test Summary ===');
  console.log(`registered: ${results.length}`);
  console.log(`executed:   ${executed}`);
  console.log(`passed:     ${passed}`);
  console.log(`skipped:    ${skipped}`);
  console.log(`failed:     ${failed}`);

  return { failed };
}

/**
 * Main entry point.
 */
function main() {
  const results = runSuites(SUITE_REGISTRY);
  const { failed } = printResults(results);
  process.exit(failed > 0 ? 1 : 0);
}

// Only run when executed directly, not when required.
if (require.main === module) {
  main();
}

module.exports = { SUITE_REGISTRY, runSuites, runSuite, resolveSuitePath, main };
