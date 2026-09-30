/**
 * Job Isolation v1 — Knowledge-Scope Read Eligibility (#39 / 9B-03).
 *
 * Implements the pure, deterministic knowledge read-eligibility boundary
 * locked by governance/contracts/job-isolation-v1.md (section 11) under
 * policy job-isolation@1.0.0:
 *
 *   - JOB_LOCAL: same canonical job only; session identity is irrelevant;
 *   - SESSION_LOCAL: requires the same canonical job AND the same exact
 *     session identity, and then the JobContract capability;
 *   - GLOBAL: requires an explicitly global / unowned source and then the
 *     JobContract capability; foreign job-local or session-local sources can
 *     never be promoted merely because the active JobContract has GLOBAL.
 *
 * Foreign-job ownership is enforced BEFORE any optional capability check:
 * when a source declares a non-null source_job_id, the canonical source
 * identity is validated first, a foreign owner is rejected with
 * FOREIGN_JOB_REJECT, and only then do optional capability rules
 * (SESSION_LOCAL / GLOBAL membership in knowledge_scope) apply. A foreign
 * source can therefore never collapse into ordinary capability
 * ineligibility.
 *
 * This module implements READ ELIGIBILITY only. It deliberately exposes NO
 * knowledge-write authorization API — GLOBAL provides read eligibility only
 * and grants no implicit global writes; no global namespace is created.
 *
 * The module consumes a canonical JobContract only. It reuses the existing
 * runtime authority — validateJobContract() (JobContract runtime core),
 * deriveNamespaces() (namespace derivation primitives), POLICY (machine
 * policy: canonical scope enum), and JobIsolationError (locked canonical
 * error carrier) — and reimplements none of the JobContract schema, job_id
 * canonicalization policy, profile rules, namespace templates, or canonical
 * error vocabulary. If the existing runtime authority rejects the contract,
 * its canonical failure propagates unchanged.
 *
 * Trust boundary (fail closed):
 *   - every request descriptor must be a plain data record (Object.prototype
 *     or null prototype) carrying exactly the locked own keys; unknown
 *     enumerable keys, unknown non-enumerable keys, symbol keys,
 *     accessor-backed fields, and custom prototypes are rejected;
 *   - descriptor inspection never executes caller-controlled getters or
 *     setters; descriptors are never silently normalized or repaired;
 *   - unknown source scope -> INVALID_KNOWLEDGE_SCOPE;
 *   - noncanonical source job_id -> INVALID_JOB_ID;
 *   - foreign source job -> FOREIGN_JOB_REJECT, enforced BEFORE any optional
 *     capability check and never overridden by session equality; a foreign
 *     source can never collapse into ordinary capability ineligibility;
 *   - namespace identity that does not match the owning job's deterministic
 *     knowledge namespace -> NAMESPACE_COLLISION;
 *   - malformed descriptors / missing required ownership -> 
 *     NAMESPACE_DERIVATION_FAILED (interpretation impossible).
 *
 * Decisions are frozen and deterministic: { eligible, scope }. Ordinary
 * eligibility=false carries NO domain .code; hard rejections carry the locked
 * canonical JobIsolationError identifiers only.
 *
 * No Context Hydration score, ranking, weight, or budget input exists in this
 * module; policy context-hydration@1.0.1 remains frozen and untouched.
 *
 * Scope boundary: knowledge read eligibility only. No write API, no global
 * namespace creation, no JobContract behavioral change, no namespace
 * derivation behavioral change, no parallel lanes (#40), no coordination
 * (#41), no acceptance suite (#42), no Phase 9C recovery semantics.
 */

'use strict';

const {
  JobIsolationError,
  POLICY,
  canonicalizeJobId,
  deriveNamespaces,
} = require('./namespace-derivation.js');

const { validateJobContract } = require('./job-contract.js');

/** Canonical knowledge source scopes (locked enum from the machine policy). */
const KNOWLEDGE_SOURCE_SCOPES = Object.freeze(POLICY.knowledge_scope.canonical_order.slice());

/** Knowledge read request fields (locked, exact). */
const KNOWLEDGE_REQUEST_FIELDS = Object.freeze([
  'requester_session_id',
  'source_scope',
  'source_job_id',
  'source_session_id',
  'source_namespace',
]);

/**
 * Structural descriptor failure: the request cannot be interpreted as a
 * knowledge read-eligibility request. NAMESPACE_DERIVATION_FAILED is used
 * only where interpretation is impossible; no other canonical error is
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

/**
 * Source job_id must already be canonical when present: the existing
 * canonicalizer is used only to validate stability
 * (canonicalizeJobId(x) === x). A noncanonical or invalid source owner
 * propagates INVALID_JOB_ID and is never repaired.
 */
function assertCanonicalSourceJobId(sourceJobId) {
  const canonical = canonicalizeJobId(sourceJobId);
  if (canonical !== sourceJobId) {
    throw new JobIsolationError('INVALID_JOB_ID', 'Source job_id is not canonical');
  }
  return canonical;
}

/** Frozen deterministic knowledge eligibility decision. */
function knowledgeDecision(eligible, scope) {
  return Object.freeze({ eligible, scope });
}

