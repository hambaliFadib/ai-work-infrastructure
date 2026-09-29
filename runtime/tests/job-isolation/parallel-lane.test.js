/**
 * ParallelLane runtime semantics tests — JPL01-JPL35.
 *
 * Validates runtime/job-isolation/parallel-lane.js against the locked
 * governance artifacts:
 *   - governance/policies/job-isolation.json (machine policy)
 *   - governance/contracts/job-isolation-v1.md (human contract, sections 17-20)
 *
 * Covers: six required fields, missing-field rejection, lane_id
 * normalization, invalid lane_id, lane identity collision, writer ownership,
 * job rebinding, coordination checkout, baseline SHA validation, fresh and
 * stale baselines, forged synchronization assertions, independent lanes,
 * copy-safe immutability, cross-lane claims, canonical error identifiers,
 * deterministic stress, the Phase 9C boundary, same-id immutable-binding
 * mismatches, canonical-lane enforcement at every decision boundary,
 * registry canonicalization, plain-data record closure (own keys, symbols,
 * descriptors, prototypes), registry lane_id uniqueness, and export-surface
 * closure.
 *
 * No network. No DB. No env/profile access. No clock. No Git mutation.
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const lane = require('../../job-isolation/parallel-lane.js');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const MODULE_PATH = path.resolve(__dirname, '..', '..', 'job-isolation', 'parallel-lane.js');
const MODULE_SOURCE = fs.readFileSync(MODULE_PATH, 'utf8');
const policy = JSON.parse(fs.readFileSync(path.join(ROOT, 'governance', 'policies', 'job-isolation.json'), 'utf8'));

const SHA_1 = '81eb83327435d96612a8bb2db4da70426ddcc80c';
const SHA_2 = '0123456789abcdef0123456789abcdef01234567';

const LANE_ERROR_CODES = ['LANE_CONTRACT_INVALID', 'LANE_ID_COLLISION', 'LANE_OWNERSHIP_CONFLICT', 'CROSS_LANE_WRITE_REJECTED', 'COORDINATION_CHECKOUT_VIOLATION', 'STALE_MAIN_BASELINE'];
const PHASE_9C_STATES = ['NEW', 'ACTIVE', 'CHECKPOINTED', 'BLOCKED', 'INTERRUPTED', 'FAILED', 'CONFLICTED', 'MERGE_PENDING', 'RESOLVED', 'ARCHIVED'];

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

function laneInput(overrides) {
  return Object.assign({
    lane_id: 'lane-40',
    job_id: 'job-40',
    branch: 'feature/40-parallel-lane-semantics',
    worktree: '<worktree-root>/issue-40',
    writer_identity: 'writer-40',
    baseline_main_sha: SHA_1,
  }, overrides);
}

function laneInputB(overrides) {
  return Object.assign({
    lane_id: 'lane-41',
    job_id: 'job-41',
    branch: 'feature/41-namespace-derivation',
    worktree: '<worktree-root>/issue-41',
    writer_identity: 'writer-41',
    baseline_main_sha: SHA_2,
  }, overrides);
}

/** Register/reuse and cross-lane decisions for a same-id binding mismatch. */
function sameIdDecisions(overrides) {
  const target = lane.createLane(laneInput()).lane;
  const conflicting = lane.createLane(laneInput(overrides)).lane;
  const registered = lane.registerLane(lane.createLaneRegistry(), laneInput());
  return {
    register: lane.registerLane(registered.registry, laneInput(overrides)),
    claim: lane.evaluateCrossLaneClaim(conflicting, target),
    reverseClaim: lane.evaluateCrossLaneClaim(target, conflicting),
  };
}

// JPL01 — six required fields, exactly, in canonical order
test('JPL01', () => {
  assert.deepStrictEqual(lane.LANE_REQUIRED_FIELDS, ['lane_id', 'job_id', 'branch', 'worktree', 'writer_identity', 'baseline_main_sha']);
  assert.deepStrictEqual(policy.parallel_lane.required_fields, Array.from(lane.LANE_REQUIRED_FIELDS));
  const result = lane.createLane(laneInput());
  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(Object.keys(result.lane), Array.from(lane.LANE_REQUIRED_FIELDS));
});

