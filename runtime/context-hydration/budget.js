/**
 * Context Hydration v1 — Budget + Deduplication
 *
 * Policy: context-hydration@1.0.1
 * Contract: governance/contracts/context-hydration-v1.md (§9, §10, H09-H11)
 *
 * Deterministic budget reservation, mandatory overflow detection,
 * retrieval-budget allocation, and candidate deduplication.
 *
 * Token counts are explicit non-negative integers resolved by the runtime
 * (active model tokenizer) BEFORE this stage. This module never guesses,
 * estimates, or measures token counts.
 *
 * Determinism: no wall-clock reads, no network, no environment access,
 * no randomness. Identical inputs produce identical outputs.
 */

'use strict';

const POLICY_ID = 'context-hydration';
const POLICY_VERSION = '1.0.1';

/** Policy 1.0.1 budget.overflow_error — exact error code. */
const OVERFLOW_ERROR = 'CONTEXT_BUDGET_EXCEEDED';

/**
 * Policy 1.0.1 budget.required_inputs — explicit non-negative integer token
 * counts that must be supplied by the runtime before the budget stage.
 */
const REQUIRED_TOKEN_INPUTS = [
  'context_window_tokens',
  'response_headroom_tokens',
  'execution_reserve_tokens',
  'active_conversation_tokens',
  'mandatory_context_tokens',
];

/** Policy 1.0.1 budget.retrieved_max_fraction. */
const RETRIEVAL_MAX_FRACTION = 0.20;

/**
 * Policy 1.0.1 budget.reservation_order — the normative 7-step order:
 *
 *   1. start with context_window_tokens
 *   2. reserve response_headroom_tokens
 *   3. reserve execution_reserve_tokens
 *   4. account for active_conversation_tokens
 *   5. account for mandatory_context_tokens
 *   6. calculate remaining available context
 *   7. allocate retrieval budget
 */
const RESERVATION_ORDER = [
  'context_window_tokens',
  'response_headroom_tokens',
  'execution_reserve_tokens',
  'active_conversation_tokens',
  'mandatory_context_tokens',
  'available_context_tokens',
  'retrieval_budget_tokens',
];

const BUDGET_ERROR_CODES = {
  CONTEXT_BUDGET_EXCEEDED: 'CONTEXT_BUDGET_EXCEEDED',
  INVALID_BUDGET_INPUTS: 'INVALID_BUDGET_INPUTS',
  INVALID_CANDIDATE_IDENTITY: 'INVALID_CANDIDATE_IDENTITY',
  INVALID_CANDIDATE_TOKENS: 'INVALID_CANDIDATE_TOKENS',
};

class BudgetError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'BudgetError';
    this.code = code;
  }
}

function isNonNegativeInteger(value) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/**
 * Validate the explicit budget inputs (contract §9).
 *
 * All five token inputs must be present as non-negative integers and
 * tokenizer_id must be a non-empty string. Fails closed with
 * INVALID_BUDGET_INPUTS on any violation.
 *
 * Returns a normalized record containing exactly the validated inputs.
 */
function validateBudgetInputs(inputs) {
  if (inputs === null || typeof inputs !== 'object' || Array.isArray(inputs)) {
    throw new BudgetError(
      BUDGET_ERROR_CODES.INVALID_BUDGET_INPUTS,
      'Budget inputs must be a plain object'
    );
  }
  for (const field of REQUIRED_TOKEN_INPUTS) {
    if (!Object.prototype.hasOwnProperty.call(inputs, field)) {
      throw new BudgetError(
        BUDGET_ERROR_CODES.INVALID_BUDGET_INPUTS,
        `Missing required budget input: ${field}`
      );
    }
    if (!isNonNegativeInteger(inputs[field])) {
      throw new BudgetError(
        BUDGET_ERROR_CODES.INVALID_BUDGET_INPUTS,
        `Budget input ${field} must be a non-negative integer`
      );
    }
  }
  if (typeof inputs.tokenizer_id !== 'string' || inputs.tokenizer_id.length === 0) {
    throw new BudgetError(
      BUDGET_ERROR_CODES.INVALID_BUDGET_INPUTS,
      'Budget input tokenizer_id must be a non-empty string'
    );
  }
  const normalized = { tokenizer_id: inputs.tokenizer_id };
  for (const field of REQUIRED_TOKEN_INPUTS) {
    normalized[field] = inputs[field];
  }
  return normalized;
}

