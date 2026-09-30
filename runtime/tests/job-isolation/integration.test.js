/**
 * Job Isolation v1 — Main Coordination Integration tests (INT01-INT24).
 *
 * Validates runtime/job-isolation/coordinator.js as the single composition
 * layer for Phase 9B (#41 / 9B-05) against the locked governance artifacts:
 *   - governance/contracts/job-isolation-v1.md (sections 17-21, 23)
 *   - governance/policies/job-isolation.json (job-isolation@1.0.0)
 *
 * The coordinator carries an authoritative active lane registry inside its
 * frozen state; lanes enter it only through the explicit
 * registerCoordinationLane transition. Merge eligibility and synchronization
 * recording require an already-registered exact lane (no auto-registration),
 * and the foreign contract/lane job boundary is evaluated before writer
 * ownership.
 *
 * Scope boundary: integration only. No JobContract change, no namespace
 * derivation change, no namespace isolation change, no knowledge-scope
 * change, no ParallelLane behavior change, no Phase 9B acceptance execution
 * (#42), no lifecycle state semantics (Phase 9C), no Context Hydration
 * coupling.
 *
 * Deterministic Node only. No wall clock. No randomness. No network. No
 * filesystem/runtime state (static repository source reads only, for the
 * boundary/error-surface guards). No env. No profile reads.
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
const ks = require('../../job-isolation/knowledge-scope.js');
const coord = require('../../job-isolation/coordinator.js');

const {
  COORDINATED_BOUNDARIES,
  createMainCoordinationState,
  registerCoordinationLane,
  recordAuditedSynchronization,
  evaluateMergeEligibility,
  evaluateCoordinatedOperation,
} = coord;

const COORDINATOR_SOURCE = fs.readFileSync(path.join(__dirname, '..', '..', 'job-isolation', 'coordinator.js'), 'utf8');

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

const MAIN_SHA = 'a'.repeat(40);
const OLD_SHA = 'b'.repeat(40);
const MAIN_SHA_2 = 'c'.repeat(40);
const OLD_SHA_2 = 'd'.repeat(40);

function makeContract(jobId, knowledgeScope) {
  return createJobContract({
    job_id: jobId,
    profile: 'default',
    knowledge_scope: knowledgeScope || ['JOB_LOCAL'],
    execution_permissions: ['READ_ONLY'],
  }, new Map());
}

const A = makeContract('int.job-a');
const A_FULL = makeContract('int.job-a', ['JOB_LOCAL', 'SESSION_LOCAL', 'GLOBAL']);
const B = makeContract('int.job-b');

function makeLane(overrides) {
  return Object.assign({
    lane_id: 'int-lane-a',
    job_id: 'int.job-a',
    branch: 'feature/41-int-lane-a',
    worktree: '<worktree-root>/issue-41',
    writer_identity: 'writer-one',
    baseline_main_sha: MAIN_SHA,
  }, overrides);
}

function freshState() {
  return createMainCoordinationState({ coordination_branch: 'main', authoritative_main_sha: MAIN_SHA });
}

/** Coordinator state with the given lane(s) explicitly registered. */
function withLane(state, lane) {
  return registerCoordinationLane(state, lane);
}

function registeredState(lane) {
  return withLane(freshState(), lane);
}

function mergeRequest(overrides) {
  return Object.assign({
    contract: A,
    lane: makeLane({}),
    writer_identity: 'writer-one',
  }, overrides);
}

const SESSION_NS = 'job:int.job-a:sessions';
const EVIDENCE_NS = 'job:int.job-a:evidence';
const LEDGER_NS = 'job:int.job-a:ledger';
const RUNTIME_NS = 'job:int.job-a:runtime-state';
const KNOWLEDGE_NS = 'job:int.job-a:knowledge';

function coordinatedRequest(overrides) {
  return Object.assign({
    contract: A,
    lane: makeLane({}),
    writer_identity: 'writer-one',
    boundary: 'SESSION',
    request: {
      operation: 'READ',
      resource_job_id: 'int.job-a',
      resource_namespace: SESSION_NS,
      resource_scope: 'JOB_SCOPED',
      requester_session_id: 'session-one',
      owner_session_id: 'session-two',
    },
  }, overrides);
}

// INT01 — main coordination state accepted: main-only checkout + valid
// authoritative SHA produce a frozen, copy-safe trusted state whose
// authoritative lane registry starts empty.
test('INT01', () => {
  const state = freshState();
  assert.deepStrictEqual(state, {
    coordination_branch: 'main',
    authoritative_main_sha: MAIN_SHA,
    lane_registry: [],
    synchronizations: [],
  });
  assert.ok(Object.isFrozen(state));
  assert.ok(Object.isFrozen(state.lane_registry));
  assert.ok(Object.isFrozen(state.synchronizations));
  try { state.authoritative_main_sha = OLD_SHA; } catch (e) { /* frozen */ }
  assert.strictEqual(state.authoritative_main_sha, MAIN_SHA);

  // trusted state is accepted by the lane-registration transition
  const next = registerCoordinationLane(state, makeLane({}));
  assert.strictEqual(next.lane_registry.length, 1);
  // and by the synchronization transition once the lane is registered
  const next2 = recordAuditedSynchronization(next, makeLane({}), 'audit-int01');
  assert.strictEqual(next2.synchronizations.length, 1);
});

// INT02 — non-main coordination checkout rejected.
test('INT02', () => {
  for (const branch of ['develop', 'Main', 'main ', 'feature/41-x', 'mains']) {
    expectCode(() => createMainCoordinationState({ coordination_branch: branch, authoritative_main_sha: MAIN_SHA }), 'COORDINATION_CHECKOUT_VIOLATION');
  }
  for (const branch of [42, null, undefined, '']) {
    expectCode(() => createMainCoordinationState({ coordination_branch: branch, authoritative_main_sha: MAIN_SHA }), 'LANE_CONTRACT_INVALID');
  }
});

