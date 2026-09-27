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
 * Determinism guarantees:
 * - Scoring uses exact rational (BigInt) arithmetic. Policy weights and factor
 *   values are integer-scaled (1/100 units), semantic relevance is an exact
 *   intersection/union fraction, and quantize6 is applied to the exact rational
 *   total, so binary floating drift can never move a half-micro boundary.
 * - Timestamps are parsed with a strict RFC3339 UTC parser (syntax AND calendar
 *   validation) that preserves full fractional-second precision. Recency age
 *   and the updated_at tie-break use exact parsed values — never Date.parse
 *   millisecond truncation.
 * - No network, no LLM, no embeddings, no per-candidate wall-clock reads, no
 *   environment access. The single immutable run anchor is `hydration_started_at`.
 *
 * The latest valid checkpoint is mandatory context (H08) and is excluded by
 * the caller before ranking; this module ranks only the candidates it is given.
 */

const POLICY_ID = 'context-hydration';
const POLICY_VERSION = '1.0.1';
const POLICY_REF = 'context-hydration@1.0.1';

// Ranking weights — exact policy values, sum = 1.00. Integer-scaled (1/100
// units) so the scoring path never depends on binary floating representations;
// the public numeric values are derived from the exact units.
const WEIGHT_UNITS = Object.freeze({
  semantic_relevance: 50,
  scope_specificity: 25,
  authority: 20,
  recency: 5,
});

const WEIGHTS = Object.freeze({
  semantic_relevance: WEIGHT_UNITS.semantic_relevance / 100,
  scope_specificity: WEIGHT_UNITS.scope_specificity / 100,
  authority: WEIGHT_UNITS.authority / 100,
  recency: WEIGHT_UNITS.recency / 100,
});

// Exact weight fractions (BigInt) for the rational scoring core.
const WEIGHT_FRACTIONS = Object.freeze({
  semantic_relevance: Object.freeze({ n: BigInt(WEIGHT_UNITS.semantic_relevance), d: 100n }),
  scope_specificity: Object.freeze({ n: BigInt(WEIGHT_UNITS.scope_specificity), d: 100n }),
  authority: Object.freeze({ n: BigInt(WEIGHT_UNITS.authority), d: 100n }),
  recency: Object.freeze({ n: BigInt(WEIGHT_UNITS.recency), d: 100n }),
});

// Recency bucket boundaries in seconds — exact policy constants.
const RECENCY_CONSTANTS_SECONDS = Object.freeze({
  ONE_DAY: 86400,
  SEVEN_DAYS: 604800,
  THIRTY_DAYS: 2592000,
  NINETY_DAYS: 7776000,
});

const RECENCY_SECONDS_BIGINT = Object.freeze({
  ONE_DAY: BigInt(RECENCY_CONSTANTS_SECONDS.ONE_DAY),
  SEVEN_DAYS: BigInt(RECENCY_CONSTANTS_SECONDS.SEVEN_DAYS),
  THIRTY_DAYS: BigInt(RECENCY_CONSTANTS_SECONDS.THIRTY_DAYS),
  NINETY_DAYS: BigInt(RECENCY_CONSTANTS_SECONDS.NINETY_DAYS),
});

// Exact centi-unit recency scores for the scoring path.
const RECENCY_CENTI = Object.freeze({
  ONE_DAY: 100,
  SEVEN_DAYS: 75,
  THIRTY_DAYS: 50,
  NINETY_DAYS: 25,
  OLDER: 0,
});

// Exact centi-unit scope values; the public numeric map is derived from them.
const SCOPE_CENTI = Object.freeze({
  same_active_session: 100,
  same_active_job: 75,
  global_scope: 50,
  otherwise: 0,
});

const SCOPE_SCORES = Object.freeze({
  same_active_session: SCOPE_CENTI.same_active_session / 100,
  same_active_job: SCOPE_CENTI.same_active_job / 100,
  global_scope: SCOPE_CENTI.global_scope / 100,
  otherwise: SCOPE_CENTI.otherwise / 100,
});