/**
 * Evaluate knowledge READ eligibility for the active job.
 *
 * Request (locked): requester_session_id, source_scope, source_job_id,
 * source_session_id, source_namespace.
 *
 * - JOB_LOCAL: source_job_id must be the canonical active job_id and
 *   source_namespace the active job knowledge namespace; session identity is
 *   irrelevant to eligibility.
 * - SESSION_LOCAL: foreign source -> FOREIGN_JOB_REJECT (checked first);
 *   same canonical job AND same exact session identity required, and then
 *   the JobContract capability. A session match never makes foreign content
 *   eligible.
 * - GLOBAL: foreign-owned source -> FOREIGN_JOB_REJECT (checked first); the
 *   source must be explicitly global/unowned: (source_job_id = null AND
 *   source_namespace = null) OR (source_job_id = active job_id AND
 *   source_namespace = active job knowledge namespace), and the JobContract
 *   capability is then required.
 *
 * Returns a frozen decision { eligible, scope }; ordinary ineligibility is
 * never a domain error and exposes no .code.
 */
function evaluateKnowledgeReadEligibility(activeContract, request) {
  const contract = validateJobContract(activeContract);
  const fields = readExactFields(request, KNOWLEDGE_REQUEST_FIELDS, 'Knowledge read request');

  const requesterSessionId = requireNonEmptyString(fields.requester_session_id, 'requester_session_id');

  const scope = fields.source_scope;
  if (typeof scope !== 'string' || !KNOWLEDGE_SOURCE_SCOPES.includes(scope)) {
    throw new JobIsolationError('INVALID_KNOWLEDGE_SCOPE', 'Unknown knowledge source scope');
  }

  if (fields.source_job_id !== null && typeof fields.source_job_id !== 'string') {
    descriptorFailure('source_job_id must be a string or null');
  }
  if (fields.source_session_id !== null && (typeof fields.source_session_id !== 'string' || fields.source_session_id.length === 0)) {
    descriptorFailure('source_session_id must be a non-empty string or null');
  }
  if (fields.source_namespace !== null && (typeof fields.source_namespace !== 'string' || fields.source_namespace.length === 0)) {
    descriptorFailure('source_namespace must be a non-empty string or null');
  }

  if (scope === 'JOB_LOCAL') {
    if (fields.source_job_id === null) {
      descriptorFailure('JOB_LOCAL knowledge source requires an owning job_id');
    }
    const sourceJobId = assertCanonicalSourceJobId(fields.source_job_id);
    if (sourceJobId !== contract.job_id) {
      throw new JobIsolationError('FOREIGN_JOB_REJECT', 'Foreign job knowledge rejected');
    }
    if (fields.source_namespace === null) {
      descriptorFailure('JOB_LOCAL knowledge source requires a namespace identity');
    }
    const derived = deriveNamespaces(contract.job_id);
    if (fields.source_namespace !== derived.knowledge_job_local_namespace) {
      throw new JobIsolationError('NAMESPACE_COLLISION', 'Knowledge namespace does not match the owning job knowledge namespace');
    }
    return knowledgeDecision(true, 'JOB_LOCAL');
  }

  if (scope === 'SESSION_LOCAL') {
    if (fields.source_job_id === null) {
      descriptorFailure('SESSION_LOCAL knowledge source requires an owning job_id');
    }
    const sourceJobId = assertCanonicalSourceJobId(fields.source_job_id);
    if (sourceJobId !== contract.job_id) {
      throw new JobIsolationError('FOREIGN_JOB_REJECT', 'Foreign job knowledge rejected');
    }
    if (!contract.knowledge_scope.includes('SESSION_LOCAL')) {
      return knowledgeDecision(false, 'SESSION_LOCAL');
    }
    if (fields.source_namespace === null) {
      descriptorFailure('SESSION_LOCAL knowledge source requires a namespace identity');
    }
    const derived = deriveNamespaces(contract.job_id);
    if (fields.source_namespace !== derived.knowledge_job_local_namespace) {
      throw new JobIsolationError('NAMESPACE_COLLISION', 'Knowledge namespace does not match the owning job knowledge namespace');
    }
    const sameSession = fields.source_session_id !== null && fields.source_session_id === requesterSessionId;
    return knowledgeDecision(sameSession, 'SESSION_LOCAL');
  }

  // scope === 'GLOBAL'
  if (fields.source_job_id === null) {
    // Unowned explicit global source: no foreign owner exists, so the
    // optional capability may be evaluated first.
    if (!contract.knowledge_scope.includes('GLOBAL')) {
      return knowledgeDecision(false, 'GLOBAL');
    }
    if (fields.source_namespace !== null) {
      throw new JobIsolationError('NAMESPACE_COLLISION', 'Unowned global source must not carry a namespace identity');
    }
    return knowledgeDecision(true, 'GLOBAL');
  }
  const sourceJobId = assertCanonicalSourceJobId(fields.source_job_id);
  if (sourceJobId !== contract.job_id) {
    throw new JobIsolationError('FOREIGN_JOB_REJECT', 'Foreign job knowledge rejected');
  }
  if (!contract.knowledge_scope.includes('GLOBAL')) {
    return knowledgeDecision(false, 'GLOBAL');
  }
  if (fields.source_namespace === null) {
    descriptorFailure('Same-job global source requires the owning job knowledge namespace');
  }
  const derived = deriveNamespaces(contract.job_id);
  if (fields.source_namespace !== derived.knowledge_job_local_namespace) {
    throw new JobIsolationError('NAMESPACE_COLLISION', 'Knowledge namespace does not match the owning job knowledge namespace');
  }
  return knowledgeDecision(true, 'GLOBAL');
}

module.exports = Object.freeze({
  KNOWLEDGE_SOURCE_SCOPES,
  evaluateKnowledgeReadEligibility,
});
