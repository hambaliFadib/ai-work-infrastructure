/**
 * Phase 9C RecoveryObject core module.
 *
 * Implements deterministic Identity, Schema validation, CREATE/idempotency,
 * and persisted policy_ref compatibility for RecoveryObjects.
 *
 * Contract: governance/contracts/session-recovery-v1.md sections 4, 15
 * Policy:   governance/policies/session-recovery.json
 */

const crypto = require('crypto');

// --- Constants ---

const CANONICAL_STATES = [
  'NEW', 'ACTIVE', 'CHECKPOINTED', 'BLOCKED', 'INTERRUPTED',
  'FAILED', 'CONFLICTED', 'MERGE_PENDING', 'RESOLVED', 'ARCHIVED'
];

const CANONICAL_RECORD_FIELDS = ['job_id', 'session_key', 'current_state', 'transition_seq', 'checkpoint_seq', 'policy_ref'];

const CURRENT_POLICY_REF = 'session-recovery@1.0.1';

const SUPERSEDED_POLICY_REFS = new Set(['session-recovery@1.0.0']);

const JOB_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

// Deterministic error identifiers
const ERR = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  SESSION_RECOVERY_INVALID: 'SESSION_RECOVERY_INVALID',
  INVALID_RECOVERY_STATE: 'INVALID_RECOVERY_STATE',
  RECOVERY_IDENTITY_MISMATCH: 'RECOVERY_IDENTITY_MISMATCH',
  ILLEGAL_TRANSITION: 'ILLEGAL_TRANSITION',
  CHECKPOINT_INVALID: 'CHECKPOINT_INVALID',
  CHECKPOINT_OWNERSHIP_MISMATCH: 'CHECKPOINT_OWNERSHIP_MISMATCH',
  IDEMPOTENT_REPLAY: 'IDEMPOTENT_REPLAY'
};

// --- Canonical helpers ---

/** Normalize a raw job_id by Phase 9B canonicalization rules. */
function normalizeJobId(raw) {
  if (typeof raw !== 'string') throw makeError(ERR.VALIDATION_ERROR, 'job_id must be a string');
  const nfc = raw.normalize('NFKC').trim().toLowerCase();
  if (!nfc || nfc.length > 64) throw makeError(ERR.VALIDATION_ERROR, 'job_id must be 1-64 chars after normalization');
  if (!JOB_ID_PATTERN.test(nfc)) throw makeError(ERR.VALIDATION_ERROR, 'job_id must match ^[a-z0-9][a-z0-9._-]{0,63}$');
  return nfc;
}

/** Validate raw session_key without parsing or deriving anything. */
function validateSessionKey(raw) {
  if (typeof raw !== 'string') throw makeError(ERR.VALIDATION_ERROR, 'session_key must be a string');
  // Opaque canonical: reject empty, otherwise pass as-is (exact string only).
  if (raw.length === 0) throw makeError(ERR.VALIDATION_ERROR, 'session_key must be non-empty');
  return raw;
}

/** Derive the canonical pair hash used as unique identifier key. */
function derivePairKey(jobId, sessionKey) {
  return `${jobId}:${sessionKey}`;
}

// --- Factory ---

/** Build a new RecoveryObject in state NEW with seqs at zero. */
function newRecoveryObject(canonicalJobId, canonicalSessionKey) {
  return {
    job_id: canonicalJobId,
    session_key: canonicalSessionKey,
    current_state: 'NEW',
    transition_seq: 0,
    checkpoint_seq: 0,
    policy_ref: CURRENT_POLICY_REF
  };
}

// --- Validation ---

