/**
 * Context Hydration — Ranking Policy lane tests (Issue #10, 9A-03).
 *
 * Verifies runtime/context-hydration/ranking-policy.js against the exact
 * context-hydration@1.0.1 deterministic scoring contract.
 *
 * Deterministic only: fixed timestamps, no network, no DB, no env reads,
 * no wall-clock dependency.
 */

const assert = require('assert');
const path = require('path');

const policy = require(path.resolve(__dirname, '..', '..', 'context-hydration', 'ranking-policy.js'));

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

// Single immutable run anchor for all tests. Fixed — never wall-clock.
const ANCHOR = '2026-09-27T00:00:00Z';

const CONTEXT = Object.freeze({
  active_job_id: 'job-1',
  active_session_id: 'sess-1',
});

/** Build a candidate record with deterministic defaults. */
function candidate(overrides) {
  return Object.assign({
    source_id: 'src',
    source_type: 'curated',
    scope: 'global',
    session_id: null,
    job_id: null,
    updated_at: ANCHOR,
    retrieval_terms: [],
  }, overrides);
}

/** Recursively freeze an input structure (immutability expectation). */
function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}

// --- Term normalization ---

// RP01: NFKC normalization (ligature + fullwidth forms)
test('RP01 normalizeTerm applies Unicode NFKC', () => {
  assert.strictEqual(policy.normalizeTerm('\uFB01le'), 'file');
  assert.strictEqual(policy.normalizeTerm('\uFF26\uFF2F\uFF2F'), 'foo');
});

// RP02: lowercase
test('RP02 normalizeTerm lowercases', () => {
  assert.strictEqual(policy.normalizeTerm('HELLO World'), 'hello world');
});

// RP03: trim leading/trailing whitespace
test('RP03 normalizeTerm trims', () => {
  assert.strictEqual(policy.normalizeTerm('  hello  '), 'hello');
  assert.strictEqual(policy.normalizeTerm('\u00A0hello\u00A0'), 'hello');
});

// RP04: collapse internal whitespace to one ASCII space
test('RP04 normalizeTerm collapses internal whitespace', () => {
  assert.strictEqual(policy.normalizeTerm('a\t\t b\n c'), 'a b c');
  assert.strictEqual(policy.normalizeTerm('a   b'), 'a b');
  assert.strictEqual(policy.normalizeTerm('a\u00A0\u00A0b'), 'a b');
});

// RP05: empty terms removed
test('RP05 normalizeTerms removes empty terms', () => {
  assert.deepStrictEqual(policy.normalizeTerms(['', '   ', '\t\n', 'ok']), ['ok']);
});

// RP06: deduplicate exact normalized terms, first-occurrence order
test('RP06 normalizeTerms deduplicates exact normalized terms', () => {
  assert.deepStrictEqual(
    policy.normalizeTerms(['Alpha', 'alpha', ' alpha ', '\uFB01le', 'FIle', 'file']),
    ['alpha', 'file']
  );
  assert.deepStrictEqual(policy.normalizeTerms(['b', 'a', 'b', 'c']), ['b', 'a', 'c']);
});

// RP07: non-string / non-array input fails closed
test('RP07 normalizeTerm(s) fail closed on invalid input', () => {
  assert.throws(() => policy.normalizeTerm(42), TypeError);
  assert.throws(() => policy.normalizeTerms(null), TypeError);
  assert.throws(() => policy.normalizeTerms(['ok', 7]), TypeError);
});

// --- Semantic relevance (Jaccard) ---

// RP08: Jaccard normal case
test('RP08 semanticRelevance Jaccard normal case', () => {
  assert.strictEqual(policy.semanticRelevance(['alpha', 'beta'], ['beta', 'gamma']), 1 / 3);
  assert.strictEqual(policy.semanticRelevance(['a', 'b'], ['a', 'b']), 1);
  assert.strictEqual(policy.semanticRelevance(['a'], ['b']), 0);
});

