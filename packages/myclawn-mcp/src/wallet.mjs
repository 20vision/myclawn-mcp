// Non-custodial USDC wallet on Base. The key is generated here, encrypted here, used here. No server ever sees it and no MCP tool returns it.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { file, readJson, writeSecure, withLock, tightenPerms } from './store.mjs';
import { getMasterKey, keystoreKind } from './keystore.mjs';
import { addCanary } from './firewall.mjs';
import { walletBindingMessage } from './identity.mjs';

export const NETWORKS = {
  base: { key: 'base', chainId: 8453, usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', rpc: 'https://mainnet.base.org', explorer: 'https://basescan.org', domain: { name: 'USD Coin', version: '2' } },
  'base-sepolia': { key: 'base-sepolia', chainId: 84532, usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', rpc: 'https://sepolia.base.org', explorer: 'https://sepolia.basescan.org', domain: { name: 'USDC', version: '2' } },
};

export function network() {
  const n = NETWORKS[process.env.MYCLAWN_NET_CHAIN || 'base'];
  if (!n) throw new Error('MYCLAWN_NET_CHAIN must be base or base-sepolia');
  return { ...n, rpc: process.env.MYCLAWN_NET_RPC || n.rpc };
}

export const viem = () => import('../dist/viem.mjs');
const AAD = Buffer.from('myclawn-wallet-v1');

function encrypt(master, plain) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', master, iv);
  c.setAAD(AAD);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return { iv: iv.toString('hex'), tag: c.getAuthTag().toString('hex'), ct: ct.toString('hex') };
}

function decrypt(master, box) {
  const d = createDecipheriv('aes-256-gcm', master, Buffer.from(box.iv, 'hex'));
  d.setAAD(AAD);
  d.setAuthTag(Buffer.from(box.tag, 'hex'));
  return Buffer.concat([d.update(Buffer.from(box.ct, 'hex')), d.final()]).toString('utf8');
}

export function walletInfo() {
  const path = file('wallet.json');
  if (!existsSync(path)) return null;
  tightenPerms(path);
  const j = readJson(path);
  return { address: j.address, keystore: keystoreKind() };
}

export async function loadOrCreateWallet() {
  const have = walletInfo();
  if (have) return { ...have, created: false };
  return withLock('wallet', async () => {
    const again = walletInfo();
    if (again) return { ...again, created: false };
    const { generatePrivateKey, privateKeyToAccount } = await viem();
    const key = generatePrivateKey();
    const account = privateKeyToAccount(key);
    const master = await getMasterKey();
    writeSecure(file('wallet.json'), { v: 1, address: account.address, box: encrypt(master, key) });
    addCanary(key);
    await (await import('./limits.mjs')).initLocalFiles();
    return { address: account.address, keystore: keystoreKind(), created: true };
  });
}

// Internal only. Callers: signing below, canary registration, and the TTY-gated `wallet export`.
export async function unsealPrivateKey() {
  const j = readJson(file('wallet.json'));
  if (!j) throw new Error('No wallet yet');
  const key = decrypt(await getMasterKey(), j.box);
  addCanary(key);
  return key;
}

export async function signWalletBinding(identity, address) {
  return identity.sign(walletBindingMessage(identity.pubkey, address));
}

// The address agreeing to the binding, so nobody can list a stranger's wallet as their own.
export async function signWalletProof(identity, address) {
  const { privateKeyToAccount } = await viem();
  const account = privateKeyToAccount(await unsealPrivateKey());
  if (account.address.toLowerCase() !== String(address).toLowerCase()) throw new Error('This wallet key does not match that address');
  return account.signMessage({ message: walletBindingMessage(identity.pubkey, address) });
}

async function rpc(method, params, { timeoutMs = 6000 } = {}) {
  const res = await fetch(network().rpc, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const j = await res.json();
  if (j.error) throw new Error(`RPC error: ${j.error.message}`);
  return j.result;
}

// balanceOf without loading viem, so myclawn_status stays instant.
export async function balances(address) {
  const n = network();
  const data = '0x70a08231' + address.slice(2).toLowerCase().padStart(64, '0');
  const [usdc, eth] = await Promise.all([rpc('eth_call', [{ to: n.usdc, data }, 'latest']), rpc('eth_getBalance', [address, 'latest'])]);
  return { usdc_micro: BigInt(usdc === '0x' ? 0 : usdc), eth_wei: BigInt(eth) };
}

export const TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
};

export const typedDomain = (n) => ({ name: n.domain.name, version: n.domain.version, chainId: n.chainId, verifyingContract: n.usdc });

// Recipient and amount are inside the signature: a relayer can only submit it or not submit it.
export async function signTransferAuthorization({ to, micro, ttlSeconds = 1800 }) {
  const { privateKeyToAccount, parseSignature } = await viem();
  const n = network();
  const account = privateKeyToAccount(await unsealPrivateKey());
  const message = {
    from: account.address,
    to,
    value: micro,
    validAfter: 0n,
    validBefore: BigInt(Math.floor(Date.now() / 1000) + ttlSeconds),
    nonce: `0x${randomBytes(32).toString('hex')}`,
  };
  const signature = await account.signTypedData({ domain: typedDomain(n), types: TYPES, primaryType: 'TransferWithAuthorization', message });
  const { r, s, v, yParity } = parseSignature(signature);
  return {
    chain_id: n.chainId,
    token: n.usdc,
    from: message.from,
    to: message.to,
    value: message.value.toString(),
    valid_after: message.validAfter.toString(),
    valid_before: message.validBefore.toString(),
    nonce: message.nonce,
    signature,
    v: Number(v ?? 27n + BigInt(yParity)),
    r,
    s,
  };
}

const TWA_ABI = 'function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)';

// Self-gas fallback: the wallet submits its own signed authorization and pays ETH for gas.
export async function submitSelfGas(auth) {
  const { createWalletClient, createPublicClient, http, parseAbi, privateKeyToAccount } = await viem();
  const n = network();
  const { base, baseSepolia } = await viem();
  const chain = n.key === 'base' ? base : baseSepolia;
  const account = privateKeyToAccount(await unsealPrivateKey());
  const transport = http(n.rpc);
  const wallet = createWalletClient({ account, chain, transport });
  const pub = createPublicClient({ chain, transport });
  const abi = parseAbi([TWA_ABI]);
  const args = [auth.from, auth.to, BigInt(auth.value), BigInt(auth.valid_after), BigInt(auth.valid_before), auth.nonce, auth.v, auth.r, auth.s];
  // One sender at a time per wallet, otherwise concurrent sessions collide on the account nonce.
  return withLock('txsend', async () => {
    const { request } = await pub.simulateContract({ account, address: n.usdc, abi, functionName: 'transferWithAuthorization', args });
    return wallet.writeContract(request);
  });
}

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

// Never trust a relayer's word: read the receipt and check token, recipient and amount ourselves.
export async function verifyOnChain(txHash, { to, micro, from, waitMs = 25000 }) {
  const n = network();
  const deadline = Date.now() + waitMs;
  for (;;) {
    let receipt = null;
    try {
      receipt = await rpc('eth_getTransactionReceipt', [txHash]);
    } catch {}
    if (receipt) {
      if (receipt.status !== '0x1') return { state: 'failed', why: 'Transaction reverted on chain.' };
      const pad = (a) => '0x' + a.slice(2).toLowerCase().padStart(64, '0');
      const hit = receipt.logs.find(
        (l) => l.address.toLowerCase() === n.usdc.toLowerCase() && l.topics[0] === TRANSFER_TOPIC && l.topics[1] === pad(from) && l.topics[2] === pad(to) && BigInt(l.data) === BigInt(micro),
      );
      return hit ? { state: 'confirmed' } : { state: 'failed', why: 'Transaction does not contain the expected USDC transfer.' };
    }
    if (Date.now() > deadline) return { state: 'submitted' };
    await new Promise((r) => setTimeout(r, 1000));
  }
}

export function explorerTx(hash) {
  return `${network().explorer}/tx/${hash}`;
}
