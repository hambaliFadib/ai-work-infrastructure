/**
 * Context Hydration v1 — Deterministic Objective Parser.
 *
 * Implements StructuredObjective generation under policy context-hydration@1.0.1.
 * Owns acceptance invariants O01–O10.
 *
 * Determinism:
 *   - No wall-clock, randomness, environment, or network reads.
 *   - objective_id is content-derived (SHA-256 over canonical objective content).
 *   - Identical deterministic input + policy version produces identical output (O09).
 *
 * Contract mapping (context-hydration@1.0.1):
 *   - Explicit objective outranks inferred objective (O10).
 *   - Ambiguity must not invent entities (O08): entities are only accepted from
 *     explicit structured input; free-text entity inference is not performed.
 *   - Term normalization: NFKC, lowercase, trim, collapse internal whitespace to
 *     one ASCII space, remove empty, deduplicate exact terms (contract section 5).
 *   - Confidence bands: HIGH >= 0.80, MEDIUM >= 0.60, LOW < 0.60 (contract section 6).
 *     LOW maps to mandatory-context-only with automatic retrieval disabled (O06/O07).
 *
 * Implementation-level choices (deterministic, documented, not additional
 * normative behavior):
 *   - Active session/job scope is a hard boundary: explicit_objective.scope may
 *     only confirm the active identifiers; mismatched identifiers fail closed
 *     (EXPLICIT_SCOPE_MISMATCH).
 *   - A meaningful explicit objective contributes at least one substantive
 *     signal (non-empty summary or intent, entities, constraints, or
 *     retrieval_terms). An empty explicit object, empty arrays, or matching
 *     scope only are NOT meaningful and fall back to effective-signal scoring.
 *   - Confidence is derived from integer signal weights (percent), so identical
 *     input always yields the identical number:
 *       meaningful explicit objective         -> 100
 *       otherwise: non-empty summary           -> +40
 *                  recognized intent           -> +30
 *                  retrieval_terms.length >= 3 -> +20
 *                  constraints.length >= 1     -> +10
 *   - Intent classification uses a closed set with fixed first-match rule order:
 *     IMPLEMENT, FIX, EXPLAIN, ANALYZE, RETRIEVE, MODIFY, UNSPECIFIED.
 *   - Retrieval-term tokenization splits text on non letter/number characters,
 *     then applies the exact contract normalization steps.
 *   - Unknown fields on structured inputs fail closed instead of being silently
 *     accepted or dropped.
 *
 * Scope boundary: objective parsing only. This module does not implement
 * candidate retrieval, ranking, budgeting, ContextPackage assembly, or skill
 * resolution.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const POLICY_REF = 'context-hydration@1.0.1';
const POLICY_PATH = path.join(__dirname, '..', '..', 'governance', 'policies', 'context-hydration.json');

const INTENT_RULES = [
  ['IMPLEMENT', ['implement', 'create', 'add', 'build', 'write', 'develop']],
  ['FIX', ['fix', 'repair', 'resolve', 'debug']],
  ['EXPLAIN', ['explain', 'describe', 'document', 'clarify']],
  ['ANALYZE', ['analyze', 'analyse', 'review', 'audit', 'inspect']],
  ['RETRIEVE', ['retrieve', 'find', 'search', 'locate', 'fetch']],
  ['MODIFY', ['update', 'modify', 'change', 'refactor', 'adjust']],
];

const EXPLICIT_ALLOWED_KEYS = new Set(['summary', 'intent', 'scope', 'entities', 'constraints', 'retrieval_terms']);

class ObjectiveParserError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ObjectiveParserError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new ObjectiveParserError(code, message);
}

/**
 * Load and lock the machine-readable policy. Fail closed if unavailable or
 * if the policy identity does not match context-hydration@1.0.1.
 */
const POLICY = (() => {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(POLICY_PATH, 'utf8'));
  } catch (e) {
    fail('POLICY_UNAVAILABLE', `Cannot load ${POLICY_REF} policy: ${e.message}`);
  }
  if (parsed.policy_ref !== POLICY_REF) {
    fail('POLICY_MISMATCH', `Expected policy ${POLICY_REF}, found ${parsed.policy_ref}`);
  }
  const confidence = parsed.confidence;
  if (!confidence || typeof confidence.high_threshold !== 'number' || typeof confidence.medium_threshold !== 'number') {
    fail('POLICY_MISMATCH', 'Policy confidence thresholds missing or malformed');
  }
  const low = confidence.low_behavior;
  if (!low || low.mandatory_context_loads !== true || low.automatic_retrieval_disabled !== true) {
    fail('POLICY_MISMATCH', 'Policy LOW-confidence behavior flags missing or malformed');
  }
  return parsed;
})();

