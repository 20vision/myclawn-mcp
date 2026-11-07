// Network-only mode (MYCLAWN_WALLET=off or --no-wallet), and proof the wallet only exists when asked for.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, writeFileSync, mkdirSync, chmodSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { startMock } from './mock-server.mjs';
import { spawnAgent, tempHome, cleanup, BIN } from './helpers.mjs';
import { walletEnabled } from '../src/mode.mjs';

const CARD = { headline: 'Rust reviews', offers: ['rust code review'], needs: ['landing page'], topics: ['rust'] };
const WALLET_WORDS = /wallet|usdc|\bpay|\bpaid\b|payment|crypto|escrow|\bcaps?\b/i;
const WALLET_FILES = ['wallet.json', 'wallet.key', 'limits.json', 'ledger.json', 'pins.json'];
const dirOf = (home, p) => join(home, '.config/myclawn-network/profiles', p);

let mock, home;
const open = [];
const agent = async (profile, opts = {}) => {
  const a = await spawnAgent({ home, profile, clientName: 'claude-code', base: mock.base, ...opts });
  open.push(a);
  return a;
};
before(async () => {
  mock = await startMock();
  home = tempHome('nw');
});
after(async () => {
  await Promise.all(open.map((a) => a.close()));
  await mock.close();
  cleanup(home);
});

test('the switch: only an explicit on value turns the wallet on', () => {
  for (const v of ['on', 'ON', '1', 'true', 'yes']) assert.equal(walletEnabled({ MYCLAWN_WALLET: v }), true, v);
  for (const v of [undefined, '', 'off', 'OFF', '0', 'false', 'no', 'maybe']) assert.equal(walletEnabled({ MYCLAWN_WALLET: v }), false, String(v));
});

test('a MyClawn cloud computer never gets a wallet, whatever the switch says', () => {
  for (const v of [undefined, 'on', 'true']) assert.equal(walletEnabled({ MYCLAWN_WALLET: v }, true), false, String(v));
});

for (const [how, opts] of [['default, no flag', { extraEnv: { MYCLAWN_WALLET: '' } }], ['env MYCLAWN_WALLET=off', { extraEnv: { MYCLAWN_WALLET: 'off' } }], ['flag --no-wallet', { args: [BIN, '--no-wallet'] }]]) {
  const profile = how.startsWith('env') ? 'envoff' : how.startsWith('flag') ? 'flagoff' : 'defaultoff';
  test(`${how}: no wallet tool, no wallet text, no wallet file, and the network works`, async () => {
    const a = await agent(profile, opts);
    assert.doesNotMatch(a.client.getInstructions(), WALLET_WORDS);
    const { tools } = await a.client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ['myclawn_block', 'myclawn_contacts', 'myclawn_inbox', 'myclawn_matches', 'myclawn_message', 'myclawn_needs_you', 'myclawn_publish_card', 'myclawn_search', 'myclawn_start', 'myclawn_status', 'myclawn_thread', 'myclawn_update_card']);
    assert.doesNotMatch(JSON.stringify(tools), WALLET_WORDS);

    const start = await a.call('myclawn_start');
    assert.equal(start.json.status, 'ready', start.text);
    assert.doesNotMatch(start.text, WALLET_WORDS);
    const pub = await a.call('myclawn_publish_card', CARD);
    assert.equal(pub.json.status, 'published', pub.text);
    const st = await a.call('myclawn_status');
    assert.doesNotMatch(st.text, WALLET_WORDS);
    assert.equal('wallet' in st.json, false);
    assert.equal(st.json.card.visibility, 'published');

    const stored = mock.db.agents.get(start.json.agent.agent_id);
    assert.equal(stored.wallet_address ?? null, null, 'no address went to the network');

    await assert.rejects(a.client.callTool({ name: 'myclawn_pay', arguments: { to_handle: 'nobody-here', amount_usdc: '1' } }), /Unknown tool/);
    await assert.rejects(a.client.callTool({ name: 'myclawn_wallet', arguments: {} }), /Unknown tool/);

    const files = readdirSync(dirOf(home, profile));
    for (const f of WALLET_FILES) assert.ok(!files.includes(f), `${f} must not exist, got ${files}`);
    assert.ok(files.includes('identity.json'));
  });
}

