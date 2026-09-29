/**
 * Job Isolation v1 — Deterministic Namespace Derivation.
 *
 * Implements the namespace derivation primitives locked by
 * governance/contracts/job-isolation-v1.md (section 9) under policy
 * job-isolation@1.0.0.
 *
 * Scope boundary: deterministic namespace derivation and namespace integrity
 * validation only. This module does NOT implement namespace isolation
 * enforcement (#39), parallel lanes (#40), coordination (#41), persistence,
 * session lifecycle, or any Phase 9C recovery/resume semantics.
 *
 * Runtime principles (locked):
 *   - Deterministic and pure: no network, DB, environment, profile-file,
 *     wall-clock, or random reads. Identical canonical input produces
 *     identical output.
 *   - Fail closed: invalid identity, derivation failure, and caller-supplied
 *     namespace overrides all fail closed with canonical error identifiers.
 *   - No global/default/shared fallback namespace exists.
 *
 * Namespaces are logical identifiers (not filesystem paths), derived purely
 * from the canonical job_id:
 *   session_namespace             = job:{job_id}:sessions
 *   evidence_namespace            = job:{job_id}:evidence
 *   ledger_namespace              = job:{job_id}:ledger
 *   runtime_state_namespace       = job:{job_id}:runtime-state
 *   knowledge_job_local_namespace = job:{job_id}:knowledge
 *
 * Error identifiers are the locked canonical set from the policy. Module
 * integrity failures (policy unavailable / mismatched / malformed) throw
 * JobIsolationPolicyError with name/message only — it exposes no domain code,
 * because the locked domain error vocabulary is exactly the 18 canonical
 * identifiers. Every validation outcome throws JobIsolationError, whose
 * constructor rejects any code outside that locked set.
 */

const fs = require('fs');
const path = require('path');

const POLICY_REF = 'job-isolation@1.0.0';
const POLICY_PATH = path.join(__dirname, '..', '..', 'governance', 'policies', 'job-isolation.json');

/** Canonical derivation order of the five locked base namespace templates. */
const NAMESPACE_FIELDS = Object.freeze([
  'session_namespace',
  'evidence_namespace',
  'ledger_namespace',
  'runtime_state_namespace',
  'knowledge_job_local_namespace',
]);

/** The four namespace fields stored on a JobContract v1 (contract section 4). */
const CONTRACT_NAMESPACE_FIELDS = Object.freeze([
  'session_namespace',
  'evidence_namespace',
  'ledger_namespace',
  'runtime_state_namespace',
]);

/** Canonical namespace field -> locked policy template key. */
const POLICY_TEMPLATE_KEYS = Object.freeze({
  session_namespace: 'session',
  evidence_namespace: 'evidence',
  ledger_namespace: 'ledger',
  runtime_state_namespace: 'runtime_state',
  knowledge_job_local_namespace: 'knowledge_job_local',
});

/**
 * Derived namespace suffix shape: lowercase, no path separators, no further
 * placeholders. Keeps derived namespaces collision-safe and path-free.
 */
const NAMESPACE_SUFFIX_PATTERN = /^[a-z][a-z0-9-]*$/;

/**
 * Module-integrity failure (policy unavailable / mismatched / malformed).
 * This is NOT a Job Isolation domain validation outcome: it deliberately
 * exposes no `code` property, because the locked domain error vocabulary is
 * exactly the 18 canonical identifiers and initialization failures must not
 * extend it.
 */
class JobIsolationPolicyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'JobIsolationPolicyError';
  }
}

function policyFailure(message) {
  throw new JobIsolationPolicyError(message);
}

/**
 * Recursively freeze a JSON-derived value so loaded policy data can never be
 * mutated by any consumer after initialization.
 */
function deepFreeze(value) {
  if (value === null || typeof value !== 'object') return value;
  for (const key of Reflect.ownKeys(value)) {
    deepFreeze(value[key]);
  }
  return Object.freeze(value);
}

/**
 * Locked machine policy, recursively frozen before any use or export.
 * Derivation reads only this immutable snapshot, so no consumer can mutate
 * policy data and change derivation output or persisted-contract validation.
 * Fail closed if unavailable, mismatched, or missing the constants this
 * module derives from.
 */
const POLICY = (() => {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(POLICY_PATH, 'utf8'));
  } catch (e) {
    policyFailure(`Cannot load ${POLICY_REF} policy: ${e.message}`);
  }
  if (parsed.policy_ref !== POLICY_REF) {
    policyFailure(`Expected policy ${POLICY_REF}, found ${parsed.policy_ref}`);
  }
  if (!Array.isArray(parsed.canonical_errors) || parsed.canonical_errors.length !== 18) {
    policyFailure('canonical_errors must be the locked 18 identifiers');
  }
  if (!parsed.job_id || typeof parsed.job_id.pattern !== 'string') {
    policyFailure('job_id pattern missing');
  }
  const templates = parsed.namespaces && parsed.namespaces.templates;
  if (!templates || typeof templates !== 'object') {
    policyFailure('namespaces.templates missing');
  }
  for (const field of NAMESPACE_FIELDS) {
    const key = POLICY_TEMPLATE_KEYS[field];
    const template = templates[key];
    if (typeof template !== 'string') {
      policyFailure(`namespace template missing: ${key}`);
    }
    const prefix = 'job:{job_id}:';
    if (!template.startsWith(prefix) || template.split('{job_id}').length !== 2) {
      policyFailure(`namespace template malformed: ${key}`);
    }
    if (!NAMESPACE_SUFFIX_PATTERN.test(template.slice(prefix.length))) {
      policyFailure(`namespace template suffix malformed: ${key}`);
    }
  }
  return deepFreeze(parsed);
})();

