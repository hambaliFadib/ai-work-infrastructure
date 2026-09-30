/**
 * Job Isolation v1 — Namespace Isolation Enforcement tests (NIS01-NIS30).
 *
 * Validates runtime/job-isolation/namespace-isolation.js against the locked
 * governance artifacts:
 *   - governance/contracts/job-isolation-v1.md (sections 10-14, 22)
 *   - governance/policies/job-isolation.json (job-isolation@1.0.0)
 *
 * Session resource scopes are pinned explicitly: JOB_SCOPED (shared inside
 * the owning job's session namespace) and SESSION_LOCAL (owner-session
 * restricted); foreign-job rejection always outranks session equality.
 *
 * Scope boundary: namespace access enforcement only. No JobContract behavior
 * changes, no namespace derivation changes, no parallel lanes (#40), no
 * coordinator (#41), no acceptance suite (#42), no Phase 9C recovery
 * semantics, no Context Hydration coupling.
 *
 * Deterministic Node only. No wall clock. No randomness. No network.
 * No filesystem/runtime state (static repository source reads only, for the
 * canonical error-surface guard). No env. No profile reads.
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const {
  JobIsolationError,
  POLICY,
} = require('../../job-isolation/namespace-derivation.js');
const { createJobContract } = require('../../job-isolation/job-contract.js');
const ns = require('../../job-isolation/namespace-isolation.js');

const {
  ACCESS_OPERATIONS,
  CLEANUP_OPERATION,
  SESSION_RESOURCE_SCOPES,
  evaluateSessionAccess,
  evaluateEvidenceAccess,
  evaluateLedgerAccess,
  evaluateRuntimeStateAccess,
  evaluateRuntimeStateCleanup,
} = ns;

const NS_SOURCE = fs.readFileSync(path.join(__dirname, '..', '..', 'job-isolation', 'namespace-isolation.js'), 'utf8');

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

function makeContract(jobId, knowledgeScope) {
  return createJobContract({
    job_id: jobId,
    profile: 'default',
    knowledge_scope: knowledgeScope || ['JOB_LOCAL'],
    execution_permissions: ['READ_ONLY'],
  }, new Map());
}

const A = makeContract('nis.job-a');
const B = makeContract('nis.job-b');

const A_NS = Object.freeze({
  session: 'job:nis.job-a:sessions',
  evidence: 'job:nis.job-a:evidence',
  ledger: 'job:nis.job-a:ledger',
  runtime: 'job:nis.job-a:runtime-state',
});
const B_NS = Object.freeze({
  session: 'job:nis.job-b:sessions',
  evidence: 'job:nis.job-b:evidence',
  ledger: 'job:nis.job-b:ledger',
  runtime: 'job:nis.job-b:runtime-state',
});

function sessionRequest(overrides) {
  return Object.assign({
    operation: 'READ',
    resource_job_id: 'nis.job-a',
    resource_namespace: A_NS.session,
    resource_scope: 'SESSION_LOCAL',
    requester_session_id: 'session-one',
    owner_session_id: 'session-one',
  }, overrides);
}

function resourceRequest(overrides) {
  return Object.assign({
    operation: 'READ',
    resource_job_id: 'nis.job-a',
    resource_namespace: A_NS.evidence,
  }, overrides);
}

class CustomPrototypeRequest {
  constructor() {
    this.operation = 'READ';
    this.resource_job_id = 'nis.job-a';
    this.resource_namespace = A_NS.session;
    this.resource_scope = 'SESSION_LOCAL';
    this.requester_session_id = 'session-one';
    this.owner_session_id = 'session-one';
  }
}

// NIS01 — active JobContract validation: canonical contract accepted by every
// boundary; existing-authority rejection propagates unchanged; contract
// validation precedes descriptor validation.
test('NIS01', () => {
  assert.deepStrictEqual(
    evaluateSessionAccess(A, sessionRequest({})),
    { allowed: true, same_job: true, same_session: true, resource_scope: 'SESSION_LOCAL' }
  );
  assert.deepStrictEqual(
    evaluateEvidenceAccess(A, resourceRequest({ resource_namespace: A_NS.evidence })),
    { allowed: true, same_job: true, operation: 'READ' }
  );
  assert.deepStrictEqual(
    evaluateLedgerAccess(A, resourceRequest({ resource_namespace: A_NS.ledger })),
    { allowed: true, same_job: true, operation: 'READ' }
  );
  assert.deepStrictEqual(
    evaluateRuntimeStateAccess(A, resourceRequest({ resource_namespace: A_NS.runtime })),
    { allowed: true, same_job: true, operation: 'READ' }
  );
  assert.deepStrictEqual(
    evaluateRuntimeStateCleanup(A, resourceRequest({ operation: CLEANUP_OPERATION, resource_namespace: A_NS.runtime })),
    { allowed: true, same_job: true, operation: 'CLEANUP' }
  );

  // unknown JobContract field -> JOB_CONTRACT_INVALID (propagated unchanged)
  const unknownField = Object.assign({}, A, { extra_field: 1 });
  expectCode(() => evaluateSessionAccess(unknownField, sessionRequest({})), 'JOB_CONTRACT_INVALID');

  // tampered derived namespace -> NAMESPACE_OVERRIDE_FORBIDDEN
  const tampered = Object.assign({}, A, { session_namespace: 'job:evil:sessions' });
  expectCode(() => evaluateEvidenceAccess(tampered, resourceRequest({})), 'NAMESPACE_OVERRIDE_FORBIDDEN');

  // noncanonical persisted job_id -> INVALID_JOB_ID
  const badJob = Object.assign({}, A, { job_id: 'NIS.JOB-A' });
  expectCode(() => evaluateLedgerAccess(badJob, resourceRequest({ resource_namespace: A_NS.ledger })), 'INVALID_JOB_ID');

  // contract failure precedence: an invalid contract fails before descriptor checks
  expectCode(() => evaluateSessionAccess(unknownField, null), 'JOB_CONTRACT_INVALID');
  expectCode(() => evaluateRuntimeStateCleanup(tampered, null), 'NAMESPACE_OVERRIDE_FORBIDDEN');
});

// NIS02 — plain-record request closure: non-record descriptors fail closed;
// null-prototype plain records are accepted.
test('NIS02', () => {
  const nonRecords = [null, undefined, 'session request', 42, true, [], new CustomPrototypeRequest(), () => {}];
  for (const value of nonRecords) {
    expectCode(() => evaluateSessionAccess(A, value), 'NAMESPACE_DERIVATION_FAILED');
  }
  expectCode(() => evaluateEvidenceAccess(A, 'not-a-record'), 'NAMESPACE_DERIVATION_FAILED');
  expectCode(() => evaluateRuntimeStateCleanup(A, []), 'NAMESPACE_DERIVATION_FAILED');

  // null-prototype plain record is a valid descriptor shape
  const nullProto = Object.create(null);
  nullProto.operation = 'READ';
  nullProto.resource_job_id = 'nis.job-a';
  nullProto.resource_namespace = A_NS.session;
  nullProto.resource_scope = 'SESSION_LOCAL';
  nullProto.requester_session_id = 'session-one';
  nullProto.owner_session_id = 'session-one';
  assert.deepStrictEqual(
    evaluateSessionAccess(A, nullProto),
    { allowed: true, same_job: true, same_session: true, resource_scope: 'SESSION_LOCAL' }
  );
});

// NIS03 — hidden/unknown field rejection: extra enumerable fields, extra
// non-enumerable fields, and missing fields (including a missing
// resource_scope) all fail closed; known fields are read as data properties
// regardless of enumerability.
test('NIS03', () => {
  // extra enumerable key
  expectCode(() => evaluateSessionAccess(A, sessionRequest({ extra: 1 })), 'NAMESPACE_DERIVATION_FAILED');
  // extra non-enumerable key (hidden)
  const hidden = sessionRequest({});
  Object.defineProperty(hidden, 'hidden', { value: 'x', enumerable: false });
  expectCode(() => evaluateSessionAccess(A, hidden), 'NAMESPACE_DERIVATION_FAILED');
  // missing key
  const missing = sessionRequest({});
  delete missing.owner_session_id;
  expectCode(() => evaluateSessionAccess(A, missing), 'NAMESPACE_DERIVATION_FAILED');
  // missing resource_scope
  const missingScope = sessionRequest({});
  delete missingScope.resource_scope;
  expectCode(() => evaluateSessionAccess(A, missingScope), 'NAMESPACE_DERIVATION_FAILED');
  // resource boundary: extra key
  expectCode(() => evaluateEvidenceAccess(A, resourceRequest({ extra: 1 })), 'NAMESPACE_DERIVATION_FAILED');

  // known field supplied as a non-enumerable data property is still read as data
  const nonEnumKnown = {
    operation: 'READ',
    resource_job_id: 'nis.job-a',
    resource_namespace: A_NS.session,
    resource_scope: 'SESSION_LOCAL',
    requester_session_id: 'session-one',
  };
  Object.defineProperty(nonEnumKnown, 'owner_session_id', { value: 'session-one', enumerable: false });
  assert.deepStrictEqual(
    evaluateSessionAccess(A, nonEnumKnown),
    { allowed: true, same_job: true, same_session: true, resource_scope: 'SESSION_LOCAL' }
  );
});

// NIS04 — symbol key rejection: enumerable and non-enumerable symbol own keys
// fail closed.
test('NIS04', () => {
  const enumerableSymbol = sessionRequest({});
  enumerableSymbol[Symbol('meta')] = 'x';
  expectCode(() => evaluateSessionAccess(A, enumerableSymbol), 'NAMESPACE_DERIVATION_FAILED');

  const hiddenSymbol = sessionRequest({});
  Object.defineProperty(hiddenSymbol, Symbol('hidden'), { value: 'x', enumerable: false });
  expectCode(() => evaluateSessionAccess(A, hiddenSymbol), 'NAMESPACE_DERIVATION_FAILED');

  const resourceSymbol = resourceRequest({});
  resourceSymbol[Symbol('x')] = 1;
  expectCode(() => evaluateLedgerAccess(A, resourceSymbol), 'NAMESPACE_DERIVATION_FAILED');
  expectCode(() => evaluateRuntimeStateAccess(A, resourceSymbol), 'NAMESPACE_DERIVATION_FAILED');
});

// NIS05 — custom prototype rejection: inherited-prototype records and class
// instances fail closed.
test('NIS05', () => {
  const inheritedProto = Object.create({ operation: 'READ' });
  inheritedProto.operation = 'READ';
  inheritedProto.resource_job_id = 'nis.job-a';
  inheritedProto.resource_namespace = A_NS.session;
  inheritedProto.resource_scope = 'SESSION_LOCAL';
  inheritedProto.requester_session_id = 'session-one';
  inheritedProto.owner_session_id = 'session-one';
  expectCode(() => evaluateSessionAccess(A, inheritedProto), 'NAMESPACE_DERIVATION_FAILED');

  expectCode(() => evaluateSessionAccess(A, new CustomPrototypeRequest()), 'NAMESPACE_DERIVATION_FAILED');
  expectCode(() => evaluateEvidenceAccess(A, new CustomPrototypeRequest()), 'NAMESPACE_DERIVATION_FAILED');
});

// NIS06 — accessor-backed fields are rejected and getter/setter functions are
// never invoked during validation (invocation count = 0).
test('NIS06', () => {
  let getterCalls = 0;
  const accessorRequest = {
    operation: 'READ',
    resource_job_id: 'nis.job-a',
    resource_namespace: A_NS.session,
    resource_scope: 'SESSION_LOCAL',
    requester_session_id: 'session-one',
  };
  Object.defineProperty(accessorRequest, 'owner_session_id', {
    get() { getterCalls += 1; return 'session-one'; },
    enumerable: true,
    configurable: true,
  });
  expectCode(() => evaluateSessionAccess(A, accessorRequest), 'NAMESPACE_DERIVATION_FAILED');
  assert.strictEqual(getterCalls, 0, 'accessor getter must never be invoked');

  // every field accessor-backed: still zero invocations
  const allAccessors = {};
  const values = {
    operation: 'READ',
    resource_job_id: 'nis.job-a',
    resource_namespace: A_NS.session,
    resource_scope: 'SESSION_LOCAL',
    requester_session_id: 'session-one',
    owner_session_id: 'session-one',
  };
  for (const [field, value] of Object.entries(values)) {
    Object.defineProperty(allAccessors, field, {
      get() { getterCalls += 1; return value; },
      enumerable: true,
      configurable: true,
    });
  }
  expectCode(() => evaluateSessionAccess(A, allAccessors), 'NAMESPACE_DERIVATION_FAILED');
  assert.strictEqual(getterCalls, 0, 'no accessor may run during descriptor validation');

  // getter/setter pair: neither accessor may run
  let pairCalls = 0;
  const pairRequest = sessionRequest({});
  Object.defineProperty(pairRequest, 'operation', {
    get() { pairCalls += 1; return 'READ'; },
    set() { pairCalls += 1; },
    enumerable: true,
    configurable: true,
  });
  expectCode(() => evaluateSessionAccess(A, pairRequest), 'NAMESPACE_DERIVATION_FAILED');
  assert.strictEqual(pairCalls, 0, 'getter/setter pair must never be invoked');
});

// NIS07 — canonical resource job ID: a noncanonical or invalid resource owner
// propagates INVALID_JOB_ID and is never silently repaired.
test('NIS07', () => {
  const badIds = ['NIS.JOB-A', ' nis.job-a ', 'nis.job-a\t', '\uFF4E\uFF49\uFF53.job-a', 'bad/id', '', 42, null, undefined];
  for (const badId of badIds) {
    expectCode(() => evaluateSessionAccess(A, sessionRequest({ resource_job_id: badId })), 'INVALID_JOB_ID');
  }
  // canonical identity passes
  assert.strictEqual(evaluateSessionAccess(A, sessionRequest({ resource_job_id: 'nis.job-a' })).allowed, true);
  // no repair: uppercase owner is rejected, never evaluated as the canonical id
  expectCode(() => evaluateEvidenceAccess(A, resourceRequest({ resource_job_id: 'NIS.JOB-A' })), 'INVALID_JOB_ID');
  expectCode(() => evaluateLedgerAccess(A, resourceRequest({ resource_job_id: 'NIS.JOB-A', resource_namespace: A_NS.ledger })), 'INVALID_JOB_ID');
  expectCode(() => evaluateRuntimeStateAccess(A, resourceRequest({ resource_job_id: 'NIS.JOB-A', resource_namespace: A_NS.runtime })), 'INVALID_JOB_ID');
  expectCode(() => evaluateRuntimeStateCleanup(A, resourceRequest({ operation: CLEANUP_OPERATION, resource_job_id: 'NIS.JOB-A', resource_namespace: A_NS.runtime })), 'INVALID_JOB_ID');
});

// NIS08 — session structural mapping: unknown/missing resource scope fails
// closed with NAMESPACE_DERIVATION_FAILED; same-job namespace mismatch ->
// NAMESPACE_COLLISION (never NAMESPACE_OVERRIDE_FORBIDDEN);
// missing/empty/non-string namespace identity fails closed.
test('NIS08', () => {
  // unknown / non-canonical resource scope values
  for (const badScope of ['GLOBAL', 'job_scoped', 'session_local', 'JOB_SCOPED ', ' JOB_SCOPED', '', 42, null, true]) {
    expectCode(() => evaluateSessionAccess(A, sessionRequest({ resource_scope: badScope })), 'NAMESPACE_DERIVATION_FAILED');
  }
  // missing resource_scope (own-key closure)
  const missingScope = sessionRequest({});
  delete missingScope.resource_scope;
  expectCode(() => evaluateSessionAccess(A, missingScope), 'NAMESPACE_DERIVATION_FAILED');
  // scope enum is exactly the locked two
  assert.deepStrictEqual(SESSION_RESOURCE_SCOPES, ['JOB_SCOPED', 'SESSION_LOCAL']);

  // same-job namespace mismatch -> NAMESPACE_COLLISION for both resource scopes
  expectCode(() => evaluateSessionAccess(A, sessionRequest({ resource_namespace: B_NS.session })), 'NAMESPACE_COLLISION');
  expectCode(() => evaluateSessionAccess(A, sessionRequest({ resource_scope: 'JOB_SCOPED', resource_namespace: B_NS.session })), 'NAMESPACE_COLLISION');
  expectCode(() => evaluateSessionAccess(A, sessionRequest({ resource_namespace: A_NS.evidence })), 'NAMESPACE_COLLISION');
  expectCode(() => evaluateEvidenceAccess(A, resourceRequest({ resource_namespace: A_NS.session })), 'NAMESPACE_COLLISION');
  expectCode(() => evaluateLedgerAccess(A, resourceRequest({ operation: 'WRITE', resource_namespace: B_NS.ledger })), 'NAMESPACE_COLLISION');
  expectCode(() => evaluateRuntimeStateAccess(A, resourceRequest({ resource_namespace: A_NS.ledger })), 'NAMESPACE_COLLISION');
  expectCode(() => evaluateRuntimeStateCleanup(A, resourceRequest({ operation: CLEANUP_OPERATION, resource_namespace: B_NS.runtime })), 'NAMESPACE_COLLISION');

  expectCode(() => evaluateSessionAccess(A, sessionRequest({ resource_namespace: null })), 'NAMESPACE_DERIVATION_FAILED');
  expectCode(() => evaluateSessionAccess(A, sessionRequest({ resource_namespace: '' })), 'NAMESPACE_DERIVATION_FAILED');
  expectCode(() => evaluateSessionAccess(A, sessionRequest({ resource_namespace: 42 })), 'NAMESPACE_DERIVATION_FAILED');

  let observed = null;
  try {
    evaluateSessionAccess(A, sessionRequest({ resource_namespace: B_NS.session }));
  } catch (e) {
    observed = e.code;
  }
  assert.notStrictEqual(observed, 'NAMESPACE_OVERRIDE_FORBIDDEN', 'resource access must not use NAMESPACE_OVERRIDE_FORBIDDEN');
});

// NIS09 — JOB_SCOPED: same job + same session READ and WRITE are allowed.
test('NIS09', () => {
  const read = evaluateSessionAccess(A, sessionRequest({ resource_scope: 'JOB_SCOPED', operation: 'READ' }));
  assert.deepStrictEqual(read, { allowed: true, same_job: true, same_session: true, resource_scope: 'JOB_SCOPED' });
  assert.ok(Object.isFrozen(read));
  const write = evaluateSessionAccess(A, sessionRequest({ resource_scope: 'JOB_SCOPED', operation: 'WRITE' }));
  assert.deepStrictEqual(write, { allowed: true, same_job: true, same_session: true, resource_scope: 'JOB_SCOPED' });
  assert.ok(Object.isFrozen(write));
});

// NIS10 — JOB_SCOPED: same job + different session READ and WRITE are allowed
// (job-scoped state is shared inside the owning job; session equality does
// not restrict it).
test('NIS10', () => {
  const read = evaluateSessionAccess(A, sessionRequest({ resource_scope: 'JOB_SCOPED', operation: 'READ', owner_session_id: 'session-two' }));
  assert.deepStrictEqual(read, { allowed: true, same_job: true, same_session: false, resource_scope: 'JOB_SCOPED' });
  assert.ok(Object.isFrozen(read));
  const write = evaluateSessionAccess(A, sessionRequest({ resource_scope: 'JOB_SCOPED', operation: 'WRITE', owner_session_id: 'session-two' }));
  assert.deepStrictEqual(write, { allowed: true, same_job: true, same_session: false, resource_scope: 'JOB_SCOPED' });
  assert.ok(Object.isFrozen(write));
  assert.strictEqual(read.code, undefined, 'job-scoped allow exposes no domain .code');
});

// NIS11 — SESSION_LOCAL: same job + same session READ and WRITE are allowed.
test('NIS11', () => {
  const read = evaluateSessionAccess(A, sessionRequest({ operation: 'READ' }));
  assert.deepStrictEqual(read, { allowed: true, same_job: true, same_session: true, resource_scope: 'SESSION_LOCAL' });
  assert.ok(Object.isFrozen(read));
  const write = evaluateSessionAccess(A, sessionRequest({ operation: 'WRITE' }));
  assert.deepStrictEqual(write, { allowed: true, same_job: true, same_session: true, resource_scope: 'SESSION_LOCAL' });
  assert.ok(Object.isFrozen(write));
});

// NIS12 — SESSION_LOCAL: same job + different session READ and WRITE are
// denied (frozen eligibility decision, not a thrown canonical exception).
test('NIS12', () => {
  const read = evaluateSessionAccess(A, sessionRequest({ operation: 'READ', owner_session_id: 'session-two' }));
  assert.deepStrictEqual(read, { allowed: false, same_job: true, same_session: false, resource_scope: 'SESSION_LOCAL' });
  assert.ok(Object.isFrozen(read));
  assert.strictEqual(read.code, undefined, 'ordinary denial exposes no domain .code');
  const write = evaluateSessionAccess(A, sessionRequest({ operation: 'WRITE', owner_session_id: 'session-two' }));
  assert.deepStrictEqual(write, { allowed: false, same_job: true, same_session: false, resource_scope: 'SESSION_LOCAL' });
  assert.ok(Object.isFrozen(write));
});

// NIS13 — foreign job: same session + READ -> FOREIGN_JOB_REJECT for BOTH
// resource scopes (resource_scope never weakens job isolation).
test('NIS13', () => {
  for (const scope of ['JOB_SCOPED', 'SESSION_LOCAL']) {
    expectCode(() => evaluateSessionAccess(A, sessionRequest({
      operation: 'READ',
      resource_scope: scope,
      resource_job_id: 'nis.job-b',
      resource_namespace: B_NS.session,
      requester_session_id: 'session-one',
      owner_session_id: 'session-one',
    })), 'FOREIGN_JOB_REJECT');
  }
});

// NIS14 — foreign job: same session + WRITE -> FOREIGN_NAMESPACE_WRITE_REJECTED
// for BOTH resource scopes.
test('NIS14', () => {
  for (const scope of ['JOB_SCOPED', 'SESSION_LOCAL']) {
    expectCode(() => evaluateSessionAccess(A, sessionRequest({
      operation: 'WRITE',
      resource_scope: scope,
      resource_job_id: 'nis.job-b',
      resource_namespace: B_NS.session,
      requester_session_id: 'session-one',
      owner_session_id: 'session-one',
    })), 'FOREIGN_NAMESPACE_WRITE_REJECTED');
  }
});

// NIS15 — foreign job: different session + READ -> FOREIGN_JOB_REJECT for
// BOTH resource scopes.
test('NIS15', () => {
  for (const scope of ['JOB_SCOPED', 'SESSION_LOCAL']) {
    expectCode(() => evaluateSessionAccess(A, sessionRequest({
      operation: 'READ',
      resource_scope: scope,
      resource_job_id: 'nis.job-b',
      resource_namespace: B_NS.session,
      requester_session_id: 'session-one',
      owner_session_id: 'session-two',
    })), 'FOREIGN_JOB_REJECT');
  }
});

// NIS16 — foreign job: different session + WRITE -> FOREIGN_NAMESPACE_WRITE_REJECTED
// for BOTH resource scopes.
test('NIS16', () => {
  for (const scope of ['JOB_SCOPED', 'SESSION_LOCAL']) {
    expectCode(() => evaluateSessionAccess(A, sessionRequest({
      operation: 'WRITE',
      resource_scope: scope,
      resource_job_id: 'nis.job-b',
      resource_namespace: B_NS.session,
      requester_session_id: 'session-one',
      owner_session_id: 'session-two',
    })), 'FOREIGN_NAMESPACE_WRITE_REJECTED');
  }
});

// NIS17 — evidence: same-job READ and WRITE are allowed; decisions are frozen.
test('NIS17', () => {
  const read = evaluateEvidenceAccess(A, resourceRequest({ operation: 'READ', resource_namespace: A_NS.evidence }));
  assert.deepStrictEqual(read, { allowed: true, same_job: true, operation: 'READ' });
  assert.ok(Object.isFrozen(read));
  const write = evaluateEvidenceAccess(A, resourceRequest({ operation: 'WRITE', resource_namespace: A_NS.evidence }));
  assert.deepStrictEqual(write, { allowed: true, same_job: true, operation: 'WRITE' });
  assert.ok(Object.isFrozen(write));
});

// NIS18 — evidence: foreign READ/WRITE reject; foreign job_id wins even when
// the supplied namespace is the active job's namespace (Job A evidence can
// never satisfy Job B and vice versa).
test('NIS18', () => {
  expectCode(() => evaluateEvidenceAccess(A, resourceRequest({ operation: 'READ', resource_job_id: 'nis.job-b', resource_namespace: B_NS.evidence })), 'FOREIGN_JOB_REJECT');
  expectCode(() => evaluateEvidenceAccess(A, resourceRequest({ operation: 'WRITE', resource_job_id: 'nis.job-b', resource_namespace: B_NS.evidence })), 'FOREIGN_NAMESPACE_WRITE_REJECTED');
  expectCode(() => evaluateEvidenceAccess(A, resourceRequest({ operation: 'READ', resource_job_id: 'nis.job-b', resource_namespace: A_NS.evidence })), 'FOREIGN_JOB_REJECT');
  expectCode(() => evaluateEvidenceAccess(A, resourceRequest({ operation: 'WRITE', resource_job_id: 'nis.job-b', resource_namespace: A_NS.evidence })), 'FOREIGN_NAMESPACE_WRITE_REJECTED');
});

// NIS19 — evidence: same-job namespace mismatch -> NAMESPACE_COLLISION.
test('NIS19', () => {
  expectCode(() => evaluateEvidenceAccess(A, resourceRequest({ resource_namespace: B_NS.evidence })), 'NAMESPACE_COLLISION');
  expectCode(() => evaluateEvidenceAccess(A, resourceRequest({ resource_namespace: A_NS.ledger })), 'NAMESPACE_COLLISION');
  expectCode(() => evaluateEvidenceAccess(A, resourceRequest({ resource_namespace: A_NS.runtime })), 'NAMESPACE_COLLISION');
});

// NIS20 — ledger: same-job READ and WRITE are allowed; decisions are frozen.
test('NIS20', () => {
  const read = evaluateLedgerAccess(A, resourceRequest({ operation: 'READ', resource_namespace: A_NS.ledger }));
  assert.deepStrictEqual(read, { allowed: true, same_job: true, operation: 'READ' });
  assert.ok(Object.isFrozen(read));
  const write = evaluateLedgerAccess(A, resourceRequest({ operation: 'WRITE', resource_namespace: A_NS.ledger }));
  assert.deepStrictEqual(write, { allowed: true, same_job: true, operation: 'WRITE' });
  assert.ok(Object.isFrozen(write));
});

// NIS21 — ledger: foreign READ/WRITE reject; no shared mutable ledger state.
test('NIS21', () => {
  expectCode(() => evaluateLedgerAccess(A, resourceRequest({ operation: 'READ', resource_job_id: 'nis.job-b', resource_namespace: B_NS.ledger })), 'FOREIGN_JOB_REJECT');
  expectCode(() => evaluateLedgerAccess(A, resourceRequest({ operation: 'WRITE', resource_job_id: 'nis.job-b', resource_namespace: B_NS.ledger })), 'FOREIGN_NAMESPACE_WRITE_REJECTED');
  expectCode(() => evaluateLedgerAccess(A, resourceRequest({ operation: 'READ', resource_job_id: 'nis.job-b', resource_namespace: A_NS.ledger })), 'FOREIGN_JOB_REJECT');
});

// NIS22 — ledger: same-job namespace mismatch -> NAMESPACE_COLLISION.
test('NIS22', () => {
  expectCode(() => evaluateLedgerAccess(A, resourceRequest({ resource_namespace: B_NS.ledger })), 'NAMESPACE_COLLISION');
  expectCode(() => evaluateLedgerAccess(A, resourceRequest({ resource_namespace: A_NS.session })), 'NAMESPACE_COLLISION');
});

// NIS23 — runtime state: same-job READ and WRITE allowed (access boundary).
test('NIS23', () => {
  const read = evaluateRuntimeStateAccess(A, resourceRequest({ operation: 'READ', resource_namespace: A_NS.runtime }));
  assert.deepStrictEqual(read, { allowed: true, same_job: true, operation: 'READ' });
  assert.ok(Object.isFrozen(read));
  const write = evaluateRuntimeStateAccess(A, resourceRequest({ operation: 'WRITE', resource_namespace: A_NS.runtime }));
  assert.deepStrictEqual(write, { allowed: true, same_job: true, operation: 'WRITE' });
  assert.ok(Object.isFrozen(write));
});

// NIS24 — runtime state: same-job CLEANUP allowed (separate operation boundary).
test('NIS24', () => {
  const decision = evaluateRuntimeStateCleanup(A, resourceRequest({ operation: CLEANUP_OPERATION, resource_namespace: A_NS.runtime }));
  assert.deepStrictEqual(decision, { allowed: true, same_job: true, operation: 'CLEANUP' });
  assert.ok(Object.isFrozen(decision));
});

// NIS25 — runtime state: foreign READ and WRITE both reject with the machine
// policy error FOREIGN_NAMESPACE_WRITE_REJECTED (foreign read included, by
// job-isolation@1.0.0 runtime_state_isolation.foreign_read_write_error).
test('NIS25', () => {
  expectCode(() => evaluateRuntimeStateAccess(A, resourceRequest({ operation: 'READ', resource_job_id: 'nis.job-b', resource_namespace: B_NS.runtime })), 'FOREIGN_NAMESPACE_WRITE_REJECTED');
  expectCode(() => evaluateRuntimeStateAccess(A, resourceRequest({ operation: 'WRITE', resource_job_id: 'nis.job-b', resource_namespace: B_NS.runtime })), 'FOREIGN_NAMESPACE_WRITE_REJECTED');
  expectCode(() => evaluateRuntimeStateAccess(A, resourceRequest({ operation: 'READ', resource_job_id: 'nis.job-b', resource_namespace: A_NS.runtime })), 'FOREIGN_NAMESPACE_WRITE_REJECTED');
});

// NIS26 — runtime state: foreign CLEANUP rejects; cleanup ownership is the
// owning canonical job only; no implicit cross-job coordination.
test('NIS26', () => {
  expectCode(() => evaluateRuntimeStateCleanup(A, resourceRequest({ operation: CLEANUP_OPERATION, resource_job_id: 'nis.job-b', resource_namespace: B_NS.runtime })), 'FOREIGN_NAMESPACE_WRITE_REJECTED');
  expectCode(() => evaluateRuntimeStateCleanup(A, resourceRequest({ operation: CLEANUP_OPERATION, resource_job_id: 'nis.job-b', resource_namespace: A_NS.runtime })), 'FOREIGN_NAMESPACE_WRITE_REJECTED');
});

// NIS27 — runtime state: same-job namespace mismatch -> NAMESPACE_COLLISION;
// operation boundaries are strict (CLEANUP is not a READ/WRITE access and
// READ/WRITE are not CLEANUP); unknown operations fail closed.
test('NIS27', () => {
  expectCode(() => evaluateRuntimeStateAccess(A, resourceRequest({ operation: 'READ', resource_namespace: B_NS.runtime })), 'NAMESPACE_COLLISION');
  expectCode(() => evaluateRuntimeStateCleanup(A, resourceRequest({ operation: CLEANUP_OPERATION, resource_namespace: B_NS.runtime })), 'NAMESPACE_COLLISION');

  expectCode(() => evaluateRuntimeStateAccess(A, resourceRequest({ operation: 'CLEANUP', resource_namespace: A_NS.runtime })), 'NAMESPACE_DERIVATION_FAILED');
  expectCode(() => evaluateRuntimeStateCleanup(A, resourceRequest({ operation: 'READ', resource_namespace: A_NS.runtime })), 'NAMESPACE_DERIVATION_FAILED');
  expectCode(() => evaluateRuntimeStateCleanup(A, resourceRequest({ operation: 'WRITE', resource_namespace: A_NS.runtime })), 'NAMESPACE_DERIVATION_FAILED');

  expectCode(() => evaluateRuntimeStateAccess(A, resourceRequest({ operation: 'DELETE', resource_namespace: A_NS.runtime })), 'NAMESPACE_DERIVATION_FAILED');
  expectCode(() => evaluateSessionAccess(A, sessionRequest({ operation: 'EXECUTE' })), 'NAMESPACE_DERIVATION_FAILED');
  expectCode(() => evaluateEvidenceAccess(A, resourceRequest({ operation: 42 })), 'NAMESPACE_DERIVATION_FAILED');
  assert.deepStrictEqual(ACCESS_OPERATIONS, ['READ', 'WRITE']);
  assert.strictEqual(CLEANUP_OPERATION, 'CLEANUP');
});

// NIS28 — caller-mutation isolation: decisions are frozen fresh objects;
// inputs are never mutated; caller mutation after a decision cannot mutate
// returned/canonical state.
test('NIS28', () => {
  const request = sessionRequest({});
  const before = JSON.stringify(request);
  const decision = evaluateSessionAccess(A, request);
  assert.strictEqual(JSON.stringify(request), before, 'evaluation must not mutate the input descriptor');

  assert.ok(Object.isFrozen(decision));
  assert.notStrictEqual(decision, request);
  assert.notStrictEqual(decision, A);
  try { decision.allowed = false; } catch (e) { /* frozen */ }
  try { decision.same_job = false; } catch (e) { /* frozen */ }
  assert.deepStrictEqual(decision, { allowed: true, same_job: true, same_session: true, resource_scope: 'SESSION_LOCAL' });

  request.operation = 'WRITE';
  request.resource_namespace = 'job:evil:sessions';
  request.resource_scope = 'JOB_SCOPED';
  assert.deepStrictEqual(decision, { allowed: true, same_job: true, same_session: true, resource_scope: 'SESSION_LOCAL' }, 'caller mutation must not alter a returned decision');

  // mutable contract clone: later caller mutation cannot alter the canonical decision
  const mutableContract = Object.assign({}, A);
  const decision2 = evaluateSessionAccess(mutableContract, sessionRequest({}));
  mutableContract.session_namespace = 'job:evil:sessions';
  mutableContract.job_id = 'evil.job';
  assert.deepStrictEqual(decision2, { allowed: true, same_job: true, same_session: true, resource_scope: 'SESSION_LOCAL' });
  assert.ok(Object.isFrozen(decision2));

  // deny decisions are frozen too
  const deny = evaluateSessionAccess(A, sessionRequest({ owner_session_id: 'session-two' }));
  assert.ok(Object.isFrozen(deny));
  try { deny.allowed = true; } catch (e) { /* frozen */ }
  assert.strictEqual(deny.allowed, false);
});

