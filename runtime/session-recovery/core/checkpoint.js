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

/** Generate a deterministic checkpoint_id from canonical inputs. */
function deriveCheckpointId(jobId, sessionKey, checkpointSeq) {
  assert.strictEqual(typeof jobId, 'string');
  assert.strictEqual(typeof sessionKey, 'string');
  assert(Number.isInteger(checkpointSeq) && checkpointSeq >= 1);
  return `job:${jobId}:sessions:${sessionKey}:checkpoint:${checkpointSeq}`;
}

/** Create a new checkpoint entry. No timestamps, no randomness. */
function createCheckpoint(jobId, sessionKey, checkpointSeq, payload) {
  assert(Number.isInteger(checkpointSeq) && checkpointSeq >= 1);
  const checkpointId = deriveCheckpointId(jobId, sessionKey, checkpointSeq);
  const payloadDigest = crypto.createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex');
  return {
    checkpoint_id: checkpointId,
    checkpoint_seq: checkpointSeq,
    job_id: jobId,
    session_key: sessionKey,
    payload_digest: payloadDigest,
    outcome: 'APPLIED'
  };
}

/** Resolve the latest valid checkpoint from a list. Fails if none. */
function resolveLatestValid(checkpoints) {
  if (!checkpoints || checkpoints.length === 0) {
    return { error: 'No checkpoints available', code: ERR.CHECKPOINT_INVALID };
  }
  // Validated checkpoints sorted descending by seq; first valid is latest valid.
  const valid = checkpoints.filter(c => c && Number.isInteger(c.checkpoint_seq) && c.payload_digest && c.payload_digest.length > 0);
  if (valid.length === 0) {
    return { error: 'All checkpoints corrupt', code: ERR.CHECKPOINT_INVALID };
  }
  valid.sort((a, b) => b.checkpoint_seq - a.checkpoint_seq);
  return { ok: true, checkpoint: valid[0] };
}

/**
 * Find the maximum-seq checkpoint and verify its integrity.
 * Corrupted max => CHECKPOINT_INVALID, never fallback to older.
 */
function verifyMaxSequenced(checkpoints) {
  if (!checkpoints || checkpoints.length === 0) {
    return { error: 'No checkpoints available', code: ERR.CHECKPOINT_INVALID };
  }
  const maxItem = [...checkpoints].sort((a, b) => b.checkpoint_seq - a.checkpoint_seq)[0];
  if (!maxItem || !maxItem.payload_digest || maxItem.payload_digest.length === 0) {
    return { error: `Max-sequence checkpoint (${maxItem.checkpoint_seq}) invalid`, code: ERR.CHECKPOINT_INVALID };
  }
  return { ok: true, checkpoint: maxItem };
}

/**
 * Deduplicate checkpoint content. Scanned by payload_digest among same-pair records.
 * Returns IDEMPOTENT_REPLAY if duplicate found, or null if unique.
 */
function checkDuplicateContent(newPayloadDigest, existingCheckpoints) {
  if (!newPayloadDigest || typeof newPayloadDigest !== 'string') {
    return null; // cannot dedup without digest
  }
  for (const cp of existingCheckpoints) {
    if (cp.payload_digest === newPayloadDigest) {
      const id = cp.checkpoint_id || `unknown-${cp.checkpoint_seq}`;
      return { result: ERR.IDEMPOTENT_REPLAY, existing_checkpoint_id: id, consumed_seq: false };
    }
  }
  return null;
}

/** Verify checkpoint ownership against job and session keys. Returns FOREIGN_JOB_REJECT for foreign jobs, CHECKPOINT_OWNERSHIP_MISMATCH for same-job foreign sessions. */
function verifyOwnership(checkpoint, job_id, session_key) {
  if (checkpoint.job_id !== job_id) {
    return { error: 'Foreign job access', code: 'FOREIGN_JOB_REJECT' };
  }
  if (checkpoint.session_key !== session_key) {
    return { error: `Checkpoint belongs to different session: ${checkpoint.session_key}`, code: ERR.CHECKPOINT_OWNERSHIP_MISMATCH };
  }
  return { ok: true };
}

/**
 * Validate a checkpoint reference exists within the store and belongs to owner.
 * Returns { ok:true, checkpoint } or { error, code }.
 */
function findCheckpointById(store, checkpointId, job_id, session_key) {
  for (const cp of store) {
    if (cp.checkpoint_id === checkpointId) {
      const ownership = verifyOwnership(cp, job_id, session_key);
      if (ownership.ok) return { ok: true, checkpoint: cp };
      return ownership;
    }
  }
  return { error: `Checkpoint not found: ${checkpointId}`, code: ERR.CHECKPOINT_INVALID };
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
