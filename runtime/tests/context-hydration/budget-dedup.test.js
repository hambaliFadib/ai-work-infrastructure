/**
 * Context Hydration — Budget + Deduplication + ContextPackage test suite.
 *
 * Policy: context-hydration@1.0.1
 * Lane: #12 (9A-05) — budget, dedup, ContextPackage, omission metadata.
 *
 * Coverage:
 *  - required budget inputs and fail-closed input validation
 *  - exact 7-step reservation order and formula results
 *  - exact-fit mandatory, mandatory overflow, zero available context
 *  - retrieval budget floor(available * 0.20)
 *  - deterministic deduplication by source identity
 *  - protected mandatory preservation
 *  - ContextPackage required fields and budget audit fields
 *  - omission metadata allowlist and no full-content persistence
 *  - exact 30-day expiry boundary (just-before / at / after)
 *  - cleanup-before-read and store initialization cleanup
 *  - repeated deterministic behavior
 *
 * Deterministic. No network. No DB. No env reads. No wall-clock reads.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const {
  BudgetError,
  BUDGET_ERROR_CODES,
  REQUIRED_TOKEN_INPUTS,
  RESERVATION_ORDER,
  RETRIEVAL_MAX_FRACTION,
  OVERFLOW_ERROR,
  validateBudgetInputs,
  allocateRetrievalBudget,
  computeBudget,
  deduplicateCandidates,
  applyRetrievalBudget,
} = require('../../context-hydration/budget.js');

const {
  ContextPackageError,
  RETENTION_SECONDS,
  CONTEXT_PACKAGE_REQUIRED_FIELDS,
  RETRIEVED_AUDIT_FIELDS,
  BUDGET_AUDIT_FIELDS,
  OMISSION_ALLOWED_METADATA,
  isExpired,
  createOmissionMetadata,
  createOmissionStore,
  buildContextPackage,
  validateContextPackage,
} = require('../../context-hydration/context-package.js');

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

const HYDRATION_STARTED_AT = '2026-09-27T00:00:00Z';

function validBudgetInputs(overrides = {}) {
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

function candidate(overrides = {}) {
  return {
    source_id: 'src-1',
    source_type: 'curated',
    scope: 'global',
    score: 0.9,
    rank: 1,
    provenance: { origin: 'test' },
    estimated_tokens: 10,
    ...overrides,
  };
}

function packageParams(overrides = {}) {
  return {
    hydration_run_id: 'run-1',
    hydration_started_at: HYDRATION_STARTED_AT,
    objective: { objective_id: 'obj-1', summary: 'deterministic test objective' },
    job_id: 'job-1',
    session_id: 'session-1',
    mandatory: [{ source_id: 'mand-1', source_type: 'mandatory', category: 'approval_state' }],
    candidates: [candidate()],
    budget_inputs: validBudgetInputs(),
    ...overrides,
  };
}

function omissionRecord(sourceId, omittedAt) {
  return createOmissionMetadata(
    { source_id: sourceId, source_type: 'curated', scope: 'global', score: 0.5, rank: 1, estimated_tokens: 5 },
    {
      hydration_run_id: 'run-x',
      hydration_started_at: omittedAt,
      omission_reason: 'retrieval_budget_exceeded',
      rank: 1,
    }
  );
}

// ---------------------------------------------------------------------------
// Budget: inputs, reservation order, overflow, allocation
// ---------------------------------------------------------------------------

// BD01: budget constants match policy 1.0.1 exactly
test('BD01 budget constants match policy 1.0.1', () => {
  assert.deepStrictEqual(REQUIRED_TOKEN_INPUTS, policy.budget.required_inputs);
  assert.strictEqual(RETRIEVAL_MAX_FRACTION, policy.budget.retrieved_max_fraction);
  assert.strictEqual(RETRIEVAL_MAX_FRACTION, 0.20);
  assert.strictEqual(OVERFLOW_ERROR, policy.budget.overflow_error);
  assert.strictEqual(policy.budget.tokenizer_id_required, true);
  assert.strictEqual(policy.budget.reservation_order.length, 7);
  assert.strictEqual(RESERVATION_ORDER.length, 7);
  const expectedStepKeywords = [
    'context_window_tokens',
    'response_headroom_tokens',
    'execution_reserve_tokens',
    'active_conversation_tokens',
    'mandatory_context_tokens',
    'available',
    'retrieval budget',
  ];
  expectedStepKeywords.forEach((keyword, index) => {
    assert.ok(
      policy.budget.reservation_order[index].includes(keyword),
      `policy step ${index + 1} must reference ${keyword}`
    );
  });
  assert.strictEqual(
    policy.budget.formulas.usable_before_mandatory,
    'context_window_tokens - response_headroom_tokens - execution_reserve_tokens - active_conversation_tokens'
  );
  assert.strictEqual(
    policy.budget.formulas.available_context_tokens,
    'usable_before_mandatory - mandatory_context_tokens'
  );
  assert.strictEqual(
    policy.budget.formulas.retrieval_budget_tokens,
    'floor(available_context_tokens * 0.20)'
  );
});

// BD02: required budget inputs accepted and normalized
test('BD02 required budget inputs accepted', () => {
  const normalized = validateBudgetInputs(validBudgetInputs());
  assert.deepStrictEqual(
    Object.keys(normalized).sort(),
    ['active_conversation_tokens', 'context_window_tokens', 'execution_reserve_tokens', 'mandatory_context_tokens', 'response_headroom_tokens', 'tokenizer_id'].sort()
  );
  assert.strictEqual(normalized.tokenizer_id, 'deterministic-test-tokenizer');
  assert.strictEqual(normalized.context_window_tokens, 100000);
  assert.strictEqual(normalized.mandatory_context_tokens, 30000);
});

// BD03: each missing input fails closed
test('BD03 missing budget input rejected', () => {
  for (const field of [...REQUIRED_TOKEN_INPUTS, 'tokenizer_id']) {
    const inputs = validBudgetInputs();
    delete inputs[field];
    assert.throws(
      () => validateBudgetInputs(inputs),
      (e) => e instanceof BudgetError && e.code === BUDGET_ERROR_CODES.INVALID_BUDGET_INPUTS,
      `missing ${field} must fail closed`
    );
  }
});

// BD04: negative token values rejected
test('BD04 negative token values rejected', () => {
  for (const field of REQUIRED_TOKEN_INPUTS) {
    assert.throws(
      () => validateBudgetInputs(validBudgetInputs({ [field]: -1 })),
      (e) => e instanceof BudgetError && e.code === BUDGET_ERROR_CODES.INVALID_BUDGET_INPUTS,
      `negative ${field} must fail closed`
    );
  }
});

// BD05: non-integer / wrong-type token values rejected
test('BD05 non-integer token values rejected', () => {
  const badValues = [1.5, '100', null, NaN, Infinity, true];
  for (const field of REQUIRED_TOKEN_INPUTS) {
    for (const bad of badValues) {
      assert.throws(
        () => validateBudgetInputs(validBudgetInputs({ [field]: bad })),
        (e) => e instanceof BudgetError && e.code === BUDGET_ERROR_CODES.INVALID_BUDGET_INPUTS,
        `${field}=${String(bad)} must fail closed`
      );
    }
  }
  for (const badTokenizer of ['', 42, null]) {
    assert.throws(
      () => validateBudgetInputs(validBudgetInputs({ tokenizer_id: badTokenizer })),
      (e) => e instanceof BudgetError && e.code === BUDGET_ERROR_CODES.INVALID_BUDGET_INPUTS,
      `tokenizer_id=${String(badTokenizer)} must fail closed`
    );
  }
});

// BD06: reservation order constant is the exact 7-step order
test('BD06 reservation order exact 7 steps', () => {
  assert.deepStrictEqual(RESERVATION_ORDER, [
    'context_window_tokens',
    'response_headroom_tokens',
    'execution_reserve_tokens',
    'active_conversation_tokens',
    'mandatory_context_tokens',
    'available_context_tokens',
    'retrieval_budget_tokens',
  ]);
});

// BD07: reservation steps applied sequentially with running values
test('BD07 reservation steps applied sequentially', () => {
  const result = computeBudget(validBudgetInputs());
  const steps = result.reservation_steps;
  assert.strictEqual(steps.length, 7);
  assert.strictEqual(steps[0].value, 100000);
  assert.strictEqual(steps[1].value, 10000);
  assert.strictEqual(steps[1].remaining, 90000);
  assert.strictEqual(steps[2].value, 5000);
  assert.strictEqual(steps[2].remaining, 85000);
  assert.strictEqual(steps[3].value, 20000);
  assert.strictEqual(steps[3].remaining, 65000);
  assert.strictEqual(steps[4].value, 30000);
  assert.strictEqual(steps[4].remaining, 35000);
  assert.strictEqual(steps[5].value, 35000);
  assert.strictEqual(steps[6].value, 7000);
});

// BD08: exact formula results
test('BD08 formula results exact', () => {
  const result = computeBudget(validBudgetInputs());
  assert.strictEqual(result.usable_before_mandatory, 65000);
  assert.strictEqual(result.available_context_tokens, 35000);
  assert.strictEqual(result.retrieval_budget_tokens, 7000);
  assert.strictEqual(result.usable_before_mandatory, 100000 - 10000 - 5000 - 20000);
  assert.strictEqual(result.available_context_tokens, result.usable_before_mandatory - 30000);
  assert.strictEqual(result.retrieval_budget_tokens, Math.floor(result.available_context_tokens * 0.20));
});

// BD09: exact-fit mandatory does not overflow
test('BD09 exact-fit mandatory does not overflow', () => {
  const inputs = validBudgetInputs({
    context_window_tokens: 50000,
    response_headroom_tokens: 5000,
    execution_reserve_tokens: 5000,
    active_conversation_tokens: 10000,
    mandatory_context_tokens: 30000,
  });
  // usable = 50000 - 5000 - 5000 - 10000 = 30000; mandatory = 30000 exact fit
  const result = computeBudget(inputs);
  assert.strictEqual(result.usable_before_mandatory, 30000);
  assert.strictEqual(result.available_context_tokens, 0);
  assert.strictEqual(result.retrieval_budget_tokens, 0);
});

// BD10: mandatory overflow fails with CONTEXT_BUDGET_EXCEEDED
test('BD10 mandatory overflow fails with CONTEXT_BUDGET_EXCEEDED', () => {
  const inputs = validBudgetInputs({
    context_window_tokens: 50000,
    response_headroom_tokens: 5000,
    execution_reserve_tokens: 5000,
    active_conversation_tokens: 10000,
    mandatory_context_tokens: 30001,
  });
  assert.throws(
    () => computeBudget(inputs),
    (e) =>
      e instanceof BudgetError &&
      e.code === BUDGET_ERROR_CODES.CONTEXT_BUDGET_EXCEEDED &&
      e.code === 'CONTEXT_BUDGET_EXCEEDED',
    'mandatory overflow must fail closed'
  );
});

// BD11: reserves exceeding the window fail with CONTEXT_BUDGET_EXCEEDED
test('BD11 reserves exceeding window fail closed', () => {
  const inputs = validBudgetInputs({
    context_window_tokens: 1000,
    response_headroom_tokens: 600,
    execution_reserve_tokens: 300,
    active_conversation_tokens: 200,
    mandatory_context_tokens: 0,
  });
  // usable = 1000 - 600 - 300 - 200 = -100; mandatory 0 > -100
  assert.throws(
    () => computeBudget(inputs),
    (e) => e instanceof BudgetError && e.code === 'CONTEXT_BUDGET_EXCEEDED'
  );
});

// BD12: zero available context yields zero retrieval budget
test('BD12 zero available context yields zero retrieval budget', () => {
  const inputs = validBudgetInputs({
    context_window_tokens: 40000,
    response_headroom_tokens: 5000,
    execution_reserve_tokens: 5000,
    active_conversation_tokens: 10000,
    mandatory_context_tokens: 20000,
  });
  // usable = 20000; available = 0
  const result = computeBudget(inputs);
  assert.strictEqual(result.available_context_tokens, 0);
  assert.strictEqual(result.retrieval_budget_tokens, 0);
});

// BD13: retrieval budget is floor(available * 0.20)
test('BD13 retrieval budget is floor(available * 0.20)', () => {
  const cases = [
    [0, 0],
    [1, 0],
    [2, 0],
    [4, 0],
    [5, 1],
    [9, 1],
    [10, 2],
    [14, 2],
    [15, 3],
    [19, 3],
    [20, 4],
    [25, 5],
    [35000, 7000],
  ];
  for (const [available, expected] of cases) {
    assert.strictEqual(
      allocateRetrievalBudget(available),
      expected,
      `floor(${available} * 0.20) must be ${expected}`
    );
  }
});

// BD14: invalid retrieval allocation input rejected
test('BD14 invalid retrieval allocation input rejected', () => {
  for (const bad of [-1, 1.5, '10', null, NaN]) {
    assert.throws(
      () => allocateRetrievalBudget(bad),
      (e) => e instanceof BudgetError && e.code === BUDGET_ERROR_CODES.INVALID_BUDGET_INPUTS,
      `available=${String(bad)} must fail closed`
    );
  }
});

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

// BD15: dedup deterministic by source identity, first occurrence kept
test('BD15 dedup deterministic by source identity', () => {
  const input = [
    candidate({ source_id: 'a', source_type: 'curated', rank: 1 }),
    candidate({ source_id: 'b', source_type: 'curated', rank: 2 }),
    candidate({ source_id: 'a', source_type: 'curated', rank: 3 }),
    candidate({ source_id: 'a', source_type: 'reviewed_session_fact', rank: 4 }),
    candidate({ source_id: 'c', source_type: 'curated', rank: 5 }),
  ];
  const first = deduplicateCandidates(input);
  const second = deduplicateCandidates(input);
  assert.deepStrictEqual(first, second);
  assert.strictEqual(first.length, 4);
  assert.deepStrictEqual(
    first.map((c) => `${c.source_type}:${c.source_id}`),
    ['curated:a', 'curated:b', 'reviewed_session_fact:a', 'curated:c']
  );
  assert.strictEqual(first[0].rank, 1, 'first occurrence (highest rank) must be kept');
  assert.strictEqual(input.length, 5, 'input array must not be mutated');
});

// BD16: dedup fails closed on invalid identity
test('BD16 dedup fails closed on invalid identity', () => {
  const invalidInputs = [
    [candidate({ source_id: '' })],
    [candidate({ source_type: '' })],
    [candidate({ source_id: undefined })],
    [candidate({ source_type: null })],
    [null],
    'not-an-array',
  ];
  for (const invalid of invalidInputs) {
    assert.throws(
      () => deduplicateCandidates(invalid),
      (e) => e instanceof BudgetError && e.code === BUDGET_ERROR_CODES.INVALID_CANDIDATE_IDENTITY,
      'invalid identity must fail closed'
    );
  }
});

// BD17: retrieval budget greedy fill deterministic (pinned split)
test('BD17 retrieval budget greedy fill deterministic', () => {
  const candidates = [
    candidate({ source_id: 'a', rank: 1, estimated_tokens: 40 }),
    candidate({ source_id: 'b', rank: 2, estimated_tokens: 70 }),
    candidate({ source_id: 'c', rank: 3, estimated_tokens: 30 }),
    candidate({ source_id: 'd', rank: 4, estimated_tokens: 10 }),
  ];
  const result = applyRetrievalBudget(candidates, 100);
  assert.deepStrictEqual(result.retrieved.map((c) => c.source_id), ['a', 'c', 'd']);
  assert.deepStrictEqual(result.omitted.map((c) => c.source_id), ['b']);
  assert.strictEqual(result.retrieved_tokens_used, 80);
  assert.strictEqual(result.remaining_tokens, 20);
  const again = applyRetrievalBudget(candidates, 100);
  assert.deepStrictEqual(again.retrieved.map((c) => c.source_id), ['a', 'c', 'd']);
  assert.deepStrictEqual(again.omitted.map((c) => c.source_id), ['b']);
});

// BD18: zero retrieval budget omits all positive-token candidates
test('BD18 zero retrieval budget omits positive-token candidates', () => {
  const candidates = [
    candidate({ source_id: 'a', estimated_tokens: 1 }),
    candidate({ source_id: 'b', estimated_tokens: 0 }),
  ];
  const result = applyRetrievalBudget(candidates, 0);
  assert.deepStrictEqual(result.retrieved.map((c) => c.source_id), ['b']);
  assert.deepStrictEqual(result.omitted.map((c) => c.source_id), ['a']);
  assert.strictEqual(result.retrieved_tokens_used, 0);
});

// BD19: invalid candidate tokens rejected
test('BD19 invalid candidate tokens rejected', () => {
  assert.throws(
    () => applyRetrievalBudget([candidate({ estimated_tokens: -1 })], 10),
    (e) => e instanceof BudgetError && e.code === BUDGET_ERROR_CODES.INVALID_CANDIDATE_TOKENS
  );
  assert.throws(
    () => applyRetrievalBudget([candidate({ estimated_tokens: 1.5 })], 10),
    (e) => e instanceof BudgetError && e.code === BUDGET_ERROR_CODES.INVALID_CANDIDATE_TOKENS
  );
  assert.throws(
    () => applyRetrievalBudget([candidate({ estimated_tokens: undefined })], 10),
    (e) => e instanceof BudgetError && e.code === BUDGET_ERROR_CODES.INVALID_CANDIDATE_TOKENS
  );
  assert.throws(
    () => applyRetrievalBudget([candidate()], -5),
    (e) => e instanceof BudgetError && e.code === BUDGET_ERROR_CODES.INVALID_BUDGET_INPUTS
  );
});

// ---------------------------------------------------------------------------
// ContextPackage
// ---------------------------------------------------------------------------

// BD20: ContextPackage required fields complete
test('BD20 ContextPackage required fields complete', () => {
  const pkg = buildContextPackage(packageParams());
  assert.deepStrictEqual(
    Object.keys(pkg).sort(),
    [...CONTEXT_PACKAGE_REQUIRED_FIELDS].sort()
  );
  assert.strictEqual(pkg.hydration_run_id, 'run-1');
  assert.strictEqual(pkg.policy_id, 'context-hydration');
  assert.strictEqual(pkg.policy_version, '1.0.1');
  assert.strictEqual(pkg.hydration_started_at, HYDRATION_STARTED_AT);
  assert.deepStrictEqual(pkg.objective, { objective_id: 'obj-1', summary: 'deterministic test objective' });
  assert.strictEqual(pkg.job_id, 'job-1');
  assert.strictEqual(pkg.session_id, 'session-1');
  assert.strictEqual(validateContextPackage(pkg), true);
});

// BD21: budget audit fields complete and exact
test('BD21 budget audit fields complete and exact', () => {
  const pkg = buildContextPackage(packageParams());
  assert.deepStrictEqual(
    Object.keys(pkg.budget).sort(),
    [...BUDGET_AUDIT_FIELDS].sort()
  );
  assert.strictEqual(pkg.budget.tokenizer_id, 'deterministic-test-tokenizer');
  assert.strictEqual(pkg.budget.context_window_tokens, 100000);
  assert.strictEqual(pkg.budget.response_headroom_tokens, 10000);
  assert.strictEqual(pkg.budget.execution_reserve_tokens, 5000);
  assert.strictEqual(pkg.budget.active_conversation_tokens, 20000);
  assert.strictEqual(pkg.budget.mandatory_context_tokens, 30000);
  assert.strictEqual(pkg.budget.available_context_tokens, 35000);
  assert.strictEqual(pkg.budget.retrieval_budget_tokens, 7000);
  assert.strictEqual(pkg.budget.retrieved_tokens_used, 10);
});

// BD22: retrieved records carry all audit fields
test('BD22 retrieved records carry audit fields', () => {
  const pkg = buildContextPackage(packageParams());
  assert.strictEqual(pkg.retrieved.length, 1);
  const record = pkg.retrieved[0];
  for (const field of RETRIEVED_AUDIT_FIELDS) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(record, field),
      `retrieved record must carry ${field}`
    );
  }
  assert.strictEqual(record.source_id, 'src-1');
  assert.strictEqual(record.source_type, 'curated');
  assert.strictEqual(record.scope, 'global');
  assert.strictEqual(record.score, 0.9);
  assert.strictEqual(record.rank, 1);
  assert.strictEqual(record.reason, 'retrieved');
  assert.deepStrictEqual(record.provenance, { origin: 'test' });
});

// BD23: package build deduplicates candidates deterministically
test('BD23 package build deduplicates candidates deterministically', () => {
  const params = packageParams({
    candidates: [
      candidate({ source_id: 'a', rank: 1, estimated_tokens: 5 }),
      candidate({ source_id: 'a', rank: 2, estimated_tokens: 5 }),
      candidate({ source_id: 'b', rank: 3, estimated_tokens: 5 }),
    ],
  });
  const pkg = buildContextPackage(params);
  assert.deepStrictEqual(pkg.retrieved.map((r) => r.source_id), ['a', 'b']);
  assert.strictEqual(pkg.retrieved[0].rank, 1);
  assert.strictEqual(pkg.retrieved[1].rank, 3);
  assert.strictEqual(pkg.budget.retrieved_tokens_used, 10);
});

// BD24: protected mandatory context preserved verbatim
test('BD24 mandatory protected context preserved verbatim', () => {
  const mandatory = [
    { source_id: 'mand-obj', source_type: 'mandatory', category: 'current_objective' },
    { source_id: 'mand-safety', source_type: 'mandatory', category: 'active_safety_constraints' },
    { source_id: 'mand-obj', source_type: 'mandatory', category: 'current_objective' },
  ];
  const params = packageParams({ mandatory, candidates: [] });
  const pkg = buildContextPackage(params);
  assert.deepStrictEqual(pkg.mandatory, mandatory, 'mandatory records must be preserved verbatim');

  // Mandatory survives even when the retrieval budget is zero.
  const zeroParams = packageParams({
    mandatory,
    candidates: [candidate({ estimated_tokens: 10 })],
    budget_inputs: validBudgetInputs({
      context_window_tokens: 40000,
      response_headroom_tokens: 5000,
      execution_reserve_tokens: 5000,
      active_conversation_tokens: 10000,
      mandatory_context_tokens: 20000,
    }),
  });
  const zeroPkg = buildContextPackage(zeroParams);
  assert.deepStrictEqual(zeroPkg.mandatory, mandatory);
  assert.strictEqual(zeroPkg.retrieved.length, 0);
  assert.strictEqual(zeroPkg.omitted.length, 1);
});

// BD25: package build fails closed on mandatory overflow
test('BD25 package build fails closed on mandatory overflow', () => {
  const params = packageParams({
    budget_inputs: validBudgetInputs({ mandatory_context_tokens: 65001 }),
  });
  assert.throws(
    () => buildContextPackage(params),
    (e) => e instanceof BudgetError && e.code === 'CONTEXT_BUDGET_EXCEEDED'
  );
});

// BD26: empty retrieval produces a valid ContextPackage (H12)
test('BD26 empty retrieval produces valid ContextPackage', () => {
  const pkg = buildContextPackage(packageParams({ candidates: [] }));
  assert.strictEqual(pkg.retrieved.length, 0);
  assert.strictEqual(pkg.omitted.length, 0);
  assert.strictEqual(pkg.budget.retrieved_tokens_used, 0);
  assert.strictEqual(validateContextPackage(pkg), true);
});

// BD27: omitted records never persist full content
test('BD27 omitted records never persist full content', () => {
  const oversized = candidate({
    source_id: 'big',
    estimated_tokens: 999999,
    content: 'FULL CONTENT MUST NOT BE PERSISTED',
    body: 'ALSO NOT PERSISTED',
    text: 'NOR THIS',
  });
  const store = createOmissionStore();
  const pkg = buildContextPackage(
    packageParams({ candidates: [oversized], omission_store: store })
  );
  assert.strictEqual(pkg.retrieved.length, 0);
  assert.strictEqual(pkg.omitted.length, 1);
  const omitted = pkg.omitted[0];
  for (const key of Object.keys(omitted)) {
    assert.ok(
      OMISSION_ALLOWED_METADATA.includes(key),
      `omitted metadata key not allowed: ${key}`
    );
  }
  assert.ok(!('content' in omitted), 'omitted metadata must not carry content');
  assert.ok(!('body' in omitted), 'omitted metadata must not carry body');
  assert.ok(!('text' in omitted), 'omitted metadata must not carry text');
  assert.throws(
    () => store.add({ ...omitted, content: 'x' }),
    (e) => e instanceof ContextPackageError && e.code === 'INVALID_OMISSION_METADATA',
    'store must reject disallowed metadata fields'
  );
});

// BD28: omission metadata allowlist exact
test('BD28 omission metadata allowlist exact', () => {
  assert.deepStrictEqual(
    [...OMISSION_ALLOWED_METADATA].sort(),
    [...policy.omission.allowed_metadata].sort()
  );
  const pkg = buildContextPackage(
    packageParams({ candidates: [candidate({ source_id: 'big', estimated_tokens: 999999 })] })
  );
  assert.deepStrictEqual(
    Object.keys(pkg.omitted[0]).sort(),
    [...OMISSION_ALLOWED_METADATA].sort()
  );
});

// BD29: omitted_at anchor and exact 30-day expiry
test('BD29 omitted_at anchor and exact 30-day expiry', () => {
  const pkg = buildContextPackage(
    packageParams({ candidates: [candidate({ source_id: 'big', estimated_tokens: 999999 })] })
  );
  const omitted = pkg.omitted[0];
  assert.strictEqual(omitted.omitted_at, HYDRATION_STARTED_AT);
  assert.strictEqual(omitted.expires_at, '2026-10-27T00:00:00.000Z');
  assert.strictEqual(Date.parse(omitted.expires_at) - Date.parse(omitted.omitted_at), RETENTION_SECONDS * 1000);
  assert.strictEqual(RETENTION_SECONDS, 2592000);
  assert.strictEqual(RETENTION_SECONDS, policy.omission.retention_seconds);
});

// BD30: metadata just before expiry remains active
test('BD30 metadata just before expiry remains active', () => {
  const pkg = buildContextPackage(
    packageParams({ candidates: [candidate({ source_id: 'big', estimated_tokens: 999999 })] })
  );
  const store = createOmissionStore();
  store.add(pkg.omitted[0]);
  const justBefore = '2026-10-26T23:59:59Z';
  assert.strictEqual(isExpired(pkg.omitted[0], justBefore), false);
  const listed = store.list(justBefore);
  assert.strictEqual(listed.length, 1);
  assert.strictEqual(listed[0].source_id, 'big');
});

// BD31: metadata at expiry boundary is expired (>= boundary)
test('BD31 metadata at expiry boundary is expired', () => {
  const pkg = buildContextPackage(
    packageParams({ candidates: [candidate({ source_id: 'big', estimated_tokens: 999999 })] })
  );
  const store = createOmissionStore();
  store.add(pkg.omitted[0]);
  assert.strictEqual(isExpired(pkg.omitted[0], '2026-10-27T00:00:00Z'), true);
  assert.strictEqual(isExpired(pkg.omitted[0], '2026-10-27T00:00:00.000Z'), true);
  assert.deepStrictEqual(store.list('2026-10-27T00:00:00Z'), []);
  assert.strictEqual(store.size('2026-10-27T00:00:00Z'), 0);
});

// BD32: metadata after expiry removed and inaccessible
test('BD32 metadata after expiry removed and inaccessible', () => {
  const pkg = buildContextPackage(
    packageParams({ candidates: [candidate({ source_id: 'big', estimated_tokens: 999999 })] })
  );
  const store = createOmissionStore();
  store.add(pkg.omitted[0]);
  const after = '2026-10-28T00:00:00Z';
  assert.strictEqual(store.purgeExpired(after), 1);
  assert.deepStrictEqual(store.list(after), []);
  assert.deepStrictEqual(store.get('run-1', after), []);
});

// BD33: expired records removed before read completes
test('BD33 expired records removed before read completes', () => {
  const store = createOmissionStore();
  store.add(omissionRecord('active', '2026-09-27T00:00:00Z')); // expires 2026-10-27
  store.add(omissionRecord('expired', '2026-08-01T00:00:00Z')); // expires 2026-08-31
  const readAt = '2026-09-27T00:00:00Z';
  const listed = store.list(readAt);
  assert.deepStrictEqual(listed.map((r) => r.source_id), ['active']);
  assert.strictEqual(store.size(readAt), 1, 'expired record must be removed by the read');
  assert.deepStrictEqual(store.get('run-x', readAt).map((r) => r.source_id), ['active']);
});

// BD34: store initialization purges expired metadata before serving
test('BD34 store initialization purges expired before serving', () => {
  const expired = omissionRecord('old', '2026-08-01T00:00:00Z'); // expires 2026-08-31
  const active = omissionRecord('new', '2026-09-27T00:00:00Z'); // expires 2026-10-27
  const store = createOmissionStore({
    records: [expired, active],
    initialization_time: '2026-09-27T00:00:00Z',
  });
  // The expired record was already inactivated at initialization.
  assert.strictEqual(store.purgeExpired('2026-09-27T00:00:00Z'), 0);
  const listed = store.list('2026-09-27T00:00:00Z');
  assert.deepStrictEqual(listed.map((r) => r.source_id), ['new']);

  // A store initialized with only expired records serves nothing.
  const emptyStore = createOmissionStore({
    records: [expired],
    initialization_time: '2026-09-27T00:00:00Z',
  });
  assert.deepStrictEqual(emptyStore.list('2026-09-27T00:00:00Z'), []);
});

// ---------------------------------------------------------------------------
// Determinism, secrets, validation
// ---------------------------------------------------------------------------

// BD35: repeated package builds are byte-identical
test('BD35 repeated package builds are byte-identical', () => {
  const makeParams = () =>
    packageParams({
      candidates: [
        candidate({ source_id: 'a', rank: 1, estimated_tokens: 5 }),
        candidate({ source_id: 'b', rank: 2, estimated_tokens: 999999 }),
        candidate({ source_id: 'a', rank: 3, estimated_tokens: 5 }),
      ],
    });
  const first = buildContextPackage(makeParams());
  const second = buildContextPackage(makeParams());
  assert.strictEqual(JSON.stringify(first), JSON.stringify(second));
});

// BD36: package contains no secret-like fields
test('BD36 package contains no secret-like fields', () => {
  const pkg = buildContextPackage(packageParams());
  const forbidden = ['password', 'token', 'secret', 'apikey', 'authorization', 'credential', 'raw_query', 'connection_string'];
  function walk(value) {
    if (value === null || typeof value !== 'object') return [];
    if (Array.isArray(value)) return value.reduce((acc, item) => acc.concat(walk(item)), []);
    return Object.keys(value).reduce(
      (acc, key) => acc.concat(
        forbidden.includes(key.toLowerCase()) ? [key] : [],
        walk(value[key])
      ),
      []
    );
  }
  assert.deepStrictEqual(walk(pkg), []);
});

// BD37: validateContextPackage fails closed on incomplete package
test('BD37 validateContextPackage fails closed on incomplete package', () => {
  const pkg = buildContextPackage(packageParams());
  const missingSession = { ...pkg };
  delete missingSession.session_id;
  assert.throws(
    () => validateContextPackage(missingSession),
    (e) => e instanceof ContextPackageError && e.code === 'INVALID_CONTEXT_PACKAGE'
  );
  const missingBudget = { ...pkg };
  delete missingBudget.budget;
  assert.throws(
    () => validateContextPackage(missingBudget),
    (e) => e instanceof ContextPackageError && e.code === 'INVALID_CONTEXT_PACKAGE'
  );
});

// BD38: invalid hydration_started_at rejected
test('BD38 invalid hydration_started_at rejected', () => {
  for (const badAnchor of ['not-a-timestamp', '2026-09-27T00:00:00+07:00', '2026-13-01T00:00:00Z', 12345]) {
    assert.throws(
      () => buildContextPackage(packageParams({ hydration_started_at: badAnchor })),
      (e) => e instanceof ContextPackageError && e.code === 'INVALID_HYDRATION_ANCHOR',
      `anchor ${String(badAnchor)} must fail closed`
    );
  }
});

// BD39: store rejects metadata with wrong expiry formula
test('BD39 store rejects metadata with wrong expiry formula', () => {
  const record = omissionRecord('x', '2026-09-27T00:00:00Z');
  const store = createOmissionStore();
  assert.throws(
    () => store.add({ ...record, expires_at: '2026-10-28T00:00:00.000Z' }),
    (e) => e instanceof ContextPackageError && e.code === 'INVALID_OMISSION_METADATA'
  );
  const incomplete = { ...record };
  delete incomplete.expires_at;
  assert.throws(
    () => store.add(incomplete),
    (e) => e instanceof ContextPackageError && e.code === 'INVALID_OMISSION_METADATA'
  );
});

// BD40: omitted metadata persisted to the store matches the package
test('BD40 omitted metadata persisted to store matches package', () => {
  const store = createOmissionStore();
  const pkg = buildContextPackage(
    packageParams({
      candidates: [candidate({ source_id: 'big', estimated_tokens: 999999 })],
      omission_store: store,
    })
  );
  const listed = store.list(HYDRATION_STARTED_AT);
  assert.deepStrictEqual(listed, pkg.omitted);
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n=== Context Hydration Budget+Dedup Test Summary ===`);
console.log(`Cases: ${passed + failed}, Passed: ${passed}, Failed: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