// JPL02 — missing field rejection
test('JPL02', () => {
  for (const field of lane.LANE_REQUIRED_FIELDS) {
    const input = laneInput();
    delete input[field];
    const result = lane.createLane(input);
    assert.strictEqual(result.ok, false, `missing ${field} must fail closed`);
    assert.strictEqual(result.error, 'LANE_CONTRACT_INVALID');
  }
  for (const field of lane.LANE_REQUIRED_FIELDS) {
    const result = lane.createLane(laneInput({ [field]: '' }));
    assert.strictEqual(result.ok, false, `empty ${field} must fail closed`);
    assert.strictEqual(result.error, 'LANE_CONTRACT_INVALID');
  }
  for (const field of ['job_id', 'branch', 'worktree', 'writer_identity']) {
    const result = lane.createLane(laneInput({ [field]: 42 }));
    assert.strictEqual(result.ok, false, `non-string ${field} must fail closed`);
    assert.strictEqual(result.error, 'LANE_CONTRACT_INVALID');
  }
});

// JPL03 — lane_id normalization (NFKC, trim, lowercase)
test('JPL03', () => {
  assert.deepStrictEqual(lane.canonicalizeLaneId('  Lane-40.Alpha  '), { ok: true, lane_id: 'lane-40.alpha' });
  assert.deepStrictEqual(lane.canonicalizeLaneId('\uFF4C\uFF21\uFF2E\uFF25\uFF0D\uFF11'), { ok: true, lane_id: 'lane-1' });
  assert.deepStrictEqual(lane.canonicalizeLaneId('\uFF4C\uFF21\uFF2E\uFF25\uFF3F\uFF11'), { ok: true, lane_id: 'lane_1' });
  const created = lane.createLane(laneInput({ lane_id: '  LANE-40  ' }));
  assert.strictEqual(created.ok, true);
  assert.strictEqual(created.lane.lane_id, 'lane-40');
});

// JPL04 — invalid lane_id
test('JPL04', () => {
  const invalid = ['lane 1', '-lane', '_lane', '.lane', 'lane/1', 'lane\\1', 'lane#1', 'lane$1', 'lane@1', 'lane~1', '\u00E9', 'a'.repeat(65), '   '];
  for (const raw of invalid) {
    const result = lane.canonicalizeLaneId(raw);
    assert.strictEqual(result.ok, false, `lane_id must be rejected: ${JSON.stringify(raw)}`);
    assert.strictEqual(result.error, 'LANE_CONTRACT_INVALID');
  }
  assert.strictEqual(lane.canonicalizeLaneId('a'.repeat(64)).ok, true);
  assert.strictEqual(lane.canonicalizeLaneId(123).ok, false);
  assert.strictEqual(lane.canonicalizeLaneId(null).ok, false);
  assert.strictEqual(lane.canonicalizeLaneId(undefined).ok, false);
});

// JPL05 — lane identity collision
test('JPL05', () => {
  const first = lane.registerLane(lane.createLaneRegistry(), laneInput());
  assert.strictEqual(first.ok, true);
  assert.strictEqual(first.registry.length, 1);
  assert.ok(Object.isFrozen(first.registry));
  assert.ok(Object.isFrozen(first.registry[0]));

  // exact deterministic reuse is idempotent, never a duplicate creation;
  // the returned registry and lane are canonical frozen copies
  const exact = lane.registerLane(first.registry, laneInput());
  assert.strictEqual(exact.ok, true);
  assert.strictEqual(exact.idempotent, true);
  assert.strictEqual(exact.registry.length, 1);
  assert.ok(Object.isFrozen(exact.registry));
  assert.ok(Object.isFrozen(exact.lane));
  assert.notStrictEqual(exact.registry, first.registry);
  assert.notStrictEqual(exact.lane, first.registry[0]);
  assert.deepStrictEqual(exact.registry, first.registry);
  assert.deepStrictEqual(exact.lane, first.registry[0]);

  // same lane identity with a different immutable binding collides
  for (const overrides of [{ branch: 'feature/other' }, { worktree: '<worktree-root>/issue-99' }, { baseline_main_sha: SHA_2 }]) {
    const collision = lane.registerLane(first.registry, laneInput(overrides));
    assert.strictEqual(collision.ok, false);
    assert.strictEqual(collision.error, 'LANE_ID_COLLISION');
  }
});

// JPL06 — same writer valid
test('JPL06', () => {
  const created = lane.createLane(laneInput());
  const result = lane.evaluateOwnership(created.lane, 'writer-40');
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.lane_id, 'lane-40');
  assert.strictEqual(result.writer_identity, 'writer-40');
});

// JPL07 — different writer rejected
test('JPL07', () => {
  const created = lane.createLane(laneInput());
  const result = lane.evaluateOwnership(created.lane, 'writer-other');
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.error, 'LANE_OWNERSHIP_CONFLICT');

  const registered = lane.registerLane(lane.createLaneRegistry(), laneInput());
  const secondWriter = lane.registerLane(registered.registry, laneInput({ writer_identity: 'writer-other' }));
  assert.strictEqual(secondWriter.ok, false);
  assert.strictEqual(secondWriter.error, 'LANE_OWNERSHIP_CONFLICT');
});