// INT03 — malformed authoritative SHA rejected with the locked structural lane mapping.
test('INT03', () => {
  for (const sha of ['zz', 'abc', 'A'.repeat(40), 'a'.repeat(39), 'a'.repeat(41), '', 42, null]) {
    expectCode(() => createMainCoordinationState({ coordination_branch: 'main', authoritative_main_sha: sha }), 'LANE_CONTRACT_INVALID');
  }
});

// INT04 — raw / forged coordinator authority rejected; caller flags never
// grant authority; a raw object carrying a structurally valid lane registry
// is still untrusted.
test('INT04', () => {
  const state = freshState();
  const validLane = makeLane({});
  const registered = withLane(state, validLane);
  const request = mergeRequest({});

  // raw lookalike with identical visible fields
  const raw = { coordination_branch: 'main', authoritative_main_sha: MAIN_SHA, lane_registry: [], synchronizations: [] };
  expectCode(() => evaluateMergeEligibility(raw, request), 'COORDINATION_CHECKOUT_VIOLATION');

  // raw object containing a structurally valid lane registry
  const rawWithRegistry = {
    coordination_branch: 'main',
    authoritative_main_sha: MAIN_SHA,
    lane_registry: [registered.lane_registry[0]],
    synchronizations: [],
  };
  expectCode(() => evaluateMergeEligibility(rawWithRegistry, request), 'COORDINATION_CHECKOUT_VIOLATION');

  // JSON clone of real state
  const clone = JSON.parse(JSON.stringify(registered));
  expectCode(() => evaluateMergeEligibility(clone, request), 'COORDINATION_CHECKOUT_VIOLATION');

  // caller-added trust flags on a copy
  const flagged = Object.assign({}, registered, { verified: true, synchronized_to_sha: MAIN_SHA, trusted: true });
  expectCode(() => evaluateMergeEligibility(flagged, request), 'COORDINATION_CHECKOUT_VIOLATION');

  // forged authority rejected by every public boundary
  expectCode(() => registerCoordinationLane(raw, validLane), 'COORDINATION_CHECKOUT_VIOLATION');
  expectCode(() => recordAuditedSynchronization(raw, validLane, 'audit'), 'COORDINATION_CHECKOUT_VIOLATION');
  expectCode(() => evaluateCoordinatedOperation(raw, coordinatedRequest({})), 'COORDINATION_CHECKOUT_VIOLATION');

  // authority failure precedes contract/request validation
  expectCode(() => evaluateMergeEligibility(raw, null), 'COORDINATION_CHECKOUT_VIOLATION');
  expectCode(() => evaluateMergeEligibility(raw, { contract: null, lane: null, writer_identity: null }), 'COORDINATION_CHECKOUT_VIOLATION');
});

// INT05 — authoritative lane registration: an unregistered otherwise-valid
// lane is NOT merge eligible and cannot dispatch; explicit registration makes
// it authoritative; exact re-registration is idempotent; the registry
// persists across transitions.
test('INT05', () => {
  const state0 = freshState();

  // empty registry: otherwise-valid lane is not eligible
  expectCode(() => evaluateMergeEligibility(state0, mergeRequest({})), 'LANE_CONTRACT_INVALID');
  // unregistered lane cannot be synchronized
  expectCode(() => recordAuditedSynchronization(state0, makeLane({}), 'audit'), 'LANE_CONTRACT_INVALID');
  // unregistered lane fails closed before any namespace/knowledge dispatch
  expectCode(() => evaluateCoordinatedOperation(state0, coordinatedRequest({ request: { broken: true } })), 'LANE_CONTRACT_INVALID');

  // explicit registration transition
  const state1 = registerCoordinationLane(state0, makeLane({}));
  assert.strictEqual(state1.lane_registry.length, 1);
  assert.strictEqual(state1.lane_registry[0].lane_id, 'int-lane-a');
  assert.strictEqual(state1.lane_registry[0].job_id, 'int.job-a');
  assert.ok(Object.isFrozen(state1.lane_registry));
  assert.ok(Object.isFrozen(state1.lane_registry[0]));
  // original state unchanged
  assert.strictEqual(state0.lane_registry.length, 0);

  // now merge eligible
  assert.strictEqual(evaluateMergeEligibility(state1, mergeRequest({})).merge_eligible, true);

  // registry persists across registration calls
  const state2 = registerCoordinationLane(state1, makeLane({ lane_id: 'int-lane-x' }));
  assert.deepStrictEqual(state2.lane_registry.map((l) => l.lane_id), ['int-lane-a', 'int-lane-x']);
  assert.strictEqual(state1.lane_registry.length, 1);
});

// INT06 — invalid JobContract errors are preserved; contract validation
// precedes lane/registry validation.
test('INT06', () => {
  const state = registeredState(makeLane({}));
  const unknownField = Object.assign({}, A, { extra_field: 1 });
  expectCode(() => evaluateMergeEligibility(state, mergeRequest({ contract: unknownField })), 'JOB_CONTRACT_INVALID');
  const tampered = Object.assign({}, A, { session_namespace: 'job:evil:sessions' });
  expectCode(() => evaluateMergeEligibility(state, mergeRequest({ contract: tampered })), 'NAMESPACE_OVERRIDE_FORBIDDEN');
  const badJob = Object.assign({}, A, { job_id: 'INT.JOB-A' });
  expectCode(() => evaluateMergeEligibility(state, mergeRequest({ contract: badJob })), 'INVALID_JOB_ID');
  // contract error wins over lane structural and registry issues
  expectCode(() => evaluateMergeEligibility(freshState(), mergeRequest({ contract: unknownField })), 'JOB_CONTRACT_INVALID');
  expectCode(() => evaluateMergeEligibility(state, mergeRequest({ contract: unknownField, lane: makeLane({ branch: 'main' }) })), 'JOB_CONTRACT_INVALID');
});

