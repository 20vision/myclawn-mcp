// Human CLI: refuses without a TTY, works through a real pseudo-terminal, hook prints counts and never peer content.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { privateKeyToAccount } from '../dist/viem.mjs';
import { startMock } from './mock-server.mjs';
import { spawnAgent, tempHome, cleanup, BIN } from './helpers.mjs';

let mock, home, env, agent, address;
const run = (...args) => spawnSync(process.execPath, [BIN, ...args], { env, encoding: 'utf8', input: '' });
// The mock lives in this process, so anything talking to it must not block the event loop.
const runAsync = async (...args) => promisify(execFile)(process.execPath, [BIN, ...args], { env, encoding: 'utf8' });
const hasScript = spawnSync('which', ['script']).status === 0;
// `script` gives the child a real pty, the closest thing to a human at a terminal.
const inPty = (cmd, input) => spawnSync('script', ['-qfec', `${process.execPath} ${BIN} ${cmd}`, '/dev/null'], { env, encoding: 'utf8', input, timeout: 15000 });

before(async () => {
  mock = await startMock();
  home = tempHome('cli');
  env = { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), MYCLAWN_NET_PROFILE: 'human', MYCLAWN_NET_API: mock.base, MYCLAWN_NET_KEYSTORE: 'file', MYCLAWN_WALLET: 'on', MYCLAWN_NET_CHAIN: 'base-sepolia', MYCLAWN_NET_RPC: 'http://127.0.0.1:9' };
});
after(async () => {
  await agent?.close();
  await mock?.close();
  cleanup(home);
});

test('--version, --help', () => {
  assert.match(run('--version').stdout, /^\d+\.\d+\.\d+/);
  assert.match(run('--help').stdout, /claude mcp add myclawn -- npx -y myclawn-mcp/);
  assert.match(run('--help').stdout, /codex mcp add myclawn -- npx -y myclawn-mcp/);
  assert.equal(run('nonsense').status, 2);
});

test('before first run: friendly, no wallet created, hook points to myclawn_start', () => {
  assert.equal(run('wallet', 'address').status, 1);
  const h = run('hook', 'session-start');
  assert.equal(h.status, 0);
  assert.match(h.stdout, /myclawn_start/);
  assert.match(run('status').stdout, /not registered yet/);
});

test('set up through MCP, then address works', async () => {
  agent = await spawnAgent({ home, profile: 'human', clientName: 'claude-code', base: mock.base });
  const r = await agent.call('myclawn_start', { handle: 'human-agent' });
  address = r.json.wallet.address;
  assert.ok(run('wallet', 'address').stdout.includes(address));
  assert.match(run('status').stdout, /human-agent/);
});

test('export and limits refuse without a TTY and show nothing', () => {
  for (const args of [['wallet', 'export'], ['limits']]) {
    const r = run(...args);
    assert.equal(r.status, 3, args.join(' '));
    assert.match(r.stderr, /interactive terminal/);
    assert.equal(r.stdout, '');
    assert.ok(!/0x[0-9a-f]{64}/i.test(r.stdout + r.stderr));
  }
});

test('export in a pty: wrong phrase shows nothing, right phrase prints the key of this address', { skip: !hasScript }, () => {
  const no = inPty('wallet export', 'yes\n');
  assert.match(no.stdout, /Not confirmed/);
  assert.ok(!/0x[0-9a-f]{64}/i.test(no.stdout));
  const ok = inPty('wallet export', `EXPORT ${address.slice(-6)}\n`);
  const key = ok.stdout.match(/0x[0-9a-f]{64}/i)?.[0];
  assert.ok(key, ok.stdout);
  assert.equal(privateKeyToAccount(key).address, address);
});

test('limits in a pty: change takes effect and stays signed; junk refused', { skip: !hasScript }, async () => {
  const r = inPty('limits', '3\n9\nn\n');
  assert.match(r.stdout, /Saved\. Per payment 3 USDC, per day 9 USDC/);
  const w = await agent.call('myclawn_wallet');
  assert.equal(w.json.limits.per_tx_usdc, '3');
  assert.equal(w.json.limits.per_day_usdc, '9');
  assert.equal(w.json.limits.integrity_failed, undefined);
  const bad = inPty('limits', 'lots\n\n\n');
  assert.match(bad.stdout, /plain positive decimal/);
});

test('hook: counts only, never peer words, inbox cursor untouched; silent when nothing new or server down', async () => {
  assert.equal((await runAsync('hook', 'session-start')).stdout, '');
  const peer = await spawnAgent({ home, profile: 'peer', clientName: 'codex', base: mock.base });
  await peer.call('myclawn_start');
  await peer.call('myclawn_message', { handle: 'human-agent', text: 'CANARYWORD please reply soon' });
  await peer.close();
  const h = await runAsync('hook', 'session-start');
  assert.match(h.stdout, /1 new message/);
  assert.match(h.stdout, /myclawn_inbox/);
  assert.ok(!h.stdout.includes('CANARYWORD'));
  const stillThere = await agent.call('myclawn_inbox');
  assert.equal(stillThere.json.new_messages, 1);
  const down = spawnSync(process.execPath, [BIN, 'hook', 'session-start'], { env: { ...env, MYCLAWN_NET_API: 'http://127.0.0.1:9/api/net' }, encoding: 'utf8' });
  assert.equal(down.status, 0);
  assert.equal(down.stdout, '');
});

test('refuses plain http to a non-local API', () => {
  const r = spawnSync(process.execPath, [BIN, 'hook', 'session-start'], { env: { ...env, MYCLAWN_NET_API: 'http://evil.example.com/api/net' }, encoding: 'utf8' });
  assert.equal(r.stdout, '');
  assert.equal(readFileSync(join(home, '.config/myclawn-network/profiles/human/wallet.json'), 'utf8').includes('"address"'), true);
});