// RP09: normalization applied inside Jaccard
test('RP09 semanticRelevance normalizes both sides', () => {
  assert.strictEqual(policy.semanticRelevance([' Alpha '], ['ALPHA']), 1);
});

// RP10: empty union -> 0
test('RP10 semanticRelevance empty union is 0', () => {
  assert.strictEqual(policy.semanticRelevance([], []), 0);
  assert.strictEqual(policy.semanticRelevance(['x'], []), 0);
});

// --- Scope specificity ---

// RP11: same active session -> 1.00 (outranks job match)
test('RP11 scope same active session is 1.00', () => {
  assert.strictEqual(
    policy.scopeSpecificity(candidate({ scope: 'session', session_id: 'sess-1' }), CONTEXT),
    1.00
  );
  assert.strictEqual(
    policy.scopeSpecificity(candidate({ scope: 'job', session_id: 'sess-1', job_id: 'job-1' }), CONTEXT),
    1.00
  );
});

// RP12: same active job -> 0.75
test('RP12 scope same active job is 0.75', () => {
  assert.strictEqual(
    policy.scopeSpecificity(candidate({ scope: 'job', session_id: 'sess-9', job_id: 'job-1' }), CONTEXT),
    0.75
  );
});

// RP13: global scope without job_id -> 0.50
test('RP13 scope global without job_id is 0.50', () => {
  assert.strictEqual(
    policy.scopeSpecificity(candidate({ scope: 'global', job_id: null }), CONTEXT),
    0.50
  );
  assert.strictEqual(
    policy.scopeSpecificity(candidate({ scope: 'global', job_id: undefined }), CONTEXT),
    0.50
  );
});

// RP14: otherwise -> 0.00
test('RP14 scope otherwise is 0.00', () => {
  assert.strictEqual(
    policy.scopeSpecificity(candidate({ scope: 'job', session_id: 'sess-9', job_id: null }), CONTEXT),
    0.00
  );
  assert.strictEqual(
    policy.scopeSpecificity(candidate({ scope: 'session', session_id: 'sess-9', job_id: null }), CONTEXT),
    0.00
  );
});

// RP15: foreign job hard reject (gate before scoring)
test('RP15 foreign job hard reject', () => {
  const foreign = candidate({ scope: 'job', job_id: 'job-2' });
  assert.throws(
    () => policy.scopeSpecificity(foreign, CONTEXT),
    (e) => e.code === 'FOREIGN_JOB_REJECT'
  );
});

// RP16: conflicting job_id cannot escape rejection via matching session
test('RP16 conflicting job + matching session still rejects', () => {
  const conflicting = candidate({ scope: 'session', session_id: 'sess-1', job_id: 'job-2' });
  assert.throws(
    () => policy.scopeSpecificity(conflicting, CONTEXT),
    (e) => e.code === 'FOREIGN_JOB_REJECT'
  );
});

// RP17: isForeignJob literal semantics
test('RP17 isForeignJob requires a present mismatched job_id', () => {
  assert.strictEqual(policy.isForeignJob(candidate({ scope: 'global', job_id: null }), 'job-1'), false);
  assert.strictEqual(policy.isForeignJob(candidate({ job_id: 'job-1' }), 'job-1'), false);
  assert.strictEqual(policy.isForeignJob(candidate({ job_id: 'job-2' }), 'job-1'), true);
  // No active job: any present job_id is unverifiable -> fail closed as foreign.
  assert.strictEqual(policy.isForeignJob(candidate({ job_id: 'job-1' }), null), true);
});

// --- Authority ---

// RP18: every authority value exact
test('RP18 authority baseline values exact', () => {
  assert.strictEqual(policy.authorityScore('curated'), 1.00);
  assert.strictEqual(policy.authorityScore('reviewed_session_fact'), 0.90);
  assert.strictEqual(policy.authorityScore('historical_checkpoint'), 0.80);
  assert.strictEqual(policy.authorityScore('semantic_memory'), 0.50);
});

