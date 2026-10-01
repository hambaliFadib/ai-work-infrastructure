/**
 * Job Isolation v1 - Phase 9B Acceptance suite (JC01-EP10; exactly 40 invariants).
 *
 * Acceptance evidence against the already implemented and verified Phase 9B
 * runtime (9B-02 / #38, 9B-03 / #39, 9B-04 / #40, 9B-05 / #41) under policy
 * job-isolation@1.0.0. Consumes the locked acceptance model exactly as
 * declared in governance/contracts/job-isolation-v1.md section 28:
 *
 *   JC01-JC10  JobContract
 *   NS01-NS10  Namespace Isolation
 *   PL01-PL10  Parallel Lanes
 *   EP01-EP10  Execution / Policy
 *
 * Acceptance only: this suite MUST NOT change runtime behavior. Any failing
 * invariant is a blocker; it is never weakened, skipped, or repaired here.
 * No renamed IDs. No additional invariant IDs. No skipped required cases.
 *
 * Determinism stress (fixed repeat counts, no time-based loops):
 *   - 100x JobContract canonicalization (JC10)
 *   - 100x namespace derivation (NS10)
 *   - 100x lane identity resolution (PL02)
 *   - 100x validation/error outcome (EP08)
 *
 * Deterministic Node only. No network. No DB. No environment/profile reads.
 * No memory reads/writes. No live external data. No wall clock. No
 * randomness. No filesystem/runtime state beyond static repository source
 * reads used by the boundary guards (PL09, EP10). Fixtures are reusable
 * deterministic infrastructure data only; worktree references are
 * machine-neutral placeholders.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const {
  JobIsolationError,
  POLICY,
  NAMESPACE_FIELDS,
  canonicalizeJobId,
  deriveNamespace,
  deriveNamespaces,
  assertNamespaceIntegrity,
} = require('../../job-isolation/namespace-derivation.js');
const {
  validateJobContract,
  createJobContract,
  reuseJobContract,
  assertProfileBinding,
  bindPermissionCeiling,
} = require('../../job-isolation/job-contract.js');
const {
  evaluateSessionAccess,
  evaluateEvidenceAccess,
  evaluateLedgerAccess,
  evaluateRuntimeStateAccess,
  evaluateRuntimeStateCleanup,
} = require('../../job-isolation/namespace-isolation.js');
const { evaluateKnowledgeReadEligibility } = require('../../job-isolation/knowledge-scope.js');
const {
  createLane,
  createLaneRegistry,
  registerLane,
  evaluateOwnership,
  evaluateCrossLaneClaim,
  evaluateCoordinationCheckout,
  evaluateStaleBaseline,
} = require('../../job-isolation/parallel-lane.js');
const {
  createMainCoordinationState,
  registerCoordinationLane,
  recordAuditedSynchronization,
  evaluateMergeEligibility,
} = require('../../job-isolation/coordinator.js');

const ROOT = path.resolve(__dirname, '..', '..', '..');

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

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
function creationInput(jobId, overrides) {
  return Object.assign({
    job_id: jobId,
    profile: 'acceptance-profile',
    knowledge_scope: ['JOB_LOCAL'],
    execution_permissions: ['READ_ONLY'],
  }, overrides || {});
}

/** Persist a freshly created contract and return { contract, store }. */
function createdAndPersisted(jobId, overrides) {
  const store = new Map();
  const contract = createJobContract(creationInput(jobId, overrides), store);
  store.set(contract.job_id, contract);
  return { contract, store };
}

/** Create a standalone canonical contract (no persisted store needed). */
function makeContract(jobId, overrides) {
  return createJobContract(creationInput(jobId, overrides), new Map());
}

/** Deterministic session access request bound to a contract. */
function sessionRequest(contract, overrides) {
  return Object.assign({
    operation: 'READ',
    resource_job_id: contract.job_id,
    resource_namespace: contract.session_namespace,
    resource_scope: 'SESSION_LOCAL',
    requester_session_id: 'session-one',
    owner_session_id: 'session-one',
  }, overrides || {});
}

// Machine-neutral deterministic fixtures. The baseline SHA is the authoritative
// Phase 9B closure baseline main commit; the prior SHA is a valid, distinct
// 40-character lowercase hex baseline used for stale-baseline scenarios.
const BASELINE_SHA = '3ed4fc4e08d9aa6e829d024d4eeadca13f8cc3a2';
const PRIOR_SHA = 'd93380228ea9c81c2861061f14d81d27e2493441';

function laneInput(overrides) {
  return Object.assign({
    lane_id: 'acc-lane-a',
    job_id: 'acc.pl.job-a',
    branch: 'feature/42-acceptance-lane-a',
    worktree: '<worktree-root>/issue-42',
    writer_identity: 'writer-42',
    baseline_main_sha: BASELINE_SHA,
  }, overrides || {});
}

function laneInputB(overrides) {
  return Object.assign({
    lane_id: 'acc-lane-b',
    job_id: 'acc.pl.job-b',
    branch: 'feature/42-acceptance-lane-b',
    worktree: '<worktree-root>/issue-42-b',
    writer_identity: 'writer-43',
    baseline_main_sha: PRIOR_SHA,
  }, overrides || {});
}

const CONTRACT_A = makeContract('acc.pl.job-a');
const CONTRACT_B = makeContract('acc.pl.job-b');

function mergeRequest(overrides) {
  return Object.assign({
    contract: CONTRACT_A,
    lane: laneInput(),
    writer_identity: 'writer-42',
  }, overrides || {});
}

// Machine-path scan patterns constructed from character codes so the suite's
// own source can never self-match the scan it performs on tracked artifacts.
const BS = String.fromCharCode(92);
function machinePathScanPatterns() {
  return [
    new RegExp('\\b[A-Za-z]' + ':' + BS + BS),
    new RegExp('D' + ':' + BS + BS + 'AI-Work-Infra'),
    new RegExp('D' + ':' + BS + BS + 'Sandbox AI'),
    new RegExp('C' + ':' + BS + BS + 'Users' + BS + BS),
  ];
}

// ---------------------------------------------------------------------------
// JobContract - JC01-JC10
// ---------------------------------------------------------------------------

// JC01 - required JobContract fields enforced; unknown fields fail closed.
test('JC01', () => {
  const required = ['job_id', 'profile', 'session_namespace', 'knowledge_scope', 'evidence_namespace', 'ledger_namespace', 'runtime_state_namespace', 'execution_permissions'];
  assert.deepStrictEqual(POLICY.job_contract.required_fields, required);
  assert.strictEqual(POLICY.job_contract.required_fields.length, 8);
  const { contract } = createdAndPersisted('acc.jc01.core');
  assert.deepStrictEqual(Object.keys(contract), required);
  assert.strictEqual(Object.keys(contract).length, 8);
  expectCode(() => validateJobContract(Object.assign({}, contract, { extra_field: 1 })), 'JOB_CONTRACT_INVALID');
  const missing = Object.assign({}, contract);
  delete missing.execution_permissions;
  expectCode(() => validateJobContract(missing), 'JOB_CONTRACT_INVALID');
  expectCode(() => validateJobContract(null), 'JOB_CONTRACT_INVALID');
  expectCode(() => validateJobContract([]), 'JOB_CONTRACT_INVALID');
});