// JPL08 — job rebinding rejected
test('JPL08', () => {
  const registered = lane.registerLane(lane.createLaneRegistry(), laneInput());
  const rebound = lane.registerLane(registered.registry, laneInput({ job_id: 'job-other' }));
  assert.strictEqual(rebound.ok, false);
  assert.strictEqual(rebound.error, 'LANE_ID_COLLISION');
  assert.ok(policy.canonical_errors.includes(rebound.error), 'rebinding must use an existing locked lane error');
  assert.strictEqual(policy.parallel_lane.lane_id.job_rebinding, 'FORBIDDEN');
});

// JPL09 — writer branch main rejected
test('JPL09', () => {
  const result = lane.createLane(laneInput({ branch: 'main' }));
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.error, 'COORDINATION_CHECKOUT_VIOLATION');

  // structural validity precedes the coordination constraint
  const both = lane.createLane(laneInput({ branch: 'main', baseline_main_sha: 'not-a-sha' }));
  assert.strictEqual(both.ok, false);
  assert.strictEqual(both.error, 'LANE_CONTRACT_INVALID');

  // registration fails closed as well
  const registered = lane.registerLane(lane.createLaneRegistry(), laneInput({ branch: 'main' }));
  assert.strictEqual(registered.ok, false);
  assert.strictEqual(registered.error, 'COORDINATION_CHECKOUT_VIOLATION');
});

// JPL10 — coordination main valid
test('JPL10', () => {
  const coordination = lane.evaluateCoordinationCheckout('main');
  assert.strictEqual(coordination.ok, true);
  assert.strictEqual(coordination.branch, 'main');
  const writer = lane.evaluateCoordinationCheckout('feature/40-parallel-lane-semantics');
  assert.strictEqual(writer.ok, false);
  assert.strictEqual(writer.error, 'COORDINATION_CHECKOUT_VIOLATION');
});

// JPL11 — baseline SHA validation
test('JPL11', () => {
  const invalid = ['', 'A'.repeat(40), 'g'.repeat(40), 'a'.repeat(39), 'a'.repeat(41), ` ${SHA_1}`, 12345];
  for (const sha of invalid) {
    const result = lane.createLane(laneInput({ baseline_main_sha: sha }));
    assert.strictEqual(result.ok, false, `baseline_main_sha must be rejected: ${JSON.stringify(sha)}`);
    assert.strictEqual(result.error, 'LANE_CONTRACT_INVALID');
  }
  assert.strictEqual(lane.createLane(laneInput({ baseline_main_sha: '0'.repeat(40) })).ok, true);
});

// JPL12 — fresh baseline
test('JPL12', () => {
  const created = lane.createLane(laneInput());
  const result = lane.evaluateStaleBaseline(created.lane, SHA_1);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.stale, false);
});

// JPL13 — stale baseline rejection
test('JPL13', () => {
  const created = lane.createLane(laneInput());
  const result = lane.evaluateStaleBaseline(created.lane, SHA_2);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.error, 'STALE_MAIN_BASELINE');
  assert.strictEqual(result.stale, true);
  assert.strictEqual(policy.coordination.stale_lane_is_authoritative_main, false);
});

// JPL14 — forged synchronization assertion cannot clear stale state
test('JPL14', () => {
  const created = lane.createLane(laneInput());
  const before = created.lane.baseline_main_sha;

  // a caller assertion naming the authoritative SHA cannot clear staleness
  const forged = lane.evaluateStaleBaseline(created.lane, SHA_2, { synchronized_to_sha: SHA_2 });
  assert.strictEqual(forged.ok, false);
  assert.strictEqual(forged.error, 'STALE_MAIN_BASELINE');
  assert.strictEqual(forged.stale, true);

  // any other caller-supplied assertion is equally untrusted
  for (const evidence of [undefined, null, 'synchronized', 42, {}, { synchronized_to_sha: SHA_1 }, { verified: true }]) {
    const result = lane.evaluateStaleBaseline(created.lane, SHA_2, evidence);
    assert.strictEqual(result.ok, false, `assertion must not clear staleness: ${JSON.stringify(evidence)}`);
    assert.strictEqual(result.error, 'STALE_MAIN_BASELINE');
  }

  // evaluation never mutates the original lane baseline
  assert.strictEqual(created.lane.baseline_main_sha, before);
  assert.ok(Object.isFrozen(created.lane));
});

