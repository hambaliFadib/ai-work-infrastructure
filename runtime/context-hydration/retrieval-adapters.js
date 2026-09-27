'use strict';

/**
 * Context Hydration v1 — Retrieval Adapters (9A-04 / Issue #11)
 *
 * Policy: context-hydration@1.0.1
 *
 * Deterministic candidate access boundaries. Adapters wrap caller-supplied
 * synchronous candidate providers. This module performs NO filesystem,
 * database, memory-service, or network access of its own — every provider
 * is injected.
 *
 * Access modes (policy retrieval.eligibility):
 *   - curated               -> automatic
 *   - reviewed_session_fact -> automatic
 *   - historical_checkpoint -> automatic
 *   - semantic_memory       -> advisory (never authoritative)
 *   - raw_source            -> explicit request only, never automatic
 *
 * Mandatory context is NOT a candidate source: no adapter exists for it and
 * adapter lookup fails closed for it.
 *
 * The confidence gate precedes candidate retrieval (contract pipeline):
 * retrieveCandidates() at LOW confidence invokes no provider at all.
 *
 * Provider contract (caller-injected):
 *   provider(context) -> Array of candidate records
 *   - synchronous, deterministic, side-effect free
 *   - must not perform secret/env reads or network/DB access
 *   - returned records are treated as immutable inputs and never mutated
 *
 * Ordering: results follow the fixed source order below; candidates are
 * concatenated in that order, preserving each provider's internal order.
 * This is deterministic access order, NOT ranked ordering — scoring and
 * final ranking belong to a different lane and are intentionally absent.
 */

const {
  CANDIDATE_SOURCE_TYPES,
  CONFIDENCE_LEVELS,
  classifyConfidence,
} = require('./eligibility-gates.js');

const ACCESS_MODES = Object.freeze({
  AUTOMATIC: 'automatic',
  ADVISORY: 'advisory',
  EXPLICIT: 'explicit',
});

const SOURCE_ACCESS = Object.freeze({
  curated: ACCESS_MODES.AUTOMATIC,
  reviewed_session_fact: ACCESS_MODES.AUTOMATIC,
  historical_checkpoint: ACCESS_MODES.AUTOMATIC,
  semantic_memory: ACCESS_MODES.ADVISORY,
  raw_source: ACCESS_MODES.EXPLICIT,
});

const SKIP_REASONS = Object.freeze({
  LOW_CONFIDENCE: 'LOW_CONFIDENCE',
  EXPLICIT_REQUIRED: 'EXPLICIT_REQUIRED',
});

function isPlainRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Raw-source access requires an explicit request that names at least one
 * concrete source id. Anything else (absent, non-explicit, empty id list)
 * is not an explicit request.
 */
function isExplicitRawRequest(context) {
  const request = isPlainRecord(context) ? context.raw_source_request : null;
  if (!isPlainRecord(request) || request.explicit !== true) return false;
  return Array.isArray(request.source_ids) && request.source_ids.length > 0;
}

/**
 * Copy a provider-returned record and stamp the adapter-owned source_type.
 * The provider's record is never mutated. Invalid records (non-objects) are
 * passed through untouched so the eligibility gate fails them closed.
 */
function stampCandidate(candidate, sourceType) {
  if (!isPlainRecord(candidate)) return candidate;
  return { ...candidate, source_type: sourceType };
}

/**
 * Create a retrieval adapter for one candidate source type.
 * - Unknown / non-candidate source types (e.g. mandatory context) are
 *   rejected at construction — they can never get an adapter.
 * - provider: function, or null/undefined for an unavailable adapter.
 */
