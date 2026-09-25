/**
 * Context Hydration v1 — Contract Test
 *
 * Deterministic repository contract test.
 * Reads tracked repository files only.
 * No env reads, no network, no database, no Oracle.
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const REPO = path.resolve(__dirname, '..', '..', '..');
const POLICY_PATH = path.join(REPO, 'governance', 'policies', 'context-hydration.json');
const CONTRACT_PATH = path.join(REPO, 'governance', 'contracts', 'context-hydration-v1.md');
const ARCH_PATH = path.join(REPO, 'docs', 'architecture', 'context-hydration.md');

let passed = 0;
let failed = 0;

function test(label, fn) {
  try {
    fn();
    passed++;
    console.log(`${label}: PASS`);
  } catch (e) {
    failed++;
    console.log(`${label}: FAIL — ${e.message}`);
  }
}

// Load policy
let policy;
try {
  policy = JSON.parse(fs.readFileSync(POLICY_PATH, 'utf8'));
} catch (e) {
  console.error('FATAL: Cannot parse policy file:', e.message);
  process.exit(1);
}

// Load contract doc
let contractDoc;
try {
  contractDoc = fs.readFileSync(CONTRACT_PATH, 'utf8');
} catch (e) {
  console.error('FATAL: Cannot read contract doc:', e.message);
  process.exit(1);
}

// Load architecture doc
let archDoc;
try {
  archDoc = fs.readFileSync(ARCH_PATH, 'utf8');
} catch (e) {
  console.error('FATAL: Cannot read architecture doc:', e.message);
  process.exit(1);
}

// C01: Policy file parses
test('C01 policy file parses', () => {
  assert.ok(policy, 'Policy must be non-null');
  assert.strictEqual(typeof policy, 'object', 'Policy must be an object');
});

// C02: policy_id exact
test('C02 policy_id exact', () => {
  assert.strictEqual(policy.policy_id, 'context-hydration');
});

// C03: policy_version exact
test('C03 policy_version exact', () => {
  assert.strictEqual(policy.policy_version, '1.0.0');
});

// C04: policy_ref exact
test('C04 policy_ref exact', () => {
  assert.strictEqual(policy.policy_ref, 'context-hydration@1.0.0');
});

// C05: weights sum exactly 1.00
test('C05 weights sum exactly 1.00', () => {
  const w = policy.ranking.weights;
  const sum = w.semantic_relevance + w.scope_specificity + w.authority + w.recency;
  assert.strictEqual(sum, 1.00);
});

// C06: exact weight values
test('C06 exact weight values', () => {
  const w = policy.ranking.weights;
  assert.strictEqual(w.semantic_relevance, 0.50);
  assert.strictEqual(w.scope_specificity, 0.25);
  assert.strictEqual(w.authority, 0.20);
  assert.strictEqual(w.recency, 0.05);
});

// C07: confidence thresholds exact
test('C07 confidence thresholds exact', () => {
  assert.strictEqual(policy.confidence.high_threshold, 0.80);
  assert.strictEqual(policy.confidence.medium_threshold, 0.60);
  assert.strictEqual(policy.confidence.low_below, 0.60);
});

// C08: LOW disables auto retrieval
test('C08 LOW disables auto retrieval', () => {
  assert.strictEqual(policy.confidence.low_behavior.automatic_retrieval_disabled, true);
  assert.strictEqual(policy.confidence.low_behavior.mandatory_context_loads, true);
});

// C09: foreign-job hard reject
test('C09 foreign-job hard reject', () => {
  assert.strictEqual(policy.retrieval.foreign_job_reject, true);
});

// C10: raw source automatic=false
test('C10 raw source automatic=false', () => {
  assert.strictEqual(policy.retrieval.raw_automatic_retrieval, false);
  assert.strictEqual(policy.retrieval.eligibility.raw_source, 'explicit_only');
});

// C11: semantic memory advisory/non-authoritative
test('C11 semantic memory advisory/non-authoritative', () => {
  assert.strictEqual(policy.retrieval.semantic_memory_authoritative, false);
  assert.strictEqual(policy.retrieval.eligibility.semantic_memory, 'advisory');
});

// C12: latest checkpoint mandatory
test('C12 latest checkpoint mandatory', () => {
  assert.strictEqual(policy.retrieval.latest_checkpoint_mandatory, true);
  assert.strictEqual(policy.retrieval.latest_checkpoint_bypasses_ranking, true);
});

// C13: retrieval budget=.20
test('C13 retrieval budget=.20', () => {
  assert.strictEqual(policy.budget.retrieved_max_fraction, 0.20);
});

// C14: mandatory protected set complete
test('C14 mandatory protected set complete', () => {
  const required = [
    'current_objective',
    'job_profile_identity',
    'active_safety_constraints',
    'approval_state',
    'latest_valid_checkpoint',
    'mandatory_project_instructions'
  ];
  const actual = policy.budget.mandatory_protected_set;
  for (const item of required) {
    assert.ok(actual.includes(item), `Missing protected item: ${item}`);
  }
});

// C15: overflow error exact
test('C15 overflow error exact', () => {
  assert.strictEqual(policy.budget.overflow_error, 'CONTEXT_BUDGET_EXCEEDED');
});

// C16: omitted full-content persistence=false
test('C16 omitted full-content persistence=false', () => {
  assert.strictEqual(policy.omission.full_content_persistence, false);
});

// C17: omission metadata allowlist exact
test('C17 omission metadata allowlist exact', () => {
  const required = [
    'source_id', 'source_type', 'scope', 'score',
    'rank', 'omission_reason', 'estimated_tokens', 'hydration_run_id'
  ];
  const actual = policy.omission.allowed_metadata;
  assert.deepStrictEqual(actual.sort(), required.sort());
});

// C18: metadata retention=30 days
test('C18 metadata retention=30 days', () => {
  assert.strictEqual(policy.omission.retention_days, 30);
});

// C19: omission metadata local-only
test('C19 omission metadata local-only', () => {
  assert.strictEqual(policy.omission.local_only, true);
  assert.strictEqual(policy.omission.redacted, true);
});

// C20: skill limits 3/5/5
test('C20 skill limits 3/5/5', () => {
  assert.strictEqual(policy.skills.limits.default_max, 3);
  assert.strictEqual(policy.skills.limits.override_max, 5);
  assert.strictEqual(policy.skills.limits.hard_max, 5);
});

// C21: skill errors exact
test('C21 skill errors exact', () => {
  assert.strictEqual(policy.skills.errors.chain_requires_override, 'SKILL_CHAIN_REQUIRES_OVERRIDE');
  assert.strictEqual(policy.skills.errors.chain_limit_exceeded, 'SKILL_CHAIN_LIMIT_EXCEEDED');
  assert.strictEqual(policy.skills.errors.conflict, 'SKILL_CONFLICT');
});

// C22: acceptance objective IDs O01–O10 exact
test('C22 acceptance objective IDs O01-O10 exact', () => {
  const expected = ['O01','O02','O03','O04','O05','O06','O07','O08','O09','O10'];
  assert.deepStrictEqual(policy.acceptance.objective_ids.sort(), expected.sort());
});

// C23: hydration IDs H01–H17 exact
test('C23 hydration IDs H01-H17 exact', () => {
  const expected = Array.from({length: 17}, (_, i) => `H${String(i+1).padStart(2, '0')}`);
  assert.deepStrictEqual(policy.acceptance.hydration_ids.sort(), expected.sort());
});

// C24: skill IDs S01–S10 exact
test('C24 skill IDs S01-S10 exact', () => {
  const expected = Array.from({length: 10}, (_, i) => `S${String(i+1).padStart(2, '0')}`);
  assert.deepStrictEqual(policy.acceptance.skill_ids.sort(), expected.sort());
});

// C25: acceptance total=37
test('C25 acceptance total=37', () => {
  assert.strictEqual(policy.acceptance.total, 37);
});

// C26: contract document references policy version
test('C26 contract document references policy version', () => {
  assert.ok(contractDoc.includes('context-hydration@1.0.0'), 'Contract must reference policy_ref');
  assert.ok(contractDoc.includes('1.0.0'), 'Contract must reference version');
});

// C27: architecture doc says TARGET / not implemented
test('C27 architecture doc says TARGET / not implemented', () => {
  assert.ok(archDoc.includes('TARGET'), 'Architecture doc must say TARGET');
  assert.ok(archDoc.includes('NOT YET IMPLEMENTED'), 'Architecture doc must say NOT YET IMPLEMENTED');
});

// Summary
console.log(`\n=== Context Hydration Contract Test Summary ===`);
console.log(`Cases: ${passed + failed}, Passed: ${passed}, Failed: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
