/**
 * Phase 9A Context Hydration — Acceptance suite (9A-08 / Issue #15).
 *
 * Policy: context-hydration@1.0.1
 *
 * Exactly 37 acceptance cases:
 *   O01-O10 = 10  (Objective)
 *   H01-H17 = 17  (Hydration)
 *   S01-S10 = 10  (Skills)
 *
 * Primarily exercises the public integrated boundary hydrateContext().
 * Lower-level exported runtime APIs are used only where the invariant
 * concerns behavior that cannot be observed completely through the
 * integrated package (H03 rankability chain, H16 retention store).
 *
 * Deterministic. No network. No DB. No env reads. No wall-clock reads.
 * All timestamps are explicit. Retrieval providers are deterministic
 * caller-injected test doubles (the runtime's designed provider interface).
 *
 * Exit 0 only when exactly 37/37 PASS with canonical IDs intact.
 */

'use strict';

const assert = require('assert');

const { hydrateContext } = require('../../context-hydration/hydrator.js');
const { createRetrievalRegistry, retrieveCandidates } = require('../../context-hydration/retrieval-adapters.js');
const { evaluateEligibility } = require('../../context-hydration/eligibility-gates.js');
const { rankCandidates } = require('../../context-hydration/ranking-policy.js');
const { createOmissionStore } = require('../../context-hydration/context-package.js');
const { BudgetError } = require('../../context-hydration/budget.js');
const { SkillResolverError } = require('../../context-hydration/skill-resolver.js');

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const CANONICAL_IDS = {
  Objective: ['O01', 'O02', 'O03', 'O04', 'O05', 'O06', 'O07', 'O08', 'O09', 'O10'],
  Hydration: [
    'H01', 'H02', 'H03', 'H04', 'H05', 'H06', 'H07', 'H08', 'H09',
    'H10', 'H11', 'H12', 'H13', 'H14', 'H15', 'H16', 'H17',
  ],
  Skills: ['S01', 'S02', 'S03', 'S04', 'S05', 'S06', 'S07', 'S08', 'S09', 'S10'],
};

const categories = [
  { name: 'Objective', expected: 10, canonical: CANONICAL_IDS.Objective, cases: [], passed: 0 },
  { name: 'Hydration', expected: 17, canonical: CANONICAL_IDS.Hydration, cases: [], passed: 0 },
  { name: 'Skills', expected: 10, canonical: CANONICAL_IDS.Skills, cases: [], passed: 0 },
];

function objective(id, label, fn) { categories[0].cases.push({ id, label, fn }); }
function hydration(id, label, fn) { categories[1].cases.push({ id, label, fn }); }
function skill(id, label, fn) { categories[2].cases.push({ id, label, fn }); }

// ---------------------------------------------------------------------------
// Deterministic fixtures
// ---------------------------------------------------------------------------

const HYDRATION_STARTED_AT = '2026-09-27T00:00:00Z';
const SESSION_ID = 'session-accept-1';
const JOB_ID = 'job-accept-1';
const RUN_ID = 'run-accept-1';

function budgetInputs(overrides = {}) {
  return {
    tokenizer_id: 'deterministic-acceptance-tokenizer',
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
    { source_id: 'mand-instructions', source_type: 'mandatory', category: 'mandatory_project_instructions' },
  ];
}

