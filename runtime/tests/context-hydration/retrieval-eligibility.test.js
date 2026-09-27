'use strict';

/**
 * Context Hydration v1 — Retrieval + Eligibility lane test (9A-04 / Issue #11)
 *
 * Policy: context-hydration@1.0.1
 *
 * Deterministic lane test for retrieval adapters and eligibility gates.
 * No network. No DB. No filesystem writes. No env/profile reads.
 * All providers are injected in-memory fakes owned by this test.
 */

const assert = require('assert');

const {
  ACCESS_MODES,
  SKIP_REASONS,
  createRetrievalAdapter,
  createRetrievalRegistry,
  retrieveCandidates,
} = require('../../context-hydration/retrieval-adapters.js');

const {
  CONFIDENCE_LEVELS,
  CANDIDATE_SOURCE_TYPES,
  REASONS,
  classifyConfidence,
  evaluateCandidate,
  evaluateEligibility,
} = require('../../context-hydration/eligibility-gates.js');

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

/** Recursively freeze fixture data so any mutation attempt throws. */
function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const key of Object.keys(value)) {
      deepFreeze(value[key]);
    }
    Object.freeze(value);
  }
  return value;
}

function context(overrides) {
  return deepFreeze({
    active_job_id: 'job-a',
    active_session_id: 'sess-a',
    objective_confidence: 0.9,
    raw_source_request: null,
    ...overrides,
  });
}

function candidate(overrides) {
  return deepFreeze({
    source_id: 'src-1',
    source_type: 'curated',
    job_id: 'job-a',
    session_id: 'sess-a',
    scope: 'job',
    retrieval_terms: ['alpha', 'beta'],
    updated_at: '2026-09-20T00:00:00Z',
    provenance: { origin: 'lane-c-test' },
    ...overrides,
  });
}

function spyProvider(items) {
  const calls = [];
  const provider = (request) => {
    calls.push(request);
    return items;
  };
  provider.calls = calls;
  return provider;
}

function totalCalls(...spies) {
  return spies.reduce((sum, spy) => sum + spy.calls.length, 0);
}

// ---------------------------------------------------------------------------
// Adapter model
// ---------------------------------------------------------------------------

test('T01 registry exposes exactly five candidate source types in deterministic order', () => {
  const registry = createRetrievalRegistry({});
  assert.deepStrictEqual(
    registry.source_types,
    ['curated', 'reviewed_session_fact', 'historical_checkpoint', 'semantic_memory', 'raw_source']
  );
  assert.strictEqual(registry.source_types.length, 5);
  assert.ok(!registry.source_types.includes('mandatory_context'));
});

test('T02 non-candidate source types can never get an adapter', () => {
  assert.throws(() => createRetrievalAdapter('mandatory_context', () => []), /Not a candidate source type/);
  assert.throws(() => createRetrievalAdapter('unknown_source', () => []), /Not a candidate source type/);
});

test('T03 registry rejects unknown provider keys and adapter lookup fails closed', () => {
  assert.throws(() => createRetrievalRegistry({ mandatory_context: () => [] }), /Not a candidate source type/);
  const registry = createRetrievalRegistry({});
  assert.throws(() => registry.adapterFor('mandatory_context'), /Not a candidate source type/);
  assert.throws(() => registry.adapterFor('unknown_source'), /Not a candidate source type/);
});

test('T04 curated adapter retrieves from injected provider and stamps source_type', () => {
  const provider = spyProvider([candidate({ source_id: 'cur-1' })]);
  const adapter = createRetrievalAdapter('curated', provider);
  assert.strictEqual(adapter.access, ACCESS_MODES.AUTOMATIC);
  const result = adapter.retrieve(context({}));
  assert.strictEqual(result.invoked, true);
  assert.strictEqual(result.unavailable, false);
  assert.strictEqual(result.candidates.length, 1);
  assert.strictEqual(result.candidates[0].source_id, 'cur-1');
  assert.strictEqual(result.candidates[0].source_type, 'curated');
  assert.strictEqual(provider.calls.length, 1);
});

test('T05 reviewed_session_fact adapter stamps its own source identity', () => {
  const provider = spyProvider([candidate({ source_id: 'rev-1', source_type: 'curated' })]);
  const adapter = createRetrievalAdapter('reviewed_session_fact', provider);
  const result = adapter.retrieve(context({}));
  assert.strictEqual(result.invoked, true);
  assert.strictEqual(result.access, ACCESS_MODES.AUTOMATIC);
  assert.strictEqual(result.candidates[0].source_type, 'reviewed_session_fact');
});