// JC02 - job_id normalization deterministic (NFKC, trim, lowercase).
test('JC02', () => {
  assert.strictEqual(canonicalizeJobId('  ACC.JC02.Core  '), 'acc.jc02.core');
  assert.strictEqual(canonicalizeJobId('ACC.JC02.Core'), 'acc.jc02.core');
  assert.strictEqual(canonicalizeJobId('\uFF21\uFF23\uFF23\uFF0D\uFF2A\uFF23\uFF10\uFF12'), 'acc-jc02');
  const first = canonicalizeJobId('  ACC.JC02.Core  ');
  for (let i = 0; i < 100; i += 1) {
    assert.strictEqual(canonicalizeJobId('  ACC.JC02.Core  '), first, `iteration ${i} diverged`);
  }
  assert.strictEqual(createJobContract(creationInput('  ACC.JC02.Core  '), new Map()).job_id, 'acc.jc02.core');
  assert.strictEqual(deriveNamespaces('  ACC.JC02.Core  ').session_namespace, 'job:acc.jc02.core:sessions');
});

// JC03 - invalid job_id rejected (representative boundary-invalid inputs).
test('JC03', () => {
  const invalid = [42, null, undefined, '', '   ', 'bad/id', 'bad id', 'bad:id', '-lead', '.lead', 'acc#x', 'acc\\x', 'a'.repeat(65)];
  for (const value of invalid) {
    expectCode(() => canonicalizeJobId(value), 'INVALID_JOB_ID');
    expectCode(() => createJobContract(creationInput(value), new Map()), 'INVALID_JOB_ID');
  }
  assert.strictEqual(canonicalizeJobId('a'.repeat(64)), 'a'.repeat(64));
  assert.strictEqual(createJobContract(creationInput('a'.repeat(64)), new Map()).job_id, 'a'.repeat(64));
});

// JC04 - create collision fails while exact persisted reuse is idempotent.
test('JC04', () => {
  const { contract, store } = createdAndPersisted('acc.jc04.core');
  expectCode(() => createJobContract(creationInput('acc.jc04.core'), store), 'JOB_ID_COLLISION');
  expectCode(() => createJobContract(creationInput('  ACC.JC04.Core  '), store), 'JOB_ID_COLLISION');
  const reused = reuseJobContract(contract, store);
  assert.deepStrictEqual(reused, contract);
  assert.ok(Object.isFrozen(reused));
  assert.strictEqual(JSON.stringify(reuseJobContract(reused, store)), JSON.stringify(contract));
  expectCode(() => reuseJobContract(Object.assign({}, contract, { knowledge_scope: ['JOB_LOCAL', 'GLOBAL'] }), store), 'JOB_ID_COLLISION');
  expectCode(() => reuseJobContract(contract, new Map()), 'JOB_CONTRACT_INVALID');
});

// JC05 - profile required and valid; case preservation intact.
test('JC05', () => {
  const complete = creationInput('acc.jc05.core');
  const missing = Object.assign({}, complete);
  delete missing.profile;
  expectCode(() => createJobContract(missing, new Map()), 'JOB_CONTRACT_INVALID');
  assert.strictEqual(createJobContract(creationInput('acc.jc05.core', { profile: '  PGNAnalyst  ' }), new Map()).profile, 'PGNAnalyst');
  assert.strictEqual(createJobContract(creationInput('acc.jc05.core', { profile: 'pgnanalyst' }), new Map()).profile, 'pgnanalyst');
  assert.notStrictEqual(
    createJobContract(creationInput('acc.jc05.core', { profile: 'PGNAnalyst' }), new Map()).profile,
    createJobContract(creationInput('acc.jc05.core', { profile: 'pgnanalyst' }), new Map()).profile
  );
  for (const profile of ['bad profile', 'bad/profile', 'bad\\profile', '-lead', '.lead', '', '   ', 42, null]) {
    expectCode(() => createJobContract(creationInput('acc.jc05.b', { profile }), new Map()), 'PROFILE_BINDING_INVALID');
  }
});

// JC06 - active profile binding immutable; mismatch fails closed.
test('JC06', () => {
  const { contract, store } = createdAndPersisted('acc.jc06.core', { profile: 'PGNAnalyst' });
  assert.strictEqual(assertProfileBinding(contract, 'PGNAnalyst'), true);
  assert.strictEqual(assertProfileBinding(contract, '  PGNAnalyst  '), true);
  expectCode(() => assertProfileBinding(contract, 'pgnanalyst'), 'PROFILE_BINDING_MISMATCH');
  expectCode(() => assertProfileBinding(contract, 'OtherProfile'), 'PROFILE_BINDING_MISMATCH');
  expectCode(() => assertProfileBinding(contract, 'bad profile'), 'PROFILE_BINDING_INVALID');
  expectCode(() => reuseJobContract(Object.assign({}, contract, { profile: 'OtherProfile' }), store), 'PROFILE_BINDING_MISMATCH');
});

// JC07 - namespace fields derived and caller override rejected.
test('JC07', () => {
  const jobId = 'acc.jc07.core';
  const contract = createJobContract(creationInput(jobId), new Map());
  const derived = deriveNamespaces(jobId);
  assert.strictEqual(contract.session_namespace, derived.session_namespace);
  assert.strictEqual(contract.evidence_namespace, derived.evidence_namespace);
  assert.strictEqual(contract.ledger_namespace, derived.ledger_namespace);
  assert.strictEqual(contract.runtime_state_namespace, derived.runtime_state_namespace);
  assert.strictEqual(deriveNamespace('knowledge_job_local_namespace', jobId), 'job:acc.jc07.core:knowledge');
  for (const field of NAMESPACE_FIELDS) {
    const override = creationInput('acc.jc07.b');
    override[field] = 'job:evil:override';
    expectCode(() => createJobContract(override, new Map()), 'NAMESPACE_OVERRIDE_FORBIDDEN');
  }
  expectCode(() => validateJobContract(Object.assign({}, contract, { ledger_namespace: 'job:evil:ledger' })), 'NAMESPACE_OVERRIDE_FORBIDDEN');
  expectCode(() => validateJobContract(Object.assign({}, contract, { session_namespace: 'job:acc.jc07.core:sessions-extra' })), 'NAMESPACE_OVERRIDE_FORBIDDEN');
});

// JC08 - knowledge scopes explicit and canonically ordered.
test('JC08', () => {
  const contract = createJobContract(creationInput('acc.jc08.core', { knowledge_scope: ['GLOBAL', 'JOB_LOCAL', 'GLOBAL', 'SESSION_LOCAL'] }), new Map());
  assert.deepStrictEqual(contract.knowledge_scope, ['JOB_LOCAL', 'SESSION_LOCAL', 'GLOBAL']);
  assert.deepStrictEqual(createJobContract(creationInput('acc.jc08.b', { knowledge_scope: ['JOB_LOCAL', 'JOB_LOCAL'] }), new Map()).knowledge_scope, ['JOB_LOCAL']);
  for (const knowledge_scope of [[], ['GLOBAL'], ['SESSION_LOCAL'], ['GLOBAL', 'SESSION_LOCAL'], ['JOB_LOCAL', 'UNKNOWN'], ['JOB_LOCAL', 7], 'JOB_LOCAL', null]) {
    expectCode(() => createJobContract(creationInput('acc.jc08.c', { knowledge_scope }), new Map()), 'INVALID_KNOWLEDGE_SCOPE');
  }
  const { contract: persisted } = createdAndPersisted('acc.jc08.d', { knowledge_scope: ['JOB_LOCAL', 'GLOBAL'] });
  expectCode(() => validateJobContract(Object.assign({}, persisted, { knowledge_scope: ['GLOBAL', 'JOB_LOCAL'] })), 'INVALID_KNOWLEDGE_SCOPE');
  expectCode(() => validateJobContract(Object.assign({}, persisted, { knowledge_scope: ['JOB_LOCAL', 'JOB_LOCAL'] })), 'INVALID_KNOWLEDGE_SCOPE');
});

