/**
 * Phase 9C Checkpoint core module.
 *
 * Implements deterministic checkpoint_id generation, monotonic sequence,
 * latest-valid resolution, and duplicate-content idempotency.
 *
 * Contract: governance/contracts/session-recovery-v1.md section 8
 * Policy:   governance/policies/session-recovery.json
 */

const crypto = require('crypto');
const assert = require('assert');

const ERR = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  CHECKPOINT_OWNERSHIP_MISMATCH: 'CHECKPOINT_OWNERSHIP_MISMATCH',
  CHECKPOINT_INVALID: 'CHECKPOINT_INVALID',
  IDEMPOTENT_REPLAY: 'IDEMPOTENT_REPLAY'
};

function deriveCheckpointId(jobId, sessionKey, checkpointSeq) {
  assert.strictEqual(typeof jobId, 'string');
  assert.strictEqual(typeof sessionKey, 'string');
  assert(Number.isInteger(checkpointSeq) && checkpointSeq >= 1);
  return `job:${jobId}:sessions:${sessionKey}:checkpoint:${checkpointSeq}`;
}

function createCheckpoint(jobId, sessionKey, checkpointSeq, payload) {
  assert(Number.isInteger(checkpointSeq) && checkpointSeq >= 1);
  const checkpointId = deriveCheckpointId(jobId, sessionKey, checkpointSeq);
  const payloadDigest = crypto.createHash('sha256')
    .update(JSON.stringify(payload), 'utf8')
    .digest('hex');
  return {
    checkpoint_id: checkpointId,
    checkpoint_seq: checkpointSeq,
    job_id: jobId,
    session_key: sessionKey,
    payload_digest: payloadDigest,
    outcome: 'APPLIED'
  };
}

function isIntegrityValid(checkpoint) {
  return Boolean(
    checkpoint &&
    Number.isInteger(checkpoint.checkpoint_seq) &&
    checkpoint.checkpoint_seq >= 1 &&
    typeof checkpoint.payload_digest === 'string' &&
    checkpoint.payload_digest.length > 0
  );
}

/**
 * Identify the maximum checkpoint_seq FIRST, then validate only that entry.
 * A corrupt maximum fails closed. No older checkpoint is ever selected.
 */
function resolveLatestValid(checkpoints) {
  if (!Array.isArray(checkpoints) || checkpoints.length === 0) {
    return { ok: false, error: 'No checkpoints available', code: ERR.CHECKPOINT_INVALID };
  }

  const ordered = checkpoints.slice().sort((a, b) => {
    const aSeq = Number.isInteger(a && a.checkpoint_seq) ? a.checkpoint_seq : -Infinity;
    const bSeq = Number.isInteger(b && b.checkpoint_seq) ? b.checkpoint_seq : -Infinity;
    return bSeq - aSeq;
  });

  const maxItem = ordered[0];
  if (!isIntegrityValid(maxItem)) {
    return {
      ok: false,
      error: `Max-sequence checkpoint (${maxItem && maxItem.checkpoint_seq}) invalid`,
      code: ERR.CHECKPOINT_INVALID
    };
  }

  return { ok: true, checkpoint: maxItem };
}

function verifyMaxSequenced(checkpoints) {
  return resolveLatestValid(checkpoints);
}

function checkDuplicateContent(newPayloadDigest, existingCheckpoints) {
  if (!newPayloadDigest || typeof newPayloadDigest !== 'string' || !Array.isArray(existingCheckpoints)) {
    return null;
  }
  for (const cp of existingCheckpoints) {
    if (cp && cp.payload_digest === newPayloadDigest) {
      return {
        result: ERR.IDEMPOTENT_REPLAY,
        existing_checkpoint_id: cp.checkpoint_id || `unknown-${cp.checkpoint_seq}`,
        consumed_seq: false
      };
    }
  }
  return null;
}

function verifyOwnership(checkpoint, job_id, session_key) {
  if (!checkpoint || checkpoint.job_id !== job_id) {
    return { error: 'Foreign job access', code: 'FOREIGN_JOB_REJECT' };
  }
  if (checkpoint.session_key !== session_key) {
    return {
      error: `Checkpoint belongs to different session: ${checkpoint.session_key}`,
      code: ERR.CHECKPOINT_OWNERSHIP_MISMATCH
    };
  }
  return { ok: true };
}

function findCheckpointById(store, checkpointId, job_id, session_key) {
  if (!Array.isArray(store)) {
    return { error: 'Store must be an array', code: ERR.CHECKPOINT_INVALID };
  }
  for (const cp of store) {
    if (cp && cp.checkpoint_id === checkpointId) {
      const ownership = verifyOwnership(cp, job_id, session_key);
      if (ownership.ok) return { ok: true, checkpoint: cp };
      return ownership;
    }
  }
  return {
    error: `Checkpoint not found: ${checkpointId}`,
    code: ERR.CHECKPOINT_INVALID
  };
}

module.exports = {
  ERR,
  deriveCheckpointId,
  createCheckpoint,
  resolveLatestValid,
  verifyMaxSequenced,
  checkDuplicateContent,
  verifyOwnership,
  findCheckpointById
};