// Exact centi-unit authority values; the public numeric map is derived from them.
const AUTHORITY_CENTI = Object.freeze({
  curated: 100,
  reviewed_session_fact: 90,
  historical_checkpoint: 80,
  semantic_memory: 50,
});

const AUTHORITY_BASELINE = Object.freeze({
  curated: AUTHORITY_CENTI.curated / 100,
  reviewed_session_fact: AUTHORITY_CENTI.reviewed_session_fact / 100,
  historical_checkpoint: AUTHORITY_CENTI.historical_checkpoint / 100,
  semantic_memory: AUTHORITY_CENTI.semantic_memory / 100,
});

// --- Exact rational core (BigInt) — scoring never depends on binary floats ---

function gcdBigInt(a, b) {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) {
    const remainder = x % y;
    x = y;
    y = remainder;
  }
  return x;
}

/** Reduce a non-negative rational { n, d } (d > 0) to lowest terms. */
function reduceFraction(n, d) {
  if (d <= 0n) throw new Error('rational denominator must be positive');
  if (n === 0n) return { n: 0n, d: 1n };
  const g = gcdBigInt(n, d);
  return { n: n / g, d: d / g };
}

function addFractions(a, b) {
  return reduceFraction(a.n * b.d + b.n * a.d, a.d * b.d);
}

function multiplyFractions(a, b) {
  return reduceFraction(a.n * b.n, a.d * b.d);
}

/**
 * quantize6 applied to an exact rational:
 *
 *   floor((n/d) * 1000000 + 0.5) / 1000000
 *   = floor((2 * n * 1000000 + d) / (2 * d)) / 1000000
 *
 * computed entirely in BigInt so no binary floating drift can move a
 * half-micro boundary.
 */
function quantize6Fraction(fraction) {
  const microUnits = (2000000n * fraction.n + fraction.d) / (2n * fraction.d);
  return Number(microUnits) / 1000000;
}

/**
 * Convert a non-negative finite Number to its exact rational value via the
 * IEEE-754 binary representation. Used only by the public totalScore helper;
 * the ranking path builds exact fractions directly from integer sources.
 */
function numberToFraction(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TypeError('score factor must be a non-negative finite number');
  }
  if (value === 0) return { n: 0n, d: 1n };

  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  const bits = view.getBigUint64(0);
  const exponentBits = Number((bits >> 52n) & 0x7ffn);
  const mantissaBits = bits & 0xfffffffffffffn;

  let mantissa;
  let exponent;
  if (exponentBits === 0) {
    mantissa = mantissaBits;
    exponent = -1074;
  } else {
    mantissa = mantissaBits | 0x10000000000000n;
    exponent = exponentBits - 1075;
  }

  let n = mantissa;
  let d = 1n;
  if (exponent >= 0) {
    n <<= BigInt(exponent);
  } else {
    d <<= BigInt(-exponent);
  }
  return reduceFraction(n, d);
}

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
 * Jaccard counts between the normalized objective term set (O) and the
 * normalized candidate term set (C). These integers are the exact source of
 * semantic relevance: |O ∩ C| / |O ∪ C| (union is 0 when both sides empty).
 */
function jaccardCounts(objectiveTerms, candidateTerms) {
  const objective = new Set(normalizeTerms(objectiveTerms));
  const candidate = new Set(normalizeTerms(candidateTerms));

  let intersection = 0;
  for (const term of objective) {
    if (candidate.has(term)) intersection += 1;
  }

  return { intersection, union: objective.size + candidate.size - intersection };
}

/**
 * Semantic relevance v1 — deterministic Jaccard similarity between the
 * normalized objective and candidate term sets; empty union yields 0.
 * No network, LLM, or embeddings.
 */