// JC09 - execution permissions explicit and canonically ordered.
test('JC09', () => {
  const contract = createJobContract(creationInput('acc.jc09.core', { execution_permissions: ['SECRET_ACCESS', 'DELETE', 'READ_ONLY', 'CONFIG_WRITE', 'LOW_RISK_WRITE', 'DELETE'] }), new Map());
  assert.deepStrictEqual(contract.execution_permissions, ['READ_ONLY', 'LOW_RISK_WRITE', 'CONFIG_WRITE', 'DELETE', 'SECRET_ACCESS']);
  for (const execution_permissions of [[], ['DELETE'], ['LOW_RISK_WRITE'], ['READ_ONLY', 'UNKNOWN'], ['READ_ONLY', 7], 'READ_ONLY', null]) {
    expectCode(() => createJobContract(creationInput('acc.jc09.b', { execution_permissions }), new Map()), 'INVALID_EXECUTION_PERMISSIONS');
  }
  const { contract: persisted } = createdAndPersisted('acc.jc09.c', { execution_permissions: ['READ_ONLY', 'DELETE'] });
  expectCode(() => validateJobContract(Object.assign({}, persisted, { execution_permissions: ['DELETE', 'READ_ONLY'] })), 'INVALID_EXECUTION_PERMISSIONS');
  expectCode(() => validateJobContract(Object.assign({}, persisted, { execution_permissions: ['READ_ONLY', 'READ_ONLY'] })), 'INVALID_EXECUTION_PERMISSIONS');
});

// JC10 - identical canonical input produces identical JobContract (100x stress).
test('JC10', () => {
  const input = {
    job_id: '  ACC.JC10.Stress  ',
    profile: '  PGN-Acceptance  ',
    knowledge_scope: ['GLOBAL', 'JOB_LOCAL', 'GLOBAL'],
    execution_permissions: ['DELETE', 'READ_ONLY', 'DELETE'],
  };
  const first = JSON.stringify(createJobContract(input, new Map()));
  for (let i = 0; i < 100; i += 1) {
    assert.strictEqual(JSON.stringify(createJobContract(input, new Map())), first, `iteration ${i} diverged`);
  }
  const contract = createJobContract(input, new Map());
  const store = new Map([[contract.job_id, contract]]);
  const firstReuse = JSON.stringify(reuseJobContract(contract, store));
  for (let i = 0; i < 100; i += 1) {
    assert.strictEqual(JSON.stringify(reuseJobContract(contract, store)), firstReuse, `reuse iteration ${i} diverged`);
    assert.strictEqual(JSON.stringify(validateJobContract(contract)), JSON.stringify(contract));
  }
  // no wall clock, randomness, environment, or unordered iteration may influence the result
  const source = fs.readFileSync(__filename, 'utf8');
  const forbiddenTokens = ['Math' + '.random', 'Date' + '.now', 'new ' + 'Date', 'process' + '.env', 'process' + '.hrtime', 'performance' + '.now'];
  for (const token of forbiddenTokens) {
    assert.ok(!source.includes(token), `acceptance suite must not use: ${token}`);
  }
});

// ---------------------------------------------------------------------------
// Namespace Isolation - NS01-NS10
// ---------------------------------------------------------------------------

// NS01 - same session + same job stays inside job boundary.
test('NS01', () => {
  const contract = makeContract('acc.ns01.job');
  const decision = evaluateSessionAccess(contract, sessionRequest(contract, { resource_scope: 'JOB_SCOPED', owner_session_id: 'session-one' }));
  assert.deepStrictEqual(decision, { allowed: true, same_job: true, same_session: true, resource_scope: 'JOB_SCOPED' });
  assert.ok(Object.isFrozen(decision));
  const local = evaluateSessionAccess(contract, sessionRequest(contract, { resource_scope: 'SESSION_LOCAL', owner_session_id: 'session-one' }));
  assert.deepStrictEqual(local, { allowed: true, same_job: true, same_session: true, resource_scope: 'SESSION_LOCAL' });
});

// NS02 - different sessions + same job share only job-scoped state.
test('NS02', () => {
  const contract = makeContract('acc.ns02.job');
  const shared = evaluateSessionAccess(contract, sessionRequest(contract, { resource_scope: 'JOB_SCOPED', owner_session_id: 'session-two' }));
  assert.deepStrictEqual(shared, { allowed: true, same_job: true, same_session: false, resource_scope: 'JOB_SCOPED' });
  const localRead = evaluateSessionAccess(contract, sessionRequest(contract, { operation: 'READ', resource_scope: 'SESSION_LOCAL', owner_session_id: 'session-two' }));
  assert.deepStrictEqual(localRead, { allowed: false, same_job: true, same_session: false, resource_scope: 'SESSION_LOCAL' });
  const localWrite = evaluateSessionAccess(contract, sessionRequest(contract, { operation: 'WRITE', resource_scope: 'SESSION_LOCAL', owner_session_id: 'session-two' }));
  assert.deepStrictEqual(localWrite, { allowed: false, same_job: true, same_session: false, resource_scope: 'SESSION_LOCAL' });
  assert.strictEqual(localWrite.code, undefined, 'ordinary denial exposes no domain .code');
});

// NS03 - same session + different job rejects foreign-job access.
test('NS03', () => {
  const contract = makeContract('acc.ns03.job-a');
  const other = makeContract('acc.ns03.job-b');
  for (const resourceScope of ['JOB_SCOPED', 'SESSION_LOCAL']) {
    expectCode(() => evaluateSessionAccess(contract, sessionRequest(contract, {
      operation: 'READ',
      resource_scope: resourceScope,
      resource_job_id: other.job_id,
      resource_namespace: other.session_namespace,
      requester_session_id: 'session-one',
      owner_session_id: 'session-one',
    })), 'FOREIGN_JOB_REJECT');
  }
});

// NS04 - different session + different job fully isolated.
test('NS04', () => {
  const contract = makeContract('acc.ns04.job-a');
  const other = makeContract('acc.ns04.job-b');
  for (const resourceScope of ['JOB_SCOPED', 'SESSION_LOCAL']) {
    expectCode(() => evaluateSessionAccess(contract, sessionRequest(contract, {
      operation: 'READ',
      resource_scope: resourceScope,
      resource_job_id: other.job_id,
      resource_namespace: other.session_namespace,
      requester_session_id: 'session-one',
      owner_session_id: 'session-two',
    })), 'FOREIGN_JOB_REJECT');
    expectCode(() => evaluateSessionAccess(contract, sessionRequest(contract, {
      operation: 'WRITE',
      resource_scope: resourceScope,
      resource_job_id: other.job_id,
      resource_namespace: other.session_namespace,
      requester_session_id: 'session-one',
      owner_session_id: 'session-two',
    })), 'FOREIGN_NAMESPACE_WRITE_REJECTED');
  }
});

// NS05 - JOB_LOCAL knowledge rejects foreign job.
test('NS05', () => {
  const contract = makeContract('acc.ns05.job-a', { knowledge_scope: ['JOB_LOCAL'] });
  const other = makeContract('acc.ns05.job-b');
  const foreignNamespace = deriveNamespaces(other.job_id).knowledge_job_local_namespace;
  expectCode(() => evaluateKnowledgeReadEligibility(contract, {
    requester_session_id: 'session-one',
    source_scope: 'JOB_LOCAL',
    source_job_id: other.job_id,
    source_session_id: null,
    source_namespace: foreignNamespace,
  }), 'FOREIGN_JOB_REJECT');
  expectCode(() => evaluateKnowledgeReadEligibility(contract, {
    requester_session_id: 'session-one',
    source_scope: 'JOB_LOCAL',
    source_job_id: other.job_id,
    source_session_id: null,
    source_namespace: deriveNamespaces(contract.job_id).knowledge_job_local_namespace,
  }), 'FOREIGN_JOB_REJECT');
  assert.deepStrictEqual(evaluateKnowledgeReadEligibility(contract, {
    requester_session_id: 'session-one',
    source_scope: 'JOB_LOCAL',
    source_job_id: contract.job_id,
    source_session_id: null,
    source_namespace: deriveNamespaces(contract.job_id).knowledge_job_local_namespace,
  }), { eligible: true, scope: 'JOB_LOCAL' });
});