test('T06 historical_checkpoint adapter retrieves and stamps source_type', () => {
  const provider = spyProvider([candidate({ source_id: 'hist-1' })]);
  const adapter = createRetrievalAdapter('historical_checkpoint', provider);
  const result = adapter.retrieve(context({}));
  assert.strictEqual(result.invoked, true);
  assert.strictEqual(result.candidates[0].source_id, 'hist-1');
  assert.strictEqual(result.candidates[0].source_type, 'historical_checkpoint');
});

test('T07 semantic_memory adapter access mode is advisory', () => {
  const provider = spyProvider([candidate({ source_id: 'sem-1', source_type: 'semantic_memory' })]);
  const adapter = createRetrievalAdapter('semantic_memory', provider);
  assert.strictEqual(adapter.access, ACCESS_MODES.ADVISORY);
  const result = adapter.retrieve(context({}));
  assert.strictEqual(result.invoked, true);
  assert.strictEqual(result.candidates[0].source_type, 'semantic_memory');
});

test('T08 raw adapter never invoked without explicit request', () => {
  const provider = spyProvider([candidate({ source_id: 'raw-1', source_type: 'raw_source' })]);
  const adapter = createRetrievalAdapter('raw_source', provider);
  assert.strictEqual(adapter.access, ACCESS_MODES.EXPLICIT);

  const noRequest = adapter.retrieve(context({ raw_source_request: null }));
  assert.strictEqual(noRequest.invoked, false);
  assert.strictEqual(noRequest.skipped_reason, SKIP_REASONS.EXPLICIT_REQUIRED);
  assert.deepStrictEqual(noRequest.candidates, []);

  const nonExplicit = adapter.retrieve(context({ raw_source_request: { explicit: false, source_ids: ['raw-1'] } }));
  assert.strictEqual(nonExplicit.invoked, false);

  const emptyIds = adapter.retrieve(context({ raw_source_request: { explicit: true, source_ids: [] } }));
  assert.strictEqual(emptyIds.invoked, false);

  assert.strictEqual(provider.calls.length, 0);
});

test('T09 raw adapter invoked with explicit request naming source ids', () => {
  const provider = spyProvider([candidate({ source_id: 'raw-1', source_type: 'raw_source' })]);
  const adapter = createRetrievalAdapter('raw_source', provider);
  const result = adapter.retrieve(context({ raw_source_request: { explicit: true, source_ids: ['raw-1'] } }));
  assert.strictEqual(result.invoked, true);
  assert.strictEqual(provider.calls.length, 1);
  assert.strictEqual(result.candidates[0].source_type, 'raw_source');
});

test('T10 provider contract violations fail closed', () => {
  const bad = createRetrievalAdapter('curated', () => 'not-an-array');
  assert.throws(() => bad.retrieve(context({})), /must return an array/);
  assert.throws(() => createRetrievalAdapter('curated', 'not-a-function'), /must be a function/);
});

test('T11 missing provider yields unavailable adapter without throwing', () => {
  const adapter = createRetrievalAdapter('curated', null);
  const result = adapter.retrieve(context({}));
  assert.strictEqual(result.invoked, false);
  assert.strictEqual(result.unavailable, true);
  assert.deepStrictEqual(result.candidates, []);

  const registry = createRetrievalRegistry({});
  const out = retrieveCandidates(registry, context({}));
  assert.deepStrictEqual(out.candidates, []);
  assert.ok(out.results.every((r) => r.unavailable === true && r.invoked === false));
});

test('T12 provider receives the caller-supplied context unchanged', () => {
  const provider = spyProvider([]);
  const adapter = createRetrievalAdapter('curated', provider);
  const ctx = context({ active_job_id: 'job-x' });
  adapter.retrieve(ctx);
  assert.strictEqual(provider.calls.length, 1);
  assert.strictEqual(provider.calls[0], ctx);
});

test('T13 adapter output does not mutate provider-returned candidates', () => {
  const item = candidate({ source_id: 'imm-1' });
  const snapshot = JSON.stringify(item);
  const adapter = createRetrievalAdapter('curated', () => [item]);
  const result = adapter.retrieve(context({}));
  assert.strictEqual(JSON.stringify(item), snapshot);
  assert.notStrictEqual(result.candidates[0], item);
  assert.strictEqual(result.candidates[0].source_id, 'imm-1');
  assert.strictEqual(result.candidates[0].source_type, 'curated');
});

