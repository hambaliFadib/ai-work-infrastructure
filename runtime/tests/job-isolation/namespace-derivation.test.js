/**
 * Job Isolation v1 — Namespace Derivation tests (NDC01-NDC12).
 *
 * Validates the deterministic namespace derivation primitives against the
 * locked governance artifacts:
 *   - governance/contracts/job-isolation-v1.md (section 9)
 *   - governance/policies/job-isolation.json (job-isolation@1.0.0)
 *
 * Scope boundary: namespace derivation and integrity validation only.
 * No isolation enforcement (#39), no parallel lanes (#40), no coordinator
 * (#41), no session lifecycle, no Phase 9C recovery semantics.
 *
 * Deterministic Node only. No network. No DB. No env. No profile reads.
 * No wall clock. No randomness.
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const {
  JobIsolationError,
  JobIsolationPolicyError,
  POLICY,
  NAMESPACE_FIELDS,
  CONTRACT_NAMESPACE_FIELDS,
  canonicalizeJobId,
  deriveNamespace,
  deriveNamespaces,
  assertNamespaceIntegrity,
} = require('../../job-isolation/namespace-derivation.js');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const POLICY_FILE = JSON.parse(fs.readFileSync(path.join(ROOT, 'governance', 'policies', 'job-isolation.json'), 'utf8'));

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

/** Run fn and return the thrown error, asserting it is a canonical JobIsolationError with the expected code. */
function expectCode(fn, code) {
  let thrown = null;
  try {
    fn();
  } catch (e) {
    thrown = e;
  }
  assert.ok(thrown, `expected ${code}, but nothing was thrown`);
  assert.ok(
    thrown instanceof JobIsolationError,
    `expected JobIsolationError for ${code}, got ${thrown && thrown.name}: ${thrown && thrown.message}`
  );
  assert.strictEqual(thrown.code, code, `expected ${code}, got ${thrown.code}`);
  assert.strictEqual(typeof thrown.message, 'string');
  return thrown;
}

// NDC01 — all five locked templates derive exactly as declared in the policy
test('NDC01', () => {
  const jobId = 'ndc01.sample';
  const derived = deriveNamespaces(jobId);
  const templates = POLICY_FILE.namespaces.templates;
  assert.deepStrictEqual(derived, {
    session_namespace: templates.session.replace('{job_id}', jobId),
    evidence_namespace: templates.evidence.replace('{job_id}', jobId),
    ledger_namespace: templates.ledger.replace('{job_id}', jobId),
    runtime_state_namespace: templates.runtime_state.replace('{job_id}', jobId),
    knowledge_job_local_namespace: templates.knowledge_job_local.replace('{job_id}', jobId),
  });
  assert.deepStrictEqual(Object.keys(derived), NAMESPACE_FIELDS);
  assert.strictEqual(Object.keys(derived).length, 5);
  assert.deepStrictEqual(NAMESPACE_FIELDS, [
    'session_namespace',
    'evidence_namespace',
    'ledger_namespace',
    'runtime_state_namespace',
    'knowledge_job_local_namespace',
  ]);
  assert.strictEqual(CONTRACT_NAMESPACE_FIELDS.length, 4);
  assert.strictEqual(derived.session_namespace, 'job:ndc01.sample:sessions');
  assert.strictEqual(derived.knowledge_job_local_namespace, 'job:ndc01.sample:knowledge');
});

// NDC02 — canonical job binding: derivation binds to the canonical identity
test('NDC02', () => {
  const derived = deriveNamespaces('  NDC.Bind-Case  ');
  assert.deepStrictEqual(derived, deriveNamespaces('ndc.bind-case'));
  for (const field of NAMESPACE_FIELDS) {
    assert.ok(derived[field].includes(':ndc.bind-case:'), `${field} must bind the canonical job id`);
    assert.ok(derived[field].startsWith('job:ndc.bind-case:'), `${field} must be job-bound`);
  }
  assert.strictEqual(canonicalizeJobId('  NDC.Bind-Case  '), 'ndc.bind-case');
  assert.strictEqual(deriveNamespace('ledger_namespace', '  NDC.Bind-Case  '), 'job:ndc.bind-case:ledger');
});

// NDC03 — same input produces identical output
test('NDC03', () => {
  const first = JSON.stringify(deriveNamespaces('ndc.same'));
  assert.strictEqual(JSON.stringify(deriveNamespaces('ndc.same')), first);
  assert.strictEqual(JSON.stringify(deriveNamespaces(' NDC.Same ')), first);
  assert.strictEqual(JSON.stringify(deriveNamespaces('ndc.same')), JSON.stringify(deriveNamespaces('ndc.same')));
  assert.strictEqual(deriveNamespace('session_namespace', 'ndc.same'), deriveNamespaces('ndc.same').session_namespace);
});