// JPL15 — two independent lanes
test('JPL15', () => {
  const laneA = lane.createLane(laneInput());
  const laneB = lane.createLane(laneInputB());
  assert.strictEqual(laneA.ok, true);
  assert.strictEqual(laneB.ok, true);

  const registryA = lane.registerLane(lane.createLaneRegistry(), laneInput());
  const registryAB = lane.registerLane(registryA.registry, laneInputB());
  assert.strictEqual(registryAB.ok, true);
  assert.strictEqual(registryAB.registry.length, 2);
  assert.notStrictEqual(registryAB.registry[0], registryAB.registry[1]);

  assert.strictEqual(lane.evaluateOwnership(laneA.lane, 'writer-40').ok, true);
  assert.strictEqual(lane.evaluateOwnership(laneB.lane, 'writer-41').ok, true);
  assert.strictEqual(lane.evaluateStaleBaseline(laneA.lane, SHA_1).ok, true);
  assert.strictEqual(lane.evaluateStaleBaseline(laneB.lane, SHA_2).ok, true);
});

// JPL16 — no shared mutable state
test('JPL16', () => {
  const input = laneInput();
  const created = lane.createLane(input);
  assert.ok(Object.isFrozen(created.lane));

  // caller-side mutation cannot reach the canonical lane
  input.writer_identity = 'writer-evil';
  input.lane_id = 'lane-evil';
  assert.strictEqual(created.lane.writer_identity, 'writer-40');
  assert.strictEqual(created.lane.lane_id, 'lane-40');

  // independent creations never share object identity
  const second = lane.createLane(laneInput());
  assert.notStrictEqual(second.lane, created.lane);
  assert.deepStrictEqual(second.lane, created.lane);

  // frozen lanes reject mutation
  assert.throws(() => { 'use strict'; created.lane.lane_id = 'lane-evil'; }, TypeError);
  assert.strictEqual(Reflect.set(created.lane, 'lane_id', 'lane-evil'), false);

  // registration returns a new frozen registry and never mutates its input
  const empty = lane.createLaneRegistry();
  assert.ok(Object.isFrozen(empty));
  const registryA = lane.registerLane(empty, laneInput());
  assert.strictEqual(empty.length, 0);
  assert.notStrictEqual(registryA.registry, empty);
  assert.ok(Object.isFrozen(registryA.registry));

  const registryB = lane.registerLane(registryA.registry, laneInputB());
  assert.strictEqual(registryA.registry.length, 1);
  assert.strictEqual(registryB.registry.length, 2);
  assert.ok(Object.isFrozen(registryB.registry[1]));
  assert.strictEqual(Reflect.set(registryB.registry, '0', null), false);
});

// JPL17 — cross-lane claim rejection
test('JPL17', () => {
  const laneA = lane.createLane(laneInput()).lane;
  const laneB = lane.createLane(laneInputB()).lane;
  const forward = lane.evaluateCrossLaneClaim(laneA, laneB);
  assert.strictEqual(forward.ok, false);
  assert.strictEqual(forward.error, 'CROSS_LANE_WRITE_REJECTED');
  const reverse = lane.evaluateCrossLaneClaim(laneB, laneA);
  assert.strictEqual(reverse.ok, false);
  assert.strictEqual(reverse.error, 'CROSS_LANE_WRITE_REJECTED');
});

// JPL18 — same-lane claim allowed
test('JPL18', () => {
  const laneA = lane.createLane(laneInput()).lane;
  const allowed = lane.evaluateCrossLaneClaim(laneA, laneA);
  assert.strictEqual(allowed.ok, true);
  assert.strictEqual(allowed.lane_id, 'lane-40');

  // same lane identity with a different writer remains an ownership conflict
  const forged = Object.assign({}, laneA, { writer_identity: 'writer-other' });
  const conflict = lane.evaluateCrossLaneClaim(forged, laneA);
  assert.strictEqual(conflict.ok, false);
  assert.strictEqual(conflict.error, 'LANE_OWNERSHIP_CONFLICT');
});

