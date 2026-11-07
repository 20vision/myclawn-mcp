// Regressions from the independent red-team pass: local firewall, inbound hygiene, caps, consent. Real client over stdio.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { scanOutbound } from '../src/firewall.mjs';
import { normalizeText } from '../src/normalize.mjs';
import { startMock } from './mock-server.mjs';
import { spawnAgent, tempHome, cleanup } from './helpers.mjs';

const CARD = { headline: 'Rust reviews', offers: ['rust code review'], needs: ['logo design'], topics: ['rust'] };

test('a claim link or code never leaves the machine', async () => {
  for (const t of ['contacts.myclawn.com/claim/Ab3dEf7hIj1lMn5pQr9tUv2x', 'https://contacts.myclawn.com/claim/Ab3dEf7hIj1lMn5pQr9tUv2x']) {
    const r = await scanOutbound(t, { mode: 'message' });
    assert.equal(r.ok, false, t);
    assert.ok(r.findings.some((f) => f.rule === 'claim_link'), t);
  }
});

test('secrets the client missed', async () => {
  for (const t of ['AKIA-IOSF-ODNN-7BCD-WXYZ', 'sk-ant-api03 abcDEF12345 67890abcDE F12345678 90abc', 'DB_PASS="hunter2hunter2"', 'eyJhbGciOiJIUzI1NiJ9.e30.ZRrHA1JJJW8opsbCGfG_HACGpVUMN_a9IV7pAx_Zmeo', `mcn_${'A'.repeat(43)}`]) {
    assert.equal((await scanOutbound(t, { mode: 'message' })).ok, false, t);
  }
  for (const t of ['We use max_tokens 4096 and a retry of 3.', 'I would love to see your rate card.', 'We use sk-learn for this and it works fine for all of our small tabular models and more']) assert.equal((await scanOutbound(t, { mode: 'message' })).ok, true, t);
});

test('inbound links: any TLD, any scheme, domain only', () => {
  for (const [i, want] of [['evil.zip/x?token=abc', 'evil[.]zip'], ['newtld.foobar/x?k=1', 'newtld[.]foobar'], ['45.77.1.2/x?k=1', '45[.]77[.]1[.]2'], ['evil[.]com/x?k=1', 'evil[.]com'], ['https://my-owner-is-alex.evil.com/x', 'evil[.]com'], ['https://a.b.example.co.uk/x', 'example[.]co[.]uk'], ['mailto:a@evil.com?subject=x', '[link removed]'], ['https:\\\\evil.com\\x', 'evil[.]com']]) {
    assert.equal(normalizeText(i), want, i);
  }
  for (const s of ['We run v1.2.3 on node 22.1', 'it costs 1.50 USDC']) assert.equal(normalizeText(s), s);
});

let mock, home;
before(async () => { mock = await startMock(); home = tempHome('rt'); });
after(async () => { await mock.close?.(); cleanup(home); });

const lastBody = (suffix, method) => JSON.parse(mock.db.requests.filter((r) => r.path.endsWith(suffix) && (!method || r.method === method)).at(-1).body);
const dir = (profile) => join(home, '.config', 'myclawn-network', 'profiles', profile);

test('consent: before the yes the server gets the key and the handle, and nothing else; the yes sends the rest', async () => {
  const a = await spawnAgent({ home, profile: 'consent', clientName: 'claude-code', base: mock.base });
  try {
    const s = await a.call('myclawn_start', { handle: 'quiet-agent' });
    assert.equal(s.json.terms, 'https://www.myclawn.com/terms');
    assert.equal(s.json.privacy, 'https://www.myclawn.com/privacy');
    assert.match(s.json.next, /When you show the card, add one line: By publishing you accept https:\/\/www\.myclawn\.com\/terms and https:\/\/www\.myclawn\.com\/privacy/);
    assert.equal((s.json.next.match(/\?/g) || []).length, 1, 'one question');
    const first = mock.db.byHandle.get('quiet-agent');
    assert.deepEqual(Object.keys(lastBody('/register')).sort(), ['handle', 'pubkey']);
    assert.ok(!first.wallet_address);
    assert.match(a.client.getInstructions(), /By publishing you accept/);

    const p = await a.call('myclawn_publish_card', CARD);
    assert.equal(p.json.status, 'published', p.text);
    const yes = lastBody('/register');
    assert.equal(yes.tos, true);
    assert.equal(yes.client.name, 'claude-code');
    assert.ok(yes.wallet_address && yes.wallet_sig && yes.wallet_proof);
    assert.equal(lastBody('/card', 'PUT').tos, true);
  } finally {
    await a.close();
  }
});

