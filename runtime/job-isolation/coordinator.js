/**
 * Job Isolation v1 — Main Coordination Integration (#41 / 9B-05).
 *
 * The single composition layer for Phase 9B. It composes the existing runtime
 * authorities — JobContract core (#38), ParallelLane semantics (#40),
 * namespace isolation (#39), and knowledge-scope read eligibility (#39) —
 * into one deterministic integration boundary:
 *
 *   - main coordination authority state (main-only coordination checkout +
 *     authoritative main SHA), module-produced and non-forgeable from plain
 *     caller data, carrying an authoritative active lane registry;
 *   - an explicit pure lane-registration transition into that registry;
 *   - explicit + audited synchronization recognition for stale lane
 *     baselines (the rule locked as intentional_synchronization =
 *     EXPLICIT_AND_AUDITED by job-isolation@1.0.0);
 *   - lane/main merge-eligibility evaluation;
 *   - end-to-end coordinated operation dispatch to the existing namespace /
 *     knowledge boundaries.
 *
 * Integration only: this module adds no Job Isolation business semantics.
 * It never replaces, reimplements, or reinterprets the modules it composes:
 * contract validation, lane validation/ownership/staleness/registry
 * decisions, namespace access, and knowledge eligibility outcomes all come
 * from the existing authorities and are propagated unchanged.
 *
 * Trust boundaries (fail closed):
 *   - coordinator state is accepted as authority ONLY when produced by this
 *     module (module-private brand registry). Raw lookalike objects, JSON
 *     clones, and caller-added "verified"/"trusted" flags never grant
 *     authority; untrusted authority fails closed with
 *     COORDINATION_CHECKOUT_VIOLATION. The brand registry carries trust
 *     only — all semantic state (coordination branch, authoritative main
 *     SHA, authoritative lane registry, synchronizations) lives in the
 *     frozen, inspectable returned state;
 *   - the authoritative active lane registry is carried in coordinator
 *     state; lanes enter it ONLY through the explicit
 *     registerCoordinationLane transition. Merge eligibility and
 *     synchronization recording require an already-registered exact lane
 *     and never auto-register. A temporary empty registry is used solely as
 *     a local structural/canonicalization adapter and never decides
 *     ownership persistence;
 *   - every public request descriptor is a strict plain data record
 *     (Object.prototype or null prototype) with exactly the locked own keys;
 *     unknown, hidden, or symbol keys, accessor-backed properties, and
 *     custom prototypes fail closed with LANE_CONTRACT_INVALID; accessor
 *     functions never execute during validation;
 *   - synchronization records derive lane_id, job_id, from_main_sha, and
 *     to_main_sha from the authoritative registered lane plus trusted state
 *     — never from caller fields; a raw synchronization lookalike never
 *     clears staleness;
 *   - foreign contract/lane job mismatch is rejected before writer
 *     ownership is evaluated; writer identity is irrelevant once lane and
 *     contract jobs differ;
 *   - ParallelLane records are never mutated: intentional synchronization is
 *     represented as coordinator audit state only.
 *
 * Not provided (explicitly out of scope): execution authorization, approval
 * tokens, automatic Git synchronization, automatic merge, job scheduling,
 * agent delegation, network dependency coordination, and any lifecycle state
 * machine (Phase 9C). The approval gate and safe mode remain authoritative;
 * a merge-eligibility decision authorizes nothing.
 *
 * Properties: pure and deterministic — no Git mutation, no branch switching,
 * no filesystem mutation, no network, no wall clock, no randomness, no
 * environment reads. All outputs are frozen and copy-safe.
 *
 * Scope boundary: main coordination integration only. No JobContract change,
 * no namespace derivation change, no namespace isolation change, no
 * knowledge-scope change, no ParallelLane behavior change, no Phase 9B
 * acceptance execution (#42), no lifecycle state semantics (Phase 9C), no
 * new canonical errors, no policy version bump.
 */

'use strict';

const { JobIsolationError, POLICY } = require('./namespace-derivation.js');
const { validateJobContract } = require('./job-contract.js');
const {
  createLaneRegistry,
  registerLane,
  evaluateOwnership,
  evaluateCoordinationCheckout,
  evaluateStaleBaseline,
} = require('./parallel-lane.js');
const {
  evaluateSessionAccess,
  evaluateEvidenceAccess,
  evaluateLedgerAccess,
  evaluateRuntimeStateAccess,
  evaluateRuntimeStateCleanup,
} = require('./namespace-isolation.js');
const { evaluateKnowledgeReadEligibility } = require('./knowledge-scope.js');