// NDC04 — different jobs produce distinct, collision-free output
test('NDC04', () => {
  const one = deriveNamespaces('ndc.job-one');
  const two = deriveNamespaces('ndc.job-two');
  for (const field of NAMESPACE_FIELDS) {
    assert.notStrictEqual(one[field], two[field], `${field} must differ across jobs`);
  }
  const withinOne = new Set(Object.values(one));
  assert.strictEqual(withinOne.size, 5, 'the five derived namespaces must be pairwise distinct');
  assert.notStrictEqual(deriveNamespaces('ndc.job').session_namespace, deriveNamespaces('ndc.job-one').session_namespace);
});

// NDC05 — invalid identity rejection (no identity is ever invented)
test('NDC05', () => {
  const invalid = [42, null, undefined, '', '   ', 'bad/id', 'bad id', 'bad:id', '-lead', '.lead', 'ndc#x', 'a'.repeat(65)];
  for (const value of invalid) {
    expectCode(() => deriveNamespaces(value), 'INVALID_JOB_ID');
    expectCode(() => canonicalizeJobId(value), 'INVALID_JOB_ID');
  }
  expectCode(() => deriveNamespace('session_namespace', 'bad/id'), 'INVALID_JOB_ID');
  assert.strictEqual(canonicalizeJobId('a'.repeat(64)), 'a'.repeat(64));
});

// NDC06 — no fallback: unknown kinds fail closed and derivation never falls back
test('NDC06', () => {
  expectCode(() => deriveNamespace('default', 'ndc06.job'), 'NAMESPACE_DERIVATION_FAILED');
  expectCode(() => deriveNamespace('session', 'ndc06.job'), 'NAMESPACE_DERIVATION_FAILED');
  expectCode(() => deriveNamespace(undefined, 'ndc06.job'), 'NAMESPACE_DERIVATION_FAILED');
  const derived = deriveNamespaces('ndc06.job');
  for (const field of NAMESPACE_FIELDS) {
    assert.ok(!/^job:(default|global|shared|unknown):/.test(derived[field]), `${field} must not fall back to a shared namespace`);
    assert.ok(!derived[field].includes('{job_id}'), `${field} must contain no unresolved placeholder`);
  }
  let threw = false;
  let value;
  try {
    value = deriveNamespaces('bad/id');
  } catch (e) {
    threw = true;
  }
  assert.strictEqual(threw, true);
  assert.strictEqual(value, undefined, 'failed derivation must not produce a fallback value');
});

// NDC07 — namespace integrity validation fails closed on any deviation
test('NDC07', () => {
  const jobId = 'ndc07.integrity';
  const derived = deriveNamespaces(jobId);
  const exact = {
    session_namespace: derived.session_namespace,
    evidence_namespace: derived.evidence_namespace,
    ledger_namespace: derived.ledger_namespace,
    runtime_state_namespace: derived.runtime_state_namespace,
  };
  assert.strictEqual(assertNamespaceIntegrity(jobId, exact), true);
  assert.strictEqual(assertNamespaceIntegrity('  NDC07.Integrity  ', exact), true);
  for (const field of CONTRACT_NAMESPACE_FIELDS) {
    expectCode(() => assertNamespaceIntegrity(jobId, { ...exact, [field]: 'job:foreign-job:sessions' }), 'NAMESPACE_OVERRIDE_FORBIDDEN');
  }
  const missing = { ...exact };
  delete missing.ledger_namespace;
  expectCode(() => assertNamespaceIntegrity(jobId, missing), 'NAMESPACE_OVERRIDE_FORBIDDEN');
  expectCode(() => assertNamespaceIntegrity(jobId, null), 'NAMESPACE_OVERRIDE_FORBIDDEN');
  expectCode(() => assertNamespaceIntegrity(jobId, 'job:ndc07.integrity:sessions'), 'NAMESPACE_OVERRIDE_FORBIDDEN');
  expectCode(() => assertNamespaceIntegrity('ndc07.other', exact), 'NAMESPACE_OVERRIDE_FORBIDDEN');
});

// NDC08 — derived namespaces are logical identifiers, not filesystem paths
test('NDC08', () => {
  const derived = deriveNamespaces('ndc08.shape');
  for (const field of NAMESPACE_FIELDS) {
    const value = derived[field];
    assert.ok(value.startsWith('job:ndc08.shape:'), `${field} must be job-bound`);
    assert.ok(!value.includes('/'), `${field} must not contain path separators`);
    assert.ok(!value.includes('\\'), `${field} must not contain path separators`);
    assert.ok(!value.includes('..'), `${field} must not contain traversal`);
    assert.ok(!/\s/.test(value), `${field} must not contain whitespace`);
    assert.ok(!value.includes('{') && !value.includes('}'), `${field} must contain no placeholders`);
  }
});

