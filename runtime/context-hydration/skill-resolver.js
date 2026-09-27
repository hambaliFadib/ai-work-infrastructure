/**
 * Context Hydration v1 — Deterministic Skill Resolver
 *
 * Policy: context-hydration@1.0.1
 * Contract: governance/contracts/context-hydration-v1.md §11 (S01-S10)
 *
 * Resolves a deterministic skill chain: validates candidate skill records,
 * fails closed on conflicts, enforces the default/override/hard chain limits
 * with the exact policy error codes, and returns the chain ordered by the
 * normative execution order.
 *
 * Invariants (policy 1.0.1 skills.invariants):
 *  - never silently truncate
 *  - explicit user-selected skill has highest skill-selection priority
 *  - skills can NEVER override runtime policy, permissions, or security
 *    constraints (fail closed)
 *
 * Determinism: no wall-clock reads, no network, no environment access, no
 * randomness. Identical inputs produce identical outputs. Inputs are never
 * mutated. Exported policy constants (SKILL_CLASSES, EXECUTION_ORDER,
 * LIMITS, SKILL_ERRORS, PROTECTED_OVERRIDE_DOMAINS) are frozen: consumers
 * can never mutate resolver policy globally.
 */

'use strict';

const POLICY_ID = 'context-hydration';
const POLICY_VERSION = '1.0.1';

/**
 * Exported policy constants are frozen so consumers can never mutate
 * resolver policy globally (determinism: identical calls must not depend on
 * earlier callers).
 */

/** Policy 1.0.1 skills.classes — exact class values. Frozen. */
const SKILL_CLASSES = Object.freeze(['PRIMARY', 'SUPPORTING', 'CONFLICTING']);

/** Policy 1.0.1 skills.execution_order — normative phase order. Frozen. */
const EXECUTION_ORDER = Object.freeze(['UNDERSTAND', 'DESIGN/PLAN', 'EXECUTE', 'VALIDATE']);

/** Policy 1.0.1 skills.limits — default / override / hard maxima. Frozen. */
const LIMITS = Object.freeze({
  default_max: 3,
  override_max: 5,
  hard_max: 5,
});

/**
 * Policy 1.0.1 skills.errors — exact policy error codes. Frozen.
 * OVERRIDE_FORBIDDEN and INVALID_INPUT are resolver-level fail-closed guards
 * implementing the §11.6 invariants; they are not policy-defined codes.
 */
const SKILL_ERRORS = Object.freeze({
  CHAIN_REQUIRES_OVERRIDE: 'SKILL_CHAIN_REQUIRES_OVERRIDE',
  CHAIN_LIMIT_EXCEEDED: 'SKILL_CHAIN_LIMIT_EXCEEDED',
  CONFLICT: 'SKILL_CONFLICT',
  OVERRIDE_FORBIDDEN: 'SKILL_OVERRIDE_FORBIDDEN',
  INVALID_INPUT: 'SKILL_INVALID_INPUT',
});

/**
 * Domains a skill chain may NEVER override (contract §11.6). Frozen.
 * Any truthy override request for any key (known or unknown) fails closed.
 */
const PROTECTED_OVERRIDE_DOMAINS = Object.freeze([
  'runtime_policy',
  'permissions',
  'security_constraints',
]);

class SkillResolverError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SkillResolverError';
    this.code = code;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function invalidInput(message) {
  return new SkillResolverError(SKILL_ERRORS.INVALID_INPUT, message);
}

/** Position of a phase in the normative execution order. */
function phaseIndex(phase) {
  return EXECUTION_ORDER.indexOf(phase);
}

/**
 * Fail closed when a resolution request attempts to override any protected
 * domain (runtime policy, permissions, security constraints). Any truthy
 * entry — known or unknown key — is treated as a forbidden override attempt
 * because it cannot be verified as safe.
 */
function assertNoForbiddenOverride(overrideRequest) {
  if (overrideRequest === undefined || overrideRequest === null) return;
  if (!isPlainObject(overrideRequest)) {
    throw invalidInput('override_request must be a plain object when provided');
  }
  const attempts = Object.keys(overrideRequest).filter((key) => Boolean(overrideRequest[key]));
  if (attempts.length > 0) {
    throw new SkillResolverError(
      SKILL_ERRORS.OVERRIDE_FORBIDDEN,
      `skill chains can never override: ${attempts.join(', ')}`
    );
  }
}

/**
 * Validate candidate skill records and return normalized copies in input
 * order (duplicates are NOT collapsed here; conflict detection operates on
 * the full validated set).
 *
 * Record contract: skill_id (non-empty string), class (one of SKILL_CLASSES),
 * phase (one of EXECUTION_ORDER), optional explicit (boolean).
 */