function semanticRelevance(objectiveTerms, candidateTerms) {
  const counts = jaccardCounts(objectiveTerms, candidateTerms);
  if (counts.union === 0) return 0;
  return counts.intersection / counts.union;
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
 * Scope specificity v1 in exact centi-units. Evaluation order is exact policy
 * order:
 *   1. foreign job_id present and != active_job_id -> HARD REJECT
 *   2. same active session -> 100
 *   3. same active job    -> 75
 *   4. global scope + no job_id -> 50
 *   5. otherwise -> 0
 *
 * Foreign candidates must never receive a score; calling this function with
 * one fails closed (Error with code FOREIGN_JOB_REJECT).
 */
function scopeSpecificityCenti(candidate, context) {
  if (isForeignJob(candidate, context.active_job_id)) {
    const error = new Error('FOREIGN_JOB_REJECT: candidate job_id conflicts with the active job');
    error.code = 'FOREIGN_JOB_REJECT';
    throw error;
  }

  const sessionId = candidate.session_id;
  if (sessionId !== null && sessionId !== undefined && sessionId === context.active_session_id) {
    return SCOPE_CENTI.same_active_session;
  }

  const jobId = candidate.job_id;
  if (jobId !== null && jobId !== undefined && jobId === context.active_job_id) {
    return SCOPE_CENTI.same_active_job;
  }

  if (candidate.scope === 'global' && (jobId === null || jobId === undefined)) {
    return SCOPE_CENTI.global_scope;
  }

  return SCOPE_CENTI.otherwise;
}

/** Public numeric scope specificity — exact centi-unit value / 100. */
function scopeSpecificity(candidate, context) {
  return scopeSpecificityCenti(candidate, context) / 100;
}

/**
 * Authority baseline lookup in exact centi-units. Returns null for any unknown
 * category. Callers must treat null as fail-closed ineligibility — no score is
 * invented.
 */
function authorityScoreCenti(sourceType) {
  if (Object.prototype.hasOwnProperty.call(AUTHORITY_CENTI, sourceType)) {
    return AUTHORITY_CENTI[sourceType];
  }
  return null;
}

/** Public numeric authority score — exact centi-unit value / 100, or null. */
function authorityScore(sourceType) {
  const centi = authorityScoreCenti(sourceType);
  return centi === null ? null : centi / 100;
}

// --- Strict RFC3339 UTC timestamps (exact, full fractional precision) ---

const RFC3339_UTC_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?Z$/;

const DAYS_IN_MONTH = Object.freeze([31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]);

function isLeapYear(year) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year, month) {
  if (month === 2 && isLeapYear(year)) return 29;
  return DAYS_IN_MONTH[month - 1];
}

