const assert = require('assert');
const { spawn } = require('child_process');
const readline = require('readline');
const path = require('path');

const entrypoint = path.join(__dirname, '..', 'mcp-server.js');

function startClient() {
  const child = spawn(process.execPath, [entrypoint], {
    cwd: path.join(__dirname, '..'),
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ORACLE_LIVE_WRITE_ENABLED: 'false' }
  });
  const lines = readline.createInterface({ input: child.stdout });
  const stderr = [];
  child.stderr.on('data', data => stderr.push(data.toString()));
  const pending = [];
  lines.on('line', line => {
    if (!line.trim()) return;
    let message;
    try { message = JSON.parse(line); } catch (error) { return; }
    const waiter = pending.shift();
    if (waiter) waiter(message);
  });
  return {
    child,
    stderr,
    request(message) {
      return new Promise(resolve => {
        pending.push(resolve);
        child.stdin.write(JSON.stringify(message) + '\n');
      });
    }
  };
}

async function run() {
  const client = startClient();
  let id = 0;
  const request = (method, params = {}) => client.request({ jsonrpc: '2.0', id: ++id, method, params });
  const notification = message => client.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: message }) + '\n');

  const initialized = await request('initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'phase8c-test', version: '1.0.0' }
  });
  assert.ok(initialized.result, 'M02 initialization succeeds');
  notification('notifications/initialized');

  const listed = await request('tools/list');
  const names = listed.result.tools.map(tool => tool.name);
  assert.deepStrictEqual(names, ['oracle_health', 'oracle_read', 'oracle_insert', 'oracle_update', 'oracle_ddl'], 'M03 exact tool inventory');
  assert.ok(!names.includes('oracle_delete') && !names.includes('oracle_raw_sql') && !names.includes('oracle_execute_sql') && !names.includes('run_sql'), 'M04 forbidden tools absent');

  const health = await request('tools/call', { name: 'oracle_health', arguments: { profile: 'unknown' } });
  assert.ok(health.result && Array.isArray(health.result.content), 'M06 health handler reachable');

  for (const [name, args] of [
    ['oracle_insert', { profile: 'test', schema: 'APP', table: 'T', values: { ID: 1 }, dry_run: false }],
    ['oracle_update', { profile: 'test', schema: 'APP', table: 'T', set: { ID: 2 }, where: { ID: 1 }, dry_run: false }],
    ['oracle_ddl', { profile: 'test', action: 'CREATE_INDEX', schema: 'APP', table: 'T', dry_run: false }]
  ]) {
    const response = await request('tools/call', { name, arguments: args });
    const payload = JSON.parse(response.result.content[0].text);
    assert.strictEqual(payload.status, 'error', `${name} blocked`);
    assert.strictEqual(payload.errors[0].category, 'POLICY_BLOCKED', `${name} policy gate`);
  }

  assert.strictEqual(client.child.exitCode, null, 'M01 server remains running after startup');
  assert.strictEqual(client.stderr.join(''), '', 'M05 startup emits no connection error');
  client.child.kill();
  await new Promise(resolve => client.child.once('exit', resolve));
  assert.ok(true, 'M08 clean shutdown');
  console.log('M01: PASS');
  console.log('M02: PASS');
  console.log('M03: PASS');
  console.log('M04: PASS');
  console.log('M05: PASS');
  console.log('M06: PASS');
  console.log('M07: PASS');
  console.log('M08: PASS');
  console.log('MCP binding results: 8 passed, 0 failed');
}

run().catch(error => {
  console.error('MCP binding test failed:', error.message);
  process.exitCode = 1;
});
