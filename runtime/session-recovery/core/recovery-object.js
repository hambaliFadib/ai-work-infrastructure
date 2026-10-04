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

const CANONICAL_STATES = Object.freeze([
  'NEW', 'ACTIVE', 'CHECKPOINTED', 'BLOCKED', 'INTERRUPTED',
  'FAILED', 'CONFLICTED', 'MERGE_PENDING', 'RESOLVED', 'ARCHIVED'
]);

const CANONICAL_RECORD_FIELDS = Object.freeze([
  'job_id', 'session_key', 'current_state',
  'transition_seq', 'checkpoint_seq', 'policy_ref'
]);

const CURRENT_POLICY_REF = 'session-recovery@1.0.1';
const SUPERSEDED_POLICY_REFS = new Set(['session-recovery@1.0.0']);
const JOB_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

const ERR = Object.freeze({
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  SESSION_RECOVERY_INVALID: 'SESSION_RECOVERY_INVALID',
  INVALID_RECOVERY_STATE: 'INVALID_RECOVERY_STATE',
  RECOVERY_IDENTITY_MISMATCH: 'RECOVERY_IDENTITY_MISMATCH',
  ILLEGAL_TRANSITION: 'ILLEGAL_TRANSITION',
  CHECKPOINT_INVALID: 'CHECKPOINT_INVALID',
  CHECKPOINT_OWNERSHIP_MISMATCH: 'CHECKPOINT_OWNERSHIP_MISMATCH',
  IDEMPOTENT_REPLAY: 'IDEMPOTENT_REPLAY'
});

function makeError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function normalizeJobId(raw) {
  if (typeof raw !== 'string') {
    throw makeError(ERR.VALIDATION_ERROR, 'job_id must be a string');
  }
  const canonical = raw.normalize('NFKC').trim().toLowerCase();
  if (!canonical || canonical.length > 64) {
    throw makeError(ERR.VALIDATION_ERROR, 'job_id must be 1-64 chars after normalization');
  }
  if (!JOB_ID_PATTERN.test(canonical)) {
    throw makeError(ERR.VALIDATION_ERROR, 'job_id must match ^[a-z0-9][a-z0-9._-]{0,63}$');
  }
  return canonical;
}

function isCanonicalJobId(value) {
  if (typeof value !== 'string') return false;
  return value === value.normalize('NFKC').trim().toLowerCase()
    && JOB_ID_PATTERN.test(value);
}

function validateSessionKey(raw) {
  if (typeof raw !== 'string') {
    throw makeError(ERR.VALIDATION_ERROR, 'session_key must be a string');
  }
  if (raw.length === 0) {
    throw makeError(ERR.VALIDATION_ERROR, 'session_key must be non-empty');
  }
  return raw;
}

function derivePairKey(jobId, sessionKey) {
  return `${jobId}:${sessionKey}`;
}

function isPlainDataRecord(record) {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) {
    return false;
  }
  const proto = Object.getPrototypeOf(record);
  return proto === Object.prototype || proto === null;
}

function getCanonicalDescriptors(record) {
  if (!isPlainDataRecord(record)) {
    return { ok: false, errors: [{
      message: 'Record must be a plain data record',
      code: ERR.SESSION_RECOVERY_INVALID
    }] };
  }

  const keys = Reflect.ownKeys(record);
  if (keys.length !== CANONICAL_RECORD_FIELDS.length) {
    return { ok: false, errors: [{
      message: 'Record must contain exactly six canonical fields',
      code: ERR.SESSION_RECOVERY_INVALID
    }] };
  }

  for (const key of keys) {
    if (typeof key !== 'string' || !CANONICAL_RECORD_FIELDS.includes(key)) {
      return { ok: false, errors: [{
        message: `Unknown fields are not permitted: ${String(key)}`,
        code: ERR.SESSION_RECOVERY_INVALID
      }] };
    }
  }

  const values = {};
  for (const field of CANONICAL_RECORD_FIELDS) {
    const descriptor = Object.getOwnPropertyDescriptor(record, field);
    if (!descriptor) {
      return { ok: false, errors: [{
        message: `Missing field: ${field}`,
        code: ERR.SESSION_RECOVERY_INVALID
      }] };
    }
    if (descriptor.get !== undefined || descriptor.set !== undefined) {
      return { ok: false, errors: [{
        message: `Accessor-backed field is not permitted: ${field}`,
        code: ERR.SESSION_RECOVERY_INVALID
      }] };
    }
    values[field] = descriptor.value;
  }
  return { ok: true, values };
}

