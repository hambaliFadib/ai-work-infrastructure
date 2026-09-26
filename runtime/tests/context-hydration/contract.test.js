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
  assert.strictEqual(policy.policy_version, '1.0.1');
});

// C04: policy_ref exact
test('C04 policy_ref exact', () => {
  assert.strictEqual(policy.policy_ref, 'context-hydration@1.0.1');
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
    'rank', 'omission_reason', 'estimated_tokens', 'hydration_run_id',
    'omitted_at', 'expires_at'
  ];
  const actual = policy.omission.allowed_metadata;
  assert.deepStrictEqual([...actual].sort(), [...required].sort());
});

// C18: metadata retention=30 days
test('C18 metadata retention=30 days', () => {
  assert.strictEqual(policy.omission.retention_seconds, 2592000);
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
  assert.deepStrictEqual([...policy.acceptance.objective_ids].sort(), [...expected].sort());
});

// C23: hydration IDs H01–H17 exact
test('C23 hydration IDs H01-H17 exact', () => {
  const expected = Array.from({length: 17}, (_, i) => `H${String(i+1).padStart(2, '0')}`);
  assert.deepStrictEqual([...policy.acceptance.hydration_ids].sort(), [...expected].sort());
});

// C24: skill IDs S01–S10 exact
test('C24 skill IDs S01-S10 exact', () => {
  const expected = Array.from({length: 10}, (_, i) => `S${String(i+1).padStart(2, '0')}`);
  assert.deepStrictEqual([...policy.acceptance.skill_ids].sort(), [...expected].sort());
});

// C25: acceptance total=37
test('C25 acceptance total=37', () => {
  assert.strictEqual(policy.acceptance.total, 37);
});

// C26: contract document references policy version
test('C26 contract document references policy version', () => {
  assert.ok(contractDoc.includes('context-hydration@1.0.1'), 'Contract must reference policy_ref');
  assert.ok(contractDoc.includes('1.0.1'), 'Contract must reference version');
});

// C27: architecture doc says TARGET / not implemented
test('C27 architecture doc says TARGET / not implemented', () => {
  assert.ok(archDoc.includes('TARGET'), 'Architecture doc must say TARGET');
  assert.ok(archDoc.includes('NOT YET IMPLEMENTED'), 'Architecture doc must say NOT YET IMPLEMENTED');
});

// C28: StructuredObjective contract exact
test('C28 StructuredObjective contract exact', () => {
  const obj = policy.objective;
  const requiredFields = ['objective_id','summary','intent','scope','entities','constraints','retrieval_terms','confidence','provenance'];
  assert.deepStrictEqual([...obj.fields].sort(), [...requiredFields].sort());
  const requiredInputs = ['session_id','job_id','latest_checkpoint','user_request','active_constraints','optional_explicit_objective'];
  assert.deepStrictEqual([...obj.input_sources].sort(), [...requiredInputs].sort());
  assert.strictEqual(obj.explicit_outranks_inferred, true);
  assert.strictEqual(obj.ambiguity_must_not_invent_entities, true);
});

// C29: authority + tie-break exact
test('C29 authority + tie-break exact', () => {
  const auth = policy.ranking.authority_baseline;
  assert.strictEqual(auth.curated, 1.00);
  assert.strictEqual(auth.reviewed_session_fact, 0.90);
  assert.strictEqual(auth.historical_checkpoint, 0.80);
  assert.strictEqual(auth.semantic_memory, 0.50);
  const expectedTieBreak = ['total_score_desc','scope_specificity_desc','authority_desc','updated_at_desc','source_id_asc'];
  assert.deepStrictEqual(policy.ranking.tie_break, expectedTieBreak);
  assert.strictEqual(policy.ranking.weight_sum, 1.00);
});

// C30: mandatory protected set exact
test('C30 mandatory protected set exact', () => {
  const expected = [
    'current_objective','job_profile_identity','active_safety_constraints',
    'approval_state','latest_valid_checkpoint','mandatory_project_instructions'
  ];
  assert.deepStrictEqual([...policy.budget.mandatory_protected_set].sort(), [...expected].sort());
});