/** Locked coordinated operation boundaries (exact). */
const COORDINATED_BOUNDARIES = Object.freeze([
  'SESSION',
  'KNOWLEDGE_READ',
  'EVIDENCE',
  'LEDGER',
  'RUNTIME_STATE',
  'RUNTIME_STATE_CLEANUP',
]);

/** Main coordination state input fields (locked, exact). */
const STATE_INPUT_FIELDS = Object.freeze([
  'coordination_branch',
  'authoritative_main_sha',
]);

/** Merge-eligibility request fields (locked, exact). */
const MERGE_REQUEST_FIELDS = Object.freeze([
  'contract',
  'lane',
  'writer_identity',
]);

/** Coordinated operation request fields (locked, exact). */
const COORDINATED_REQUEST_FIELDS = Object.freeze([
  'contract',
  'lane',
  'writer_identity',
  'boundary',
  'request',
]);

/** Authoritative main SHA shape, read from the machine policy (no second literal source). */
const MAIN_SHA_PATTERN = new RegExp(POLICY.parallel_lane.baseline_main_sha.pattern);

/**
 * Module-private brand registry for coordination authority state. Membership
 * is granted ONLY by this module when it constructs a state; it carries
 * trust branding only — no semantic state is hidden here. Plain lookalike
 * objects, JSON clones, and caller-added flags never become members.
 */
const TRUSTED_COORDINATOR_STATES = new WeakSet();

/**
 * Structural integration failure: the descriptor cannot be interpreted by the
 * coordination boundary. Uses the existing locked structural lane mapping
 * (LANE_CONTRACT_INVALID); no new canonical error is introduced.
 */
function structuralFailure(message) {
  throw new JobIsolationError('LANE_CONTRACT_INVALID', message);
}

/**
 * A plain data record: a non-array object whose prototype is
 * Object.prototype or null. Class instances and any other custom prototype
 * are rejected — they could smuggle behavior into structural validation.
 */
function isPlainDataRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Read exactly the locked own keys from an untrusted descriptor as data
 * values. Every own key — enumerable, non-enumerable, or symbol — is
 * inspected; accessor-backed fields are rejected by descriptor inspection
 * before any value is read, so caller-controlled getters never execute and
 * descriptors are never normalized or repaired.
 */
function readExactFields(record, fields, label) {
  if (!isPlainDataRecord(record)) {
    structuralFailure(`${label} must be a plain data record`);
  }
  const ownKeys = Reflect.ownKeys(record);
  if (ownKeys.length !== fields.length) {
    structuralFailure(`${label} must contain exactly the locked fields`);
  }
  for (const key of ownKeys) {
    if (typeof key !== 'string' || !fields.includes(key)) {
      structuralFailure(`${label} contains an unknown field: ${String(key)}`);
    }
  }
  const values = {};
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(record, field);
    if (descriptor === undefined || 'get' in descriptor || 'set' in descriptor) {
      structuralFailure(`${label} field must be an ordinary data property: ${field}`);
    }
    values[field] = descriptor.value;
  }
  return values;
}

/**
 * Produce a frozen, copy-safe trusted coordination state and brand it as
 * module-produced authority. The lane registry and synchronization records
 * are frozen; the caller receives no mutable references. All semantic state
 * is carried in the returned object — nothing authoritative is hidden.
 */
function createTrustedState(coordinationBranch, authoritativeMainSha, laneRegistry, synchronizations) {
  const state = Object.freeze({
    coordination_branch: coordinationBranch,
    authoritative_main_sha: authoritativeMainSha,
    lane_registry: Object.freeze(laneRegistry.slice()),
    synchronizations: Object.freeze(synchronizations.slice()),
  });
  TRUSTED_COORDINATOR_STATES.add(state);
  return state;
}

/**
 * Validate that the supplied coordination state is module-produced authority.
 * Untrusted (raw lookalike / JSON clone / caller-flagged) state fails closed
 * with the existing canonical coordination error.
 */
function assertTrustedState(state) {
  if (state === null || typeof state !== 'object' || !TRUSTED_COORDINATOR_STATES.has(state)) {
    throw new JobIsolationError('COORDINATION_CHECKOUT_VIOLATION', 'Coordinator authority state must be module-produced');
  }
  return state;
}

/**
 * Local structural/canonicalization adapter ONLY. Produces a canonical frozen
 * lane copy for job-boundary comparison, using a throwaway empty registry.
 * The throwaway registry is NOT active lane authority: it never decides
 * ownership persistence, is never returned, and never replaces coordinator
 * state's authoritative lane registry. Lane structural errors propagate
 * unchanged from the existing ParallelLane authority.
 */