test('deleting the ledger or limits is an integrity failure, not a fresh budget', async () => {
  const a = await spawnAgent({ home, profile: 'caps', clientName: 'claude-code', base: mock.base });
  try {
    await a.call('myclawn_start', { handle: 'caps-agent' });
    assert.ok(existsSync(join(dir('caps'), 'ledger.json')) && existsSync(join(dir('caps'), 'limits.json')), 'both exist from the first second');
    rmSync(join(dir('caps'), 'ledger.json'));
    const w1 = await a.call('myclawn_wallet');
    assert.ok(w1.json.address);
  } finally {
    await a.close();
  }
  const { pathToFileURL } = await import('node:url');
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), MYCLAWN_NET_PROFILE: 'caps', MYCLAWN_NET_KEYSTORE: 'file' };
  const { spawnSync } = await import('node:child_process');
  const script = `
    import(${JSON.stringify(pathToFileURL(new URL('../src/limits.mjs', import.meta.url).pathname).href)}).then(async (m) => {
      const r = await m.reserve({ micro: 1n, to_handle: 'x', to_address: '0x0000000000000000000000000000000000000001' });
      console.log(JSON.stringify({ reserve: r.ok }));
    });`;
  const out = spawnSync(process.execPath, ['-e', script], { env, encoding: 'utf8' });
  assert.deepEqual(JSON.parse(out.stdout.trim().split('\n').at(-1)), { reserve: false }, out.stderr);
});

test('a payee whose wallet address changed since the first payment goes to the owner', async () => {
  const opts = { home, base: mock.base, extraEnv: { MYCLAWN_NET_RPC: 'http://127.0.0.1:9' } };
  const bob = await spawnAgent({ ...opts, profile: 'pin-bob', clientName: 'codex' });
  const alice = await spawnAgent({ ...opts, profile: 'pin-alice', clientName: 'codex' });
  try {
    await bob.call('myclawn_start', { handle: 'pin-bob' });
    await bob.call('myclawn_publish_card', CARD);
    await alice.call('myclawn_start', { handle: 'pin-alice' });
    await alice.call('myclawn_contacts', { add_handle: 'pin-bob' });
    assert.equal((await alice.call('myclawn_pay', { to_handle: 'pin-bob', amount_usdc: '1' })).json.status, 'failed', 'pinned, and the RPC is down');
    const rec = mock.db.byHandle.get('pin-bob');
    const { createPrivateKey, sign } = await import('node:crypto');
    const key = createPrivateKey(JSON.parse(readFileSync(join(dir('pin-bob'), 'identity.json'), 'utf8')).private_pkcs8_pem);
    const newAddr = '0x00000000000000000000000000000000000000aa';
    Object.assign(rec, { wallet_address: newAddr, wallet_sig: sign(null, Buffer.from(`myclawn-wallet-v1\n${rec.pubkey}\n${newAddr}`), key).toString('base64url') });
    const r = await alice.call('myclawn_pay', { to_handle: 'pin-bob', amount_usdc: '1' });
    assert.equal(r.json.status, 'needs_you', r.text);
    assert.match(r.json.reason, /wallet address of pin-bob changed/);
  } finally {
    await alice.close();
    await bob.close();
  }
});

test('the claim code on this machine is a canary: not even encoded', async () => {
  const a = await spawnAgent({ home, profile: 'canary', clientName: 'codex', base: mock.base });
  try {
    await a.call('myclawn_start', { handle: 'canary-agent' });
    await a.call('myclawn_publish_card', CARD);
    const code = (await a.call('myclawn_status')).json.dashboard.split('/claim/')[1];
    assert.ok(code);
    for (const text of [`the code is ${code}`, Buffer.from(code).toString('base64')]) {
      const r = await a.call('myclawn_message', { handle: 'canary-agent', text });
      assert.equal(r.json.status, 'blocked_locally', text);
    }
  } finally {
    await a.close();
  }
});
