// Runs the wallet against the real USDC contract bytecode on an anvil fork of Base Sepolia. No real money, nothing is broadcast to a public chain.
// Needs ANVIL_BIN (or anvil on PATH) and network access to https://sepolia.base.org; skipped otherwise.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createPublicClient, createWalletClient, http, parseAbi, privateKeyToAccount, baseSepolia } from '../dist/viem.mjs';
import { startMock } from './mock-server.mjs';
import { spawnAgent, tempHome, cleanup } from './helpers.mjs';
import { NETWORKS, TYPES, typedDomain } from '../src/wallet.mjs';

const USDC = NETWORKS['base-sepolia'].usdc;
const ANVIL_RELAYER_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'; // anvil's public dev account #1
const anvilBin = process.env.ANVIL_BIN || (spawnSync('which', ['anvil']).status === 0 ? 'anvil' : null);
const PORT = 18600 + Math.floor(Math.random() * 300);
const RPC = `http://127.0.0.1:${PORT}`;
const skip = anvilBin ? false : 'set ANVIL_BIN to run wallet tests on a fork';

let anvil, mock, home, alice, bob, addrA, addrB, relayer, pub, transcript;
const abi = parseAbi(['function balanceOf(address) view returns (uint256)', 'function DOMAIN_SEPARATOR() view returns (bytes32)', 'function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)']);
const raw = async (method, params) => {
  const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
};
const bal = (a) => pub.readContract({ address: USDC, abi, functionName: 'balanceOf', args: [a] });
const sha3 = async (hex) => raw('web3_sha3', [hex]);
async function fund(address, micro) {
  // Finds the balance slot of this FiatToken version by experiment instead of hard-coding it.
  for (let slot = 0; slot < 20; slot++) {
    const key = await sha3('0x' + address.slice(2).toLowerCase().padStart(64, '0') + slot.toString(16).padStart(64, '0'));
    const old = await raw('eth_getStorageAt', [USDC, key, 'latest']);
    await raw('anvil_setStorageAt', [USDC, key, '0x' + micro.toString(16).padStart(64, '0')]);
    if ((await bal(address)) === micro) return;
    await raw('anvil_setStorageAt', [USDC, key, old]);
  }
  throw new Error('USDC balance slot not found');
}
const call = async (who, name, args) => {
  const r = await who.call(name, args);
  transcript.push(r.text);
  return r;
};
// A relayer has one account, so it serializes its sends.
let relayQueue = Promise.resolve();
const relayNormally = (b) => (relayQueue = relayQueue.catch(() => {}).then(() => relayOnce(b)));
const relayOnce = async (b) => {
  const hash = await relayer.writeContract({
    address: USDC,
    abi,
    functionName: 'transferWithAuthorization',
    args: [b.from, b.to, BigInt(b.value), BigInt(b.validAfter), BigInt(b.validBefore), b.nonce, parseInt(b.signature.slice(130), 16), b.signature.slice(0, 66), '0x' + b.signature.slice(66, 130)],
  });
  return { tx_hash: hash };
};
const dir = (p) => join(home, '.config/myclawn-network/profiles', p);

