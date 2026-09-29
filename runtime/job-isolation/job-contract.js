/**
 * Job Isolation v1 — JobContract Runtime Core.
 *
 * Implements the pure, deterministic JobContract runtime semantics locked by
 * governance/contracts/job-isolation-v1.md under policy job-isolation@1.0.0:
 *
 *   - canonical 8-field JobContract creation (CREATE);
 *   - persisted JobContract validation (exactly the locked eight fields);
 *   - deterministic reuse/resolution of an exact persisted canonical
 *     contract (REUSE, idempotent) and collision handling (JOB_ID_COLLISION);
 *   - explicit profile binding comparison (trim only, case preserved);
 *   - job-bound execution-permission ceiling binding (capability ceiling,
 *     never an approval).
 *
 * Scope boundary: JobContract runtime core only. This module does NOT
 * implement parallel lanes (#40), namespace isolation enforcement (#39),
 * coordination (#41), recovery/resume state machines (Phase 9C), or any
 * persistence layer. Persistence is owned by the caller: CREATE returns the
 * canonical contract and does not write it anywhere; REUSE requires the
 * caller to supply the persisted canonical contracts.
 *
 * Runtime principles (locked):
 *   - Deterministic and pure: no network, DB, environment, profile-file,
 *     wall-clock, or random reads. Identical canonical input produces
 *     identical output.
 *   - Fail closed: unknown fields, malformed values, collisions, foreign-job
 *     access, and namespace overrides all fail closed with canonical error
 *     identifiers.
 *   - Validation never silently repairs an inconsistent persisted contract.
 *   - Validation precedence (locked, first failing condition wins):
 *       1. structural JobContract validity
 *       2. canonical job_id
 *       3. profile binding
 *       4. namespace integrity
 *       5. knowledge_scope
 *       6. execution_permissions
 *       7. job identity / collision / foreign-job boundary
 *
 * All error identifiers are the locked canonical set from the policy; the
 * JobIsolationError constructor rejects any non-canonical code. Module
 * integrity failures use JobIsolationPolicyError (name/message only, no
 * domain code outside the locked 18).
 */

const {
  JobIsolationError,
  JobIsolationPolicyError,
  POLICY,
  NAMESPACE_FIELDS,
  CONTRACT_NAMESPACE_FIELDS,
  canonicalizeJobId,
  deriveNamespaces,
  assertNamespaceIntegrity,
} = require('./namespace-derivation.js');

/**
 * The locked 8 JobContract fields in canonical order. Loaded from the policy
 * and structurally locked here; no second vocabulary is defined.
 */
const REQUIRED_FIELDS = (() => {
  const fields = POLICY.job_contract && POLICY.job_contract.required_fields;
  if (!Array.isArray(fields) || fields.length !== 8 || fields.some((f) => typeof f !== 'string')) {
    throw new JobIsolationPolicyError('job_contract.required_fields must be the locked 8 fields');
  }
  for (const field of ['job_id', 'profile', 'knowledge_scope', 'execution_permissions']) {
    if (!fields.includes(field)) {
      throw new JobIsolationPolicyError(`job_contract.required_fields missing: ${field}`);
    }
  }
  for (const field of CONTRACT_NAMESPACE_FIELDS) {
    if (!fields.includes(field)) {
      throw new JobIsolationPolicyError(`job_contract.required_fields missing: ${field}`);
    }
  }
  return Object.freeze(fields.slice());
})();

/** Caller-controlled creation input fields (contract section 4 semantics). */
const CREATION_INPUT_FIELDS = Object.freeze([
  'job_id',
  'profile',
  'knowledge_scope',
  'execution_permissions',
]);

/** Knowledge scope canonical enum + order (locked). */
const KNOWLEDGE_SCOPES = (() => {
  const scopes = POLICY.knowledge_scope && POLICY.knowledge_scope.canonical_order;
  if (!Array.isArray(scopes) || scopes.length !== 3 || !scopes.includes('JOB_LOCAL')) {
    throw new JobIsolationPolicyError('knowledge_scope.canonical_order malformed');
  }
  return Object.freeze(scopes.slice());
})();