function validateSkillRecords(skills) {
  if (!Array.isArray(skills)) {
    throw invalidInput('skills must be an array');
  }
  return skills.map((record) => {
    if (!isPlainObject(record)) {
      throw invalidInput('skill record must be a plain object');
    }
    if (typeof record.skill_id !== 'string' || record.skill_id.length === 0) {
      throw invalidInput('skill record must carry a non-empty skill_id');
    }
    if (!SKILL_CLASSES.includes(record.class)) {
      throw invalidInput(`skill ${record.skill_id} must carry a valid class`);
    }
    if (!EXECUTION_ORDER.includes(record.phase)) {
      throw invalidInput(`skill ${record.skill_id} must carry a valid phase`);
    }
    if (record.explicit !== undefined && typeof record.explicit !== 'boolean') {
      throw invalidInput(`skill ${record.skill_id} explicit flag must be a boolean`);
    }
    return {
      skill_id: record.skill_id,
      class: record.class,
      phase: record.phase,
      explicit: record.explicit === true,
    };
  });
}

/**
 * Collapse duplicate skill identities deterministically.
 *
 * Identity: skill_id. The first occurrence keeps class and phase; the
 * explicit flag is the logical OR across all occurrences so an explicitly
 * user-selected skill can never lose its priority through deduplication.
 * Input order of first occurrences is preserved.
 */
function deduplicateSkills(records) {
  const byId = new Map();
  for (const record of records) {
    const existing = byId.get(record.skill_id);
    if (existing === undefined) {
      byId.set(record.skill_id, { ...record });
    } else if (record.explicit) {
      existing.explicit = true;
    }
  }
  return [...byId.values()];
}

/**
 * Resolve a deterministic skill chain under policy 1.0.1.
 *
 * Evaluation order (documented resolver decision; the only precedence the
 * contract mandates is hard-limit before override-required, which is
 * honored):
 *   1. structural input validation
 *   2. protected-override boundary (fail closed)
 *   3. skill record validation
 *   4. conflict — any CONFLICTING-class record fails the chain closed
 *   5. duplicate identity collapse (explicit flag preserved)
 *   6. hard maximum — > 5 skills always SKILL_CHAIN_LIMIT_EXCEEDED
 *   7. override requirement — 4-5 without explicit override →
 *      SKILL_CHAIN_REQUIRES_OVERRIDE
 *   8. allowed — return the chain ordered by the normative execution order
 *
 * Never silently truncates: the resolver either fails closed or returns the
 * complete resolved chain (count === ordered.length === unique skills).
 *
 * @param {object} input
 * @param {Array} input.skills - candidate skill records
 * @param {boolean} [input.explicit_override] - explicit user chain override
 * @param {object} [input.override_request] - must be absent or all-false;
 *   any truthy entry fails closed
 * @returns {{ count: number, ordered: Array, override_applied: boolean }}
 */
function resolveSkillChain(input) {
  if (!isPlainObject(input)) {
    throw invalidInput('resolveSkillChain input must be a plain object');
  }
  const { skills, explicit_override, override_request } = input;

  if (explicit_override !== undefined && typeof explicit_override !== 'boolean') {
    throw invalidInput('explicit_override must be a boolean when provided');
  }
  const hasOverride = explicit_override === true;

  // Boundary first: protected domains can never be overridden.
  assertNoForbiddenOverride(override_request);

  // Validate all records, then fail closed on any conflicting class record.
  const validated = validateSkillRecords(skills);
  const conflicting = validated.filter((record) => record.class === 'CONFLICTING');
  if (conflicting.length > 0) {
    throw new SkillResolverError(
      SKILL_ERRORS.CONFLICT,
      `conflicting skills present: ${conflicting.map((record) => record.skill_id).join(', ')}`
    );
  }

  // Collapse duplicate identities (explicit flag preserved).
  const unique = deduplicateSkills(validated);
  const count = unique.length;

  // Hard limit precedes override-required evaluation (contract §11.4):
  // 6 skills without override → SKILL_CHAIN_LIMIT_EXCEEDED, never
  // SKILL_CHAIN_REQUIRES_OVERRIDE.
  if (count > LIMITS.hard_max) {
    throw new SkillResolverError(
      SKILL_ERRORS.CHAIN_LIMIT_EXCEEDED,
      `${count} skills exceed the hard maximum of ${LIMITS.hard_max}`
    );
  }

  // 4-5 skills require the explicit user override.
  if (count > LIMITS.default_max && !hasOverride) {
    throw new SkillResolverError(
      SKILL_ERRORS.CHAIN_REQUIRES_OVERRIDE,
      `${count} skills require an explicit override`
    );
  }

  // Deterministic stable ordering by the normative execution order.
  const ordered = unique
    .map((record, index) => ({ record, index }))
    .sort((a, b) => {
      const phaseDelta = phaseIndex(a.record.phase) - phaseIndex(b.record.phase);
      if (phaseDelta !== 0) return phaseDelta;
      return a.index - b.index;
    })
    .map((entry) => ({ ...entry.record }));

  return {
    count,
    ordered,
    override_applied: hasOverride && count > LIMITS.default_max,
  };
}

module.exports = {
  POLICY_ID,
  POLICY_VERSION,
  SKILL_CLASSES,
  EXECUTION_ORDER,
  LIMITS,
  SKILL_ERRORS,
  PROTECTED_OVERRIDE_DOMAINS,
  SkillResolverError,
  phaseIndex,
  resolveSkillChain,
};
