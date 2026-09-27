/**
 * Context Hydration — Deterministic Ranking Policy
 *
 * Implements the exact deterministic scoring contract locked by
 * context-hydration@1.0.1 (governance/policies/context-hydration.json and
 * governance/contracts/context-hydration-v1.md section 8).
 *
 * Scope: term normalization, semantic relevance (Jaccard), scope specificity
 * (with foreign-job hard rejection), authority baseline, recency buckets,
 * quantize6 total score, and deterministic tie-break ordering.
 *
 * Deterministic by construction: no network, no LLM, no embeddings, no
 * per-candidate wall-clock reads, no environment access. The single immutable
 * run anchor is `hydration_started_at`, supplied by the caller.
 *
 * The latest valid checkpoint is mandatory context (H08) and is excluded by
 * the caller before ranking; this module ranks only the candidates it is given.
 */

const POLICY_ID = 'context-hydration';
const POLICY_VERSION = '1.0.1';
const POLICY_REF = 'context-hydration@1.0.1';

// Ranking weights — exact policy values, sum = 1.00.
const WEIGHTS = Object.freeze({
  semantic_relevance: 0.50,
  scope_specificity: 0.25,
  authority: 0.20,
  recency: 0.05,
});

// Recency bucket boundaries in seconds — exact policy constants.
const RECENCY_CONSTANTS_SECONDS = Object.freeze({
  ONE_DAY: 86400,
  SEVEN_DAYS: 604800,
  THIRTY_DAYS: 2592000,
  NINETY_DAYS: 7776000,
});

// Authority baseline — exact policy values. No other category is valid.
const AUTHORITY_BASELINE = Object.freeze({
  curated: 1.00,
  reviewed_session_fact: 0.90,
  historical_checkpoint: 0.80,
  semantic_memory: 0.50,
});

// Scope-specificity mapping — exact policy values.
const SCOPE_SCORES = Object.freeze({
  same_active_session: 1.00,
  same_active_job: 0.75,
  global_scope: 0.50,
  otherwise: 0.00,
});

/**
 * Normalize one retrieval term with the exact v1 pipeline:
 * NFKC -> lowercase -> trim -> collapse internal whitespace to one ASCII
 * space. Empty-after-normalization removal and deduplication are handled by
 * normalizeTerms().
 *
 * Non-string input is a contract violation and fails closed (TypeError).
 */
function normalizeTerm(term) {
  if (typeof term !== 'string') {
    const actual = term === null ? 'null' : typeof term;
    throw new TypeError(`retrieval term must be a string, got ${actual}`);
  }
  return term.normalize('NFKC').toLowerCase().trim().replace(/\s+/g, ' ');
}

/**
 * Normalize a retrieval-term array with the exact v1 pipeline:
 * NFKC -> lowercase -> trim -> collapse whitespace -> remove empty terms ->
 * deduplicate exact normalized terms. First-occurrence order is preserved.
 *
 * Non-array input or non-string entries fail closed (TypeError).
 */
function normalizeTerms(terms) {
  if (!Array.isArray(terms)) {
    throw new TypeError('retrieval terms must be an array');
  }
  const seen = new Set();
  const normalized = [];
  for (const term of terms) {
    const value = normalizeTerm(term);
    if (value === '') continue;
    if (seen.has(value)) continue;
    seen.add(value);
    normalized.push(value);
  }
  return normalized;
}

/**
 * Semantic relevance v1 — deterministic Jaccard similarity between the
 * normalized objective term set (O) and the normalized candidate term set (C):
 *
 *   |O ∩ C| / |O ∪ C|
 *
 * Empty union (both sides empty) yields 0. No network, LLM, or embeddings.
 */
function semanticRelevance(objectiveTerms, candidateTerms) {
  const objective = new Set(normalizeTerms(objectiveTerms));
  const candidate = new Set(normalizeTerms(candidateTerms));

  let intersection = 0;
  for (const term of objective) {
    if (candidate.has(term)) intersection += 1;
  }

  const union = objective.size + candidate.size - intersection;
  if (union === 0) return 0;
  return intersection / union;
}