// NS06 - SESSION_LOCAL requires same job + same session; session never overrides foreign-job isolation.
test('NS06', () => {
  const contract = makeContract('acc.ns06.job-a', { knowledge_scope: ['JOB_LOCAL', 'SESSION_LOCAL'] });
  const other = makeContract('acc.ns06.job-b');
  const knsA = deriveNamespaces('acc.ns06.job-a').knowledge_job_local_namespace;
  const knsB = deriveNamespaces('acc.ns06.job-b').knowledge_job_local_namespace;
  assert.deepStrictEqual(evaluateKnowledgeReadEligibility(contract, {
    requester_session_id: 'session-one', source_scope: 'SESSION_LOCAL',
    source_job_id: 'acc.ns06.job-a', source_session_id: 'session-one', source_namespace: knsA,
  }), { eligible: true, scope: 'SESSION_LOCAL' });
  assert.deepStrictEqual(evaluateKnowledgeReadEligibility(contract, {
    requester_session_id: 'session-one', source_scope: 'SESSION_LOCAL',
    source_job_id: 'acc.ns06.job-a', source_session_id: 'session-two', source_namespace: knsA,
  }), { eligible: false, scope: 'SESSION_LOCAL' });
  expectCode(() => evaluateKnowledgeReadEligibility(contract, {
    requester_session_id: 'session-one', source_scope: 'SESSION_LOCAL',
    source_job_id: other.job_id, source_session_id: 'session-one', source_namespace: knsB,
  }), 'FOREIGN_JOB_REJECT');
  expectCode(() => evaluateKnowledgeReadEligibility(contract, {
    requester_session_id: 'session-one', source_scope: 'SESSION_LOCAL',
    source_job_id: other.job_id, source_session_id: 'session-two', source_namespace: knsB,
  }), 'FOREIGN_JOB_REJECT');
});

// NS07 - GLOBAL requires explicit job capability + explicitly global source; no promotion of foreign data.
test('NS07', () => {
  const full = makeContract('acc.ns07.job-a', { knowledge_scope: ['JOB_LOCAL', 'SESSION_LOCAL', 'GLOBAL'] });
  const base = makeContract('acc.ns07.job-a', { knowledge_scope: ['JOB_LOCAL'] });
  const other = makeContract('acc.ns07.job-b');
  const knsA = deriveNamespaces('acc.ns07.job-a').knowledge_job_local_namespace;
  const knsB = deriveNamespaces('acc.ns07.job-b').knowledge_job_local_namespace;
  assert.deepStrictEqual(evaluateKnowledgeReadEligibility(full, {
    requester_session_id: 'session-one', source_scope: 'GLOBAL',
    source_job_id: null, source_session_id: null, source_namespace: null,
  }), { eligible: true, scope: 'GLOBAL' });
  assert.deepStrictEqual(evaluateKnowledgeReadEligibility(base, {
    requester_session_id: 'session-one', source_scope: 'GLOBAL',
    source_job_id: null, source_session_id: null, source_namespace: null,
  }), { eligible: false, scope: 'GLOBAL' });
  assert.deepStrictEqual(evaluateKnowledgeReadEligibility(full, {
    requester_session_id: 'session-one', source_scope: 'GLOBAL',
    source_job_id: 'acc.ns07.job-a', source_session_id: null, source_namespace: knsA,
  }), { eligible: true, scope: 'GLOBAL' });
  expectCode(() => evaluateKnowledgeReadEligibility(full, {
    requester_session_id: 'session-one', source_scope: 'GLOBAL',
    source_job_id: other.job_id, source_session_id: null, source_namespace: knsB,
  }), 'FOREIGN_JOB_REJECT');
  expectCode(() => evaluateKnowledgeReadEligibility(full, {
    requester_session_id: 'session-one', source_scope: 'GLOBAL',
    source_job_id: other.job_id, source_session_id: null, source_namespace: knsA,
  }), 'FOREIGN_JOB_REJECT');
  expectCode(() => evaluateKnowledgeReadEligibility(full, {
    requester_session_id: 'session-one', source_scope: 'GLOBAL',
    source_job_id: null, source_session_id: null, source_namespace: knsA,
  }), 'NAMESPACE_COLLISION');
  assert.strictEqual(Object.keys(require('../../job-isolation/knowledge-scope.js')).some((name) => /write/i.test(name)), false, 'no global write authorization exists');
});

// NS08 - evidence from Job A cannot satisfy Job B.
test('NS08', () => {
  const a = makeContract('acc.ns08.job-a');
  const b = makeContract('acc.ns08.job-b');
  assert.deepStrictEqual(evaluateEvidenceAccess(a, {
    operation: 'READ', resource_job_id: 'acc.ns08.job-a', resource_namespace: a.evidence_namespace,
  }), { allowed: true, same_job: true, operation: 'READ' });
  expectCode(() => evaluateEvidenceAccess(b, {
    operation: 'READ', resource_job_id: a.job_id, resource_namespace: a.evidence_namespace,
  }), 'FOREIGN_JOB_REJECT');
  expectCode(() => evaluateEvidenceAccess(b, {
    operation: 'READ', resource_job_id: a.job_id, resource_namespace: b.evidence_namespace,
  }), 'FOREIGN_JOB_REJECT');
  expectCode(() => evaluateEvidenceAccess(b, {
    operation: 'WRITE', resource_job_id: a.job_id, resource_namespace: a.evidence_namespace,
  }), 'FOREIGN_NAMESPACE_WRITE_REJECTED');
  expectCode(() => evaluateEvidenceAccess(a, {
    operation: 'READ', resource_job_id: 'acc.ns08.job-a', resource_namespace: b.evidence_namespace,
  }), 'NAMESPACE_COLLISION');
});

// NS09 - ledger/runtime mutable state reject foreign-job access/write; cleanup ownership enforced.
test('NS09', () => {
  const a = makeContract('acc.ns09.job-a');
  const b = makeContract('acc.ns09.job-b');
  assert.deepStrictEqual(evaluateLedgerAccess(a, {
    operation: 'WRITE', resource_job_id: 'acc.ns09.job-a', resource_namespace: a.ledger_namespace,
  }), { allowed: true, same_job: true, operation: 'WRITE' });
  assert.deepStrictEqual(evaluateRuntimeStateAccess(a, {
    operation: 'WRITE', resource_job_id: 'acc.ns09.job-a', resource_namespace: a.runtime_state_namespace,
  }), { allowed: true, same_job: true, operation: 'WRITE' });
  expectCode(() => evaluateLedgerAccess(a, {
    operation: 'READ', resource_job_id: b.job_id, resource_namespace: b.ledger_namespace,
  }), 'FOREIGN_JOB_REJECT');
  expectCode(() => evaluateLedgerAccess(a, {
    operation: 'WRITE', resource_job_id: b.job_id, resource_namespace: b.ledger_namespace,
  }), 'FOREIGN_NAMESPACE_WRITE_REJECTED');
  expectCode(() => evaluateRuntimeStateAccess(a, {
    operation: 'READ', resource_job_id: b.job_id, resource_namespace: b.runtime_state_namespace,
  }), 'FOREIGN_NAMESPACE_WRITE_REJECTED');
  expectCode(() => evaluateRuntimeStateAccess(a, {
    operation: 'WRITE', resource_job_id: b.job_id, resource_namespace: b.runtime_state_namespace,
  }), 'FOREIGN_NAMESPACE_WRITE_REJECTED');
  assert.deepStrictEqual(evaluateRuntimeStateCleanup(a, {
    operation: 'CLEANUP', resource_job_id: 'acc.ns09.job-a', resource_namespace: a.runtime_state_namespace,
  }), { allowed: true, same_job: true, operation: 'CLEANUP' });
  expectCode(() => evaluateRuntimeStateCleanup(a, {
    operation: 'CLEANUP', resource_job_id: b.job_id, resource_namespace: b.runtime_state_namespace,
  }), 'FOREIGN_NAMESPACE_WRITE_REJECTED');
});

