/**
 * Job Isolation v1 — JobContract Runtime Core tests (JCC01-JCC27).
 *
 * Validates the deterministic JobContract runtime semantics against the
 * locked governance artifacts:
 *   - governance/contracts/job-isolation-v1.md
 *   - governance/policies/job-isolation.json (job-isolation@1.0.0)
 *
 * Scope boundary: JobContract core only. No parallel lanes (#40), no
 * namespace isolation enforcement (#39), no coordinator (#41), no recovery
 * state machine or lifecycle transitions (Phase 9C), no persistence layer.
 *
 * Deterministic Node only. No network. No DB. No env. No profile reads.
 * No wall clock. No randomness.
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const {
  JobIsolationError,
  validateJobContract,
  createJobContract,
  reuseJobContract,
  assertProfileBinding,
  bindPermissionCeiling,
} = require('../../job-isolation/job-contract.js');

const { deriveNamespaces } = require('../../job-isolation/namespace-derivation.js');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const POLICY = JSON.parse(fs.readFileSync(path.join(ROOT, 'governance', 'policies', 'job-isolation.json'), 'utf8'));
const LOCKED_ERRORS = POLICY.canonical_errors;
const CONTRACT_FIELDS = POLICY.job_contract.required_fields;
const STORED_NAMESPACE_FIELDS = ['session_namespace', 'evidence_namespace', 'ledger_namespace', 'runtime_state_namespace'];
const DERIVED_NAMESPACE_FIELDS = STORED_NAMESPACE_FIELDS.concat(['knowledge_job_local_namespace']);

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

/** Deterministic creation input; overrides are applied on top. */
function creationInput(jobId, overrides = {}) {
  return {
    job_id: jobId,
    profile: 'PGN-Core',
    knowledge_scope: ['JOB_LOCAL'],
    execution_permissions: ['READ_ONLY'],
    ...overrides,
  };
}

/** Persist a freshly created contract and return { contract, store }. */
function createdAndPersisted(jobId, overrides = {}) {
  const store = new Map();
  const contract = createJobContract(creationInput(jobId, overrides), store);
  store.set(contract.job_id, contract);
  return { contract, store };
}

// JCC01 — creation output is the exact canonical 8-field JobContract
test('JCC01', () => {
  const contract = createJobContract(
    {
      job_id: '  JCC01.Core  ',
      profile: '  PGNAnalyst  ',
      knowledge_scope: ['GLOBAL', 'JOB_LOCAL', 'GLOBAL'],
      execution_permissions: ['DELETE', 'READ_ONLY', 'DELETE'],
    },
    new Map()
  );
  assert.deepStrictEqual(Object.keys(contract), CONTRACT_FIELDS);
  assert.strictEqual(Object.keys(contract).length, 8);
  assert.strictEqual(contract.job_id, 'jcc01.core');
  assert.strictEqual(contract.profile, 'PGNAnalyst');
  assert.deepStrictEqual(contract.knowledge_scope, ['JOB_LOCAL', 'GLOBAL']);
  assert.deepStrictEqual(contract.execution_permissions, ['READ_ONLY', 'DELETE']);
  assert.strictEqual(contract.session_namespace, 'job:jcc01.core:sessions');
  assert.strictEqual(contract.evidence_namespace, 'job:jcc01.core:evidence');
  assert.strictEqual(contract.ledger_namespace, 'job:jcc01.core:ledger');
  assert.strictEqual(contract.runtime_state_namespace, 'job:jcc01.core:runtime-state');
});

// JCC02 — required creation input enforced
test('JCC02', () => {
  const complete = creationInput('jcc02');
  expectCode(() => createJobContract({}, new Map()), 'JOB_CONTRACT_INVALID');
  for (const field of ['job_id', 'profile', 'knowledge_scope', 'execution_permissions']) {
    const partial = { ...complete };
    delete partial[field];
    expectCode(() => createJobContract(partial, new Map()), 'JOB_CONTRACT_INVALID');
  }
  expectCode(() => createJobContract(null, new Map()), 'JOB_CONTRACT_INVALID');
  expectCode(() => createJobContract([], new Map()), 'JOB_CONTRACT_INVALID');
  expectCode(() => createJobContract('contract', new Map()), 'JOB_CONTRACT_INVALID');
  expectCode(() => createJobContract(complete, undefined), 'JOB_CONTRACT_INVALID');
  expectCode(() => createJobContract(complete, {}), 'JOB_CONTRACT_INVALID');
});

