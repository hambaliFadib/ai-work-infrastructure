/**
 * Job Isolation contract tests — JIC01-JIC33.
 *
 * Validates the locked governance artifacts:
 *   - governance/policies/job-isolation.json (machine policy)
 *   - governance/contracts/job-isolation-v1.md (human contract)
 *   - docs/architecture/job-isolation.md (architecture doc)
 *   - docs/governance/repository-collaboration.md (Phase 9B status)
 *
 * No runtime implementation imports. Deterministic Node only.
 * No network. No DB. No env. No profile reads. No wall clock.
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '..', '..', '..');

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

const policy = JSON.parse(read('governance/policies/job-isolation.json'));
const contract = read('governance/contracts/job-isolation-v1.md');
const arch = read('docs/architecture/job-isolation.md');
const collab = read('docs/governance/repository-collaboration.md');
const blueprint = read('docs/ARCHITECTURE-BLUEPRINT.md');
const workflow = read('docs/WORKFLOW.md');
const readme = read('README.md');
const migration = read('docs/MIGRATION-MANIFEST.md');
const buildPlan = read('docs/BUILD-PLAN.md');
const executionContext = read('governance/schemas/execution-context.json');

let passed = 0;
let failed = 0;

function test(label, fn) {
  try {
    fn();
    passed += 1;
    console.log(`${label}: PASS`);
  } catch (e) {
    failed += 1;
    console.log(`${label}: FAIL - ${e.message}`);
  }
}

const REQUIRED_FIELDS = ['job_id', 'profile', 'session_namespace', 'knowledge_scope', 'evidence_namespace', 'ledger_namespace', 'runtime_state_namespace', 'execution_permissions'];
const KNOWLEDGE_SCOPES = ['JOB_LOCAL', 'SESSION_LOCAL', 'GLOBAL'];
const PERMISSIONS = ['READ_ONLY', 'LOW_RISK_WRITE', 'CONFIG_WRITE', 'DELETE', 'SECRET_ACCESS'];
const CANONICAL_ERRORS = ['JOB_CONTRACT_INVALID', 'INVALID_JOB_ID', 'JOB_ID_COLLISION', 'PROFILE_BINDING_INVALID', 'PROFILE_BINDING_MISMATCH', 'NAMESPACE_DERIVATION_FAILED', 'NAMESPACE_OVERRIDE_FORBIDDEN', 'NAMESPACE_COLLISION', 'FOREIGN_JOB_REJECT', 'FOREIGN_NAMESPACE_WRITE_REJECTED', 'INVALID_KNOWLEDGE_SCOPE', 'INVALID_EXECUTION_PERMISSIONS', 'LANE_CONTRACT_INVALID', 'LANE_ID_COLLISION', 'LANE_OWNERSHIP_CONFLICT', 'CROSS_LANE_WRITE_REJECTED', 'COORDINATION_CHECKOUT_VIOLATION', 'STALE_MAIN_BASELINE'];
const PRECEDENCE = ['STRUCTURAL_JOB_CONTRACT_VALIDITY', 'CANONICAL_JOB_ID', 'PROFILE_BINDING', 'NAMESPACE_INTEGRITY', 'KNOWLEDGE_SCOPE', 'EXECUTION_PERMISSIONS', 'JOB_IDENTITY_BOUNDARY', 'LANE_STRUCTURAL_VALIDITY', 'LANE_IDENTITY_OWNERSHIP', 'COORDINATION_MAIN_BASELINE'];
const PHASE_9C_STATES = ['NEW', 'ACTIVE', 'CHECKPOINTED', 'BLOCKED', 'INTERRUPTED', 'FAILED', 'CONFLICTED', 'MERGE_PENDING', 'RESOLVED', 'ARCHIVED'];
const LANE_FIELDS = ['lane_id', 'job_id', 'branch', 'worktree', 'writer_identity', 'baseline_main_sha'];

function ids(prefix, count) {
  const out = [];
  for (let i = 1; i <= count; i += 1) out.push(prefix + String(i).padStart(2, '0'));
  return out;
}

// JIC01 — policy identity/version
test('JIC01', () => {
  assert.strictEqual(policy.policy_id, 'job-isolation');
  assert.strictEqual(policy.policy_version, '1.0.0');
  assert.strictEqual(policy.policy_ref, 'job-isolation@1.0.0');
  assert.strictEqual(policy.status, 'CONTRACT_LOCKED');
  assert.strictEqual(policy.implementation_status, 'PARTIAL');
  assert.deepStrictEqual(policy.implementation_components.implemented, ['JOB_CONTRACT_RUNTIME_CORE', 'NAMESPACE_DERIVATION_PRIMITIVES', 'PARALLEL_LANE_SEMANTICS', 'NAMESPACE_ISOLATION_ENFORCEMENT', 'PARALLEL_LANE_MAIN_INTEGRATION', 'MAIN_COORDINATION_INTEGRATION']);
  assert.deepStrictEqual(policy.implementation_components.pending, []);
});

// JIC02 — human contract status/policy parity
test('JIC02', () => {
  assert.ok(contract.includes('Status: CONTRACT LOCKED'));
  assert.ok(contract.includes('Policy: job-isolation@1.0.0'));
  assert.ok(contract.includes('Implementation: PARTIAL'));
  assert.ok(!contract.includes('Implementation: NOT IMPLEMENTED'));
  assert.ok(contract.includes('9B-02 JobContract Runtime Core:'));
  assert.ok(contract.includes('IMPLEMENTED / VERIFIED'));
  assert.ok(!contract.includes('pending merge verification'));
  assert.ok(contract.includes('9B-03 Namespace Isolation:'));
  assert.ok(contract.includes('9B-04 Parallel Lane:'));
  assert.ok(/9B-04 Parallel Lane:\s*IMPLEMENTED \/ VERIFIED/.test(contract));
  assert.ok(!contract.includes('NOT MERGED'));
  assert.ok(contract.includes('9B-05 Integration:'));
  assert.ok(contract.includes('9B-06 Acceptance:'));
  assert.ok(/9B-06 Acceptance:\s*VERIFIED/.test(contract));
  assert.ok(contract.includes('docs/acceptance/phase-9b.md'));
});

// JIC03 — exact 8 JobContract required fields
test('JIC03', () => {
  assert.deepStrictEqual(policy.job_contract.required_fields, REQUIRED_FIELDS);
  for (const field of REQUIRED_FIELDS) {
    assert.ok(contract.includes(field), `contract missing field: ${field}`);
  }
});

// JIC04 — unknown JobContract fields fail-closed policy declared
test('JIC04', () => {
  assert.strictEqual(policy.job_contract.unknown_fields, 'FAIL_CLOSED');
  assert.strictEqual(policy.job_contract.future_extension_requires_version_change, true);
  assert.ok(contract.includes('FAIL CLOSED'));
});

// JIC05 — job_id normalization sequence
test('JIC05', () => {
  assert.deepStrictEqual(policy.job_id.normalization, ['unicode_nfkc', 'trim', 'lowercase']);
});

// JIC06 — job_id regex + length
test('JIC06', () => {
  assert.strictEqual(policy.job_id.pattern, '^[a-z0-9][a-z0-9._-]{0,63}$');
  assert.strictEqual(policy.job_id.min_length, 1);
  assert.strictEqual(policy.job_id.max_length, 64);
  const re = new RegExp(policy.job_id.pattern);
  assert.ok(re.test('job-1.alpha'));
  assert.ok(!re.test('Job 1'));
});

// JIC07 — caller-created vs generated-persisted strategies
test('JIC07', () => {
  assert.strictEqual(policy.job_id.creation.caller_supplied, 'ALLOWED_ONLY_DURING_CREATION');
  assert.strictEqual(policy.job_id.creation.generated, 'ONE_TIME_CREATION_MUST_PERSIST_BEFORE_REUSE');
  assert.strictEqual(policy.job_id.creation.resolution_must_not_generate_new_identity, true);
});

// JIC08 — create-vs-reuse collision semantics
test('JIC08', () => {
  assert.strictEqual(policy.job_id.collision.create_collision_error, 'JOB_ID_COLLISION');
  assert.strictEqual(policy.job_id.collision.exact_persisted_reuse, 'IDEMPOTENT');
  assert.strictEqual(policy.job_id.collision.different_immutable_fields_error, 'JOB_ID_COLLISION');
});

// JIC09 — profile required
test('JIC09', () => {
  assert.strictEqual(policy.profile.required, true);
  assert.ok(contract.includes('Profile Binding'));
});

// JIC10 — profile regex matches execution-context rule
test('JIC10', () => {
  assert.strictEqual(policy.profile.pattern, '^[A-Za-z0-9][A-Za-z0-9._-]*$');
  assert.ok(executionContext.includes('^[A-Za-z0-9][A-Za-z0-9._-]*$'));
});

// JIC11 — profile case preservation
test('JIC11', () => {
  assert.deepStrictEqual(policy.profile.normalization, ['trim']);
  assert.strictEqual(policy.profile.case_preserved, true);
  assert.strictEqual(policy.profile.case_folded, false);
});

// JIC12 — profile immutability + mismatch semantics
test('JIC12', () => {
  assert.strictEqual(policy.profile.immutable_when_active, true);
  assert.strictEqual(policy.profile.mismatch_error, 'PROFILE_BINDING_MISMATCH');
  assert.deepStrictEqual(policy.profile.allowed_sources, ['EXPLICIT_SELECTION', 'EXPLICIT_AUDITED_DEFAULT']);
  assert.strictEqual(policy.profile.silent_inheritance, 'FORBIDDEN');
});

// JIC13 — exact namespace templates
test('JIC13', () => {
  assert.deepStrictEqual(policy.namespaces.templates, {
    session: 'job:{job_id}:sessions',
    evidence: 'job:{job_id}:evidence',
    ledger: 'job:{job_id}:ledger',
    runtime_state: 'job:{job_id}:runtime-state',
    knowledge_job_local: 'job:{job_id}:knowledge',
  });
  assert.strictEqual(policy.namespaces.session_specific_template, 'job:{job_id}:sessions:{session_key}');
  for (const template of Object.values(policy.namespaces.templates)) {
    assert.ok(contract.includes(template), `contract missing template: ${template}`);
  }
});

// JIC14 — namespace override forbidden
test('JIC14', () => {
  assert.strictEqual(policy.namespaces.override, 'FORBIDDEN');
  assert.strictEqual(policy.namespaces.override_error, 'NAMESPACE_OVERRIDE_FORBIDDEN');
  assert.strictEqual(policy.namespaces.derivation_failure_error, 'NAMESPACE_DERIVATION_FAILED');
  assert.strictEqual(policy.namespaces.collision_error, 'NAMESPACE_COLLISION');
  assert.strictEqual(policy.namespaces.fallback, 'NONE');
});

// JIC15 — knowledge scope enum/order/JOB_LOCAL requirement
test('JIC15', () => {
  assert.deepStrictEqual(policy.knowledge_scope.enum, KNOWLEDGE_SCOPES);
  assert.deepStrictEqual(policy.knowledge_scope.canonical_order, KNOWLEDGE_SCOPES);
  assert.strictEqual(policy.knowledge_scope.job_local_required, true);
  assert.strictEqual(policy.knowledge_scope.deduplicate, true);
  assert.strictEqual(policy.knowledge_scope.empty, 'INVALID');
  assert.strictEqual(policy.knowledge_scope.unknown_error, 'INVALID_KNOWLEDGE_SCOPE');
});

// JIC16 — same-session/foreign-job rule
test('JIC16', () => {
  assert.deepStrictEqual(policy.knowledge_isolation.session_local.requires, ['SAME_CANONICAL_JOB', 'SAME_CANONICAL_SESSION']);
  assert.strictEqual(policy.knowledge_isolation.session_local.session_equality_overrides_foreign_job, false);
  assert.strictEqual(policy.knowledge_isolation.job_local.foreign_job_error, 'FOREIGN_JOB_REJECT');
});

// JIC17 — evidence isolation
test('JIC17', () => {
  assert.strictEqual(policy.evidence_isolation.cross_job_access_error, 'FOREIGN_JOB_REJECT');
  assert.strictEqual(policy.evidence_isolation.cross_job_write_error, 'FOREIGN_NAMESPACE_WRITE_REJECTED');
  assert.strictEqual(policy.evidence_isolation.shared_global_evidence_namespace, 'NOT_IN_V1');
});

// JIC18 — ledger/runtime isolation
test('JIC18', () => {
  assert.strictEqual(policy.ledger_isolation.shared_mutable_ledger, 'FORBIDDEN');
  assert.strictEqual(policy.runtime_state_isolation.foreign_read_write_error, 'FOREIGN_NAMESPACE_WRITE_REJECTED');
  assert.strictEqual(policy.runtime_state_isolation.cleanup_ownership, 'OWNING_JOB_NAMESPACE_ONLY');
});

// JIC19 — exact execution permission enum/order
test('JIC19', () => {
  assert.deepStrictEqual(policy.execution_permissions.enum, PERMISSIONS);
  assert.deepStrictEqual(policy.execution_permissions.canonical_order, PERMISSIONS);
  assert.strictEqual(policy.execution_permissions.read_only_required, true);
  assert.strictEqual(policy.execution_permissions.deduplicate, true);
  assert.strictEqual(policy.execution_permissions.unknown_error, 'INVALID_EXECUTION_PERMISSIONS');
  assert.strictEqual(policy.execution_permissions.empty, 'INVALID');
});

// JIC20 — JobContract capability != authorization
test('JIC20', () => {
  assert.strictEqual(policy.execution_permissions.capability_ceiling_not_authorization, true);
  assert.ok(contract.includes('capability ceiling'));
});

// JIC21 — READ remains release-gated
test('JIC21', () => {
  const mapping = policy.approval_mapping.READ_ONLY;
  assert.strictEqual(mapping.action_class, 'READ');
  assert.strictEqual(mapping.contract_alone_authorizes_execution, false);
  assert.strictEqual(mapping.release_gate, 'PLAN_AND_EXPLICIT_USER_RELEASE');
});

// JIC22 — WRITE remains approval-gated
test('JIC22', () => {
  for (const key of ['LOW_RISK_WRITE', 'CONFIG_WRITE']) {
    const mapping = policy.approval_mapping[key];
    assert.strictEqual(mapping.action_class, 'WRITE');
    assert.strictEqual(mapping.contract_alone_authorizes_execution, false);
    assert.strictEqual(mapping.approval_required, true);
  }
});

// JIC23 — DELETE + SECRET_ACCESS have no implicit authorization
test('JIC23', () => {
  for (const key of ['DELETE', 'SECRET_ACCESS']) {
    const mapping = policy.approval_mapping[key];
    assert.strictEqual(mapping.contract_alone_authorizes_execution, false);
    assert.strictEqual(mapping.requires_separate_explicit_governing_authority, true);
    assert.strictEqual(mapping.otherwise, 'FAIL_CLOSED');
  }
});

// JIC24 — ParallelLane required fields
test('JIC24', () => {
  assert.deepStrictEqual(policy.parallel_lane.required_fields, LANE_FIELDS);
});

// JIC25 — lane_id normalization
test('JIC25', () => {
  assert.deepStrictEqual(policy.parallel_lane.lane_id.normalization, ['unicode_nfkc', 'trim', 'lowercase']);
  assert.strictEqual(policy.parallel_lane.lane_id.pattern, '^[a-z0-9][a-z0-9._-]{0,63}$');
  assert.strictEqual(policy.parallel_lane.lane_id.collision_error, 'LANE_ID_COLLISION');
});

// JIC26 — baseline_main_sha pattern
test('JIC26', () => {
  assert.strictEqual(policy.parallel_lane.baseline_main_sha.pattern, '^[0-9a-f]{40}$');
  assert.strictEqual(policy.parallel_lane.baseline_main_sha.required, true);
});

// JIC27 — one-writer + cross-lane ownership rules
test('JIC27', () => {
  assert.strictEqual(policy.parallel_lane.one_active_writer_per_lane, true);
  assert.strictEqual(policy.parallel_lane.ownership_conflict_error, 'LANE_OWNERSHIP_CONFLICT');
  assert.strictEqual(policy.parallel_lane.cross_lane_write_error, 'CROSS_LANE_WRITE_REJECTED');
  assert.deepStrictEqual(policy.parallel_lane.immutable_fields, ['job_id', 'branch', 'worktree', 'writer_identity', 'baseline_main_sha']);
});

// JIC28 — main coordination + stale-baseline semantics
test('JIC28', () => {
  assert.strictEqual(policy.coordination.stale_baseline_error, 'STALE_MAIN_BASELINE');
  assert.strictEqual(policy.coordination.stale_lane_is_authoritative_main, false);
  assert.strictEqual(policy.coordination.coordination_checkout, 'MAIN_ONLY');
  assert.strictEqual(policy.coordination.writer_branch_cannot_be_main, true);
  assert.strictEqual(policy.coordination.coordination_violation_error, 'COORDINATION_CHECKOUT_VIOLATION');
});

// JIC29 — exact canonical error list
test('JIC29', () => {
  assert.deepStrictEqual(policy.canonical_errors, CANONICAL_ERRORS);
  assert.strictEqual(policy.canonical_errors.length, 18);
  for (const errorId of CANONICAL_ERRORS) {
    assert.ok(contract.includes(errorId), `contract missing error: ${errorId}`);
  }
});

// JIC30 — validation precedence exact
test('JIC30', () => {
  assert.deepStrictEqual(policy.validation_precedence, PRECEDENCE);
  assert.strictEqual(policy.validation_precedence.length, 10);
});

// JIC31 — exact 40 acceptance IDs
test('JIC31', () => {
  assert.strictEqual(policy.acceptance_model.total, 40);
  assert.deepStrictEqual(policy.acceptance_model.JC, ids('JC', 10));
  assert.deepStrictEqual(policy.acceptance_model.NS, ids('NS', 10));
  assert.deepStrictEqual(policy.acceptance_model.PL, ids('PL', 10));
  assert.deepStrictEqual(policy.acceptance_model.EP, ids('EP', 10));
  assert.ok(contract.includes('JC01'));
  assert.ok(contract.includes('EP10'));
});

// JIC32 — Phase 9C boundary + context-hydration@1.0.1 freeze + docs parity + boundary reconciliation
test('JIC32', () => {
  assert.deepStrictEqual(policy.phase_9c.forbidden_states, PHASE_9C_STATES);
  assert.strictEqual(policy.context_hydration.policy_ref, 'context-hydration@1.0.1');
  assert.strictEqual(policy.context_hydration.scoring_changes, 'NONE');
  assert.ok(contract.includes('context-hydration@1.0.1'));
  assert.ok(arch.includes('context-hydration@1.0.1'));
  assert.ok(arch.includes('CONTRACT LOCKED'));
  assert.ok(arch.includes('RUNTIME IMPLEMENTATION: PARTIAL'));
  assert.ok(!arch.includes('IMPLEMENTATION NOT STARTED'));
  assert.ok(collab.includes('job-isolation@1.0.0'));
  assert.strictEqual(policy.job_contract.required_fields.length, 8);
  assert.strictEqual(policy.job_boundary.job_contract_field_count, 8);
  assert.strictEqual(policy.job_boundary.working_context.job_contract_field, false);
  assert.strictEqual(policy.job_boundary.working_context.representation, 'DERIVED_JOB_SCOPED_VIEW');
  assert.strictEqual(policy.job_boundary.database_target.job_contract_field, false);
  assert.strictEqual(policy.job_boundary.database_target.ownership, 'OPERATION_SPECIFIC_EXECUTION_CONTEXT');
  assert.strictEqual(policy.job_boundary.database_target.isolation_identity, false);
  assert.strictEqual(policy.job_boundary.database_target.may_override_job_id, false);
  assert.strictEqual(policy.job_boundary.database_target.may_override_profile, false);
  assert.strictEqual(policy.job_boundary.database_target.may_elevate_permissions, false);
  assert.strictEqual(policy.job_boundary.database_target.credential_material_allowed, false);
  assert.ok(contract.includes('Job Isolation Boundary vs JobContract'));
  assert.ok(arch.includes('Job Isolation Boundary'));
  assert.ok(blueprint.includes('job-isolation@1.0.0'));
  assert.ok(!blueprint.includes('A unified JobContract does not yet exist'));
  assert.ok(workflow.includes('job-isolation@1.0.0'));
  assert.ok(!workflow.includes('governance not yet locked'));
});

// JIC33 — implementation status parity across machine/human/docs surfaces
test('JIC33', () => {
  assert.strictEqual(policy.implementation_status, 'PARTIAL');
  assert.ok(contract.includes('Implementation: PARTIAL'));
  assert.ok(!contract.includes('Implementation: NOT IMPLEMENTED'));
  assert.ok(arch.includes('RUNTIME IMPLEMENTATION: PARTIAL'));
  assert.ok(arch.includes('JobContract Runtime Core'));
  assert.ok(arch.includes('namespace derivation primitives'));
  assert.ok(!arch.includes('IMPLEMENTATION NOT STARTED'));
  assert.ok(blueprint.includes('Runtime implementation: PARTIAL'));
  assert.ok(blueprint.includes('Phase 9B acceptance: VERIFIED'));
  assert.ok(!blueprint.includes('Runtime implementation: NOT STARTED'));
  assert.ok(workflow.includes('Runtime implementation: PARTIAL'));
  assert.ok(workflow.includes('#38'));
  assert.ok(workflow.includes('JobContract Runtime Core'));
  assert.ok(!workflow.includes('Runtime implementation: NOT STARTED'));
  assert.ok(/#38\s+9B-02 JobContract Runtime Core\s+— CLOSED \/ VERIFIED/.test(collab));
  assert.ok(/#39\s+9B-03 Namespace Isolation Enforcement\s+— CLOSED \/ VERIFIED/.test(collab));
  assert.ok(/#40\s+9B-04 Parallel Lane Semantics\s+— CLOSED \/ VERIFIED/.test(collab));
  assert.ok(/#41\s+9B-05 Main Coordination Integration\s+— CLOSED \/ VERIFIED/.test(collab));
  assert.ok(/#42\s+9B-06 Acceptance Closure\s+— CLOSED \/ VERIFIED/.test(collab));
  assert.ok(collab.includes('CONTRACT_LOCKED / PARTIAL'));
  assert.ok(collab.includes('PHASE 9B VERIFIED'));
  assert.ok(policy.implementation_components.implemented.includes('PARALLEL_LANE_SEMANTICS'));
  assert.ok(arch.includes('ParallelLane runtime semantics'));
  assert.ok(readme.includes('ParallelLane runtime semantics'));
  assert.ok(blueprint.includes('ParallelLane runtime semantics'));
  assert.ok(workflow.includes('ParallelLane runtime semantics'));
  // 9B-03 namespace isolation enforcement parity (proposed post-merge truth)
  assert.ok(policy.implementation_components.implemented.includes('NAMESPACE_ISOLATION_ENFORCEMENT'));
  assert.ok(/9B-03 Namespace Isolation:\s*IMPLEMENTED \/ VERIFIED/.test(contract));
  assert.ok(arch.includes('namespace isolation enforcement'));
  assert.ok(arch.includes('knowledge-scope eligibility'));
  assert.ok(readme.includes('namespace isolation enforcement'));
  assert.ok(blueprint.includes('namespace isolation enforcement'));
  assert.ok(workflow.includes('namespace isolation enforcement'));
  assert.ok(contract.includes('Phase 9B'));
  assert.ok(/9B-06 Acceptance:\s*VERIFIED/.test(contract));
  assert.ok(contract.includes('docs/acceptance/phase-9b.md'));
  // 9B-05 main coordination integration parity (proposed post-merge truth)
  assert.ok(policy.implementation_components.implemented.includes('PARALLEL_LANE_MAIN_INTEGRATION'));
  assert.ok(policy.implementation_components.implemented.includes('MAIN_COORDINATION_INTEGRATION'));
  assert.deepStrictEqual(policy.implementation_components.pending, []);
  assert.ok(/9B-05 Integration:\s*IMPLEMENTED \/ VERIFIED/.test(contract));
  assert.ok(arch.includes('main coordination integration'));
  assert.ok(arch.includes('audited synchronization recognition'));
  assert.ok(readme.includes('Main Coordination Integration'));
  assert.ok(readme.includes('audited synchronization recognition'));
  assert.ok(blueprint.includes('Main Coordination Integration'));
  assert.ok(blueprint.includes('audited synchronization recognition'));
  assert.ok(workflow.includes('main coordination integration'));
  assert.ok(workflow.includes('audited synchronization recognition'));
  assert.ok(contract.includes('Architecture Freeze: NOT CLAIMED'));
  assert.ok(readme.includes('Phase 9B'));
  assert.ok(/Phase 9B: VERIFIED/.test(readme));
  assert.ok(readme.includes('NOT VERIFIED'));
  assert.ok(readme.includes('job-isolation@1.0.0'));
  assert.ok(readme.includes('PARTIAL'));
  assert.ok(!readme.includes('Phase 9B and Phase 9C remain TARGET'));
  assert.ok(migration.includes('Phase 9B'));
  assert.ok(/Phase 9B[^\n]*VERIFIED/.test(migration));
  assert.ok(migration.includes('NOT VERIFIED'));
  assert.ok(migration.includes('job-isolation@1.0.0'));
  assert.ok(migration.includes('PARTIAL'));
  assert.ok(!migration.includes('TARGET / PLANNED'));
  assert.ok(!migration.includes('Phase 9B and Phase 9C remain future target work'));
  assert.ok(buildPlan.includes('Phase 9B'));
  assert.ok(/Phase 9B\s+Job Isolation \+ Parallelism\s+VERIFIED/.test(buildPlan));
  assert.ok(buildPlan.includes('PARTIAL'));
  assert.ok(!/Phase 9B.*TARGET/.test(buildPlan));
  assert.ok(workflow.includes('NOT VERIFIED'));
});

console.log('');
console.log(`Cases: ${passed + failed}`);
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);

process.exit(failed > 0 ? 1 : 0);