// NS10 - namespace derivation deterministic; ambiguity/collision behavior fails closed.
test('NS10', () => {
  const jobId = 'acc.ns10.job';
  const first = JSON.stringify(deriveNamespaces(jobId));
  for (let i = 0; i < 100; i += 1) {
    assert.strictEqual(JSON.stringify(deriveNamespaces(jobId)), first, `iteration ${i} diverged`);
  }
  assert.strictEqual(JSON.stringify(deriveNamespaces('  ACC.NS10.Job  ')), first);
  const derived = deriveNamespaces(jobId);
  for (const field of NAMESPACE_FIELDS) {
    assert.ok(!derived[field].includes('{job_id}'), `${field} must contain no unresolved placeholder`);
    assert.ok(!/^job:(default|global|shared|unknown):/.test(derived[field]), `${field} must not fall back to a shared namespace`);
  }
  assert.strictEqual(new Set(Object.values(derived)).size, 5, 'derived namespaces must be pairwise distinct');
  assert.strictEqual(POLICY.namespaces.collision_error, 'NAMESPACE_COLLISION');
  assert.strictEqual(POLICY.namespaces.fallback, 'NONE');
  expectCode(() => deriveNamespace('default', jobId), 'NAMESPACE_DERIVATION_FAILED');
  expectCode(() => deriveNamespace('shared', jobId), 'NAMESPACE_DERIVATION_FAILED');
  expectCode(() => deriveNamespaces('bad/id'), 'INVALID_JOB_ID');
  const exact = {
    session_namespace: derived.session_namespace,
    evidence_namespace: derived.evidence_namespace,
    ledger_namespace: derived.ledger_namespace,
    runtime_state_namespace: derived.runtime_state_namespace,
  };
  assert.strictEqual(assertNamespaceIntegrity(jobId, exact), true);
  expectCode(() => assertNamespaceIntegrity(jobId, Object.assign({}, exact, { ledger_namespace: 'job:foreign:ledger' })), 'NAMESPACE_OVERRIDE_FORBIDDEN');
  expectCode(() => assertNamespaceIntegrity(jobId, null), 'NAMESPACE_OVERRIDE_FORBIDDEN');
});

// ---------------------------------------------------------------------------
// Parallel Lanes - PL01-PL10
// ---------------------------------------------------------------------------

// PL01 - one active writer per lane.
test('PL01', () => {
  assert.strictEqual(POLICY.parallel_lane.one_active_writer_per_lane, true);
  const registered = registerLane(createLaneRegistry(), laneInput());
  assert.strictEqual(registered.ok, true);
  const secondWriter = registerLane(registered.registry, laneInput({ writer_identity: 'writer-other' }));
  assert.strictEqual(secondWriter.ok, false);
  assert.strictEqual(secondWriter.error, 'LANE_OWNERSHIP_CONFLICT');
  assert.strictEqual(evaluateOwnership(registered.lane, 'writer-other').error, 'LANE_OWNERSHIP_CONFLICT');
  assert.strictEqual(evaluateOwnership(registered.lane, 'writer-42').ok, true);
});

// PL02 - multiple independent lanes may operate concurrently (100x lane identity resolution).
test('PL02', () => {
  const registryA = registerLane(createLaneRegistry(), laneInput());
  const registryAB = registerLane(registryA.registry, laneInputB());
  assert.strictEqual(registryAB.ok, true);
  assert.strictEqual(registryAB.registry.length, 2);
  assert.strictEqual(evaluateOwnership(registryAB.registry[0], 'writer-42').ok, true);
  assert.strictEqual(evaluateOwnership(registryAB.registry[1], 'writer-43').ok, true);
  assert.strictEqual(evaluateStaleBaseline(registryAB.registry[0], BASELINE_SHA).ok, true);
  assert.strictEqual(evaluateStaleBaseline(registryAB.registry[1], PRIOR_SHA).ok, true);
  const scenario = () => JSON.stringify({
    a: createLane(laneInput()),
    b: createLane(laneInputB()),
    ab: registerLane(registerLane(createLaneRegistry(), laneInput()).registry, laneInputB()),
  });
  const first = scenario();
  for (let i = 0; i < 100; i += 1) {
    assert.strictEqual(scenario(), first, `iteration ${i} diverged`);
  }
});

// PL03 - lane job binding immutable.
test('PL03', () => {
  assert.strictEqual(POLICY.parallel_lane.lane_id.job_rebinding, 'FORBIDDEN');
  assert.ok(POLICY.parallel_lane.immutable_fields.includes('job_id'));
  const registered = registerLane(createLaneRegistry(), laneInput());
  const rebound = registerLane(registered.registry, laneInput({ job_id: 'acc.pl.job-other' }));
  assert.strictEqual(rebound.ok, false);
  assert.strictEqual(rebound.error, 'LANE_ID_COLLISION');
  assert.strictEqual(createLane(laneInput({ job_id: '' })).error, 'LANE_CONTRACT_INVALID');
});

// PL04 - cross-lane write ownership violation rejected.
test('PL04', () => {
  const a = createLane(laneInput()).lane;
  const b = createLane(laneInputB()).lane;
  assert.strictEqual(evaluateCrossLaneClaim(a, b).ok, false);
  assert.strictEqual(evaluateCrossLaneClaim(a, b).error, 'CROSS_LANE_WRITE_REJECTED');
  assert.strictEqual(evaluateCrossLaneClaim(b, a).error, 'CROSS_LANE_WRITE_REJECTED');
  assert.strictEqual(evaluateCrossLaneClaim(a, a).ok, true);
  const forgedWriter = Object.assign({}, a, { writer_identity: 'writer-other' });
  assert.strictEqual(evaluateCrossLaneClaim(forgedWriter, a).error, 'LANE_OWNERSHIP_CONFLICT');
});

// PL05 - coordination checkout remains main-only.
test('PL05', () => {
  assert.strictEqual(POLICY.coordination.coordination_checkout, 'MAIN_ONLY');
  assert.deepStrictEqual(evaluateCoordinationCheckout('main'), { ok: true, branch: 'main' });
  for (const branch of ['develop', 'Main', 'main ', 'feature/x', 'mains']) {
    assert.strictEqual(evaluateCoordinationCheckout(branch).error, 'COORDINATION_CHECKOUT_VIOLATION');
  }
  assert.strictEqual(evaluateCoordinationCheckout(42).error, 'LANE_CONTRACT_INVALID');
  assert.strictEqual(evaluateCoordinationCheckout('').error, 'LANE_CONTRACT_INVALID');
  const state = createMainCoordinationState({ coordination_branch: 'main', authoritative_main_sha: BASELINE_SHA });
  assert.strictEqual(state.coordination_branch, 'main');
  expectCode(() => createMainCoordinationState({ coordination_branch: 'develop', authoritative_main_sha: BASELINE_SHA }), 'COORDINATION_CHECKOUT_VIOLATION');
});