// JCC03 — unknown creation input fails closed
test('JCC03', () => {
  expectCode(() => createJobContract({ ...creationInput('jcc03'), bogus: 1 }, new Map()), 'JOB_CONTRACT_INVALID');
  expectCode(() => createJobContract({ ...creationInput('jcc03'), status: 'ACTIVE' }, new Map()), 'JOB_CONTRACT_INVALID');
  expectCode(() => createJobContract({ ...creationInput('jcc03'), created_at: '2026-01-01' }, new Map()), 'JOB_CONTRACT_INVALID');
});

// JCC04 — job_id normalization (NFKC, trim, lowercase)
test('JCC04', () => {
  assert.strictEqual(createJobContract(creationInput('  JCC04.Core  '), new Map()).job_id, 'jcc04.core');
  assert.strictEqual(createJobContract(creationInput('ＪＣＣ０４－Ｃｏｒｅ'), new Map()).job_id, 'jcc04-core');
  assert.strictEqual(createJobContract(creationInput('A.B_C-D9'), new Map()).job_id, 'a.b_c-d9');
  assert.strictEqual(createJobContract(creationInput('0digit'), new Map()).job_id, '0digit');
});

// JCC05 — invalid job_id rejected
test('JCC05', () => {
  const invalid = [42, null, '', '   ', 'jcc 05', 'jcc/05', 'jcc:05', '-lead', '.lead', 'jcc#5', 'jcc\\05', 'a'.repeat(65)];
  for (const job_id of invalid) {
    expectCode(() => createJobContract(creationInput(job_id), new Map()), 'INVALID_JOB_ID');
  }
  assert.strictEqual(createJobContract(creationInput('a'.repeat(64)), new Map()).job_id, 'a'.repeat(64));
});

// JCC06 — profile trim only, case preserved
test('JCC06', () => {
  const mixed = createJobContract(creationInput('jcc06', { profile: '  PGNAnalyst  ' }), new Map());
  assert.strictEqual(mixed.profile, 'PGNAnalyst');
  const lower = createJobContract(creationInput('jcc06', { profile: 'pgnanalyst' }), new Map());
  assert.strictEqual(lower.profile, 'pgnanalyst');
  assert.notStrictEqual(lower.profile, mixed.profile);
});

// JCC07 — profile validation fails closed on malformed profiles
test('JCC07', () => {
  const invalid = ['bad profile', 'bad/profile', 'bad\\profile', '-lead', '.lead', '', '   ', 42, null];
  for (const profile of invalid) {
    expectCode(() => createJobContract(creationInput('jcc07', { profile }), new Map()), 'PROFILE_BINDING_INVALID');
  }
});

// JCC08 — knowledge scope deduplicated and canonically ordered
test('JCC08', () => {
  const contract = createJobContract(
    creationInput('jcc08', { knowledge_scope: ['GLOBAL', 'JOB_LOCAL', 'GLOBAL', 'SESSION_LOCAL'] }),
    new Map()
  );
  assert.deepStrictEqual(contract.knowledge_scope, ['JOB_LOCAL', 'SESSION_LOCAL', 'GLOBAL']);
  const single = createJobContract(creationInput('jcc08', { knowledge_scope: ['JOB_LOCAL', 'JOB_LOCAL'] }), new Map());
  assert.deepStrictEqual(single.knowledge_scope, ['JOB_LOCAL']);
});

// JCC09 — knowledge scope invalid: empty, unknown, missing JOB_LOCAL
test('JCC09', () => {
  const invalid = [[], ['GLOBAL'], ['SESSION_LOCAL'], ['GLOBAL', 'SESSION_LOCAL'], ['JOB_LOCAL', 'UNKNOWN'], ['JOB_LOCAL', 7], 'JOB_LOCAL', null];
  for (const knowledge_scope of invalid) {
    expectCode(() => createJobContract(creationInput('jcc09', { knowledge_scope }), new Map()), 'INVALID_KNOWLEDGE_SCOPE');
  }
});

// JCC10 — execution permissions deduplicated and canonically ordered
test('JCC10', () => {
  const contract = createJobContract(
    creationInput('jcc10', { execution_permissions: ['SECRET_ACCESS', 'DELETE', 'READ_ONLY', 'CONFIG_WRITE', 'LOW_RISK_WRITE', 'DELETE'] }),
    new Map()
  );
  assert.deepStrictEqual(contract.execution_permissions, ['READ_ONLY', 'LOW_RISK_WRITE', 'CONFIG_WRITE', 'DELETE', 'SECRET_ACCESS']);
});