// INT07 — registration collisions and ownership semantics stay owned by the
// existing ParallelLane authority (no rule duplication).
test('INT07', () => {
  const state = registeredState(makeLane({}));

  // exact re-registration is idempotent
  assert.strictEqual(registerCoordinationLane(state, makeLane({})).lane_registry.length, 1);
  // same lane_id + different writer -> LANE_OWNERSHIP_CONFLICT
  expectCode(() => registerCoordinationLane(state, makeLane({ writer_identity: 'writer-two' })), 'LANE_OWNERSHIP_CONFLICT');
  // same lane_id + different job/branch/worktree/baseline -> LANE_ID_COLLISION
  expectCode(() => registerCoordinationLane(state, makeLane({ job_id: 'int.job-b' })), 'LANE_ID_COLLISION');
  expectCode(() => registerCoordinationLane(state, makeLane({ branch: 'feature/41-other' })), 'LANE_ID_COLLISION');
  expectCode(() => registerCoordinationLane(state, makeLane({ worktree: '<worktree-root>/other' })), 'LANE_ID_COLLISION');
  expectCode(() => registerCoordinationLane(state, makeLane({ baseline_main_sha: OLD_SHA })), 'LANE_ID_COLLISION');

  // merge-time ownership preserved
  expectCode(() => evaluateMergeEligibility(state, mergeRequest({ writer_identity: 'writer-two' })), 'LANE_OWNERSHIP_CONFLICT');
  expectCode(() => evaluateMergeEligibility(state, mergeRequest({ writer_identity: '' })), 'LANE_CONTRACT_INVALID');
  expectCode(() => evaluateMergeEligibility(state, mergeRequest({ writer_identity: 42 })), 'LANE_CONTRACT_INVALID');

  // merge-time lane rebinding against the authoritative registry
  expectCode(() => evaluateMergeEligibility(state, mergeRequest({ lane: makeLane({ baseline_main_sha: OLD_SHA }) })), 'LANE_ID_COLLISION');
  expectCode(() => evaluateMergeEligibility(state, mergeRequest({ lane: makeLane({ job_id: 'int.job-b' }) })), 'FOREIGN_JOB_REJECT');

  // lane structural errors propagate from the existing authority
  expectCode(() => evaluateMergeEligibility(state, mergeRequest({ lane: makeLane({ branch: 'main' }) })), 'COORDINATION_CHECKOUT_VIOLATION');
  expectCode(() => evaluateMergeEligibility(state, mergeRequest({ lane: makeLane({ baseline_main_sha: 'zz' }) })), 'LANE_CONTRACT_INVALID');
  expectCode(() => evaluateMergeEligibility(state, mergeRequest({ lane: null })), 'LANE_CONTRACT_INVALID');
});

// INT08 — contract/lane foreign-job mismatch rejected BEFORE writer
// ownership: writer identity is irrelevant once lane and contract jobs differ.
test('INT08', () => {
  const foreignLane = makeLane({ lane_id: 'int-lane-b', job_id: 'int.job-b', baseline_main_sha: OLD_SHA });
  const stateB = registeredState(foreignLane);

  // writer matches the foreign lane writer
  expectCode(() => evaluateMergeEligibility(stateB, mergeRequest({ lane: foreignLane, writer_identity: 'writer-one' })), 'FOREIGN_JOB_REJECT');
  // writer differs from the foreign lane writer — still FOREIGN_JOB_REJECT
  expectCode(() => evaluateMergeEligibility(stateB, mergeRequest({ lane: foreignLane, writer_identity: 'some-other-writer' })), 'FOREIGN_JOB_REJECT');

  // same lane_id text as a job-A lane, different job: foreign rejection wins
  const sameTextLane = makeLane({ lane_id: 'int-lane-a', job_id: 'int.job-b', baseline_main_sha: OLD_SHA });
  const stateB2 = registeredState(sameTextLane);
  expectCode(() => evaluateMergeEligibility(stateB2, mergeRequest({ lane: sameTextLane, writer_identity: 'writer-one' })), 'FOREIGN_JOB_REJECT');

  // even with a recorded audited synchronization for the foreign lane
  const stateB3 = recordAuditedSynchronization(stateB, foreignLane, 'audit-foreign');
  expectCode(() => evaluateMergeEligibility(stateB3, mergeRequest({ lane: foreignLane, writer_identity: 'writer-one' })), 'FOREIGN_JOB_REJECT');
});

// INT09 — fresh baseline is merge eligible without synchronization; unrelated
// synchronization records do not affect freshness.
test('INT09', () => {
  const laneX = makeLane({ lane_id: 'int-lane-x', baseline_main_sha: OLD_SHA });
  let state = registeredState(makeLane({}));
  state = registerCoordinationLane(state, laneX);
  state = recordAuditedSynchronization(state, laneX, 'audit-x');
  const decision = evaluateMergeEligibility(state, mergeRequest({}));
  assert.strictEqual(decision.merge_eligible, true);
  assert.strictEqual(decision.synchronized, false);
  assert.strictEqual(decision.audit_ref, null);
  assert.strictEqual(decision.authoritative_main_sha, MAIN_SHA);
});

// INT10 — stale baseline without coordinator audit is rejected; a stale lane
// is never authoritative main.
test('INT10', () => {
  const staleLane = makeLane({ baseline_main_sha: OLD_SHA });
  const state = registeredState(staleLane);
  expectCode(() => evaluateMergeEligibility(state, mergeRequest({ lane: staleLane })), 'STALE_MAIN_BASELINE');
});