const HIGH_THRESHOLD = POLICY.confidence.high_threshold;
const MEDIUM_THRESHOLD = POLICY.confidence.medium_threshold;

/**
 * Exact v1 term normalization (contract section 5):
 * NFKC, lowercase, trim, collapse internal whitespace, remove empty, deduplicate.
 */
function normalizeTerms(terms) {
  if (!Array.isArray(terms)) {
    fail('INVALID_TERMS', 'terms must be an array of strings');
  }
  const normalized = [];
  const seen = new Set();
  for (const raw of terms) {
    if (typeof raw !== 'string') {
      fail('INVALID_TERMS', 'terms must contain only strings');
    }
    const term = raw.normalize('NFKC').toLowerCase().trim().replace(/\s+/g, ' ');
    if (term === '') continue;
    if (seen.has(term)) continue;
    seen.add(term);
    normalized.push(term);
  }
  return normalized;
}

/**
 * Deterministic tokenization: NFKC, lowercase, split on non letter/number
 * characters, then apply the exact contract normalization steps.
 */
function tokenizeTerms(text) {
  if (typeof text !== 'string') return [];
  const separated = text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ');
  return normalizeTerms(separated.split(' '));
}

/**
 * Closed-set intent classification with fixed first-match rule order.
 */
function classifyIntent(text) {
  const tokens = new Set(tokenizeTerms(text));
  for (const [intent, keywords] of INTENT_RULES) {
    for (const keyword of keywords) {
      if (tokens.has(keyword)) return intent;
    }
  }
  return 'UNSPECIFIED';
}

/**
 * Confidence band classification per policy thresholds.
 */
function classifyConfidence(confidence) {
  if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    fail('INVALID_CONFIDENCE', 'confidence must be a finite number in [0, 1]');
  }
  if (confidence >= HIGH_THRESHOLD) return 'HIGH';
  if (confidence >= MEDIUM_THRESHOLD) return 'MEDIUM';
  return 'LOW';
}

/**
 * Policy-compatible behavior mapping for a confidence value.
 * Mandatory context always loads; automatic candidate retrieval is disabled
 * exactly when the confidence band is LOW (policy 1.0.1 low_behavior).
 */
function confidencePolicy(confidence) {
  const level = classifyConfidence(confidence);
  return {
    level,
    mandatory_context_loads: true,
    automatic_retrieval_disabled: level === 'LOW',
  };
}

function requireNonEmptyString(value, code, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    fail(code, `${label} must be a non-empty string`);
  }
  return value.trim();
}

function extractCheckpointId(latestCheckpoint) {
  if (latestCheckpoint === undefined || latestCheckpoint === null) return null;
  if (typeof latestCheckpoint === 'string') {
    if (latestCheckpoint.trim() === '') {
      fail('INVALID_LATEST_CHECKPOINT', 'latest_checkpoint string must be non-empty');
    }
    return latestCheckpoint.trim();
  }
  if (typeof latestCheckpoint === 'object' && !Array.isArray(latestCheckpoint)) {
    const id = latestCheckpoint.checkpoint_id;
    if (typeof id !== 'string' || id.trim() === '') {
      fail('INVALID_LATEST_CHECKPOINT', 'latest_checkpoint object form requires a non-empty checkpoint_id string');
    }
    return id.trim();
  }
  fail('INVALID_LATEST_CHECKPOINT', 'latest_checkpoint must be a string, object, null, or undefined');
}

function normalizeStringList(list, code, label) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) {
    fail(code, `${label} must be an array of strings`);
  }
  const normalized = [];
  const seen = new Set();
  for (const raw of list) {
    if (typeof raw !== 'string' || raw.trim() === '') {
      fail(code, `${label} must contain only non-empty strings`);
    }
    const value = raw.trim();
    if (seen.has(value)) continue;
    seen.add(value);
    normalized.push(value);
  }
  return normalized;
}

/**
 * Validate and normalize the optional explicit objective. Unknown fields fail
 * closed; explicit emptiness is only allowed through required non-empty fields.
 */