// RP19: unknown authority fail closed (no invented score)
test('RP19 unknown authority fails closed', () => {
  assert.strictEqual(policy.authorityScore('mystery_source'), null);
  assert.strictEqual(policy.authorityScore(''), null);
});

// --- Recency ---

// RP20: exact bucket boundaries
test('RP20 recency exact boundaries', () => {
  assert.strictEqual(policy.recencyScore(ANCHOR, ANCHOR), 1.00);                        // age 0
  assert.strictEqual(policy.recencyScore('2026-09-26T00:00:00Z', ANCHOR), 1.00);        // age 86400
  assert.strictEqual(policy.recencyScore('2026-09-20T00:00:00Z', ANCHOR), 0.75);        // age 604800
  assert.strictEqual(policy.recencyScore('2026-08-28T00:00:00Z', ANCHOR), 0.50);        // age 2592000
  assert.strictEqual(policy.recencyScore('2026-06-29T00:00:00Z', ANCHOR), 0.25);        // age 7776000
});

// RP21: just-over-boundary ages drop one bucket
test('RP21 recency just-over boundaries', () => {
  assert.strictEqual(policy.recencyScore('2026-09-25T23:59:59Z', ANCHOR), 0.75);        // age 86401
  assert.strictEqual(policy.recencyScore('2026-09-19T23:59:59Z', ANCHOR), 0.50);        // age 604801
  assert.strictEqual(policy.recencyScore('2026-08-27T23:59:59Z', ANCHOR), 0.25);        // age 2592001
  assert.strictEqual(policy.recencyScore('2026-06-28T23:59:59Z', ANCHOR), 0.00);        // age 7776001
});

// RP22: future updated_at floored to age 0
test('RP22 future updated_at floors to age 0', () => {
  assert.strictEqual(policy.recencyScore('2026-09-28T00:00:00Z', ANCHOR), 1.00);
  assert.strictEqual(policy.recencyScore('2027-01-01T00:00:00Z', ANCHOR), 1.00);
});

// RP23: invalid timestamps fail closed
test('RP23 recency invalid timestamps fail closed', () => {
  assert.throws(() => policy.recencyScore('not-a-date', ANCHOR), TypeError);
  assert.throws(() => policy.recencyScore(ANCHOR, 'not-a-date'), TypeError);
});

// --- Total score + quantization ---

// RP24: exact weighted total formula
test('RP24 total formula exact', () => {
  assert.strictEqual(
    policy.totalScore({ semantic_relevance: 1, scope_specificity: 1, authority: 1, recency: 1 }),
    1
  );
  assert.strictEqual(
    policy.totalScore({ semantic_relevance: 0.5, scope_specificity: 0.75, authority: 0.9, recency: 0.25 }),
    0.63
  );
  assert.strictEqual(
    policy.totalScore({ semantic_relevance: 0, scope_specificity: 1, authority: 1, recency: 1 }),
    0.5
  );
  assert.strictEqual(
    policy.totalScore({ semantic_relevance: 0, scope_specificity: 0, authority: 0, recency: 0 }),
    0
  );
});

// RP25: quantize6 half-up behavior
test('RP25 quantize6 half-up behavior', () => {
  assert.strictEqual(policy.quantize6(0.0078125), 0.007813);   // exact half -> up
  assert.strictEqual(policy.quantize6(0.0000005), 0.000001);   // exact half -> up
  assert.strictEqual(policy.quantize6(0.1234565), 0.123457);   // exact half -> up
  assert.strictEqual(policy.quantize6(0.00781249), 0.007812);  // just below half -> down
  assert.strictEqual(policy.quantize6(0.00781251), 0.007813);  // just above half -> up
  assert.strictEqual(policy.quantize6(0.5), 0.5);              // integer micros unchanged
});

// --- Tie-break comparator ---

