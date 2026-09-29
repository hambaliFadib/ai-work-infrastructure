/**
 * ParallelLane v1 — pure lane semantics for job-isolation@1.0.0.
 *
 * Implements ONLY the locked ParallelLane semantics from
 * governance/contracts/job-isolation-v1.md (sections 17-20):
 * structural validation, lane identity, lane ownership, cross-lane claims,
 * coordination checkout validation, and stale main baseline detection.
 *
 * Trust boundaries (fail closed):
 * - every evaluation boundary (ownership, cross-lane claim, stale baseline)
 *   validates its inputs as FULL canonical six-field PLAIN DATA lane records;
 *   partial, accessor-backed, symbol-keyed, hidden-keyed, or custom-prototype
 *   records fail closed with LANE_CONTRACT_INVALID and never receive a success
 *   decision;
 * - registry inputs are validated entry-by-entry, must contain at most one
 *   entry per canonical lane_id (duplicate identities fail closed), and are
 *   canonicalized into frozen copies; caller-owned mutable arrays or lane
 *   objects are never returned and never become canonical registry state;
 * - stale baseline DETECTION ONLY: equality decides freshness. No
 *   caller-supplied synchronization assertion can clear staleness. Trusted,
 *   audited synchronization recognition is deferred to the coordination
 *   integration lane (9B-05 / #41) rather than trusting caller assertions.
 *
 * Properties:
 * - pure and deterministic: no wall clock, no randomness, no environment input;
 * - no Git mutation of any kind (no checkout, no branch switch, no commit);
 * - no filesystem access, no network, no child processes;
 * - every failure returns a canonical UPPER_SNAKE error identifier from the
 *   locked job-isolation@1.0.0 canonical error list;
 * - all returned structures are frozen and copy-safe; inputs are never mutated.
 *
 * Not implemented here (explicitly out of scope):
 * - JobContract core validation (9B-02 JobContract Runtime Core / #38);
 * - namespace derivation and namespace enforcement;
 * - trusted/audited synchronization recognition (coordination integration lane);
 * - recovery/resume state transitions (Phase 9C);
 * - any approval-system behavior.
 */

'use strict';

/** Canonical ParallelLane v1 fields, in canonical order. Exactly these six. */
const LANE_REQUIRED_FIELDS = Object.freeze([
  'lane_id',
  'job_id',
  'branch',
  'worktree',
  'writer_identity',
  'baseline_main_sha',
]);

/**
 * Canonical error identifiers used by ParallelLane semantics.
 * All six are locked by job-isolation@1.0.0; no further error is introduced.
 */
const LANE_ERRORS = Object.freeze({
  LANE_CONTRACT_INVALID: 'LANE_CONTRACT_INVALID',
  LANE_ID_COLLISION: 'LANE_ID_COLLISION',
  LANE_OWNERSHIP_CONFLICT: 'LANE_OWNERSHIP_CONFLICT',
  CROSS_LANE_WRITE_REJECTED: 'CROSS_LANE_WRITE_REJECTED',
  COORDINATION_CHECKOUT_VIOLATION: 'COORDINATION_CHECKOUT_VIOLATION',
  STALE_MAIN_BASELINE: 'STALE_MAIN_BASELINE',
});

const LANE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MAIN_SHA_PATTERN = /^[0-9a-f]{40}$/;
const COORDINATION_BRANCH = 'main';

/** Frozen success envelope. */
function pass(values) {
  return Object.freeze(Object.assign({ ok: true }, values));
}

/** Frozen fail-closed envelope carrying a canonical error identifier. */
function reject(error, extra) {
  return Object.freeze(Object.assign({ ok: false, error }, extra));
}

/**
 * Read the six canonical fields from an untrusted record.
 *
 * The record must be plain data:
 * - a plain object (Object.prototype or null prototype) — custom class
 *   prototypes are rejected;
 * - exactly the six canonical own keys (Reflect.ownKeys): no unknown string
 *   keys (enumerable or non-enumerable), no symbol keys;
 * - every required field is an ordinary own DATA property; accessor-backed
 *   fields are rejected before any getter could run;
 * - no descriptor or prototype repair is attempted; violations fail closed.
 *
 * Returns { ok: true, fields } (fresh field map) or LANE_CONTRACT_INVALID.
 */