// JCC11 — execution permissions invalid: empty, unknown, missing READ_ONLY
test('JCC11', () => {
  const invalid = [[], ['DELETE'], ['LOW_RISK_WRITE'], ['READ_ONLY', 'UNKNOWN'], ['READ_ONLY', 7], 'READ_ONLY', null];
  for (const execution_permissions of invalid) {
    expectCode(() => createJobContract(creationInput('jcc11', { execution_permissions }), new Map()), 'INVALID_EXECUTION_PERMISSIONS');
  }
});

// JCC12 — creation derives the stored namespaces; knowledge namespace derives separately
test('JCC12', () => {
  const contract = createJobContract(creationInput('jcc12.core'), new Map());
  assert.strictEqual(contract.session_namespace, 'job:jcc12.core:sessions');
  assert.strictEqual(contract.evidence_namespace, 'job:jcc12.core:evidence');
  assert.strictEqual(contract.ledger_namespace, 'job:jcc12.core:ledger');
  assert.strictEqual(contract.runtime_state_namespace, 'job:jcc12.core:runtime-state');
  assert.strictEqual(deriveNamespaces('jcc12.core').knowledge_job_local_namespace, 'job:jcc12.core:knowledge');
});

// JCC13 — caller-supplied derived namespaces are forbidden during creation
test('JCC13', () => {
  for (const field of DERIVED_NAMESPACE_FIELDS) {
    expectCode(
      () => createJobContract({ ...creationInput('jcc13'), [field]: 'job:jcc13:sessions' }, new Map()),
      'NAMESPACE_OVERRIDE_FORBIDDEN'
    );
  }
  expectCode(
    () => createJobContract({ ...creationInput('jcc13'), session_namespace: 'x', bogus: 1 }, new Map()),
    'NAMESPACE_OVERRIDE_FORBIDDEN'
  );
});

// JCC14 — persisted validation accepts an exact canonical contract
test('JCC14', () => {
  const { contract } = createdAndPersisted('jcc14.core');
  const validated = validateJobContract(contract);
  assert.deepStrictEqual(validated, contract);
  assert.notStrictEqual(validated, contract);
  assert.ok(Object.isFrozen(validated));
  const clone = JSON.parse(JSON.stringify(contract));
  assert.deepStrictEqual(validateJobContract(clone), contract);
});

// JCC15 — persisted validation requires exactly the locked eight fields
test('JCC15', () => {
  const { contract } = createdAndPersisted('jcc15.core');
  expectCode(() => validateJobContract({ ...contract, extra: 1 }), 'JOB_CONTRACT_INVALID');
  const missing = { ...contract };
  delete missing.ledger_namespace;
  expectCode(() => validateJobContract(missing), 'JOB_CONTRACT_INVALID');
  expectCode(() => validateJobContract(null), 'JOB_CONTRACT_INVALID');
  expectCode(() => validateJobContract([]), 'JOB_CONTRACT_INVALID');
  expectCode(() => validateJobContract('contract'), 'JOB_CONTRACT_INVALID');
  expectCode(() => validateJobContract({ ...contract, job_id: 7 }), 'JOB_CONTRACT_INVALID');
  expectCode(() => validateJobContract({ ...contract, knowledge_scope: 'JOB_LOCAL' }), 'JOB_CONTRACT_INVALID');
  expectCode(() => validateJobContract({ ...contract, session_namespace: 7 }), 'JOB_CONTRACT_INVALID');
});

// JCC16 — persisted identity/profile must already be canonical (no silent repair)
test('JCC16', () => {
  const { contract } = createdAndPersisted('jcc16.core');
  expectCode(() => validateJobContract({ ...contract, job_id: 'JCC16.core' }), 'INVALID_JOB_ID');
  expectCode(() => validateJobContract({ ...contract, profile: ' PGN-Core ' }), 'PROFILE_BINDING_INVALID');
  expectCode(() => validateJobContract({ ...contract, profile: 'bad profile' }), 'PROFILE_BINDING_INVALID');
});

// JCC17 — persisted namespace mismatch fails closed
test('JCC17', () => {
  const { contract } = createdAndPersisted('jcc17.core');
  for (const field of STORED_NAMESPACE_FIELDS) {
    expectCode(() => validateJobContract({ ...contract, [field]: 'job:foreign-job:sessions' }), 'NAMESPACE_OVERRIDE_FORBIDDEN');
  }
  expectCode(() => validateJobContract({ ...contract, session_namespace: 'job:jcc17.core:sessions-extra' }), 'NAMESPACE_OVERRIDE_FORBIDDEN');
});

