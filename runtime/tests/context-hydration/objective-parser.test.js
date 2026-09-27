/**
 * Context Hydration — Objective Parser acceptance tests (Issue #9, 9A-02).
 *
 * Covers O01–O10 plus confidence boundaries, schema completeness, term
 * normalization, intent classification, checkpoint provenance, and
 * fail-closed input validation.
 *
 * No network. No database. No env/profile access. No wall-clock dependency.
 * Deterministic under context-hydration@1.0.1.
 */

const assert = require('assert');

const {
  POLICY_REF,
  ObjectiveParserError,
  parseObjective,
  classifyConfidence,
  confidencePolicy,
  normalizeTerms,
  tokenizeTerms,
  classifyIntent,
} = require('../../context-hydration/objective-parser.js');

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

function baseInput(overrides) {
  return Object.assign({
    session_id: 'sess-1',
    job_id: 'job-7',
    user_request: 'Implement the objective parser module',
    active_constraints: [],
    latest_checkpoint: null,
  }, overrides || {});
}

// O01: explicit objective preserved
test('O01 explicit objective preserved', () => {
  const objective = parseObjective(baseInput({
    user_request: 'do something vague',
    explicit_objective: {
      summary: 'Ship deterministic objective parsing',
      intent: 'IMPLEMENT',
      retrieval_terms: ['Objective Parser', 'determinism'],
    },
  }));
  assert.strictEqual(objective.summary, 'Ship deterministic objective parsing');
  assert.strictEqual(objective.intent, 'IMPLEMENT');
  assert.deepStrictEqual(objective.retrieval_terms, ['objective parser', 'determinism']);
});

// O02: clear request produces structured objective
test('O02 clear request produces structured objective', () => {
  const objective = parseObjective(baseInput());
  const fields = ['objective_id', 'summary', 'intent', 'scope', 'entities', 'constraints', 'retrieval_terms', 'confidence', 'provenance'];
  assert.deepStrictEqual(Object.keys(objective), fields);
  assert.ok(typeof objective.objective_id === 'string' && objective.objective_id.startsWith('obj-'));
  assert.strictEqual(objective.summary, 'Implement the objective parser module');
  assert.strictEqual(objective.intent, 'IMPLEMENT');
  assert.ok(objective.confidence >= 0.80, `expected HIGH band, got ${objective.confidence}`);
});

// O03: scope extracted correctly
test('O03 scope extracted correctly', () => {
  const objective = parseObjective(baseInput());
  assert.deepStrictEqual(objective.scope, { session_id: 'sess-1', job_id: 'job-7' });
  const overridden = parseObjective(baseInput({
    explicit_objective: { scope: { job_id: 'job-9' } },
  }));
  assert.deepStrictEqual(overridden.scope, { session_id: 'sess-1', job_id: 'job-9' });
});

// O04: active constraints preserved
test('O04 active constraints preserved', () => {
  const objective = parseObjective(baseInput({
    active_constraints: ['no network', 'read-only', 'no network'],
    explicit_objective: { constraints: ['no secrets'] },
  }));
  assert.deepStrictEqual(objective.constraints, ['no network', 'read-only', 'no secrets']);
});

// O05: provenance preserved
test('O05 provenance preserved', () => {
  const objective = parseObjective(baseInput({
    latest_checkpoint: { checkpoint_id: 'ckpt-42' },
  }));
  assert.deepStrictEqual(objective.provenance, {
    session_id: 'sess-1',
    job_id: 'job-7',
    objective_source: 'inferred_request',
    checkpoint_id: 'ckpt-42',
    policy_ref: POLICY_REF,
  });
  const explicit = parseObjective(baseInput({ explicit_objective: { summary: 'Explicit scope' } }));
  assert.strictEqual(explicit.provenance.objective_source, 'explicit_objective');
});

// O06: LOW confidence blocks automatic retrieval
test('O06 LOW confidence blocks automatic retrieval', () => {
  const objective = parseObjective(baseInput({ user_request: 'zzz' }));
  assert.ok(objective.confidence < 0.60, `expected LOW band, got ${objective.confidence}`);
  const policy = confidencePolicy(objective.confidence);
  assert.strictEqual(policy.level, 'LOW');
  assert.strictEqual(policy.automatic_retrieval_disabled, true);
});

// O07: LOW confidence still loads mandatory context
test('O07 LOW confidence still loads mandatory context', () => {
  const objective = parseObjective(baseInput({ user_request: '' }));
  assert.ok(objective.confidence < 0.60, `expected LOW band, got ${objective.confidence}`);
  const policy = confidencePolicy(objective.confidence);
  assert.strictEqual(policy.level, 'LOW');
  assert.strictEqual(policy.mandatory_context_loads, true);
  assert.strictEqual(policy.automatic_retrieval_disabled, true);
});