function readCanonicalFields(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return reject(LANE_ERRORS.LANE_CONTRACT_INVALID);
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    return reject(LANE_ERRORS.LANE_CONTRACT_INVALID);
  }
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== LANE_REQUIRED_FIELDS.length) {
    return reject(LANE_ERRORS.LANE_CONTRACT_INVALID);
  }
  for (const key of ownKeys) {
    if (typeof key !== 'string' || !LANE_REQUIRED_FIELDS.includes(key)) {
      return reject(LANE_ERRORS.LANE_CONTRACT_INVALID);
    }
  }
  const fields = {};
  for (const field of LANE_REQUIRED_FIELDS) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined) {
      return reject(LANE_ERRORS.LANE_CONTRACT_INVALID);
    }
    fields[field] = descriptor.value;
  }
  return pass({ fields });
}

/**
 * Canonicalize a raw lane_id: NFKC, trim, lowercase, then structural pattern.
 * Invalid structure fails closed with LANE_CONTRACT_INVALID.
 * Never generates an identifier (no wall clock, no randomness).
 *
 * This normalization applies to CREATION only. Evaluation of an already-created
 * lane requires an already-canonical lane_id; see validateCanonicalLane.
 */
function canonicalizeLaneId(raw) {
  if (typeof raw !== 'string') return reject(LANE_ERRORS.LANE_CONTRACT_INVALID);
  const laneId = raw.normalize('NFKC').trim().toLowerCase();
  if (!LANE_ID_PATTERN.test(laneId)) return reject(LANE_ERRORS.LANE_CONTRACT_INVALID);
  return pass({ lane_id: laneId });
}

/**
 * Create a canonical frozen ParallelLane from untrusted input.
 *
 * Structural validity (fail-closed, LANE_CONTRACT_INVALID):
 * - exactly the six canonical fields; unknown fields fail closed
 *   (this is how lifecycle/status/recovery/agent fields are excluded);
 * - all six fields present;
 * - lane_id canonicalized (NFKC, trim, lowercase, pattern);
 * - job_id, branch, worktree, writer_identity are non-empty runtime strings;
 * - baseline_main_sha matches ^[0-9a-f]{40}$.
 *
 * Coordination constraint (fail-closed, COORDINATION_CHECKOUT_VIOLATION):
 * - a writer-lane branch must never be the coordination branch (main).
 *
 * job_id is treated as an already-canonicalized job binding; full JobContract
 * validation belongs to the JobContract core and is NOT reimplemented here.
 * No Git mutation is performed.
 */
function createLane(input) {
  const record = readCanonicalFields(input);
  if (!record.ok) return record;
  const fields = record.fields;

  const laneId = canonicalizeLaneId(fields.lane_id);
  if (!laneId.ok) return laneId;

  for (const field of ['job_id', 'branch', 'worktree', 'writer_identity']) {
    const value = fields[field];
    if (typeof value !== 'string' || value.length === 0) {
      return reject(LANE_ERRORS.LANE_CONTRACT_INVALID);
    }
  }

  const baselineMainSha = fields.baseline_main_sha;
  if (typeof baselineMainSha !== 'string' || !MAIN_SHA_PATTERN.test(baselineMainSha)) {
    return reject(LANE_ERRORS.LANE_CONTRACT_INVALID);
  }

  if (fields.branch === COORDINATION_BRANCH) {
    return reject(LANE_ERRORS.COORDINATION_CHECKOUT_VIOLATION);
  }

  return pass({
    lane: Object.freeze({
      lane_id: laneId.lane_id,
      job_id: fields.job_id,
      branch: fields.branch,
      worktree: fields.worktree,
      writer_identity: fields.writer_identity,
      baseline_main_sha: baselineMainSha,
    }),
  });
}

/** Create an empty frozen lane registry. */
function createLaneRegistry() {
  return Object.freeze([]);
}

/**
 * Canonical lane validator for ALREADY-CREATED lane records.
 *
 * Requires a full canonical six-field record and NEVER silently normalizes:
 * - exactly the six canonical fields (partial and extended records fail);
 * - lane_id already canonical (NFKC/trim/lowercase stable) and pattern-valid;
 * - job_id, branch, worktree, writer_identity non-empty strings;
 * - baseline_main_sha matches ^[0-9a-f]{40}$;
 * - branch is not the coordination branch (main).
 *
 * Any violation fails closed with LANE_CONTRACT_INVALID.
 * On success returns a frozen canonical COPY of the record.
 */