const CANONICAL_ERRORS = Object.freeze(POLICY.canonical_errors.slice());
const JOB_ID_PATTERN = new RegExp(POLICY.job_id.pattern);

/**
 * Canonical error carrier. Exposes a stable `code` (one of the locked 18
 * canonical identifiers) and a human-readable `message`. Messages are
 * informational only; no decision logic may depend on message text.
 */
class JobIsolationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'JobIsolationError';
    this.code = code;
    if (!CANONICAL_ERRORS.includes(code)) {
      throw new Error(`JobIsolationError: non-canonical error code rejected: ${String(code)}`);
    }
  }
}

/**
 * Canonicalize a job identity exactly as locked: Unicode NFKC, trim,
 * lowercase, then the canonical pattern ^[a-z0-9][a-z0-9._-]{0,63}$
 * (length 1-64). Invalid identity: INVALID_JOB_ID. No fallback identity is
 * ever generated during resolution.
 */
function canonicalizeJobId(rawJobId) {
  if (typeof rawJobId !== 'string') {
    throw new JobIsolationError('INVALID_JOB_ID', 'job_id must be a string');
  }
  const canonical = rawJobId.normalize('NFKC').trim().toLowerCase();
  if (!JOB_ID_PATTERN.test(canonical)) {
    throw new JobIsolationError('INVALID_JOB_ID', 'job_id does not match the canonical pattern');
  }
  return canonical;
}

function isValidNamespaceValue(value, canonicalJobId) {
  if (typeof value !== 'string') return false;
  const prefix = `job:${canonicalJobId}:`;
  if (!value.startsWith(prefix)) return false;
  return NAMESPACE_SUFFIX_PATTERN.test(value.slice(prefix.length));
}

/**
 * Derive all five locked base namespaces for a canonical-bound identity.
 * Deterministic, pure, and job-bound. Unknown template kinds fail closed with
 * NAMESPACE_DERIVATION_FAILED; a derived collision fails closed with
 * NAMESPACE_COLLISION. There is no fallback path.
 */
function deriveNamespaces(jobId) {
  const canonicalJobId = canonicalizeJobId(jobId);
  const derived = {};
  const seen = new Set();
  for (const field of NAMESPACE_FIELDS) {
    const template = POLICY.namespaces.templates[POLICY_TEMPLATE_KEYS[field]];
    const value = template.split('{job_id}').join(canonicalJobId);
    if (!isValidNamespaceValue(value, canonicalJobId)) {
      throw new JobIsolationError('NAMESPACE_DERIVATION_FAILED', `Namespace derivation failed: ${field}`);
    }
    if (seen.has(value)) {
      throw new JobIsolationError('NAMESPACE_COLLISION', `Derived namespaces collide: ${field}`);
    }
    seen.add(value);
    derived[field] = value;
  }
  return Object.freeze(derived);
}

/**
 * Derive a single namespace by canonical field name. Same locked derivation
 * as deriveNamespaces; unknown field names fail closed.
 */
function deriveNamespace(field, jobId) {
  if (!NAMESPACE_FIELDS.includes(field)) {
    throw new JobIsolationError('NAMESPACE_DERIVATION_FAILED', `Unknown namespace template kind: ${String(field)}`);
  }
  return deriveNamespaces(jobId)[field];
}

/**
 * Validate that caller-provided namespace fields match the deterministic
 * derivation for the canonical job_id. Any deviation — including a missing
 * value — fails closed with NAMESPACE_OVERRIDE_FORBIDDEN. This function never
 * repairs, normalizes, or falls back to a shared/default namespace.
 *
 * Only the four stored JobContract namespace fields are checked here; the
 * knowledge job-local namespace is derived on demand and is not a stored
 * JobContract field.
 */
function assertNamespaceIntegrity(jobId, candidate) {
  const canonicalJobId = canonicalizeJobId(jobId);
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new JobIsolationError('NAMESPACE_OVERRIDE_FORBIDDEN', 'Namespace candidate must be an object');
  }
  const expected = deriveNamespaces(canonicalJobId);
  for (const field of CONTRACT_NAMESPACE_FIELDS) {
    if (candidate[field] !== expected[field]) {
      throw new JobIsolationError('NAMESPACE_OVERRIDE_FORBIDDEN', `Namespace override or mismatch: ${field}`);
    }
  }
  return true;
}

module.exports = {
  JobIsolationError,
  JobIsolationPolicyError,
  POLICY,
  NAMESPACE_FIELDS,
  CONTRACT_NAMESPACE_FIELDS,
  canonicalizeJobId,
  deriveNamespace,
  deriveNamespaces,
  assertNamespaceIntegrity,
};
