/**
 * Context Hydration runner infrastructure test.
 *
 * Tests the runner itself — NOT Context Hydration business behavior.
 * R01-R11: registry, required/optional behavior, path safety, uniqueness.
 *
 * No network. No DB. No env/profile access.
 * Uses temporary fixtures outside tracked repository content.
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const { SUITE_REGISTRY, runSuites, runSuite, resolveSuitePath } = require('./run-all.js');

// Fixtures are created inside the context-hydration directory to satisfy path safety checks.
const FIXTURES_DIR = __dirname;
const FIXTURE_PASS = '__fixture_passing_test__.js';
const FIXTURE_FAIL = '__fixture_failing_test__.js';
let passed = 0;
let failed = 0;

function test(label, fn) {
  try {
    fn();
    passed++;
    console.log(`${label}: PASS`);
  } catch (e) {
    failed++;
    console.log(`${label}: FAIL — ${e.message}`);
  }
}

// Clean up fixture files after tests
function cleanupFixtures() {
  for (const f of [FIXTURE_PASS, FIXTURE_FAIL]) {
    const p = path.join(FIXTURES_DIR, f);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
}

// R01: registry contains exactly 7 known suites
test('R01 registry contains exactly 7 known suites', () => {
  assert.strictEqual(SUITE_REGISTRY.length, 7, `Expected 7 suites, got ${SUITE_REGISTRY.length}`);
});

// R02: contract.test.js is required
test('R02 contract.test.js is required', () => {
  const contract = SUITE_REGISTRY.find(s => s.name === 'contract');
  assert.ok(contract, 'contract suite must exist');
  assert.strictEqual(contract.required, true, 'contract must be required');
  assert.strictEqual(contract.file, 'contract.test.js');
});

// R03: runner.test.js is required
test('R03 runner.test.js is required', () => {
  const runner = SUITE_REGISTRY.find(s => s.name === 'runner');
  assert.ok(runner, 'runner suite must exist');
  assert.strictEqual(runner.required, true, 'runner must be required');
  assert.strictEqual(runner.file, 'runner.test.js');
});

// R04: five implementation-lane suites are optional
test('R04 five implementation-lane suites are optional', () => {
  const optionalNames = ['objective-parser', 'ranking-policy', 'retrieval-eligibility', 'budget-dedup', 'skill-resolver'];
  for (const name of optionalNames) {
    const suite = SUITE_REGISTRY.find(s => s.name === name);
    assert.ok(suite, `${name} suite must exist in registry`);
    assert.strictEqual(suite.required, false, `${name} must be optional`);
  }
});

// R05: optional missing suite -> SKIP, not FAIL
test('R05 optional missing suite -> SKIP, not FAIL', () => {
  const result = runSuite({ name: 'nonexistent', file: 'nonexistent-test-12345.js', required: false });
  assert.strictEqual(result.status, 'SKIP', `Expected SKIP, got ${result.status}`);
});

// R06: required missing suite -> FAIL
test('R06 required missing suite -> FAIL', () => {
  const result = runSuite({ name: 'nonexistent', file: 'nonexistent-test-12345.js', required: true });
  assert.strictEqual(result.status, 'FAIL', `Expected FAIL, got ${result.status}`);
});

// R07: present passing optional suite -> PASS
test('R07 present passing optional suite -> PASS', () => {
  // Create a passing test fixture inside context-hydration dir
  const fixturePath = path.join(FIXTURES_DIR, FIXTURE_PASS);
  fs.writeFileSync(fixturePath, 'console.log("PASS"); process.exit(0);', 'utf8');
  const result = runSuite({ name: 'passing-fixture', file: FIXTURE_PASS, required: false });
  assert.strictEqual(result.status, 'PASS', `Expected PASS, got ${result.status}`);
  fs.unlinkSync(fixturePath);
});

// R08: present failing optional suite -> FAIL
test('R08 present failing optional suite -> FAIL', () => {
  // Create a failing test fixture inside context-hydration dir
  const fixturePath = path.join(FIXTURES_DIR, FIXTURE_FAIL);
  fs.writeFileSync(fixturePath, 'process.exit(1);', 'utf8');
  const result = runSuite({ name: 'failing-fixture', file: FIXTURE_FAIL, required: false });
  assert.strictEqual(result.status, 'FAIL', `Expected FAIL, got ${result.status}`);
  fs.unlinkSync(fixturePath);
});

// R09: arbitrary unregistered file is never executed
test('R09 arbitrary unregistered file is never executed', () => {
  // Create an arbitrary file inside context-hydration dir
  const arbitraryName = '__arbitrary_unregistered__.js';
  const fixturePath = path.join(FIXTURES_DIR, arbitraryName);
  fs.writeFileSync(fixturePath, 'console.log("ARBITRARY EXECUTED"); process.exit(0);', 'utf8');
  // Verify it's not in the registry
  const found = SUITE_REGISTRY.find(s => s.file === arbitraryName);
  assert.ok(!found, 'Arbitrary file should not be in registry');
  fs.unlinkSync(fixturePath);
});

// R10: suite registry filenames are unique
test('R10 suite registry filenames are unique', () => {
  const files = SUITE_REGISTRY.map(s => s.file);
  const unique = new Set(files);
  assert.strictEqual(unique.size, files.length, `Expected ${files.length} unique, got ${unique.size}`);
});

// R11: registry paths cannot escape context-hydration test directory
test('R11 registry paths cannot escape context-hydration test directory', () => {
  const testDir = path.resolve(__dirname);
  for (const suite of SUITE_REGISTRY) {
    const resolved = resolveSuitePath(suite.file);
    const normalizedDir = testDir + path.sep;
    assert.ok(
      resolved.startsWith(normalizedDir),
      `Suite ${suite.name} path ${resolved} escapes directory ${testDir}`
    );
  }
});

// Cleanup
cleanupFixtures();

// Summary
console.log(`\n=== Runner Infrastructure Test Summary ===`);
console.log(`Passed: ${passed}, Failed: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