/** Execution permission canonical enum + order (locked). */
const EXECUTION_PERMISSIONS = (() => {
  const permissions = POLICY.execution_permissions && POLICY.execution_permissions.canonical_order;
  if (!Array.isArray(permissions) || permissions.length !== 5 || !permissions.includes('READ_ONLY')) {
    throw new JobIsolationPolicyError('execution_permissions.canonical_order malformed');
  }
  return Object.freeze(permissions.slice());
})();

const PROFILE_PATTERN = new RegExp(POLICY.profile.pattern);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function arraysEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Deep field comparison across the locked eight fields. Used for exact
 * persisted-reuse equality only; never used to repair or normalize.
 */
function contractsEqual(a, b) {
  for (const field of REQUIRED_FIELDS) {
    const av = a[field];
    const bv = b[field];
    if (Array.isArray(av) || Array.isArray(bv)) {
      if (!Array.isArray(av) || !Array.isArray(bv) || !arraysEqual(av, bv)) return false;
    } else if (av !== bv) {
      return false;
    }
  }
  return true;
}

/**
 * Canonicalize a caller-supplied profile for creation: trim only, case
 * preserved. Malformed: PROFILE_BINDING_INVALID. No profile file is read.
 */
function canonicalizeProfile(rawProfile) {
  if (typeof rawProfile !== 'string') {
    throw new JobIsolationError('PROFILE_BINDING_INVALID', 'profile must be a string');
  }
  const profile = rawProfile.trim();
  if (!PROFILE_PATTERN.test(profile)) {
    throw new JobIsolationError('PROFILE_BINDING_INVALID', 'profile does not match the bound profile pattern');
  }
  return profile;
}

/**
 * Validate a persisted profile without silent repair: it must already be in
 * canonical bound form (trim-stable and pattern-valid).
 */
function assertPersistedProfile(profile) {
  if (typeof profile !== 'string' || profile !== profile.trim() || !PROFILE_PATTERN.test(profile)) {
    throw new JobIsolationError('PROFILE_BINDING_INVALID', 'Persisted profile is not in canonical bound form');
  }
  return profile;
}

/**
 * Canonicalize knowledge_scope: deduplicate and order canonically
 * (JOB_LOCAL, SESSION_LOCAL, GLOBAL). JOB_LOCAL is required; empty and
 * unknown scopes fail closed with INVALID_KNOWLEDGE_SCOPE.
 */
function canonicalizeKnowledgeScope(rawScope) {
  if (!Array.isArray(rawScope)) {
    throw new JobIsolationError('INVALID_KNOWLEDGE_SCOPE', 'knowledge_scope must be an array');
  }
  const seen = new Set();
  for (const item of rawScope) {
    if (typeof item !== 'string' || !KNOWLEDGE_SCOPES.includes(item)) {
      throw new JobIsolationError('INVALID_KNOWLEDGE_SCOPE', 'knowledge_scope contains an unknown scope');
    }
    seen.add(item);
  }
  if (!seen.has('JOB_LOCAL')) {
    throw new JobIsolationError('INVALID_KNOWLEDGE_SCOPE', 'knowledge_scope must include JOB_LOCAL');
  }
  return KNOWLEDGE_SCOPES.filter((scope) => seen.has(scope));
}

/**
 * Canonicalize execution_permissions: deduplicate and order canonically
 * (READ_ONLY, LOW_RISK_WRITE, CONFIG_WRITE, DELETE, SECRET_ACCESS).
 * READ_ONLY is required; empty and unknown permissions fail closed with
 * INVALID_EXECUTION_PERMISSIONS. These remain capability ceilings, never
 * approvals.
 */
function canonicalizeExecutionPermissions(rawPermissions) {
  if (!Array.isArray(rawPermissions)) {
    throw new JobIsolationError('INVALID_EXECUTION_PERMISSIONS', 'execution_permissions must be an array');
  }
  const seen = new Set();
  for (const item of rawPermissions) {
    if (typeof item !== 'string' || !EXECUTION_PERMISSIONS.includes(item)) {
      throw new JobIsolationError('INVALID_EXECUTION_PERMISSIONS', 'execution_permissions contains an unknown permission');
    }
    seen.add(item);
  }
  if (!seen.has('READ_ONLY')) {
    throw new JobIsolationError('INVALID_EXECUTION_PERMISSIONS', 'execution_permissions must include READ_ONLY');
  }
  return EXECUTION_PERMISSIONS.filter((permission) => seen.has(permission));
}

