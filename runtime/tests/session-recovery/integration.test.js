/**
 * Session Recovery v1 — Integration Test (SRCI01–SRCI32)
 *
 * Tests the runtime core modules: RecoveryObject + Checkpoint facade.
 * Validates deterministic create, idempotency, policy_ref enforcement,
 * checkpoint identity, monotonic sequences, dedup, latest-valid, and foreign access.
 *
 * Contract: governance/contracts/session-recovery-v1.md sections 4, 8
 * Policy:   governance/policies/session-recovery.json
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const MOD = require('../../session-recovery/core');
const CORE_DIR = path.resolve(__dirname, '..', '..', 'session-recovery', 'core');

let passed = 0;
let failed = 0;

function test(label, fn) {
  try { fn(); passed++; console.log(`SRCI${label}: PASS`); }
  catch (e) { failed++; console.log(`SRCI${label}: FAIL - ${e.message}`); }
}

// ============================================================================
// A. RecoveryObject Core
// ============================================================================

// SRCI01 — Create succeeds with correct fields
test('01', () => {
  const r = MOD.createSession(null, 'job-alpha', 's1');
  assert(r.ok);
  assert.strictEqual(r.record.job_id, 'job-alpha');
  assert.strictEqual(r.record.session_key, 's1');
  assert.strictEqual(r.record.current_state, 'NEW');
  assert.strictEqual(r.record.transition_seq, 0);
  assert.strictEqual(r.record.checkpoint_seq, 0);
  assert.strictEqual(r.record.policy_ref, MOD.CURRENT_POLICY_REF);
  assert.strictEqual(r.action, 'CREATED');
});

// SRCI02 — Strict schema: unknown field -> SESSION_RECOVERY_INVALID
test('02', () => {
  const err = MOD.validateRecord({
    job_id: 'j1', session_key: 's1', current_state: 'NEW',
    transition_seq: 0, checkpoint_seq: 0, policy_ref: 'session-recovery@1.0.1',
    _extra: true
  });
  assert(err && err[0].code === 'SESSION_RECOVERY_INVALID');
});

// SRCI03 — Missing field -> SESSION_RECOVERY_INVALID
test('03', () => {
  const rec = { job_id: 'j1' };
  const errors = MOD.validateRecord(rec);
  assert(errors);
  assert.strictEqual(errors[0].code, 'SESSION_RECOVERY_INVALID');
});

// SRCI04 — Invalid state value -> INVALID_RECOVERY_STATE
test('04', () => {
  const rec = { job_id:'j1', session_key:'s1', current_state:'BOGUS',
    transition_seq:0, checkpoint_seq:0, policy_ref:'session-recovery@1.0.1' };
  const err = MOD.validateRecord(rec);
  assert(err);
  assert.ok(err.some(e => e.code === 'INVALID_RECOVERY_STATE'));
});

// SRCI05 — CREATE idempotent on exact pair
test('05', () => {
  const store = [];
  let result = MOD.createSession(store, 'my-job', 'my-session');
  assert.strictEqual(result.action, 'CREATED');
  result = MOD.createSession(store, 'my-job', 'my-session');
  assert.strictEqual(result.action, 'IDEMPOTENT_REUSE');
  assert.deepStrictEqual(result.record, store[0]);
});

// SRCI06 — Immutable identity/tamper rejection
test('06', () => {
  // Valid record passes tamper check
  const valid = { job_id:'j1', session_key:'s1', current_state:'NEW',
    transition_seq:0, checkpoint_seq:0, policy_ref:'session-recovery@1.0.1' };
  const tValid = MOD.tamperCheck(valid);
  assert.ok(tValid.ok, 'valid record must pass tamper check');

  // Tampered identity (empty job_id) must fail
  const tampered = { job_id:'', session_key:'s1', current_state:'NEW',
    transition_seq:0, checkpoint_seq:0, policy_ref:'session-recovery@1.0.1' };
  const tBad = MOD.tamperCheck(tampered);
  assert.ok(!tBad.ok, 'empty job_id must fail');
});

// SRCI07 — Policy ref 1.0.1 enforced
test('07', () => {
  const rec = { job_id:'j1', session_key:'s1', current_state:'NEW',
    transition_seq:0, checkpoint_seq:0, policy_ref:'session-recovery@0.9.0' };
  const err = MOD.validateRecord(rec);
  assert(err);
  assert.strictEqual(err[0].code, 'SESSION_RECOVERY_INVALID');
});

// SRCI08 — Superseded 1.0.0 rejected with no migration
test('08', () => {
  const rec = { job_id:'j1', session_key:'s1', current_state:'NEW',
    transition_seq:0, checkpoint_seq:0, policy_ref:'session-recovery@1.0.0' };
  assert.ok(MOD.isSupersededRef(rec));
  const err = MOD.validatePersisted(rec);
  assert(err);
  assert.strictEqual(err.code, 'SESSION_RECOVERY_INVALID');
});

// SRCI09 — 100x deterministic create produces byte-identical records
test('09', () => {
  const results = [];
  for (let i = 0; i < 100; i++) {
    const r = MOD.createSession(null, 'determ-job', 'determ-sess');
    results.push(JSON.stringify(r.record));
  }
  const first = results[0];
  for (let i = 1; i < 100; i++) {
    assert.strictEqual(results[i], first);
  }
});

// SRCI10 — 100x deterministic checkpoint-id generation
test('10', () => {
  const results = [];
  for (let i = 1; i <= 100; i++) {
    results.push(MOD.deriveCheckpointId('cj', 'cs', i));
  }
  assert.strictEqual(results[0], 'job:cj:sessions:cs:checkpoint:1');
  assert.strictEqual(results[1], 'job:cj:sessions:cs:checkpoint:2');
  assert.strictEqual(results[99], 'job:cj:sessions:cs:checkpoint:100');
});

// SRCI11 — Monotonic checkpoint sequence (always +1)
test('11', () => {
  let prevSeq = 0;
  for (let seq = 1; seq <= 20; seq++) {
    const r = MOD.appendCheckpoint('mj', 'ms', seq, { data: 'payload-' + seq });
    assert(r.ok, 'append failed at seq ' + seq);
    assert.strictEqual(r.checkpoint.checkpoint_seq, seq);
    assert.strictEqual(prevSeq + 1, seq);
    prevSeq = seq;
  }
});

// SRCI12 — Checkpoint uniqueness enforced
test('12', () => {
  const ids = new Set();
  for (let i = 1; i <= 50; i++) {
    const id = MOD.deriveCheckpointId('unique-job', 'unique-sess', i);
    assert.ok(!ids.has(id), 'duplicate id at seq ' + i);
    ids.add(id);
  }
  // Different session -> different id set
  const otherId = MOD.deriveCheckpointId('unique-job', 'other-sess', 1);
  assert.ok(!ids.has(otherId), 'cross-session collision');
});

// SRCI13 — Latest valid = maximum valid seq
test('13', () => {
  const store = [
    { checkpoint_id:'c1', checkpoint_seq:1, payload_digest:'abc', job_id:'j', session_key:'s' },
    { checkpoint_id:'c5', checkpoint_seq:5, payload_digest:'xyz', job_id:'j', session_key:'s' },
    { checkpoint_id:'c3', checkpoint_seq:3, payload_digest:'def', job_id:'j', session_key:'s' }
  ];
  const res = MOD.getLatestValidCheckpoint(store);
  assert(res.ok);
  assert.strictEqual(res.checkpoint.checkpoint_id, 'c5');
  assert.strictEqual(res.checkpoint.checkpoint_seq, 5);
});

// SRCI14 — Invalid max checkpoint => CHECKPOINT_INVALID, no fallback
test('14', () => {
  const store = [
    { checkpoint_id:'ok', checkpoint_seq:1, payload_digest:'good' },
    { checkpoint_id:'bad-max', checkpoint_seq:10, payload_digest:'' } // empty digest = corrupt
  ];
  const res = MOD.verifyMaxSequenced(store);
  assert(!res.ok, 'corrupt max must fail');
  assert.strictEqual(res.code, 'CHECKPOINT_INVALID');
});

// SRCI15 — Duplicate content returns IDEMPOTENT_REPLAY, no seq consumed
test('15', () => {
  const existing = [
    { checkpoint_id:'c10', payload_digest:'payload-a-digest' }
  ];
  const dup = MOD.checkDuplicateContent('payload-a-digest', existing);
  assert(dup);
  assert.strictEqual(dup.result, 'IDEMPOTENT_REPLAY');
  assert.strictEqual(dup.consumed_seq, false);
  assert.strictEqual(dup.existing_checkpoint_id, 'c10');
});

// SRCI16 — Duplicate content returns null when unique
test('16', () => {
  const existing = [
    { checkpoint_id:'c1', payload_digest:'digest-one' },
    { checkpoint_id:'c2', payload_digest:'digest-two' }
  ];
  const result = MOD.checkDuplicateContent('digest-new', existing);
  assert.strictEqual(result, null);
});

// SRCI17 — Foreign-job rejection (via ownership check)
test('17', () => {
  const cp = { checkpoint_id:'c1', job_id:'foreign-job', session_key:'s1', payload_digest:'x' };
  const result = MOD.verifyOwnership(cp, 'owning-job', 's1');
  assert.ok(!result.ok, 'foreign job must reject');
  assert.strictEqual(result.code, 'FOREIGN_JOB_REJECT');
});

// SRCI18 — Same-job foreign-session rejection => CHECKPOINT_OWNERSHIP_MISMATCH
test('18', () => {
  const cp = { checkpoint_id:'c1', job_id:'same-job', session_key:'other-session', payload_digest:'x' };
  const result = MOD.verifyOwnership(cp, 'same-job', 'my-session');
  assert.ok(!result.ok, 'foreign session must reject');
  assert.strictEqual(result.code, 'CHECKPOINT_OWNERSHIP_MISMATCH');
});

// SRCI19 — Forbidden nondeterministic sources absent from core
test('19', () => {
  const files = fs.readdirSync(CORE_DIR).filter(f => f.endsWith('.js'));
  let found = [];
  for (const f of files) {
    const src = fs.readFileSync(path.join(CORE_DIR, f), 'utf8');
    if (/Date\.now|new\s+Date/.test(src)) found.push(f + ': uses Date');
    if (/Math\.random/.test(src)) found.push(f + ': uses Math.random');
    if (/crypto\.randomBytes|crypto\.pseudoRandomBytes/.test(src)) found.push(f + ': uses random source');
  }
  assert.strictEqual(found.length, 0, 'forbidden sources found: ' + found.join('; '));
});

// SRCI20 — Empty checkpoint store handling
test('20', () => {
  const res = MOD.getLatestValidCheckpoint([]);
  assert.ok(!res.ok, 'empty store must fail');
  assert.strictEqual(res.code, 'CHECKPOINT_INVALID');
});

// SRCI21 — Valid full store after multiple corruptions still finds latest valid
test('21', () => {
  const store = [
    { checkpoint_id:'a', checkpoint_seq:1, payload_digest:'valid-a' },
    { checkpoint_id:'b', checkpoint_seq:2, payload_digest:'valid-b' },
    { checkpoint_id:'c', checkpoint_seq:3, payload_digest:'' } // corrupt
  ];
  const res = MOD.resolveLatestValid(store);
  assert(res.ok, 'should find valid checkpoints');
  assert.strictEqual(res.checkpoint.checkpoint_id, 'b');
  assert.strictEqual(res.checkpoint.checkpoint_seq, 2);
});

// SRCI22 — Find checkpoint by id with ownership verification
test('22', () => {
  const store = [
    { checkpoint_id:'target-1', checkpoint_seq:1, job_id:'j', session_key:'s', payload_digest:'x' },
    { checkpoint_id:'other-2', checkpoint_seq:2, job_id:'j', session_key:'diff-s', payload_digest:'y' }
  ];
  let r = MOD.findCheckpointById(store, 'target-1', 'j', 's');
  assert(r.ok, 'must find target');
  assert.strictEqual(r.checkpoint.checkpoint_seq, 1);
  r = MOD.findCheckpointById(store, 'missing-id', 'j', 's');
  assert(!r.ok, 'missing id must fail');
});

// SRCI23 — All canonical states are valid in recovery_object schema
test('23', () => {
  for (const state of MOD.CANONICAL_STATES) {
    const rec = { job_id:'j1', session_key:'s1', current_state:state,
      transition_seq:0, checkpoint_seq:0, policy_ref:'session-recovery@1.0.1' };
    const err = MOD.validateRecord(rec);
    assert(!err, state + ' should be valid');
  }
});

// SRCI24 — Record with valid identity fields passes tamperCheck
test('24', () => {
  const rec = { job_id:'j1', session_key:'s1', current_state:'NEW',
    transition_seq:0, checkpoint_seq:0, policy_ref:'session-recovery@1.0.1' };
  // No idempotent_hash — should still pass (identity fields are valid)
  const t = MOD.tamperCheck(rec);
  assert.ok(t.ok, 'valid record without hash must pass tamperCheck');

  // Null record must fail
  const tNull = MOD.tamperCheck(null);
  assert.ok(!tNull.ok, 'null record must fail');
});

// SRCI25 — Job ID normalization applied correctly
test('25', () => {
  assert.strictEqual(MOD.normalizeJobId('JOB-Alpha'), 'job-alpha');
  assert.strictEqual(MOD.normalizeJobId('  job-beta  '), 'job-beta');
  let threw = false;
  try { MOD.normalizeJobId('job!inv@lid#chars'); } catch(e) { threw = true; }
  assert(threw, 'regex validation must reject invalid chars');
});

// SRCI26 — Session key treated as opaque (preserved as-is)
test('26', () => {
  const keys = ['UPPER-CASE', 'with spaces', 'with.dots', 'with_underscores', 'emoji-test'];
  for (const k of keys) {
    const result = MOD.validateSessionKey(k);
    assert.strictEqual(result, k, 'opaque key must equal input');
  }
});

// SRCI27 — DeterministicHash produces sha256 output length
test('27', () => {
  const hash = MOD.deterministicHash('test-input');
  assert.strictEqual(hash.length, 64, 'sha256 hex must be 64 chars');
  assert.ok(/^[0-9a-f]{64}$/.test(hash), 'must be lowercase hex');
});

// SRCI28 — IdentitiesMatch works for same and different pairs
test('28', () => {
  const a = { job_id:'j1', session_key:'s1' };
  const b = { job_id:'j1', session_key:'s1' };
  const c = { job_id:'j1', session_key:'s2' };
  const d = { job_id:'j2', session_key:'s1' };
  assert.ok(MOD.identitiesMatch(a, b), 'same pair must match');
  assert.ok(!MOD.identitiesMatch(a, c), 'different session must differ');
  assert.ok(!MOD.identitiesMatch(a, d), 'different job must differ');
});

// SRCI29 — AppendCheckpoint rejects seq <= 0
test('29', () => {
  const r0 = MOD.appendCheckpoint('j','s',0,{data:'x'});
  assert.ok(!r0.ok, 'seq 0 must reject');
  const rn = MOD.appendCheckpoint('j','s',-1,{data:'x'});
  assert.ok(!rn.ok, 'negative seq must reject');
  const rok = MOD.appendCheckpoint('j','s',1,{data:'x'});
  assert(rok.ok, 'seq 1 must accept');
});

// SRCI30 — Full lifecycle: create -> append checkpoints -> latest-valid
test('30', () => {
  const createResult = MOD.createSession(null, 'lf-job', 'lf-sess');
  assert(createResult.ok);
  const store = [];
  let seq = 0;
  for (let i = 0; i < 5; i++) {
    seq++;
    const cp = MOD.appendCheckpoint('lf-job', 'lf-sess', seq, { data: 'payload-'+i });
    assert(cp.ok, 'append failed at '+i);
    store.push(cp.checkpoint);
  }
  const lv = MOD.getLatestValidCheckpoint(store);
  assert(lv.ok, 'latest must succeed');
  assert.strictEqual(lv.checkpoint.checkpoint_seq, 5);
  assert.strictEqual(lv.checkpoint.checkpoint_id, 'job:lf-job:sessions:lf-sess:checkpoint:5');
});

// SRCI31 — Policy-check equivalent: scan core for forbidden patterns
test('31', () => {
  const files = fs.readdirSync(CORE_DIR).filter(f => f.endsWith('.js'));
  const src = files.map(f => fs.readFileSync(path.join(CORE_DIR, f), 'utf8')).join('\n');
  const forbidden = [/console\.log\(/, /process\.env/, /fetch\(|XMLHttpRequest/, /http:/, /https:/];
  let violations = [];
  for (const pat of forbidden) {
    if (pat.test(src)) violations.push(pat.source);
  }
  assert.strictEqual(violations.length, 0, 'forbidden patterns found: ' + violations.join(', '));
});

// SRCI32 — Verify no 9C-04 semantics leaked into the change
test('32', () => {
  const files = fs.readdirSync(CORE_DIR).filter(f => f.endsWith('.js'));
  const fullSrc = files.map(f => fs.readFileSync(path.join(CORE_DIR, f), 'utf8')).join('\n');
  // Check for operation dispatch logic (not references within contract constants)
  let found = [];
  if (/\bdispatch\s*\w*[\s\S]*?\bswitch\s*\(.*\bfrom_state/.test(fullSrc)) found.push('dispatch-switch');
  assert.strictEqual(found.length, 0, '9C-04 transition logic detected: ' + found.join(','));
});

// SRCI33 — Exact checkpoint_id format matches contract spec
test('33', () => {
  const id = MOD.deriveCheckpointId('my-job', 'my-session', 5);
  assert.strictEqual(id, 'job:my-job:sessions:my-session:checkpoint:5');
  // Verify template: job:{job_id}:sessions:{session_key}:checkpoint:{checkpoint_seq}
  const parts = id.split(':');
  assert.strictEqual(parts[0], 'job');
  assert.strictEqual(parts[1], 'my-job');
  assert.strictEqual(parts[2], 'sessions');
  assert.strictEqual(parts[3], 'my-session');
  assert.strictEqual(parts[4], 'checkpoint');
  assert.strictEqual(parts[5], '5');
});

// SRCI34 — DeriveCheckpointId rejects seq 0 or negative
test('34', () => {
  assert.throws(() => MOD.deriveCheckpointId('j', 's', 0));
  assert.throws(() => MOD.deriveCheckpointId('j', 's', -1));
});

// SRCI35 — verifyMaxSequenced with empty/null store
test('35', () => {
  let res = MOD.verifyMaxSequenced([]);
  assert.strictEqual(res.code, 'CHECKPOINT_INVALID');
  res = MOD.verifyMaxSequenced(null);
  assert.strictEqual(res.code, 'CHECKPOINT_INVALID');
  res = MOD.verifyMaxSequenced(undefined);
  assert.strictEqual(res.code, 'CHECKPOINT_INVALID');
});

// SRCI36 — Session recovery invalid for null/undefined record
test('36', () => {
  let err = MOD.validateRecord(null);
  assert(err && err.some(e => e.code === 'VALIDATION_ERROR'));
  err = MOD.validateRecord(undefined);
  assert(err && err.some(e => e.code === 'VALIDATION_ERROR'));
  err = MOD.validateRecord('string');
  assert(err && err.some(e => e.code === 'VALIDATION_ERROR'));
});

// SRCI37 — IDEMPOTENT_REUSE returns exact same record (deep equal)
test('37', () => {
  const store = [];
  const first = MOD.createSession(store, 'reuse-job', 'reuse-session');
  assert.strictEqual(first.action, 'CREATED');
  const second = MOD.createSession(store, 'reuse-job', 'reuse-session');
  assert.strictEqual(second.action, 'IDEMPOTENT_REUSE');
  assert.deepStrictEqual(second.record, first.record);
  // Verify it's the same object reference from the store
  assert.strictEqual(second.record, store[0]);
});

// SRCI38 — Different sessions for same job are distinct records
test('38', () => {
  const store = [];
  const a = MOD.createSession(store, 'multi-sess', 'session-a');
  const b = MOD.createSession(store, 'multi-sess', 'session-b');
  assert.strictEqual(a.action, 'CREATED');
  assert.strictEqual(b.action, 'CREATED');
  assert.notDeepStrictEqual(a.record, b.record);
  assert.strictEqual(store.length, 2);
  // Idempotent per pair
  const a2 = MOD.createSession(store, 'multi-sess', 'session-a');
  assert.strictEqual(a2.action, 'IDEMPOTENT_REUSE');
  assert.strictEqual(a2.record, a.record);
});

// SRCI39 — Same session across different jobs is distinct
test('39', () => {
  const store = [];
  const a = MOD.createSession(store, 'job-alpha', 'shared-session');
  const b = MOD.createSession(store, 'job-beta', 'shared-session');
  assert.strictEqual(a.action, 'CREATED');
  assert.strictEqual(b.action, 'CREATED');
  assert.notDeepStrictEqual(a.record, b.record);
  assert.strictEqual(store.length, 2);
});

// SRCI40 — Namespace isolation: recovery artifacts under session namespace only
test('40', () => {
  // Verify the namespace template from the policy
  const id = MOD.deriveCheckpointId('ns-job', 'ns-sess', 1);
  assert.ok(id.startsWith('job:ns-job:sessions:ns-sess:'), 'checkpoint must be under session namespace');
  // Verify pair key derivation uses session namespace pattern
  const pairKey = MOD.derivePairKey('ns-job', 'ns-sess');
  assert.strictEqual(pairKey, 'ns-job:ns-sess');
  // Create via createSession - verify session namespace fields
  const result = MOD.createSession(null, 'ns-job', 'ns-sess');
  assert(result.ok);
  assert.strictEqual(result.record.job_id, 'ns-job');
  assert.strictEqual(result.record.session_key, 'ns-sess');
});

// --- Summary ---
console.log('');
console.log(`Cases: ${passed + failed}`);
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