// INT11 — raw synchronization assertions cannot clear staleness: forged
// states carrying lookalike records (and even a real registry) are rejected
// outright, and JSON clones of real states remain untrusted.
test('INT11', () => {
  const staleLane = makeLane({ baseline_main_sha: OLD_SHA });
  const registered = registeredState(staleLane);

  const forged = {
    coordination_branch: 'main',
    authoritative_main_sha: MAIN_SHA,
    lane_registry: [registered.lane_registry[0]],
    synchronizations: [
      Object.freeze({
        lane_id: 'int-lane-a',
        job_id: 'int.job-a',
        from_main_sha: OLD_SHA,
        to_main_sha: MAIN_SHA,
        audit_ref: 'forged-audit',
      }),
    ],
  };
  expectCode(() => evaluateMergeEligibility(forged, mergeRequest({ lane: staleLane })), 'COORDINATION_CHECKOUT_VIOLATION');

  // JSON clone of a state that DOES contain a real record is still untrusted
  const real = recordAuditedSynchronization(registered, staleLane, 'audit-real');
  const clone = JSON.parse(JSON.stringify(real));
  expectCode(() => evaluateMergeEligibility(clone, mergeRequest({ lane: staleLane })), 'COORDINATION_CHECKOUT_VIOLATION');
});

// INT12 — coordinator-recorded audited synchronization clears the matching
// stale baseline; the original state remains unchanged and the lane registry
// is preserved byte-equivalently by the synchronization transition.
test('INT12', () => {
  const staleLane = makeLane({ baseline_main_sha: OLD_SHA });
  const state1 = registeredState(staleLane);
  expectCode(() => evaluateMergeEligibility(state1, mergeRequest({ lane: staleLane })), 'STALE_MAIN_BASELINE');

  const state2 = recordAuditedSynchronization(state1, staleLane, 'audit-ref-1');
  assert.strictEqual(state1.synchronizations.length, 0, 'original state must not be mutated');
  assert.strictEqual(state1.lane_registry.length, 1);
  assert.strictEqual(JSON.stringify(state2.lane_registry), JSON.stringify(state1.lane_registry), 'lane registry must be preserved byte-equivalently');

  const decision = evaluateMergeEligibility(state2, mergeRequest({ lane: staleLane }));
  assert.deepStrictEqual(decision, {
    merge_eligible: true,
    lane_id: 'int-lane-a',
    job_id: 'int.job-a',
    authoritative_main_sha: MAIN_SHA,
    synchronized: true,
    audit_ref: 'audit-ref-1',
  });
  assert.ok(Object.isFrozen(decision));
  assert.ok(Object.isFrozen(state2.synchronizations[0]));
});

// INT13 — an audit for a different lane does not clear staleness.
test('INT13', () => {
  const laneA = makeLane({ baseline_main_sha: OLD_SHA });
  const laneC = makeLane({ lane_id: 'int-lane-c', baseline_main_sha: OLD_SHA });
  let state = registeredState(laneA);
  state = registerCoordinationLane(state, laneC);
  state = recordAuditedSynchronization(state, laneA, 'audit-lane-a');
  expectCode(() => evaluateMergeEligibility(state, mergeRequest({ lane: laneC })), 'STALE_MAIN_BASELINE');
});

// INT14 — audits for a different job / different to SHA do not clear
// staleness; a rebaselined lane under the same lane_id fails closed at
// authoritative registration (wrong-from is structurally impossible once
// lanes are registered).
test('INT14', () => {
  // different job: record for a job-B lane, evaluate a job-A stale lane
  const laneA = makeLane({ baseline_main_sha: OLD_SHA });
  const laneB = makeLane({ lane_id: 'int-lane-b', job_id: 'int.job-b', baseline_main_sha: OLD_SHA });
  let state = registeredState(laneA);
  state = registerCoordinationLane(state, laneB);
  state = recordAuditedSynchronization(state, laneB, 'audit-job-b');
  expectCode(() => evaluateMergeEligibility(state, mergeRequest({ lane: laneA })), 'STALE_MAIN_BASELINE');

  // different to SHA: a record made against MAIN_SHA clears staleness under
  // MAIN_SHA, but not once authority has moved to MAIN_SHA_2
  const stateA = registeredState(laneA);
  const stateAWithRecord = recordAuditedSynchronization(stateA, laneA, 'audit-to');
  assert.strictEqual(evaluateMergeEligibility(stateAWithRecord, mergeRequest({ lane: laneA })).synchronized, true);
  const stateB2 = registerCoordinationLane(
    createMainCoordinationState({ coordination_branch: 'main', authoritative_main_sha: MAIN_SHA_2 }),
    laneA
  );
  expectCode(() => evaluateMergeEligibility(stateB2, mergeRequest({ lane: laneA })), 'STALE_MAIN_BASELINE');

  // wrong-from: a rebaselined lane under the same lane_id is rejected at
  // authoritative registration and at merge evaluation (LANE_ID_COLLISION)
  expectCode(() => registerCoordinationLane(stateA, makeLane({ baseline_main_sha: OLD_SHA_2 })), 'LANE_ID_COLLISION');
  expectCode(() => evaluateMergeEligibility(stateA, mergeRequest({ lane: makeLane({ baseline_main_sha: OLD_SHA_2 }) })), 'LANE_ID_COLLISION');
});