/**
 * Build the canonical frozen 8-field JobContract in canonical field order.
 * Arrays are copied and frozen so caller mutation cannot mutate the contract.
 */
function buildJobContract(fields) {
  const contract = {};
  for (const field of REQUIRED_FIELDS) {
    const value = fields[field];
    contract[field] = Array.isArray(value) ? Object.freeze(value.slice()) : value;
  }
  return Object.freeze(contract);
}

/**
 * CREATE a canonical JobContract from caller-controlled input.
 *
 * Input: { job_id, profile, knowledge_scope, execution_permissions }.
 * The four stored namespace fields are derived by the runtime; any caller
 * attempt to supply a derived namespace fails closed with
 * NAMESPACE_OVERRIDE_FORBIDDEN, and unknown unrelated input fails closed with
 * JOB_CONTRACT_INVALID. Schema closure is strict: every own key (enumerable,
 * non-enumerable, or symbol) is inspected.
 *
 * CREATE is explicit: an existing active canonical job_id in the supplied
 * persisted set always collides (JOB_ID_COLLISION), even when the input is
 * identical. Deterministic reuse is the separate REUSE operation.
 *
 * Returns the exact canonical frozen 8-field JobContract. This function does
 * not persist anything; persistence belongs to the caller.
 */
function createJobContract(input, persistedContracts) {
  if (!(persistedContracts instanceof Map)) {
    throw new JobIsolationError('JOB_CONTRACT_INVALID', 'persistedContracts must be a Map keyed by canonical job_id');
  }
  if (!isPlainObject(input)) {
    throw new JobIsolationError('JOB_CONTRACT_INVALID', 'Creation input must be a plain object');
  }
  // Strict own-key closure: every own key — enumerable, non-enumerable, or
  // symbol — is inspected. Derived namespace fields are runtime-owned; any
  // caller supply is an override attempt.
  const ownKeys = Reflect.ownKeys(input);
  for (const key of ownKeys) {
    if (typeof key === 'string' && NAMESPACE_FIELDS.includes(key)) {
      throw new JobIsolationError('NAMESPACE_OVERRIDE_FORBIDDEN', `Caller-supplied derived namespace: ${key}`);
    }
  }
  // Unknown unrelated creation input (including symbol own keys) fails closed.
  for (const key of ownKeys) {
    if (typeof key !== 'string' || !CREATION_INPUT_FIELDS.includes(key)) {
      throw new JobIsolationError('JOB_CONTRACT_INVALID', `Unknown creation input field: ${String(key)}`);
    }
  }
  // Required creation input.
  for (const field of CREATION_INPUT_FIELDS) {
    if (!ownKeys.includes(field)) {
      throw new JobIsolationError('JOB_CONTRACT_INVALID', `Missing required creation input: ${field}`);
    }
  }

  // Canonicalization in locked precedence order:
  // job identity -> profile binding -> namespace derivation -> knowledge -> permissions.
  const jobId = canonicalizeJobId(input.job_id);
  const profile = canonicalizeProfile(input.profile);
  const namespaces = deriveNamespaces(jobId);
  const knowledgeScope = canonicalizeKnowledgeScope(input.knowledge_scope);
  const executionPermissions = canonicalizeExecutionPermissions(input.execution_permissions);

  // Job identity boundary: CREATE never reuses an existing canonical job_id.
  if (persistedContracts.has(jobId)) {
    throw new JobIsolationError('JOB_ID_COLLISION', `Canonical job_id already exists: ${jobId}`);
  }

  return buildJobContract({
    job_id: jobId,
    profile,
    session_namespace: namespaces.session_namespace,
    knowledge_scope: knowledgeScope,
    evidence_namespace: namespaces.evidence_namespace,
    ledger_namespace: namespaces.ledger_namespace,
    runtime_state_namespace: namespaces.runtime_state_namespace,
    execution_permissions: executionPermissions,
  });
}

/**
 * Validate a persisted JobContract. Schema closure is strict: the own keys
 * (Reflect.ownKeys — enumerable, non-enumerable, and symbol keys included)
 * must equal exactly the locked eight string fields; anything else fails
 * closed with JOB_CONTRACT_INVALID.
 *
 * The persisted identity must already be canonical (no silent repair), the
 * profile must be in canonical bound form, the four namespace fields must
 * exactly match the deterministic derivation for the canonical job_id
 * (NAMESPACE_OVERRIDE_FORBIDDEN), and knowledge_scope / execution_permissions
 * must already be in canonical deduplicated order.
 *
 * Returns a frozen canonical copy. Validation never repairs an inconsistent
 * persisted contract.
 */