function normalizeExplicitObjective(explicit) {
  if (explicit === undefined || explicit === null) return null;
  if (typeof explicit !== 'object' || Array.isArray(explicit)) {
    fail('INVALID_EXPLICIT_OBJECTIVE', 'explicit_objective must be a plain object');
  }
  for (const key of Object.keys(explicit)) {
    if (!EXPLICIT_ALLOWED_KEYS.has(key)) {
      fail('INVALID_EXPLICIT_OBJECTIVE', `explicit_objective contains unsupported field: ${key}`);
    }
  }
  const normalized = {};
  if (explicit.summary !== undefined) {
    normalized.summary = requireNonEmptyString(explicit.summary, 'INVALID_EXPLICIT_OBJECTIVE', 'explicit_objective.summary');
  }
  if (explicit.intent !== undefined) {
    normalized.intent = requireNonEmptyString(explicit.intent, 'INVALID_EXPLICIT_OBJECTIVE', 'explicit_objective.intent');
  }
  if (explicit.scope !== undefined) {
    const scope = explicit.scope;
    if (scope === null || typeof scope !== 'object' || Array.isArray(scope)) {
      fail('INVALID_EXPLICIT_OBJECTIVE', 'explicit_objective.scope must be an object');
    }
    for (const key of Object.keys(scope)) {
      if (key !== 'session_id' && key !== 'job_id') {
        fail('INVALID_EXPLICIT_OBJECTIVE', `explicit_objective.scope contains unsupported field: ${key}`);
      }
    }
    const normalizedScope = {};
    if (scope.session_id !== undefined) {
      normalizedScope.session_id = requireNonEmptyString(scope.session_id, 'INVALID_EXPLICIT_OBJECTIVE', 'explicit_objective.scope.session_id');
    }
    if (scope.job_id !== undefined) {
      normalizedScope.job_id = requireNonEmptyString(scope.job_id, 'INVALID_EXPLICIT_OBJECTIVE', 'explicit_objective.scope.job_id');
    }
    normalized.scope = normalizedScope;
  }
  if (explicit.entities !== undefined) {
    normalized.entities = normalizeStringList(explicit.entities, 'INVALID_EXPLICIT_OBJECTIVE', 'explicit_objective.entities');
  }
  if (explicit.constraints !== undefined) {
    normalized.constraints = normalizeStringList(explicit.constraints, 'INVALID_EXPLICIT_OBJECTIVE', 'explicit_objective.constraints');
  }
  if (explicit.retrieval_terms !== undefined) {
    if (!Array.isArray(explicit.retrieval_terms)) {
      fail('INVALID_EXPLICIT_OBJECTIVE', 'explicit_objective.retrieval_terms must be an array of strings');
    }
    normalized.retrieval_terms = normalizeTerms(explicit.retrieval_terms);
  }
  return normalized;
}

function mergeConstraints(active, explicitConstraints) {
  const merged = active.slice();
  const seen = new Set(active);
  for (const value of explicitConstraints) {
    if (seen.has(value)) continue;
    seen.add(value);
    merged.push(value);
  }
  return merged;
}

/**
 * A meaningful explicit objective contributes at least one substantive signal.
 * Matching scope identifiers and empty arrays do not count (review 4115581856).
 */
function hasMeaningfulExplicitSignal(explicit) {
  if (!explicit) return false;
  if (explicit.summary !== undefined && explicit.summary !== '') return true;
  if (explicit.intent !== undefined && explicit.intent !== '') return true;
  if (Array.isArray(explicit.entities) && explicit.entities.length > 0) return true;
  if (Array.isArray(explicit.constraints) && explicit.constraints.length > 0) return true;
  if (Array.isArray(explicit.retrieval_terms) && explicit.retrieval_terms.length > 0) return true;
  return false;
}

/**
 * Canonical JSON with sorted object keys; arrays keep their order.
 */
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function deriveObjectiveId(content) {
  const digest = crypto.createHash('sha256').update(stableStringify(content), 'utf8').digest('hex');
  return `obj-${digest.slice(0, 16)}`;
}

/**
 * Parse deterministic inputs into a StructuredObjective under policy 1.0.1.
 *
 * Required: session_id (non-empty string), job_id (non-empty string),
 * user_request (string; may be empty when an explicit objective is present).
 * Optional: latest_checkpoint (string | object | null), active_constraints
 * (array of non-empty strings), explicit_objective (plain object).
 */