/**
 * Foreign-job gate. A candidate is foreign only when it actually carries job
 * ownership: candidate.job_id is present/non-null AND differs from the active
 * job. Global candidates (job_id absent/null) are never foreign here.
 *
 * This gate runs BEFORE scoring. A conflicting job_id cannot escape rejection
 * through matching session metadata.
 */
function isForeignJob(candidate, activeJobId) {
  const jobId = candidate.job_id;
  const hasJobId = jobId !== null && jobId !== undefined;
  if (!hasJobId) return false;
  return jobId !== activeJobId;
}

/**
 * Scope specificity v1. Evaluation order is exact policy order:
 *   1. foreign job_id present and != active_job_id -> HARD REJECT
 *   2. same active session -> 1.00
 *   3. same active job    -> 0.75
 *   4. global scope + no job_id -> 0.50
 *   5. otherwise -> 0.00
 *
 * Foreign candidates must never receive a score; calling this function with
 * one fails closed (Error with code FOREIGN_JOB_REJECT).
 */
function scopeSpecificity(candidate, context) {
  if (isForeignJob(candidate, context.active_job_id)) {
    const error = new Error('FOREIGN_JOB_REJECT: candidate job_id conflicts with the active job');
    error.code = 'FOREIGN_JOB_REJECT';
    throw error;
  }

  const sessionId = candidate.session_id;
  if (sessionId !== null && sessionId !== undefined && sessionId === context.active_session_id) {
    return SCOPE_SCORES.same_active_session;
  }

  const jobId = candidate.job_id;
  if (jobId !== null && jobId !== undefined && jobId === context.active_job_id) {
    return SCOPE_SCORES.same_active_job;
  }

  if (candidate.scope === 'global' && (jobId === null || jobId === undefined)) {
    return SCOPE_SCORES.global_scope;
  }

  return SCOPE_SCORES.otherwise;
}

/**
 * Authority baseline lookup by candidate source_type. Returns the exact policy
 * value for the four known categories, or null for any unknown category.
 * Callers must treat null as fail-closed ineligibility — no score is invented.
 */
function authorityScore(sourceType) {
  if (Object.prototype.hasOwnProperty.call(AUTHORITY_BASELINE, sourceType)) {
    return AUTHORITY_BASELINE[sourceType];
  }
  return null;
}

/**
 * Recency v1. Age is measured against the single immutable run anchor:
 *
 *   age_seconds = max(0, hydration_started_at - candidate.updated_at)
 *
 * Buckets: <= 1 day -> 1.00, <= 7 days -> 0.75, <= 30 days -> 0.50,
 * <= 90 days -> 0.25, > 90 days -> 0.00. Future updated_at values floor to
 * age 0. No per-candidate wall-clock reads. Invalid timestamps fail closed.
 */
function recencyScore(updatedAt, hydrationStartedAt) {
  const anchorMs = Date.parse(hydrationStartedAt);
  if (Number.isNaN(anchorMs)) {
    throw new TypeError('hydration_started_at must be a valid RFC3339 UTC timestamp');
  }
  const updatedMs = Date.parse(updatedAt);
  if (Number.isNaN(updatedMs)) {
    throw new TypeError('candidate.updated_at must be a valid RFC3339 UTC timestamp');
  }

  const ageSeconds = Math.max(0, (anchorMs - updatedMs) / 1000);

  if (ageSeconds <= RECENCY_CONSTANTS_SECONDS.ONE_DAY) return 1.00;
  if (ageSeconds <= RECENCY_CONSTANTS_SECONDS.SEVEN_DAYS) return 0.75;
  if (ageSeconds <= RECENCY_CONSTANTS_SECONDS.THIRTY_DAYS) return 0.50;
  if (ageSeconds <= RECENCY_CONSTANTS_SECONDS.NINETY_DAYS) return 0.25;
  return 0.00;
}

/**
 * quantize6 — exact policy rounding:
 *
 *   floor((x * 1000000) + 0.5) / 1000000
 */
function quantize6(x) {
  return Math.floor((x * 1000000) + 0.5) / 1000000;
}