function validateJobContract(contract) {
  // 1. structural JobContract validity — strict own-key schema closure
  if (!isPlainObject(contract)) {
    throw new JobIsolationError('JOB_CONTRACT_INVALID', 'JobContract must be a plain object');
  }
  const ownKeys = Reflect.ownKeys(contract);
  for (const key of ownKeys) {
    if (typeof key !== 'string') {
      throw new JobIsolationError('JOB_CONTRACT_INVALID', 'JobContract must not contain symbol own properties');
    }
  }
  for (const key of ownKeys) {
    if (!REQUIRED_FIELDS.includes(key)) {
      throw new JobIsolationError('JOB_CONTRACT_INVALID', `Unknown JobContract field: ${key}`);
    }
  }
  for (const field of REQUIRED_FIELDS) {
    if (!ownKeys.includes(field)) {
      throw new JobIsolationError('JOB_CONTRACT_INVALID', `Missing required JobContract field: ${field}`);
    }
  }
  if (
    typeof contract.job_id !== 'string'
    || typeof contract.profile !== 'string'
    || !Array.isArray(contract.knowledge_scope)
    || !Array.isArray(contract.execution_permissions)
  ) {
    throw new JobIsolationError('JOB_CONTRACT_INVALID', 'JobContract field types are invalid');
  }
  for (const field of CONTRACT_NAMESPACE_FIELDS) {
    if (typeof contract[field] !== 'string') {
      throw new JobIsolationError('JOB_CONTRACT_INVALID', `Namespace field must be a string: ${field}`);
    }
  }

  // 2. canonical job_id — a non-canonical persisted identity is rejected, never repaired
  const canonicalJobId = canonicalizeJobId(contract.job_id);
  if (canonicalJobId !== contract.job_id) {
    throw new JobIsolationError('INVALID_JOB_ID', 'Persisted job_id is not canonical');
  }

  // 3. profile binding — persisted form must already be canonical
  const profile = assertPersistedProfile(contract.profile);

  // 4. namespace integrity — must exactly match deterministic derivation
  assertNamespaceIntegrity(canonicalJobId, contract);

  // 5. knowledge_scope — must already be canonical (no dedup/order repair)
  const knowledgeScope = canonicalizeKnowledgeScope(contract.knowledge_scope);
  if (!arraysEqual(knowledgeScope, contract.knowledge_scope)) {
    throw new JobIsolationError('INVALID_KNOWLEDGE_SCOPE', 'Persisted knowledge_scope is not in canonical form');
  }

  // 6. execution_permissions — must already be canonical
  const executionPermissions = canonicalizeExecutionPermissions(contract.execution_permissions);
  if (!arraysEqual(executionPermissions, contract.execution_permissions)) {
    throw new JobIsolationError('INVALID_EXECUTION_PERMISSIONS', 'Persisted execution_permissions are not in canonical form');
  }

  return buildJobContract({
    job_id: canonicalJobId,
    profile,
    session_namespace: contract.session_namespace,
    knowledge_scope: knowledgeScope,
    evidence_namespace: contract.evidence_namespace,
    ledger_namespace: contract.ledger_namespace,
    runtime_state_namespace: contract.runtime_state_namespace,
    execution_permissions: executionPermissions,
  });
}

/**
 * REUSE (resolve) a persisted canonical JobContract. Re-resolving the exact
 * persisted contract for the same canonical job is allowed and idempotent;
 * deterministic reuse is not duplicate creation.
 *
 * The presented contract is validated as a canonical JobContract and the
 * persisted entry is validated as well. REUSE of a contract with no persisted
 * counterpart fails closed (JOB_CONTRACT_INVALID). A different bound profile
 * fails closed with PROFILE_BINDING_MISMATCH; any other differing immutable
 * field fails closed with JOB_ID_COLLISION. No resume/recovery semantics
 * exist in v1.
 *
 * Returns a frozen canonical copy.
 */