/**
 * Allocate the retrieval budget: floor(available_context_tokens * 0.20).
 *
 * Implemented as floor((available * 20) / 100), which is exactly equal to
 * floor(available * 0.20) for every non-negative safe integer while avoiding
 * binary floating-point representation of 0.20. No alternative denominator
 * is introduced: the fraction is exactly the policy 0.20.
 */
function allocateRetrievalBudget(availableContextTokens) {
  if (!isNonNegativeInteger(availableContextTokens)) {
    throw new BudgetError(
      BUDGET_ERROR_CODES.INVALID_BUDGET_INPUTS,
      'available_context_tokens must be a non-negative integer'
    );
  }
  return Math.floor((availableContextTokens * 20) / 100);
}

/**
 * Apply the exact 7-step reservation order (contract §10).
 *
 * Returns the full budget record including the sequential reservation audit
 * trail (reservation_steps).
 *
 * Mandatory overflow fails closed: when
 * mandatory_context_tokens > usable_before_mandatory the call throws
 * BudgetError with code CONTEXT_BUDGET_EXCEEDED. Mandatory context is never
 * silently truncated or dropped.
 */
function computeBudget(inputs) {
  const normalized = validateBudgetInputs(inputs);

  // Step 1 — start with the context window.
  const step1 = normalized.context_window_tokens;

  // Step 2 — reserve response headroom.
  const step2 = step1 - normalized.response_headroom_tokens;

  // Step 3 — reserve execution reserve.
  const step3 = step2 - normalized.execution_reserve_tokens;

  // Step 4 — account for active conversation.
  const step4 = step3 - normalized.active_conversation_tokens;
  const usable_before_mandatory = step4;

  // Step 5 — account for mandatory context. Overflow fails closed.
  if (normalized.mandatory_context_tokens > usable_before_mandatory) {
    throw new BudgetError(
      BUDGET_ERROR_CODES.CONTEXT_BUDGET_EXCEEDED,
      `mandatory_context_tokens (${normalized.mandatory_context_tokens}) exceeds usable_before_mandatory (${usable_before_mandatory})`
    );
  }

  // Step 6 — calculate remaining available context.
  const available_context_tokens =
    usable_before_mandatory - normalized.mandatory_context_tokens;

  // Step 7 — allocate retrieval budget.
  const retrieval_budget_tokens = allocateRetrievalBudget(available_context_tokens);

  return {
    tokenizer_id: normalized.tokenizer_id,
    context_window_tokens: normalized.context_window_tokens,
    response_headroom_tokens: normalized.response_headroom_tokens,
    execution_reserve_tokens: normalized.execution_reserve_tokens,
    active_conversation_tokens: normalized.active_conversation_tokens,
    mandatory_context_tokens: normalized.mandatory_context_tokens,
    usable_before_mandatory,
    available_context_tokens,
    retrieval_budget_tokens,
    reservation_steps: [
      { step: 1, action: 'start_with_context_window', field: 'context_window_tokens', value: step1 },
      { step: 2, action: 'reserve_response_headroom', field: 'response_headroom_tokens', value: normalized.response_headroom_tokens, remaining: step2 },
      { step: 3, action: 'reserve_execution_reserve', field: 'execution_reserve_tokens', value: normalized.execution_reserve_tokens, remaining: step3 },
      { step: 4, action: 'account_active_conversation', field: 'active_conversation_tokens', value: normalized.active_conversation_tokens, remaining: step4 },
      { step: 5, action: 'account_mandatory_context', field: 'mandatory_context_tokens', value: normalized.mandatory_context_tokens, remaining: available_context_tokens },
      { step: 6, action: 'calculate_available_context', field: 'available_context_tokens', value: available_context_tokens },
      { step: 7, action: 'allocate_retrieval_budget', field: 'retrieval_budget_tokens', value: retrieval_budget_tokens },
    ],
  };
}

/**
 * Candidate/source identity for deduplication.
 *
 * Under policy 1.0.1 a knowledge record is identified by its source
 * (retrieved/omitted audit fields source_id and source_type, contract §11.1
 * and §12.2). Duplicate knowledge therefore means two candidate records
 * carrying the same (source_type, source_id) pair. The pair is encoded
 * unambiguously so distinct pairs can never collide.
 */
