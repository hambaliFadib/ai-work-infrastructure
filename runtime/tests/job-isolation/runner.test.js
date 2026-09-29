/**
 * Job Isolation runner infrastructure test — JIR01-JIR08.
 *
 * Tests the runner itself - NOT Job Isolation business behavior.
 *
 * No network. No DB. No env/profile access.
 * Fixture runtime state lives under the Git-ignored ./tmp root and is removed
 * by the owning invocation only.
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const { SUITE_REGISTRY, validateRegistry, runSuites, runSuite } = require('./run-all.js');

const TEST_DIR = __dirname;
const TMP_DIR = path.join(TEST_DIR, 'tmp');
const RUNNER_SOURCE = fs.readFileSync(path.join(TEST_DIR, 'run-all.js'), 'utf8');

let passed = 0;
let failed = 0;

function test(label, fn) {
  try {
    fn();
    passed += 1;
    console.log(`${label}: PASS`);
  } catch (e) {
    failed += 1;
    console.log(`${label}: FAIL - ${e.message}`);
  }
}

// JIR01 — exact registry = 4, canonical order, all required
test('JIR01', () => {
  assert.ok(Array.isArray(SUITE_REGISTRY));
  assert.strictEqual(SUITE_REGISTRY.length, 4);
  assert.deepStrictEqual(SUITE_REGISTRY.map((s) => s.name), ['contract', 'runner', 'job-contract', 'namespace-derivation']);
  for (const suite of SUITE_REGISTRY) {
    assert.strictEqual(suite.required, true, `${suite.name} must be required`);
  }
});

// JIR02 — contract suite required
test('JIR02', () => {
  const entry = SUITE_REGISTRY.find((s) => s.name === 'contract');
  assert.ok(entry, 'contract suite must be registered');
  assert.strictEqual(entry.file, 'contract.test.js');
  assert.strictEqual(entry.required, true);
});

// JIR03 — runner suite required
test('JIR03', () => {
  const entry = SUITE_REGISTRY.find((s) => s.name === 'runner');
  assert.ok(entry, 'runner suite must be registered');
  assert.strictEqual(entry.file, 'runner.test.js');
  assert.strictEqual(entry.required, true);
});

// JIR04 — only relative repository-safe test paths
test('JIR04', () => {
  for (const suite of SUITE_REGISTRY) {
    assert.ok(!path.isAbsolute(suite.file), `absolute path not allowed: ${suite.file}`);
    assert.ok(!suite.file.includes('..'), `parent traversal not allowed: ${suite.file}`);
    assert.ok(!suite.file.includes('/'), `subdirectory not allowed: ${suite.file}`);
    assert.ok(!suite.file.includes('\\'), `subdirectory not allowed: ${suite.file}`);
  }
  const errors = validateRegistry([{ name: 'evil', file: '../evil.test.js', required: true }]);
  assert.ok(errors.length > 0, 'unsafe path must be rejected');
});

// JIR05 — no glob/dynamic discovery
test('JIR05', () => {
  assert.ok(!RUNNER_SOURCE.includes('readdir'));
  assert.ok(!RUNNER_SOURCE.includes('globSync'));
  assert.ok(!RUNNER_SOURCE.includes("require('glob')"));
  assert.ok(!RUNNER_SOURCE.includes('require("glob")'));
  assert.ok(RUNNER_SOURCE.includes('SUITE_REGISTRY'));
});

// JIR06 — missing required suite fails
test('JIR06', () => {
  const result = runSuite({ name: 'missing', file: 'definitely-missing.test.js', required: true });
  assert.strictEqual(result.status, 'FAIL');
});

// JIR07 — duplicate suite registration fails
test('JIR07', () => {
  const errors = validateRegistry([
    { name: 'dup', file: 'dup.test.js', required: true },
    { name: 'dup', file: 'dup.test.js', required: true },
  ]);
  assert.ok(errors.length > 0, 'duplicate registration must be rejected');
});

// JIR08 — deterministic execution order contract -> runner
test('JIR08', () => {
  assert.ok(RUNNER_SOURCE.includes('for (const suite of registry)'), 'runner must iterate the registry sequentially');
  fs.mkdirSync(TMP_DIR, { recursive: true });
  const relativeDir = `tmp/runner-${process.pid}`;
  const dir = path.join(TEST_DIR, relativeDir);
  fs.mkdirSync(dir, { recursive: true });
  try {
    fs.writeFileSync(path.join(dir, 'first.test.js'), 'console.log("FIRST"); process.exit(0);');
    fs.writeFileSync(path.join(dir, 'second.test.js'), 'console.log("SECOND"); process.exit(0);');
    const registry = [
      { name: 'first', file: `${relativeDir}/first.test.js`, required: true },
      { name: 'second', file: `${relativeDir}/second.test.js`, required: true },
    ];
    const results = runSuites(registry);
    assert.strictEqual(results.length, 2);
    assert.strictEqual(results[0].name, 'first');
    assert.strictEqual(results[0].status, 'PASS');
    assert.strictEqual(results[1].name, 'second');
    assert.strictEqual(results[1].status, 'PASS');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

console.log('');
console.log(`Cases: ${passed + failed}`);
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);

process.exit(failed > 0 ? 1 : 0);
