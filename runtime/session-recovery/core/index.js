/**
 * Phase 9C RecoverySession — Core Facade
 *
 * Combines RecoveryObject + Checkpoint into a single deterministic facade
 * for Phase 9C-03 (Recovery State Record + Checkpoint Identity Runtime Core).
 *
 * Implements ONLY:
 *   - RecoveryObject: identity, strict schema, CREATE/idempotency, policy_ref
 *   - Checkpoint:   id generation, monotonic sequence, latest-valid, dedup
 *
 * Does NOT implement (reserved for 9C-04+): transition engine, lifecycle
 * operations (START, RESUME, CLOSE, ARCHIVE, etc.), approval gates.
 *
 * Contract: governance/contracts/session-recovery-v1.md sections 4, 8
 * Policy:   governance/policies/session-recovery.json
 */

const {
  CANONICAL_STATES,
  CANONICAL_RECORD_FIELDS,
  CURRENT_POLICY_REF,
  SUPERSEDED_POLICY_REFS,
  ERR,
  normalizeJobId,
  validateSessionKey,
  derivePairKey,
  newRecoveryObject,
  validateRecord,
  identitiesMatch,
  tamperCheck,
  deterministicHash
} = require('./recovery-object');

const {
  createCheckpoint,
  resolveLatestValid,
  verifyMaxSequenced,
  checkDuplicateContent,
  verifyOwnership,
  findCheckpointById
} = require('./checkpoint');

// Checkpoint ERR aliases from recovery-object ERR (unified)
const CP_ERR = {
  CHECKPOINT_INVALID: ERR.CHECKPOINT_INVALID,
  CHECKPOINT_OWNERSHIP_MISMATCH: ERR.CHECKPOINT_OWNERSHIP_MISMATCH,
  IDEMPOTENT_REPLAY: ERR.IDEMPOTENT_REPLAY
};

// --- Public API ---

/**
 * Create a new RecoveryObject.
 * Returns { ok:true, record } or { ok:false, error, code }.
 * Idempotent: if an identical pair already exists, returns it unchanged.
 */
function createSession(store, rawJobId, rawSessionKey) {
  try {
    const jobId = normalizeJobId(rawJobId);
    const sessionKey = validateSessionKey(rawSessionKey);

    // Idempotent reuse: check for exact-pair match
    if (store && Array.isArray(store)) {
      for (const existing of store) {
        if (identitiesMatch(existing, { job_id: jobId, session_key: sessionKey })) {
          // Verify the existing record is still valid
          const tamper = tamperCheck(existing, jobId, sessionKey);
          if (!tamper.ok) return { ok: false, error: tamper.error, code: tamper.code };
          const validationErrors = validateRecord(existing);
          if (validationErrors) {
            const first = Array.isArray(validationErrors) ? validationErrors[0] : validationErrors;
            return { ok: false, error: first.message, code: first.code };
          }
          return { ok: true, record: existing, action: 'IDEMPOTENT_REUSE' };
        }
      }
    }

    const record = newRecoveryObject(jobId, sessionKey);
    // Persist created record into store for idempotency
    if (store && Array.isArray(store)) {
      store.push(record);
    }
    return { ok: true, record, action: 'CREATED' };
  } catch (e) {
    return { ok: false, error: e.message || 'CREATE failed', code: e.code || ERR.SESSION_RECOVERY_INVALID };
  }
}

/**
 * Validate a persisted record for compatibility.
 * Rejects superseded refs without migration/repair.
 * Returns null if valid, or { error, code } object.
 */
function validatePersisted(record) {
  const errors = validateRecord(record);
  if (errors) {
    const first = Array.isArray(errors) ? errors[0] : errors;
    return { error: first.message, code: first.code };
  }
  return null;
}

/**
 * Determine whether a record carries a superseded policy ref.
 */
function isSupersededRef(record) {
  return record && typeof record.policy_ref === 'string' && SUPERSEDED_POLICY_REFS.has(record.policy_ref);
}

/**
 * Create a checkpoint entry at the given sequence number.
 * No timestamps, no randomness, fully deterministic.
 */
function appendCheckpoint(jobId, sessionKey, seq, payload) {
  try {
    if (!Number.isInteger(seq) || seq < 1) {
      return { ok: false, error: 'checkpoint_seq must be >= 1', code: ERR.CHECKPOINT_INVALID };
    }
    const cp = createCheckpoint(jobId, sessionKey, seq, payload);
    return { ok: true, checkpoint: cp };
  } catch (e) {
    return { ok: false, error: e.message, code: ERR.VALIDATION_ERROR };
  }
}

/**
 * Resolve the latest valid checkpoint from a store.
 * Never falls back to older checkpoints on corruption.
 */
function getLatestValidCheckpoint(store) {
  if (!Array.isArray(store) || store.length === 0) {
    return { ok: false, error: 'No checkpoints available', code: CP_ERR.CHECKPOINT_INVALID };
  }
  return resolveLatestValid(store);
}

/**
 * Find a specific checkpoint by id within a store, verifying ownership.
 */
function resolveCheckpointById(store, checkpointId, jobId, sessionKey) {
  if (!Array.isArray(store)) {
    return { ok: false, error: 'Store must be an array', code: CP_ERR.CHECKPOINT_INVALID };
  }
  return findCheckpointById(store, checkpointId, jobId, sessionKey);
}

module.exports = {
  // Constants
  CANONICAL_STATES,
  CANONICAL_RECORD_FIELDS,
  CURRENT_POLICY_REF,
  SUPERSEDED_POLICY_REFS,
  ERR,

  // Factory
  createSession,

  // Validation
  validatePersisted,
  isSupersededRef,
  validateRecord,
  tamperCheck,

  // Checkpoint ops
  appendCheckpoint,
  getLatestValidCheckpoint,
  resolveCheckpointById,
  checkDuplicateContent,
  verifyMaxSequenced,
  verifyOwnership,
  resolveLatestValid,
  findCheckpointById,

  // Helpers
  normalizeJobId,
  validateSessionKey,
  identitiesMatch,
  derivePairKey,
  deriveCheckpointId: require('./checkpoint').deriveCheckpointId,
  deterministicHash
};