// JPL19 — canonical error identifiers
test('JPL19', () => {
  assert.deepStrictEqual(Object.values(lane.LANE_ERRORS).slice().sort(), LANE_ERROR_CODES.slice().sort());
  for (const code of Object.values(lane.LANE_ERRORS)) {
    assert.ok(policy.canonical_errors.includes(code), `not a locked canonical error: ${code}`);
  }
  // no nineteenth canonical error is introduced
  assert.strictEqual(policy.canonical_errors.length, 18);
  assert.ok(Object.values(lane.LANE_ERRORS).length < policy.canonical_errors.length);

  // every error produced by the module belongs to the locked canonical list
  const observed = new Set();
  const observe = (result) => { if (result && result.ok === false) observed.add(result.error); return result; };
  observe(lane.createLane(null));
  observe(lane.createLane({}));
  observe(lane.createLane(laneInput({ lane_id: 'bad id' })));
  observe(lane.createLane(laneInput({ branch: 'main' })));
  const registered = lane.registerLane(lane.createLaneRegistry(), laneInput());
  observe(lane.registerLane(registered.registry, laneInput({ job_id: 'job-other' })));
  observe(lane.registerLane(registered.registry, laneInput({ writer_identity: 'writer-other' })));
  observe(lane.registerLane(registered.registry, laneInput({ branch: 'feature/other' })));
  observe(lane.evaluateOwnership(registered.lane, 'writer-other'));
  observe(lane.evaluateCrossLaneClaim(registered.lane, lane.createLane(laneInputB()).lane));
  observe(lane.evaluateCoordinationCheckout('feature/x'));
  observe(lane.evaluateStaleBaseline(registered.lane, SHA_2));
  assert.deepStrictEqual(Array.from(observed).sort(), LANE_ERROR_CODES.slice().sort());

  // policy parity for the lane-specific error bindings
  assert.strictEqual(policy.parallel_lane.lane_id.collision_error, lane.LANE_ERRORS.LANE_ID_COLLISION);
  assert.strictEqual(policy.parallel_lane.ownership_conflict_error, lane.LANE_ERRORS.LANE_OWNERSHIP_CONFLICT);
  assert.strictEqual(policy.parallel_lane.cross_lane_write_error, lane.LANE_ERRORS.CROSS_LANE_WRITE_REJECTED);
  assert.strictEqual(policy.coordination.coordination_violation_error, lane.LANE_ERRORS.COORDINATION_CHECKOUT_VIOLATION);
  assert.strictEqual(policy.coordination.stale_baseline_error, lane.LANE_ERRORS.STALE_MAIN_BASELINE);
});

// JPL20 — 100x deterministic stress
test('JPL20', () => {
  const scenario = () => {
    const created = lane.createLane(laneInput());
    const createdB = lane.createLane(laneInputB());
    const registryA = lane.registerLane(lane.createLaneRegistry(), laneInput());
    const registryAB = lane.registerLane(registryA.registry, laneInputB());
    return {
      canonicalLane: created.lane,
      registryLength: registryAB.registry.length,
      ownershipSame: lane.evaluateOwnership(created.lane, 'writer-40'),
      ownershipDifferent: lane.evaluateOwnership(created.lane, 'writer-other'),
      crossLane: lane.evaluateCrossLaneClaim(created.lane, createdB.lane),
      sameLane: lane.evaluateCrossLaneClaim(created.lane, created.lane),
      coordinationMain: lane.evaluateCoordinationCheckout('main'),
      coordinationWriter: lane.evaluateCoordinationCheckout('feature/40-parallel-lane-semantics'),
      freshBaseline: lane.evaluateStaleBaseline(created.lane, SHA_1),
      staleBaseline: lane.evaluateStaleBaseline(created.lane, SHA_2),
      forgedStale: lane.evaluateStaleBaseline(created.lane, SHA_2, { synchronized_to_sha: SHA_2 }),
      collision: lane.registerLane(registryAB.registry, laneInput({ job_id: 'job-other' })),
      errorCode: lane.createLane({}).error,
    };
  };
  const first = scenario();
  for (let i = 0; i < 100; i += 1) {
    assert.deepStrictEqual(scenario(), first, `iteration ${i} diverged`);
  }

  // no clock, randomness, or environment input may influence the result
  for (const token of ['Math.random', 'Date.now', 'new Date', 'process.env', 'process.hrtime', 'performance.now', 'child_process', 'execSync', 'require(', 'process.exit']) {
    assert.ok(!MODULE_SOURCE.includes(token), `module must not use: ${token}`);
  }
});

// JPL21 — Phase 9C states absent
test('JPL21', () => {
  assert.deepStrictEqual(policy.phase_9c.forbidden_states, PHASE_9C_STATES);
  for (const state of PHASE_9C_STATES) {
    assert.ok(!new RegExp(`\\b${state}\\b`).test(MODULE_SOURCE), `Phase 9C state leaked into module: ${state}`);
  }
  // no lifecycle/status/recovery/agent fields are accepted on a lane
  for (const field of ['status', 'state', 'lifecycle', 'recovery', 'agent', 'subagent', 'role']) {
    const result = lane.createLane(laneInput({ [field]: 'x' }));
    assert.strictEqual(result.ok, false, `unknown field must fail closed: ${field}`);
    assert.strictEqual(result.error, 'LANE_CONTRACT_INVALID');
  }
  // the canonical lane exposes exactly the six locked fields
  const created = lane.createLane(laneInput());
  assert.deepStrictEqual(Object.keys(created.lane), Array.from(lane.LANE_REQUIRED_FIELDS));
});

