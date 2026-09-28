/**
 * Context Hydration — Integration test suite (9A-07 / Issue #14).
 *
 * Policy: context-hydration@1.0.1
 * Lane: #14 — hydrateContext integration orchestrator.
 *
 * Coverage (I01-I20):
 *  - I01 happy-path curated retrieval produces ContextPackage
 *  - I02 identical deterministic input produces identical output
 *  - I03 LOW confidence invokes zero providers and returns mandatory-only package
 *  - I04 foreign-job knowledge absent from final retrieval
 *  - I05 global candidate remains eligible
 *  - I06 semantic memory remains advisory-compatible and rankable
 *  - I07 raw source without explicit request does not invoke raw provider
 *  - I08 explicit raw request invokes provider but no raw authority is invented
 *  - I09 rank total_score maps exactly to ContextPackage score
 *  - I10 rank is deterministic 1-based ranked position
 *  - I11 duplicate knowledge obeys (source_type, source_id) identity
 *  - I12 retrieval budget omission metadata is produced safely
 *  - I13 mandatory overflow preserves CONTEXT_BUDGET_EXCEEDED
 *  - I14 compatible skill chain returns deterministic ordered skill_chain
 *  - I15 skill conflict fails closed before omission-store write
 *  - I16 forbidden skill override fails closed before omission-store write
 *  - I17 successful omission-store write occurs only on successful package build
 *  - I18 representative inputs are not mutated
 *  - I19 malformed ranking candidate fails closed
 *  - I20 explicit hydration_run_id and hydration_started_at are preserved exactly
 *
 * Deterministic. No network. No DB. No env reads. No wall-clock reads.
 * No memory service. Every retrieval provider is caller-injected.
 */

'use strict';

const assert = require('assert');

const { hydrateContext } = require('../../context-hydration/hydrator.js');
const { rankCandidates } = require('../../context-hydration/ranking-policy.js');
const { createOmissionStore } = require('../../context-hydration/context-package.js');
const { BudgetError } = require('../../context-hydration/budget.js');
const { SkillResolverError } = require('../../context-hydration/skill-resolver.js');

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

// ---------------------------------------------------------------------------
// Deterministic fixtures
// ---------------------------------------------------------------------------

const HYDRATION_STARTED_AT = '2026-09-27T00:00:00Z';
const SESSION_ID = 'session-1';
const JOB_ID = 'job-1';
const RUN_ID = 'run-1';

const CANDIDATE_SOURCE_TYPES = [
  'curated',
  'reviewed_session_fact',
  'historical_checkpoint',
  'semantic_memory',
  'raw_source',
];

function budgetInputs(overrides = {}) {
  return {
    tokenizer_id: 'deterministic-test-tokenizer',
    context_window_tokens: 100000,
    response_headroom_tokens: 10000,
    execution_reserve_tokens: 5000,
    active_conversation_tokens: 20000,
    mandatory_context_tokens: 30000,
    ...overrides,
  };
}

function mandatoryRecords() {
  return [
    { source_id: 'mand-approval', source_type: 'mandatory', category: 'approval_state' },
    { source_id: 'mand-checkpoint', source_type: 'mandatory', category: 'latest_valid_checkpoint' },
  ];
}

function curatedCandidate(overrides = {}) {
  return {
    source_id: 'curated-1',
    scope: 'session',
    session_id: SESSION_ID,
    job_id: JOB_ID,
    updated_at: '2026-09-26T00:00:00Z',
    retrieval_terms: ['context', 'hydration'],
    estimated_tokens: 100,
    content: 'curated knowledge payload',
    provenance: { origin: 'test-provider' },
    ...overrides,
  };
}

function reviewedCandidate(overrides = {}) {
  return {
    source_id: 'fact-1',
    scope: 'session',
    session_id: SESSION_ID,
    job_id: JOB_ID,
    updated_at: '2026-09-25T00:00:00Z',
    retrieval_terms: ['hydration'],
    estimated_tokens: 50,
    content: 'reviewed session fact payload',
    ...overrides,
  };
}

function semanticCandidate(overrides = {}) {
  return {
    source_id: 'sem-1',
    scope: 'session',
    session_id: SESSION_ID,
    job_id: JOB_ID,
    updated_at: '2026-09-26T00:00:00Z',
    retrieval_terms: ['context'],
    estimated_tokens: 40,
    content: 'semantic memory advisory payload',
    ...overrides,
  };
}

