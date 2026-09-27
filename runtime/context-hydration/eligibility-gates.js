'use strict';

/**
 * Context Hydration v1 — Eligibility Gates (9A-04 / Issue #11)
 *
 * Policy: context-hydration@1.0.1
 *
 * Deterministic, dependency-free candidate eligibility enforcement applied
 * after retrieval and before scoring/ranking. This module performs NO I/O
 * and imports nothing.
 *
 * Hard gates (policy retrieval.eligibility + ranking.scope_specificity):
 *   - candidate.job_id present/non-null AND != active_job_id -> HARD REJECT
 *   - scope=global + no job_id -> eligible (not a foreign-job candidate)
 *   - raw_source -> explicit request only, never automatic
 *   - semantic_memory -> advisory only, never authoritative
 *   - LOW confidence -> mandatory context only, automatic retrieval disabled
 *
 * Fail-closed rules:
 *   - Unknown/forbidden source_type (including mandatory context) -> ineligible
 *   - Missing/invalid candidate shape -> ineligible
 *   - Missing/invalid objective confidence -> LOW (mandatory-only)
 *
 * Deterministic per-candidate evaluation order:
 *   1. shape validation (fail closed)
 *   2. foreign-job hard reject (contract section 8.3 evaluation order, item 1)
 *   3. LOW-confidence mandatory-only gate (contract section 6)
 *   4. source access rules (contract section 6.2)
 *
 * Mandatory context is NOT a candidate source: it is loaded deterministically
 * by the pipeline and must never be converted into optional candidate
 * retrieval. This module fails closed on any attempt to route it as a
 * candidate.
 *
 * Output is a decision set only — no scores, no ordering, no budget.
 * Scoring/ranking is owned by a different lane.
 */

const CONFIDENCE_LEVELS = Object.freeze({
  HIGH: 'HIGH',
  MEDIUM: 'MEDIUM',
  LOW: 'LOW',
});

// Contract section 6: HIGH >= 0.80, MEDIUM >= 0.60, LOW < 0.60.
const CONFIDENCE_THRESHOLDS = Object.freeze({
  HIGH: 0.80,
  MEDIUM: 0.60,
});

const SOURCE_TYPES = Object.freeze({
  CURATED: 'curated',
  REVIEWED_SESSION_FACT: 'reviewed_session_fact',
  HISTORICAL_CHECKPOINT: 'historical_checkpoint',
  SEMANTIC_MEMORY: 'semantic_memory',
  RAW_SOURCE: 'raw_source',
});

// The only source types that may exist as retrieval candidates.
// Mandatory context and any unknown category are deliberately excluded.
const CANDIDATE_SOURCE_TYPES = Object.freeze([
  SOURCE_TYPES.CURATED,
  SOURCE_TYPES.REVIEWED_SESSION_FACT,
  SOURCE_TYPES.HISTORICAL_CHECKPOINT,
  SOURCE_TYPES.SEMANTIC_MEMORY,
  SOURCE_TYPES.RAW_SOURCE,
]);

const REASONS = Object.freeze({
  // rejections
  INVALID_CANDIDATE: 'INVALID_CANDIDATE',
  UNKNOWN_SOURCE_TYPE: 'UNKNOWN_SOURCE_TYPE',
  FOREIGN_JOB_HARD_REJECT: 'FOREIGN_JOB_HARD_REJECT',
  LOW_CONFIDENCE_MANDATORY_ONLY: 'LOW_CONFIDENCE_MANDATORY_ONLY',
  RAW_SOURCE_EXPLICIT_ONLY: 'RAW_SOURCE_EXPLICIT_ONLY',
  // eligibilities
  ELIGIBLE: 'ELIGIBLE',
  ELIGIBLE_ADVISORY: 'ELIGIBLE_ADVISORY',
  ELIGIBLE_EXPLICIT_RAW: 'ELIGIBLE_EXPLICIT_RAW',
});

function isPlainRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isKnownCandidateSourceType(sourceType) {
  return CANDIDATE_SOURCE_TYPES.includes(sourceType);
}

/**
 * Classify objective confidence per contract section 6.
 * Invalid or missing values fail closed to LOW (mandatory-only) —
 * no silent guess or escalation.
 */
function classifyConfidence(score) {
  if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 1) {
    return CONFIDENCE_LEVELS.LOW;
  }
  if (score >= CONFIDENCE_THRESHOLDS.HIGH) return CONFIDENCE_LEVELS.HIGH;
  if (score >= CONFIDENCE_THRESHOLDS.MEDIUM) return CONFIDENCE_LEVELS.MEDIUM;
  return CONFIDENCE_LEVELS.LOW;
}

function normalizeContext(context) {
  const ctx = isPlainRecord(context) ? context : {};
  return {
    active_job_id: ctx.active_job_id === undefined ? null : ctx.active_job_id,
    active_session_id: ctx.active_session_id === undefined ? null : ctx.active_session_id,
    objective_confidence: ctx.objective_confidence,
    raw_source_request: isPlainRecord(ctx.raw_source_request) ? ctx.raw_source_request : null,
  };
}

/**
 * Raw-source eligibility: only an explicit request naming the exact source id
 * makes a raw candidate eligible. Everything else is rejected.
 */