// JPL22 — same lane_id + same writer + different job_id rejected
test('JPL22', () => {
  const decisions = sameIdDecisions({ job_id: 'job-other' });
  assert.strictEqual(decisions.register.ok, false);
  assert.strictEqual(decisions.register.error, 'LANE_ID_COLLISION');
  assert.strictEqual(decisions.claim.ok, false);
  assert.strictEqual(decisions.claim.error, 'LANE_ID_COLLISION');
  assert.strictEqual(decisions.reverseClaim.ok, false);
  assert.strictEqual(decisions.reverseClaim.error, 'LANE_ID_COLLISION');
});

// JPL23 — same lane_id + same writer + different branch rejected
test('JPL23', () => {
  const decisions = sameIdDecisions({ branch: 'feature/other' });
  assert.strictEqual(decisions.register.ok, false);
  assert.strictEqual(decisions.register.error, 'LANE_ID_COLLISION');
  assert.strictEqual(decisions.claim.ok, false);
  assert.strictEqual(decisions.claim.error, 'LANE_ID_COLLISION');
  assert.strictEqual(decisions.reverseClaim.ok, false);
  assert.strictEqual(decisions.reverseClaim.error, 'LANE_ID_COLLISION');
});

// JPL24 — same lane_id + same writer + different worktree rejected
test('JPL24', () => {
  const decisions = sameIdDecisions({ worktree: '<worktree-root>/issue-99' });
  assert.strictEqual(decisions.register.ok, false);
  assert.strictEqual(decisions.register.error, 'LANE_ID_COLLISION');
  assert.strictEqual(decisions.claim.ok, false);
  assert.strictEqual(decisions.claim.error, 'LANE_ID_COLLISION');
  assert.strictEqual(decisions.reverseClaim.ok, false);
  assert.strictEqual(decisions.reverseClaim.error, 'LANE_ID_COLLISION');
});

// JPL25 — same lane_id + same writer + different baseline rejected
test('JPL25', () => {
  const decisions = sameIdDecisions({ baseline_main_sha: SHA_2 });
  assert.strictEqual(decisions.register.ok, false);
  assert.strictEqual(decisions.register.error, 'LANE_ID_COLLISION');
  assert.strictEqual(decisions.claim.ok, false);
  assert.strictEqual(decisions.claim.error, 'LANE_ID_COLLISION');
  assert.strictEqual(decisions.reverseClaim.ok, false);
  assert.strictEqual(decisions.reverseClaim.error, 'LANE_ID_COLLISION');
});

// JPL26 — partial lane at ownership boundary rejected
test('JPL26', () => {
  const partial = { lane_id: 'lane-40', writer_identity: 'writer-40' };
  const result = lane.evaluateOwnership(partial, 'writer-40');
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.error, 'LANE_CONTRACT_INVALID');

  const missingBaseline = laneInput();
  delete missingBaseline.baseline_main_sha;
  const fiveFields = lane.evaluateOwnership(missingBaseline, 'writer-40');
  assert.strictEqual(fiveFields.ok, false);
  assert.strictEqual(fiveFields.error, 'LANE_CONTRACT_INVALID');
});

// JPL27 — partial lane at cross-lane boundary rejected
test('JPL27', () => {
  const full = lane.createLane(laneInput()).lane;
  const partial = { lane_id: 'lane-40', writer_identity: 'writer-40' };
  const forward = lane.evaluateCrossLaneClaim(partial, full);
  assert.strictEqual(forward.ok, false);
  assert.strictEqual(forward.error, 'LANE_CONTRACT_INVALID');
  const reverse = lane.evaluateCrossLaneClaim(full, partial);
  assert.strictEqual(reverse.ok, false);
  assert.strictEqual(reverse.error, 'LANE_CONTRACT_INVALID');
});

// JPL28 — partial lane at stale-baseline boundary rejected
test('JPL28', () => {
  const partial = { lane_id: 'lane-40', writer_identity: 'writer-40', baseline_main_sha: SHA_1 };
  const result = lane.evaluateStaleBaseline(partial, SHA_1);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.error, 'LANE_CONTRACT_INVALID');
});

