// Ed25519 agent identity, node:crypto only. Signs ts\nnonce\nMETHOD\npath\nsha256(body).
import { generateKeyPairSync, createPrivateKey, createPublicKey, sign, verify, createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { file, readJson, writeSecure, withLock, tightenPerms } from './store.mjs';

const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
export const b64u = (buf) => Buffer.from(buf).toString('base64url');

export async function loadOrCreateIdentity() {
  const path = file('identity.json');
  const existing = loadIdentity();
  if (existing) return existing;
  return withLock('identity', async () => {
    const again = loadIdentity();
    if (again) return again;
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(SPKI_PREFIX.length);
    writeSecure(path, { v: 1, algo: 'ed25519', pubkey: b64u(raw), private_pkcs8_pem: privateKey.export({ format: 'pem', type: 'pkcs8' }) });
    return loadIdentity();
  });
}

export function loadIdentity() {
  const path = file('identity.json');
  if (!existsSync(path)) return null;
  tightenPerms(path);
  const j = readJson(path);
  const key = createPrivateKey(j.private_pkcs8_pem);
  return { pubkey: j.pubkey, sign: (data) => b64u(sign(null, Buffer.from(data), key)), _pem: j.private_pkcs8_pem };
}

export function publicKeyFromB64u(pubkey) {
  const raw = Buffer.from(String(pubkey), 'base64url');
  if (raw.length !== 32) throw new Error('bad ed25519 public key');
  return createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
}

export function verifySig(pubkey, data, sig) {
  try {
    return verify(null, Buffer.from(data), publicKeyFromB64u(pubkey), Buffer.from(String(sig), 'base64url'));
  } catch {
    return false;
  }
}

export const sha256Hex = (data) => createHash('sha256').update(data).digest('hex');

export function canonicalRequest({ ts, nonce, method, path, body }) {
  return `${ts}\n${nonce}\n${method.toUpperCase()}\n${path}\n${sha256Hex(body ?? '')}`;
}

export function signRequest(identity, { method, path, body }) {
  const ts = String(Math.floor(Date.now() / 1000)); // unix seconds, server window +-300 s
  const nonce = randomBytes(16).toString('hex');
  return { ts, nonce, sig: identity.sign(canonicalRequest({ ts, nonce, method, path, body })) };
}

// What a peer verifies before paying: "this wallet address belongs to this Ed25519 identity".
export function walletBindingMessage(pubkey, address) {
  return `myclawn-wallet-v1\n${pubkey}\n${String(address).toLowerCase()}`;
}