// PL06 - writer lane branch cannot be main.
test('PL06', () => {
  assert.strictEqual(POLICY.coordination.writer_branch_cannot_be_main, true);
  assert.strictEqual(createLane(laneInput({ branch: 'main' })).error, 'COORDINATION_CHECKOUT_VIOLATION');
  assert.strictEqual(registerLane(createLaneRegistry(), laneInput({ branch: 'main' })).error, 'COORDINATION_CHECKOUT_VIOLATION');
  assert.strictEqual(createLane(laneInput({ branch: 'main', baseline_main_sha: 'not-a-sha' })).error, 'LANE_CONTRACT_INVALID');
});

// PL07 - baseline_main_sha required; malformed/missing fails closed.
test('PL07', () => {
  assert.strictEqual(POLICY.parallel_lane.baseline_main_sha.required, true);
  assert.strictEqual(POLICY.parallel_lane.baseline_main_sha.pattern, '^[0-9a-f]{40}$');
  const missing = laneInput();
  delete missing.baseline_main_sha;
  assert.strictEqual(createLane(missing).error, 'LANE_CONTRACT_INVALID');
  for (const sha of ['', 'A'.repeat(40), 'g'.repeat(40), 'a'.repeat(39), 'a'.repeat(41), ` ${BASELINE_SHA}`, 42, null]) {
    assert.strictEqual(createLane(laneInput({ baseline_main_sha: sha })).error, 'LANE_CONTRACT_INVALID');
  }
  assert.strictEqual(createLane(laneInput({ baseline_main_sha: '0'.repeat(40) })).ok, true);
});

// PL08 - stale main baseline detected; only governed audited synchronization clears it.
test('PL08', () => {
  const created = createLane(laneInput());
  assert.deepStrictEqual(evaluateStaleBaseline(created.lane, BASELINE_SHA), { ok: true, stale: false });
  const stale = evaluateStaleBaseline(created.lane, PRIOR_SHA);
  assert.strictEqual(stale.ok, false);
  assert.strictEqual(stale.error, 'STALE_MAIN_BASELINE');
  assert.strictEqual(stale.stale, true);
  assert.strictEqual(evaluateStaleBaseline(created.lane, PRIOR_SHA, { synchronized_to_sha: PRIOR_SHA }).error, 'STALE_MAIN_BASELINE');
  const state0 = createMainCoordinationState({ coordination_branch: 'main', authoritative_main_sha: PRIOR_SHA });
  const state1 = registerCoordinationLane(state0, laneInput());
  expectCode(() => evaluateMergeEligibility(state1, mergeRequest()), 'STALE_MAIN_BASELINE');
  const state2 = recordAuditedSynchronization(state1, laneInput(), 'acc-pl08-audit');
  const decision = evaluateMergeEligibility(state2, mergeRequest());
  assert.strictEqual(decision.merge_eligible, true);
  assert.strictEqual(decision.synchronized, true);
  assert.strictEqual(decision.audit_ref, 'acc-pl08-audit');
  assert.strictEqual(decision.authoritative_main_sha, PRIOR_SHA);
});

// PL09 - tracked worktree representation remains machine-neutral.
test('PL09', () => {
  const scanTargets = [
    'runtime/job-isolation/job-contract.js',
    'runtime/job-isolation/namespace-derivation.js',
    'runtime/job-isolation/namespace-isolation.js',
    'runtime/job-isolation/knowledge-scope.js',
    'runtime/job-isolation/parallel-lane.js',
    'runtime/job-isolation/coordinator.js',
    'runtime/tests/job-isolation/acceptance.test.js',
    'runtime/tests/job-isolation/run-all.js',
    'runtime/tests/job-isolation/runner.test.js',
    'runtime/tests/job-isolation/contract.test.js',
    'governance/contracts/job-isolation-v1.md',
    'governance/policies/job-isolation.json',
    'docs/architecture/job-isolation.md',
    'docs/acceptance/phase-9b.md',
  ];
  const machinePathPatterns = machinePathScanPatterns();
  for (const rel of scanTargets) {
    const source = read(rel);
    for (const pattern of machinePathPatterns) {
      assert.ok(!pattern.test(source), `${rel} must not contain a machine-specific path`);
    }
  }
  assert.ok(laneInput().worktree.startsWith('<worktree-root>/'));
  assert.ok(POLICY.coordination.machine_neutral_examples.includes('<coordination-checkout>'));
  assert.ok(POLICY.coordination.machine_neutral_examples.includes('<worktree-root>/<issue-id>'));
});

// PL10 - stale lane state never becomes authoritative main implicitly.
test('PL10', () => {
  assert.strictEqual(POLICY.coordination.stale_lane_is_authoritative_main, false);
  const state0 = createMainCoordinationState({ coordination_branch: 'main', authoritative_main_sha: PRIOR_SHA });
  const state1 = registerCoordinationLane(state0, laneInput());
  expectCode(() => evaluateMergeEligibility(state1, mergeRequest()), 'STALE_MAIN_BASELINE');
  expectCode(() => evaluateMergeEligibility(state1, mergeRequest()), 'STALE_MAIN_BASELINE');
  assert.strictEqual(state1.synchronizations.length, 0, 'no implicit synchronization may exist');
  assert.strictEqual(state1.authoritative_main_sha, PRIOR_SHA);
  const state2 = recordAuditedSynchronization(state1, laneInput(), 'acc-pl10-audit');
  assert.strictEqual(evaluateMergeEligibility(state2, mergeRequest()).synchronized, true);
  expectCode(() => evaluateMergeEligibility(state1, mergeRequest()), 'STALE_MAIN_BASELINE');
  assert.strictEqual(state1.synchronizations.length, 0, 'original stale state must remain unchanged');
});

// ---------------------------------------------------------------------------
// Execution / Policy - EP01-EP10
// ---------------------------------------------------------------------------

// EP01 - execution permissions explicit and READ_ONLY present.
test('EP01', () => {
  assert.strictEqual(POLICY.execution_permissions.read_only_required, true);
  const contract = createJobContract(creationInput('acc.ep01.core', { execution_permissions: ['READ_ONLY'] }), new Map());
  assert.deepStrictEqual(contract.execution_permissions, ['READ_ONLY']);
  for (const execution_permissions of [[], ['DELETE'], ['LOW_RISK_WRITE'], ['CONFIG_WRITE'], ['SECRET_ACCESS']]) {
    expectCode(() => createJobContract(creationInput('acc.ep01.b', { execution_permissions }), new Map()), 'INVALID_EXECUTION_PERMISSIONS');
  }
  const full = createJobContract(creationInput('acc.ep01.c', { execution_permissions: ['READ_ONLY', 'LOW_RISK_WRITE', 'CONFIG_WRITE', 'DELETE', 'SECRET_ACCESS'] }), new Map());
  assert.deepStrictEqual(full.execution_permissions, ['READ_ONLY', 'LOW_RISK_WRITE', 'CONFIG_WRITE', 'DELETE', 'SECRET_ACCESS']);
});

// EP02 - unknown permission fails closed.
test('EP02', () => {
  assert.strictEqual(POLICY.execution_permissions.unknown_error, 'INVALID_EXECUTION_PERMISSIONS');
  assert.strictEqual(POLICY.execution_permissions.empty, 'INVALID');
  for (const execution_permissions of [['READ_ONLY', 'SUPER_USER'], ['READ_ONLY', 'ADMIN'], ['READ_ONLY', 7], ['READ_ONLY', null], 'READ_ONLY', null, 42]) {
    expectCode(() => createJobContract(creationInput('acc.ep02.core', { execution_permissions }), new Map()), 'INVALID_EXECUTION_PERMISSIONS');
  }
  const { contract } = createdAndPersisted('acc.ep02.d');
  expectCode(() => validateJobContract(Object.assign({}, contract, { execution_permissions: ['READ_ONLY', 'SUPER_USER'] })), 'INVALID_EXECUTION_PERMISSIONS');
});