function candidateIdentity(candidate) {
  const { source_id, source_type } = candidate;
  if (typeof source_id !== 'string' || source_id.length === 0) {
    throw new BudgetError(
      BUDGET_ERROR_CODES.INVALID_CANDIDATE_IDENTITY,
      'candidate must carry a non-empty source_id'
    );
  }
  if (typeof source_type !== 'string' || source_type.length === 0) {
    throw new BudgetError(
      BUDGET_ERROR_CODES.INVALID_CANDIDATE_IDENTITY,
      'candidate must carry a non-empty source_type'
    );
  }
  return JSON.stringify([source_type, source_id]);
}

/**
 * Deterministic deduplication (pipeline step before budget enforcement; H11).
 *
 * Input order is preserved: the first occurrence of each source identity is
 * kept and later duplicates are removed. The input order is expected to be
 * the deterministic ranked order produced upstream, so the kept record is
 * the highest-ranked occurrence.
 *
 * Mandatory context is NOT passed through this function: protected mandatory
 * records are never subject to deduplication or removal.
 *
 * Malformed candidates (missing source identity) fail closed with
 * INVALID_CANDIDATE_IDENTITY.
 */
function deduplicateCandidates(candidates) {
  if (!Array.isArray(candidates)) {
    throw new BudgetError(
      BUDGET_ERROR_CODES.INVALID_CANDIDATE_IDENTITY,
      'candidates must be an array'
    );
  }
  const seen = new Set();
  const deduplicated = [];
  for (const candidate of candidates) {
    if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new BudgetError(
        BUDGET_ERROR_CODES.INVALID_CANDIDATE_IDENTITY,
        'candidate must be a plain object'
      );
    }
    const identity = candidateIdentity(candidate);
    if (seen.has(identity)) continue;
    seen.add(identity);
    deduplicated.push(candidate);
  }
  return deduplicated;
}

/**
 * Enforce the retrieval budget over deduplicated ranked candidates.
 *
 * Deterministic greedy fill in ranked order: a candidate is retrieved when
 * its resolved estimated_tokens fit within the remaining retrieval budget;
 * otherwise it is omitted (metadata only) and evaluation continues with the
 * remaining budget. No candidate record is ever truncated.
 *
 * Returns the retrieved/omitted split plus exact token accounting.
 * Malformed token counts fail closed with INVALID_CANDIDATE_TOKENS.
 */
function applyRetrievalBudget(candidates, retrievalBudgetTokens) {
  if (!Array.isArray(candidates)) {
    throw new BudgetError(
      BUDGET_ERROR_CODES.INVALID_CANDIDATE_TOKENS,
      'candidates must be an array'
    );
  }
  if (!isNonNegativeInteger(retrievalBudgetTokens)) {
    throw new BudgetError(
      BUDGET_ERROR_CODES.INVALID_BUDGET_INPUTS,
      'retrieval_budget_tokens must be a non-negative integer'
    );
  }
  const retrieved = [];
  const omitted = [];
  let remaining_tokens = retrievalBudgetTokens;
  let retrieved_tokens_used = 0;

  for (const candidate of candidates) {
    if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new BudgetError(
        BUDGET_ERROR_CODES.INVALID_CANDIDATE_TOKENS,
        'candidate must be a plain object'
      );
    }
    if (!isNonNegativeInteger(candidate.estimated_tokens)) {
      throw new BudgetError(
        BUDGET_ERROR_CODES.INVALID_CANDIDATE_TOKENS,
        'candidate.estimated_tokens must be a non-negative integer resolved before the budget stage'
      );
    }
    if (candidate.estimated_tokens <= remaining_tokens) {
      remaining_tokens -= candidate.estimated_tokens;
      retrieved_tokens_used += candidate.estimated_tokens;
      retrieved.push(candidate);
    } else {
      omitted.push(candidate);
    }
  }

  return {
    retrieved,
    omitted,
    retrieved_tokens_used,
    remaining_tokens,
  };
}

module.exports = {
  POLICY_ID,
  POLICY_VERSION,
  OVERFLOW_ERROR,
  REQUIRED_TOKEN_INPUTS,
  RETRIEVAL_MAX_FRACTION,
  RESERVATION_ORDER,
  BUDGET_ERROR_CODES,
  BudgetError,
  isNonNegativeInteger,
  validateBudgetInputs,
  allocateRetrievalBudget,
  computeBudget,
  candidateIdentity,
  deduplicateCandidates,
  applyRetrievalBudget,
};