function parseObjective(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    fail('INVALID_INPUT', 'input must be a plain object');
  }

  const sessionId = requireNonEmptyString(input.session_id, 'INVALID_SESSION_ID', 'session_id');
  const jobId = requireNonEmptyString(input.job_id, 'INVALID_JOB_ID', 'job_id');
  if (typeof input.user_request !== 'string') {
    fail('INVALID_USER_REQUEST', 'user_request must be a string');
  }
  const userRequest = input.user_request;
  const checkpointId = extractCheckpointId(input.latest_checkpoint);
  const activeConstraints = normalizeStringList(input.active_constraints, 'INVALID_ACTIVE_CONSTRAINTS', 'active_constraints');
  const explicit = normalizeExplicitObjective(input.explicit_objective);

  const objectiveSource = explicit ? 'explicit_objective' : 'inferred_request';

  // Scope: the active session/job inputs are the authoritative boundary.
  // Explicit scope may only confirm them; mismatches fail closed (review 4115581853).
  const scope = { session_id: sessionId, job_id: jobId };
  if (explicit && explicit.scope) {
    if (explicit.scope.session_id !== undefined && explicit.scope.session_id !== sessionId) {
      fail('EXPLICIT_SCOPE_MISMATCH', 'explicit_objective.scope.session_id must match the active session_id');
    }
    if (explicit.scope.job_id !== undefined && explicit.scope.job_id !== jobId) {
      fail('EXPLICIT_SCOPE_MISMATCH', 'explicit_objective.scope.job_id must match the active job_id');
    }
  }

  // Summary: explicit summary outranks the inferred request text.
  const inferredSummary = userRequest.replace(/\s+/g, ' ').trim();
  const effectiveText = explicit && explicit.summary !== undefined ? explicit.summary : inferredSummary;
  const summary = effectiveText;

  // Intent: explicit intent outranks inferred classification.
  const intent = explicit && explicit.intent !== undefined ? explicit.intent : classifyIntent(effectiveText);

  // Retrieval terms: explicit terms outrank derived terms; always normalized.
  const retrievalTerms = explicit && explicit.retrieval_terms !== undefined
    ? explicit.retrieval_terms
    : tokenizeTerms(effectiveText);

  // Entities: explicit structured input only. Free-text entity inference is not
  // performed under 1.0.1, so ambiguity can never invent entities (O08).
  const entities = explicit && explicit.entities !== undefined ? explicit.entities : [];

  // Constraints: active constraints are preserved; explicit constraints are added.
  const constraints = explicit && explicit.constraints !== undefined
    ? mergeConstraints(activeConstraints, explicit.constraints)
    : activeConstraints;

  // Confidence: integer percent weights keep identical inputs identical (O09).
  // Only a meaningful explicit objective may take the explicit-confidence path;
  // an empty explicit object must not auto-escalate (review 4115581856).
  let confidence;
  if (explicit && hasMeaningfulExplicitSignal(explicit)) {
    confidence = 1;
  } else {
    let score = 0;
    if (summary !== '') score += 40;
    if (intent !== 'UNSPECIFIED') score += 30;
    if (retrievalTerms.length >= 3) score += 20;
    if (constraints.length >= 1) score += 10;
    confidence = score / 100;
  }

  // Provenance: origin tracking stays traceable to job/session/checkpoint/policy.
  const provenance = {
    session_id: sessionId,
    job_id: jobId,
    objective_source: objectiveSource,
    checkpoint_id: checkpointId,
    policy_ref: POLICY_REF,
  };

  const objectiveId = deriveObjectiveId({
    policy_ref: POLICY_REF,
    session_id: sessionId,
    job_id: jobId,
    objective_source: objectiveSource,
    summary,
    intent,
    scope,
    entities,
    constraints,
    retrieval_terms: retrievalTerms,
    confidence,
    checkpoint_id: checkpointId,
  });

  return {
    objective_id: objectiveId,
    summary,
    intent,
    scope,
    entities,
    constraints,
    retrieval_terms: retrievalTerms,
    confidence,
    provenance,
  };
}

module.exports = {
  POLICY_REF,
  ObjectiveParserError,
  parseObjective,
  classifyConfidence,
  confidencePolicy,
  normalizeTerms,
  tokenizeTerms,
  classifyIntent,
};