function reuseJobContract(candidate, persistedContracts) {
  if (!(persistedContracts instanceof Map)) {
    throw new JobIsolationError('JOB_CONTRACT_INVALID', 'persistedContracts must be a Map keyed by canonical job_id');
  }
  const canonical = validateJobContract(candidate);
  const persisted = persistedContracts.get(canonical.job_id);
  if (persisted === undefined) {
    throw new JobIsolationError('JOB_CONTRACT_INVALID', 'REUSE requires an existing persisted canonical JobContract');
  }
  const persistedCanonical = validateJobContract(persisted);
  if (persistedCanonical.profile !== canonical.profile) {
    throw new JobIsolationError('PROFILE_BINDING_MISMATCH', 'Presented profile does not match the bound profile');
  }
  if (!contractsEqual(persistedCanonical, canonical)) {
    throw new JobIsolationError('JOB_ID_COLLISION', 'Presented immutable fields differ from the persisted contract');
  }
  return buildJobContract(canonical);
}

/**
 * Runtime profile binding comparison: trim only, case preserved. An exact
 * bound match passes; a valid but different profile fails closed with
 * PROFILE_BINDING_MISMATCH; a malformed profile fails closed with
 * PROFILE_BINDING_INVALID. No profile file is read.
 */
function assertProfileBinding(contract, profile) {
  const canonical = validateJobContract(contract);
  const boundProfile = canonicalizeProfile(profile);
  if (boundProfile !== canonical.profile) {
    throw new JobIsolationError('PROFILE_BINDING_MISMATCH', 'Profile does not match the active JobContract binding');
  }
  return true;
}

/**
 * Retrieve the job-bound execution-permission ceiling for the active job.
 *
 * Trust boundary: the ceiling is ALWAYS taken from the persisted canonical
 * active JobContract in `persistedContracts` (a Map keyed by canonical
 * job_id) — never from a caller-supplied clone. The candidate contract is
 * accepted only as proof of identity: it must be a canonical JobContract
 * whose job_id equals the active canonical job id and which matches the
 * persisted active contract exactly. Failure semantics:
 *   - malformed candidate: structural/canonical JobContract errors
 *   - malformed active identity: INVALID_JOB_ID
 *   - foreign active job: FOREIGN_JOB_REJECT
 *   - missing persisted active contract: JOB_CONTRACT_INVALID (fail closed)
 *   - profile mismatch: PROFILE_BINDING_MISMATCH
 *   - any other immutable difference (forged elevation): JOB_ID_COLLISION
 *
 * Returns a frozen copy bound to the job. The returned value is a capability
 * ceiling representation only: it authorizes nothing and approves nothing.
 * The approval gate and safe mode remain authoritative.
 */
function bindPermissionCeiling(candidate, activeJobId, persistedContracts) {
  if (!(persistedContracts instanceof Map)) {
    throw new JobIsolationError('JOB_CONTRACT_INVALID', 'persistedContracts must be a Map keyed by canonical job_id');
  }
  const candidateCanonical = validateJobContract(candidate);
  const activeCanonical = canonicalizeJobId(activeJobId);
  if (activeCanonical !== candidateCanonical.job_id) {
    throw new JobIsolationError('FOREIGN_JOB_REJECT', 'Active job id does not own this JobContract');
  }
  const persisted = persistedContracts.get(activeCanonical);
  if (persisted === undefined) {
    throw new JobIsolationError('JOB_CONTRACT_INVALID', 'No persisted active canonical JobContract for the active job id');
  }
  const persistedCanonical = validateJobContract(persisted);
  if (persistedCanonical.profile !== candidateCanonical.profile) {
    throw new JobIsolationError('PROFILE_BINDING_MISMATCH', 'Candidate profile does not match the persisted binding');
  }
  if (!contractsEqual(persistedCanonical, candidateCanonical)) {
    throw new JobIsolationError('JOB_ID_COLLISION', 'Candidate differs from the persisted active contract');
  }
  return Object.freeze({
    job_id: persistedCanonical.job_id,
    execution_permissions: Object.freeze(persistedCanonical.execution_permissions.slice()),
  });
}

module.exports = {
  JobIsolationError,
  JobIsolationPolicyError,
  validateJobContract,
  createJobContract,
  reuseJobContract,
  assertProfileBinding,
  bindPermissionCeiling,
};