// INT15 — synchronization record idempotence and collision behavior is
// deterministic; recording requires a registered lane; audit provenance is
// never silently overwritten; the registry is unchanged by synchronization.
test('INT15', () => {
  const staleLane = makeLane({ baseline_main_sha: OLD_SHA });
  const state = registeredState(staleLane);
  const s2 = recordAuditedSynchronization(state, staleLane, 'audit-1');
  const s3 = recordAuditedSynchronization(s2, staleLane, 'audit-1');
  assert.strictEqual(s3.synchronizations.length, 1, 'exact repeat must be idempotent');
  assert.strictEqual(JSON.stringify(s3), JSON.stringify(s2));
  expectCode(() => recordAuditedSynchronization(s2, staleLane, 'audit-2'), 'LANE_ID_COLLISION');

  // invalid audit_ref fails closed
  for (const badRef of ['', 42, null, undefined, true]) {
    expectCode(() => recordAuditedSynchronization(state, staleLane, badRef), 'LANE_CONTRACT_INVALID');
  }

  // synchronization is never an implicit registration path
  expectCode(() => recordAuditedSynchronization(state, makeLane({ lane_id: 'int-lane-z', baseline_main_sha: OLD_SHA }), 'audit'), 'LANE_CONTRACT_INVALID');
  expectCode(() => recordAuditedSynchronization(state, makeLane({ writer_identity: 'writer-two', baseline_main_sha: OLD_SHA }), 'audit'), 'LANE_OWNERSHIP_CONFLICT');
  expectCode(() => recordAuditedSynchronization(state, makeLane({ job_id: 'int.job-b', baseline_main_sha: OLD_SHA }), 'audit'), 'LANE_ID_COLLISION');

  // the transition records lane_id/job_id/from/to derived from the registered lane + state only
  const record = s2.synchronizations[0];
  assert.deepStrictEqual(Object.keys(record), ['lane_id', 'job_id', 'from_main_sha', 'to_main_sha', 'audit_ref']);
  assert.strictEqual(record.from_main_sha, OLD_SHA);
  assert.strictEqual(record.to_main_sha, MAIN_SHA);
  // lane registry unchanged by synchronization
  assert.strictEqual(JSON.stringify(s2.lane_registry), JSON.stringify(state.lane_registry));
});

// INT16 — coordinated SESSION access preserves the underlying decision
// semantics exactly (JOB_SCOPED shared, SESSION_LOCAL owner-restricted).
test('INT16', () => {
  const state = registeredState(makeLane({}));
  const jobScoped = coordinatedRequest({ request: {
    operation: 'READ',
    resource_job_id: 'int.job-a',
    resource_namespace: SESSION_NS,
    resource_scope: 'JOB_SCOPED',
    requester_session_id: 'session-one',
    owner_session_id: 'session-two',
  } });
  const direct = ns.evaluateSessionAccess(A, jobScoped.request);
  const result = evaluateCoordinatedOperation(state, jobScoped);
  assert.deepStrictEqual(result.decision, direct);
  assert.strictEqual(result.decision.allowed, true);
  assert.strictEqual(result.boundary, 'SESSION');
  assert.strictEqual(result.merge_eligibility.merge_eligible, true);
  assert.ok(Object.isFrozen(result));

  const sessionLocal = coordinatedRequest({ request: {
    operation: 'READ',
    resource_job_id: 'int.job-a',
    resource_namespace: SESSION_NS,
    resource_scope: 'SESSION_LOCAL',
    requester_session_id: 'session-one',
    owner_session_id: 'session-two',
  } });
  const directLocal = ns.evaluateSessionAccess(A, sessionLocal.request);
  const resultLocal = evaluateCoordinatedOperation(state, sessionLocal);
  assert.deepStrictEqual(resultLocal.decision, directLocal);
  assert.strictEqual(resultLocal.decision.allowed, false);
});

// INT17 — coordinated KNOWLEDGE_READ preserves eligibility semantics,
// including ordinary capability ineligibility.
test('INT17', () => {
  const state = registeredState(makeLane({}));
  const jobLocal = coordinatedRequest({ boundary: 'KNOWLEDGE_READ', request: {
    requester_session_id: 'session-one',
    source_scope: 'JOB_LOCAL',
    source_job_id: 'int.job-a',
    source_session_id: null,
    source_namespace: KNOWLEDGE_NS,
  } });
  const result = evaluateCoordinatedOperation(state, jobLocal);
  assert.deepStrictEqual(result.decision, ks.evaluateKnowledgeReadEligibility(A, jobLocal.request));
  assert.deepStrictEqual(result.decision, { eligible: true, scope: 'JOB_LOCAL' });

  const sessionLocal = coordinatedRequest({ boundary: 'KNOWLEDGE_READ', request: {
    requester_session_id: 'session-one',
    source_scope: 'SESSION_LOCAL',
    source_job_id: 'int.job-a',
    source_session_id: 'session-one',
    source_namespace: KNOWLEDGE_NS,
  } });
  const ineligible = evaluateCoordinatedOperation(state, sessionLocal);
  assert.deepStrictEqual(ineligible.decision, ks.evaluateKnowledgeReadEligibility(A, sessionLocal.request));
  assert.deepStrictEqual(ineligible.decision, { eligible: false, scope: 'SESSION_LOCAL' });
});

// INT18 — coordinated EVIDENCE access preserves decisions and canonical errors.
test('INT18', () => {
  const state = registeredState(makeLane({}));
  const read = coordinatedRequest({ boundary: 'EVIDENCE', request: {
    operation: 'READ',
    resource_job_id: 'int.job-a',
    resource_namespace: EVIDENCE_NS,
  } });
  const result = evaluateCoordinatedOperation(state, read);
  assert.deepStrictEqual(result.decision, ns.evaluateEvidenceAccess(A, read.request));
  assert.strictEqual(result.decision.allowed, true);

  const mismatch = coordinatedRequest({ boundary: 'EVIDENCE', request: {
    operation: 'READ',
    resource_job_id: 'int.job-a',
    resource_namespace: LEDGER_NS,
  } });
  expectCode(() => evaluateCoordinatedOperation(state, mismatch), 'NAMESPACE_COLLISION');
});

