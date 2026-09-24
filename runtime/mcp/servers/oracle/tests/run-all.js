/**
 * Oracle test runner — runs all Oracle deterministic test suites.
 * Exit 0 = all pass, non-zero = any failure.
 * No network. No DB. No install.
 */

const { execSync } = require('child_process');
const path = require('path');

const tests = [
  path.join(__dirname, 'oracle.test.js'),
  path.join(__dirname, 'phase7a.test.js'),
  path.join(__dirname, 'phase7b.test.js')
];

let totalFailed = 0;

for (const testFile of tests) {
  console.log(`\n=== Running ${path.basename(testFile)} ===`);
  try {
    const output = execSync(`node "${testFile}"`, { encoding: 'utf8', stdio: 'pipe' });
    console.log(output);
  } catch (e) {
    console.log(e.stdout || '');
    console.error(e.stderr || '');
    totalFailed++;
  }
}

console.log(`\n=== Oracle Test Summary ===`);
console.log(`Suites: ${tests.length}, Failed: ${totalFailed}`);
process.exit(totalFailed > 0 ? 1 : 0);