/** Days since 1970-01-01 for a proleptic Gregorian civil date. */
function daysFromCivil(year, month, day) {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/**
 * Strict RFC3339 UTC parser. Accepts only the canonical UTC form
 * `YYYY-MM-DDTHH:MM:SS[.fraction]Z` and validates both syntax and calendar
 * value (month/day ranges including leap years, and time-of-day ranges).
 * All fractional-second digits are preserved for exact comparison.
 *
 * Returns { seconds: BigInt, fractionDigits: string }.
 * Invalid input fails closed with TypeError.
 */
function parseRfc3339Utc(value) {
  if (typeof value !== 'string') {
    throw new TypeError('timestamp must be a string');
  }
  const match = RFC3339_UTC_PATTERN.exec(value);
  if (!match) {
    throw new TypeError(`timestamp is not strict RFC3339 UTC: ${value}`);
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const fractionDigits = match[7] || '';

  if (month < 1 || month > 12 ||
      day < 1 || day > daysInMonth(year, month) ||
      hour > 23 || minute > 59 || second > 59) {
    throw new TypeError(`timestamp has an invalid calendar value: ${value}`);
  }

  const days = daysFromCivil(year, month, day);
  const seconds = BigInt(days) * 86400n + BigInt(hour * 3600 + minute * 60 + second);
  return { seconds, fractionDigits };
}

/** Compare two parsed timestamps chronologically: -1 | 0 | 1. */
function compareParsedTimestamps(a, b) {
  if (a.seconds !== b.seconds) return a.seconds < b.seconds ? -1 : 1;
  const length = Math.max(a.fractionDigits.length, b.fractionDigits.length);
  const aFraction = a.fractionDigits.padEnd(length, '0');
  const bFraction = b.fractionDigits.padEnd(length, '0');
  if (aFraction === bFraction) return 0;
  return aFraction < bFraction ? -1 : 1;
}

/** Compare two strict RFC3339 UTC strings chronologically: -1 | 0 | 1. */
function compareRfc3339Utc(a, b) {
  return compareParsedTimestamps(parseRfc3339Utc(a), parseRfc3339Utc(b));
}

/** Scale a fractional-digit string to a common length as BigInt. */
function fractionDigitsToBigInt(fractionDigits, length) {
  const padded = fractionDigits.padEnd(length, '0');
  return padded === '' ? 0n : BigInt(padded);
}

/**
 * Recency v1 in exact centi-units. Age is measured against the single
 * immutable run anchor with full fractional precision:
 *
 *   age = max(0, hydration_started_at - candidate.updated_at)
 *
 * Buckets: <= 1 day -> 100, <= 7 days -> 75, <= 30 days -> 50,
 * <= 90 days -> 25, > 90 days -> 0. Future updated_at floors to age 0.
 * No per-candidate wall-clock reads. Invalid timestamps fail closed.
 */
function recencyScoreCenti(updatedAt, hydrationStartedAt) {
  const anchor = parseRfc3339Utc(hydrationStartedAt);
  const updated = parseRfc3339Utc(updatedAt);

  const length = Math.max(anchor.fractionDigits.length, updated.fractionDigits.length);
  const scale = 10n ** BigInt(length);
  const anchorUnits = anchor.seconds * scale + fractionDigitsToBigInt(anchor.fractionDigits, length);
  const updatedUnits = updated.seconds * scale + fractionDigitsToBigInt(updated.fractionDigits, length);
  const ageUnits = anchorUnits - updatedUnits;

  if (ageUnits <= 0n) return RECENCY_CENTI.ONE_DAY;
  if (ageUnits <= RECENCY_SECONDS_BIGINT.ONE_DAY * scale) return RECENCY_CENTI.ONE_DAY;
  if (ageUnits <= RECENCY_SECONDS_BIGINT.SEVEN_DAYS * scale) return RECENCY_CENTI.SEVEN_DAYS;
  if (ageUnits <= RECENCY_SECONDS_BIGINT.THIRTY_DAYS * scale) return RECENCY_CENTI.THIRTY_DAYS;
  if (ageUnits <= RECENCY_SECONDS_BIGINT.NINETY_DAYS * scale) return RECENCY_CENTI.NINETY_DAYS;
  return RECENCY_CENTI.OLDER;
}

/** Public numeric recency score — exact centi-unit value / 100. */
function recencyScore(updatedAt, hydrationStartedAt) {
  return recencyScoreCenti(updatedAt, hydrationStartedAt) / 100;
}

/**
 * quantize6 — policy rounding formula applied in float space:
 *
 *   floor((x * 1000000) + 0.5) / 1000000
 *
 * The scoring path does NOT use this helper on computed floats; it applies the
 * same formula to the exact rational total via quantize6Fraction, so binary
 * floating drift cannot move half-micro boundaries.
 */
function quantize6(x) {
  return Math.floor((x * 1000000) + 0.5) / 1000000;
}

/**
 * Exact weighted total from exact factor fractions, then quantize6 on the
 * exact rational sum. Shared by the ranking path (integer sources) and the
 * public totalScore helper (exact values of the provided factors):
 *
 *   raw_total = (semantic * 0.50) + (scope * 0.25) + (authority * 0.20)
 *             + (recency * 0.05)
 */
function weightedTotalScore(factors) {
  const semantic = multiplyFractions(factors.semantic, WEIGHT_FRACTIONS.semantic_relevance);
  const scope = multiplyFractions(factors.scope, WEIGHT_FRACTIONS.scope_specificity);
  const authority = multiplyFractions(factors.authority, WEIGHT_FRACTIONS.authority);
  const recency = multiplyFractions(factors.recency, WEIGHT_FRACTIONS.recency);

  const rawTotal = addFractions(
    addFractions(semantic, scope),
    addFractions(authority, recency)
  );
  return quantize6Fraction(rawTotal);
}

/**
 * Ranking-path total score built directly from integer sources — semantic
 * relevance as the exact fraction intersection/union, factor values as exact
 * centi-units. No float round-trip anywhere.
 */
function totalScoreFromCounts({ intersection, union, scopeCenti, authorityCenti, recencyCenti }) {
  return weightedTotalScore({
    semantic: union === 0 ? { n: 0n, d: 1n } : reduceFraction(BigInt(intersection), BigInt(union)),
    scope: reduceFraction(BigInt(scopeCenti), 100n),
    authority: reduceFraction(BigInt(authorityCenti), 100n),
    recency: reduceFraction(BigInt(recencyCenti), 100n),
  });
}

/**
 * Total score — exact policy formula, then quantize6:
 *
 *   raw_total = (semantic_relevance * 0.50) + (scope_specificity * 0.25)
 *             + (authority * 0.20) + (recency * 0.05)
 *   total_score = quantize6(raw_total)
 *
 * The weighted sum is computed with exact rational arithmetic on the exact
 * values of the provided factors (no binary floating drift); the final
 * quantization is the exact floor((x * 1000000) + 0.5) / 1000000.
 */
function totalScore(factors) {
  return weightedTotalScore({
    semantic: numberToFraction(factors.semantic_relevance),
    scope: numberToFraction(factors.scope_specificity),
    authority: numberToFraction(factors.authority),
    recency: numberToFraction(factors.recency),
  });
}

/**
 * Deterministic tie-break comparator. Exact policy order:
 *   1. total_score DESC
 *   2. scope_specificity DESC
 *   3. authority DESC
 *   4. updated_at DESC — exact chronological comparison with full RFC3339
 *      fractional-second precision (never Date.parse millisecond truncation)
 *   5. source_id ASC (UTF-16 code-unit order, no locale collation)
 */
function compareScoredCandidates(a, b) {
  if (a.total_score !== b.total_score) return b.total_score - a.total_score;
  if (a.scope_specificity !== b.scope_specificity) return b.scope_specificity - a.scope_specificity;
  if (a.authority !== b.authority) return b.authority - a.authority;

  const timeOrder = compareRfc3339Utc(a.updated_at, b.updated_at);
  if (timeOrder !== 0) return -timeOrder;

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

    const authorityCenti = authorityScoreCenti(candidate.source_type);
    if (authorityCenti === null) {
      rejected.push({ source_id: candidate.source_id, reason: 'unknown_authority' });
      continue;
    }

    const counts = jaccardCounts(objectiveTerms, candidate.retrieval_terms);
    const scopeCenti = scopeSpecificityCenti(candidate, context);
    const recencyCenti = recencyScoreCenti(candidate.updated_at, input.hydration_started_at);

    const total = totalScoreFromCounts({
      intersection: counts.intersection,
      union: counts.union,
      scopeCenti,
      authorityCenti,
      recencyCenti,
    });

    ranked.push({
      ...candidate,
      semantic_relevance: counts.union === 0 ? 0 : counts.intersection / counts.union,
      scope_specificity: scopeCenti / 100,
      authority: authorityCenti / 100,
      recency: recencyCenti / 100,
      total_score: total,
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
