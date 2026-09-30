/**
 * Job Isolation v1 — Knowledge-Scope Read Eligibility tests (KSC01-KSC18).
 *
 * Validates runtime/job-isolation/knowledge-scope.js against the locked
 * governance artifacts:
 *   - governance/contracts/job-isolation-v1.md (section 11)
 *   - governance/policies/job-isolation.json (job-isolation@1.0.0)
 *
 * Scope boundary: knowledge read eligibility only. No knowledge-write API,
 * no Context Hydration score/ranking/weight/budget input (policy
 * context-hydration@1.0.1 remains frozen), no JobContract behavior changes,
 * no parallel lanes (#40), no coordinator (#41), no acceptance suite (#42),
 * no Phase 9C recovery semantics.
 *
 * Deterministic Node only. No wall clock. No randomness. No network.
 * No filesystem/runtime state (static repository source reads only, for the
 * API/error-surface guard). No env. No profile reads.
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const {
  JobIsolationError,
  POLICY,
} = require('../../job-isolation/namespace-derivation.js');
const { createJobContract } = require('../../job-isolation/job-contract.js');
const ks = require('../../job-isolation/knowledge-scope.js');

const {
  KNOWLEDGE_SOURCE_SCOPES,
  evaluateKnowledgeReadEligibility,
} = ks;

const KS_SOURCE = fs.readFileSync(path.join(__dirname, '..', '..', 'job-isolation', 'knowledge-scope.js'), 'utf8');

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
    knowledge_scope: knowledgeScope,
    execution_permissions: ['READ_ONLY'],
  }, new Map());
}

const A_BASE = makeContract('ksc.job-a', ['JOB_LOCAL']);
const A_SESSION = makeContract('ksc.job-a', ['JOB_LOCAL', 'SESSION_LOCAL']);
const A_FULL = makeContract('ksc.job-a', ['JOB_LOCAL', 'SESSION_LOCAL', 'GLOBAL']);
const B = makeContract('ksc.job-b', ['JOB_LOCAL']);

const A_KNOWLEDGE = 'job:ksc.job-a:knowledge';
const B_KNOWLEDGE = 'job:ksc.job-b:knowledge';

function knowledgeRequest(overrides) {
  return Object.assign({
    requester_session_id: 'session-one',
    source_scope: 'JOB_LOCAL',
    source_job_id: 'ksc.job-a',
    source_session_id: null,
    source_namespace: A_KNOWLEDGE,
  }, overrides);
}

class CustomPrototypeKnowledgeRequest {
  constructor() {
    this.requester_session_id = 'session-one';
    this.source_scope = 'JOB_LOCAL';
    this.source_job_id = 'ksc.job-a';
    this.source_session_id = null;
    this.source_namespace = A_KNOWLEDGE;
  }
}

// KSC01 — active JobContract validation: canonical contract accepted; existing
// authority rejections propagate unchanged; contract validation precedes
// descriptor validation.
test('KSC01', () => {
  assert.deepStrictEqual(
    evaluateKnowledgeReadEligibility(A_FULL, knowledgeRequest({})),
    { eligible: true, scope: 'JOB_LOCAL' }
  );

  const unknownField = Object.assign({}, A_FULL, { extra: 1 });
  expectCode(() => evaluateKnowledgeReadEligibility(unknownField, knowledgeRequest({})), 'JOB_CONTRACT_INVALID');

  const tampered = Object.assign({}, A_FULL, { evidence_namespace: 'job:evil:evidence' });
  expectCode(() => evaluateKnowledgeReadEligibility(tampered, knowledgeRequest({})), 'NAMESPACE_OVERRIDE_FORBIDDEN');

  const badJob = Object.assign({}, A_FULL, { job_id: 'KSC.JOB-A' });
  expectCode(() => evaluateKnowledgeReadEligibility(badJob, knowledgeRequest({})), 'INVALID_JOB_ID');

  // contract failure precedence
  expectCode(() => evaluateKnowledgeReadEligibility(unknownField, null), 'JOB_CONTRACT_INVALID');
});

// KSC02 — strict request record closure: non-records, unknown keys, hidden
// keys, symbol keys, missing keys, accessor-backed fields, and custom
// prototypes all fail closed; getters are never invoked.
test('KSC02', () => {
  const nonRecords = [null, undefined, 'request', 42, [], new CustomPrototypeKnowledgeRequest(), () => {}];
  for (const value of nonRecords) {
    expectCode(() => evaluateKnowledgeReadEligibility(A_FULL, value), 'NAMESPACE_DERIVATION_FAILED');
  }

  expectCode(() => evaluateKnowledgeReadEligibility(A_FULL, knowledgeRequest({ extra: 1 })), 'NAMESPACE_DERIVATION_FAILED');

  const hidden = knowledgeRequest({});
  Object.defineProperty(hidden, 'hidden', { value: 'x', enumerable: false });
  expectCode(() => evaluateKnowledgeReadEligibility(A_FULL, hidden), 'NAMESPACE_DERIVATION_FAILED');

  const symbolKeyed = knowledgeRequest({});
  symbolKeyed[Symbol('meta')] = 'x';
  expectCode(() => evaluateKnowledgeReadEligibility(A_FULL, symbolKeyed), 'NAMESPACE_DERIVATION_FAILED');

  const missing = knowledgeRequest({});
  delete missing.source_namespace;
  expectCode(() => evaluateKnowledgeReadEligibility(A_FULL, missing), 'NAMESPACE_DERIVATION_FAILED');

  let getterCalls = 0;
  const accessor = {
    requester_session_id: 'session-one',
    source_scope: 'JOB_LOCAL',
    source_job_id: 'ksc.job-a',
    source_namespace: A_KNOWLEDGE,
  };
  Object.defineProperty(accessor, 'source_session_id', {
    get() { getterCalls += 1; return null; },
    enumerable: true,
    configurable: true,
  });
  expectCode(() => evaluateKnowledgeReadEligibility(A_FULL, accessor), 'NAMESPACE_DERIVATION_FAILED');
  assert.strictEqual(getterCalls, 0, 'accessor getter must never be invoked');

  const customProto = Object.create({});
  Object.assign(customProto, knowledgeRequest({}));
  expectCode(() => evaluateKnowledgeReadEligibility(A_FULL, customProto), 'NAMESPACE_DERIVATION_FAILED');
});

// KSC03 — unknown source scope -> INVALID_KNOWLEDGE_SCOPE.
test('KSC03', () => {
  for (const badScope of ['global', 'local', 'GLOBAL ', '', 42, null, 'PUBLIC', 'JOB_LOCAL ']) {
    expectCode(
      () => evaluateKnowledgeReadEligibility(A_FULL, knowledgeRequest({ source_scope: badScope })),
      'INVALID_KNOWLEDGE_SCOPE'
    );
  }
  assert.deepStrictEqual(KNOWLEDGE_SOURCE_SCOPES, ['JOB_LOCAL', 'SESSION_LOCAL', 'GLOBAL']);
});

// KSC04 — JOB_LOCAL: same canonical job is eligible; session identity is
// irrelevant to JOB_LOCAL eligibility; decision is frozen.
test('KSC04', () => {
  const decision = evaluateKnowledgeReadEligibility(A_FULL, knowledgeRequest({}));
  assert.deepStrictEqual(decision, { eligible: true, scope: 'JOB_LOCAL' });
  assert.ok(Object.isFrozen(decision));

  // session identity does not affect JOB_LOCAL eligibility
  assert.strictEqual(
    evaluateKnowledgeReadEligibility(A_FULL, knowledgeRequest({ requester_session_id: 'session-x', source_session_id: null })).eligible,
    true
  );
  assert.strictEqual(
    evaluateKnowledgeReadEligibility(A_FULL, knowledgeRequest({ requester_session_id: 'session-y', source_session_id: 'session-z' })).eligible,
    true
  );
  // also eligible on a JOB_LOCAL-only contract
  assert.strictEqual(evaluateKnowledgeReadEligibility(A_BASE, knowledgeRequest({})).eligible, true);
});

// KSC05 — JOB_LOCAL: foreign source job -> FOREIGN_JOB_REJECT (foreign job_id
// is checked before any namespace comparison).
test('KSC05', () => {
  expectCode(
    () => evaluateKnowledgeReadEligibility(A_FULL, knowledgeRequest({ source_job_id: 'ksc.job-b', source_namespace: B_KNOWLEDGE })),
    'FOREIGN_JOB_REJECT'
  );
  expectCode(
    () => evaluateKnowledgeReadEligibility(A_FULL, knowledgeRequest({ source_job_id: 'ksc.job-b' })),
    'FOREIGN_JOB_REJECT'
  );
});

// KSC06 — JOB_LOCAL: namespace mismatch -> NAMESPACE_COLLISION; missing
// ownership/namespace and noncanonical source job ids fail closed with their
// pinned canonical errors.
test('KSC06', () => {
  expectCode(
    () => evaluateKnowledgeReadEligibility(A_FULL, knowledgeRequest({ source_namespace: B_KNOWLEDGE })),
    'NAMESPACE_COLLISION'
  );
  expectCode(
    () => evaluateKnowledgeReadEligibility(A_FULL, knowledgeRequest({ source_namespace: 'job:ksc.job-a:evidence' })),
    'NAMESPACE_COLLISION'
  );
  expectCode(
    () => evaluateKnowledgeReadEligibility(A_FULL, knowledgeRequest({ source_namespace: null })),
    'NAMESPACE_DERIVATION_FAILED'
  );
  expectCode(
    () => evaluateKnowledgeReadEligibility(A_FULL, knowledgeRequest({ source_job_id: null })),
    'NAMESPACE_DERIVATION_FAILED'
  );
  expectCode(
    () => evaluateKnowledgeReadEligibility(A_FULL, knowledgeRequest({ source_job_id: 'KSC.JOB-A' })),
    'INVALID_JOB_ID'
  );
});

// KSC07 — SESSION_LOCAL: capability absent from knowledge_scope -> eligible=false
// (frozen decision, no domain error).
test('KSC07', () => {
  const decision = evaluateKnowledgeReadEligibility(A_BASE, knowledgeRequest({ source_scope: 'SESSION_LOCAL', source_session_id: 'session-one' }));
  assert.deepStrictEqual(decision, { eligible: false, scope: 'SESSION_LOCAL' });
  assert.ok(Object.isFrozen(decision));
  assert.strictEqual(decision.code, undefined, 'ordinary ineligibility exposes no domain .code');
});

// KSC08 — SESSION_LOCAL: same job + same exact session -> eligible.
test('KSC08', () => {
  assert.deepStrictEqual(
    evaluateKnowledgeReadEligibility(A_SESSION, knowledgeRequest({ source_scope: 'SESSION_LOCAL', source_session_id: 'session-one' })),
    { eligible: true, scope: 'SESSION_LOCAL' }
  );
  assert.strictEqual(
    evaluateKnowledgeReadEligibility(A_FULL, knowledgeRequest({ source_scope: 'SESSION_LOCAL', source_session_id: 'session-one' })).eligible,
    true
  );
});

// KSC09 — SESSION_LOCAL: same job + different session -> eligible=false.
test('KSC09', () => {
  assert.deepStrictEqual(
    evaluateKnowledgeReadEligibility(A_SESSION, knowledgeRequest({ source_scope: 'SESSION_LOCAL', source_session_id: 'session-two' })),
    { eligible: false, scope: 'SESSION_LOCAL' }
  );
  // null source session is not the same session
  assert.strictEqual(
    evaluateKnowledgeReadEligibility(A_SESSION, knowledgeRequest({ source_scope: 'SESSION_LOCAL', source_session_id: null })).eligible,
    false
  );
});

// KSC10 — SESSION_LOCAL: same session + foreign job -> FOREIGN_JOB_REJECT;
// a session match never makes foreign content eligible.
test('KSC10', () => {
  expectCode(
    () => evaluateKnowledgeReadEligibility(A_FULL, knowledgeRequest({
      source_scope: 'SESSION_LOCAL',
      source_session_id: 'session-one',
      source_job_id: 'ksc.job-b',
      source_namespace: B_KNOWLEDGE,
    })),
    'FOREIGN_JOB_REJECT'
  );
});

// KSC11 — GLOBAL: capability absent -> eligible=false.
test('KSC11', () => {
  assert.deepStrictEqual(
    evaluateKnowledgeReadEligibility(A_SESSION, knowledgeRequest({ source_scope: 'GLOBAL', source_job_id: null, source_namespace: null })),
    { eligible: false, scope: 'GLOBAL' }
  );
  assert.deepStrictEqual(
    evaluateKnowledgeReadEligibility(A_BASE, knowledgeRequest({ source_scope: 'GLOBAL', source_job_id: null, source_namespace: null })),
    { eligible: false, scope: 'GLOBAL' }
  );
});

// KSC12 — GLOBAL: unowned explicit source (null job + null namespace) is
// eligible; an unowned source carrying a namespace identity is rejected.
test('KSC12', () => {
  const decision = evaluateKnowledgeReadEligibility(A_FULL, knowledgeRequest({
    source_scope: 'GLOBAL',
    source_job_id: null,
    source_session_id: null,
    source_namespace: null,
  }));
  assert.deepStrictEqual(decision, { eligible: true, scope: 'GLOBAL' });
  assert.ok(Object.isFrozen(decision));

  expectCode(
    () => evaluateKnowledgeReadEligibility(A_FULL, knowledgeRequest({
      source_scope: 'GLOBAL',
      source_job_id: null,
      source_namespace: A_KNOWLEDGE,
    })),
    'NAMESPACE_COLLISION'
  );
});

// KSC13 — GLOBAL: same-job explicit source (active job + active job knowledge
// namespace) is eligible; wrong namespace -> NAMESPACE_COLLISION; noncanonical
// source job -> INVALID_JOB_ID.
test('KSC13', () => {
  assert.deepStrictEqual(
    evaluateKnowledgeReadEligibility(A_FULL, knowledgeRequest({
      source_scope: 'GLOBAL',
      source_job_id: 'ksc.job-a',
      source_namespace: A_KNOWLEDGE,
    })),
    { eligible: true, scope: 'GLOBAL' }
  );

  expectCode(
    () => evaluateKnowledgeReadEligibility(A_FULL, knowledgeRequest({
      source_scope: 'GLOBAL',
      source_job_id: 'ksc.job-a',
      source_namespace: B_KNOWLEDGE,
    })),
    'NAMESPACE_COLLISION'
  );

  expectCode(
    () => evaluateKnowledgeReadEligibility(A_FULL, knowledgeRequest({
      source_scope: 'GLOBAL',
      source_job_id: 'KSC.JOB-A',
      source_namespace: A_KNOWLEDGE,
    })),
    'INVALID_JOB_ID'
  );
});

// KSC14 — GLOBAL: foreign-owned source -> FOREIGN_JOB_REJECT.
test('KSC14', () => {
  expectCode(
    () => evaluateKnowledgeReadEligibility(A_FULL, knowledgeRequest({
      source_scope: 'GLOBAL',
      source_job_id: 'ksc.job-b',
      source_namespace: B_KNOWLEDGE,
    })),
    'FOREIGN_JOB_REJECT'
  );
});

// KSC15 — a foreign JOB_LOCAL / SESSION_LOCAL source cannot be promoted merely
// because the active JobContract has GLOBAL.
test('KSC15', () => {
  // foreign job-local source presented as GLOBAL with its own namespace
  expectCode(
    () => evaluateKnowledgeReadEligibility(A_FULL, knowledgeRequest({
      source_scope: 'GLOBAL',
      source_job_id: 'ksc.job-b',
      source_namespace: B_KNOWLEDGE,
    })),
    'FOREIGN_JOB_REJECT'
  );
  // foreign source cannot ride the active job's namespace either
  expectCode(
    () => evaluateKnowledgeReadEligibility(A_FULL, knowledgeRequest({
      source_scope: 'GLOBAL',
      source_job_id: 'ksc.job-b',
      source_namespace: A_KNOWLEDGE,
    })),
    'FOREIGN_JOB_REJECT'
  );
  // foreign session-local source with an identical session string still rejects
  expectCode(
    () => evaluateKnowledgeReadEligibility(A_FULL, knowledgeRequest({
      source_scope: 'SESSION_LOCAL',
      source_job_id: 'ksc.job-b',
      source_session_id: 'session-one',
      source_namespace: B_KNOWLEDGE,
    })),
    'FOREIGN_JOB_REJECT'
  );
});

// KSC16 — no knowledge-write public API; module surface is read-eligibility
// only; error-like identifiers stay within the locked 18.
test('KSC16', () => {
  const exportNames = Object.keys(ks).slice().sort();
  assert.deepStrictEqual(exportNames, ['KNOWLEDGE_SOURCE_SCOPES', 'evaluateKnowledgeReadEligibility'].sort());
  assert.ok(exportNames.every((name) => !/write/i.test(name)), 'no write API may be exported');
  assert.strictEqual(ks.evaluateKnowledgeWrite, undefined);
  assert.strictEqual(ks.evaluateKnowledgeWriteEligibility, undefined);
  assert.strictEqual(ks.evaluateKnowledgeWriteAuthorization, undefined);
  assert.ok(!KS_SOURCE.includes('evaluateKnowledgeWrite'), 'no knowledge-write API may exist');

  const quoted = KS_SOURCE.match(/'[A-Z][A-Z0-9_]+'/g) || [];
  const errorLike = quoted
    .map((q) => q.slice(1, -1))
    .filter((code) => /(REJECT|FORBIDDEN|FAILED|INVALID|COLLISION|MISMATCH|CONFLICT|VIOLATION)/.test(code));
  assert.ok(errorLike.length > 0, 'error-surface scan must find the module error identifiers');
  for (const code of errorLike) {
    assert.ok(POLICY.canonical_errors.includes(code), `${code} must be one of the locked canonical identifiers`);
  }
});

// KSC17 — frozen/copy-safe decisions: decisions are frozen fresh objects;
// inputs are never mutated; caller mutation after a decision cannot mutate
// returned state.
test('KSC17', () => {
  const request = knowledgeRequest({ source_scope: 'SESSION_LOCAL', source_session_id: 'session-one' });
  const before = JSON.stringify(request);
  const decision = evaluateKnowledgeReadEligibility(A_FULL, request);
  assert.strictEqual(JSON.stringify(request), before, 'evaluation must not mutate the input descriptor');

  assert.ok(Object.isFrozen(decision));
  assert.notStrictEqual(decision, request);
  try { decision.eligible = false; } catch (e) { /* frozen */ }
  assert.deepStrictEqual(decision, { eligible: true, scope: 'SESSION_LOCAL' });

  // fresh decision objects per call (no shared cache)
  const decision2 = evaluateKnowledgeReadEligibility(A_FULL, knowledgeRequest({ source_scope: 'SESSION_LOCAL', source_session_id: 'session-one' }));
  assert.notStrictEqual(decision, decision2);
  assert.deepStrictEqual(decision, decision2);

  // caller mutation after the decision
  request.source_scope = 'GLOBAL';
  request.source_job_id = null;
  request.source_namespace = null;
  assert.deepStrictEqual(decision, { eligible: true, scope: 'SESSION_LOCAL' });

  // ineligible decisions are frozen too
  const ineligible = evaluateKnowledgeReadEligibility(A_BASE, knowledgeRequest({ source_scope: 'SESSION_LOCAL' }));
  assert.ok(Object.isFrozen(ineligible));
  try { ineligible.eligible = true; } catch (e) { /* frozen */ }
  assert.strictEqual(ineligible.eligible, false);
});

