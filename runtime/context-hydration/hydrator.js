/**
 * Context Hydration v1 — Integration Orchestrator (9A-07 / Issue #14)
 *
 * Policy: context-hydration@1.0.1
 * Contract: governance/contracts/context-hydration-v1.md
 *
 * Composes the five merged component modules into one deterministic pipeline:
 *
 *   hydrateContext(params)
 *     → parseObjective()                        StructuredObjective
 *     → resolveSkillChain()                     pure fail-closed companion gate
 *     → createRetrievalRegistry() + retrieveCandidates()
 *     → evaluateEligibility()
 *     → rankCandidates()
 *     → rank → ContextPackage score/rank projection (integration wiring only)
 *     → buildContextPackage()                   only stage that may write omission metadata
 *     → { context_package, skill_chain }
 *
 * Ordering rationale: the skill resolver deliberately executes before
 * buildContextPackage(). buildContextPackage() is the only integration stage
 * that may persist omission metadata, so every pure fail-closed integration
 * gate must succeed before that final ContextPackage/store boundary.
 *
 * Checkpoint invariant (validation only): when the Objective Parser resolved
 * a declared latest checkpoint, the caller-supplied mandatory context must
 * already contain that exact checkpoint identity (checkpoint_id). The
 * hydrator never injects, synthesizes, or mutates mandatory records — an
 * invalid integrated request fails closed before any provider, ranking, or
 * omission-store boundary.
 *
 * Integration layer only: no scoring, validation, dedup, budget, omission,
 * or skill-resolution logic is duplicated here. Every stage delegates to the
 * owning module's public API and preserves its native error class/code.
 *
 * raw_source under policy 1.0.1: access is explicit-only and the authority
 * baseline defines no raw_source authority. An explicitly requested raw
 * candidate may pass retrieval and eligibility, but the ranking module
 * rejects it as unknown authority — no synthetic authority value is invented
 * here. This is the known v1 fail-closed behavior; changing it requires a
 * separate policy-version decision.
 *
 * Determinism: no wall-clock, randomness, environment, network, or database
 * reads. hydration_run_id and hydration_started_at are explicit deterministic
 * caller inputs and are never generated here. Identical deterministic inputs
 * produce identical outputs. Inputs are never mutated.
 */

'use strict';

const { parseObjective } = require('./objective-parser.js');
const { resolveSkillChain } = require('./skill-resolver.js');
const { createRetrievalRegistry, retrieveCandidates } = require('./retrieval-adapters.js');
const { evaluateEligibility } = require('./eligibility-gates.js');
const { rankCandidates } = require('./ranking-policy.js');
const { buildContextPackage } = require('./context-package.js');

function isPlainRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Locked v1 checkpoint invariant at the integrated boundary (validation only).
 *
 * The Objective Parser already normalizes latest_checkpoint and exposes the
 * authoritative identity as objective.provenance.checkpoint_id. When that
 * identity is declared (non-empty string), the caller-supplied mandatory
 * context must already contain a plain-object record whose checkpoint_id is
 * strictly equal. The hydrator never synthesizes, appends, or mutates
 * mandatory records — the caller/runtime remains responsible for assembling
 * the actual checkpoint payload. A declared checkpoint that is not
 * represented fails closed before skills, retrieval, ranking, or any
 * omission-store boundary.
 */
function assertDeclaredCheckpointIsMandatory(objective, mandatory) {
  const checkpointId = objective.provenance.checkpoint_id;
  // No declared checkpoint (null / absent) — nothing to enforce.
  if (typeof checkpointId !== 'string') return;
  const represented =
    Array.isArray(mandatory) &&
    mandatory.some((record) => isPlainRecord(record) && record.checkpoint_id === checkpointId);
  if (!represented) {
    throw new TypeError(
      'latest_checkpoint must be represented in mandatory context by matching checkpoint_id'
    );
  }
}

/**
 * Hydrate context through the complete deterministic v1 pipeline.
 *
 * @param {object} params
 * @param {string} params.hydration_run_id - explicit caller-supplied run id (never generated here)
 * @param {string} params.hydration_started_at - explicit immutable RFC3339 UTC run anchor
 * @param {string} params.session_id
 * @param {string} params.job_id
 * @param {string|object|null} [params.latest_checkpoint] - when declared, caller-supplied
 *   mandatory context must already contain a record with the same checkpoint_id
 * @param {string} params.user_request
 * @param {string[]} [params.active_constraints]
 * @param {object} [params.explicit_objective]
 * @param {Array} [params.mandatory] - mandatory context records (pass-through)
 * @param {object} [params.budget_inputs] - explicit tokenizer token counts
 * @param {object} [params.retrieval_providers] - injected candidate providers keyed by source type
 * @param {object} [params.raw_source_request] - explicit raw-source request (if any)
 * @param {Array} [params.skills] - candidate skill records
 * @param {boolean} [params.explicit_skill_override]
 * @param {object} [params.skill_override_request]
 * @param {object} [params.omission_store] - optional omission metadata store
 * @returns {{ context_package: object, skill_chain: object }}
 */