// ---------------------------------------------------------------------------
// Retrieval confidence gate
// ---------------------------------------------------------------------------

test('T14 LOW confidence disables all automatic retrieval — no provider invoked', () => {
  const curated = spyProvider([candidate()]);
  const reviewed = spyProvider([candidate({ source_type: 'reviewed_session_fact' })]);
  const historical = spyProvider([candidate({ source_type: 'historical_checkpoint' })]);
  const semantic = spyProvider([candidate({ source_type: 'semantic_memory' })]);
  const raw = spyProvider([candidate({ source_type: 'raw_source' })]);
  const registry = createRetrievalRegistry({
    curated,
    reviewed_session_fact: reviewed,
    historical_checkpoint: historical,
    semantic_memory: semantic,
    raw_source: raw,
  });

  const out = retrieveCandidates(
    registry,
    context({ objective_confidence: 0.59, raw_source_request: { explicit: true, source_ids: ['src-1'] } })
  );

  assert.strictEqual(out.confidence_level, CONFIDENCE_LEVELS.LOW);
  assert.strictEqual(out.automatic_retrieval_enabled, false);
  assert.deepStrictEqual(out.candidates, []);
  assert.strictEqual(totalCalls(curated, reviewed, historical, semantic, raw), 0);
  assert.ok(out.results.every((r) => r.invoked === false && r.skipped_reason === SKIP_REASONS.LOW_CONFIDENCE));
});

test('T15 MEDIUM confidence enables automatic retrieval; raw stays explicit-only', () => {
  const curated = spyProvider([candidate({ source_id: 'cur-1' })]);
  const semantic = spyProvider([candidate({ source_id: 'sem-1', source_type: 'semantic_memory' })]);
  const raw = spyProvider([candidate({ source_id: 'raw-1', source_type: 'raw_source' })]);
  const registry = createRetrievalRegistry({ curated, semantic_memory: semantic, raw_source: raw });

  const out = retrieveCandidates(registry, context({ objective_confidence: 0.60 }));
  assert.strictEqual(out.confidence_level, CONFIDENCE_LEVELS.MEDIUM);
  assert.strictEqual(out.automatic_retrieval_enabled, true);
  assert.strictEqual(curated.calls.length, 1);
  assert.strictEqual(semantic.calls.length, 1);
  assert.strictEqual(raw.calls.length, 0);
  assert.deepStrictEqual(out.candidates.map((c) => c.source_id), ['cur-1', 'sem-1']);

  const out2 = retrieveCandidates(
    registry,
    context({ objective_confidence: 0.60, raw_source_request: { explicit: true, source_ids: ['raw-1'] } })
  );
  assert.strictEqual(raw.calls.length, 1);
  assert.deepStrictEqual(out2.candidates.map((c) => c.source_id), ['cur-1', 'sem-1', 'raw-1']);
});

test('T16 HIGH confidence enables automatic retrieval', () => {
  const curated = spyProvider([candidate({ source_id: 'cur-1' })]);
  const registry = createRetrievalRegistry({ curated });
  const out = retrieveCandidates(registry, context({ objective_confidence: 0.80 }));
  assert.strictEqual(out.confidence_level, CONFIDENCE_LEVELS.HIGH);
  assert.strictEqual(out.automatic_retrieval_enabled, true);
  assert.deepStrictEqual(out.candidates.map((c) => c.source_id), ['cur-1']);
});

test('T17 candidate access order is deterministic and source-ordered', () => {
  const registry = createRetrievalRegistry({
    curated: spyProvider([candidate({ source_id: 'cur-1' }), candidate({ source_id: 'cur-2' })]),
    reviewed_session_fact: spyProvider([candidate({ source_id: 'rev-1', source_type: 'reviewed_session_fact' })]),
    historical_checkpoint: spyProvider([candidate({ source_id: 'hist-1', source_type: 'historical_checkpoint' })]),
    semantic_memory: spyProvider([candidate({ source_id: 'sem-1', source_type: 'semantic_memory' })]),
    raw_source: spyProvider([candidate({ source_id: 'raw-1', source_type: 'raw_source' })]),
  });
  const out = retrieveCandidates(registry, context({ raw_source_request: { explicit: true, source_ids: ['raw-1'] } }));
  assert.deepStrictEqual(out.results.map((r) => r.source_type), CANDIDATE_SOURCE_TYPES);
  assert.deepStrictEqual(
    out.candidates.map((c) => c.source_id),
    ['cur-1', 'cur-2', 'rev-1', 'hist-1', 'sem-1', 'raw-1']
  );
});