function isExplicitlyRequestedRawSource(sourceId, rawSourceRequest) {
  if (!isPlainRecord(rawSourceRequest) || rawSourceRequest.explicit !== true) return false;
  const sourceIds = rawSourceRequest.source_ids;
  if (!Array.isArray(sourceIds)) return false;
  return sourceIds.includes(sourceId);
}

function makeDecision(candidate, sourceId, sourceType, eligible, advisory, reason) {
  return {
    candidate,
    source_id: sourceId,
    source_type: sourceType,
    eligible,
    advisory,
    reason,
  };
}

/**
 * Evaluate a single candidate. `context` may be raw or pre-normalized and
 * `level` is optional (classified from context when omitted).
 * Never mutates the candidate or the context.
 */
function evaluateCandidate(candidate, context, level) {
  const ctx = normalizeContext(context);
  const resolvedLevel = level === undefined ? classifyConfidence(ctx.objective_confidence) : level;

  // 1. Shape validation — fail closed.
  if (!isPlainRecord(candidate)) {
    return makeDecision(candidate, null, null, false, false, REASONS.INVALID_CANDIDATE);
  }
  const sourceId = candidate.source_id;
  const sourceType = candidate.source_type === undefined ? null : candidate.source_type;
  if (typeof sourceId !== 'string' || sourceId.length === 0) {
    return makeDecision(candidate, null, sourceType, false, false, REASONS.INVALID_CANDIDATE);
  }
  if (!isKnownCandidateSourceType(sourceType)) {
    return makeDecision(candidate, sourceId, sourceType, false, false, REASONS.UNKNOWN_SOURCE_TYPE);
  }

  // 2. Foreign-job hard reject — contract section 8.3 evaluation order item 1.
  // Applies even when the candidate claims the active session, and is never
  // softened by the confidence gate below.
  const jobId = candidate.job_id;
  if (jobId !== null && jobId !== undefined && jobId !== ctx.active_job_id) {
    return makeDecision(candidate, sourceId, sourceType, false, false, REASONS.FOREIGN_JOB_HARD_REJECT);
  }

  // 3. LOW confidence — mandatory context only; all candidate retrieval is
  // disabled, including explicit raw requests (contract section 6:
  // "Mandatory context only").
  if (resolvedLevel === CONFIDENCE_LEVELS.LOW) {
    return makeDecision(candidate, sourceId, sourceType, false, false, REASONS.LOW_CONFIDENCE_MANDATORY_ONLY);
  }

  // 4. Source access rules — contract section 6.2.
  if (sourceType === SOURCE_TYPES.SEMANTIC_MEMORY) {
    // Advisory only; never authoritative.
    return makeDecision(candidate, sourceId, sourceType, true, true, REASONS.ELIGIBLE_ADVISORY);
  }
  if (sourceType === SOURCE_TYPES.RAW_SOURCE) {
    if (isExplicitlyRequestedRawSource(sourceId, ctx.raw_source_request)) {
      return makeDecision(candidate, sourceId, sourceType, true, false, REASONS.ELIGIBLE_EXPLICIT_RAW);
    }
    return makeDecision(candidate, sourceId, sourceType, false, false, REASONS.RAW_SOURCE_EXPLICIT_ONLY);
  }

  // curated / reviewed_session_fact / historical_checkpoint — automatic.
  return makeDecision(candidate, sourceId, sourceType, true, false, REASONS.ELIGIBLE);
}

/**
 * Evaluate a candidate list against the eligibility contract.
 *
 * Returns:
 *   {
 *     confidence: { score, level, automatic_retrieval_enabled },
 *     decisions: [ { candidate, source_id, source_type, eligible, advisory, reason } ],
 *     eligible:  [ decisions with eligible === true ],
 *     rejected:  [ decisions with eligible === false ],
 *   }
 *
 * Candidates and context are treated as immutable inputs.
 */
function evaluateEligibility(candidates, context) {
  if (!Array.isArray(candidates)) {
    throw new TypeError('evaluateEligibility: candidates must be an array');
  }
  const ctx = normalizeContext(context);
  const level = classifyConfidence(ctx.objective_confidence);

  const decisions = [];
  const eligible = [];
  const rejected = [];
  for (const candidate of candidates) {
    const decision = evaluateCandidate(candidate, ctx, level);
    decisions.push(decision);
    if (decision.eligible) {
      eligible.push(decision);
    } else {
      rejected.push(decision);
    }
  }

  const score =
    typeof ctx.objective_confidence === 'number' && Number.isFinite(ctx.objective_confidence)
      ? ctx.objective_confidence
      : null;

  return {
    confidence: {
      score,
      level,
      automatic_retrieval_enabled: level !== CONFIDENCE_LEVELS.LOW,
    },
    decisions,
    eligible,
    rejected,
  };
}

module.exports = {
  CONFIDENCE_LEVELS,
  CONFIDENCE_THRESHOLDS,
  SOURCE_TYPES,
  CANDIDATE_SOURCE_TYPES,
  REASONS,
  classifyConfidence,
  evaluateCandidate,
  evaluateEligibility,
};