function makeProviderEnv(definitions = {}) {
  const calls = {};
  const providers = {};
  for (const sourceType of ['curated', 'reviewed_session_fact', 'historical_checkpoint', 'semantic_memory', 'raw_source']) {
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

function curatedCandidate(overrides = {}) {
  return {
    source_id: 'curated-1',
    scope: 'session',
    session_id: SESSION_ID,
    job_id: JOB_ID,
    updated_at: '2026-09-26T00:00:00Z',
    retrieval_terms: ['context', 'hydration'],
    estimated_tokens: 100,
    content: 'curated acceptance payload',
    provenance: { origin: 'acceptance-fixture' },
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

function skillRecord(skill_id, cls, phase) {
  return { skill_id, class: cls, phase };
}

function baseParams(overrides = {}) {
  return {
    hydration_run_id: RUN_ID,
    hydration_started_at: HYDRATION_STARTED_AT,
    session_id: SESSION_ID,
    job_id: JOB_ID,
    latest_checkpoint: null,
    user_request: 'Implement the deterministic context hydration acceptance suite',
    active_constraints: ['no-network', 'deterministic-only'],
    explicit_objective: { summary: 'Acceptance fixture objective', retrieval_terms: ['context', 'hydration', 'pipeline'] },
    mandatory: mandatoryRecords(),
    budget_inputs: budgetInputs(),
    retrieval_providers: {},
    skills: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Objective acceptance — O01-O10
// ---------------------------------------------------------------------------

objective('O01', 'Explicit objective preserved', () => {
  const explicit = {
    summary: 'Explicit acceptance objective summary',
    intent: 'IMPLEMENT',
    entities: ['entity-alpha', 'entity-beta'],
    retrieval_terms: ['alpha', 'beta', 'gamma'],
  };
  const result = hydrateContext(baseParams({ explicit_objective: explicit }));
  const obj = result.context_package.objective;
  assert.strictEqual(obj.summary, 'Explicit acceptance objective summary');
  assert.strictEqual(obj.intent, 'IMPLEMENT');
  assert.deepStrictEqual(obj.entities, ['entity-alpha', 'entity-beta']);
  assert.deepStrictEqual(obj.retrieval_terms, ['alpha', 'beta', 'gamma']);
  assert.strictEqual(obj.confidence, 1);
});

objective('O02', 'Clear request produces structured objective', () => {
  const result = hydrateContext(baseParams({
    explicit_objective: undefined,
    user_request: 'Implement the deterministic context hydration acceptance suite',
  }));
  const obj = result.context_package.objective;
  assert.ok(typeof obj.objective_id === 'string' && obj.objective_id.startsWith('obj-'));
  assert.strictEqual(obj.summary, 'Implement the deterministic context hydration acceptance suite');
  assert.strictEqual(obj.intent, 'IMPLEMENT');
  assert.deepStrictEqual(obj.scope, { session_id: SESSION_ID, job_id: JOB_ID });
  assert.deepStrictEqual(obj.entities, []);
  assert.deepStrictEqual(obj.constraints, ['no-network', 'deterministic-only']);
  assert.ok(Array.isArray(obj.retrieval_terms) && obj.retrieval_terms.length > 0);
  assert.strictEqual(obj.confidence, 1);
  assert.ok(obj.provenance !== null && typeof obj.provenance === 'object');
});

objective('O03', 'Scope extracted correctly', () => {
  const result = hydrateContext(baseParams());
  const scope = result.context_package.objective.scope;
  assert.strictEqual(scope.session_id, SESSION_ID);
  assert.strictEqual(scope.job_id, JOB_ID);
  assert.deepStrictEqual(Object.keys(scope).sort(), ['job_id', 'session_id']);
});

objective('O04', 'Active constraints preserved', () => {
  const constraints = ['constraint-alpha', 'constraint-beta'];
  const result = hydrateContext(baseParams({ active_constraints: constraints }));
  assert.deepStrictEqual(result.context_package.objective.constraints, ['constraint-alpha', 'constraint-beta']);
});

objective('O05', 'Provenance preserved', () => {
  const checkpointRecord = {
    source_id: 'mand-checkpoint',
    source_type: 'mandatory',
    category: 'latest_valid_checkpoint',
    checkpoint_id: 'cp-accept-1',
  };
  const result = hydrateContext(baseParams({
    latest_checkpoint: { checkpoint_id: 'cp-accept-1' },
    mandatory: [checkpointRecord],
  }));
  const prov = result.context_package.objective.provenance;
  assert.strictEqual(prov.session_id, SESSION_ID);
  assert.strictEqual(prov.job_id, JOB_ID);
  assert.strictEqual(prov.objective_source, 'explicit_objective');
  assert.strictEqual(prov.checkpoint_id, 'cp-accept-1');
  assert.strictEqual(prov.policy_ref, 'context-hydration@1.0.1');
});

objective('O06', 'LOW confidence blocks automatic retrieval', () => {
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
  for (const sourceType of Object.keys(calls)) {
    assert.strictEqual(calls[sourceType], 0, `${sourceType} provider must not be invoked at LOW confidence`);
  }
  assert.strictEqual(pkg.retrieved.length, 0);
});

objective('O07', 'LOW confidence still loads mandatory context', () => {
  const mandatory = mandatoryRecords();
  const result = hydrateContext(baseParams({
    user_request: '',
    explicit_objective: undefined,
    active_constraints: [],
    mandatory,
  }));
  const pkg = result.context_package;
  assert.strictEqual(pkg.objective.confidence, 0);
  assert.deepStrictEqual(pkg.mandatory, mandatory);
  assert.strictEqual(pkg.retrieved.length, 0);
  assert.strictEqual(pkg.omitted.length, 0);
});

objective('O08', 'Ambiguity does not invent entities', () => {
  const result = hydrateContext(baseParams({
    user_request: 'Handle the thing with the stuff maybe',
    explicit_objective: undefined,
  }));
  assert.deepStrictEqual(result.context_package.objective.entities, []);
});

objective('O09', 'Identical input + policy produces identical objective', () => {
  const first = hydrateContext(baseParams());
  const second = hydrateContext(baseParams());
  assert.deepStrictEqual(first.context_package.objective, second.context_package.objective);
  const a = first.context_package.objective;
  const b = second.context_package.objective;
  assert.strictEqual(a.objective_id, b.objective_id);
  assert.strictEqual(a.confidence, b.confidence);
  assert.deepStrictEqual(a.provenance, b.provenance);
  assert.deepStrictEqual(a.retrieval_terms, b.retrieval_terms);
});

objective('O10', 'Explicit objective outranks inferred objective', () => {
  const result = hydrateContext(baseParams({
    user_request: 'Explain the legacy behavior of the unrelated module',
    explicit_objective: {
      summary: 'Implement the new acceptance suite',
      intent: 'IMPLEMENT',
      retrieval_terms: ['acceptance', 'suite'],
    },
  }));
  const obj = result.context_package.objective;
  assert.strictEqual(obj.summary, 'Implement the new acceptance suite');
  assert.strictEqual(obj.intent, 'IMPLEMENT');
  assert.deepStrictEqual(obj.retrieval_terms, ['acceptance', 'suite']);
});

// ---------------------------------------------------------------------------
// Hydration acceptance — H01-H17
// ---------------------------------------------------------------------------

hydration('H01', 'Mandatory context always loaded', () => {
  const mandatory = mandatoryRecords();
  const result = hydrateContext(baseParams({ mandatory }));
  assert.deepStrictEqual(result.context_package.mandatory, mandatory);
});

hydration('H02', 'Relevant curated item retrieved', () => {
  const { providers } = makeProviderEnv({ curated: [curatedCandidate({ source_id: 'curated-h02' })] });
  const result = hydrateContext(baseParams({ retrieval_providers: providers }));
  const pkg = result.context_package;
  assert.strictEqual(pkg.retrieved.length, 1);
  const record = pkg.retrieved[0];
  assert.strictEqual(record.source_id, 'curated-h02');
  for (const field of ['source_id', 'source_type', 'scope', 'score', 'rank', 'reason', 'provenance']) {
    assert.ok(Object.prototype.hasOwnProperty.call(record, field), `retrieved audit field ${field} required`);
  }
  assert.strictEqual(record.reason, 'retrieved');
  assert.strictEqual(record.rank, 1);
  assert.deepStrictEqual(record.provenance, { origin: 'acceptance-fixture' });
});

hydration('H03', 'Irrelevant item excluded', () => {
  const raw = rawCandidate({ source_id: 'raw-h03-1' });
  const rawRequest = { explicit: true, source_ids: ['raw-h03-1'] };
  const { providers, calls } = makeProviderEnv({ raw_source: [raw] });
  const result = hydrateContext(baseParams({ retrieval_providers: providers, raw_source_request: rawRequest }));
  const pkg = result.context_package;

  // P1: MEDIUM/HIGH confidence permits candidate retrieval (LOW is invalid for H03).
  assert.ok(pkg.objective.confidence >= 0.60, 'objective confidence must be MEDIUM/HIGH for H03');
  // P3: the raw provider MUST be invoked (fails H03 if it was not).
  assert.strictEqual(calls.raw_source, 1, 'raw provider MUST be invoked for the explicit request');
  // P8: the candidate MUST NOT appear in retrieved.
  assert.strictEqual(pkg.retrieved.length, 0, 'raw candidate must be absent from retrieved');
  assert.strictEqual(pkg.omitted.length, 0);

  // P4-P7: non-vacuous chain — adapter filter, eligibility pass, ranking rejection.
  const registry = createRetrievalRegistry({ raw_source: () => [raw] });
  const retrieval = retrieveCandidates(registry, {
    objective_confidence: pkg.objective.confidence,
    active_job_id: JOB_ID,
    active_session_id: SESSION_ID,
    hydration_started_at: HYDRATION_STARTED_AT,
    raw_source_request: rawRequest,
  });
  assert.deepStrictEqual(
    retrieval.candidates.map((candidate) => candidate.source_id),
    ['raw-h03-1'],
    'candidate MUST survive the explicit source-id adapter filter'
  );
  const eligibility = evaluateEligibility(retrieval.candidates, {
    active_job_id: JOB_ID,
    active_session_id: SESSION_ID,
    objective_confidence: pkg.objective.confidence,
    raw_source_request: rawRequest,
  });
  assert.strictEqual(eligibility.eligible.length, 1, 'candidate MUST pass eligibility');
  assert.strictEqual(eligibility.eligible[0].reason, 'ELIGIBLE_EXPLICIT_RAW');
  const ranking = rankCandidates({
    objective_retrieval_terms: pkg.objective.retrieval_terms,
    candidates: eligibility.eligible.map((decision) => decision.candidate),
    active_job_id: JOB_ID,
    active_session_id: SESSION_ID,
    hydration_started_at: HYDRATION_STARTED_AT,
  });
  assert.strictEqual(ranking.ranked.length, 0, 'candidate MUST reach ranking and be rejected there');
  assert.deepStrictEqual(ranking.rejected, [{ source_id: 'raw-h03-1', reason: 'unknown_authority' }]);
});

hydration('H04', 'Foreign-job knowledge hard rejected', () => {
  const { providers } = makeProviderEnv({
    curated: [
      curatedCandidate({ source_id: 'foreign-h04', job_id: 'job-foreign' }),
      curatedCandidate({ source_id: 'local-h04' }),
    ],
  });
  const result = hydrateContext(baseParams({ retrieval_providers: providers }));
  const pkg = result.context_package;
  assert.ok(!JSON.stringify(pkg).includes('foreign-h04'), 'foreign-job candidate must not receive final inclusion');
  assert.deepStrictEqual(pkg.retrieved.map((record) => record.source_id), ['local-h04']);
});

hydration('H05', 'Raw source not auto-injected', () => {
  const { providers, calls } = makeProviderEnv({ raw_source: [rawCandidate({ source_id: 'raw-h05-1' })] });
  const result = hydrateContext(baseParams({ retrieval_providers: providers }));
  assert.strictEqual(calls.raw_source, 0, 'raw provider must not be invoked without an explicit request');
  assert.ok(!JSON.stringify(result.context_package).includes('raw-h05-1'));
  assert.strictEqual(result.context_package.retrieved.length, 0);
});

hydration('H06', 'Semantic relevance dominates recency appropriately', () => {
  const oldRelevant = curatedCandidate({
    source_id: 'curated-h06-old-relevant',
    updated_at: '2026-01-01T00:00:00Z',
    retrieval_terms: ['context', 'hydration', 'pipeline'],
  });
  const freshIrrelevant = curatedCandidate({
    source_id: 'curated-h06-fresh-irrelevant',
    updated_at: '2026-09-26T23:59:00Z',
    retrieval_terms: ['unrelated'],
  });
  const { providers } = makeProviderEnv({ curated: [oldRelevant, freshIrrelevant] });
  const result = hydrateContext(baseParams({ retrieval_providers: providers }));
  const pkg = result.context_package;
  assert.strictEqual(pkg.retrieved.length, 2);
  assert.strictEqual(pkg.retrieved[0].source_id, 'curated-h06-old-relevant');
  assert.strictEqual(pkg.retrieved[0].score, 0.95);
  assert.strictEqual(pkg.retrieved[1].source_id, 'curated-h06-fresh-irrelevant');
  assert.strictEqual(pkg.retrieved[1].score, 0.5);
});

hydration('H07', 'Deterministic tie-breaking', () => {
  // (a) Full tie on earlier tiers: source_id ASC decides.
  const envA = makeProviderEnv({ curated: [curatedCandidate({ source_id: 'tie-b' }), curatedCandidate({ source_id: 'tie-a' })] });
  const resultA = hydrateContext(baseParams({ retrieval_providers: envA.providers }));
  assert.deepStrictEqual(resultA.context_package.retrieved.map((record) => record.source_id), ['tie-a', 'tie-b']);

  // (b) Equal total scores, different scope: scope_specificity DESC precedes source_id ASC.
  const scopeHigh = curatedCandidate({
    source_id: 'zz-scope-high',
    updated_at: '2026-09-26T12:00:00Z',
    retrieval_terms: ['alpha'],
  });
  const scopeLow = {
    source_id: 'aa-scope-low',
    scope: 'global',
    updated_at: '2026-09-26T12:00:00Z',
    retrieval_terms: ['alpha', 'beta'],
    estimated_tokens: 100,
    content: 'global candidate',
  };
  const envB = makeProviderEnv({ curated: [scopeHigh, scopeLow] });
  const resultB = hydrateContext(baseParams({
    retrieval_providers: envB.providers,
    explicit_objective: { summary: 'Tie-break scope fixture', retrieval_terms: ['alpha', 'beta', 'gamma', 'delta'] },
  }));
  const pkgB = resultB.context_package;
  assert.strictEqual(pkgB.retrieved.length, 2);
  assert.strictEqual(pkgB.retrieved[0].total_score, pkgB.retrieved[1].total_score, 'totals must tie for the scope tie-break proof');
  assert.strictEqual(pkgB.retrieved[0].source_id, 'zz-scope-high');
  assert.strictEqual(pkgB.retrieved[1].source_id, 'aa-scope-low');
});

hydration('H08', 'Latest checkpoint bypasses candidate ranking', () => {
  const checkpointRecord = {
    source_id: 'mand-checkpoint',
    source_type: 'mandatory',
    category: 'latest_valid_checkpoint',
    checkpoint_id: 'cp-h08',
    estimated_tokens: 999999,
    payload: { state: 'safe' },
  };
  const { providers } = makeProviderEnv({
    curated: [curatedCandidate({ source_id: 'curated-h08', estimated_tokens: 100 })],
  });
  const result = hydrateContext(baseParams({
    latest_checkpoint: { checkpoint_id: 'cp-h08' },
    mandatory: [checkpointRecord],
    retrieval_providers: providers,
  }));
  const pkg = result.context_package;

  assert.deepStrictEqual(pkg.mandatory, [checkpointRecord], 'checkpoint remains mandatory context, verbatim');
  assert.ok(!JSON.stringify(pkg.retrieved).includes('cp-h08'), 'checkpoint must not be converted into a retrieval candidate');
  assert.ok(!JSON.stringify(pkg.omitted).includes('cp-h08'), 'checkpoint must not appear in omitted metadata');
  assert.strictEqual(pkg.budget.retrieved_tokens_used, 100, 'checkpoint must not consume retrieval budget');
  assert.ok(!Object.prototype.hasOwnProperty.call(pkg.mandatory[0], 'rank'));
  assert.ok(!Object.prototype.hasOwnProperty.call(pkg.mandatory[0], 'score'));
});

hydration('H09', 'Context budget respected', () => {
  const { providers } = makeProviderEnv({
    curated: [
      curatedCandidate({ source_id: 'fit-a', estimated_tokens: 5000 }),
      curatedCandidate({ source_id: 'fit-c', retrieval_terms: [], estimated_tokens: 1000, content: 'small payload' }),
    ],
    reviewed_session_fact: [reviewedCandidate({ source_id: 'omit-b', estimated_tokens: 5000 })],
  });
  const result = hydrateContext(baseParams({ retrieval_providers: providers }));
  const pkg = result.context_package;

  assert.strictEqual(pkg.budget.retrieval_budget_tokens, 7000);
  assert.ok(pkg.budget.retrieved_tokens_used <= pkg.budget.retrieval_budget_tokens);
  assert.strictEqual(pkg.budget.retrieved_tokens_used, 6000);
  assert.deepStrictEqual(pkg.retrieved.map((record) => record.source_id), ['fit-a', 'fit-c']);
  assert.deepStrictEqual(pkg.omitted.map((record) => record.source_id), ['omit-b']);
  // Atomic candidates: no truncation — records remain intact.
  assert.strictEqual(pkg.retrieved[0].estimated_tokens, 5000);
  assert.strictEqual(pkg.retrieved[1].estimated_tokens, 1000);
});

hydration('H10', 'Mandatory context never silently dropped', () => {
  const mandatory = mandatoryRecords();
  const result = hydrateContext(baseParams({ mandatory }));
  assert.deepStrictEqual(result.context_package.mandatory, mandatory);

  let error = null;
  try {
    hydrateContext(baseParams({
      mandatory,
      budget_inputs: budgetInputs({ mandatory_context_tokens: 70000 }),
    }));
  } catch (e) {
    error = e;
  }
  assert.ok(error instanceof BudgetError, `expected BudgetError, got ${error && error.name}`);
  assert.strictEqual(error.code, 'CONTEXT_BUDGET_EXCEEDED');
});

hydration('H11', 'Duplicate knowledge deduplicated', () => {
  const dupNewer = curatedCandidate({ source_id: 'dup-h11', updated_at: '2026-09-26T00:00:00Z', content: 'newer duplicate' });
  const dupOlder = curatedCandidate({ source_id: 'dup-h11', updated_at: '2026-07-01T00:00:00Z', content: 'older duplicate' });
  const curatedPair = curatedCandidate({ source_id: 'pair-h11', updated_at: '2026-09-26T00:00:00Z', content: 'curated pair payload' });
  const reviewedPair = reviewedCandidate({ source_id: 'pair-h11', updated_at: '2026-09-26T00:00:00Z', content: 'reviewed pair payload' });
  const { providers } = makeProviderEnv({
    curated: [dupNewer, dupOlder, curatedPair],
    reviewed_session_fact: [reviewedPair],
  });
  const result = hydrateContext(baseParams({ retrieval_providers: providers }));
  const pkg = result.context_package;

  const duplicates = pkg.retrieved.filter((record) => record.source_id === 'dup-h11');
  assert.strictEqual(duplicates.length, 1, 'duplicate (source_type, source_id) must collapse to one final record');
  assert.strictEqual(duplicates[0].content, 'newer duplicate', 'first in ranked order wins');
  const pairs = pkg.retrieved.filter((record) => record.source_id === 'pair-h11');
  assert.strictEqual(pairs.length, 2, 'same source_id with different source_type is not a duplicate');
  assert.deepStrictEqual(pkg.mandatory, mandatoryRecords(), 'mandatory context remains exempt from candidate dedup');
});

hydration('H12', 'Empty retrieval produces valid ContextPackage', () => {
  const result = hydrateContext(baseParams({ retrieval_providers: {} }));
  const pkg = result.context_package;
  assert.deepStrictEqual(pkg.retrieved, []);
  assert.deepStrictEqual(pkg.omitted, []);
  assert.strictEqual(pkg.policy_id, 'context-hydration');
  assert.strictEqual(pkg.policy_version, '1.0.1');
  assert.strictEqual(pkg.hydration_run_id, RUN_ID);
  assert.strictEqual(pkg.job_id, JOB_ID);
  assert.strictEqual(pkg.session_id, SESSION_ID);
  assert.deepStrictEqual(pkg.mandatory, mandatoryRecords());
  assert.ok(pkg.budget !== null && typeof pkg.budget === 'object');
  assert.strictEqual(pkg.budget.retrieved_tokens_used, 0);
});

hydration('H13', 'Provenance preserved', () => {
  const provenance = { origin: 'acceptance-h13', ref: 'doc-13', chain: ['a', 'b'] };
  const { providers } = makeProviderEnv({ curated: [curatedCandidate({ source_id: 'curated-h13', provenance })] });
  const result = hydrateContext(baseParams({ retrieval_providers: providers }));
  assert.deepStrictEqual(result.context_package.retrieved[0].provenance, provenance);
});

hydration('H14', 'Omitted content not persisted', () => {
  const { providers } = makeProviderEnv({
    curated: [curatedCandidate({
      source_id: 'omit-h14',
      estimated_tokens: 9000,
      content: 'ordinary omitted content',
      body: 'ordinary body',
      text: 'ordinary text',
      nested: { payload: 'ordinary nested payload' },
    })],
  });
  const result = hydrateContext(baseParams({ retrieval_providers: providers }));
  const pkg = result.context_package;
  assert.strictEqual(pkg.omitted.length, 1);
  const omission = pkg.omitted[0];
  const allowed = [
    'source_id', 'source_type', 'scope', 'score', 'rank',
    'omission_reason', 'estimated_tokens', 'hydration_run_id', 'omitted_at', 'expires_at',
  ];
  assert.deepStrictEqual(Object.keys(omission).sort(), [...allowed].sort());
  const serialized = JSON.stringify(omission);
  assert.ok(!serialized.includes('ordinary omitted content'));
  assert.ok(!serialized.includes('ordinary body'));
  assert.ok(!serialized.includes('ordinary text'));
  assert.ok(!serialized.includes('ordinary nested payload'));
});

hydration('H15', 'Omitted metadata safely persisted', () => {
  const { providers } = makeProviderEnv({
    curated: [curatedCandidate({ source_id: 'omit-h15', estimated_tokens: 9000 })],
  });
  const store = createOmissionStore();
  const result = hydrateContext(baseParams({ retrieval_providers: providers, omission_store: store }));
  const pkg = result.context_package;
  assert.strictEqual(pkg.omitted.length, 1);
  const stored = store.list(HYDRATION_STARTED_AT);
  assert.strictEqual(stored.length, 1);
  assert.deepStrictEqual(stored[0], pkg.omitted[0]);
  assert.strictEqual(stored[0].omission_reason, 'retrieval_budget_exceeded');
});

hydration('H16', 'Retention policy applied', () => {
  const { providers } = makeProviderEnv({
    curated: [curatedCandidate({ source_id: 'omit-h16', estimated_tokens: 9000 })],
  });
  const store = createOmissionStore();
  hydrateContext(baseParams({ retrieval_providers: providers, omission_store: store }));

  const records = store.list(HYDRATION_STARTED_AT);
  assert.strictEqual(records.length, 1);
  const metadata = records[0];
  assert.strictEqual(metadata.omitted_at, HYDRATION_STARTED_AT);
  assert.strictEqual(metadata.expires_at, '2026-10-27T00:00:00.000Z');

  // retention_current_time < expires_at -> record available.
  const beforeStore = createOmissionStore({ records: [metadata] });
  assert.strictEqual(beforeStore.list('2026-10-26T23:59:59Z').length, 1);

  // retention_current_time == expires_at -> expired, not returned.
  const atStore = createOmissionStore({ records: [metadata] });
  assert.strictEqual(atStore.list('2026-10-27T00:00:00Z').length, 0);

  // Initialization cleanup: expired records purged on store initialization.
  const initStore = createOmissionStore({ records: [metadata], initialization_time: '2026-10-27T00:00:00Z' });
  assert.strictEqual(initStore.list('2026-10-27T00:00:00Z').length, 0);
});

hydration('H17', 'Identical inputs/scope/policy produce identical ordering', () => {
  const build = () => hydrateContext(baseParams({
    retrieval_providers: makeProviderEnv({
      curated: [curatedCandidate({ source_id: 'ord-1' })],
      reviewed_session_fact: [reviewedCandidate({ source_id: 'ord-2' })],
      semantic_memory: [semanticCandidate({ source_id: 'ord-3' })],
    }).providers,
  }));
  const first = build();
  const second = build();
  assert.deepStrictEqual(first.context_package.retrieved, second.context_package.retrieved);
  assert.strictEqual(JSON.stringify(first.context_package.retrieved), JSON.stringify(second.context_package.retrieved));
  assert.deepStrictEqual(first.context_package.retrieved.map((record) => record.rank), [1, 2, 3]);
  assert.deepStrictEqual(
    first.context_package.retrieved.map((record) => record.score),
    second.context_package.retrieved.map((record) => record.score)
  );
});

// ---------------------------------------------------------------------------
// Skill acceptance — S01-S10
// ---------------------------------------------------------------------------

skill('S01', 'One matching skill', () => {
  const result = hydrateContext(baseParams({ skills: [skillRecord('skill-one', 'PRIMARY', 'UNDERSTAND')] }));
  assert.strictEqual(result.skill_chain.count, 1);
  assert.strictEqual(result.skill_chain.ordered.length, 1);
  assert.strictEqual(result.skill_chain.ordered[0].skill_id, 'skill-one');
});

skill('S02', 'Two compatible skills', () => {
  const result = hydrateContext(baseParams({ skills: [
    skillRecord('skill-b', 'SUPPORTING', 'DESIGN/PLAN'),
    skillRecord('skill-a', 'PRIMARY', 'UNDERSTAND'),
  ] }));
  assert.strictEqual(result.skill_chain.count, 2);
  assert.deepStrictEqual(result.skill_chain.ordered.map((record) => record.skill_id), ['skill-a', 'skill-b']);
});

skill('S03', 'Three compatible skills allowed by default', () => {
  const result = hydrateContext(baseParams({ skills: [
    skillRecord('s3-a', 'PRIMARY', 'UNDERSTAND'),
    skillRecord('s3-b', 'SUPPORTING', 'DESIGN/PLAN'),
    skillRecord('s3-c', 'PRIMARY', 'EXECUTE'),
  ] }));
  assert.strictEqual(result.skill_chain.count, 3);
  assert.strictEqual(result.skill_chain.override_applied, false);
});

skill('S04', 'Four skills require explicit override', () => {
  let error = null;
  try {
    hydrateContext(baseParams({ skills: [
      skillRecord('s4-a', 'PRIMARY', 'UNDERSTAND'),
      skillRecord('s4-b', 'SUPPORTING', 'DESIGN/PLAN'),
      skillRecord('s4-c', 'PRIMARY', 'EXECUTE'),
      skillRecord('s4-d', 'SUPPORTING', 'VALIDATE'),
    ] }));
  } catch (e) {
    error = e;
  }
  assert.ok(error instanceof SkillResolverError, `expected SkillResolverError, got ${error && error.name}`);
  assert.strictEqual(error.code, 'SKILL_CHAIN_REQUIRES_OVERRIDE');
});

skill('S05', 'Five skills allowed only with override', () => {
  const five = [
    skillRecord('s5-a', 'PRIMARY', 'UNDERSTAND'),
    skillRecord('s5-b', 'SUPPORTING', 'DESIGN/PLAN'),
    skillRecord('s5-c', 'PRIMARY', 'EXECUTE'),
    skillRecord('s5-d', 'SUPPORTING', 'VALIDATE'),
    skillRecord('s5-e', 'PRIMARY', 'EXECUTE'),
  ];
  const result = hydrateContext(baseParams({ skills: five, explicit_skill_override: true }));
  assert.strictEqual(result.skill_chain.count, 5);
  assert.strictEqual(result.skill_chain.override_applied, true);

  let error = null;
  try {
    hydrateContext(baseParams({ skills: five }));
  } catch (e) {
    error = e;
  }
  assert.ok(error instanceof SkillResolverError);
  assert.strictEqual(error.code, 'SKILL_CHAIN_REQUIRES_OVERRIDE');
});

skill('S06', 'Six skills rejected', () => {
  const six = [
    skillRecord('s6-a', 'PRIMARY', 'UNDERSTAND'),
    skillRecord('s6-b', 'SUPPORTING', 'DESIGN/PLAN'),
    skillRecord('s6-c', 'PRIMARY', 'EXECUTE'),
    skillRecord('s6-d', 'SUPPORTING', 'VALIDATE'),
    skillRecord('s6-e', 'PRIMARY', 'EXECUTE'),
    skillRecord('s6-f', 'SUPPORTING', 'VALIDATE'),
  ];
  let errorWithOverride = null;
  let errorWithoutOverride = null;
  try {
    hydrateContext(baseParams({ skills: six, explicit_skill_override: true }));
  } catch (e) {
    errorWithOverride = e;
  }
  try {
    hydrateContext(baseParams({ skills: six }));
  } catch (e) {
    errorWithoutOverride = e;
  }
  assert.ok(errorWithOverride instanceof SkillResolverError);
  assert.strictEqual(errorWithOverride.code, 'SKILL_CHAIN_LIMIT_EXCEEDED');
  assert.ok(errorWithoutOverride instanceof SkillResolverError);
  assert.strictEqual(errorWithoutOverride.code, 'SKILL_CHAIN_LIMIT_EXCEEDED');
});

skill('S07', 'Chain never silently truncated', () => {
  const six = [
    skillRecord('s7-a', 'PRIMARY', 'UNDERSTAND'),
    skillRecord('s7-b', 'SUPPORTING', 'DESIGN/PLAN'),
    skillRecord('s7-c', 'PRIMARY', 'EXECUTE'),
    skillRecord('s7-d', 'SUPPORTING', 'VALIDATE'),
    skillRecord('s7-e', 'PRIMARY', 'EXECUTE'),
    skillRecord('s7-f', 'SUPPORTING', 'VALIDATE'),
  ];
  let error = null;
  try {
    hydrateContext(baseParams({ skills: six, explicit_skill_override: true }));
  } catch (e) {
    error = e;
  }
  assert.ok(error instanceof SkillResolverError, 'over-limit chain must fail, not truncate');
  assert.strictEqual(error.code, 'SKILL_CHAIN_LIMIT_EXCEEDED');
  assert.ok(/exceed the hard maximum/.test(String(error.message)), 'failure must be the hard-limit rejection');
});

skill('S08', 'Conflicting skills fail closed', () => {
  let errorTwo = null;
  try {
    hydrateContext(baseParams({ skills: [
      skillRecord('s8-a', 'PRIMARY', 'UNDERSTAND'),
      skillRecord('s8-x', 'CONFLICTING', 'EXECUTE'),
    ] }));
  } catch (e) {
    errorTwo = e;
  }
  assert.ok(errorTwo instanceof SkillResolverError);
  assert.strictEqual(errorTwo.code, 'SKILL_CONFLICT');

  // Conflict precedes chain-limit decisions: 6 skills including a conflict -> still SKILL_CONFLICT.
  let errorSix = null;
  try {
    hydrateContext(baseParams({ skills: [
      skillRecord('s8-a', 'PRIMARY', 'UNDERSTAND'),
      skillRecord('s8-b', 'SUPPORTING', 'DESIGN/PLAN'),
      skillRecord('s8-c', 'PRIMARY', 'EXECUTE'),
      skillRecord('s8-d', 'SUPPORTING', 'VALIDATE'),
      skillRecord('s8-e', 'PRIMARY', 'EXECUTE'),
      skillRecord('s8-x', 'CONFLICTING', 'EXECUTE'),
    ] }));
  } catch (e) {
    errorSix = e;
  }
  assert.ok(errorSix instanceof SkillResolverError);
  assert.strictEqual(errorSix.code, 'SKILL_CONFLICT');
});

skill('S09', 'Explicit user skill retained', () => {
  const result = hydrateContext(baseParams({ skills: [
    { skill_id: 's-dup', class: 'PRIMARY', phase: 'UNDERSTAND', explicit: false },
    { skill_id: 's-dup', class: 'PRIMARY', phase: 'UNDERSTAND', explicit: true },
  ] }));
  assert.strictEqual(result.skill_chain.count, 1);
  assert.strictEqual(result.skill_chain.ordered.length, 1);
  assert.strictEqual(result.skill_chain.ordered[0].skill_id, 's-dup');
  assert.strictEqual(result.skill_chain.ordered[0].explicit, true, 'logical-OR explicit retention through deduplication');
});

skill('S10', 'Skill cannot override runtime policy', () => {
  let error = null;
  try {
    hydrateContext(baseParams({
      skills: [skillRecord('s10-a', 'PRIMARY', 'UNDERSTAND')],
      skill_override_request: { runtime_policy: true },
    }));
  } catch (e) {
    error = e;
  }
  assert.ok(error instanceof SkillResolverError);
  assert.strictEqual(error.code, 'SKILL_OVERRIDE_FORBIDDEN');
});

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

function main() {
  console.log('=== Phase 9A Context Hydration Acceptance ===');
  let totalPassed = 0;
  let totalFailed = 0;
  let canonicalOk = true;

  for (const category of categories) {
    console.log('');
    console.log(`${category.name}:`);
    let categoryPassed = 0;
    const executedIds = [];
    for (const testCase of category.cases) {
      executedIds.push(testCase.id);
      let status = 'PASS';
      try {
        testCase.fn();
      } catch (e) {
        status = `FAIL — ${e.message}`;
      }
      if (status === 'PASS') {
        categoryPassed += 1;
        totalPassed += 1;
      } else {
        totalFailed += 1;
      }
      console.log(`${testCase.id} ${status}`);
    }
    category.passed = categoryPassed;
    if (executedIds.length !== category.canonical.length) canonicalOk = false;
    for (let i = 0; i < category.canonical.length && i < executedIds.length; i += 1) {
      if (executedIds[i] !== category.canonical[i]) {
        canonicalOk = false;
        break;
      }
    }
  }

  if (!canonicalOk) {
    console.log('');
    console.log('CANONICAL_ID_MISMATCH — acceptance IDs must be exactly O01-O10, H01-H17, S01-S10');
  }

  console.log('');
  console.log('=== Acceptance Summary ===');
  console.log(`Objective:  ${categories[0].passed} / ${categories[0].expected}`);
  console.log(`Hydration:  ${categories[1].passed} / ${categories[1].expected}`);
  console.log(`Skills:     ${categories[2].passed} / ${categories[2].expected}`);
  console.log(`Total:      ${totalPassed} / 37`);
  console.log(`Failed:     ${totalFailed}`);

  const ok = canonicalOk && totalPassed === 37 && totalFailed === 0;
  process.exit(ok ? 0 : 1);
}

main();