// RP26: level 1 — total_score DESC
test('RP26 tie-break 1: total_score DESC', () => {
  const a = { total_score: 0.7, scope_specificity: 0.5, authority: 0.5, updated_at: ANCHOR, source_id: 'b' };
  const b = { total_score: 0.6, scope_specificity: 1.0, authority: 1.0, updated_at: ANCHOR, source_id: 'a' };
  assert.ok(policy.compareScoredCandidates(a, b) < 0, 'higher total must come first');
});

// RP27: level 2 — scope_specificity DESC
test('RP27 tie-break 2: scope_specificity DESC', () => {
  const a = { total_score: 0.5, scope_specificity: 1.0, authority: 0.5, updated_at: ANCHOR, source_id: 'z' };
  const b = { total_score: 0.5, scope_specificity: 0.75, authority: 1.0, updated_at: ANCHOR, source_id: 'a' };
  assert.ok(policy.compareScoredCandidates(a, b) < 0, 'higher scope must come first');
});

// RP28: level 3 — authority DESC
test('RP28 tie-break 3: authority DESC', () => {
  const a = { total_score: 0.5, scope_specificity: 0.5, authority: 0.9, updated_at: ANCHOR, source_id: 'z' };
  const b = { total_score: 0.5, scope_specificity: 0.5, authority: 0.8, updated_at: ANCHOR, source_id: 'a' };
  assert.ok(policy.compareScoredCandidates(a, b) < 0, 'higher authority must come first');
});

// RP29: level 4 — updated_at DESC
test('RP29 tie-break 4: updated_at DESC', () => {
  const a = { total_score: 0.5, scope_specificity: 0.5, authority: 0.5, updated_at: '2026-09-26T00:00:00Z', source_id: 'z' };
  const b = { total_score: 0.5, scope_specificity: 0.5, authority: 0.5, updated_at: '2026-09-25T00:00:00Z', source_id: 'a' };
  assert.ok(policy.compareScoredCandidates(a, b) < 0, 'newer updated_at must come first');
});

// RP30: level 5 — source_id ASC (final tie-break)
test('RP30 tie-break 5: source_id ASC', () => {
  const a = { total_score: 0.5, scope_specificity: 0.5, authority: 0.5, updated_at: ANCHOR, source_id: 'alpha' };
  const b = { total_score: 0.5, scope_specificity: 0.5, authority: 0.5, updated_at: ANCHOR, source_id: 'beta' };
  assert.ok(policy.compareScoredCandidates(a, b) < 0, 'source_id ascending must come first');
  assert.ok(policy.compareScoredCandidates(b, a) > 0, 'comparator must be antisymmetric');
  assert.strictEqual(policy.compareScoredCandidates(a, { ...a }), 0, 'fully equal records compare equal');
});

// --- End-to-end ranking ---

function buildScenarioInput() {
  return {
    objective_retrieval_terms: ['alpha', 'beta'],
    candidates: [
      {
        source_id: 'global-curated', source_type: 'curated', scope: 'global',
        session_id: null, job_id: null, updated_at: '2026-09-26T00:00:00Z',
        retrieval_terms: ['alpha', 'beta', 'gamma'],
      },
      {
        source_id: 'session-curated', source_type: 'curated', scope: 'session',
        session_id: 'sess-1', job_id: null, updated_at: '2026-09-25T00:00:00Z',
        retrieval_terms: ['alpha'],
      },
      {
        source_id: 'job-fact', source_type: 'reviewed_session_fact', scope: 'job',
        session_id: 'sess-9', job_id: 'job-1', updated_at: '2026-09-26T23:00:00Z',
        retrieval_terms: ['beta'],
      },
      {
        source_id: 'foreign-x', source_type: 'curated', scope: 'job',
        session_id: 'sess-1', job_id: 'job-2', updated_at: '2026-09-26T00:00:00Z',
        retrieval_terms: ['alpha'],
      },
      {
        source_id: 'weird-x', source_type: 'unknown_source', scope: 'global',
        session_id: null, job_id: null, updated_at: '2026-09-26T00:00:00Z',
        retrieval_terms: ['alpha'],
      },
    ],
    active_job_id: 'job-1',
    active_session_id: 'sess-1',
    hydration_started_at: ANCHOR,
  };
}