// C31: ContextPackage contract exact
test('C31 ContextPackage contract exact', () => {
  const cp = policy.context_package;
  const requiredFields = ['hydration_run_id','policy_id','policy_version','hydration_started_at','objective','job_id','session_id','mandatory','retrieved','omitted','budget'];
  assert.deepStrictEqual([...cp.required_fields].sort(), [...requiredFields].sort());
  const auditFields = ['source_id','source_type','scope','score','rank','reason','provenance'];
  assert.deepStrictEqual([...cp.retrieved_audit_fields].sort(), [...auditFields].sort());
  assert.strictEqual(cp.no_secrets, true);
});

// C32: skill classes/order/invariants exact
test('C32 skill classes/order/invariants exact', () => {
  assert.deepStrictEqual(policy.skills.classes, ['PRIMARY', 'SUPPORTING', 'CONFLICTING']);
  assert.deepStrictEqual(policy.skills.execution_order, ['UNDERSTAND', 'DESIGN/PLAN', 'EXECUTE', 'VALIDATE']);
  const inv = policy.skills.invariants;
  assert.strictEqual(inv.never_silently_truncate, true);
  assert.strictEqual(inv.user_explicit_highest_priority, true);
  assert.strictEqual(inv.cannot_override_runtime_policy, true);
  assert.strictEqual(inv.cannot_override_permissions, true);
  assert.strictEqual(inv.cannot_override_security_constraints, true);
});

// C33: skill decision precedence exact
test('C33 skill decision precedence exact', () => {
  const dr = policy.skills.decision_rules;
  assert.ok(dr, 'decision_rules must exist');
  assert.strictEqual(dr.allow_at_or_below_default_without_override, true);
  assert.strictEqual(dr.require_override_above_default_through_hard_max, true);
  assert.strictEqual(dr.allow_through_hard_max_with_override, true);
  assert.strictEqual(dr.reject_above_hard_max_regardless_of_override, true);
  assert.strictEqual(dr.hard_limit_precedes_override_requirement, true);
});

// C34: exact term-normalization rules
test('C34 exact term-normalization rules', () => {
  const tn = policy.ranking.term_normalization;
  assert.ok(tn, 'term_normalization must exist');
  assert.deepStrictEqual(tn.steps, ['unicode_nfkc', 'lowercase', 'trim_whitespace', 'collapse_internal_whitespace', 'remove_empty', 'deduplicate']);
});

// C35: exact Jaccard semantic relevance contract
test('C35 exact Jaccard semantic relevance contract', () => {
  const sr = policy.ranking.semantic_relevance;
  assert.ok(sr, 'semantic_relevance must exist');
  assert.strictEqual(sr.formula, 'jaccard_similarity');
  assert.strictEqual(sr.definition, '|O ∩ C| / |O ∪ C|');
  assert.strictEqual(sr.zero_union, 0);
  assert.deepStrictEqual(sr.range, [0.0, 1.0]);
  assert.strictEqual(sr.requires_network, false);
});

// C36: exact scope-specificity mapping + foreign-job reject
test('C36 exact scope-specificity mapping + foreign-job reject', () => {
  const ss = policy.ranking.scope_specificity;
  assert.ok(ss, 'scope_specificity must exist');
  assert.strictEqual(ss.foreign_job_reject, true);
  assert.strictEqual(ss.mapping.same_active_session, 1.00);
  assert.strictEqual(ss.mapping.same_active_job, 0.75);
  assert.strictEqual(ss.mapping.global_scope, 0.50);
  assert.strictEqual(ss.mapping.otherwise, 0.00);
  assert.deepStrictEqual(ss.range, [0.0, 1.0]);
});

// C37: exact recency anchor/buckets
test('C37 exact recency anchor/buckets', () => {
  const rc = policy.ranking.recency;
  assert.ok(rc, 'recency must exist');
  assert.strictEqual(rc.anchor, 'hydration_started_at');
  assert.strictEqual(rc.anchor_format, 'RFC3339 UTC');
  assert.strictEqual(rc.future_values_floored, true);
  assert.strictEqual(rc.buckets['age <= 1 day'], 1.00);
  assert.strictEqual(rc.buckets['age <= 7 days'], 0.75);
  assert.strictEqual(rc.buckets['age <= 30 days'], 0.50);
  assert.strictEqual(rc.buckets['age <= 90 days'], 0.25);
  assert.strictEqual(rc.buckets['age > 90 days'], 0.00);
  assert.strictEqual(rc.constants_seconds['1_day'], 86400);
  assert.strictEqual(rc.constants_seconds['7_days'], 604800);
  assert.strictEqual(rc.constants_seconds['30_days'], 2592000);
  assert.strictEqual(rc.constants_seconds['90_days'], 7776000);
});