// INT19 — coordinated LEDGER access preserves decisions and canonical errors.
test('INT19', () => {
  const state = registeredState(makeLane({}));
  const write = coordinatedRequest({ boundary: 'LEDGER', request: {
    operation: 'WRITE',
    resource_job_id: 'int.job-a',
    resource_namespace: LEDGER_NS,
  } });
  const result = evaluateCoordinatedOperation(state, write);
  assert.deepStrictEqual(result.decision, ns.evaluateLedgerAccess(A, write.request));
  assert.strictEqual(result.decision.allowed, true);

  const foreign = coordinatedRequest({ boundary: 'LEDGER', request: {
    operation: 'WRITE',
    resource_job_id: 'int.job-b',
    resource_namespace: 'job:int.job-b:ledger',
  } });
  expectCode(() => evaluateCoordinatedOperation(state, foreign), 'FOREIGN_NAMESPACE_WRITE_REJECTED');
});

// INT20 — coordinated RUNTIME_STATE access and CLEANUP preserve boundary
// semantics exactly, including foreign mapping and operation strictness.
test('INT20', () => {
  const state = registeredState(makeLane({}));
  const read = coordinatedRequest({ boundary: 'RUNTIME_STATE', request: {
    operation: 'READ',
    resource_job_id: 'int.job-a',
    resource_namespace: RUNTIME_NS,
  } });
  const result = evaluateCoordinatedOperation(state, read);
  assert.deepStrictEqual(result.decision, ns.evaluateRuntimeStateAccess(A, read.request));
  assert.strictEqual(result.decision.allowed, true);

  const cleanup = coordinatedRequest({ boundary: 'RUNTIME_STATE_CLEANUP', request: {
    operation: 'CLEANUP',
    resource_job_id: 'int.job-a',
    resource_namespace: RUNTIME_NS,
  } });
  const cleanupResult = evaluateCoordinatedOperation(state, cleanup);
  assert.deepStrictEqual(cleanupResult.decision, ns.evaluateRuntimeStateCleanup(A, cleanup.request));
  assert.deepStrictEqual(cleanupResult.decision, { allowed: true, same_job: true, operation: 'CLEANUP' });

  const foreignCleanup = coordinatedRequest({ boundary: 'RUNTIME_STATE_CLEANUP', request: {
    operation: 'CLEANUP',
    resource_job_id: 'int.job-b',
    resource_namespace: 'job:int.job-b:runtime-state',
  } });
  expectCode(() => evaluateCoordinatedOperation(state, foreignCleanup), 'FOREIGN_NAMESPACE_WRITE_REJECTED');

  const wrongOp = coordinatedRequest({ boundary: 'RUNTIME_STATE_CLEANUP', request: {
    operation: 'READ',
    resource_job_id: 'int.job-a',
    resource_namespace: RUNTIME_NS,
  } });
  expectCode(() => evaluateCoordinatedOperation(state, wrongOp), 'NAMESPACE_DERIVATION_FAILED');
});

// INT21 — end-to-end cross-job isolation: foreign resource jobs are rejected
// by the underlying boundaries and foreign lanes never become eligible.
test('INT21', () => {
  const state = registeredState(makeLane({}));

  // JobContract A + Lane A + resource Job B -> underlying foreign rejection preserved
  const foreignEvidence = coordinatedRequest({ boundary: 'EVIDENCE', request: {
    operation: 'READ',
    resource_job_id: 'int.job-b',
    resource_namespace: 'job:int.job-b:evidence',
  } });
  expectCode(() => evaluateCoordinatedOperation(state, foreignEvidence), 'FOREIGN_JOB_REJECT');

  // foreign knowledge source is rejected even with GLOBAL capability
  const foreignKnowledge = coordinatedRequest({ contract: A_FULL, boundary: 'KNOWLEDGE_READ', request: {
    requester_session_id: 'session-one',
    source_scope: 'GLOBAL',
    source_job_id: 'int.job-b',
    source_session_id: null,
    source_namespace: 'job:int.job-b:knowledge',
  } });
  expectCode(() => evaluateCoordinatedOperation(state, foreignKnowledge), 'FOREIGN_JOB_REJECT');

  // JobContract A + registered foreign Lane B -> FOREIGN_JOB_REJECT before any
  // namespace access (even with a recorded audited synchronization)
  const foreignLane = makeLane({ lane_id: 'int-lane-b', job_id: 'int.job-b', baseline_main_sha: OLD_SHA });
  let stateB = registeredState(foreignLane);
  stateB = recordAuditedSynchronization(stateB, foreignLane, 'audit-foreign-lane');
  expectCode(() => evaluateMergeEligibility(stateB, mergeRequest({ lane: foreignLane })), 'FOREIGN_JOB_REJECT');
  expectCode(() => evaluateCoordinatedOperation(stateB, coordinatedRequest({ lane: foreignLane })), 'FOREIGN_JOB_REJECT');

  // session identity never bypasses the job boundary either
  const foreignSession = coordinatedRequest({ request: {
    operation: 'READ',
    resource_job_id: 'int.job-b',
    resource_namespace: 'job:int.job-b:sessions',
    resource_scope: 'SESSION_LOCAL',
    requester_session_id: 'session-one',
    owner_session_id: 'session-one',
  } });
  expectCode(() => evaluateCoordinatedOperation(state, foreignSession), 'FOREIGN_JOB_REJECT');
});

