/**
 * Job Isolation v1 — Namespace Isolation Enforcement (#39 / 9B-03).
 *
 * Implements the pure, deterministic namespace access enforcement locked by
 * governance/contracts/job-isolation-v1.md (sections 10-14) under policy
 * job-isolation@1.0.0:
 *
 *   - session namespace access (JOB_SCOPED / SESSION_LOCAL resource scope x
 *     same/different session x same/different job);
 *   - evidence namespace access;
 *   - ledger namespace access;
 *   - runtime-state access and runtime-state cleanup ownership.
 *
 * The module consumes a canonical JobContract only. It reuses the existing
 * runtime authority — validateJobContract() (JobContract runtime core),
 * deriveNamespaces() (namespace derivation primitives), POLICY (machine
 * policy), and JobIsolationError (locked canonical error carrier) — and
 * reimplements none of the JobContract schema, job_id canonicalization
 * policy, profile rules, namespace templates, or canonical error vocabulary.
 * If the existing runtime authority rejects the contract, its canonical
 * failure propagates unchanged.
 *
 * Trust boundary (fail closed):
 *   - every public request descriptor must be a plain data record
 *     (Object.prototype or null prototype) carrying exactly the locked own
 *     keys; unknown enumerable keys, unknown non-enumerable keys, symbol
 *     keys, accessor-backed fields, and custom prototypes are rejected;
 *   - descriptor inspection never executes caller-controlled getters or
 *     setters;
 *   - resource descriptors are never silently normalized or repaired;
 *   - a noncanonical resource job_id propagates INVALID_JOB_ID;
 *   - malformed request descriptors, unknown operations, and unknown session
 *     resource scopes fail closed with NAMESPACE_DERIVATION_FAILED
 *     (namespace interpretation impossible);
 *   - a supplied namespace that does not match the deterministic namespace
 *     of the owning job fails closed with NAMESPACE_COLLISION; this never
 *     uses NAMESPACE_OVERRIDE_FORBIDDEN, which stays reserved for caller
 *     attempts to override JobContract-derived namespace fields;
 *   - foreign-job ownership is checked before same-job access is allowed,
 *     and session identity never overrides the job boundary.
 *
 * Operation boundaries (locked):
 *   - access operations are exactly READ and WRITE;
 *   - runtime-state cleanup is a separate boundary with operation CLEANUP;
 *   - session resource scopes are exactly JOB_SCOPED and SESSION_LOCAL;
 *   - unknown operations or resource scopes fail closed; no nineteenth
 *     domain error exists.
 *
 * Error mapping (pinned by the #39 test suites):
 *   - malformed request descriptor / unknown operation / unknown session
 *     resource scope                                 -> NAMESPACE_DERIVATION_FAILED
 *   - noncanonical resource job_id                      -> INVALID_JOB_ID
 *   - foreign job: READ  -> FOREIGN_JOB_REJECT
 *                  WRITE -> FOREIGN_NAMESPACE_WRITE_REJECTED
 *   - foreign runtime-state (READ/WRITE/CLEANUP)        -> FOREIGN_NAMESPACE_WRITE_REJECTED
 *     (machine policy runtime_state_isolation.foreign_read_write_error)
 *   - same-job namespace mismatch                       -> NAMESPACE_COLLISION
 *
 * Outputs are frozen, copy-safe, and deterministic. No wall clock, no
 * randomness, no network, no filesystem access, no persistence.
 *
 * Scope boundary: namespace access enforcement only. No JobContract
 * behavioral change, no namespace derivation behavioral change, no parallel
 * lanes (#40), no coordination (#41), no acceptance suite (#42), no Phase 9C
 * recovery semantics.
 */

'use strict';

const {
  JobIsolationError,
  POLICY,
  canonicalizeJobId,
  deriveNamespaces,
} = require('./namespace-derivation.js');

const { validateJobContract } = require('./job-contract.js');

/** Namespace access operations (locked): exactly READ and WRITE. */
const ACCESS_OPERATIONS = Object.freeze(['READ', 'WRITE']);

/** Runtime-state cleanup is a separate operation boundary (locked). */
const CLEANUP_OPERATION = 'CLEANUP';
const CLEANUP_OPERATIONS = Object.freeze([CLEANUP_OPERATION]);

/** Canonical session resource scopes (locked): exactly these two. */
const SESSION_RESOURCE_SCOPES = Object.freeze(['JOB_SCOPED', 'SESSION_LOCAL']);