function canonicalizeLaneForComparison(lane) {
  const scratchRegistry = createLaneRegistry();
  const registered = registerLane(scratchRegistry, lane);
  if (!registered.ok) {
    throw new JobIsolationError(registered.error, 'Lane rejected by the ParallelLane authority');
  }
  return registered.lane;
}

/**
 * Require the canonical lane to be present EXACTLY in the authoritative
 * coordinator lane registry. Uses the existing registerLane comparison
 * behavior; no ParallelLane rules are duplicated:
 *
 * - exact registered lane: idempotent match -> return the authoritative lane;
 * - same lane_id with a different writer: LANE_OWNERSHIP_CONFLICT (propagated);
 * - same lane_id with a different job/branch/worktree/baseline:
 *   LANE_ID_COLLISION (propagated);
 * - lane_id absent from the authoritative registry: LANE_CONTRACT_INVALID
 *   (the integration structural mapping) — merge evaluation and
 *   synchronization recording never auto-register.
 */
function requireRegisteredLane(state, lane) {
  const registered = registerLane(state.lane_registry, lane);
  if (!registered.ok) {
    throw new JobIsolationError(registered.error, 'Lane registration rejected by the ParallelLane authority');
  }
  if (registered.idempotent !== true) {
    throw new JobIsolationError('LANE_CONTRACT_INVALID', 'Lane is not present in the authoritative coordinator lane registry');
  }
  return registered.lane;
}

/**
 * Find the coordinator-produced audited synchronization record matching a
 * canonical lane and the trusted authoritative main SHA. Exact match on
 * lane_id, job_id, from_main_sha, and to_main_sha. Returns the frozen record
 * or null.
 */
function findSynchronization(state, lane) {
  for (const record of state.synchronizations) {
    if (
      record.lane_id === lane.lane_id
      && record.job_id === lane.job_id
      && record.from_main_sha === lane.baseline_main_sha
      && record.to_main_sha === state.authoritative_main_sha
    ) {
      return record;
    }
  }
  return null;
}

/** Frozen merge-eligibility decision (an eligibility statement, never an authorization). */
function mergeDecision(lane, authoritativeMainSha, synchronized, auditRef) {
  return Object.freeze({
    merge_eligible: true,
    lane_id: lane.lane_id,
    job_id: lane.job_id,
    authoritative_main_sha: authoritativeMainSha,
    synchronized,
    audit_ref: auditRef,
  });
}

/**
 * Create module-produced main coordination authority state.
 *
 * Input (locked, exact): coordination_branch, authoritative_main_sha. A
 * caller-supplied lane registry is not accepted at construction; the
 * authoritative lane registry begins empty and grows only through the
 * explicit registerCoordinationLane transition.
 *
 * - coordination_branch must pass the existing ParallelLane coordination
 *   checkout validation: 'main' is valid; any other string fails closed with
 *   COORDINATION_CHECKOUT_VIOLATION; non-string/empty fails closed with
 *   LANE_CONTRACT_INVALID (propagated unchanged);
 * - authoritative_main_sha must match the machine policy's locked main-SHA
 *   pattern (POLICY.parallel_lane.baseline_main_sha.pattern); a malformed
 *   SHA fails closed with LANE_CONTRACT_INVALID.
 *
 * The returned state is frozen, copy-safe, and branded as module-produced
 * authority: { coordination_branch, authoritative_main_sha, lane_registry,
 * synchronizations }. No timestamp, no generated ID.
 */
function createMainCoordinationState(input) {
  const fields = readExactFields(input, STATE_INPUT_FIELDS, 'Main coordination state input');

  const checkout = evaluateCoordinationCheckout(fields.coordination_branch);
  if (!checkout.ok) {
    throw new JobIsolationError(checkout.error, 'Coordination checkout rejected by the ParallelLane authority');
  }

  const sha = fields.authoritative_main_sha;
  if (typeof sha !== 'string' || !MAIN_SHA_PATTERN.test(sha)) {
    throw new JobIsolationError('LANE_CONTRACT_INVALID', 'authoritative_main_sha does not match the locked main-SHA pattern');
  }

  return createTrustedState(checkout.branch, sha, [], []);
}