// JCC18 — persisted arrays must already be in canonical form
test('JCC18', () => {
  const { contract } = createdAndPersisted('jcc18.core', { knowledge_scope: ['JOB_LOCAL', 'GLOBAL'], execution_permissions: ['READ_ONLY', 'DELETE'] });
  expectCode(() => validateJobContract({ ...contract, knowledge_scope: ['GLOBAL', 'JOB_LOCAL'] }), 'INVALID_KNOWLEDGE_SCOPE');
  expectCode(() => validateJobContract({ ...contract, knowledge_scope: ['JOB_LOCAL', 'JOB_LOCAL'] }), 'INVALID_KNOWLEDGE_SCOPE');
  expectCode(() => validateJobContract({ ...contract, knowledge_scope: ['GLOBAL'] }), 'INVALID_KNOWLEDGE_SCOPE');
  expectCode(() => validateJobContract({ ...contract, execution_permissions: ['DELETE', 'READ_ONLY'] }), 'INVALID_EXECUTION_PERMISSIONS');
  expectCode(() => validateJobContract({ ...contract, execution_permissions: ['READ_ONLY', 'READ_ONLY'] }), 'INVALID_EXECUTION_PERMISSIONS');
  expectCode(() => validateJobContract({ ...contract, execution_permissions: ['DELETE'] }), 'INVALID_EXECUTION_PERMISSIONS');
});

// JCC19 — CREATE collision: an existing active canonical job_id always collides
test('JCC19', () => {
  const { store } = createdAndPersisted('jcc19.core');
  expectCode(() => createJobContract(creationInput('jcc19.core'), store), 'JOB_ID_COLLISION');
  expectCode(() => createJobContract(creationInput('  JCC19.Core  '), store), 'JOB_ID_COLLISION');
  expectCode(() => createJobContract(creationInput('jcc19.core', { profile: 'OtherProfile' }), store), 'JOB_ID_COLLISION');
  expectCode(
    () => createJobContract(creationInput('jcc19.core', { knowledge_scope: ['JOB_LOCAL', 'GLOBAL'] }), store),
    'JOB_ID_COLLISION'
  );
  expectCode(() => createJobContract(creationInput('jcc19.core', { profile: 'bad profile' }), store), 'PROFILE_BINDING_INVALID');
});

// JCC20 — exact persisted REUSE is idempotent
test('JCC20', () => {
  const { contract, store } = createdAndPersisted('jcc20.core');
  const again = reuseJobContract(contract, store);
  assert.deepStrictEqual(again, contract);
  assert.notStrictEqual(again, contract);
  assert.ok(Object.isFrozen(again));
  const twice = reuseJobContract(again, store);
  assert.strictEqual(JSON.stringify(twice), JSON.stringify(contract));
});

// JCC21 — REUSE immutable mismatch and missing persisted contract fail closed
test('JCC21', () => {
  const { contract, store } = createdAndPersisted('jcc21.core', { knowledge_scope: ['JOB_LOCAL', 'GLOBAL'], execution_permissions: ['READ_ONLY', 'DELETE'] });
  expectCode(() => reuseJobContract({ ...contract, profile: 'OtherProfile' }, store), 'PROFILE_BINDING_MISMATCH');
  expectCode(() => reuseJobContract({ ...contract, knowledge_scope: ['JOB_LOCAL'] }, store), 'JOB_ID_COLLISION');
  expectCode(() => reuseJobContract({ ...contract, execution_permissions: ['READ_ONLY'] }, store), 'JOB_ID_COLLISION');
  expectCode(() => reuseJobContract(contract, new Map()), 'JOB_CONTRACT_INVALID');
  expectCode(() => reuseJobContract(contract, undefined), 'JOB_CONTRACT_INVALID');
});

// JCC22 — runtime profile binding comparison: trim only, case preserved
test('JCC22', () => {
  const { contract } = createdAndPersisted('jcc22.core', { profile: 'PGNAnalyst' });
  assert.strictEqual(assertProfileBinding(contract, 'PGNAnalyst'), true);
  assert.strictEqual(assertProfileBinding(contract, '  PGNAnalyst  '), true);
  expectCode(() => assertProfileBinding(contract, 'pgnanalyst'), 'PROFILE_BINDING_MISMATCH');
  expectCode(() => assertProfileBinding(contract, 'OtherProfile'), 'PROFILE_BINDING_MISMATCH');
  expectCode(() => assertProfileBinding(contract, 'bad profile'), 'PROFILE_BINDING_INVALID');
  expectCode(() => assertProfileBinding(contract, 42), 'PROFILE_BINDING_INVALID');
});