// JPL29 — mutable reconstructed registry canonicalized; caller mutation isolated
test('JPL29', () => {
  const rawLaneA = JSON.parse(JSON.stringify(laneInput()));
  const rawRegistry = [rawLaneA];
  assert.ok(!Object.isFrozen(rawRegistry));
  assert.ok(!Object.isFrozen(rawLaneA));

  const registered = lane.registerLane(rawRegistry, laneInputB());
  assert.strictEqual(registered.ok, true);
  assert.strictEqual(registered.registry.length, 2);
  assert.ok(Object.isFrozen(registered.registry));
  assert.ok(Object.isFrozen(registered.registry[0]));
  assert.ok(Object.isFrozen(registered.registry[1]));
  assert.notStrictEqual(registered.registry, rawRegistry);
  assert.notStrictEqual(registered.registry[0], rawLaneA);

  // caller mutation after registration cannot alter canonical registry state
  rawLaneA.writer_identity = 'writer-evil';
  rawLaneA.branch = 'feature/evil';
  rawRegistry.push(laneInput({ lane_id: 'lane-99' }));
  assert.strictEqual(registered.registry.length, 2);
  assert.strictEqual(registered.registry[0].writer_identity, 'writer-40');
  assert.strictEqual(registered.registry[0].branch, 'feature/40-parallel-lane-semantics');

  // idempotent reuse returns canonical frozen copies, never the caller array
  const rawReuse = [JSON.parse(JSON.stringify(laneInput()))];
  const reused = lane.registerLane(rawReuse, laneInput());
  assert.strictEqual(reused.ok, true);
  assert.strictEqual(reused.idempotent, true);
  assert.ok(Object.isFrozen(reused.registry));
  assert.ok(Object.isFrozen(reused.lane));
  assert.notStrictEqual(reused.registry, rawReuse);
  assert.notStrictEqual(reused.lane, rawReuse[0]);
  rawReuse[0].job_id = 'job-evil';
  rawReuse[0].writer_identity = 'writer-evil';
  assert.strictEqual(reused.registry[0].job_id, 'job-40');
  assert.strictEqual(reused.registry[0].writer_identity, 'writer-40');
  assert.strictEqual(reused.lane.job_id, 'job-40');
  assert.strictEqual(reused.lane.writer_identity, 'writer-40');
});

// JPL30 — invalid registry entries rejected
test('JPL30', () => {
  const valid = JSON.parse(JSON.stringify(laneInput()));
  const cases = [
    [{ ...valid, status: 'x' }],
    [{ lane_id: 'lane-40', writer_identity: 'writer-40' }],
    [{ ...valid, lane_id: 'Lane-40' }],
    [{ ...valid, baseline_main_sha: 'nope' }],
    [{ ...valid, branch: 'main' }],
    ['not-a-lane'],
    [null],
  ];
  for (const registry of cases) {
    const result = lane.registerLane(registry, laneInputB());
    assert.strictEqual(result.ok, false, `registry must be rejected: ${JSON.stringify(registry)}`);
    assert.strictEqual(result.error, 'LANE_CONTRACT_INVALID');
  }
});

// JPL31 — non-canonical full record rejected at evaluation boundaries
test('JPL31', () => {
  const nonCanonical = laneInput({ lane_id: 'Lane-40' });
  const full = lane.createLane(laneInput()).lane;

  assert.strictEqual(lane.evaluateOwnership(nonCanonical, 'writer-40').error, 'LANE_CONTRACT_INVALID');
  assert.strictEqual(lane.evaluateCrossLaneClaim(nonCanonical, full).error, 'LANE_CONTRACT_INVALID');
  assert.strictEqual(lane.evaluateCrossLaneClaim(full, nonCanonical).error, 'LANE_CONTRACT_INVALID');
  assert.strictEqual(lane.evaluateStaleBaseline(nonCanonical, SHA_1).error, 'LANE_CONTRACT_INVALID');

  // a record with an extra field is not a canonical lane either
  const extra = Object.assign(laneInput(), { status: 'x' });
  assert.strictEqual(lane.evaluateOwnership(extra, 'writer-40').error, 'LANE_CONTRACT_INVALID');
});

// JPL32 — non-enumerable / symbol lane extras rejected
test('JPL32', () => {
  // non-enumerable extra string key
  const hiddenExtra = laneInput();
  Object.defineProperty(hiddenExtra, 'hidden_extra', { value: 'x', enumerable: false, writable: true, configurable: true });
  const createdHidden = lane.createLane(hiddenExtra);
  assert.strictEqual(createdHidden.ok, false);
  assert.strictEqual(createdHidden.error, 'LANE_CONTRACT_INVALID');
  assert.strictEqual(lane.evaluateOwnership(hiddenExtra, 'writer-40').error, 'LANE_CONTRACT_INVALID');
  assert.strictEqual(lane.registerLane([hiddenExtra], laneInputB()).error, 'LANE_CONTRACT_INVALID');

  // symbol key (enumerable)
  const symbolExtra = laneInput();
  symbolExtra[Symbol('meta')] = 'x';
  const createdSymbol = lane.createLane(symbolExtra);
  assert.strictEqual(createdSymbol.ok, false);
  assert.strictEqual(createdSymbol.error, 'LANE_CONTRACT_INVALID');
  assert.strictEqual(lane.evaluateStaleBaseline(symbolExtra, SHA_1).error, 'LANE_CONTRACT_INVALID');

  // symbol key (non-enumerable)
  const hiddenSymbol = laneInput();
  Object.defineProperty(hiddenSymbol, Symbol('hidden'), { value: 'x', enumerable: false });
  assert.strictEqual(lane.createLane(hiddenSymbol).error, 'LANE_CONTRACT_INVALID');
});