/**
 * Pure state transition: register a lane into the authoritative coordinator
 * lane registry.
 *
 * - coordinatorState must be module-produced authority;
 * - the existing ParallelLane registerLane behavior decides everything:
 *   new lane_id registers; an exact canonical lane is idempotent; a same
 *   lane_id with a different writer is LANE_OWNERSHIP_CONFLICT; a same
 *   lane_id with a different job/branch/worktree/baseline is
 *   LANE_ID_COLLISION — all propagated unchanged;
 * - the supplied coordinator state is never mutated; synchronizations are
 *   preserved unchanged; the returned NEW trusted frozen state carries the
 *   canonical registry returned by the ParallelLane authority.
 */
function registerCoordinationLane(coordinatorState, lane) {
  const state = assertTrustedState(coordinatorState);
  const registered = registerLane(state.lane_registry, lane);
  if (!registered.ok) {
    throw new JobIsolationError(registered.error, 'Lane registration rejected by the ParallelLane authority');
  }
  return createTrustedState(state.coordination_branch, state.authoritative_main_sha, registered.registry, state.synchronizations);
}

/**
 * Pure state transition: record an explicit + audited synchronization of a
 * registered lane baseline to the current authoritative main SHA.
 *
 * - coordinatorState must be module-produced authority;
 * - lane is structurally canonicalized, then must already be present EXACTLY
 *   in the authoritative coordinator lane registry; an unregistered lane
 *   fails closed with LANE_CONTRACT_INVALID and a registry collision
 *   propagates its exact existing error — synchronization recording is never
 *   an implicit registration path;
 * - audit_ref is a required non-empty opaque caller-supplied external audit
 *   reference (not a credential, not a timestamp, not generated here);
 * - lane_id, job_id, from_main_sha (= registered lane baseline), and
 *   to_main_sha (= state.authoritative_main_sha) are DERIVED by this module
 *   and can never be supplied by the caller;
 * - the ParallelLane record is never mutated and the lane registry is
 *   preserved byte-equivalently; the original state is never mutated (pure
 *   transition returning a new trusted state);
 * - at most one synchronization identity (lane_id, job_id, from_main_sha,
 *   to_main_sha) is recorded: an exact repeat with the same audit_ref is
 *   idempotent; the same identity with a different audit_ref fails closed
 *   with LANE_ID_COLLISION (audit provenance is never overwritten).
 */
function recordAuditedSynchronization(coordinatorState, lane, auditRef) {
  const state = assertTrustedState(coordinatorState);
  const canonicalLane = canonicalizeLaneForComparison(lane);
  const authoritativeLane = requireRegisteredLane(state, canonicalLane);

  if (typeof auditRef !== 'string' || auditRef.length === 0) {
    throw new JobIsolationError('LANE_CONTRACT_INVALID', 'audit_ref must be a non-empty string');
  }

  const record = Object.freeze({
    lane_id: authoritativeLane.lane_id,
    job_id: authoritativeLane.job_id,
    from_main_sha: authoritativeLane.baseline_main_sha,
    to_main_sha: state.authoritative_main_sha,
    audit_ref: auditRef,
  });

  let existing = null;
  for (const candidate of state.synchronizations) {
    if (
      candidate.lane_id === record.lane_id
      && candidate.job_id === record.job_id
      && candidate.from_main_sha === record.from_main_sha
      && candidate.to_main_sha === record.to_main_sha
    ) {
      existing = candidate;
      break;
    }
  }

  if (existing !== null) {
    if (existing.audit_ref === record.audit_ref) {
      return createTrustedState(state.coordination_branch, state.authoritative_main_sha, state.lane_registry, state.synchronizations);
    }
    throw new JobIsolationError('LANE_ID_COLLISION', 'Synchronization identity already recorded with a different audit_ref');
  }

  return createTrustedState(state.coordination_branch, state.authoritative_main_sha, state.lane_registry, state.synchronizations.concat([record]));
}

/**
 * Evaluate lane/main merge eligibility for a canonical JobContract + lane +
 * writer. Integration precedence (composition order only; the global
 * normative Job Isolation validation precedence is unchanged):
 *
 *   1. validate coordinator authority (module-produced state only);
 *   2. validate canonical JobContract (existing authority; errors propagate);
 *   3. structurally canonicalize the lane safely (local adapter);
 *   4. verify lane.job_id === contract.job_id — the foreign-job boundary is
 *      evaluated BEFORE writer ownership, and writer identity is irrelevant
 *      once lane and contract jobs differ (mismatch: FOREIGN_JOB_REJECT);
 *   5. require the lane to be present exactly in the authoritative
 *      coordinator lane registry (unregistered: LANE_CONTRACT_INVALID;
 *      collision/ownership: propagated unchanged; no auto-registration);
 *   6. verify writer ownership (existing evaluateOwnership);
 *   7. evaluate the lane baseline against authoritative main;
 *   8. if stale, require a matching coordinator-produced audited
 *      synchronization record; otherwise STALE_MAIN_BASELINE (a stale lane
 *      is never authoritative main; no automatic synchronization exists);
 *   9. return a frozen merge-eligibility decision.
 *
 * The decision is an eligibility statement only: it is NOT execution
 * authorization and never implies approval.
 */