// ---------------------------------------------------------------------------
// Eligibility gates
// ---------------------------------------------------------------------------

test('T18 curated candidate is eligible at HIGH confidence', () => {
  const out = evaluateEligibility([candidate({ source_id: 'cur-1' })], context({}));
  assert.strictEqual(out.confidence.level, CONFIDENCE_LEVELS.HIGH);
  assert.strictEqual(out.eligible.length, 1);
  assert.strictEqual(out.rejected.length, 0);
  assert.strictEqual(out.eligible[0].reason, REASONS.ELIGIBLE);
  assert.strictEqual(out.eligible[0].advisory, false);
});

test('T19 reviewed session fact is eligible at MEDIUM confidence', () => {
  const out = evaluateEligibility(
    [candidate({ source_id: 'rev-1', source_type: 'reviewed_session_fact' })],
    context({ objective_confidence: 0.60 })
  );
  assert.strictEqual(out.eligible.length, 1);
  assert.strictEqual(out.eligible[0].reason, REASONS.ELIGIBLE);
});

test('T20 historical checkpoint is eligible at HIGH confidence', () => {
  const out = evaluateEligibility(
    [candidate({ source_id: 'hist-1', source_type: 'historical_checkpoint' })],
    context({})
  );
  assert.strictEqual(out.eligible.length, 1);
  assert.strictEqual(out.eligible[0].reason, REASONS.ELIGIBLE);
});

test('T21 semantic memory remains advisory, never authoritative', () => {
  const out = evaluateEligibility(
    [candidate({ source_id: 'sem-1', source_type: 'semantic_memory' })],
    context({ objective_confidence: 0.75 })
  );
  assert.strictEqual(out.eligible.length, 1);
  assert.strictEqual(out.eligible[0].advisory, true);
  assert.strictEqual(out.eligible[0].reason, REASONS.ELIGIBLE_ADVISORY);

  const automatic = evaluateEligibility([candidate({ source_id: 'cur-1' })], context({ objective_confidence: 0.75 }));
  assert.strictEqual(automatic.eligible[0].advisory, false);
});

test('T22 raw source without explicit request is rejected', () => {
  const out = evaluateEligibility(
    [candidate({ source_id: 'raw-1', source_type: 'raw_source' })],
    context({})
  );
  assert.strictEqual(out.eligible.length, 0);
  assert.strictEqual(out.rejected.length, 1);
  assert.strictEqual(out.rejected[0].reason, REASONS.RAW_SOURCE_EXPLICIT_ONLY);
});

test('T23 raw source with explicit matching request is eligible', () => {
  const out = evaluateEligibility(
    [candidate({ source_id: 'raw-1', source_type: 'raw_source' })],
    context({ raw_source_request: { explicit: true, source_ids: ['raw-1'] } })
  );
  assert.strictEqual(out.eligible.length, 1);
  assert.strictEqual(out.eligible[0].reason, REASONS.ELIGIBLE_EXPLICIT_RAW);
  assert.strictEqual(out.eligible[0].advisory, false);
});

test('T24 raw source with explicit request for a different id is rejected', () => {
  const out = evaluateEligibility(
    [candidate({ source_id: 'raw-1', source_type: 'raw_source' })],
    context({ raw_source_request: { explicit: true, source_ids: ['raw-2'] } })
  );
  assert.strictEqual(out.eligible.length, 0);
  assert.strictEqual(out.rejected[0].reason, REASONS.RAW_SOURCE_EXPLICIT_ONLY);
});

test('T25 foreign-job candidate is hard rejected', () => {
  const out = evaluateEligibility(
    [candidate({ source_id: 'foreign-1', job_id: 'job-b' })],
    context({})
  );
  assert.strictEqual(out.eligible.length, 0);
  assert.strictEqual(out.rejected[0].reason, REASONS.FOREIGN_JOB_HARD_REJECT);
});