test('network-only agents and wallet agents talk, and peers\' wallet fields stop at the client', async () => {
  const on = await agent('walleton');
  const off = await agent('walletoff', { extraEnv: { MYCLAWN_WALLET: 'off' } });
  const hOn = (await on.call('myclawn_start', { handle: 'with-wallet' })).json.agent.handle;
  const hOff = (await off.call('myclawn_start', { handle: 'no-wallet' })).json.agent.handle;
  await on.call('myclawn_publish_card', CARD);
  await off.call('myclawn_publish_card', CARD);
  const m = await off.call('myclawn_message', { handle: hOn, text: 'Hello from network-only' });
  assert.equal(m.json.status, 'delivered', m.text);
  assert.equal((await on.call('myclawn_inbox')).json.new_messages, 1);
  const search = await off.call('myclawn_search', { query: 'rust' });
  assert.doesNotMatch(search.text, /wallet_|price_usdc/);
  // A wallet agent asked to pay a network-only one doesn't pay: nothing verifiable to pay to.
  await on.call('myclawn_contacts', { add_handle: hOff });
  const pay = await on.call('myclawn_pay', { to_handle: hOff, amount_usdc: '1' });
  assert.equal(pay.json.sent, false);
  assert.equal(pay.json.status, 'needs_you', pay.text);
});

test('a keychain is never touched in network-only mode, and is by default', async () => {
  const bin = join(home, 'fakebin');
  mkdirSync(bin, { recursive: true });
  const log = join(home, 'secret-tool.log');
  writeFileSync(join(bin, 'secret-tool'), `#!/bin/sh\necho "$1" >> ${log}\nexit 1\n`);
  chmodSync(join(bin, 'secret-tool'), 0o755);
  // MYCLAWN_NET_KEYSTORE '' lets the real keychain lookup run, against the fake secret-tool.
  const env = { MYCLAWN_NET_KEYSTORE: '', DBUS_SESSION_BUS_ADDRESS: 'x', PATH: `${bin}:${process.env.PATH}` };
  const off = await agent('kcoff', { extraEnv: { ...env, MYCLAWN_WALLET: 'off' } });
  await off.call('myclawn_start');
  await off.call('myclawn_publish_card', CARD);
  await off.call('myclawn_status');
  assert.equal(existsSync(log), false, 'network-only mode called secret-tool');
  if (process.platform !== 'linux') return;
  const on = await agent('kcon', { extraEnv: env });
  await on.call('myclawn_start');
  assert.ok(readFileSync(log, 'utf8').includes('lookup'), 'the probe above would have seen it');
});

test('a profile that already has a wallet: off mode leaves it alone and hides it', async () => {
  const first = await agent('switcher');
  const addr = (await first.call('myclawn_start')).json.wallet.address;
  const walletBefore = readFileSync(join(dirOf(home, 'switcher'), 'wallet.json'), 'utf8');
  await first.close();
  const off = await agent('switcher', { args: [BIN, '--no-wallet'] });
  const st = await off.call('myclawn_status');
  assert.doesNotMatch(st.text, new RegExp(addr, 'i'));
  assert.doesNotMatch(st.text, WALLET_WORDS);
  assert.equal(readFileSync(join(dirOf(home, 'switcher'), 'wallet.json'), 'utf8'), walletBefore);
});

test('asked for: all 14 tools, wallet file created', async () => {
  const a = await agent('defaulton', { args: [BIN, '--wallet'], extraEnv: { MYCLAWN_WALLET: '' } });
  const { tools } = await a.client.listTools();
  assert.equal(tools.length, 14);
  assert.ok(tools.some((t) => t.name === 'myclawn_pay') && tools.some((t) => t.name === 'myclawn_wallet'));
  assert.match(a.client.getInstructions(), /pay within caps/);
  const start = await a.call('myclawn_start');
  assert.match(start.json.wallet.address, /^0x/);
  for (const f of ['wallet.json', 'wallet.key', 'limits.json', 'ledger.json']) assert.ok(existsSync(join(dirOf(home, 'defaulton'), f)), f);
  assert.ok('wallet' in (await a.call('myclawn_status')).json);
});

test('every tool spells out title, readOnlyHint and destructiveHint, in both modes', async () => {
  for (const a of [await agent('annon'), await agent('annoff', { extraEnv: { MYCLAWN_WALLET: 'off' } })]) {
    for (const t of (await a.client.listTools()).tools) {
      assert.ok(t.annotations.title, t.name);
      assert.equal(typeof t.annotations.readOnlyHint, 'boolean', t.name);
      assert.equal(typeof t.annotations.destructiveHint, 'boolean', t.name);
    }
  }
});

test('CLI in off mode: wallet commands refuse, status and help say nothing of it', () => {
  const run = (...args) => spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), MYCLAWN_NET_PROFILE: 'cli', MYCLAWN_NET_KEYSTORE: 'file', MYCLAWN_WALLET: 'off' } });
  for (const cmd of [['wallet', 'address'], ['limits'], ['pins', 'forget', 'x'], ['plugin']]) {
    const r = run(...cmd);
    assert.equal(r.status, 2, cmd.join(' '));
    assert.match(r.stderr, /network-only/);
  }
  assert.doesNotMatch(run('status').stdout, WALLET_WORDS);
  assert.doesNotMatch(run('--help').stdout, WALLET_WORDS);
  assert.ok(!existsSync(join(dirOf(home, 'cli'), 'wallet.key')));
});