// RP31: end-to-end ordering, gates, and factor values
test('RP31 rankCandidates end-to-end ordering + gates', () => {
  const result = policy.rankCandidates(buildScenarioInput());

  assert.deepStrictEqual(
    result.ranked.map((r) => r.source_id),
    ['session-curated', 'global-curated', 'job-fact']
  );
  assert.strictEqual(result.ranked[0].total_score, 0.7375);
  assert.strictEqual(result.ranked[1].total_score, 0.708333);
  assert.strictEqual(result.ranked[2].total_score, 0.6675);

  // Factor values are carried on the ranked records.
  assert.strictEqual(result.ranked[0].semantic_relevance, 0.5);
  assert.strictEqual(result.ranked[0].scope_specificity, 1.00);
  assert.strictEqual(result.ranked[0].authority, 1.00);
  assert.strictEqual(result.ranked[0].recency, 0.75);
  assert.strictEqual(result.ranked[1].scope_specificity, 0.50);
  assert.strictEqual(result.ranked[2].authority, 0.90);

  // Foreign job and unknown authority are ineligible, in input order.
  assert.deepStrictEqual(result.rejected, [
    { source_id: 'foreign-x', reason: 'foreign_job' },
    { source_id: 'weird-x', reason: 'unknown_authority' },
  ]);
});

// RP32: deterministic repeat + input-order independence
test('RP32 rankCandidates deterministic repeat', () => {
  const input = buildScenarioInput();
  const first = policy.rankCandidates(input);
  const second = policy.rankCandidates(input);
  assert.deepStrictEqual(first, second);

  const reversed = { ...input, candidates: [...input.candidates].reverse() };
  const third = policy.rankCandidates(reversed);
  assert.deepStrictEqual(third.ranked, first.ranked, 'candidate set must rank identically regardless of input order');
});

// RP33: source_id final tie-break through rankCandidates
test('RP33 rankCandidates source_id final tie-break', () => {
  const input = {
    objective_retrieval_terms: [],
    candidates: [
      {
        source_id: 'zeta', source_type: 'curated', scope: 'global',
        session_id: null, job_id: null, updated_at: ANCHOR, retrieval_terms: [],
      },
      {
        source_id: 'alpha', source_type: 'curated', scope: 'global',
        session_id: null, job_id: null, updated_at: ANCHOR, retrieval_terms: [],
      },
    ],
    active_job_id: 'job-1',
    active_session_id: 'sess-1',
    hydration_started_at: ANCHOR,
  };
  const result = policy.rankCandidates(input);
  assert.deepStrictEqual(result.ranked.map((r) => r.source_id), ['alpha', 'zeta']);
});

// RP34: inputs are not mutated
test('RP34 rankCandidates does not mutate inputs', () => {
  const input = buildScenarioInput();
  const snapshot = JSON.parse(JSON.stringify(input));
  policy.rankCandidates(input);
  assert.deepStrictEqual(input, snapshot);
});

// RP35: runs cleanly against deep-frozen inputs
test('RP35 rankCandidates accepts frozen inputs', () => {
  const frozen = deepFreeze(buildScenarioInput());
  const result = policy.rankCandidates(frozen);
  assert.deepStrictEqual(
    result.ranked.map((r) => r.source_id),
    ['session-curated', 'global-curated', 'job-fact']
  );
});

// RP36: invalid candidates container fails closed
test('RP36 rankCandidates rejects a non-array candidates container', () => {
  assert.throws(
    () => policy.rankCandidates({
      objective_retrieval_terms: [],
      candidates: null,
      active_job_id: null,
      active_session_id: null,
      hydration_started_at: ANCHOR,
    }),
    TypeError
  );
});

// Summary
console.log(`\n=== Ranking Policy Test Summary ===`);
console.log(`Cases: ${passed + failed}, Passed: ${passed}, Failed: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