// O08: ambiguity does not invent entities
test('O08 ambiguity does not invent entities', () => {
  const objective = parseObjective(baseInput({ user_request: 'handle the thing with the stuff somehow' }));
  assert.strictEqual(objective.intent, 'UNSPECIFIED');
  assert.deepStrictEqual(objective.entities, []);
  const explicitEntities = parseObjective(baseInput({
    explicit_objective: { entities: ['Context Hydration'] },
  }));
  assert.deepStrictEqual(explicitEntities.entities, ['Context Hydration']);
});

// O09: identical input + policy produces identical objective
test('O09 identical input + policy produces identical objective', () => {
  const makeInput = () => baseInput({ active_constraints: ['no network'], latest_checkpoint: 'ckpt-1' });
  const first = parseObjective(makeInput());
  const second = parseObjective(makeInput());
  assert.deepStrictEqual(first, second);
  assert.strictEqual(first.objective_id, second.objective_id);
  assert.strictEqual(JSON.stringify(first), JSON.stringify(second));
});

// O10: explicit objective outranks inferred objective
test('O10 explicit objective outranks inferred objective', () => {
  const inferred = parseObjective(baseInput({ user_request: 'Fix the parser' }));
  const explicit = parseObjective(baseInput({
    user_request: 'Fix the parser',
    explicit_objective: {
      summary: 'Implement deterministic objective parsing',
      intent: 'IMPLEMENT',
      retrieval_terms: ['structured objective'],
    },
  }));
  assert.strictEqual(inferred.intent, 'FIX');
  assert.strictEqual(explicit.intent, 'IMPLEMENT');
  assert.strictEqual(explicit.summary, 'Implement deterministic objective parsing');
  assert.deepStrictEqual(explicit.retrieval_terms, ['structured objective']);
  assert.notStrictEqual(explicit.objective_id, inferred.objective_id);
});

// T01: HIGH threshold boundary (>= 0.80)
test('T01 HIGH threshold boundary (0.80 => HIGH)', () => {
  const objective = parseObjective(baseInput({
    user_request: 'Fix bug',
    active_constraints: ['no network'],
  }));
  assert.strictEqual(objective.confidence, 0.80);
  assert.strictEqual(classifyConfidence(objective.confidence), 'HIGH');
  const explicit = parseObjective(baseInput({ explicit_objective: { summary: 'Explicit objective' } }));
  assert.strictEqual(explicit.confidence, 1.00);
  assert.strictEqual(classifyConfidence(explicit.confidence), 'HIGH');
});

// T02: MEDIUM threshold boundary (>= 0.60 < 0.80)
test('T02 MEDIUM threshold boundary (0.60 => MEDIUM)', () => {
  const objective = parseObjective(baseInput({ user_request: 'alpha bravo charlie' }));
  assert.strictEqual(objective.confidence, 0.60);
  assert.strictEqual(classifyConfidence(objective.confidence), 'MEDIUM');
  assert.strictEqual(confidencePolicy(objective.confidence).automatic_retrieval_disabled, false);
});

// T03: LOW threshold boundary (< 0.60)
test('T03 LOW threshold boundary (< 0.60 => LOW)', () => {
  const low = parseObjective(baseInput({ user_request: 'zzz' }));
  assert.strictEqual(low.confidence, 0.40);
  assert.strictEqual(classifyConfidence(low.confidence), 'LOW');
  assert.strictEqual(classifyConfidence(0.59), 'LOW');
  assert.strictEqual(classifyConfidence(0.79), 'MEDIUM');
});

// T04: output schema completeness and types
test('T04 output schema completeness and types', () => {
  const objective = parseObjective(baseInput());
  assert.strictEqual(typeof objective.objective_id, 'string');
  assert.strictEqual(typeof objective.summary, 'string');
  assert.strictEqual(typeof objective.intent, 'string');
  assert.ok(objective.scope && typeof objective.scope === 'object' && !Array.isArray(objective.scope));
  assert.ok(Array.isArray(objective.entities));
  assert.ok(Array.isArray(objective.constraints));
  assert.ok(Array.isArray(objective.retrieval_terms));
  assert.strictEqual(typeof objective.confidence, 'number');
  assert.ok(objective.confidence >= 0 && objective.confidence <= 1);
  assert.ok(objective.provenance && typeof objective.provenance === 'object' && !Array.isArray(objective.provenance));
  assert.strictEqual(Object.keys(objective.provenance).length, 5);
});

// T05: exact v1 term normalization
test('T05 term normalization exactness', () => {
  assert.deepStrictEqual(
    normalizeTerms(['  Hello   WORLD ', 'hello world', '\uFF48\uFF45\uFF4C\uFF4C\uFF4F', '', '   ']),
    ['hello world', 'hello']
  );
  assert.deepStrictEqual(normalizeTerms([]), []);
});

