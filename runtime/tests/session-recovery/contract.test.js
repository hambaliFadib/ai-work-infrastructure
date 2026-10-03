/**
 * Session Recovery v1 — Contract Test (SRC01–SRC25)
 *
 * Validates the locked governance artifacts for Phase 9C-03.
 * Deterministic repository contract test. Reads tracked files only.
 * No env reads, no network, no database, no Oracle.
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const REPO = path.resolve(__dirname, '..', '..', '..');
const POLICY_PATH = path.join(REPO, 'governance', 'policies', 'session-recovery.json');
const CONTRACT_PATH = path.join(REPO, 'governance', 'contracts', 'session-recovery-v1.md');
const ARCH_PATH = path.join(REPO, 'docs', 'architecture', 'session-recovery.md');

let passed = 0;
let failed = 0;

function test(label, fn) {
  try { fn(); passed++; console.log(`${label}: PASS`); }
  catch (e) { failed++; console.log(`${label}: FAIL — ${e.message}`); }
}

// --- Load policy + contract ---
const policy = JSON.parse(fs.readFileSync(POLICY_PATH, 'utf8'));
const contractDoc = fs.readFileSync(CONTRACT_PATH, 'utf8');
const archDoc = fs.readFileSync(ARCH_PATH, 'utf8');

// --- Canonical constants from policy/contract ---

const EXPECTED_STATES = [
  'NEW','ACTIVE','CHECKPOINTED','BLOCKED','INTERRUPTED',
  'FAILED','CONFLICTED','MERGE_PENDING','RESOLVED','ARCHIVED'
];

const EXPECTED_ERRORS = [
  'SESSION_RECOVERY_INVALID', 'INVALID_RECOVERY_STATE', 'ILLEGAL_TRANSITION',
  'CHECKPOINT_OWNERSHIP_MISMATCH', 'CHECKPOINT_INVALID',
  'RECOVERY_IDENTITY_MISMATCH', 'RECOVERY_PRECONDITION_FAILED',
  'RECOVERY_APPROVAL_REQUIRED'
];

// Expected allow-list edges (contract section 6.3 canonical order)
const EXPECTED_EDGES = [
  ['NEW','ACTIVE','START'],['NEW','ARCHIVED','ARCHIVE'],
  ['ACTIVE','CHECKPOINTED','CHECKPOINT_CREATE'],['ACTIVE','BLOCKED','BLOCK_RECORD'],
  ['ACTIVE','INTERRUPTED','INTERRUPT_RECORD'],['ACTIVE','FAILED','FAILURE_RECORD'],
  ['ACTIVE','CONFLICTED','CONFLICT_RECORD'],['ACTIVE','MERGE_PENDING','MERGE_ELIGIBLE_RECORD'],
  ['ACTIVE','RESOLVED','CLOSE'],
  ['CHECKPOINTED','ACTIVE','RESUME'],['CHECKPOINTED','CHECKPOINTED','CHECKPOINT_CREATE'],
  ['CHECKPOINTED','BLOCKED','BLOCK_RECORD'],['CHECKPOINTED','INTERRUPTED','INTERRUPT_RECORD'],
  ['CHECKPOINTED','FAILED','FAILURE_RECORD'],['CHECKPOINTED','CONFLICTED','CONFLICT_RECORD'],
  ['CHECKPOINTED','MERGE_PENDING','MERGE_ELIGIBLE_RECORD'],['CHECKPOINTED','RESOLVED','CLOSE'],
  ['CHECKPOINTED','ARCHIVED','ARCHIVE'],
  ['BLOCKED','ACTIVE','UNBLOCK'],['BLOCKED','FAILED','FAILURE_RECORD'],
  ['BLOCKED','CONFLICTED','CONFLICT_RECORD'],['BLOCKED','RESOLVED','CLOSE'],
  ['BLOCKED','ARCHIVED','ARCHIVE'],
  ['INTERRUPTED','ACTIVE','RESUME'],['INTERRUPTED','FAILED','FAILURE_RECORD'],
  ['INTERRUPTED','CONFLICTED','CONFLICT_RECORD'],['INTERRUPTED','RESOLVED','CLOSE'],
  ['INTERRUPTED','ARCHIVED','ARCHIVE'],
  ['FAILED','ACTIVE','REOPEN'],['FAILED','CONFLICTED','CONFLICT_RECORD'],
  ['FAILED','RESOLVED','CLOSE'],['FAILED','ARCHIVED','ARCHIVE'],
  ['CONFLICTED','ACTIVE','CONFLICT_RESOLVE'],['CONFLICTED','FAILED','FAILURE_RECORD'],
  ['CONFLICTED','RESOLVED','CLOSE'],['CONFLICTED','ARCHIVED','ARCHIVE'],
  ['MERGE_PENDING','RESOLVED','INTEGRATE_CLOSE'],
  ['MERGE_PENDING','CONFLICTED','CONFLICT_RECORD'],['MERGE_PENDING','BLOCKED','BLOCK_RECORD'],
  ['MERGE_PENDING','FAILED','FAILURE_RECORD'],
  ['RESOLVED','ARCHIVED','ARCHIVE']
];

const EXPECTED_ACCEPTANCE_IDS = [
  ...[1,2,3,4,5,6,7,8].map(i=>'RC'+String(i).padStart(2,'0')),
  ...[1,2,3,4,5,6,7,8,9,10,11,12].map(i=>'ST'+String(i).padStart(2,'0')),
  ...[1,2,3,4,5,6,7,8,9,10].map(i=>'CP'+String(i).padStart(2,'0')),
  ...[1,2,3,4,5,6,7].map(i=>'ID'+String(i).padStart(2,'0')),
  ...[1,2,3,4,5,6,7].map(i=>'IF'+String(i).padStart(2,'0')),
  ...[1,2,3,4,5,6,7,8].map(i=>'MP'+String(i).padStart(2,'0')),
  ...[1,2,3,4,5,6,7,8].map(i=>'DI'+String(i).padStart(2,'0')),
  ...[1,2,3,4,5,6,7,8,9,10].map(i=>'SB'+String(i).padStart(2,'0'))
];

// --- SRC01: Policy file parses ---
test('SRC01 policy file parses', () => {
  assert.ok(policy, 'Policy must be non-null');
  assert.strictEqual(typeof policy, 'object', 'Policy must be an object');
});

// --- SRC02: policy_id, version, ref exact ---
test('SRC02 policy identity', () => {
  assert.strictEqual(policy.policy_id, 'session-recovery');
  assert.strictEqual(policy.policy_version, '1.0.1');
  assert.strictEqual(policy.policy_ref, 'session-recovery@1.0.1');
  assert.strictEqual(policy.status, 'CONTRACT_LOCKED');
});

// --- SRC03: State model = exactly 10 ---
test('SRC03 state count = 10', () => {
  assert.deepStrictEqual(policy.states, EXPECTED_STATES);
  assert.strictEqual(policy.state_count, 10);
  assert.strictEqual(policy.transition_model.allowed_count, 41);
});

// --- SRC04: Terminality ---
test('SRC04 terminality (ARCHIVED sole terminal)', () => {
  assert.strictEqual(policy.archived.terminal, true);
  assert.deepStrictEqual(policy.archived.outgoing, []);
  assert.strictEqual(policy.resolved.terminal, false);
  assert.deepStrictEqual(policy.resolved.outgoing, ['ARCHIVED']);
});

// --- SRC05: Transition count + structure ---
test('SRC05 transition count = 41', () => {
  const jsonEdges = policy.transition_model.transitions.map(t => [t.from, t.to, t.operation]);
  assert.strictEqual(jsonEdges.length, 41);
  for (const edge of jsonEdges) {
    assert.ok(Array.isArray(edge) && edge.length === 3, 'each edge must have from/to/operation');
  }
});

// --- SRC06: Allow-list deep-equal to contract §6.3 ---
test('SRC06 allow-list deep-equal (JSON == contract)', () => {
  const jsonEdges = policy.transition_model.transitions.map(t => [t.from, t.to, t.operation]);
  assert.deepStrictEqual(jsonEdges, EXPECTED_EDGES, 'transition list must match contract §6.3 exactly');
});

// --- SRC07: Hard forbiddens present ---
test('SRC07 hard forbiddens declared', () => {
  assert.ok(policy.transition_model.hard_forbidden.includes('into_NEW'));
  assert.ok(policy.transition_model.hard_forbidden.includes('out_of_ARCHIVED'));
  assert.ok(policy.transition_model.hard_forbidden.includes('ACTIVE_to_ARCHIVED'));
  assert.ok(policy.transition_model.hard_forbidden.includes('MERGE_PENDING_to_ACTIVE'));
  assert.ok(policy.transition_model.hard_forbidden.includes('RESOLVED_exit_except_ARCHIVED'));
});

// --- SRC08: Checkpoint idempotency settings ---
test('SRC08 checkpoint duplicate content config', () => {
  const d = policy.checkpoint.duplicate_content;
  assert.strictEqual(d.result, 'IDEMPOTENT_REPLAY');
  assert.strictEqual(d.consumes_seq, false);
  assert.strictEqual(d.writes_transition_record, false);
  assert.strictEqual(d.changes_state, false);
  assert.strictEqual(d.requires_approval, false);
  assert.strictEqual(d.applies_transition, false);
  assert.strictEqual(d.evaluation_stage, 'P11_AFTER_P9_REPLAY_AND_P10_LEGALITY_BEFORE_P12_APPROVAL');
});

// --- SRC09: Error taxonomy = exactly 8 ---
test('SRC09 error count = 8', () => {
  assert.deepStrictEqual(policy.canonical_errors, EXPECTED_ERRORS);
  assert.strictEqual(policy.canonical_errors.length, 8);
  // Reused errors unchanged
  assert.strictEqual(policy.reused_errors.phase_9b_locked_count, 18);
  assert.strictEqual(policy.reused_errors.merge_pending_conflict, 'NOT_INTRODUCED');
  assert.strictEqual(policy.reused_errors.idempotent_replay_is_error, false);
});

// --- SRC10: Validation precedence = P1-P13 ordered ---
test('SRC10 validation precedence P1..P13', () => {
  assert.strictEqual(policy.validation_precedence.length, 13);
  for (let i = 0; i < 13; i++) {
    assert.ok(policy.validation_precedence[i].startsWith(`P${i+1}_`), `must start with P${i+1}_`);
  }
});

// --- SRC11: Exact acceptance IDs = 70 ---
test('SRC11 acceptance IDs = 70 unique', () => {
  const ids = [
    ...policy.acceptance_model.RC, ...policy.acceptance_model.ST,
    ...policy.acceptance_model.CP, ...policy.acceptance_model.ID,
    ...policy.acceptance_model.IF, ...policy.acceptance_model.MP,
    ...policy.acceptance_model.DI, ...policy.acceptance_model.SB
  ];
  assert.strictEqual(ids.length, 70);
  assert.strictEqual(new Set(ids).size, 70);
  assert.strictEqual(policy.acceptance_model.total, 70);
  assert.strictEqual(policy.acceptance_model.status, 'DECLARED_NOT_EXECUTED');
});

// --- SRC12: Acceptance counts per category ---
test('SRC12 acceptance per-category counts', () => {
  assert.strictEqual(policy.acceptance_model.RC.length, 8);
  assert.strictEqual(policy.acceptance_model.ST.length, 12);
  assert.strictEqual(policy.acceptance_model.CP.length, 10);
  assert.strictEqual(policy.acceptance_model.ID.length, 7);
  assert.strictEqual(policy.acceptance_model.IF.length, 7);
  assert.strictEqual(policy.acceptance_model.MP.length, 8);
  assert.strictEqual(policy.acceptance_model.DI.length, 8);
  assert.strictEqual(policy.acceptance_model.SB.length, 10);
});

// --- SRC13: Non-claims ---
test('SRC13 non-claims preserved', () => {
  const nc = policy.non_claims;
  assert.strictEqual(nc.phase_9c_verified, false);
  assert.strictEqual(nc.runtime, 'PARTIAL (9C-03)');
  assert.strictEqual(nc.architecture_freeze, 'NOT_CLAIMED');
  assert.strictEqual(nc.production_readiness, 'NOT_PROVEN');
  assert.strictEqual(nc.acceptance_executed, false);
  assert.strictEqual(policy.implementation_status, 'PARTIAL (9C-03)');
});

// --- SRC14: Phase 9B boundary unchanged ---
test('SRC14 Phase 9B boundary', () => {
  assert.strictEqual(policy.phase_9b.unchanged, true);
  assert.strictEqual(policy.phase_9b.policy_ref, 'job-isolation@1.0.0');
  assert.strictEqual(policy.phase_9b.acceptance, '40/40 VERIFIED UNCHANGED');
  assert.strictEqual(policy.phase_9b.runtime_modifications, 'NONE');
});

// --- SRC15: Context hydration frozen ---
test('SRC15 context hydration frozen', () => {
  assert.strictEqual(policy.context_hydration.policy_ref, 'context-hydration@1.0.1');
  assert.strictEqual(policy.context_hydration.frozen, true);
  assert.strictEqual(policy.context_hydration.scoring_changes, 'NONE');
});

// --- SRC16: Policy_ref compatibility model ---
test('SRC16 persisted_policy_ref_compatibility', () => {
  const c = policy.recovery_object.persisted_policy_ref_compatibility;
  assert.strictEqual(c.mode, 'EXACT_CURRENT_POLICY_REF');
  assert.strictEqual(c.current_policy_ref, 'session-recovery@1.0.1');
  assert.deepStrictEqual(c.superseded_policy_refs, ['session-recovery@1.0.0']);
  assert.strictEqual(c.superseded_record_result, 'SESSION_RECOVERY_INVALID');
  assert.strictEqual(c.automatic_migration, 'FORBIDDEN');
  assert.strictEqual(c.implicit_rebind_or_alias, 'FORBIDDEN');
  assert.strictEqual(c.record_rewrite_or_repair, 'FORBIDDEN');
  assert.strictEqual(c.replacement_record_creation, 'FORBIDDEN');
  assert.strictEqual(c.migration_in_scope_for_9c_02, false);
});

// --- SRC17: RecoveryObject schema ---
test('SRC17 recovery_object strict schema', () => {
  const ro = policy.recovery_object;
  assert.deepStrictEqual(ro.record_fields, ['job_id','session_key','current_state','transition_seq','checkpoint_seq','policy_ref']);
  assert.strictEqual(ro.unknown_fields, 'FAIL_CLOSED');
  assert.strictEqual(ro.unknown_fields_error, 'SESSION_RECOVERY_INVALID');
  assert.strictEqual(ro.timestamps, 'FORBIDDEN');
});

// --- SRC18: CREATE semantics ---
test('SRC18 CREATE idempotent semantics', () => {
  const create = policy.recovery_object.create;
  assert.strictEqual(create.exact_pair_reuse, 'IDEMPOTENT');
  assert.strictEqual(create.policy_ref_mismatch_error, 'SESSION_RECOVERY_INVALID');
  assert.strictEqual(create.identity_immutable_after_creation, true);
});

// --- SRC19: Namespace rules ---
test('SRC19 namespace isolation', () => {
  assert.strictEqual(policy.namespaces.forbidden_write_roots.length, 2);
  assert.deepStrictEqual(policy.namespaces.forbidden_write_roots, ['ledger_namespace', 'runtime_state_namespace']);
  assert.strictEqual(policy.namespaces.ledger_recovery_writes, 'FORBIDDEN');
});

// --- SRC20: Approval model ---
test('SRC20 approval model', () => {
  assert.strictEqual(policy.approval_model.all_transitions_gated, true);
  assert.strictEqual(policy.approval_model.gated_transition_count, 41);
  assert.strictEqual(policy.approval_model.contract_alone_authorizes_execution, false);
  assert.strictEqual(policy.approval_model.self_authorizing_recovery, 'FORBIDDEN');
});

// --- SRC21: Audit model ---
test('SRC21 audit model', () => {
  const a = policy.audit;
  assert.strictEqual(a.timestamps, 'FORBIDDEN');
  assert.strictEqual(a.append_only, true);
  assert.strictEqual(a.immutable, true);
  assert.strictEqual(a.ledger_writes, 'NONE');
});

// --- SRC22: Determinism/fail-closed invariants ---
test('SRC22 determinism + fail-closed', () => {
  assert.strictEqual(policy.determinism.fallback_scope, 'NONE');
  assert.strictEqual(policy.determinism.silent_repair, 'FORBIDDEN');
  assert.strictEqual(policy.determinism.silent_resume, 'FORBIDDEN');
});

// --- SRC23: Contract document references ---
test('SRC23 contract doc references policy', () => {
  assert.ok(contractDoc.includes('session-recovery@1.0.1'), 'Contract must reference 1.0.1');
  assert.ok(contractDoc.includes('CONTRACT LOCKED'), 'Contract must say CONTRACT LOCKED');
  assert.ok(contractDoc.includes('Session Recovery v1'), 'Contract title must match');
  assert.ok(contractDoc.includes('### 4.3 Persisted policy_ref compatibility'), 'Contract must contain persistence compat section');
  assert.ok(contractDoc.includes('No implicit migration'), 'Contract must declare no implicit migration');
  assert.ok(contractDoc.includes('Phase 9C: NOT VERIFIED'), 'Contract must not claim VERIFIED');
});

// --- SRC24: Architecture doc parity ---
test('SRC24 architecture doc parity', () => {
  assert.ok(archDoc.includes('CONTRACT LOCKED'), 'Architecture must say CONTRACT LOCKED');
  assert.ok(archDoc.includes('RUNTIME IMPLEMENTATION: PARTIAL'), 'Architecture must say runtime PARTIAL');
  assert.ok(archDoc.includes('9C-03 core'), 'Architecture must reference 9C-03 core');
  // NOT/VERIFIED may be split by \r\n across lines — use regex
  assert.ok(/NOT\s+VERIFIED/.test(archDoc), 'Architecture must say NOT VERIFIED');
  assert.ok(!archDoc.includes('IMPLEMENTATION STARTED'), 'Must not claim started');
});

// --- SRC25: Superseded-ref incompatibility explicit ---
test('SRC25 superseded record incompatibility explicit', () => {
  assert.ok(contractDoc.includes('Superseded ref'), 'Contract must declare superseded ref');
  assert.ok(contractDoc.includes('is incompatible with the current policy'), 'Contract must say incompatible');
  assert.ok(contractDoc.includes('not part of 9C-02'), 'Contract must exclude from 9C-02 scope');
  assert.ok(policy.recovery_object.persisted_policy_ref_compatibility.superseded_1_0_0_implementation === 'NONE', '1.0.0 implementation NONE');
  assert.ok(policy.recovery_object.persisted_policy_ref_compatibility.historical_runtime_migration_event === 'NONE', 'No historical migration event');
});

console.log(`\n=== Session Recovery Contract Test Summary ===`);
console.log(`Cases: ${passed + failed}, Passed: ${passed}, Failed: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