/** Generic foreign-job access error mapping (contract sections 12-14). */
const FOREIGN_ACCESS_ERRORS = Object.freeze({
  READ: 'FOREIGN_JOB_REJECT',
  WRITE: 'FOREIGN_NAMESPACE_WRITE_REJECTED',
});

/**
 * Foreign runtime-state error: read from the machine policy so the runtime
 * behavior and job-isolation@1.0.0 stay bound to a single source of truth.
 */
const RUNTIME_STATE_FOREIGN_ERROR = POLICY.runtime_state_isolation.foreign_read_write_error;

/** Session access request fields (locked, exact). */
const SESSION_REQUEST_FIELDS = Object.freeze([
  'operation',
  'resource_job_id',
  'resource_namespace',
  'resource_scope',
  'requester_session_id',
  'owner_session_id',
]);

/** Evidence / ledger / runtime-state resource request fields (locked, exact). */
const RESOURCE_REQUEST_FIELDS = Object.freeze([
  'operation',
  'resource_job_id',
  'resource_namespace',
]);

/**
 * Structural descriptor failure: the descriptor cannot be interpreted as a
 * namespace access request. NAMESPACE_DERIVATION_FAILED is used only where
 * namespace interpretation is impossible; no other canonical error is
 * overloaded for this boundary.
 */
function descriptorFailure(message) {
  throw new JobIsolationError('NAMESPACE_DERIVATION_FAILED', message);
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
    descriptorFailure(`${label} must be a plain data record`);
  }
  const ownKeys = Reflect.ownKeys(record);
  if (ownKeys.length !== fields.length) {
    descriptorFailure(`${label} must contain exactly the locked fields`);
  }
  for (const key of ownKeys) {
    if (typeof key !== 'string' || !fields.includes(key)) {
      descriptorFailure(`${label} contains an unknown field: ${String(key)}`);
    }
  }
  const values = {};
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(record, field);
    if (descriptor === undefined || 'get' in descriptor || 'set' in descriptor) {
      descriptorFailure(`${label} field must be an ordinary data property: ${field}`);
    }
    values[field] = descriptor.value;
  }
  return values;
}

function requireNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    descriptorFailure(`${label} must be a non-empty string`);
  }
  return value;
}

/** Read and validate the operation against the boundary's locked set. */
function readOperation(fields, allowed, label) {
  const operation = fields.operation;
  if (typeof operation !== 'string' || !allowed.includes(operation)) {
    descriptorFailure(`${label} operation is not supported by this boundary`);
  }
  return operation;
}

/** Read and validate the session resource scope against the locked enum. */
function readResourceScope(fields) {
  const scope = fields.resource_scope;
  if (typeof scope !== 'string' || !SESSION_RESOURCE_SCOPES.includes(scope)) {
    descriptorFailure('Session access request resource_scope is not a canonical resource scope');
  }
  return scope;
}

/**
 * Resource job_id must already be canonical: the existing canonicalizer is
 * used only to validate stability (canonicalizeJobId(x) === x). A
 * noncanonical or invalid resource owner propagates INVALID_JOB_ID and is
 * never repaired.
 */
function assertCanonicalResourceJobId(resourceJobId) {
  const canonical = canonicalizeJobId(resourceJobId);
  if (canonical !== resourceJobId) {
    throw new JobIsolationError('INVALID_JOB_ID', 'Resource job_id is not canonical');
  }
  return canonical;
}

/**
 * Same-job namespace rule: the supplied namespace identity must be a
 * non-empty string that exactly matches the deterministic namespace of the
 * owning job. A missing/empty/non-string namespace fails closed with
 * NAMESPACE_DERIVATION_FAILED; a supplied identity that does not match fails
 * closed with NAMESPACE_COLLISION.
 */
function assertSameJobNamespace(resourceNamespace, expectedNamespace, label) {
  if (resourceNamespace === null || typeof resourceNamespace !== 'string' || resourceNamespace.length === 0) {
    descriptorFailure(`${label} must carry a non-empty namespace identity`);
  }
  if (resourceNamespace !== expectedNamespace) {
    throw new JobIsolationError('NAMESPACE_COLLISION', `${label} does not match the deterministic namespace of the owning job`);
  }
}

