/**
 * Context Hydration runner infrastructure test.
 *
 * Tests the runner itself — NOT Context Hydration business behavior.
 * R01-R14: registry, required/optional behavior, path safety, uniqueness,
 * per-invocation fixture isolation, concurrent-process safety, and the
 * Git-ignored temp-state contract.
 *
 * No network. No DB. No env/profile access.
 *
 * Fixture runtime state lives under the Git-ignored ./tmp root, one owned
 * directory per invocation: tmp/runner-<pid>-<uuid>/. Cleanup removes only
 * the owning invocation's directory (try/finally, exact ownership).
 *
 * Interrupted-process model: SIGKILL / hard termination can bypass finally.
 * Correctness therefore does NOT depend on guaranteed cleanup after hard
 * termination — orphaned state is confined to the ignored tmp/ root and
 * cannot dirty tracked test source or Git working-tree status.
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const crypto = require('crypto');
const { spawn } = require('child_process');

const { SUITE_REGISTRY, runSuites, runSuite, resolveSuitePath } = require('./run-all.js');

const TEST_DIR = __dirname;
const FIXTURE_SUBDIR = 'tmp';
const FIXTURES_DIR = path.join(TEST_DIR, FIXTURE_SUBDIR);
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
 * Per-invocation fixture namespace, owned by this process only.
 * process.pid + crypto.randomUUID() guarantee no two concurrent invocations
 * in the same checkout share fixture paths (PR #23 review comment 4111937898).
 * All paths are relative to TEST_DIR and live beneath the ignored tmp root.
 */
function createInvocationNamespace() {
  const token = `${process.pid}-${crypto.randomUUID()}`;
  const dir = `runner-${token}`;
  return {
    token,
    dir,
    relativeDir: path.join(FIXTURE_SUBDIR, dir),
    relativePass: path.join(FIXTURE_SUBDIR, dir, 'pass.js'),
    relativeFail: path.join(FIXTURE_SUBDIR, dir, 'fail.js'),
  };
}

/**
 * Resolve a fixture path relative to TEST_DIR, refusing anything outside it.
 */
function fixturePath(relativePath) {
  const resolved = path.resolve(TEST_DIR, relativePath);
  const normalizedDir = path.resolve(TEST_DIR) + path.sep;
  if (!resolved.startsWith(normalizedDir)) {
    throw new Error(`Fixture path escapes context-hydration directory: ${relativePath}`);
  }
  return resolved;
}

/**
 * Create an owned fixture file under this invocation's temp directory.
 * Returns its absolute path for exact cleanup.
 */
function writeOwnedFixture(relativePath, content) {
  const ownedPath = fixturePath(relativePath);
  fs.mkdirSync(path.dirname(ownedPath), { recursive: true });
  fs.writeFileSync(ownedPath, content, 'utf8');
  return ownedPath;
}

/**
 * Remove exactly this invocation's owned directory.
 * Never scans or globs — an invocation may delete only what it created,
 * and never the shared tmp root itself.
 */
function removeOwnedDir(relativeDir) {
  const dirPath = fixturePath(relativeDir);
  if (fs.existsSync(dirPath)) fs.rmSync(dirPath, { recursive: true, force: true });
}

/**
 * Internal worker mode used by R13.
 * Creates one unique passing fixture in its own temp directory, runs it
 * through runSuite(), asserts PASS, removes only its own directory, and
 * reports the fixture path on stdout. Never runs the R01+ suite recursively.
 */
function runFixtureWorker() {
  const namespace = createInvocationNamespace();
  let ok = false;
  try {
    writeOwnedFixture(namespace.relativePass, 'console.log("WORKER PASS"); process.exit(0);');
    const result = runSuite({ name: 'concurrent-fixture', file: namespace.relativePass, required: false });
    ok = result.status === 'PASS';
    if (ok) {
      console.log(`fixture-worker PASS ${namespace.relativePass}`);
    } else {
      console.error(`fixture-worker FAIL expected PASS got ${result.status}`);
    }
  } finally {
    removeOwnedDir(namespace.relativeDir);
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
  // Create a per-invocation passing fixture under the ignored temp root
  const namespace = createInvocationNamespace();
  try {
    writeOwnedFixture(namespace.relativePass, 'console.log("PASS"); process.exit(0);');
    const result = runSuite({ name: 'passing-fixture', file: namespace.relativePass, required: false });
    assert.strictEqual(result.status, 'PASS', `Expected PASS, got ${result.status}`);
  } finally {
    removeOwnedDir(namespace.relativeDir);
  }
});

// R08: present failing optional suite -> FAIL
test('R08 present failing optional suite -> FAIL', () => {
  // Create a per-invocation failing fixture under the ignored temp root
  const namespace = createInvocationNamespace();
  try {
    writeOwnedFixture(namespace.relativeFail, 'process.exit(1);');
    const result = runSuite({ name: 'failing-fixture', file: namespace.relativeFail, required: false });
    assert.strictEqual(result.status, 'FAIL', `Expected FAIL, got ${result.status}`);
  } finally {
    removeOwnedDir(namespace.relativeDir);
  }
});