function evaluateMergeEligibility(coordinatorState, request) {
  const state = assertTrustedState(coordinatorState);
  const fields = readExactFields(request, MERGE_REQUEST_FIELDS, 'Merge eligibility request');

  const contract = validateJobContract(fields.contract);
  const candidateLane = canonicalizeLaneForComparison(fields.lane);

  if (candidateLane.job_id !== contract.job_id) {
    throw new JobIsolationError('FOREIGN_JOB_REJECT', 'Lane job does not own this JobContract');
  }

  const lane = requireRegisteredLane(state, candidateLane);

  const ownership = evaluateOwnership(lane, fields.writer_identity);
  if (!ownership.ok) {
    throw new JobIsolationError(ownership.error, 'Lane ownership rejected by the ParallelLane authority');
  }

  const freshness = evaluateStaleBaseline(lane, state.authoritative_main_sha);
  if (freshness.ok) {
    return mergeDecision(lane, state.authoritative_main_sha, false, null);
  }
  if (freshness.error !== 'STALE_MAIN_BASELINE') {
    throw new JobIsolationError(freshness.error, 'Baseline evaluation rejected by the ParallelLane authority');
  }

  const record = findSynchronization(state, lane);
  if (record === null) {
    throw new JobIsolationError('STALE_MAIN_BASELINE', 'Stale lane baseline is not authoritative main');
  }
  return mergeDecision(lane, state.authoritative_main_sha, true, record.audit_ref);
}

/**
 * Fixed internal dispatch table. Caller-supplied strings are validated
 * against the locked boundary enum before lookup; there is no dynamic
 * handler resolution and no arbitrary function injection.
 */
const BOUNDARY_DISPATCH = Object.freeze({
  SESSION: (contract, request) => evaluateSessionAccess(contract, request),
  KNOWLEDGE_READ: (contract, request) => evaluateKnowledgeReadEligibility(contract, request),
  EVIDENCE: (contract, request) => evaluateEvidenceAccess(contract, request),
  LEDGER: (contract, request) => evaluateLedgerAccess(contract, request),
  RUNTIME_STATE: (contract, request) => evaluateRuntimeStateAccess(contract, request),
  RUNTIME_STATE_CLEANUP: (contract, request) => evaluateRuntimeStateCleanup(contract, request),
});

/**
 * Evaluate one coordinated operation end to end.
 *
 * Request (locked, exact): contract, lane, writer_identity, boundary, request.
 *
 * Order (locked): merge eligibility is evaluated first; only a merge-eligible
 * (and therefore already-registered) lane may reach the boundary dispatch.
 * The dispatched evaluator receives the request unchanged and its exact
 * decision / canonical error semantics are preserved (no wrapping, no
 * translation). If merge eligibility fails, the boundary evaluator never
 * executes.
 *
 * The returned integration result is frozen:
 * { boundary, merge_eligibility, decision }.
 */
function evaluateCoordinatedOperation(coordinatorState, request) {
  const state = assertTrustedState(coordinatorState);
  const fields = readExactFields(request, COORDINATED_REQUEST_FIELDS, 'Coordinated operation request');

  const eligibility = evaluateMergeEligibility(state, {
    contract: fields.contract,
    lane: fields.lane,
    writer_identity: fields.writer_identity,
  });

  const boundary = fields.boundary;
  if (typeof boundary !== 'string' || !COORDINATED_BOUNDARIES.includes(boundary)) {
    structuralFailure('Coordinated operation boundary is not a canonical boundary');
  }

  const decision = BOUNDARY_DISPATCH[boundary](fields.contract, fields.request);

  return Object.freeze({
    boundary,
    merge_eligibility: eligibility,
    decision,
  });
}

module.exports = Object.freeze({
  COORDINATED_BOUNDARIES,
  createMainCoordinationState,
  registerCoordinationLane,
  recordAuditedSynchronization,
  evaluateMergeEligibility,
  evaluateCoordinatedOperation,
});