// JCC23 — job-bound permission ceiling: only the owning canonical job may bind
test('JCC23', () => {
  const { contract } = createdAndPersisted('jcc23.core', { execution_permissions: ['READ_ONLY', 'DELETE'] });
  const ceiling = bindPermissionCeiling(contract, 'jcc23.core');
  assert.deepStrictEqual(ceiling, { job_id: 'jcc23.core', execution_permissions: ['READ_ONLY', 'DELETE'] });
  assert.ok(Object.isFrozen(ceiling));
  assert.ok(Object.isFrozen(ceiling.execution_permissions));
  for (const value of Object.values(ceiling)) {
    assert.notStrictEqual(typeof value, 'function', 'the ceiling must not expose executable behavior');
  }
  assert.deepStrictEqual(bindPermissionCeiling(contract, '  JCC23.Core  ').job_id, 'jcc23.core');
  expectCode(() => bindPermissionCeiling(contract, 'foreign-job'), 'FOREIGN_JOB_REJECT');
  expectCode(() => bindPermissionCeiling(contract, 'jcc23.core.other'), 'FOREIGN_JOB_REJECT');
  expectCode(() => bindPermissionCeiling(contract, 'bad/id'), 'INVALID_JOB_ID');
  expectCode(() => bindPermissionCeiling(contract, 42), 'INVALID_JOB_ID');
});

// JCC24 — caller mutation cannot mutate the JobContract
test('JCC24', () => {
  const { contract, store } = createdAndPersisted('jcc24.core');
  assert.ok(Object.isFrozen(contract));
  assert.ok(Object.isFrozen(contract.knowledge_scope));
  assert.ok(Object.isFrozen(contract.execution_permissions));
  try { contract.job_id = 'mutated'; } catch (e) { /* frozen */ }
  assert.strictEqual(contract.job_id, 'jcc24.core');
  let pushRejected = false;
  try { contract.execution_permissions.push('DELETE'); } catch (e) { pushRejected = true; }
  assert.strictEqual(pushRejected, true);
  assert.deepStrictEqual(contract.execution_permissions, ['READ_ONLY']);
  const ceiling = bindPermissionCeiling(contract, contract.job_id);
  try { ceiling.execution_permissions.push('DELETE'); } catch (e) { /* frozen */ }
  assert.deepStrictEqual(contract.execution_permissions, ['READ_ONLY']);
  assert.deepStrictEqual(ceiling.execution_permissions, ['READ_ONLY']);
  const copy = reuseJobContract(contract, store);
  try { copy.knowledge_scope.push('GLOBAL'); } catch (e) { /* frozen */ }
  assert.deepStrictEqual(contract.knowledge_scope, ['JOB_LOCAL']);
  assert.deepStrictEqual(copy.knowledge_scope, ['JOB_LOCAL']);
});

// JCC25 — canonical errors only
test('JCC25', () => {
  const { contract, store } = createdAndPersisted('jcc25.core');
  const cases = [
    [() => createJobContract({}, new Map()), 'JOB_CONTRACT_INVALID'],
    [() => createJobContract(creationInput('bad/id'), new Map()), 'INVALID_JOB_ID'],
    [() => createJobContract(creationInput('jcc25.core'), store), 'JOB_ID_COLLISION'],
    [() => createJobContract(creationInput('jcc25.b', { profile: 'bad profile' }), new Map()), 'PROFILE_BINDING_INVALID'],
    [() => createJobContract(creationInput('jcc25.b', { session_namespace: 'x' }), new Map()), 'NAMESPACE_OVERRIDE_FORBIDDEN'],
    [() => createJobContract(creationInput('jcc25.b', { knowledge_scope: [] }), new Map()), 'INVALID_KNOWLEDGE_SCOPE'],
    [() => createJobContract(creationInput('jcc25.b', { execution_permissions: [] }), new Map()), 'INVALID_EXECUTION_PERMISSIONS'],
    [() => validateJobContract({ ...contract, extra: 1 }), 'JOB_CONTRACT_INVALID'],
    [() => validateJobContract({ ...contract, job_id: 'JCC25.core' }), 'INVALID_JOB_ID'],
    [() => validateJobContract({ ...contract, profile: ' PGN-Core ' }), 'PROFILE_BINDING_INVALID'],
    [() => validateJobContract({ ...contract, session_namespace: 'job:x:sessions' }), 'NAMESPACE_OVERRIDE_FORBIDDEN'],
    [() => reuseJobContract({ ...contract, profile: 'OtherProfile' }, store), 'PROFILE_BINDING_MISMATCH'],
    [() => reuseJobContract({ ...contract, knowledge_scope: ['JOB_LOCAL', 'GLOBAL'] }, store), 'JOB_ID_COLLISION'],
    [() => reuseJobContract(contract, new Map()), 'JOB_CONTRACT_INVALID'],
    [() => bindPermissionCeiling(contract, 'foreign-job'), 'FOREIGN_JOB_REJECT'],
  ];
  for (const [fn, expected] of cases) {
    const err = expectCode(fn, expected);
    assert.ok(LOCKED_ERRORS.includes(err.code), `${err.code} must be one of the locked canonical identifiers`);
    assert.strictEqual(err.name, 'JobIsolationError');
  }
  let rejected = false;
  try {
    new JobIsolationError('MADE_UP_CODE', 'x');
  } catch (e) {
    rejected = true;
  }
  assert.strictEqual(rejected, true, 'non-canonical error codes must be rejected at construction');
  assert.strictEqual(LOCKED_ERRORS.length, 18);
});