// INT22 — unknown boundary fails closed with the structural integration
// mapping; strict descriptor closure holds for every coordinator request.
test('INT22', () => {
  const state = registeredState(makeLane({}));
  for (const boundary of ['SESSIONS', 'WRITE', 'session', 'SESSION_LOCAL', 'READ', '', 42, null, undefined]) {
    expectCode(() => evaluateCoordinatedOperation(state, coordinatedRequest({ boundary })), 'LANE_CONTRACT_INVALID');
  }
  assert.deepStrictEqual(COORDINATED_BOUNDARIES, ['SESSION', 'KNOWLEDGE_READ', 'EVIDENCE', 'LEDGER', 'RUNTIME_STATE', 'RUNTIME_STATE_CLEANUP']);

  // unknown/missing fields and hidden/symbol keys fail closed
  expectCode(() => evaluateCoordinatedOperation(state, coordinatedRequest({ extra: 1 })), 'LANE_CONTRACT_INVALID');
  const missing = coordinatedRequest({});
  delete missing.boundary;
  expectCode(() => evaluateCoordinatedOperation(state, missing), 'LANE_CONTRACT_INVALID');
  const hidden = coordinatedRequest({});
  Object.defineProperty(hidden, 'hidden', { value: 'x', enumerable: false });
  expectCode(() => evaluateCoordinatedOperation(state, hidden), 'LANE_CONTRACT_INVALID');
  const symbolKeyed = coordinatedRequest({});
  symbolKeyed[Symbol('meta')] = 'x';
  expectCode(() => evaluateCoordinatedOperation(state, symbolKeyed), 'LANE_CONTRACT_INVALID');
  const customProto = Object.create({});
  Object.assign(customProto, coordinatedRequest({}));
  expectCode(() => evaluateCoordinatedOperation(state, customProto), 'LANE_CONTRACT_INVALID');
  expectCode(() => evaluateCoordinatedOperation(state, []), 'LANE_CONTRACT_INVALID');

  // merge-eligibility request closure
  expectCode(() => evaluateMergeEligibility(state, mergeRequest({ extra: 1 })), 'LANE_CONTRACT_INVALID');
  const missingWriter = mergeRequest({});
  delete missingWriter.writer_identity;
  expectCode(() => evaluateMergeEligibility(state, missingWriter), 'LANE_CONTRACT_INVALID');

  // state input closure
  expectCode(() => createMainCoordinationState({ coordination_branch: 'main' }), 'LANE_CONTRACT_INVALID');
  expectCode(() => createMainCoordinationState({ coordination_branch: 'main', authoritative_main_sha: MAIN_SHA, extra: 1 }), 'LANE_CONTRACT_INVALID');
});

// INT23 — trust boundaries, frozen/copy-safe outputs, and getter invocation
// count 0 across every public coordinator boundary.
test('INT23', () => {
  const state = registeredState(makeLane({}));

  // accessor-backed fields: getters never execute
  let getterCalls = 0;
  const accessorMerge = { contract: A, lane: makeLane({}) };
  Object.defineProperty(accessorMerge, 'writer_identity', {
    get() { getterCalls += 1; return 'writer-one'; },
    enumerable: true,
    configurable: true,
  });
  expectCode(() => evaluateMergeEligibility(state, accessorMerge), 'LANE_CONTRACT_INVALID');
  assert.strictEqual(getterCalls, 0);

  const accessorCoord = { contract: A, lane: makeLane({}), writer_identity: 'writer-one', request: {} };
  Object.defineProperty(accessorCoord, 'boundary', {
    get() { getterCalls += 1; return 'SESSION'; },
    set() { getterCalls += 1; },
    enumerable: true,
    configurable: true,
  });
  expectCode(() => evaluateCoordinatedOperation(state, accessorCoord), 'LANE_CONTRACT_INVALID');
  assert.strictEqual(getterCalls, 0);

  const accessorState = { authoritative_main_sha: MAIN_SHA };
  Object.defineProperty(accessorState, 'coordination_branch', {
    get() { getterCalls += 1; return 'main'; },
    enumerable: true,
    configurable: true,
  });
  expectCode(() => createMainCoordinationState(accessorState), 'LANE_CONTRACT_INVALID');
  assert.strictEqual(getterCalls, 0);

  // frozen outputs and caller-mutation isolation
  const request = mergeRequest({});
  const before = JSON.stringify(request);
  const decision = evaluateMergeEligibility(state, request);
  assert.strictEqual(JSON.stringify(request), before, 'inputs must never be mutated');
  try { decision.merge_eligible = false; } catch (e) { /* frozen */ }
  assert.strictEqual(decision.merge_eligible, true);
  request.writer_identity = 'writer-two';
  assert.strictEqual(decision.merge_eligible, true, 'caller mutation must not alter a returned decision');

  const result = evaluateCoordinatedOperation(state, coordinatedRequest({}));
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.merge_eligibility));
  assert.ok(Object.isFrozen(result.decision));
  try { result.decision.allowed = false; } catch (e) { /* frozen */ }
  assert.strictEqual(result.decision.allowed, true);

  // state, registry, registered lanes, and records are frozen
  assert.ok(Object.isFrozen(state));
  assert.ok(Object.isFrozen(state.lane_registry));
  assert.ok(Object.isFrozen(state.lane_registry[0]));
  try { state.lane_registry.push({}); } catch (e) { /* frozen */ }
  assert.strictEqual(state.lane_registry.length, 1);
  const synced = recordAuditedSynchronization(state, makeLane({}), 'audit-frozen');
  assert.ok(Object.isFrozen(synced));
  assert.ok(Object.isFrozen(synced.lane_registry));
  assert.ok(Object.isFrozen(synced.synchronizations));
  assert.ok(Object.isFrozen(synced.synchronizations[0]));
  try { synced.synchronizations.push({}); } catch (e) { /* frozen */ }
  assert.strictEqual(synced.synchronizations.length, 1);
  // registry unchanged by the synchronization transition
  assert.strictEqual(JSON.stringify(synced.lane_registry), JSON.stringify(state.lane_registry));
});

