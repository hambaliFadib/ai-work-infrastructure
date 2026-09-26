/**
 * Context Hydration runner infrastructure test.
 *
 * Tests the runner itself — NOT Context Hydration business behavior.
 * R01-R13: registry, required/optional behavior, path safety, uniqueness,
 * per-invocation fixture isolation, and concurrent-process safety.
 *
 * No network. No DB. No env/profile access.
 * Fixtures are per-invocation unique inside the context-hydration directory
 * and are removed only by the invocation that created them.
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const crypto = require('crypto');
const { spawn } = require('child_process');

const { SUITE_REGISTRY, runSuites, runSuite, resolveSuitePath } = require('./run-all.js');

// Fixtures are created inside the context-hydration directory to satisfy path safety checks.
const FIXTURES_DIR = __dirname;
const WORKER_FLAG = '--fixture-worker';

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

/**
 * Per-invocation fixture namespace.
 * process.pid + crypto.randomUUID() guarantee no two concurrent invocations
 * in the same checkout share fixture paths (PR #23 review comment 4111937898).
 */
function createInvocationNamespace() {
  const token = `${process.pid}_${crypto.randomUUID()}`;
  return {
    token,
    pass: `__runner_fixture_${token}_pass.js`,
    fail: `__runner_fixture_${token}_fail.js`,
  };
}

/**
 * Resolve a fixture filename, refusing anything outside the fixture directory.
 */
function fixturePath(name) {
  const resolved = path.resolve(FIXTURES_DIR, name);
  const normalizedDir = path.resolve(FIXTURES_DIR) + path.sep;
  if (!resolved.startsWith(normalizedDir)) {
    throw new Error(`Fixture path escapes context-hydration directory: ${name}`);
  }
  return resolved;
}

/**
 * Create an owned fixture file. Returns its absolute path for exact cleanup.
 */
function writeOwnedFixture(name, content) {
  const ownedPath = fixturePath(name);
  fs.writeFileSync(ownedPath, content, 'utf8');
  return ownedPath;
}

/**
 * Remove exactly the given owned fixture paths.
 * Never scans or globs — an invocation may delete only what it created.
 */
function removeOwnedFixtures(ownedPaths) {
  for (const ownedPath of ownedPaths) {
    if (fs.existsSync(ownedPath)) fs.unlinkSync(ownedPath);
  }
}

/**
 * Internal worker mode used by R13.
 * Creates one unique passing fixture, runs it through runSuite(), asserts PASS,
 * removes only its own fixture, and reports the fixture name on stdout.
 * Never runs the R01+ suite recursively.
 */
function runFixtureWorker() {
  const ownedPaths = [];
  let ok = false;
  try {
    const namespace = createInvocationNamespace();
    ownedPaths.push(writeOwnedFixture(namespace.pass, 'console.log("WORKER PASS"); process.exit(0);'));
    const result = runSuite({ name: 'concurrent-fixture', file: namespace.pass, required: false });
    ok = result.status === 'PASS';
    if (ok) {
      console.log(`fixture-worker PASS ${namespace.pass}`);
    } else {
      console.error(`fixture-worker FAIL expected PASS got ${result.status}`);
    }
  } finally {
    removeOwnedFixtures(ownedPaths);
  }
  return ok;
}

// Worker mode must run before any R01+ test executes — never recursively.
if (process.argv.includes(WORKER_FLAG)) {
  process.exit(runFixtureWorker() ? 0 : 1);
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
  // Create a per-invocation passing test fixture inside context-hydration dir
  const namespace = createInvocationNamespace();
  const ownedPath = writeOwnedFixture(namespace.pass, 'console.log("PASS"); process.exit(0);');
  try {
    const result = runSuite({ name: 'passing-fixture', file: namespace.pass, required: false });
    assert.strictEqual(result.status, 'PASS', `Expected PASS, got ${result.status}`);
  } finally {
    removeOwnedFixtures([ownedPath]);
  }
});

// R08: present failing optional suite -> FAIL
test('R08 present failing optional suite -> FAIL', () => {
  // Create a per-invocation failing test fixture inside context-hydration dir
  const namespace = createInvocationNamespace();
  const ownedPath = writeOwnedFixture(namespace.fail, 'process.exit(1);');
  try {
    const result = runSuite({ name: 'failing-fixture', file: namespace.fail, required: false });
    assert.strictEqual(result.status, 'FAIL', `Expected FAIL, got ${result.status}`);
  } finally {
    removeOwnedFixtures([ownedPath]);
  }
});