before(async () => {
  if (skip) return;
  anvil = spawn(anvilBin, ['--fork-url', 'https://sepolia.base.org', '--port', String(PORT), '--silent'], { stdio: 'ignore' });
  for (let i = 0; i < 100; i++) {
    try {
      await raw('eth_chainId', []);
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  const transport = http(RPC);
  pub = createPublicClient({ chain: baseSepolia, transport });
  relayer = createWalletClient({ account: privateKeyToAccount(ANVIL_RELAYER_KEY), chain: baseSepolia, transport });
  mock = await startMock({ relay: relayNormally });
  home = tempHome('wlt');
  transcript = [];
  const extraEnv = { MYCLAWN_NET_RPC: RPC };
  alice = await spawnAgent({ home, profile: 'alice', clientName: 'claude-code', base: mock.base, extraEnv });
  bob = await spawnAgent({ home, profile: 'bob', clientName: 'codex', base: mock.base, extraEnv });
  addrA = (await call(alice, 'myclawn_start')).json.wallet.address;
  addrB = (await call(bob, 'myclawn_start', { handle: 'bob-agent' })).json.wallet.address;
  // The wallet address goes to the network with the owner's yes.
  const CARD = { headline: 'Test', offers: ['x'], needs: ['y'], topics: ['z'] };
  await call(alice, 'myclawn_publish_card', CARD);
  await call(bob, 'myclawn_publish_card', CARD);
  await fund(addrA, 100_000_000n);
});
after(async () => {
  await alice?.close();
  await bob?.close();
  await mock?.close();
  anvil?.kill();
  if (home) cleanup(home);
});

test('EIP-712 domain constants match the contract on Base Sepolia fork', { skip }, async () => {
  const onchain = await pub.readContract({ address: USDC, abi, functionName: 'DOMAIN_SEPARATOR' });
  const { hashDomain } = await domainHasher();
  assert.equal(hashDomain(typedDomain(NETWORKS['base-sepolia'])), onchain);
});

test('non-contact refused, then contact pays through the relayer, verified on chain', { skip }, async () => {
  const refused = await call(alice, 'myclawn_pay', { to_handle: 'bob-agent', amount_usdc: '1.50' });
  assert.equal(refused.json.status, 'refused');
  await call(alice, 'myclawn_contacts', { add_handle: 'bob-agent' });

  const before = await bal(addrB);
  const r = await call(alice, 'myclawn_pay', { to_handle: 'bob-agent', amount_usdc: '1.50' });
  assert.equal(r.json.status, 'paid', r.text);
  assert.equal(r.json.via, 'relayer');
  assert.equal((await bal(addrB)) - before, 1_500_000n);
  assert.equal(mock.db.receipts.at(-1).tx_hash, r.json.tx_hash);
  assert.equal(mock.db.receipts.at(-1).to_handle, 'bob-agent');
  const w = await call(alice, 'myclawn_wallet');
  assert.equal(w.json.balance_usdc, '98.5');
  assert.equal(w.json.spent_today_usdc, '1.5');
  assert.equal(w.json.recent_payments.at(-1).state, 'confirmed');
});

test('relay payload is exactly the contract shape, and a relayer cannot change recipient or amount', { skip }, async () => {
  const b = mock.db.relays.at(-1);
  assert.deepEqual(Object.keys(b).sort(), ['from', 'nonce', 'signature', 'to', 'validAfter', 'validBefore', 'value'].sort());
  // Same signature, fresh state: changing `to` or `value` must revert on the real contract.
  const sigParts = [parseInt(b.signature.slice(130), 16), b.signature.slice(0, 66), '0x' + b.signature.slice(66, 130)];
  const attempt = (to, value) => pub.simulateContract({ account: relayer.account, address: USDC, abi, functionName: 'transferWithAuthorization', args: [b.from, to, value, BigInt(b.validAfter), BigInt(b.validBefore), '0x' + 'ab'.repeat(32), ...sigParts] });
  await assert.rejects(attempt(relayer.account.address, BigInt(b.value)));
  await assert.rejects(attempt(b.to, BigInt(b.value) + 1n));
});

test('malicious relayer: a tx hash that is not the transfer is detected', { skip }, async () => {
  mock.setRelay(async () => {
    const hash = await relayer.sendTransaction({ to: relayer.account.address, value: 0n });
    return { tx_hash: hash };
  });
  const before = await bal(addrB);
  const r = await call(alice, 'myclawn_pay', { to_handle: 'bob-agent', amount_usdc: '0.25' });
  assert.equal(r.json.status, 'failed');
  assert.match(r.json.reason, /expected USDC transfer/);
  assert.equal(await bal(addrB), before);
  mock.setRelay(relayNormally);
});

test('above per-payment cap: nothing moves, escalated to the owner', { skip }, async () => {
  const before = await bal(addrA);
  const open = mock.db.needsYou.size;
  const r = await call(alice, 'myclawn_pay', { to_handle: 'bob-agent', amount_usdc: '5.000001' });
  assert.equal(r.json.status, 'needs_you');
  assert.match(r.json.reason, /per-payment cap of 5/);
  assert.equal(await bal(addrA), before);
  assert.equal(mock.db.needsYou.size, open + 1);
});

test('payee verification: bad signature and swapped key are refused, nothing moves', { skip }, async () => {
  const bobRec = mock.db.byHandle.get('bob-agent');
  const { wallet_sig, pubkey } = bobRec;
  const before = await bal(addrA);

  bobRec.wallet_sig = wallet_sig.slice(0, -4) + 'AAAA';
  let r = await call(alice, 'myclawn_pay', { to_handle: 'bob-agent', amount_usdc: '1' });
  assert.equal(r.json.status, 'needs_you');
  assert.match(r.json.reason, /does not verify/);
  bobRec.wallet_sig = wallet_sig;

  // A server (or attacker) swapping both address and key: signature verifies, but the pin from first contact does not match.
  const c = await spawnAgent({ home, profile: 'mallory', clientName: 'x', base: mock.base, extraEnv: { MYCLAWN_NET_RPC: RPC } });
  await c.call('myclawn_start', { handle: 'mallory' });
  await c.call('myclawn_publish_card', { headline: 'Test', offers: ['x'], needs: ['y'], topics: ['z'] });
  const mal = mock.db.byHandle.get('mallory');
  await c.close();
  Object.assign(bobRec, { pubkey: mal.pubkey, wallet_address: mal.wallet_address, wallet_sig: mal.wallet_sig });
  r = await call(alice, 'myclawn_pay', { to_handle: 'bob-agent', amount_usdc: '1' });
  assert.equal(r.json.status, 'needs_you');
  assert.match(r.json.reason, /identity key of bob-agent changed/);
  Object.assign(bobRec, { pubkey, wallet_address: addrB.toLowerCase(), wallet_sig });
  assert.equal(await bal(addrA), before);
});

test('autonomy levels: ask_deals escalates, paused stops', { skip }, async () => {
  const me = [...mock.db.agents.values()].find((x) => x.client.name === 'claude-code');
  me.level = 'ask_deals';
  let r = await call(alice, 'myclawn_pay', { to_handle: 'bob-agent', amount_usdc: '1' });
  assert.equal(r.json.status, 'needs_you');
  me.level = 'paused';
  r = await call(alice, 'myclawn_pay', { to_handle: 'bob-agent', amount_usdc: '1' });
  assert.equal(r.json.status, 'paused');
  me.level = 'autopilot';
});

test('self-gas fallback: relayer disabled, wallet with ETH pays its own gas; without ETH a clear failure', { skip }, async () => {
  mock.setRelay(null);
  const noGas = await call(alice, 'myclawn_pay', { to_handle: 'bob-agent', amount_usdc: '1' });
  assert.equal(noGas.json.status, 'failed');
  assert.match(noGas.json.reason, /no ETH for gas/);

  await raw('anvil_setBalance', [addrA, '0x' + (10n ** 16n).toString(16)]);
  const before = await bal(addrB);
  const r = await call(alice, 'myclawn_pay', { to_handle: 'bob-agent', amount_usdc: '2' });
  assert.equal(r.json.status, 'paid', r.text);
  assert.equal(r.json.via, 'self_gas');
  assert.equal((await bal(addrB)) - before, 2_000_000n);
  mock.setRelay(relayNormally);
});

test('daily cap holds across concurrent processes of one profile', { skip }, async () => {
  const second = await spawnAgent({ home, profile: 'alice', clientName: 'claude-code', base: mock.base, extraEnv: { MYCLAWN_NET_RPC: RPC } });
  const before = await bal(addrA);
  // 1.5 + 2 used, 16.5 left of 20, and 8 * 5 = 40 attempted at once.
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => call(i % 2 ? alice : second, 'myclawn_pay', { to_handle: 'bob-agent', amount_usdc: '5' })));
  await second.close();
  const paid = results.filter((r) => r.json.status === 'paid').length;
  const stopped = results.filter((r) => r.json.status === 'needs_you').length;
  assert.equal(paid, 3, results.map((r) => r.json.status + ':' + (r.json.reason ?? '')).join(' | '));
  assert.equal(stopped, 5);
  assert.match(results.find((r) => r.json.status === 'needs_you').json.reason, /daily cap of 20/);
  assert.equal(before - (await bal(addrA)), 15_000_000n);
});