// JPL33 — custom prototype and accessor-backed lane rejected; getter not invoked
test('JPL33', () => {
  class FakeLane {
    constructor() { Object.assign(this, laneInput()); }
  }
  const classed = new FakeLane();
  assert.strictEqual(lane.createLane(classed).error, 'LANE_CONTRACT_INVALID');
  assert.strictEqual(lane.evaluateOwnership(classed, 'writer-40').error, 'LANE_CONTRACT_INVALID');
  assert.strictEqual(lane.evaluateCrossLaneClaim(classed, classed).error, 'LANE_CONTRACT_INVALID');

  // accessor-backed field: no getter may ever run
  let getterCalls = 0;
  const accessor = laneInput();
  Object.defineProperty(accessor, 'lane_id', {
    get() { getterCalls += 1; return 'lane-40'; },
    enumerable: true,
    configurable: true,
  });
  const createdAccessor = lane.createLane(accessor);
  assert.strictEqual(createdAccessor.ok, false);
  assert.strictEqual(createdAccessor.error, 'LANE_CONTRACT_INVALID');
  assert.strictEqual(lane.evaluateStaleBaseline(accessor, SHA_1).error, 'LANE_CONTRACT_INVALID');
  assert.strictEqual(lane.evaluateCrossLaneClaim(accessor, accessor).error, 'LANE_CONTRACT_INVALID');
  assert.strictEqual(getterCalls, 0, 'accessor getter must never be invoked');

  // getter/setter pair: neither accessor may ever run
  let accessorCalls = 0;
  const accessorPair = laneInput();
  Object.defineProperty(accessorPair, 'job_id', {
    get() { accessorCalls += 1; return 'job-40'; },
    set() { accessorCalls += 1; },
    enumerable: true,
    configurable: true,
  });
  assert.strictEqual(lane.createLane(accessorPair).error, 'LANE_CONTRACT_INVALID');
  assert.strictEqual(accessorCalls, 0, 'accessor accessors must never be invoked');
});

// JPL34 — duplicate registry lane_id rejected (including exact duplicate)
test('JPL34', () => {
  const entry = JSON.parse(JSON.stringify(laneInput()));

  // exact duplicate lane_id
  const exact = lane.registerLane([entry, JSON.parse(JSON.stringify(laneInput()))], laneInputB());
  assert.strictEqual(exact.ok, false);
  assert.strictEqual(exact.error, 'LANE_ID_COLLISION');

  // duplicate same-ID/different-writer
  const conflicting = lane.registerLane([entry, laneInput({ writer_identity: 'writer-other' })], laneInputB());
  assert.strictEqual(conflicting.ok, false);
  assert.strictEqual(conflicting.error, 'LANE_OWNERSHIP_CONFLICT');

  // duplicate same-ID/different-binding (same writer)
  const rebound = lane.registerLane([entry, laneInput({ job_id: 'job-other' })], laneInputB());
  assert.strictEqual(rebound.ok, false);
  assert.strictEqual(rebound.error, 'LANE_ID_COLLISION');

  // a UNIQUE canonical registry plus an equal candidate remains idempotent
  const unique = lane.registerLane([JSON.parse(JSON.stringify(laneInput()))], laneInput());
  assert.strictEqual(unique.ok, true);
  assert.strictEqual(unique.idempotent, true);
});

// JPL35 — unsafe raw lookup surface removed (no public findLane bypass)
test('JPL35', () => {
  assert.strictEqual(Object.prototype.hasOwnProperty.call(lane, 'findLane'), false);
  assert.strictEqual(typeof lane.findLane, 'undefined');
  assert.deepStrictEqual(Object.keys(lane).slice().sort(), [
    'LANE_ERRORS',
    'LANE_REQUIRED_FIELDS',
    'canonicalizeLaneId',
    'createLane',
    'createLaneRegistry',
    'evaluateCoordinationCheckout',
    'evaluateCrossLaneClaim',
    'evaluateOwnership',
    'evaluateStaleBaseline',
    'registerLane',
  ].sort());
});

console.log('');
console.log(`Cases: ${passed + failed}`);
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);

process.exit(failed > 0 ? 1 : 0);