test('T26 same-session candidate with conflicting job_id is still hard rejected', () => {
  const out = evaluateEligibility(
    [candidate({ source_id: 'x-1', job_id: 'job-b', session_id: 'sess-a' })],
    context({})
  );
  assert.strictEqual(out.eligible.length, 0);
  assert.strictEqual(out.rejected[0].reason, REASONS.FOREIGN_JOB_HARD_REJECT);
});

test('T27 global candidate (scope=global, no job_id) remains eligible', () => {
  const nullJob = evaluateEligibility(
    [candidate({ source_id: 'glob-1', scope: 'global', job_id: null })],
    context({})
  );
  assert.strictEqual(nullJob.eligible.length, 1);
  assert.strictEqual(nullJob.eligible[0].reason, REASONS.ELIGIBLE);

  const absentJob = evaluateEligibility(
    [candidate({ source_id: 'glob-2', scope: 'global', job_id: undefined })],
    context({})
  );
  assert.strictEqual(absentJob.eligible.length, 1);
});

test('T28 same-job and same-session candidates are eligible', () => {
  const sameJob = evaluateEligibility([candidate({ source_id: 'sj-1', job_id: 'job-a' })], context({}));
  assert.strictEqual(sameJob.eligible.length, 1);

  const sameSession = evaluateEligibility(
    [candidate({ source_id: 'ss-1', job_id: null, scope: 'session', session_id: 'sess-a' })],
    context({})
  );
  assert.strictEqual(sameSession.eligible.length, 1);
});

test('T29 LOW confidence yields mandatory-only behavior for all candidates', () => {
  const out = evaluateEligibility(
    [
      candidate({ source_id: 'cur-1' }),
      candidate({ source_id: 'sem-1', source_type: 'semantic_memory' }),
      candidate({ source_id: 'raw-1', source_type: 'raw_source' }),
    ],
    context({ objective_confidence: 0.59, raw_source_request: { explicit: true, source_ids: ['raw-1'] } })
  );
  assert.strictEqual(out.confidence.level, CONFIDENCE_LEVELS.LOW);
  assert.strictEqual(out.confidence.automatic_retrieval_enabled, false);
  assert.strictEqual(out.eligible.length, 0);
  assert.strictEqual(out.rejected.length, 3);
  assert.ok(out.rejected.every((d) => d.reason === REASONS.LOW_CONFIDENCE_MANDATORY_ONLY));
});

test('T30 foreign-job hard reject is not softened by LOW confidence', () => {
  // Contract section 8.3 evaluation order: foreign-job reject precedes the
  // confidence gate, so the hard-reject reason is preserved at LOW.
  const out = evaluateEligibility(
    [candidate({ source_id: 'foreign-1', job_id: 'job-b' })],
    context({ objective_confidence: 0.1 })
  );
  assert.strictEqual(out.eligible.length, 0);
  assert.strictEqual(out.rejected[0].reason, REASONS.FOREIGN_JOB_HARD_REJECT);
});

test('T31 invalid candidates fail closed — never silently eligible', () => {
  const cases = [
    { value: null, reason: REASONS.INVALID_CANDIDATE },
    { value: undefined, reason: REASONS.INVALID_CANDIDATE },
    { value: 42, reason: REASONS.INVALID_CANDIDATE },
    { value: 'candidate', reason: REASONS.INVALID_CANDIDATE },
    { value: [], reason: REASONS.INVALID_CANDIDATE },
    { value: {}, reason: REASONS.INVALID_CANDIDATE },
    { value: { source_id: '' }, reason: REASONS.INVALID_CANDIDATE },
    { value: candidate({ source_type: 'mandatory_context' }), reason: REASONS.UNKNOWN_SOURCE_TYPE },
    { value: candidate({ source_type: 'totally_unknown' }), reason: REASONS.UNKNOWN_SOURCE_TYPE },
  ];
  const out = evaluateEligibility(cases.map((c) => c.value), context({}));
  assert.strictEqual(out.eligible.length, 0);
  assert.strictEqual(out.rejected.length, cases.length);
  cases.forEach((c, i) => {
    assert.strictEqual(out.decisions[i].reason, c.reason, `case ${i} reason mismatch`);
    assert.strictEqual(out.decisions[i].eligible, false);
  });
});