/**
 * Total score — exact policy formula, then quantize6:
 *
 *   raw_total = (semantic_relevance * 0.50) + (scope_specificity * 0.25)
 *             + (authority * 0.20) + (recency * 0.05)
 *   total_score = quantize6(raw_total)
 */
function totalScore(factors) {
  const rawTotal =
    (factors.semantic_relevance * WEIGHTS.semantic_relevance) +
    (factors.scope_specificity * WEIGHTS.scope_specificity) +
    (factors.authority * WEIGHTS.authority) +
    (factors.recency * WEIGHTS.recency);
  return quantize6(rawTotal);
}

/**
 * Deterministic tie-break comparator. Exact policy order:
 *   1. total_score DESC
 *   2. scope_specificity DESC
 *   3. authority DESC
 *   4. updated_at DESC (chronological instant)
 *   5. source_id ASC (UTF-16 code-unit order, no locale collation)
 */
function compareScoredCandidates(a, b) {
  if (a.total_score !== b.total_score) return b.total_score - a.total_score;
  if (a.scope_specificity !== b.scope_specificity) return b.scope_specificity - a.scope_specificity;
  if (a.authority !== b.authority) return b.authority - a.authority;

  const aUpdatedMs = Date.parse(a.updated_at);
  const bUpdatedMs = Date.parse(b.updated_at);
  if (aUpdatedMs !== bUpdatedMs) return bUpdatedMs - aUpdatedMs;

  if (a.source_id === b.source_id) return 0;
  return a.source_id < b.source_id ? -1 : 1;
}

/**
 * Rank candidates under policy 1.0.1.
 *
 * Input:
 *   {
 *     objective_retrieval_terms: string[],
 *     candidates: [{
 *       source_id, source_type, scope,
 *       session_id, job_id, updated_at, retrieval_terms
 *     }],
 *     active_job_id, active_session_id,
 *     hydration_started_at   // single immutable run anchor
 *   }
 *
 * Returns:
 *   {
 *     ranked:   eligible scored records in deterministic tie-break order,
 *               each = input candidate fields + semantic_relevance,
 *               scope_specificity, authority, recency, total_score,
 *     rejected: [{ source_id, reason }] in input order, where reason is
 *               'foreign_job' (hard gate before scoring) or
 *               'unknown_authority' (fail-closed ineligibility)
 *   }
 *
 * Inputs are never mutated; every emitted record is a new object.
 */
function rankCandidates(input) {
  if (!Array.isArray(input.candidates)) {
    throw new TypeError('candidates must be an array');
  }

  const objectiveTerms = normalizeTerms(input.objective_retrieval_terms);
  const context = {
    active_job_id: input.active_job_id,
    active_session_id: input.active_session_id,
  };

  const ranked = [];
  const rejected = [];

  for (const candidate of input.candidates) {
    if (isForeignJob(candidate, input.active_job_id)) {
      rejected.push({ source_id: candidate.source_id, reason: 'foreign_job' });
      continue;
    }

    const authority = authorityScore(candidate.source_type);
    if (authority === null) {
      rejected.push({ source_id: candidate.source_id, reason: 'unknown_authority' });
      continue;
    }

    const semantic = semanticRelevance(objectiveTerms, candidate.retrieval_terms);
    const scope = scopeSpecificity(candidate, context);
    const recency = recencyScore(candidate.updated_at, input.hydration_started_at);
    const score = totalScore({
      semantic_relevance: semantic,
      scope_specificity: scope,
      authority,
      recency,
    });

    ranked.push({
      ...candidate,
      semantic_relevance: semantic,
      scope_specificity: scope,
      authority,
      recency,
      total_score: score,
    });
  }

  ranked.sort(compareScoredCandidates);

  return { ranked, rejected };
}

module.exports = {
  POLICY_ID,
  POLICY_VERSION,
  POLICY_REF,
  WEIGHTS,
  RECENCY_CONSTANTS_SECONDS,
  AUTHORITY_BASELINE,
  SCOPE_SCORES,
  normalizeTerm,
  normalizeTerms,
  semanticRelevance,
  isForeignJob,
  scopeSpecificity,
  authorityScore,
  recencyScore,
  quantize6,
  totalScore,
  compareScoredCandidates,
  rankCandidates,
};
