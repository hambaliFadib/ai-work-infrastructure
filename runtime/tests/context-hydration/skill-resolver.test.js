/**
 * Context Hydration — Skill Resolver test suite.
 *
 * Policy: context-hydration@1.0.1
 * Lane: #13 (9A-06) — deterministic skill resolver.
 *
 * Coverage:
 *  - S01-S10 acceptance invariants
 *  - 1/2/3 skills, 4/5 with and without override, 6 with and without override
 *  - conflict fail-closed and hard-limit precedence
 *  - explicit user skill priority and retention
 *  - phase ordering and same-phase stability
 *  - runtime-policy, permission, and security boundaries
 *  - immutability and determinism
 *
 * Deterministic. No network. No DB. No env reads. No wall-clock reads.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const {
  SKILL_CLASSES,
  EXECUTION_ORDER,
  LIMITS,
  SKILL_ERRORS,
  PROTECTED_OVERRIDE_DOMAINS,
  SkillResolverError,
  resolveSkillChain,
} = require('../../context-hydration/skill-resolver.js');

const REPO = path.resolve(__dirname, '..', '..', '..');
const policy = JSON.parse(
  fs.readFileSync(path.join(REPO, 'governance', 'policies', 'context-hydration.json'), 'utf8')
);

let passed = 0;
let failed = 0;

function test(label, fn) {
  try {
    fn();
    passed += 1;
    console.log(`${label}: PASS`);
  } catch (e) {
    failed += 1;
    console.log(`${label}: FAIL — ${e.message}`);
  }
}

function skill(skill_id, cls, phase, explicit) {
  const record = { skill_id, class: cls, phase };
  if (explicit !== undefined) record.explicit = explicit;
  return record;
}

const a = skill('skill-a', 'PRIMARY', 'UNDERSTAND');
const b = skill('skill-b', 'SUPPORTING', 'DESIGN/PLAN');
const c = skill('skill-c', 'PRIMARY', 'EXECUTE');
const d = skill('skill-d', 'SUPPORTING', 'VALIDATE');
const e = skill('skill-e', 'PRIMARY', 'EXECUTE');
const f = skill('skill-f', 'SUPPORTING', 'VALIDATE');
const x = skill('skill-x', 'CONFLICTING', 'EXECUTE');

function isError(code) {
  return (err) => err instanceof SkillResolverError && err.code === code;
}

// ---------------------------------------------------------------------------
// Policy parity
// ---------------------------------------------------------------------------

// SK01: resolver constants match policy 1.0.1 exactly
test('SK01 constants match policy 1.0.1', () => {
  assert.deepStrictEqual(SKILL_CLASSES, policy.skills.classes);
  assert.deepStrictEqual(EXECUTION_ORDER, policy.skills.execution_order);
  assert.deepStrictEqual(LIMITS, policy.skills.limits);
  assert.strictEqual(SKILL_ERRORS.CHAIN_REQUIRES_OVERRIDE, policy.skills.errors.chain_requires_override);
  assert.strictEqual(SKILL_ERRORS.CHAIN_LIMIT_EXCEEDED, policy.skills.errors.chain_limit_exceeded);
  assert.strictEqual(SKILL_ERRORS.CONFLICT, policy.skills.errors.conflict);
  const dr = policy.skills.decision_rules;
  assert.strictEqual(dr.allow_at_or_below_default_without_override, true);
  assert.strictEqual(dr.require_override_above_default_through_hard_max, true);
  assert.strictEqual(dr.allow_through_hard_max_with_override, true);
  assert.strictEqual(dr.reject_above_hard_max_regardless_of_override, true);
  assert.strictEqual(dr.hard_limit_precedes_override_requirement, true);
  const inv = policy.skills.invariants;
  assert.strictEqual(inv.never_silently_truncate, true);
  assert.strictEqual(inv.user_explicit_highest_priority, true);
  assert.strictEqual(inv.cannot_override_runtime_policy, true);
  assert.strictEqual(inv.cannot_override_permissions, true);
  assert.strictEqual(inv.cannot_override_security_constraints, true);
  assert.deepStrictEqual(
    PROTECTED_OVERRIDE_DOMAINS,
    ['runtime_policy', 'permissions', 'security_constraints']
  );
});

// ---------------------------------------------------------------------------
// S01-S06: chain sizes and limits
// ---------------------------------------------------------------------------

// SK02: S01 — one matching skill resolves
test('SK02 S01 one matching skill', () => {
  const result = resolveSkillChain({ skills: [a] });
  assert.strictEqual(result.count, 1);
  assert.strictEqual(result.ordered.length, 1);
  assert.strictEqual(result.ordered[0].skill_id, 'skill-a');
  assert.strictEqual(result.override_applied, false);
});

// SK03: S02 — two compatible skills resolve
test('SK03 S02 two compatible skills', () => {
  const result = resolveSkillChain({ skills: [a, b] });
  assert.strictEqual(result.count, 2);
  assert.deepStrictEqual(result.ordered.map((r) => r.skill_id), ['skill-a', 'skill-b']);
});

// SK04: S03 — three compatible skills allowed by default
test('SK04 S03 three skills allowed by default', () => {
  const result = resolveSkillChain({ skills: [a, b, c] });
  assert.strictEqual(result.count, 3);
  assert.strictEqual(result.override_applied, false);
});

// SK05: S04 — four skills without override require explicit override
test('SK05 S04 four skills without override rejected', () => {
  assert.throws(
    () => resolveSkillChain({ skills: [a, b, c, d] }),
    isError(SKILL_ERRORS.CHAIN_REQUIRES_OVERRIDE)
  );
});

// SK06: S04 — four skills with explicit override allowed
test('SK06 S04 four skills with override allowed', () => {
  const result = resolveSkillChain({ skills: [a, b, c, d], explicit_override: true });
  assert.strictEqual(result.count, 4);
  assert.strictEqual(result.override_applied, true);
  assert.deepStrictEqual(
    result.ordered.map((r) => r.skill_id),
    ['skill-a', 'skill-b', 'skill-c', 'skill-d']
  );
});

// SK07: S05 — five skills without override require explicit override
test('SK07 S05 five skills without override rejected', () => {
  assert.throws(
    () => resolveSkillChain({ skills: [a, b, c, d, e] }),
    isError(SKILL_ERRORS.CHAIN_REQUIRES_OVERRIDE)
  );
});

// SK08: S05 — five skills with explicit override allowed
test('SK08 S05 five skills with override allowed', () => {
  const result = resolveSkillChain({ skills: [a, b, c, d, e], explicit_override: true });
  assert.strictEqual(result.count, 5);
  assert.strictEqual(result.override_applied, true);
  assert.deepStrictEqual(
    result.ordered.map((r) => r.skill_id),
    ['skill-a', 'skill-b', 'skill-c', 'skill-e', 'skill-d']
  );
});

// SK09: S06 — six skills without override rejected
test('SK09 S06 six skills without override rejected', () => {
  assert.throws(
    () => resolveSkillChain({ skills: [a, b, c, d, e, f] }),
    isError(SKILL_ERRORS.CHAIN_LIMIT_EXCEEDED)
  );
});

// SK10: S06 — six skills with override still rejected
test('SK10 S06 six skills with override rejected', () => {
  assert.throws(
    () => resolveSkillChain({ skills: [a, b, c, d, e, f], explicit_override: true }),
    isError(SKILL_ERRORS.CHAIN_LIMIT_EXCEEDED)
  );
});

// SK11: hard-limit evaluation precedes override-required evaluation
test('SK11 hard-limit precedence over override-required', () => {
  assert.throws(
    () => resolveSkillChain({ skills: [a, b, c, d, e, f] }),
    (err) =>
      err instanceof SkillResolverError &&
      err.code === 'SKILL_CHAIN_LIMIT_EXCEEDED' &&
      err.code !== 'SKILL_CHAIN_REQUIRES_OVERRIDE'
  );
});

// SK12: S07 — chain never silently truncated
test('SK12 S07 chain never silently truncated', () => {
  // A disallowed chain throws; it never returns a truncated prefix.
  assert.throws(
    () => resolveSkillChain({ skills: [a, b, c, d] }),
    isError(SKILL_ERRORS.CHAIN_REQUIRES_OVERRIDE)
  );
  // An allowed chain returns every unique skill — count === ordered.length.
  const five = resolveSkillChain({ skills: [a, b, c, d, e], explicit_override: true });
  assert.strictEqual(five.count, 5);
  assert.strictEqual(five.ordered.length, 5);
  assert.deepStrictEqual(
    [...five.ordered.map((r) => r.skill_id)].sort(),
    ['skill-a', 'skill-b', 'skill-c', 'skill-d', 'skill-e'].sort()
  );
});

// ---------------------------------------------------------------------------
// Conflict
// ---------------------------------------------------------------------------

// SK13: S08 — conflicting skills fail closed in every configuration
test('SK13 S08 conflicting skills fail closed', () => {
  assert.throws(() => resolveSkillChain({ skills: [a, x] }), isError(SKILL_ERRORS.CONFLICT));
  assert.throws(() => resolveSkillChain({ skills: [a, b, c, x] }), isError(SKILL_ERRORS.CONFLICT));
  assert.throws(
    () => resolveSkillChain({ skills: [a, b, c, d, x], explicit_override: true }),
    isError(SKILL_ERRORS.CONFLICT)
  );
  // Fail closed: no partial result is ever returned.
  let returned = null;
  try {
    returned = resolveSkillChain({ skills: [a, x] });
  } catch (err) {
    assert.strictEqual(err.code, 'SKILL_CONFLICT');
  }
  assert.strictEqual(returned, null);
});

// SK14: conflict evaluated before chain limits (documented resolver precedence)
test('SK14 conflict precedes limit evaluation', () => {
  // Six skills including a conflicting one: conflict fails closed first.
  assert.throws(
    () => resolveSkillChain({ skills: [a, b, c, d, e, x] }),
    isError(SKILL_ERRORS.CONFLICT)
  );
});

// ---------------------------------------------------------------------------
// Explicit user skill priority
// ---------------------------------------------------------------------------

// SK15: S09 — explicit user skill retained in the resolved chain
test('SK15 S09 explicit user skill retained', () => {
  const explicitSkill = skill('skill-e', 'PRIMARY', 'EXECUTE', true);
  const result = resolveSkillChain({ skills: [a, explicitSkill, b] });
  assert.strictEqual(result.count, 3);
  const record = result.ordered.find((r) => r.skill_id === 'skill-e');
  assert.ok(record, 'explicit skill must be retained');
  assert.strictEqual(record.explicit, true);
});

// SK16: explicit flag survives duplicate-identity collapse
test('SK16 explicit flag survives dedup merge', () => {
  const implicit = skill('skill-e', 'PRIMARY', 'EXECUTE');
  const explicit = skill('skill-e', 'PRIMARY', 'EXECUTE', true);
  const first = resolveSkillChain({ skills: [implicit, explicit] });
  assert.strictEqual(first.count, 1);
  assert.strictEqual(first.ordered[0].explicit, true);
  const second = resolveSkillChain({ skills: [explicit, implicit] });
  assert.strictEqual(second.count, 1);
  assert.strictEqual(second.ordered[0].explicit, true);
});

// SK17: explicit user skill cannot bypass chain limits
test('SK17 explicit skill cannot bypass chain limits', () => {
  const explicitSkill = skill('skill-e', 'PRIMARY', 'EXECUTE', true);
  assert.throws(
    () => resolveSkillChain({ skills: [a, b, c, explicitSkill] }),
    isError(SKILL_ERRORS.CHAIN_REQUIRES_OVERRIDE)
  );
  assert.throws(
    () => resolveSkillChain({ skills: [a, b, c, d, explicitSkill, f], explicit_override: true }),
    isError(SKILL_ERRORS.CHAIN_LIMIT_EXCEEDED)
  );
});

// SK18: explicit conflicting skill still fails closed
test('SK18 explicit conflicting skill fails closed', () => {
  const explicitConflict = skill('skill-x', 'CONFLICTING', 'EXECUTE', true);
  assert.throws(
    () => resolveSkillChain({ skills: [a, explicitConflict], explicit_override: true }),
    isError(SKILL_ERRORS.CONFLICT)
  );
});

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

// SK19: chain ordered by the normative execution order
test('SK19 chain ordered by execution order', () => {
  const result = resolveSkillChain({ skills: [d, a, c, b], explicit_override: true });
  assert.deepStrictEqual(
    result.ordered.map((r) => r.phase),
    ['UNDERSTAND', 'DESIGN/PLAN', 'EXECUTE', 'VALIDATE']
  );
  assert.deepStrictEqual(
    result.ordered.map((r) => r.skill_id),
    ['skill-a', 'skill-b', 'skill-c', 'skill-d']
  );
});

// SK20: same-phase ordering is stable and input-order deterministic
test('SK20 same-phase ordering stable', () => {
  const first = resolveSkillChain({ skills: [c, e] });
  assert.deepStrictEqual(first.ordered.map((r) => r.skill_id), ['skill-c', 'skill-e']);
  const second = resolveSkillChain({ skills: [e, c] });
  assert.deepStrictEqual(second.ordered.map((r) => r.skill_id), ['skill-e', 'skill-c']);
});

// ---------------------------------------------------------------------------
// Boundaries: runtime policy, permissions, security constraints
// ---------------------------------------------------------------------------

// SK21: runtime-policy boundary
test('SK21 runtime-policy boundary fails closed', () => {
  assert.throws(
    () => resolveSkillChain({ skills: [a], override_request: { runtime_policy: true } }),
    isError(SKILL_ERRORS.OVERRIDE_FORBIDDEN)
  );
});

// SK22: permission boundary
test('SK22 permission boundary fails closed', () => {
  assert.throws(
    () => resolveSkillChain({ skills: [a], override_request: { permissions: true } }),
    isError(SKILL_ERRORS.OVERRIDE_FORBIDDEN)
  );
});

// SK23: security boundary
test('SK23 security boundary fails closed', () => {
  assert.throws(
    () => resolveSkillChain({ skills: [a], override_request: { security_constraints: true } }),
    isError(SKILL_ERRORS.OVERRIDE_FORBIDDEN)
  );
});

// SK24: unknown override targets and truthy non-boolean values fail closed
test('SK24 unknown override targets fail closed', () => {
  assert.throws(
    () => resolveSkillChain({ skills: [a], override_request: { network: true } }),
    isError(SKILL_ERRORS.OVERRIDE_FORBIDDEN)
  );
  assert.throws(
    () => resolveSkillChain({ skills: [a], override_request: { runtime_policy: 'yes' } }),
    isError(SKILL_ERRORS.OVERRIDE_FORBIDDEN)
  );
});

// SK25: all-false override request is allowed
test('SK25 all-false override request allowed', () => {
  const result = resolveSkillChain({
    skills: [a],
    override_request: { runtime_policy: false, permissions: false, security_constraints: false },
  });
  assert.strictEqual(result.count, 1);
});

// SK26: boundary evaluation precedes chain validity checks
test('SK26 boundary precedes chain validity', () => {
  assert.throws(
    () => resolveSkillChain({ skills: [x], override_request: { permissions: true } }),
    isError(SKILL_ERRORS.OVERRIDE_FORBIDDEN)
  );
});

// ---------------------------------------------------------------------------
// Validation, dedup, determinism, immutability
// ---------------------------------------------------------------------------

// SK27: invalid inputs fail closed
test('SK27 invalid inputs fail closed', () => {
  const invalidCases = [
    () => resolveSkillChain(null),
    () => resolveSkillChain('not-an-object'),
    () => resolveSkillChain({ skills: 'not-an-array' }),
    () => resolveSkillChain({ skills: [null] }),
    () => resolveSkillChain({ skills: [{}] }),
    () => resolveSkillChain({ skills: [skill('', 'PRIMARY', 'UNDERSTAND')] }),
    () => resolveSkillChain({ skills: [skill('s', 'SECONDARY', 'UNDERSTAND')] }),
    () => resolveSkillChain({ skills: [skill('s', 'PRIMARY', 'PLAN')] }),
    () => resolveSkillChain({ skills: [skill('s', 'PRIMARY', 'UNDERSTAND', 'yes')] }),
    () => resolveSkillChain({ skills: [a], explicit_override: 'yes' }),
    () => resolveSkillChain({ skills: [a], override_request: 'nope' }),
  ];
  for (const invalidCase of invalidCases) {
    assert.throws(invalidCase, isError(SKILL_ERRORS.INVALID_INPUT));
  }
});

// SK28: empty chain resolves deterministically
test('SK28 empty chain resolves deterministically', () => {
  const result = resolveSkillChain({ skills: [] });
  assert.strictEqual(result.count, 0);
  assert.deepStrictEqual(result.ordered, []);
  assert.strictEqual(result.override_applied, false);
});

// SK29: duplicate identities collapse; conflicting duplicates still fail closed
test('SK29 duplicate identities collapse deterministically', () => {
  const result = resolveSkillChain({ skills: [a, a, a] });
  assert.strictEqual(result.count, 1);
  assert.strictEqual(result.ordered[0].skill_id, 'skill-a');
  // A conflicting duplicate of the same identity still fails closed.
  assert.throws(
    () =>
      resolveSkillChain({
        skills: [skill('skill-a', 'PRIMARY', 'UNDERSTAND'), skill('skill-a', 'CONFLICTING', 'UNDERSTAND')],
      }),
    isError(SKILL_ERRORS.CONFLICT)
  );
});

// SK30: output shape and override_applied semantics
test('SK30 output shape and override semantics', () => {
  const result = resolveSkillChain({ skills: [a, b, c], explicit_override: true });
  assert.deepStrictEqual(Object.keys(result).sort(), ['count', 'ordered', 'override_applied']);
  assert.strictEqual(result.override_applied, false, 'override not required at <= 3');
  for (const record of result.ordered) {
    assert.deepStrictEqual(
      Object.keys(record).sort(),
      ['class', 'explicit', 'phase', 'skill_id']
    );
  }
  const withOverride = resolveSkillChain({ skills: [a, b, c, d], explicit_override: true });
  assert.strictEqual(withOverride.override_applied, true);
});

// SK31: PRIMARY and SUPPORTING are both compatible (no special semantics)
test('SK31 primary and supporting both compatible', () => {
  const result = resolveSkillChain({
    skills: [
      skill('p1', 'PRIMARY', 'UNDERSTAND'),
      skill('s1', 'SUPPORTING', 'EXECUTE'),
      skill('p2', 'PRIMARY', 'VALIDATE'),
    ],
  });
  assert.strictEqual(result.count, 3);
});

// SK32: repeated calls are identical; inputs are never mutated
test('SK32 determinism and immutability', () => {
  const input = { skills: [d, a, c], explicit_override: false };
  const snapshot = JSON.parse(JSON.stringify(input));
  const first = resolveSkillChain(input);
  const second = resolveSkillChain(input);
  assert.deepStrictEqual(first, second);
  assert.deepStrictEqual(input, snapshot, 'input must not be mutated');
  // The result is a copy: mutating it cannot affect later calls.
  first.ordered[0].skill_id = 'mutated';
  first.ordered.push({});
  const third = resolveSkillChain(input);
  assert.deepStrictEqual(third, second);
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n=== Context Hydration Skill Resolver Test Summary ===`);
console.log(`Cases: ${passed + failed}, Passed: ${passed}, Failed: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