// KSC18 — 100x determinism: identical inputs produce identical decisions and
// identical canonical error outcomes.
test('KSC18', () => {
  const cases = [
    () => evaluateKnowledgeReadEligibility(A_FULL, knowledgeRequest({})),
    () => evaluateKnowledgeReadEligibility(A_FULL, knowledgeRequest({ source_scope: 'SESSION_LOCAL', source_session_id: 'session-one' })),
    () => evaluateKnowledgeReadEligibility(A_BASE, knowledgeRequest({ source_scope: 'SESSION_LOCAL', source_session_id: 'session-one' })),
    () => evaluateKnowledgeReadEligibility(A_FULL, knowledgeRequest({ source_scope: 'GLOBAL', source_job_id: null, source_namespace: null })),
  ];
  const first = cases.map((fn) => JSON.stringify(fn()));
  for (let i = 0; i < 100; i += 1) {
    cases.forEach((fn, idx) => {
      assert.strictEqual(JSON.stringify(fn()), first[idx], `case ${idx} must be deterministic`);
    });
  }
  for (let i = 0; i < 100; i += 1) {
    expectCode(
      () => evaluateKnowledgeReadEligibility(A_FULL, knowledgeRequest({ source_job_id: 'ksc.job-b', source_namespace: B_KNOWLEDGE })),
      'FOREIGN_JOB_REJECT'
    );
  }
});

console.log('');
console.log(`Cases: ${passed + failed}`);
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);

process.exit(failed > 0 ? 1 : 0);