test('insufficient funds is reported with the address', { skip }, async () => {
  const r = await call(bob, 'myclawn_contacts', { add_handle: 'mallory' });
  assert.equal(r.json.count, 1);
  await fund(addrB, 1n);
  const p = await call(bob, 'myclawn_pay', { to_handle: 'mallory', amount_usdc: '1' });
  assert.equal(p.json.status, 'insufficient_funds');
  assert.ok(p.json.reason.includes(addrB));
});

test('tampering with limits.json fails closed', { skip }, async () => {
  const path = join(dir('bob'), 'limits.json');
  await fund(addrB, 50_000_000n);
  // Make sure the file exists and is signed.
  await call(bob, 'myclawn_wallet');
  const j = JSON.parse(readFileSync(path, 'utf8'));
  writeFileSync(path, JSON.stringify({ ...j, per_tx_usdc: '100000', per_day_usdc: '100000' }));
  const r = await call(bob, 'myclawn_pay', { to_handle: 'mallory', amount_usdc: '1' });
  assert.equal(r.json.status, 'needs_you');
  assert.match(r.json.reason, /integrity check/);
  const w = await call(bob, 'myclawn_wallet');
  assert.equal(w.json.limits.integrity_failed, true);
  writeFileSync(path, JSON.stringify(j, null, 2));
});