function validateCanonicalLane(value) {
  const record = readCanonicalFields(value);
  if (!record.ok) return record;
  const fields = record.fields;

  if (typeof fields.lane_id !== 'string') return reject(LANE_ERRORS.LANE_CONTRACT_INVALID);
  const canonicalLaneId = fields.lane_id.normalize('NFKC').trim().toLowerCase();
  if (fields.lane_id !== canonicalLaneId || !LANE_ID_PATTERN.test(fields.lane_id)) {
    return reject(LANE_ERRORS.LANE_CONTRACT_INVALID);
  }

  for (const field of ['job_id', 'branch', 'worktree', 'writer_identity']) {
    if (typeof fields[field] !== 'string' || fields[field].length === 0) {
      return reject(LANE_ERRORS.LANE_CONTRACT_INVALID);
    }
  }

  if (typeof fields.baseline_main_sha !== 'string' || !MAIN_SHA_PATTERN.test(fields.baseline_main_sha)) {
    return reject(LANE_ERRORS.LANE_CONTRACT_INVALID);
  }

  if (fields.branch === COORDINATION_BRANCH) {
    return reject(LANE_ERRORS.LANE_CONTRACT_INVALID);
  }

  return pass({
    lane: Object.freeze({
      lane_id: fields.lane_id,
      job_id: fields.job_id,
      branch: fields.branch,
      worktree: fields.worktree,
      writer_identity: fields.writer_identity,
      baseline_main_sha: fields.baseline_main_sha,
    }),
  });
}

/** Deterministic lookup by canonical lane_id. Returns the lane or null. */
function findLane(registry, laneId) {
  if (!Array.isArray(registry) || typeof laneId !== 'string') return null;
  for (const lane of registry) {
    if (lane !== null && typeof lane === 'object' && lane.lane_id === laneId) return lane;
  }
  return null;
}

/** Structural equality over the six canonical fields. */
function lanesEqual(a, b) {
  return LANE_REQUIRED_FIELDS.every((field) => a[field] === b[field]);
}

/**
 * Decision for two full canonical lanes sharing the same lane_id but not being
 * equal across all six fields. Deterministic precedence:
 * - different job_id (job rebinding): LANE_ID_COLLISION;
 * - different writer_identity: LANE_OWNERSHIP_CONFLICT;
 * - any other immutable binding difference: LANE_ID_COLLISION.
 */
function decideSameLaneId(existing, candidate) {
  if (existing.job_id !== candidate.job_id) return reject(LANE_ERRORS.LANE_ID_COLLISION);
  if (existing.writer_identity !== candidate.writer_identity) {
    return reject(LANE_ERRORS.LANE_OWNERSHIP_CONFLICT);
  }
  return reject(LANE_ERRORS.LANE_ID_COLLISION);
}

/**
 * Canonicalize a registry supplied from persistence/caller:
 * - must be an array;
 * - every entry must be a full canonical six-field lane record (no
 *   normalization is applied to persisted records);
 * - at most one entry per canonical lane_id: a duplicate lane_id fails closed
 *   (different writer_identity -> LANE_OWNERSHIP_CONFLICT; otherwise, including
 *   an exact duplicate -> LANE_ID_COLLISION); duplicates are never silently
 *   deduplicated and never returned;
 * - each accepted record is copied and frozen;
 * - the resulting registry is frozen.
 * Any malformed or noncanonical entry: LANE_CONTRACT_INVALID.
 */
function canonicalizeRegistry(registry) {
  if (!Array.isArray(registry)) return reject(LANE_ERRORS.LANE_CONTRACT_INVALID);
  const lanes = [];
  const owners = new Map();
  for (const entry of registry) {
    const validated = validateCanonicalLane(entry);
    if (!validated.ok) return validated;
    const lane = validated.lane;
    const existing = owners.get(lane.lane_id);
    if (existing !== undefined) {
      if (existing.writer_identity !== lane.writer_identity) {
        return reject(LANE_ERRORS.LANE_OWNERSHIP_CONFLICT);
      }
      return reject(LANE_ERRORS.LANE_ID_COLLISION);
    }
    owners.set(lane.lane_id, lane);
    lanes.push(lane);
  }
  return pass({ registry: Object.freeze(lanes) });
}

/**
 * Register a lane into a registry (pure; neither input is ever mutated or
 * returned by reference).
 *
 * The registry is canonicalized first: caller-owned arrays and lane objects are
 * validated, copied, and frozen. Outcomes:
 * - new canonical lane_id: new frozen registry with the lane appended;
 * - exact same canonical six-field lane: deterministic reuse, idempotent,
 *   returning canonical frozen registry and lane copies (never caller refs);
 * - same lane_id with a different job_id (job rebinding): LANE_ID_COLLISION;
 * - same lane_id with a different writer_identity: LANE_OWNERSHIP_CONFLICT;
 * - same lane_id with any other different immutable binding: LANE_ID_COLLISION.
 */