// JCC26 — validation precedence is deterministic (first failing condition wins)
test('JCC26', () => {
  expectCode(
    () => createJobContract({ job_id: 'bad/id', profile: 'bad profile', knowledge_scope: ['JOB_LOCAL'], execution_permissions: ['READ_ONLY'], bogus: 1 }, new Map()),
    'JOB_CONTRACT_INVALID'
  );
  expectCode(
    () => createJobContract({ job_id: 'bad/id', profile: 'bad profile', knowledge_scope: ['JOB_LOCAL'], execution_permissions: ['READ_ONLY'] }, new Map()),
    'INVALID_JOB_ID'
  );
  expectCode(
    () => createJobContract({ job_id: 'jcc26', profile: 'bad profile', knowledge_scope: ['GLOBAL'], execution_permissions: ['DELETE'] }, new Map()),
    'PROFILE_BINDING_INVALID'
  );
  expectCode(
    () => createJobContract({ job_id: 'jcc26', profile: 'PGN-Core', knowledge_scope: ['GLOBAL'], execution_permissions: ['DELETE'] }, new Map()),
    'INVALID_KNOWLEDGE_SCOPE'
  );
  const { contract } = createdAndPersisted('jcc26.core');
  expectCode(() => validateJobContract({ ...contract, job_id: 'BAD ID', session_namespace: 'job:x:sessions' }), 'INVALID_JOB_ID');
  expectCode(() => validateJobContract({ ...contract, profile: 'bad profile', session_namespace: 'job:x:sessions' }), 'PROFILE_BINDING_INVALID');
  expectCode(() => validateJobContract({ ...contract, session_namespace: 'job:x:sessions', knowledge_scope: ['GLOBAL'] }), 'NAMESPACE_OVERRIDE_FORBIDDEN');
  expectCode(() => validateJobContract({ ...contract, knowledge_scope: ['GLOBAL'], execution_permissions: ['DELETE'] }), 'INVALID_KNOWLEDGE_SCOPE');
});

// JCC27 — 100x deterministic stress on identical inputs
test('JCC27', () => {
  const input = {
    job_id: '  JCC27.Stress  ',
    profile: '  PGN-Stress  ',
    knowledge_scope: ['GLOBAL', 'JOB_LOCAL', 'GLOBAL'],
    execution_permissions: ['DELETE', 'READ_ONLY', 'DELETE'],
  };
  const first = JSON.stringify(createJobContract(input, new Map()));
  for (let i = 0; i < 100; i += 1) {
    assert.strictEqual(JSON.stringify(createJobContract(input, new Map())), first);
  }
  const contract = createJobContract(input, new Map());
  const store = new Map([[contract.job_id, contract]]);
  const firstReuse = JSON.stringify(reuseJobContract(contract, store));
  for (let i = 0; i < 100; i += 1) {
    assert.strictEqual(JSON.stringify(reuseJobContract(contract, store)), firstReuse);
    assert.strictEqual(JSON.stringify(validateJobContract(contract)), JSON.stringify(contract));
  }
});

console.log('');
console.log(`Cases: ${passed + failed}`);
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);

process.exit(failed > 0 ? 1 : 0);