function hydrateContext(params) {
  if (!isPlainRecord(params)) {
    throw new TypeError('hydrateContext input must be a plain object');
  }

  const {
    hydration_run_id,
    hydration_started_at,
    session_id,
    job_id,
    latest_checkpoint,
    user_request,
    active_constraints,
    explicit_objective,
    mandatory,
    budget_inputs,
    retrieval_providers,
    raw_source_request,
    skills,
    explicit_skill_override,
    skill_override_request,
    omission_store,
  } = params;

  // Stage 1 — StructuredObjective. The parsed objective is the authoritative
  // downstream input; no field is reconstructed manually.
  const objective = parseObjective({
    session_id,
    job_id,
    latest_checkpoint,
    user_request,
    active_constraints,
    explicit_objective,
  });

  // Checkpoint invariant (validation only) — enforced after the Objective
  // Parser resolves the authoritative checkpoint identity and before every
  // fail-closed integration gate (skills, retrieval, ranking, package). A
  // missing representation must cause zero provider invocations and zero
  // omission-store writes.
  assertDeclaredCheckpointIsMandatory(objective, mandatory);

  // Stage 2 — Skill chain resolution. Pure fail-closed companion gate that
  // must execute before buildContextPackage() so a skill failure can never
  // occur after omission-store persistence. Native SkillResolverError codes
  // propagate unchanged.
  const skill_chain = resolveSkillChain({
    skills,
    explicit_override: explicit_skill_override,
    override_request: skill_override_request,
  });

  // Stage 3 — Retrieval registry built from caller-injected providers only.
  // This module performs no filesystem, network, database, memory-service, or
  // environment reads of its own.
  const registry = createRetrievalRegistry(retrieval_providers);

  // Deterministic retrieval context. The LOW-confidence gate lives inside the
  // retrieval module: at LOW confidence no provider is invoked at all.
  const retrieval_context = {
    objective,
    objective_confidence: objective.confidence,
    active_job_id: job_id,
    active_session_id: session_id,
    hydration_started_at,
    raw_source_request,
  };

  const retrieval = retrieveCandidates(registry, retrieval_context);

  // Stage 4 — Eligibility gates over the retrieved candidates. Foreign-job,
  // unknown-source, LOW-confidence, and non-explicit raw records are stopped
  // by the existing gates; nothing is softened here.
  const eligibility = evaluateEligibility(retrieval.candidates, {
    active_job_id: job_id,
    active_session_id: session_id,
    objective_confidence: objective.confidence,
    raw_source_request,
  });

  // Only eligible === true candidates proceed toward ranking.
  const eligible_candidates = eligibility.eligible.map((decision) => decision.candidate);

  // Stage 5 — Deterministic ranking. Unknown-authority records (including
  // raw_source under 1.0.1) are rejected fail-closed by the ranking module.
  const ranking = rankCandidates({
    objective_retrieval_terms: objective.retrieval_terms,
    candidates: eligible_candidates,
    active_job_id: job_id,
    active_session_id: session_id,
    hydration_started_at,
  });

  // Stage 6 — Integration wiring only: project the deterministic ranking
  // output onto the ContextPackage candidate contract
  // (score = total_score, rank = 1-based ranked position). Copies only —
  // ranking output records are never mutated and no score is recalculated.
  const projected_candidates = ranking.ranked.map((record, index) => ({
    ...record,
    score: record.total_score,
    rank: index + 1,
  }));

  // Stage 7 — ContextPackage assembly. The only integration stage that may
  // write omission metadata; it persists through the existing
  // buildContextPackage() behavior after full package validation succeeds.
  const context_package = buildContextPackage({
    hydration_run_id,
    hydration_started_at,
    objective,
    job_id,
    session_id,
    mandatory,
    candidates: projected_candidates,
    budget_inputs,
    omission_store,
  });

  return {
    context_package,
    skill_chain,
  };
}

module.exports = { hydrateContext };