// NIS29 — 100x determinism: identical inputs produce identical decisions and
// identical canonical error outcomes.
test('NIS29', () => {
  const cases = [
    () => evaluateSessionAccess(A, sessionRequest({ operation: 'READ' })),
    () => evaluateSessionAccess(A, sessionRequest({ resource_scope: 'JOB_SCOPED', operation: 'READ', owner_session_id: 'session-two' })),
    () => evaluateSessionAccess(A, sessionRequest({ operation: 'WRITE', owner_session_id: 'session-two' })),
    () => evaluateEvidenceAccess(A, resourceRequest({ operation: 'WRITE', resource_namespace: A_NS.evidence })),
    () => evaluateLedgerAccess(A, resourceRequest({ operation: 'READ', resource_namespace: A_NS.ledger })),
    () => evaluateRuntimeStateAccess(A, resourceRequest({ operation: 'READ', resource_namespace: A_NS.runtime })),
    () => evaluateRuntimeStateCleanup(A, resourceRequest({ operation: CLEANUP_OPERATION, resource_namespace: A_NS.runtime })),
  ];
  const first = cases.map((fn) => JSON.stringify(fn()));
  for (let i = 0; i < 100; i += 1) {
    cases.forEach((fn, idx) => {
      assert.strictEqual(JSON.stringify(fn()), first[idx], `case ${idx} must be deterministic`);
    });
  }
  for (let i = 0; i < 100; i += 1) {
    expectCode(() => evaluateEvidenceAccess(A, resourceRequest({ operation: 'READ', resource_job_id: 'nis.job-b', resource_namespace: B_NS.evidence })), 'FOREIGN_JOB_REJECT');
  }
});

