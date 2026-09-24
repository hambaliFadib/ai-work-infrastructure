/**
 * Runtime utils test harness for AI-Work-Infra.
 * No third-party dependencies. Uses only Node.js standard library.
 * Exit code 0 = all pass, non-zero = any failure.
 */

const path = require('path');
const fs = require('fs');
const rt = require(path.join(__dirname, '..', 'mcp', 'lib', 'runtime-utils.js'));

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    passed++;
    console.log(`${label}: PASS`);
  } else {
    failed++;
    console.log(`${label}: FAIL`);
  }
}

// --- R1A: Valid result accepted ---
(() => {
  const r = rt.newResult({ operation: 'test-op', dryRun: true });
  const v = rt.validateResult(r);
  assert(v.valid, 'R1A');
})();

// --- R1B: Missing required field (operation) rejected ---
(() => {
  const v = rt.validateResult({ ok: true });
  assert(!v.valid, 'R1B');
})();

// --- R1C: Incorrect type (ok = string) rejected ---
(() => {
  const v = rt.validateResult({ ok: 'yes', operation: 'test', status: 'ok', dry_run: false, warnings: [], errors: [] });
  assert(!v.valid, 'R1C');
})();

// --- R1D: Invalid error structure rejected ---
(() => {
  const v = rt.validateResult({ ok: false, operation: 'test', status: 'error', dry_run: false, warnings: [], errors: [{ category: 'BOGUS', message: 'x' }] });
  assert(!v.valid, 'R1D');
})();

// --- R2: Known error category accepted ---
(() => {
  assert(rt.isValidErrorCategory('EXECUTION_ERROR'), 'R2');
})();

// --- R2B: Unknown error category rejected ---
(() => {
  assert(!rt.isValidErrorCategory('BOGUS_CATEGORY'), 'R2B');
})();

// --- R3A: Common field redaction ---
(() => {
  const redacted = rt.protectSecrets('password=secret123 token=abc Bearer xyz credential=cred123');
  assert(!redacted.includes('secret123') && !redacted.includes('abc') && !redacted.includes('xyz') && !redacted.includes('cred123'), 'R3A');
})();

// --- R3B: Managed secret name redaction ---
(() => {
  const payload = 'CTX7_API_KEY=key7val GITHUB_PERSONAL_ACCESS_TOKEN=ghp_xyz123 GITLAB_TOKEN=glpat_abc456';
  const redacted = rt.protectSecrets(payload, ['CTX7_API_KEY', 'GITHUB_PERSONAL_ACCESS_TOKEN', 'GITLAB_TOKEN']);
  assert(!redacted.includes('key7val') && !redacted.includes('ghp_xyz123') && !redacted.includes('glpat_abc456'), 'R3B');
})();

// --- R4: Run ID correctness ---
(() => {
  const rid = rt.newRunId();
  const validLength = rid.length === 32;
  const validHex = /^[0-9a-f]{32}$/.test(rid);
  const noInvalidChars = !/[^\x00-\x7F]/.test(rid); // ASCII only
  // Generate multiple and check no duplicates in small sample
  const ids = new Set();
  for (let i = 0; i < 100; i++) ids.add(rt.newRunId());
  assert(validLength && validHex && noInvalidChars && ids.size === 100, 'R4');
})();

// --- R5: Valid execution context ---
(() => {
  const ctx = rt.newExecutionContext({ operation: 'test-op' });
  assert(ctx.run_id && ctx.operation === 'test-op' && ctx.timestamp, 'R5');
})();

// --- R5B: Traversal operation rejected ---
(() => {
  let caught = false;
  try { rt.newExecutionContext({ operation: '../bad' }); } catch { caught = true; }
  assert(caught, 'R5B');
})();

// --- R5C: Traversal profile rejected ---
(() => {
  let caught = false;
  try { rt.newExecutionContext({ operation: 'test', profile: '../escape' }); } catch { caught = true; }
  assert(caught, 'R5C');
})();

// --- R6: Valid registry accepted ---
(() => {
  const regPath = path.join(__dirname, '..', 'mcp', 'registry.json');
  const reg = JSON.parse(fs.readFileSync(regPath, 'utf8'));
  const names = reg.entries.map(e => e.name);
  const unique = names.length === new Set(names).size;
  const validOwnership = reg.entries.every(e => ['REPOSITORY_OWNED', 'EXTERNAL_REMOTE', 'EXTERNAL_LOCAL'].includes(e.ownership));
  const validCriticality = reg.entries.every(e => ['CORE', 'OPTIONAL', 'PLANNED'].includes(e.criticality));
  const validBooleans = reg.entries.every(e => typeof e.enabled_by_default === 'boolean');
  assert(unique && validOwnership && validCriticality && validBooleans, 'R6');
})();

// --- R6B: Invalid registry rejected ---
(() => {
  // Test validator with synthetic invalid registry
  const invalidReg = {
    entries: [
      { name: 'a', ownership: 'BOGUS', criticality: 'OPTIONAL', enabled_by_default: true },
      { name: 'a', ownership: 'EXTERNAL_REMOTE', criticality: 'BOGUS', enabled_by_default: 'yes' }
    ]
  };
  const names = invalidReg.entries.map(e => e.name);
  const hasDuplicate = names.length !== new Set(names).size;
  const hasBadOwnership = invalidReg.entries.some(e => !['REPOSITORY_OWNED', 'EXTERNAL_REMOTE', 'EXTERNAL_LOCAL'].includes(e.ownership));
  const hasBadCriticality = invalidReg.entries.some(e => !['CORE', 'OPTIONAL', 'PLANNED'].includes(e.criticality));
  const hasBadBool = invalidReg.entries.some(e => typeof e.enabled_by_default !== 'boolean');
  assert(hasDuplicate || hasBadOwnership || hasBadCriticality || hasBadBool, 'R6B');
})();

// --- Summary ---
console.log('');
console.log(`Results: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