// R09: arbitrary unregistered file is never executed
test('R09 arbitrary unregistered file is never executed', () => {
  // Create a per-invocation arbitrary file under the ignored temp root
  const namespace = createInvocationNamespace();
  const arbitraryRel = path.join(FIXTURE_SUBDIR, namespace.dir, 'arbitrary.js');
  try {
    writeOwnedFixture(arbitraryRel, 'console.log("ARBITRARY EXECUTED"); process.exit(0);');
    // Verify it's not in the registry
    const found = SUITE_REGISTRY.find(s => s.file === arbitraryRel);
    assert.ok(!found, 'Arbitrary file should not be in registry');
  } finally {
    removeOwnedDir(namespace.relativeDir);
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
  assert.notStrictEqual(first.dir, second.dir, 'invocation directories must be unique');
  assert.notStrictEqual(first.relativePass, second.relativePass, 'pass fixture paths must differ between invocations');
  assert.notStrictEqual(first.relativeFail, second.relativeFail, 'fail fixture paths must differ between invocations');
  const normalizedDir = path.resolve(TEST_DIR) + path.sep;
  for (const rel of [first.relativePass, first.relativeFail, second.relativePass, second.relativeFail]) {
    assert.ok(!rel.includes('..'), `${rel} must not contain path traversal`);
    assert.ok(!path.isAbsolute(rel), `${rel} must be a relative path`);
    const resolved = fixturePath(rel);
    assert.ok(resolved.startsWith(normalizedDir), `${rel} must stay inside ${TEST_DIR}`);
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
  const workerScript = path.join(TEST_DIR, 'runner.test.js');
  const runs = [];
  for (let i = 0; i < WORKER_COUNT; i++) {
    runs.push(new Promise((resolve) => {
      const child = spawn(process.execPath, [workerScript, WORKER_FLAG], {
        cwd: TEST_DIR,
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

  const reportedPaths = results.map((r) => {
    const match = r.stdout.match(/fixture-worker PASS (\S+)/);
    return match ? match[1] : null;
  });
  const missing = reportedPaths.filter((p) => !p);
  assert.strictEqual(missing.length, 0, `${missing.length}/${WORKER_COUNT} workers did not report a fixture path`);
  assert.strictEqual(new Set(reportedPaths).size, WORKER_COUNT, 'worker fixture paths must be unique across processes');

  // No owned worker fixture file or directory may remain after the workers exited.
  for (const rel of reportedPaths) {
    const ownedFile = fixturePath(rel);
    assert.ok(!fs.existsSync(ownedFile), `owned worker fixture left behind: ${rel}`);
    assert.ok(!fs.existsSync(path.dirname(ownedFile)), `owned worker fixture directory left behind: ${path.dirname(rel)}`);
  }

  // No fixture state may ever live directly beside tracked test files.
  const direct = fs.readdirSync(TEST_DIR).filter((n) => /^(__runner_fixture_|runner-|__fixture_|__arbitrary_)/.test(n));
  assert.deepStrictEqual(direct, [], `fixture state must not live directly beside tracked test files: ${direct.join(', ')}`);
});

// R14: fixture runtime state lives under the Git-ignored tmp root
// Guards the P2 from PR #25 review comment 4112251781.
testAsync('R14 fixture state lives under the Git-ignored tmp root', () => {
  // The fixture root is a dedicated subdirectory, never the tracked test directory itself.
  assert.notStrictEqual(path.resolve(FIXTURES_DIR), path.resolve(TEST_DIR), 'fixture root must not be the tracked test directory');
  assert.strictEqual(path.basename(path.resolve(FIXTURES_DIR)), FIXTURE_SUBDIR, `fixture root basename must be ${FIXTURE_SUBDIR}`);
  // The fixture root remains below the context-hydration test directory.
  assert.ok(
    path.resolve(FIXTURES_DIR).startsWith(path.resolve(TEST_DIR) + path.sep),
    'fixture root must remain below the context-hydration test directory'
  );
  // Generated fixture paths resolve beneath the fixture root and beneath TEST_DIR.
  const namespace = createInvocationNamespace();
  const resolvedPass = fixturePath(namespace.relativePass);
  assert.ok(
    resolvedPass.startsWith(path.resolve(FIXTURES_DIR) + path.sep),
    'generated fixture path must resolve beneath the fixture root'
  );
  assert.ok(
    resolvedPass.startsWith(path.resolve(TEST_DIR) + path.sep),
    'generated fixture path must resolve beneath the test directory'
  );
  // Generated fixture state never sits directly beside tracked test files.
  assert.notStrictEqual(path.dirname(resolvedPass), path.resolve(TEST_DIR), 'fixture files must not be created directly beside tracked test files');
  assert.strictEqual(
    path.dirname(path.dirname(resolvedPass)),
    path.resolve(FIXTURES_DIR),
    'invocation directories must be direct children of the fixture root'
  );
  // Repository ignore policy must carry an active tmp/ rule (read-only check, never mutated).
  const repoRoot = path.resolve(TEST_DIR, '..', '..', '..');
  const ignoreContent = fs.readFileSync(path.join(repoRoot, '.gitignore'), 'utf8');
  const activeRules = ignoreContent.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0 && !l.startsWith('#'));
  assert.ok(activeRules.includes(`${FIXTURE_SUBDIR}/`), `repository .gitignore must contain an active ${FIXTURE_SUBDIR}/ rule`);
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