// EP03 - JobContract permissions are capability ceilings, not approvals.
test('EP03', () => {
  assert.strictEqual(POLICY.execution_permissions.capability_ceiling_not_authorization, true);
  for (const key of ['READ_ONLY', 'LOW_RISK_WRITE', 'CONFIG_WRITE', 'DELETE', 'SECRET_ACCESS']) {
    assert.strictEqual(POLICY.approval_mapping[key].contract_alone_authorizes_execution, false, `${key} must not authorize execution`);
  }
  const { contract, store } = createdAndPersisted('acc.ep03.core', { execution_permissions: ['READ_ONLY', 'DELETE'] });
  const ceiling = bindPermissionCeiling(contract, 'acc.ep03.core', store);
  assert.deepStrictEqual(Object.keys(ceiling), ['job_id', 'execution_permissions']);
  assert.ok(Object.isFrozen(ceiling));
  for (const value of Object.values(ceiling)) {
    assert.notStrictEqual(typeof value, 'function', 'the ceiling must not expose executable behavior');
  }
  assert.ok(!('approval' in ceiling) && !('authorized' in ceiling) && !('token' in ceiling), 'the ceiling is not an approval token');
});

// EP04 - WRITE-class capability still requires the approval gate.
test('EP04', () => {
  for (const key of ['LOW_RISK_WRITE', 'CONFIG_WRITE']) {
    const mapping = POLICY.approval_mapping[key];
    assert.strictEqual(mapping.action_class, 'WRITE');
    assert.strictEqual(mapping.approval_required, true);
    assert.strictEqual(mapping.contract_alone_authorizes_execution, false);
  }
  const approvalGate = read('.opencode/orchestrator/approval-gate.md');
  assert.ok(approvalGate.includes('No execution without approval.'));
  assert.ok(approvalGate.includes('wait for user approval'));
  const safeMode = read('.opencode/orchestrator/safe-mode.md');
  assert.ok(safeMode.includes('WRITE always requires approval.'));
  assert.ok(safeMode.includes('No execution is allowed before the user explicitly approves the plan.'));
  const { contract, store } = createdAndPersisted('acc.ep04.core', { execution_permissions: ['READ_ONLY', 'LOW_RISK_WRITE', 'CONFIG_WRITE'] });
  const ceiling = bindPermissionCeiling(contract, 'acc.ep04.core', store);
  assert.deepStrictEqual(ceiling.execution_permissions, ['READ_ONLY', 'LOW_RISK_WRITE', 'CONFIG_WRITE']);
  assert.ok(Object.isFrozen(ceiling.execution_permissions));
});

// EP05 - DELETE is not authorized by JobContract alone.
test('EP05', () => {
  const mapping = POLICY.approval_mapping.DELETE;
  assert.strictEqual(mapping.action_class, 'WRITE_DESTRUCTIVE');
  assert.strictEqual(mapping.contract_alone_authorizes_execution, false);
  assert.strictEqual(mapping.requires_separate_explicit_governing_authority, true);
  assert.strictEqual(mapping.otherwise, 'FAIL_CLOSED');
  const { contract, store } = createdAndPersisted('acc.ep05.core', { execution_permissions: ['READ_ONLY', 'DELETE'] });
  const ceiling = bindPermissionCeiling(contract, 'acc.ep05.core', store);
  assert.deepStrictEqual(ceiling.execution_permissions, ['READ_ONLY', 'DELETE']);
  assert.ok(Object.isFrozen(ceiling));
  assert.ok(!Object.keys(contract).some((field) => /authorize|approval|execute/i.test(field)), 'no authorization field exists on JobContract');
  assert.strictEqual(Object.keys(contract).length, 8);
});

// EP06 - SECRET_ACCESS is not authorized by JobContract alone.
test('EP06', () => {
  const mapping = POLICY.approval_mapping.SECRET_ACCESS;
  assert.strictEqual(mapping.action_class, 'PROTECTED_ACCESS');
  assert.strictEqual(mapping.contract_alone_authorizes_execution, false);
  assert.strictEqual(mapping.requires_separate_explicit_governing_authority, true);
  assert.strictEqual(mapping.otherwise, 'FAIL_CLOSED');
  assert.strictEqual(POLICY.profile.secret_reads, 'NOT_REQUIRED');
  const contract = createJobContract(creationInput('acc.ep06.core', { execution_permissions: ['READ_ONLY', 'SECRET_ACCESS'] }), new Map());
  assert.deepStrictEqual(contract.execution_permissions, ['READ_ONLY', 'SECRET_ACCESS']);
  const ceiling = bindPermissionCeiling(contract, 'acc.ep06.core', new Map([[contract.job_id, contract]]));
  assert.deepStrictEqual(ceiling.execution_permissions, ['READ_ONLY', 'SECRET_ACCESS']);
  assert.ok(Object.isFrozen(ceiling));
});

// EP07 - declared capability never bypasses foreign-job isolation.
test('EP07', () => {
  const powerful = makeContract('acc.ep07.job-a', {
    knowledge_scope: ['JOB_LOCAL', 'SESSION_LOCAL', 'GLOBAL'],
    execution_permissions: ['READ_ONLY', 'LOW_RISK_WRITE', 'CONFIG_WRITE', 'DELETE', 'SECRET_ACCESS'],
  });
  const other = makeContract('acc.ep07.job-b');
  const knsB = deriveNamespaces('acc.ep07.job-b').knowledge_job_local_namespace;
  expectCode(() => evaluateKnowledgeReadEligibility(powerful, {
    requester_session_id: 'session-one', source_scope: 'GLOBAL',
    source_job_id: other.job_id, source_session_id: null, source_namespace: knsB,
  }), 'FOREIGN_JOB_REJECT');
  expectCode(() => evaluateEvidenceAccess(powerful, {
    operation: 'WRITE', resource_job_id: other.job_id, resource_namespace: other.evidence_namespace,
  }), 'FOREIGN_NAMESPACE_WRITE_REJECTED');
  expectCode(() => evaluateRuntimeStateAccess(powerful, {
    operation: 'WRITE', resource_job_id: other.job_id, resource_namespace: other.runtime_state_namespace,
  }), 'FOREIGN_NAMESPACE_WRITE_REJECTED');
  const state = registerCoordinationLane(createMainCoordinationState({ coordination_branch: 'main', authoritative_main_sha: BASELINE_SHA }), laneInputB());
  expectCode(() => evaluateMergeEligibility(state, { contract: powerful, lane: laneInputB(), writer_identity: 'writer-43' }), 'FOREIGN_JOB_REJECT');
  expectCode(() => evaluateMergeEligibility(state, { contract: powerful, lane: laneInputB(), writer_identity: 'writer-other' }), 'FOREIGN_JOB_REJECT');
});