// T06: empty/minimal legitimate input
test('T06 empty/minimal legitimate input', () => {
  const objective = parseObjective({ session_id: 's', job_id: 'j', user_request: '' });
  assert.strictEqual(objective.summary, '');
  assert.deepStrictEqual(objective.entities, []);
  assert.deepStrictEqual(objective.constraints, []);
  assert.deepStrictEqual(objective.retrieval_terms, []);
  assert.strictEqual(objective.confidence, 0);
  assert.strictEqual(classifyConfidence(objective.confidence), 'LOW');
  const withExplicit = parseObjective({
    session_id: 's',
    job_id: 'j',
    user_request: '',
    explicit_objective: { summary: 'Explicit objective without request text' },
  });
  assert.strictEqual(withExplicit.confidence, 1.00);
  assert.strictEqual(withExplicit.provenance.objective_source, 'explicit_objective');
});

// T07: malformed required input fails closed
test('T07 malformed required input fails closed', () => {
  const expectCode = (input, code) => {
    let threw = null;
    try {
      parseObjective(input);
    } catch (e) {
      threw = e;
    }
    assert.ok(threw, `expected ${code} to throw`);
    assert.ok(threw instanceof ObjectiveParserError, 'must throw ObjectiveParserError');
    assert.strictEqual(threw.code, code);
  };
  expectCode({ job_id: 'j', user_request: 'x' }, 'INVALID_SESSION_ID');
  expectCode({ session_id: 's', user_request: 'x' }, 'INVALID_JOB_ID');
  expectCode({ session_id: '   ', job_id: 'j', user_request: 'x' }, 'INVALID_SESSION_ID');
  expectCode({ session_id: 's', job_id: 'j' }, 'INVALID_USER_REQUEST');
  expectCode({ session_id: 's', job_id: 'j', user_request: 42 }, 'INVALID_USER_REQUEST');
  expectCode({ session_id: 's', job_id: 'j', user_request: 'x', active_constraints: 'nope' }, 'INVALID_ACTIVE_CONSTRAINTS');
  expectCode({ session_id: 's', job_id: 'j', user_request: 'x', active_constraints: [42] }, 'INVALID_ACTIVE_CONSTRAINTS');
  expectCode({ session_id: 's', job_id: 'j', user_request: 'x', latest_checkpoint: 42 }, 'INVALID_LATEST_CHECKPOINT');
  expectCode({ session_id: 's', job_id: 'j', user_request: 'x', explicit_objective: 'nope' }, 'INVALID_EXPLICIT_OBJECTIVE');
  expectCode({ session_id: 's', job_id: 'j', user_request: 'x', explicit_objective: { unknown: true } }, 'INVALID_EXPLICIT_OBJECTIVE');
  expectCode({ session_id: 's', job_id: 'j', user_request: 'x', explicit_objective: { scope: { other: 'z' } } }, 'INVALID_EXPLICIT_OBJECTIVE');
});

// T08: intent classification closed set and deterministic tokenization
test('T08 intent classification closed set and deterministic tokenization', () => {
  assert.strictEqual(classifyIntent('Implement the parser'), 'IMPLEMENT');
  assert.strictEqual(classifyIntent('fix the bug'), 'FIX');
  assert.strictEqual(classifyIntent('explain the contract'), 'EXPLAIN');
  assert.strictEqual(classifyIntent('review the ranking code'), 'ANALYZE');
  assert.strictEqual(classifyIntent('find the checkpoint'), 'RETRIEVE');
  assert.strictEqual(classifyIntent('update the budget module'), 'MODIFY');
  assert.strictEqual(classifyIntent('what about it'), 'UNSPECIFIED');
  assert.strictEqual(classifyIntent(''), 'UNSPECIFIED');
  assert.deepStrictEqual(tokenizeTerms('Context-Hydration! v1'), ['context', 'hydration', 'v1']);
});

// T09: checkpoint provenance traceability
test('T09 checkpoint provenance traceability', () => {
  const fromString = parseObjective(baseInput({ latest_checkpoint: 'ckpt-abc' }));
  assert.strictEqual(fromString.provenance.checkpoint_id, 'ckpt-abc');
  const fromObject = parseObjective(baseInput({ latest_checkpoint: { checkpoint_id: 'ckpt-xyz', extra: 'ignored' } }));
  assert.strictEqual(fromObject.provenance.checkpoint_id, 'ckpt-xyz');
  const none = parseObjective(baseInput({ latest_checkpoint: null }));
  assert.strictEqual(none.provenance.checkpoint_id, null);
});

// T10: policy lock is context-hydration@1.0.1
test('T10 policy lock is context-hydration@1.0.1', () => {
  assert.strictEqual(POLICY_REF, 'context-hydration@1.0.1');
  const objective = parseObjective(baseInput());
  assert.strictEqual(objective.provenance.policy_ref, 'context-hydration@1.0.1');
});

// Summary
console.log(`\n=== Objective Parser Test Summary ===`);
console.log(`Cases: ${passed + failed}, Passed: ${passed}, Failed: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