function rawCandidate(overrides = {}) {
  return {
    source_id: 'raw-1',
    scope: 'session',
    session_id: SESSION_ID,
    job_id: JOB_ID,
    updated_at: '2026-09-26T00:00:00Z',
    retrieval_terms: ['context'],
    estimated_tokens: 10,
    content: 'raw source payload',
    ...overrides,
  };
}

/**
 * Build injected providers with per-source invocation counters.
 * Only source types present in `definitions` get a provider function;
 * everything else stays an unavailable adapter.
 */
function makeProviderEnv(definitions = {}) {
  const calls = {};
  const providers = {};
  for (const sourceType of CANDIDATE_SOURCE_TYPES) {
    calls[sourceType] = 0;
    if (Object.prototype.hasOwnProperty.call(definitions, sourceType)) {
      const records = definitions[sourceType];
      providers[sourceType] = () => {
        calls[sourceType] += 1;
        return records;
      };
    }
  }
  return { providers, calls };
}

function baseParams(overrides = {}) {
  return {
    hydration_run_id: RUN_ID,
    hydration_started_at: HYDRATION_STARTED_AT,
    session_id: SESSION_ID,
    job_id: JOB_ID,
    latest_checkpoint: { checkpoint_id: 'checkpoint-7' },
    user_request: 'Implement the deterministic context hydration pipeline',
    active_constraints: ['no-network', 'deterministic-only'],
    explicit_objective: {
      summary: 'Integrate the context hydration pipeline',
      retrieval_terms: ['context', 'hydration', 'pipeline'],
    },
    mandatory: mandatoryRecords(),
    budget_inputs: budgetInputs(),
    retrieval_providers: {},
    skills: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// I01-I10
// ---------------------------------------------------------------------------

// I01: happy-path curated retrieval produces ContextPackage
test('I01 happy-path curated retrieval produces ContextPackage', () => {
  const { providers, calls } = makeProviderEnv({
    curated: [curatedCandidate()],
    reviewed_session_fact: [reviewedCandidate()],
  });
  const result = hydrateContext(baseParams({ retrieval_providers: providers }));
  const pkg = result.context_package;

  assert.strictEqual(calls.curated, 1);
  assert.strictEqual(calls.reviewed_session_fact, 1);
  assert.strictEqual(pkg.hydration_run_id, RUN_ID);
  assert.strictEqual(pkg.policy_id, 'context-hydration');
  assert.strictEqual(pkg.policy_version, '1.0.1');
  assert.strictEqual(pkg.job_id, JOB_ID);
  assert.strictEqual(pkg.session_id, SESSION_ID);
  assert.deepStrictEqual(pkg.mandatory, mandatoryRecords());
  assert.strictEqual(pkg.retrieved.length, 2);
  assert.strictEqual(pkg.omitted.length, 0);

  const first = pkg.retrieved[0];
  assert.strictEqual(first.source_id, 'curated-1');
  assert.strictEqual(first.source_type, 'curated');
  assert.strictEqual(first.rank, 1);
  assert.strictEqual(first.score, 0.833333);
  assert.strictEqual(first.reason, 'retrieved');

  const second = pkg.retrieved[1];
  assert.strictEqual(second.source_id, 'fact-1');
  assert.strictEqual(second.source_type, 'reviewed_session_fact');
  assert.strictEqual(second.rank, 2);

  assert.deepStrictEqual(result.skill_chain, { count: 0, ordered: [], override_applied: false });
  assert.ok(
    !Object.prototype.hasOwnProperty.call(pkg, 'skill_chain'),
    'skill_chain must be returned separately, never inside ContextPackage'
  );
});

// I02: identical deterministic input produces identical output
test('I02 identical deterministic input produces identical output', () => {
  const build = () => hydrateContext(baseParams({
    retrieval_providers: makeProviderEnv({
      curated: [curatedCandidate()],
      semantic_memory: [semanticCandidate()],
    }).providers,
    skills: [{ skill_id: 'skill-a', class: 'PRIMARY', phase: 'UNDERSTAND' }],
  }));
  const first = build();
  const second = build();

  assert.deepStrictEqual(first, second);
  assert.strictEqual(JSON.stringify(first), JSON.stringify(second));
});

// I03: LOW confidence invokes zero providers and returns mandatory-only package
test('I03 LOW confidence invokes zero providers and returns mandatory-only package', () => {
  const { providers, calls } = makeProviderEnv({
    curated: [curatedCandidate()],
    reviewed_session_fact: [reviewedCandidate()],
    historical_checkpoint: [reviewedCandidate({ source_id: 'hist-1' })],
    semantic_memory: [semanticCandidate()],
    raw_source: [rawCandidate()],
  });
  const result = hydrateContext(baseParams({
    user_request: '',
    explicit_objective: undefined,
    active_constraints: [],
    retrieval_providers: providers,
  }));
  const pkg = result.context_package;

  assert.strictEqual(pkg.objective.confidence, 0);
  for (const sourceType of CANDIDATE_SOURCE_TYPES) {
    assert.strictEqual(calls[sourceType], 0, `${sourceType} provider must not be invoked at LOW confidence`);
  }
  assert.deepStrictEqual(pkg.retrieved, []);
  assert.deepStrictEqual(pkg.omitted, []);
  assert.deepStrictEqual(pkg.mandatory, mandatoryRecords());
});

// I04: foreign-job knowledge absent from final retrieval
test('I04 foreign-job knowledge absent from final retrieval', () => {
  const { providers } = makeProviderEnv({
    curated: [
      curatedCandidate({ source_id: 'foreign-1', job_id: 'job-other' }),
      curatedCandidate({ source_id: 'local-1', job_id: JOB_ID }),
    ],
  });
  const result = hydrateContext(baseParams({ retrieval_providers: providers }));
  const pkg = result.context_package;

  assert.ok(
    !JSON.stringify(pkg).includes('foreign-1'),
    'foreign-job knowledge must not appear anywhere in the ContextPackage'
  );
  assert.strictEqual(pkg.retrieved.length, 1);
  assert.strictEqual(pkg.retrieved[0].source_id, 'local-1');
});

// I05: global candidate remains eligible
test('I05 global candidate remains eligible', () => {
  const globalCandidate = {
    source_id: 'global-1',
    scope: 'global',
    updated_at: '2026-09-26T00:00:00Z',
    retrieval_terms: ['context', 'hydration'],
    estimated_tokens: 25,
    content: 'global curated payload',
  };
  const { providers } = makeProviderEnv({ curated: [globalCandidate] });
  const result = hydrateContext(baseParams({ retrieval_providers: providers }));
  const pkg = result.context_package;

  assert.strictEqual(pkg.retrieved.length, 1);
  assert.strictEqual(pkg.retrieved[0].source_id, 'global-1');
  assert.strictEqual(pkg.retrieved[0].scope_specificity, 0.5);
  assert.strictEqual(pkg.retrieved[0].rank, 1);
});

// I06: semantic memory remains advisory-compatible and rankable
test('I06 semantic memory remains advisory-compatible and rankable', () => {
  const { providers } = makeProviderEnv({ semantic_memory: [semanticCandidate()] });
  const result = hydrateContext(baseParams({ retrieval_providers: providers }));
  const pkg = result.context_package;

  assert.strictEqual(pkg.retrieved.length, 1);
  const record = pkg.retrieved[0];
  assert.strictEqual(record.source_id, 'sem-1');
  assert.strictEqual(record.source_type, 'semantic_memory');
  assert.strictEqual(record.authority, 0.5);
  assert.strictEqual(record.rank, 1);
  assert.strictEqual(typeof record.score, 'number');
});

// I07: raw source without explicit request does not invoke raw provider
test('I07 raw source without explicit request does not invoke raw provider', () => {
  // (a) no request at all
  const envA = makeProviderEnv({ raw_source: [rawCandidate()] });
  hydrateContext(baseParams({ retrieval_providers: envA.providers }));
  assert.strictEqual(envA.calls.raw_source, 0, 'raw provider must not be invoked without a request');

  // (b) non-explicit request
  const envB = makeProviderEnv({ raw_source: [rawCandidate()] });
  const resultB = hydrateContext(baseParams({
    retrieval_providers: envB.providers,
    raw_source_request: { explicit: false, source_ids: ['raw-1'] },
  }));
  assert.strictEqual(envB.calls.raw_source, 0, 'raw provider must not be invoked for a non-explicit request');
  assert.strictEqual(resultB.context_package.retrieved.length, 0);

  // (c) explicit flag without concrete source ids
  const envC = makeProviderEnv({ raw_source: [rawCandidate()] });
  const resultC = hydrateContext(baseParams({
    retrieval_providers: envC.providers,
    raw_source_request: { explicit: true, source_ids: [] },
  }));
  assert.strictEqual(envC.calls.raw_source, 0, 'raw provider must not be invoked without a concrete source id');
  assert.strictEqual(resultC.context_package.retrieved.length, 0);
});

// I08: explicit raw request invokes provider but no raw authority is invented
test('I08 explicit raw request invokes provider but no raw authority is invented', () => {
  const { providers, calls } = makeProviderEnv({
    raw_source: [rawCandidate({ source_id: 'raw-1' }), rawCandidate({ source_id: 'raw-2' })],
  });
  const result = hydrateContext(baseParams({
    retrieval_providers: providers,
    raw_source_request: { explicit: true, source_ids: ['raw-1'] },
  }));
  const pkg = result.context_package;

  assert.strictEqual(calls.raw_source, 1, 'raw provider must be invoked for an explicit request');
  assert.strictEqual(pkg.retrieved.length, 0, 'raw source must not be included in retrieved records');
  assert.strictEqual(pkg.omitted.length, 0, 'raw source must not be included in omitted records');

  // Ranking rejects raw_source as unknown authority under policy 1.0.1 —
  // no synthetic authority value is invented by the integration layer.
  const direct = rankCandidates({
    objective_retrieval_terms: ['context', 'hydration', 'pipeline'],
    candidates: [{ ...rawCandidate({ source_id: 'raw-1' }), source_type: 'raw_source' }],
    active_job_id: JOB_ID,
    active_session_id: SESSION_ID,
    hydration_started_at: HYDRATION_STARTED_AT,
  });
  assert.strictEqual(direct.ranked.length, 0);
  assert.deepStrictEqual(direct.rejected, [{ source_id: 'raw-1', reason: 'unknown_authority' }]);
});

// I09: rank total_score maps exactly to ContextPackage score
test('I09 rank total_score maps exactly to ContextPackage score', () => {
  const { providers } = makeProviderEnv({
    curated: [curatedCandidate()],
    reviewed_session_fact: [reviewedCandidate()],
  });
  const result = hydrateContext(baseParams({ retrieval_providers: providers }));
  const pkg = result.context_package;

  const direct = rankCandidates({
    objective_retrieval_terms: pkg.objective.retrieval_terms,
    candidates: [
      { ...curatedCandidate(), source_type: 'curated' },
      { ...reviewedCandidate(), source_type: 'reviewed_session_fact' },
    ],
    active_job_id: JOB_ID,
    active_session_id: SESSION_ID,
    hydration_started_at: HYDRATION_STARTED_AT,
  });

  assert.strictEqual(pkg.retrieved.length, 2);
  for (let i = 0; i < direct.ranked.length; i += 1) {
    assert.strictEqual(
      pkg.retrieved[i].score,
      direct.ranked[i].total_score,
      `retrieved[${i}].score must equal ranking total_score`
    );
  }
  // Exact wiring value for the curated candidate: 5/6 quantized to 0.833333.
  assert.strictEqual(pkg.retrieved[0].score, 0.833333);
});

// I10: rank is deterministic 1-based ranked position
test('I10 rank is deterministic 1-based ranked position', () => {
  const { providers } = makeProviderEnv({
    curated: [curatedCandidate()],
    reviewed_session_fact: [reviewedCandidate()],
    semantic_memory: [semanticCandidate()],
  });
  const result = hydrateContext(baseParams({ retrieval_providers: providers }));
  const pkg = result.context_package;

  assert.strictEqual(pkg.retrieved.length, 3);
  assert.deepStrictEqual(pkg.retrieved.map((record) => record.rank), [1, 2, 3]);
  assert.deepStrictEqual(
    pkg.retrieved.map((record) => record.source_id),
    ['curated-1', 'fact-1', 'sem-1']
  );
});

// ---------------------------------------------------------------------------
// I11-I20
// ---------------------------------------------------------------------------

// I11: duplicate knowledge obeys (source_type, source_id) identity
test('I11 duplicate knowledge obeys (source_type, source_id) identity', () => {
  const dupNewer = curatedCandidate({ source_id: 'dup-1', updated_at: '2026-09-26T00:00:00Z', content: 'newer duplicate' });
  const dupOlder = curatedCandidate({ source_id: 'dup-1', updated_at: '2026-07-01T00:00:00Z', content: 'older duplicate' });
  const curatedPair = curatedCandidate({ source_id: 'pair-1', updated_at: '2026-09-26T00:00:00Z', content: 'curated pair payload' });
  const reviewedPair = reviewedCandidate({ source_id: 'pair-1', updated_at: '2026-09-26T00:00:00Z', content: 'reviewed pair payload' });
  const { providers } = makeProviderEnv({
    curated: [dupNewer, dupOlder, curatedPair],
    reviewed_session_fact: [reviewedPair],
  });
  const result = hydrateContext(baseParams({ retrieval_providers: providers }));
  const pkg = result.context_package;

  const dupRecords = pkg.retrieved.filter((record) => record.source_id === 'dup-1');
  assert.strictEqual(dupRecords.length, 1, 'duplicate (source_type, source_id) must be deduplicated to one record');
  assert.strictEqual(dupRecords[0].content, 'newer duplicate', 'first ranked occurrence must be kept');

  const pairRecords = pkg.retrieved.filter((record) => record.source_id === 'pair-1');
  assert.strictEqual(pairRecords.length, 2, 'same source_id with different source_type is not a duplicate');
  assert.deepStrictEqual(
    pairRecords.map((record) => record.source_type).sort(),
    ['curated', 'reviewed_session_fact']
  );
});

// I12: retrieval budget omission metadata is produced safely
test('I12 retrieval budget omission metadata is produced safely', () => {
  const { providers } = makeProviderEnv({
    curated: [
      curatedCandidate({ source_id: 'fit-a', estimated_tokens: 5000 }),
      curatedCandidate({ source_id: 'fit-c', retrieval_terms: [], estimated_tokens: 1000, content: 'small payload' }),
    ],
    reviewed_session_fact: [reviewedCandidate({ source_id: 'omit-b', estimated_tokens: 5000 })],
  });
  const store = createOmissionStore();
  const result = hydrateContext(baseParams({ retrieval_providers: providers, omission_store: store }));
  const pkg = result.context_package;

  assert.deepStrictEqual(pkg.retrieved.map((record) => record.source_id), ['fit-a', 'fit-c']);
  assert.strictEqual(pkg.omitted.length, 1);

  const omission = pkg.omitted[0];
  assert.strictEqual(omission.source_id, 'omit-b');
  assert.strictEqual(omission.source_type, 'reviewed_session_fact');
  assert.strictEqual(omission.omission_reason, 'retrieval_budget_exceeded');
  assert.strictEqual(omission.estimated_tokens, 5000);
  assert.strictEqual(omission.hydration_run_id, RUN_ID);
  assert.strictEqual(omission.omitted_at, HYDRATION_STARTED_AT);
  assert.strictEqual(omission.expires_at, '2026-10-27T00:00:00.000Z');
  assert.strictEqual(omission.rank, 2);
  assert.strictEqual(omission.score, 0.634167);
  assert.ok(!('content' in omission), 'omission metadata must not persist full content');

  const allowed = [
    'source_id', 'source_type', 'scope', 'score', 'rank',
    'omission_reason', 'estimated_tokens', 'hydration_run_id', 'omitted_at', 'expires_at',
  ];
  assert.deepStrictEqual(Object.keys(omission).sort(), [...allowed].sort());

  // Persisted safely through the existing omission-store boundary.
  const stored = store.list(HYDRATION_STARTED_AT);
  assert.strictEqual(stored.length, 1);
  assert.deepStrictEqual(stored[0], omission);
});

// I13: mandatory overflow preserves CONTEXT_BUDGET_EXCEEDED
test('I13 mandatory overflow preserves CONTEXT_BUDGET_EXCEEDED', () => {
  const { providers, calls } = makeProviderEnv({ curated: [curatedCandidate()] });
  const store = createOmissionStore();
  let error = null;
  try {
    hydrateContext(baseParams({
      retrieval_providers: providers,
      budget_inputs: budgetInputs({ mandatory_context_tokens: 70000 }),
      omission_store: store,
    }));
  } catch (e) {
    error = e;
  }

  assert.ok(error, 'mandatory overflow must fail closed');
  assert.ok(error instanceof BudgetError, `expected BudgetError, got ${error && error.name}`);
  assert.strictEqual(error.code, 'CONTEXT_BUDGET_EXCEEDED');
  assert.strictEqual(calls.curated, 1, 'pipeline must reach the package stage before budget overflow');
  assert.strictEqual(store.list(HYDRATION_STARTED_AT).length, 0, 'failed run must not write omission metadata');
});

// I14: compatible skill chain returns deterministic ordered skill_chain
test('I14 compatible skill chain returns deterministic ordered skill_chain', () => {
  const skills = [
    { skill_id: 'skill-b', class: 'SUPPORTING', phase: 'DESIGN/PLAN' },
    { skill_id: 'skill-a', class: 'PRIMARY', phase: 'UNDERSTAND' },
    { skill_id: 'skill-d', class: 'SUPPORTING', phase: 'VALIDATE' },
  ];
  const result = hydrateContext(baseParams({ skills }));

  assert.deepStrictEqual(result.skill_chain, {
    count: 3,
    ordered: [
      { skill_id: 'skill-a', class: 'PRIMARY', phase: 'UNDERSTAND', explicit: false },
      { skill_id: 'skill-b', class: 'SUPPORTING', phase: 'DESIGN/PLAN', explicit: false },
      { skill_id: 'skill-d', class: 'SUPPORTING', phase: 'VALIDATE', explicit: false },
    ],
    override_applied: false,
  });
  assert.ok(!Object.prototype.hasOwnProperty.call(result.context_package, 'skill_chain'));
});

// I15: skill conflict fails closed before omission-store write
test('I15 skill conflict fails closed before omission-store write', () => {
  const { providers, calls } = makeProviderEnv({ curated: [curatedCandidate()] });
  const store = createOmissionStore();
  let error = null;
  try {
    hydrateContext(baseParams({
      retrieval_providers: providers,
      omission_store: store,
      skills: [
        { skill_id: 'skill-a', class: 'PRIMARY', phase: 'UNDERSTAND' },
        { skill_id: 'skill-x', class: 'CONFLICTING', phase: 'EXECUTE' },
      ],
    }));
  } catch (e) {
    error = e;
  }

  assert.ok(error instanceof SkillResolverError, `expected SkillResolverError, got ${error && error.name}`);
  assert.strictEqual(error.code, 'SKILL_CONFLICT');
  assert.strictEqual(store.list(HYDRATION_STARTED_AT).length, 0, 'skill failure must not write omission metadata');
  assert.strictEqual(calls.curated, 0, 'retrieval must not run after a skill failure');
});

// I16: forbidden skill override fails closed before omission-store write
test('I16 forbidden skill override fails closed before omission-store write', () => {
  const store = createOmissionStore();
  let error = null;
  try {
    hydrateContext(baseParams({
      omission_store: store,
      skills: [{ skill_id: 'skill-a', class: 'PRIMARY', phase: 'UNDERSTAND' }],
      skill_override_request: { security_constraints: true },
    }));
  } catch (e) {
    error = e;
  }

  assert.ok(error instanceof SkillResolverError, `expected SkillResolverError, got ${error && error.name}`);
  assert.strictEqual(error.code, 'SKILL_OVERRIDE_FORBIDDEN');
  assert.strictEqual(store.list(HYDRATION_STARTED_AT).length, 0, 'protected override failure must not write omission metadata');
});

// I17: successful omission-store write occurs only on successful package build
test('I17 successful omission-store write occurs only on successful package build', () => {
  const store = createOmissionStore();

  // Failed build (mandatory overflow) must not write.
  let error = null;
  try {
    hydrateContext(baseParams({
      budget_inputs: budgetInputs({ mandatory_context_tokens: 70000 }),
      omission_store: store,
    }));
  } catch (e) {
    error = e;
  }
  assert.ok(error instanceof BudgetError);
  assert.strictEqual(store.list(HYDRATION_STARTED_AT).length, 0);

  // Successful build with an omitted record persists exactly that metadata.
  const { providers } = makeProviderEnv({
    curated: [curatedCandidate({ source_id: 'fit-a', estimated_tokens: 5000 })],
    reviewed_session_fact: [reviewedCandidate({ source_id: 'omit-b', estimated_tokens: 5000 })],
  });
  const result = hydrateContext(baseParams({ retrieval_providers: providers, omission_store: store }));
  assert.strictEqual(result.context_package.omitted.length, 1);

  const stored = store.list(HYDRATION_STARTED_AT);
  assert.strictEqual(stored.length, 1);
  assert.deepStrictEqual(stored[0], result.context_package.omitted[0]);
});

// I18: representative inputs are not mutated
test('I18 representative inputs are not mutated', () => {
  const mandatory = mandatoryRecords();
  const budget = budgetInputs();
  const rawRequest = { explicit: true, source_ids: ['raw-1'] };
  const skills = [{ skill_id: 'skill-a', class: 'PRIMARY', phase: 'UNDERSTAND' }];
  const constraints = ['no-network', 'deterministic-only'];
  const explicitObjective = {
    summary: 'Integrate the context hydration pipeline',
    retrieval_terms: ['context', 'hydration', 'pipeline'],
  };
  const providerRecords = [curatedCandidate(), reviewedCandidate()];
  const providers = { curated: () => providerRecords };

  const params = baseParams({
    active_constraints: constraints,
    explicit_objective: explicitObjective,
    mandatory,
    budget_inputs: budget,
    retrieval_providers: providers,
    raw_source_request: rawRequest,
    skills,
  });

  const snapshot = (value) => JSON.parse(JSON.stringify(value));
  const mandatoryBefore = snapshot(mandatory);
  const budgetBefore = snapshot(budget);
  const rawBefore = snapshot(rawRequest);
  const skillsBefore = snapshot(skills);
  const constraintsBefore = snapshot(constraints);
  const objectiveBefore = snapshot(explicitObjective);
  const recordsBefore = snapshot(providerRecords);
  const paramsBefore = snapshot(params);

  hydrateContext(params);

  assert.deepStrictEqual(mandatory, mandatoryBefore);
  assert.deepStrictEqual(budget, budgetBefore);
  assert.deepStrictEqual(rawRequest, rawBefore);
  assert.deepStrictEqual(skills, skillsBefore);
  assert.deepStrictEqual(constraints, constraintsBefore);
  assert.deepStrictEqual(explicitObjective, objectiveBefore);
  assert.deepStrictEqual(providerRecords, recordsBefore, 'provider-returned records must not be mutated');
  assert.deepStrictEqual(snapshot(params), paramsBefore, 'params must not be mutated');
  assert.strictEqual(params.retrieval_providers.curated, providers.curated);
});

// I19: malformed ranking candidate fails closed
test('I19 malformed ranking candidate fails closed', () => {
  const store = createOmissionStore();
  const { providers } = makeProviderEnv({
    curated: [curatedCandidate({ updated_at: 'not-a-timestamp' })],
  });
  let error = null;
  try {
    hydrateContext(baseParams({ retrieval_providers: providers, omission_store: store }));
  } catch (e) {
    error = e;
  }

  assert.ok(error, 'malformed ranking candidate must fail closed');
  assert.ok(/RFC3339/.test(String(error.message)), `expected RFC3339 failure, got: ${error && error.message}`);
  assert.strictEqual(store.list(HYDRATION_STARTED_AT).length, 0, 'ranking failure must not write omission metadata');
});

// I20: explicit hydration_run_id and hydration_started_at are preserved exactly
test('I20 explicit hydration_run_id and hydration_started_at are preserved exactly', () => {
  const runId = 'run-explicit-42';
  const anchor = '2026-09-27T10:20:30.123456Z';
  const { providers } = makeProviderEnv({
    curated: [curatedCandidate({ source_id: 'fit-a', estimated_tokens: 5000 })],
    reviewed_session_fact: [reviewedCandidate({ source_id: 'omit-b', estimated_tokens: 5000 })],
  });
  const result = hydrateContext(baseParams({
    hydration_run_id: runId,
    hydration_started_at: anchor,
    retrieval_providers: providers,
  }));
  const pkg = result.context_package;

  assert.strictEqual(pkg.hydration_run_id, runId);
  assert.strictEqual(pkg.hydration_started_at, anchor);

  // Derived omission timestamps use the exact provided anchor.
  assert.strictEqual(pkg.omitted.length, 1);
  assert.strictEqual(pkg.omitted[0].hydration_run_id, runId);
  assert.strictEqual(pkg.omitted[0].omitted_at, anchor);
  assert.strictEqual(pkg.omitted[0].expires_at, '2026-10-27T10:20:30.123456Z');
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n=== Context Hydration Integration Test Summary ===`);
console.log(`Cases: ${passed + failed}, Passed: ${passed}, Failed: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