test('T32 mandatory context cannot be converted into candidate retrieval', () => {
  const registry = createRetrievalRegistry({});
  assert.throws(() => registry.adapterFor('mandatory_context'), /Not a candidate source type/);
  const out = evaluateEligibility(
    [candidate({ source_id: 'mand-1', source_type: 'mandatory_context' })],
    context({})
  );
  assert.strictEqual(out.eligible.length, 0);
  assert.strictEqual(out.rejected[0].reason, REASONS.UNKNOWN_SOURCE_TYPE);
});

// ---------------------------------------------------------------------------
// Immutability + determinism + boundaries
// ---------------------------------------------------------------------------

test('T33 eligibility evaluation never mutates candidate or context inputs', () => {
  const candidates = [
    candidate({ source_id: 'a-1' }),
    candidate({ source_id: 'b-1', source_type: 'semantic_memory', job_id: null, scope: 'global' }),
    candidate({ source_id: 'c-1', source_type: 'raw_source' }),
  ];
  const ctx = context({ raw_source_request: { explicit: true, source_ids: ['c-1'] } });
  const candidatesBefore = JSON.stringify(candidates);
  const ctxBefore = JSON.stringify(ctx);

  const out = evaluateEligibility(candidates, ctx);

  assert.strictEqual(JSON.stringify(candidates), candidatesBefore);
  assert.strictEqual(JSON.stringify(ctx), ctxBefore);
  assert.strictEqual(out.eligible.length, 3);
});

test('T34 retrieval never mutates provider-returned records or context', () => {
  const items = [candidate({ source_id: 'cur-1' })];
  const ctx = context({});
  const itemsBefore = JSON.stringify(items);
  const ctxBefore = JSON.stringify(ctx);

  const registry = createRetrievalRegistry({ curated: () => items });
  const out = retrieveCandidates(registry, ctx);

  assert.strictEqual(JSON.stringify(items), itemsBefore);
  assert.strictEqual(JSON.stringify(ctx), ctxBefore);
  assert.strictEqual(out.candidates.length, 1);
});

test('T35 identical inputs produce identical outputs across runs', () => {
  const buildCandidates = () => [
    candidate({ source_id: 'a-1' }),
    candidate({ source_id: 'b-1', source_type: 'semantic_memory' }),
    candidate({ source_id: 'c-1', source_type: 'raw_source' }),
    candidate({ source_id: 'd-1', job_id: 'job-b' }),
  ];
  const ctx = context({ raw_source_request: { explicit: true, source_ids: ['c-1'] } });

  const first = evaluateEligibility(buildCandidates(), ctx);
  const second = evaluateEligibility(buildCandidates(), ctx);
  assert.strictEqual(JSON.stringify(first), JSON.stringify(second));

  const buildRegistry = () =>
    createRetrievalRegistry({
      curated: spyProvider([candidate({ source_id: 'cur-1' })]),
      semantic_memory: spyProvider([candidate({ source_id: 'sem-1', source_type: 'semantic_memory' })]),
      raw_source: spyProvider([candidate({ source_id: 'raw-1', source_type: 'raw_source' })]),
    });
  const run1 = retrieveCandidates(buildRegistry(), ctx);
  const run2 = retrieveCandidates(buildRegistry(), ctx);
  assert.strictEqual(JSON.stringify(run1), JSON.stringify(run2));
});

test('T36 confidence classification boundaries are exact', () => {
  assert.strictEqual(classifyConfidence(1.0), CONFIDENCE_LEVELS.HIGH);
  assert.strictEqual(classifyConfidence(0.80), CONFIDENCE_LEVELS.HIGH);
  assert.strictEqual(classifyConfidence(0.799999), CONFIDENCE_LEVELS.MEDIUM);
  assert.strictEqual(classifyConfidence(0.60), CONFIDENCE_LEVELS.MEDIUM);
  assert.strictEqual(classifyConfidence(0.599999), CONFIDENCE_LEVELS.LOW);
  assert.strictEqual(classifyConfidence(0), CONFIDENCE_LEVELS.LOW);
  // invalid or missing confidence fails closed to LOW
  assert.strictEqual(classifyConfidence(NaN), CONFIDENCE_LEVELS.LOW);
  assert.strictEqual(classifyConfidence(undefined), CONFIDENCE_LEVELS.LOW);
  assert.strictEqual(classifyConfidence(null), CONFIDENCE_LEVELS.LOW);
  assert.strictEqual(classifyConfidence('0.9'), CONFIDENCE_LEVELS.LOW);
  assert.strictEqual(classifyConfidence(2), CONFIDENCE_LEVELS.LOW);
  assert.strictEqual(classifyConfidence(-0.1), CONFIDENCE_LEVELS.LOW);
});