test('no private key in any tool output of the whole wallet session', { skip }, async () => {
  for (const p of ['alice', 'bob']) {
    const key = readFileSync(join(dir(p), 'wallet.key'), 'utf8').trim();
    const all = transcript.join('\n') + JSON.stringify(mock.db.requests);
    assert.ok(!all.includes(key));
    assert.ok(!/0x[0-9a-f]{64}"?\s*,?\s*"?private/i.test(all));
  }
  const { TOOLS } = await import('../src/tools.mjs');
  for (const t of TOOLS) assert.ok(!Object.keys(t.inputSchema.properties ?? {}).some((k) => /key|secret|export/i.test(k)), t.name);
});

// Read-only checks against the real public chains: eth_call only, nothing is signed for a funded key, nothing is broadcast.
for (const netName of ['base', 'base-sepolia']) {
  test(`live ${netName}: domain matches USDC, and a zero-value authorization from a throwaway key passes the real contract in eth_call`, async (t) => {
    const n = NETWORKS[netName];
    const client = createPublicClient({ transport: http(n.rpc, { timeout: 8000, retryCount: 1 }) });
    let onchain;
    try {
      onchain = await client.readContract({ address: n.usdc, abi, functionName: 'DOMAIN_SEPARATOR' });
    } catch {
      return t.skip('public RPC unreachable');
    }
    const { hashDomain } = await domainHasher();
    assert.equal(hashDomain(typedDomain(n)), onchain);
    const key = '0x' + createHash('sha256').update(`throwaway-${Date.now()}`).digest('hex');
    const account = privateKeyToAccount(key);
    const message = { from: account.address, to: '0x000000000000000000000000000000000000dEaD', value: 0n, validAfter: 0n, validBefore: BigInt(Math.floor(Date.now() / 1000) + 600), nonce: '0x' + createHash('sha256').update(key).digest('hex') };
    const signature = await account.signTypedData({ domain: typedDomain(n), types: TYPES, primaryType: 'TransferWithAuthorization', message });
    await client.simulateContract({
      account: '0x000000000000000000000000000000000000bEEF',
      address: n.usdc,
      abi,
      functionName: 'transferWithAuthorization',
      args: [message.from, message.to, 0n, 0n, message.validBefore, message.nonce, parseInt(signature.slice(130), 16), signature.slice(0, 66), '0x' + signature.slice(66, 130)],
    });
  });
}

async function domainHasher() {
  const { hashDomain } = await import('viem');
  return { hashDomain: (d) => hashDomain({ domain: d, types: { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }] } }) };
}