function registerLane(registry, input) {
  const canonicalized = canonicalizeRegistry(registry);
  if (!canonicalized.ok) return canonicalized;
  const canonicalRegistry = canonicalized.registry;

  const created = createLane(input);
  if (!created.ok) return created;
  const lane = created.lane;

  const existing = findLane(canonicalRegistry, lane.lane_id);
  if (existing === null) {
    return pass({ registry: Object.freeze(canonicalRegistry.concat([lane])), lane });
  }
  if (lanesEqual(existing, lane)) {
    return pass({ registry: canonicalRegistry, lane: existing, idempotent: true });
  }
  return decideSameLaneId(existing, lane);
}

/**
 * Lane ownership: one active writer per lane.
 * Requires a full canonical lane record; partial/malformed records fail closed
 * with LANE_CONTRACT_INVALID before any ownership decision is made.
 * Same lane + same writer is valid; a different writer fails closed with
 * LANE_OWNERSHIP_CONFLICT. Never mutates lane ownership data.
 */
function evaluateOwnership(lane, writerIdentity) {
  const validated = validateCanonicalLane(lane);
  if (!validated.ok) return validated;
  if (typeof writerIdentity !== 'string' || writerIdentity.length === 0) {
    return reject(LANE_ERRORS.LANE_CONTRACT_INVALID);
  }
  if (validated.lane.writer_identity === writerIdentity) {
    return pass({ lane_id: validated.lane.lane_id, writer_identity: writerIdentity });
  }
  return reject(LANE_ERRORS.LANE_OWNERSHIP_CONFLICT);
}

/**
 * Cross-lane claim: a writer belonging to one lane must not claim or write
 * another lane as that other lane's writer.
 *
 * Both records must be full canonical lanes (partial/malformed input fails
 * closed with LANE_CONTRACT_INVALID before any claim decision).
 *
 * - same lane_id and all six canonical fields equal: same lane, allowed;
 * - same lane_id with different immutable bindings: LANE_ID_COLLISION or
 *   LANE_OWNERSHIP_CONFLICT (see decideSameLaneId);
 * - different lane identities: CROSS_LANE_WRITE_REJECTED (detection only).
 */
function evaluateCrossLaneClaim(claimantLane, targetLane) {
  const claimant = validateCanonicalLane(claimantLane);
  if (!claimant.ok) return claimant;
  const target = validateCanonicalLane(targetLane);
  if (!target.ok) return target;

  if (claimant.lane.lane_id === target.lane.lane_id) {
    if (lanesEqual(claimant.lane, target.lane)) {
      return pass({ lane_id: target.lane.lane_id });
    }
    return decideSameLaneId(claimant.lane, target.lane);
  }
  return reject(LANE_ERRORS.CROSS_LANE_WRITE_REJECTED);
}

/**
 * Coordination checkout validation (pure; no branch switching).
 * The coordination checkout remains on the coordination branch (main);
 * anything else fails closed with COORDINATION_CHECKOUT_VIOLATION.
 */
function evaluateCoordinationCheckout(branch) {
  if (typeof branch !== 'string' || branch.length === 0) {
    return reject(LANE_ERRORS.LANE_CONTRACT_INVALID);
  }
  if (branch === COORDINATION_BRANCH) return pass({ branch });
  return reject(LANE_ERRORS.COORDINATION_CHECKOUT_VIOLATION);
}

/**
 * Stale main baseline DETECTION ONLY (no automatic sync, no recovery
 * transition, and the original lane baseline is never mutated).
 *
 * Requires a full canonical lane record; partial/malformed records fail closed
 * with LANE_CONTRACT_INVALID.
 *
 * - lane baseline equals authoritative main: fresh;
 * - any mismatch: STALE_MAIN_BASELINE.
 *
 * No caller-supplied synchronization assertion clears staleness. Trusted,
 * audited synchronization recognition belongs to the later coordination
 * integration authority (9B-05 / #41).
 */
function evaluateStaleBaseline(lane, authoritativeMainSha) {
  const validated = validateCanonicalLane(lane);
  if (!validated.ok) return validated;
  if (typeof authoritativeMainSha !== 'string' || !MAIN_SHA_PATTERN.test(authoritativeMainSha)) {
    return reject(LANE_ERRORS.LANE_CONTRACT_INVALID);
  }
  if (validated.lane.baseline_main_sha === authoritativeMainSha) {
    return pass({ stale: false });
  }
  return reject(LANE_ERRORS.STALE_MAIN_BASELINE, { stale: true });
}

module.exports = Object.freeze({
  LANE_REQUIRED_FIELDS,
  LANE_ERRORS,
  canonicalizeLaneId,
  createLane,
  createLaneRegistry,
  registerLane,
  evaluateOwnership,
  evaluateCrossLaneClaim,
  evaluateCoordinationCheckout,
  evaluateStaleBaseline,
});