function newRecoveryObject(canonicalJobId, canonicalSessionKey) {
  return Object.freeze({
    job_id: canonicalJobId,
    session_key: canonicalSessionKey,
    current_state: 'NEW',
    transition_seq: 0,
    checkpoint_seq: 0,
    policy_ref: CURRENT_POLICY_REF
  });
}

function validateRecord(record) {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) {
    return [{
      message: 'Record must be a non-null plain object',
      code: ERR.VALIDATION_ERROR
    }];
  }

  const structural = getCanonicalDescriptors(record);
  if (!structural.ok) return structural.errors;
  const values = structural.values;

  const errors = [];

  if (!isCanonicalJobId(values.job_id)) {
    errors.push({
      message: 'job_id is not already canonical',
      code: ERR.SESSION_RECOVERY_INVALID
    });
  }

  if (typeof values.session_key !== 'string' || values.session_key.length === 0) {
    errors.push({
      message: 'session_key must be a non-empty string',
      code: ERR.SESSION_RECOVERY_INVALID
    });
  }

  if (typeof values.current_state !== 'string' || !CANONICAL_STATES.includes(values.current_state)) {
    if (typeof values.current_state === 'string' && values.current_state.length > 0) {
      errors.push({
        message: `Invalid current_state: ${values.current_state}`,
        code: ERR.INVALID_RECOVERY_STATE
      });
    } else {
      errors.push({
        message: 'current_state must be a canonical state string',
        code: ERR.SESSION_RECOVERY_INVALID
      });
    }
  }

  if (!Number.isInteger(values.transition_seq) || values.transition_seq < 0) {
    errors.push({
      message: 'transition_seq must be a non-negative integer',
      code: ERR.SESSION_RECOVERY_INVALID
    });
  }

  if (!Number.isInteger(values.checkpoint_seq) || values.checkpoint_seq < 0) {
    errors.push({
      message: 'checkpoint_seq must be a non-negative integer',
      code: ERR.SESSION_RECOVERY_INVALID
    });
  }

  if (typeof values.policy_ref !== 'string' || values.policy_ref !== CURRENT_POLICY_REF) {
    errors.push({
      message: `policy_ref mismatch (got '${values.policy_ref}', expected '${CURRENT_POLICY_REF}')`,
      code: ERR.SESSION_RECOVERY_INVALID
    });
  }

  return errors.length > 0 ? errors : null;
}

function identitiesMatch(a, b) {
  return Boolean(a && b && a.job_id === b.job_id && a.session_key === b.session_key);
}

function tamperCheck(record, expectedJobId, expectedSessionKey) {
  const errors = validateRecord(record);
  if (errors) {
    const first = errors[0];
    return { ok: false, error: first.message, code: first.code };
  }

  if (expectedJobId !== undefined || expectedSessionKey !== undefined) {
    let canonicalExpectedJobId;
    try {
      canonicalExpectedJobId = normalizeJobId(expectedJobId);
    } catch (_) {
      return {
        ok: false,
        error: 'Expected job identity is invalid',
        code: ERR.RECOVERY_IDENTITY_MISMATCH
      };
    }

    if (record.job_id !== canonicalExpectedJobId || record.session_key !== expectedSessionKey) {
      return {
        ok: false,
        error: 'Persisted identity does not match the expected recovery object identity',
        code: ERR.RECOVERY_IDENTITY_MISMATCH
      };
    }
  }

  return { ok: true };
}

function deterministicHash() {
  const parts = Array.from(arguments).map(String).join('|');
  return crypto.createHash('sha256').update(parts, 'utf8').digest('hex');
}

module.exports = {
  CANONICAL_STATES,
  CANONICAL_RECORD_FIELDS,
  CURRENT_POLICY_REF,
  SUPERSEDED_POLICY_REFS,
  ERR,
  normalizeJobId,
  isCanonicalJobId,
  validateSessionKey,
  derivePairKey,
  newRecoveryObject,
  validateRecord,
  identitiesMatch,
  tamperCheck,
  deterministicHash,
  makeError
};