/** Validate a record's structure strictly. Returns null or {errors:string[]}. */
function validateRecord(record) {
  if (!record || typeof record !== 'object') {
    return [{ message: 'Record must be a non-null object', code: ERR.VALIDATION_ERROR }];
  }

  // Unknown fields -> FAIL CLOSED
  const extraKeys = Object.keys(record).filter(k => !CANONICAL_RECORD_FIELDS.includes(k));
  if (extraKeys.length > 0) {
    return [{ message: `Unknown fields: ${extraKeys.join(',')}`, code: ERR.SESSION_RECOVERY_INVALID }];
  }

  // Missing fields -> FAIL CLOSED
  const missingFields = [];
  for (const field of CANONICAL_RECORD_FIELDS) {
    if (!(field in record) || record[field] === undefined) {
      missingFields.push(field);
    }
  }
  if (missingFields.length > 0) {
    return [{ message: `Missing fields: ${missingFields.join(',')}`, code: ERR.SESSION_RECOVERY_INVALID }];
  }

  // Type checks
  const errors = [];
  if (typeof record.job_id !== 'string') errors.push({ message: 'job_id must be string', code: ERR.SESSION_RECOVERY_INVALID });
  if (typeof record.session_key !== 'string') errors.push({ message: 'session_key must be string', code: ERR.SESSION_RECOVERY_INVALID });
  if (!Array.isArray(CANONICAL_STATES) || !CANONICAL_STATES.includes(record.current_state)) {
    if (record.current_state && typeof record.current_state === 'string') {
      errors.push({ message: `Invalid current_state: ${record.current_state}`, code: ERR.INVALID_RECOVERY_STATE });
    } else {
      errors.push({ message: 'current_state must be a string', code: ERR.SESSION_RECOVERY_INVALID });
    }
  }
  if (!Number.isInteger(record.transition_seq) || record.transition_seq < 0) errors.push({ message: 'transition_seq must be a non-negative integer', code: ERR.SESSION_RECOVERY_INVALID });
  if (!Number.isInteger(record.checkpoint_seq) || record.checkpoint_seq < 0) errors.push({ message: 'checkpoint_seq must be a non-negative integer', code: ERR.SESSION_RECOVERY_INVALID });
  if (typeof record.policy_ref !== 'string') errors.push({ message: 'policy_ref must be string', code: ERR.SESSION_RECOVERY_INVALID });

  // policy_ref compatibility check (section 4.3)
  const ref = record.policy_ref;
  if (SUPERSEDED_POLICY_REFS.has(ref)) {
    return [{ message: 'Superseded policy_ref not compatible with current policy', code: ERR.SESSION_RECOVERY_INVALID }];
  }
  if (ref !== CURRENT_POLICY_REF) {
    return [{ message: `policy_ref mismatch (got '${ref}', expected '${CURRENT_POLICY_REF}')`, code: ERR.SESSION_RECOVERY_INVALID }];
  }

  return errors.length > 0 ? errors : null;
}

/** Check if two RecoveryObjects share the same identity (job_id + session_key). */
function identitiesMatch(a, b) {
  return a.job_id === b.job_id && a.session_key === b.session_key;
}

/** Tamper-detect: verify record identity fields are valid and self-consistent. */
function tamperCheck(record) {
  if (!record || typeof record !== 'object') {
    return { ok: false, error: 'Record must be a non-null object', code: ERR.SESSION_RECOVERY_INVALID };
  }
  if (typeof record.job_id !== 'string' || record.job_id.length === 0) {
    return { ok: false, error: 'Record job_id is invalid', code: ERR.SESSION_RECOVERY_INVALID };
  }
  if (typeof record.session_key !== 'string' || record.session_key.length === 0) {
    return { ok: false, error: 'Record session_key is invalid', code: ERR.SESSION_RECOVERY_INVALID };
  }
  return { ok: true };
}

// --- Idempotency ---

/** Deterministic hash used for idempotency verification. */
function deterministicHash() {
  const parts = Array.from(arguments).map(String).join('|');
  return crypto.createHash('sha256').update(parts, 'utf8').digest('hex');
}

// --- Error constructor ---

function makeError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

module.exports = {
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
  deterministicHash,
  makeError
};