// NDC09 — canonical error surface only
test('NDC09', () => {
  const locked = POLICY_FILE.canonical_errors;
  const used = ['INVALID_JOB_ID', 'NAMESPACE_DERIVATION_FAILED', 'NAMESPACE_OVERRIDE_FORBIDDEN'];
  for (const code of used) {
    assert.ok(locked.includes(code), `${code} must be one of the locked canonical identifiers`);
  }
  const err = expectCode(() => deriveNamespaces('bad/id'), 'INVALID_JOB_ID');
  assert.strictEqual(err.name, 'JobIsolationError');
  assert.strictEqual(typeof err.code, 'string');
  assert.strictEqual(typeof err.message, 'string');
  let rejected = false;
  try {
    new JobIsolationError('NOT_A_LOCKED_IDENTIFIER', 'x');
  } catch (e) {
    rejected = true;
  }
  assert.strictEqual(rejected, true, 'non-canonical error codes must be rejected at construction');
  assert.strictEqual(POLICY.policy_ref, 'job-isolation@1.0.0');
});

// NDC10 — 100x deterministic stress on identical inputs
test('NDC10', () => {
  const input = '  NDC10.Stress  ';
  const first = JSON.stringify(deriveNamespaces(input));
  for (let i = 0; i < 100; i += 1) {
    assert.strictEqual(JSON.stringify(deriveNamespaces(input)), first);
  }
  const derived = deriveNamespaces(input);
  const exact = {
    session_namespace: derived.session_namespace,
    evidence_namespace: derived.evidence_namespace,
    ledger_namespace: derived.ledger_namespace,
    runtime_state_namespace: derived.runtime_state_namespace,
  };
  for (let i = 0; i < 100; i += 1) {
    assert.strictEqual(assertNamespaceIntegrity(input, exact), true);
  }
});

// NDC11 — loaded policy data is recursively immutable
test('NDC11', () => {
  assert.ok(Object.isFrozen(POLICY));
  assert.ok(Object.isFrozen(POLICY.job_id));
  assert.ok(Object.isFrozen(POLICY.namespaces));
  assert.ok(Object.isFrozen(POLICY.namespaces.templates));
  assert.ok(Object.isFrozen(POLICY.canonical_errors));
  assert.ok(Object.isFrozen(POLICY.knowledge_scope));
  assert.ok(Object.isFrozen(POLICY.knowledge_scope.canonical_order));
  assert.ok(Object.isFrozen(POLICY.execution_permissions));
  assert.ok(Object.isFrozen(POLICY.execution_permissions.canonical_order));
  const before = JSON.stringify(deriveNamespaces('ndc11.freeze'));
  try { POLICY.namespaces.templates.session = 'job:{job_id}:evil'; } catch (e) { /* frozen */ }
  try { POLICY.namespaces.templates.session = 'job:{job_id}:evil'; } catch (e) { /* frozen */ }
  try { POLICY.canonical_errors.push('FAKE_CODE'); } catch (e) { /* frozen */ }
  try { POLICY.canonical_errors[0] = 'FAKE_CODE'; } catch (e) { /* frozen */ }
  try { POLICY.knowledge_scope.canonical_order[0] = 'GLOBAL'; } catch (e) { /* frozen */ }
  try { POLICY.execution_permissions.canonical_order.push('SUPER_USER'); } catch (e) { /* frozen */ }
  assert.strictEqual(POLICY.namespaces.templates.session, 'job:{job_id}:sessions');
  assert.strictEqual(POLICY.canonical_errors.length, 18);
  assert.deepStrictEqual(POLICY.knowledge_scope.canonical_order, ['JOB_LOCAL', 'SESSION_LOCAL', 'GLOBAL']);
  assert.deepStrictEqual(POLICY.execution_permissions.canonical_order, ['READ_ONLY', 'LOW_RISK_WRITE', 'CONFIG_WRITE', 'DELETE', 'SECRET_ACCESS']);
  assert.strictEqual(deriveNamespaces('ndc11.freeze').session_namespace, 'job:ndc11.freeze:sessions');
  assert.strictEqual(JSON.stringify(deriveNamespaces('ndc11.freeze')), before);
});

// NDC12 — policy integrity errors expose no ungoverned domain codes
test('NDC12', () => {
  const err = new JobIsolationPolicyError('policy unavailable');
  assert.strictEqual(err.name, 'JobIsolationPolicyError');
  assert.strictEqual(typeof err.message, 'string');
  assert.strictEqual(Object.prototype.hasOwnProperty.call(err, 'code'), false);
  assert.strictEqual(err.code, undefined);
  assert.strictEqual(POLICY.canonical_errors.length, 18);
  for (const candidateCode of ['POLICY_UNAVAILABLE', 'POLICY_MISMATCH']) {
    let rejected = false;
    try { new JobIsolationError(candidateCode, 'x'); } catch (e) { rejected = true; }
    assert.strictEqual(rejected, true, `${candidateCode} must not be constructible as a domain error code`);
  }
  for (const rel of ['runtime/job-isolation/namespace-derivation.js', 'runtime/job-isolation/job-contract.js']) {
    const source = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    assert.ok(!source.includes('POLICY_UNAVAILABLE'), `${rel} must not reference POLICY_UNAVAILABLE`);
    assert.ok(!source.includes('POLICY_MISMATCH'), `${rel} must not reference POLICY_MISMATCH`);
  }
});

console.log('');
console.log(`Cases: ${passed + failed}`);
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);

process.exit(failed > 0 ? 1 : 0);