test('T37 retrieval + eligibility chain enforces all boundaries together', () => {
  const registry = createRetrievalRegistry({
    curated: spyProvider([
      candidate({ source_id: 'cur-1' }),
      candidate({ source_id: 'foreign-1', job_id: 'job-z' }),
    ]),
    semantic_memory: spyProvider([candidate({ source_id: 'sem-1', source_type: 'semantic_memory' })]),
    raw_source: spyProvider([candidate({ source_id: 'raw-1', source_type: 'raw_source' })]),
  });
  const ctx = context({ objective_confidence: 0.85, raw_source_request: { explicit: true, source_ids: ['raw-1'] } });

  const retrieval = retrieveCandidates(registry, ctx);
  assert.strictEqual(retrieval.automatic_retrieval_enabled, true);

  const eligibility = evaluateEligibility(retrieval.candidates, ctx);
  assert.deepStrictEqual(eligibility.eligible.map((d) => d.source_id), ['cur-1', 'sem-1', 'raw-1']);
  assert.deepStrictEqual(eligibility.rejected.map((d) => d.source_id), ['foreign-1']);

  const advisory = eligibility.eligible.find((d) => d.source_id === 'sem-1');
  assert.strictEqual(advisory.advisory, true);
});

test('T38 single-candidate evaluation primitive works standalone', () => {
  const eligible = evaluateCandidate(candidate({ source_id: 'cur-1' }), context({}));
  assert.strictEqual(eligible.eligible, true);
  assert.strictEqual(eligible.reason, REASONS.ELIGIBLE);

  const rejected = evaluateCandidate(
    candidate({ source_id: 'raw-1', source_type: 'raw_source' }),
    context({})
  );
  assert.strictEqual(rejected.eligible, false);
  assert.strictEqual(rejected.reason, REASONS.RAW_SOURCE_EXPLICIT_ONLY);
});

test('T39 raw adapter filters out records not explicitly requested', () => {
  const provider = spyProvider([
    candidate({ source_id: 'raw-1', source_type: 'raw_source' }),
    candidate({ source_id: 'raw-2', source_type: 'raw_source' }),
    candidate({ source_id: 'raw-3', source_type: 'raw_source' }),
  ]);
  const adapter = createRetrievalAdapter('raw_source', provider);
  const result = adapter.retrieve(
    context({ raw_source_request: { explicit: true, source_ids: ['raw-1', 'raw-3'] } })
  );
  assert.strictEqual(result.invoked, true);
  assert.deepStrictEqual(result.candidates.map((c) => c.source_id), ['raw-1', 'raw-3']);

  const registry = createRetrievalRegistry({ raw_source: provider });
  const out = retrieveCandidates(
    registry,
    context({ raw_source_request: { explicit: true, source_ids: ['raw-2'] } })
  );
  assert.deepStrictEqual(out.candidates.map((c) => c.source_id), ['raw-2']);
});

test('T40 malformed or extra arguments cannot bypass the LOW-confidence gate', () => {
  const lowCtx = context({ objective_confidence: 0.2 });

  const forcedHigh = evaluateCandidate(candidate({ source_id: 'cur-1' }), lowCtx, CONFIDENCE_LEVELS.HIGH);
  assert.strictEqual(forcedHigh.eligible, false);
  assert.strictEqual(forcedHigh.reason, REASONS.LOW_CONFIDENCE_MANDATORY_ONLY);

  const malformed = evaluateCandidate(candidate({ source_id: 'cur-1' }), lowCtx, 'HIGH-TYPO');
  assert.strictEqual(malformed.eligible, false);
  assert.strictEqual(malformed.reason, REASONS.LOW_CONFIDENCE_MANDATORY_ONLY);

  const nullLevel = evaluateCandidate(candidate({ source_id: 'cur-1' }), lowCtx, null);
  assert.strictEqual(nullLevel.eligible, false);
  assert.strictEqual(nullLevel.reason, REASONS.LOW_CONFIDENCE_MANDATORY_ONLY);
});

// Summary
console.log(`\n=== Retrieval + Eligibility Lane Test Summary ===`);
console.log(`Cases: ${passed + failed}, Passed: ${passed}, Failed: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