// C38: exact total-score formula + quantize6 + tie-break
test('C38 exact total-score formula + quantize6 + tie-break', () => {
  const ts = policy.ranking.total_score;
  assert.ok(ts, 'total_score must exist');
  assert.strictEqual(ts.formula, '(semantic_relevance * 0.50) + (scope_specificity * 0.25) + (authority * 0.20) + (recency * 0.05)');
  assert.strictEqual(ts.quantization.function, 'quantize6');
  assert.strictEqual(ts.quantization.definition, 'floor((x * 1000000) + 0.5) / 1000000');
  assert.deepStrictEqual(ts.range, [0.0, 1.0]);
  const tb = policy.ranking.tie_break;
  assert.deepStrictEqual(tb, ['total_score_desc', 'scope_specificity_desc', 'authority_desc', 'updated_at_desc', 'source_id_asc']);
});

// C39: exact budget inputs/denominator/reservation order/formula
test('C39 exact budget inputs/denominator/reservation order/formula', () => {
  const b = policy.budget;
  assert.ok(b.required_inputs, 'required_inputs must exist');
  assert.deepStrictEqual(b.required_inputs, ['context_window_tokens', 'response_headroom_tokens', 'execution_reserve_tokens', 'active_conversation_tokens', 'mandatory_context_tokens']);
  assert.strictEqual(b.tokenizer_id_required, true);
  assert.ok(b.reservation_order, 'reservation_order must exist');
  assert.strictEqual(b.reservation_order.length, 7);
  assert.ok(b.formulas, 'formulas must exist');
  assert.ok(b.formulas.usable_before_mandatory.includes('context_window_tokens'));
  assert.ok(b.formulas.available_context_tokens.includes('usable_before_mandatory'));
  assert.ok(b.formulas.retrieval_budget_tokens.includes('0.20'));
  assert.strictEqual(b.retrieved_max_fraction, 0.20);
});

// C40: exact omission timestamp + 30-day expiry semantics
test('C40 exact omission timestamp + 30-day expiry semantics', () => {
  const o = policy.omission;
  assert.ok(o, 'omission must exist');
  assert.strictEqual(o.timestamp_format, 'RFC3339 UTC');
  assert.strictEqual(o.omitted_at_source, 'hydration_started_at');
  assert.strictEqual(o.retention_seconds, 2592000);
  assert.ok(o.expiry_formula.includes('2592000'));
  assert.ok(o.allowed_metadata.includes('omitted_at'));
  assert.ok(o.allowed_metadata.includes('expires_at'));
  assert.strictEqual(o.full_content_persistence, false);
});

// C41: ContextPackage hydration_started_at + budget audit fields
test('C41 ContextPackage hydration_started_at + budget audit fields', () => {
  const cp = policy.context_package;
  assert.ok(cp.required_fields.includes('hydration_started_at'), 'ContextPackage must require hydration_started_at');
  assert.ok(cp.budget_audit_fields, 'budget_audit_fields must exist');
  const expectedBudgetFields = ['tokenizer_id', 'context_window_tokens', 'response_headroom_tokens', 'execution_reserve_tokens', 'active_conversation_tokens', 'mandatory_context_tokens', 'available_context_tokens', 'retrieval_budget_tokens', 'retrieved_tokens_used'];
  assert.deepStrictEqual([...cp.budget_audit_fields].sort(), [...expectedBudgetFields].sort());
  assert.strictEqual(cp.no_secrets, true);
});

// Summary
console.log(`\n=== Context Hydration Contract Test Summary ===`);
console.log(`Cases: ${passed + failed}, Passed: ${passed}, Failed: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