/**
 * Evaluate session namespace access for the active job.
 *
 * The request explicitly classifies the resource scope:
 *
 * - JOB_SCOPED: job-scoped operational state inside the owning job's session
 *   namespace. Same canonical job + exact session namespace -> allowed for
 *   the owning session AND for other sessions of the same job; session
 *   equality does not restrict job-scoped state.
 * - SESSION_LOCAL: session-local state. Same canonical job + exact session
 *   namespace -> allowed only for the same exact session identity; a
 *   different session receives a normal fail-closed decision
 *   { allowed: false } (no new canonical exception).
 *
 * Foreign job ownership is checked first and is never weakened by
 * resource_scope or session equality: READ -> FOREIGN_JOB_REJECT;
 * WRITE -> FOREIGN_NAMESPACE_WRITE_REJECTED.
 *
 * Both resource scopes use the canonical JobContract base session namespace;
 * no session-key derivation (job:{job_id}:sessions:{session_key}) exists
 * here. Session identifiers are opaque upstream-resolved identities compared
 * by exact equality only.
 *
 * Returns a frozen decision
 * { allowed, same_job, same_session, resource_scope }.
 */
function evaluateSessionAccess(activeContract, request) {
  const contract = validateJobContract(activeContract);
  const fields = readExactFields(request, SESSION_REQUEST_FIELDS, 'Session access request');
  const operation = readOperation(fields, ACCESS_OPERATIONS, 'Session access request');
  const resourceScope = readResourceScope(fields);
  const resourceNamespace = requireNonEmptyString(fields.resource_namespace, 'resource_namespace');
  const requesterSessionId = requireNonEmptyString(fields.requester_session_id, 'requester_session_id');
  const ownerSessionId = requireNonEmptyString(fields.owner_session_id, 'owner_session_id');

  const resourceJobId = assertCanonicalResourceJobId(fields.resource_job_id);
  if (resourceJobId !== contract.job_id) {
    throw new JobIsolationError(FOREIGN_ACCESS_ERRORS[operation], 'Foreign job session access rejected');
  }

  const derived = deriveNamespaces(contract.job_id);
  assertSameJobNamespace(resourceNamespace, derived.session_namespace, 'Session access request');

  const sameSession = requesterSessionId === ownerSessionId;
  if (resourceScope === 'JOB_SCOPED') {
    return Object.freeze({
      allowed: true,
      same_job: true,
      same_session: sameSession,
      resource_scope: 'JOB_SCOPED',
    });
  }
  return Object.freeze({
    allowed: sameSession,
    same_job: true,
    same_session: sameSession,
    resource_scope: 'SESSION_LOCAL',
  });
}

/**
 * Evaluate evidence namespace access for the active job.
 *
 * Same job + exact evidence namespace: READ and WRITE allowed. Foreign job:
 * READ -> FOREIGN_JOB_REJECT; WRITE -> FOREIGN_NAMESPACE_WRITE_REJECTED.
 * Same-job namespace mismatch: NAMESPACE_COLLISION. No shared/global evidence
 * namespace exists in v1 and there is no fallback: evidence for Job A must
 * never satisfy Job B.
 *
 * Returns a frozen decision { allowed: true, same_job: true, operation }.
 */
function evaluateEvidenceAccess(activeContract, request) {
  const contract = validateJobContract(activeContract);
  const fields = readExactFields(request, RESOURCE_REQUEST_FIELDS, 'Evidence access request');
  const operation = readOperation(fields, ACCESS_OPERATIONS, 'Evidence access request');
  const resourceNamespace = requireNonEmptyString(fields.resource_namespace, 'resource_namespace');

  const resourceJobId = assertCanonicalResourceJobId(fields.resource_job_id);
  if (resourceJobId !== contract.job_id) {
    throw new JobIsolationError(FOREIGN_ACCESS_ERRORS[operation], 'Foreign job evidence access rejected');
  }

  const derived = deriveNamespaces(contract.job_id);
  assertSameJobNamespace(resourceNamespace, derived.evidence_namespace, 'Evidence access request');

  return Object.freeze({ allowed: true, same_job: true, operation });
}

/**
 * Evaluate ledger namespace access for the active job.
 *
 * Ledger owns namespace isolation only: execution records, decisions, audit
 * events, and coordination entries stay job-scoped. Same job + exact ledger
 * namespace: READ and WRITE allowed. Foreign job: READ -> FOREIGN_JOB_REJECT;
 * WRITE -> FOREIGN_NAMESPACE_WRITE_REJECTED. Same-job namespace mismatch:
 * NAMESPACE_COLLISION. No recovery transitions, no resume states, no Phase 9C
 * state machine.
 *
 * Returns a frozen decision { allowed: true, same_job: true, operation }.
 */