function createRetrievalAdapter(sourceType, provider) {
  if (!CANDIDATE_SOURCE_TYPES.includes(sourceType)) {
    throw new Error(`Not a candidate source type: ${String(sourceType)}`);
  }
  if (provider !== undefined && provider !== null && typeof provider !== 'function') {
    throw new TypeError(`Retrieval provider for ${sourceType} must be a function`);
  }
  const access = SOURCE_ACCESS[sourceType];
  const available = typeof provider === 'function';

  return Object.freeze({
    source_type: sourceType,
    access,
    available,
    retrieve(context) {
      if (!available) {
        return {
          source_type: sourceType,
          access,
          invoked: false,
          unavailable: true,
          skipped_reason: null,
          candidates: [],
        };
      }
      if (access === ACCESS_MODES.EXPLICIT && !isExplicitRawRequest(context)) {
        return {
          source_type: sourceType,
          access,
          invoked: false,
          unavailable: false,
          skipped_reason: SKIP_REASONS.EXPLICIT_REQUIRED,
          candidates: [],
        };
      }
      const result = provider(context);
      if (!Array.isArray(result)) {
        throw new Error(`Retrieval provider for ${sourceType} must return an array`);
      }
      return {
        source_type: sourceType,
        access,
        invoked: true,
        unavailable: false,
        skipped_reason: null,
        candidates: result.map((candidate) => stampCandidate(candidate, sourceType)),
      };
    },
  });
}

/**
 * Create a registry of adapters for all candidate source types.
 * providers: plain object keyed by candidate source type. Unknown keys are
 * rejected (fail closed). Missing providers yield unavailable adapters.
 */
function createRetrievalRegistry(providers) {
  const supplied = providers === undefined || providers === null ? {} : providers;
  if (!isPlainRecord(supplied)) {
    throw new TypeError('providers must be a plain object keyed by candidate source type');
  }
  for (const key of Object.keys(supplied)) {
    if (!CANDIDATE_SOURCE_TYPES.includes(key)) {
      throw new Error(`Not a candidate source type: ${key}`);
    }
  }

  const adapters = new Map();
  for (const sourceType of CANDIDATE_SOURCE_TYPES) {
    adapters.set(sourceType, createRetrievalAdapter(sourceType, supplied[sourceType]));
  }

  return Object.freeze({
    source_types: CANDIDATE_SOURCE_TYPES,
    adapterFor(sourceType) {
      if (!CANDIDATE_SOURCE_TYPES.includes(sourceType)) {
        throw new Error(`Not a candidate source type: ${String(sourceType)}`);
      }
      return adapters.get(sourceType);
    },
  });
}

/**
 * Retrieve candidates from every adapter in deterministic source order.
 *
 * Confidence gate: at LOW objective confidence, automatic candidate
 * retrieval is disabled — no provider is invoked and no candidate is
 * returned (mandatory context is loaded separately by the pipeline).
 *
 * Returns:
 *   {
 *     confidence_level,
 *     automatic_retrieval_enabled,
 *     results: [ { source_type, access, invoked, unavailable, skipped_reason, candidates } ],
 *     candidates: [ ...flat, source-ordered... ],
 *   }
 */
function retrieveCandidates(registry, context) {
  if (!isPlainRecord(registry) || typeof registry.adapterFor !== 'function') {
    throw new TypeError('retrieveCandidates: registry must be created by createRetrievalRegistry');
  }
  const ctx = isPlainRecord(context) ? context : {};
  const level = classifyConfidence(ctx.objective_confidence);

  if (level === CONFIDENCE_LEVELS.LOW) {
    return {
      confidence_level: level,
      automatic_retrieval_enabled: false,
      results: CANDIDATE_SOURCE_TYPES.map((sourceType) => ({
        source_type: sourceType,
        access: SOURCE_ACCESS[sourceType],
        invoked: false,
        unavailable: false,
        skipped_reason: SKIP_REASONS.LOW_CONFIDENCE,
        candidates: [],
      })),
      candidates: [],
    };
  }

  const results = CANDIDATE_SOURCE_TYPES.map((sourceType) => {
    const adapter = registry.adapterFor(sourceType);
    return adapter.retrieve(ctx);
  });

  const candidates = [];
  for (const result of results) {
    for (const candidate of result.candidates) {
      candidates.push(candidate);
    }
  }

  return {
    confidence_level: level,
    automatic_retrieval_enabled: true,
    results,
    candidates,
  };
}

module.exports = {
  ACCESS_MODES,
  SOURCE_ACCESS,
  SKIP_REASONS,
  createRetrievalAdapter,
  createRetrievalRegistry,
  retrieveCandidates,
};