// NIS30 — canonical error-surface guard: every error-like identifier in the
// module is one of the locked 18; non-canonical codes are rejected at
// construction; SESSION_MISMATCH is not a domain error.
test('NIS30', () => {
  const locked = POLICY.canonical_errors;
  assert.strictEqual(locked.length, 18);

  const observed = new Set();
  const battery = [
    () => evaluateSessionAccess(A, null),
    () => evaluateSessionAccess(A, sessionRequest({ resource_job_id: 'NIS.JOB-A' })),
    () => evaluateSessionAccess(A, sessionRequest({ resource_scope: 'GLOBAL' })),
    () => evaluateSessionAccess(A, sessionRequest({ resource_job_id: 'nis.job-b', resource_namespace: B_NS.session })),
    () => evaluateSessionAccess(A, sessionRequest({ resource_namespace: B_NS.session })),
    () => evaluateSessionAccess(A, Object.assign({}, A, { session_namespace: 'job:evil:sessions' })),
  ];
  for (const fn of battery) {
    let thrown = null;
    try { fn(); } catch (e) { thrown = e; }
    assert.ok(thrown, 'battery case must fail closed');
    assert.ok(thrown instanceof JobIsolationError);
    observed.add(thrown.code);
  }
  for (const code of observed) {
    assert.ok(locked.includes(code), `${code} must be one of the locked canonical identifiers`);
  }

  let rejected = false;
  try { new JobIsolationError('SESSION_MISMATCH', 'x'); } catch (e) { rejected = true; }
  assert.strictEqual(rejected, true, 'non-canonical codes must be rejected at construction');
  assert.ok(!NS_SOURCE.includes('SESSION_MISMATCH'), 'SESSION_MISMATCH must not exist as a domain error');

  // every error-like quoted constant in the module source is within the locked 18
  const quoted = NS_SOURCE.match(/'[A-Z][A-Z0-9_]+'/g) || [];
  const errorLike = quoted
    .map((q) => q.slice(1, -1))
    .filter((code) => /(REJECT|FORBIDDEN|FAILED|INVALID|COLLISION|MISMATCH|CONFLICT|VIOLATION)/.test(code));
  assert.ok(errorLike.length > 0, 'error-surface scan must find the module error identifiers');
  for (const code of errorLike) {
    assert.ok(locked.includes(code), `${code} must be one of the locked canonical identifiers`);
  }
});

console.log('');
console.log(`Cases: ${passed + failed}`);
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);

process.exit(failed > 0 ? 1 : 0);