function evaluateLedgerAccess(activeContract, request) {
  const contract = validateJobContract(activeContract);
  const fields = readExactFields(request, RESOURCE_REQUEST_FIELDS, 'Ledger access request');
  const operation = readOperation(fields, ACCESS_OPERATIONS, 'Ledger access request');
  const resourceNamespace = requireNonEmptyString(fields.resource_namespace, 'resource_namespace');

  const resourceJobId = assertCanonicalResourceJobId(fields.resource_job_id);
  if (resourceJobId !== contract.job_id) {
    throw new JobIsolationError(FOREIGN_ACCESS_ERRORS[operation], 'Foreign job ledger access rejected');
  }

  const derived = deriveNamespaces(contract.job_id);
  assertSameJobNamespace(resourceNamespace, derived.ledger_namespace, 'Ledger access request');

  return Object.freeze({ allowed: true, same_job: true, operation });
}

/**
 * Evaluate runtime-state access (READ / WRITE) for the active job.
 *
 * Foreign ownership follows the machine policy for ALL operations:
 * runtime_state_isolation.foreign_read_write_error =
 * FOREIGN_NAMESPACE_WRITE_REJECTED (including foreign READ — intentional per
 * job-isolation@1.0.0). Same job + exact runtime-state namespace: allowed.
 * Same-job namespace mismatch: NAMESPACE_COLLISION.
 *
 * Returns a frozen decision { allowed: true, same_job: true, operation }.
 */
function evaluateRuntimeStateAccess(activeContract, request) {
  const contract = validateJobContract(activeContract);
  const fields = readExactFields(request, RESOURCE_REQUEST_FIELDS, 'Runtime-state access request');
  const operation = readOperation(fields, ACCESS_OPERATIONS, 'Runtime-state access request');
  const resourceNamespace = requireNonEmptyString(fields.resource_namespace, 'resource_namespace');

  const resourceJobId = assertCanonicalResourceJobId(fields.resource_job_id);
  if (resourceJobId !== contract.job_id) {
    throw new JobIsolationError(RUNTIME_STATE_FOREIGN_ERROR, 'Foreign job runtime-state access rejected');
  }

  const derived = deriveNamespaces(contract.job_id);
  assertSameJobNamespace(resourceNamespace, derived.runtime_state_namespace, 'Runtime-state access request');

  return Object.freeze({ allowed: true, same_job: true, operation });
}

/**
 * Evaluate runtime-state cleanup ownership for the active job.
 *
 * CLEANUP is a separate operation boundary. Cleanup ownership is the owning
 * canonical job only; there is no implicit cross-job coordination. Foreign
 * ownership: FOREIGN_NAMESPACE_WRITE_REJECTED (machine policy). Same-job
 * namespace mismatch: NAMESPACE_COLLISION.
 *
 * Returns a frozen decision { allowed: true, same_job: true, operation: 'CLEANUP' }.
 */
function evaluateRuntimeStateCleanup(activeContract, request) {
  const contract = validateJobContract(activeContract);
  const fields = readExactFields(request, RESOURCE_REQUEST_FIELDS, 'Runtime-state cleanup request');
  const operation = readOperation(fields, CLEANUP_OPERATIONS, 'Runtime-state cleanup request');
  const resourceNamespace = requireNonEmptyString(fields.resource_namespace, 'resource_namespace');

  const resourceJobId = assertCanonicalResourceJobId(fields.resource_job_id);
  if (resourceJobId !== contract.job_id) {
    throw new JobIsolationError(RUNTIME_STATE_FOREIGN_ERROR, 'Foreign job runtime-state cleanup rejected');
  }

  const derived = deriveNamespaces(contract.job_id);
  assertSameJobNamespace(resourceNamespace, derived.runtime_state_namespace, 'Runtime-state cleanup request');

  return Object.freeze({ allowed: true, same_job: true, operation });
}

module.exports = Object.freeze({
  ACCESS_OPERATIONS,
  CLEANUP_OPERATION,
  SESSION_RESOURCE_SCOPES,
  evaluateSessionAccess,
  evaluateEvidenceAccess,
  evaluateLedgerAccess,
  evaluateRuntimeStateAccess,
  evaluateRuntimeStateCleanup,
});