// EP08 - validation/error precedence deterministic (100x stress).
test('EP08', () => {
  assert.strictEqual(POLICY.validation_precedence.length, 10);
  const { contract } = createdAndPersisted('acc.ep08.core', { knowledge_scope: ['JOB_LOCAL', 'GLOBAL'], execution_permissions: ['READ_ONLY', 'DELETE'] });
  const steps = [
    [() => validateJobContract(Object.assign({}, contract, { bogus: 1, job_id: 'BAD ID', profile: 'bad profile', session_namespace: 'job:x:sessions', knowledge_scope: ['GLOBAL'], execution_permissions: ['DELETE'] })), 'JOB_CONTRACT_INVALID'],
    [() => validateJobContract(Object.assign({}, contract, { job_id: 'BAD ID', profile: 'bad profile', session_namespace: 'job:x:sessions', knowledge_scope: ['GLOBAL'], execution_permissions: ['DELETE'] })), 'INVALID_JOB_ID'],
    [() => validateJobContract(Object.assign({}, contract, { profile: 'bad profile', session_namespace: 'job:x:sessions', knowledge_scope: ['GLOBAL'], execution_permissions: ['DELETE'] })), 'PROFILE_BINDING_INVALID'],
    [() => validateJobContract(Object.assign({}, contract, { session_namespace: 'job:x:sessions', knowledge_scope: ['GLOBAL'], execution_permissions: ['DELETE'] })), 'NAMESPACE_OVERRIDE_FORBIDDEN'],
    [() => validateJobContract(Object.assign({}, contract, { knowledge_scope: ['GLOBAL'], execution_permissions: ['DELETE'] })), 'INVALID_KNOWLEDGE_SCOPE'],
    [() => validateJobContract(Object.assign({}, contract, { execution_permissions: ['DELETE'] })), 'INVALID_EXECUTION_PERMISSIONS'],
  ];
  for (const [fn, expected] of steps) {
    const err = expectCode(fn, expected);
    assert.ok(POLICY.canonical_errors.includes(err.code), `${err.code} must be one of the locked canonical identifiers`);
  }
  // level 7 (job identity boundary) precedes lane checks; level 8 precedes 9-10; level 9 precedes 10
  const state = registerCoordinationLane(createMainCoordinationState({ coordination_branch: 'main', authoritative_main_sha: PRIOR_SHA }), laneInput());
  expectCode(() => evaluateMergeEligibility(state, { contract: CONTRACT_A, lane: laneInputB(), writer_identity: 'writer-43' }), 'FOREIGN_JOB_REJECT');
  expectCode(() => evaluateMergeEligibility(state, { contract: CONTRACT_A, lane: { lane_id: 'bad id' }, writer_identity: 'writer-42' }), 'LANE_CONTRACT_INVALID');
  expectCode(() => evaluateMergeEligibility(state, { contract: CONTRACT_A, lane: laneInput({ writer_identity: 'writer-other' }), writer_identity: 'writer-other' }), 'LANE_OWNERSHIP_CONFLICT');
  expectCode(() => evaluateMergeEligibility(state, { contract: CONTRACT_A, lane: laneInput(), writer_identity: 'writer-42' }), 'STALE_MAIN_BASELINE');
  const battery = () => steps.map(([fn]) => {
    try {
      fn();
      return 'NO-ERROR';
    } catch (e) {
      return e.code;
    }
  });
  const first = JSON.stringify(battery());
  for (let i = 0; i < 100; i += 1) {
    assert.strictEqual(JSON.stringify(battery()), first, `iteration ${i} diverged`);
  }
  assert.deepStrictEqual(battery(), ['JOB_CONTRACT_INVALID', 'INVALID_JOB_ID', 'PROFILE_BINDING_INVALID', 'NAMESPACE_OVERRIDE_FORBIDDEN', 'INVALID_KNOWLEDGE_SCOPE', 'INVALID_EXECUTION_PERMISSIONS']);
});

// EP09 - unresolved identity/namespace ambiguity never falls back to shared/default scope.
test('EP09', () => {
  for (const badId of [null, undefined, '', '   ', 'bad/id']) {
    expectCode(() => canonicalizeJobId(badId), 'INVALID_JOB_ID');
    expectCode(() => deriveNamespaces(badId), 'INVALID_JOB_ID');
  }
  const contract = makeContract('acc.ep09.job');
  expectCode(() => evaluateSessionAccess(contract, {
    operation: 'READ', resource_job_id: 'acc.ep09.job', resource_namespace: null,
    resource_scope: 'JOB_SCOPED', requester_session_id: 'session-one', owner_session_id: 'session-one',
  }), 'NAMESPACE_DERIVATION_FAILED');
  expectCode(() => evaluateSessionAccess(contract, {
    operation: 'READ', resource_job_id: 'acc.ep09.job', resource_namespace: 'job:default:sessions',
    resource_scope: 'JOB_SCOPED', requester_session_id: 'session-one', owner_session_id: 'session-one',
  }), 'NAMESPACE_COLLISION');
  expectCode(() => evaluateEvidenceAccess(contract, {
    operation: 'READ', resource_job_id: 'acc.ep09.job', resource_namespace: 'job:shared:evidence',
  }), 'NAMESPACE_COLLISION');
  expectCode(() => evaluateKnowledgeReadEligibility(contract, {
    requester_session_id: 'session-one', source_scope: 'JOB_LOCAL',
    source_job_id: null, source_session_id: null, source_namespace: null,
  }), 'NAMESPACE_DERIVATION_FAILED');
  const derived = deriveNamespaces('acc.ep09.job');
  for (const field of NAMESPACE_FIELDS) {
    assert.ok(!/^job:(default|shared|global|unknown):/.test(derived[field]), `${field} must never resolve to a shared/default scope`);
  }
});

// EP10 - public tracked artifacts contain no secrets, private state, or machine-specific runtime data.
test('EP10', () => {
  const forbidden = POLICY.public_artifact_constraints.forbidden_content;
  for (const item of ['client_data', 'pgn_data', 'credentials', 'secret_profiles', 'runtime_auth_state', 'private_personal_memory', 'opencode_db', 'browser_profiles', 'machine_specific_evidence', 'machine_specific_runtime_databases', 'machine_specific_absolute_paths']) {
    assert.ok(forbidden.includes(item), `forbidden content must be declared: ${item}`);
  }
  // the repository security boundary and scanner remain the authority
  const boundary = read('docs/SECURITY-BOUNDARY.md');
  assert.ok(boundary.includes('# Security Boundary'));
  assert.ok(boundary.includes('Zero real secrets.'));
  assert.ok(boundary.includes('Zero client data.'));
  assert.ok(boundary.includes('Zero machine runtime state.'));
  const scanner = read('.github/scripts/security-scan.sh');
  assert.ok(scanner.includes('BEGIN (RSA|OPENSSH|EC) PRIVATE KEY'));
  assert.ok(scanner.includes('security-scan: PASS'));
  // tracked acceptance artifacts satisfy the prohibited-pattern scan
  const scanTargets = [
    'runtime/tests/job-isolation/acceptance.test.js',
    'docs/acceptance/phase-9b.md',
    'runtime/job-isolation/job-contract.js',
    'runtime/job-isolation/namespace-derivation.js',
    'runtime/job-isolation/namespace-isolation.js',
    'runtime/job-isolation/knowledge-scope.js',
    'runtime/job-isolation/parallel-lane.js',
    'runtime/job-isolation/coordinator.js',
    'governance/policies/job-isolation.json',
    'governance/contracts/job-isolation-v1.md',
  ];
  const prohibited = [/BEGIN (RSA|OPENSSH|EC) PRIVATE KEY/].concat(machinePathScanPatterns());
  for (const rel of scanTargets) {
    const source = read(rel);
    for (const pattern of prohibited) {
      assert.ok(!pattern.test(source), `${rel} must not contain prohibited tracked content`);
    }
  }
  // fixtures are reusable deterministic infrastructure data only
  const fixtures = JSON.stringify({ contract: CONTRACT_A, lane: laneInput(), laneB: laneInputB() });
  assert.ok(!/secret|password|credential|token/i.test(fixtures), 'fixtures must contain no secret-like material');
});

console.log('');
console.log(`Cases: ${passed + failed}`);
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);

process.exit(failed > 0 ? 1 : 0);