// INT24 — 100x deterministic stress; lifecycle-state absence; coordinator
// error surface stays within the locked 18 canonical identifiers.
test('INT24', () => {
  const staleLane = makeLane({ baseline_main_sha: OLD_SHA });
  const state0 = freshState();
  const stateStale = registeredState(staleLane);
  const stateSynced = recordAuditedSynchronization(stateStale, staleLane, 'audit-loop');
  const stateFresh = registeredState(makeLane({}));

  const fresh = () => evaluateMergeEligibility(stateFresh, mergeRequest({}));
  const stale = () => {
    try {
      evaluateMergeEligibility(stateStale, mergeRequest({ lane: staleLane }));
      return null;
    } catch (e) {
      return e.code;
    }
  };
  const synced = () => evaluateMergeEligibility(stateSynced, mergeRequest({ lane: staleLane }));
  const coordinated = () => evaluateCoordinatedOperation(stateFresh, coordinatedRequest({}));

  const first = [JSON.stringify(fresh()), stale(), JSON.stringify(synced()), JSON.stringify(coordinated())];
  assert.strictEqual(first[1], 'STALE_MAIN_BASELINE');
  for (let i = 0; i < 100; i += 1) {
    assert.strictEqual(JSON.stringify(fresh()), first[0], 'fresh decision must be deterministic');
    assert.strictEqual(stale(), first[1], 'stale outcome must be deterministic');
    assert.strictEqual(JSON.stringify(synced()), first[2], 'synced decision must be deterministic');
    assert.strictEqual(JSON.stringify(coordinated()), first[3], 'coordinated result must be deterministic');
    const rebuilt = recordAuditedSynchronization(registeredState(staleLane), staleLane, 'audit-loop');
    assert.strictEqual(JSON.stringify(rebuilt), JSON.stringify(stateSynced), 'state transitions must be deterministic');
  }
  assert.strictEqual(state0.lane_registry.length, 0);

  // lifecycle-state absence: no Phase 9C state machine semantics in the module
  const upper = COORDINATOR_SOURCE.toUpperCase();
  for (const token of ['CHECKPOINTED', 'INTERRUPTED', 'CONFLICTED', 'MERGE_PENDING', 'RESOLVED', 'ARCHIVED', 'RECOVERY', 'RESUME', 'RETRY']) {
    assert.ok(!upper.includes(token), `coordinator must not contain lifecycle token: ${token}`);
  }
  for (const name of Object.keys(coord)) {
    assert.ok(!/resume|recover|retry/i.test(name), `no lifecycle export may exist: ${name}`);
  }

  // canonical error-surface guard: every coordinator outcome stays within the locked 18
  const locked = POLICY.canonical_errors;
  assert.strictEqual(locked.length, 18);
  const observed = new Set();
  const battery = [
    () => createMainCoordinationState({ coordination_branch: 'develop', authoritative_main_sha: MAIN_SHA }),
    () => createMainCoordinationState({ coordination_branch: 'main', authoritative_main_sha: 'zz' }),
    () => createMainCoordinationState(null),
    () => evaluateMergeEligibility({}, mergeRequest({})),
    () => evaluateMergeEligibility(stateFresh, null),
    () => evaluateMergeEligibility(stateFresh, mergeRequest({ contract: Object.assign({}, A, { session_namespace: 'job:evil:sessions' }) })),
    () => evaluateMergeEligibility(stateFresh, mergeRequest({ lane: makeLane({ branch: 'main' }) })),
    () => evaluateMergeEligibility(stateFresh, mergeRequest({ lane: makeLane({ job_id: 'int.job-b' }) })),
    () => evaluateMergeEligibility(freshState(), mergeRequest({})),
    () => evaluateMergeEligibility(stateFresh, mergeRequest({ writer_identity: 'writer-two' })),
    () => evaluateMergeEligibility(stateStale, mergeRequest({ lane: staleLane })),
    () => registerCoordinationLane(stateFresh, makeLane({ writer_identity: 'writer-two' })),
    () => registerCoordinationLane(stateFresh, makeLane({ job_id: 'int.job-b' })),
    () => recordAuditedSynchronization(stateFresh, makeLane({ lane_id: 'int-lane-z' }), 'audit'),
    () => recordAuditedSynchronization(stateFresh, makeLane({}), ''),
    () => evaluateCoordinatedOperation(stateFresh, coordinatedRequest({ boundary: 'WRITE' })),
    () => evaluateCoordinatedOperation(stateFresh, coordinatedRequest({ boundary: 'EVIDENCE', request: { operation: 'READ', resource_job_id: 'int.job-a', resource_namespace: LEDGER_NS } })),
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

  // no invented coordinator error vocabulary
  for (const forbidden of ['COORDINATOR_INVALID', 'SYNC_INVALID', 'AUDIT_INVALID', 'MERGE_NOT_ELIGIBLE']) {
    assert.ok(!COORDINATOR_SOURCE.includes(forbidden), `${forbidden} must not exist`);
    let rejected = false;
    try { new JobIsolationError(forbidden, 'x'); } catch (e) { rejected = true; }
    assert.strictEqual(rejected, true, `${forbidden} must not be constructible`);
  }

  // every error-like quoted constant in the module source is within the locked 18
  const quoted = COORDINATOR_SOURCE.match(/'[A-Z][A-Z0-9_]+'/g) || [];
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