// R09: arbitrary unregistered file is never executed
test('R09 arbitrary unregistered file is never executed', () => {
  // Create a per-invocation arbitrary file inside context-hydration dir
  const namespace = createInvocationNamespace();
  const arbitraryName = `__runner_fixture_${namespace.token}_arbitrary.js`;
  const ownedPath = writeOwnedFixture(arbitraryName, 'console.log("ARBITRARY EXECUTED"); process.exit(0);');
  try {
    // Verify it's not in the registry
    const found = SUITE_REGISTRY.find(s => s.file === arbitraryName);
    assert.ok(!found, 'Arbitrary file should not be in registry');
  } finally {
    removeOwnedFixtures([ownedPath]);
  }
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

// R12: independent invocations generate distinct fixture names
test('R12 independent invocations generate distinct fixture names', () => {
  const first = createInvocationNamespace();
  const second = createInvocationNamespace();
  assert.notStrictEqual(first.token, second.token, 'invocation tokens must be unique');
  assert.notStrictEqual(first.pass, second.pass, 'pass fixture names must differ between invocations');
  assert.notStrictEqual(first.fail, second.fail, 'fail fixture names must differ between invocations');
  const normalizedDir = path.resolve(FIXTURES_DIR) + path.sep;
  for (const name of [first.pass, first.fail, second.pass, second.fail]) {
    assert.ok(!name.includes('..'), `${name} must not contain path traversal`);
    assert.ok(!path.isAbsolute(name), `${name} must be a bare filename`);
    const resolved = fixturePath(name);
    assert.ok(resolved.startsWith(normalizedDir), `${name} must stay inside ${FIXTURES_DIR}`);
  }
});

// Async tests run after the synchronous R01-R12 block.
const asyncTests = [];
function testAsync(label, fn) {
  asyncTests.push({ label, fn });
}

// R13: concurrent processes cannot collide on fixture names
// Guards the P1 from PR #23 review comment 4111937898.
testAsync('R13 concurrent fixture workers pass without collision', async () => {
  const WORKER_COUNT = 8;
  const workerScript = path.join(FIXTURES_DIR, 'runner.test.js');
  const runs = [];
  for (let i = 0; i < WORKER_COUNT; i++) {
    runs.push(new Promise((resolve) => {
      const child = spawn(process.execPath, [workerScript, WORKER_FLAG], {
        cwd: FIXTURES_DIR,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('error', (err) => resolve({ code: -1, stdout, stderr: `${stderr}${err.message}` }));
      child.on('close', (code) => resolve({ code, stdout, stderr }));
    }));
  }

  const results = await Promise.all(runs);
  const failures = results.filter((r) => r.code !== 0);
  const firstFailure = failures.length ? (failures[0].stderr || failures[0].stdout || `exit ${failures[0].code}`) : '';
  assert.strictEqual(
    failures.length,
    0,
    `${WORKER_COUNT - failures.length}/${WORKER_COUNT} workers exited 0; first failure: ${firstFailure}`
  );

  const reportedNames = results.map((r) => {
    const match = r.stdout.match(/fixture-worker PASS (\S+\.js)/);
    return match ? match[1] : null;
  });
  const missing = reportedNames.filter((name) => !name);
  assert.strictEqual(missing.length, 0, `${missing.length}/${WORKER_COUNT} workers did not report a fixture name`);
  assert.strictEqual(new Set(reportedNames).size, WORKER_COUNT, 'worker fixture names must be unique across processes');

  // No owned worker fixture may remain after the workers exited.
  for (const name of reportedNames) {
    assert.ok(!fs.existsSync(fixturePath(name)), `owned worker fixture left behind: ${name}`);
  }
});

async function main() {
  for (const { label, fn } of asyncTests) {
    try {
      await fn();
      passed++;
      console.log(`${label}: PASS`);
    } catch (e) {
      failed++;
      console.log(`${label}: FAIL — ${e.message}`);
    }
  }

  // Summary
  console.log(`\n=== Runner Infrastructure Test Summary ===`);
  console.log(`Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(`FATAL: ${e.message}`);
  process.exit(1);
});
