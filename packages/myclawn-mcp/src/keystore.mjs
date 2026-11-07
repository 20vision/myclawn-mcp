// Master key that encrypts the wallet at rest. OS keychain when one is really usable, otherwise a 0600 key file next to the wallet.
// File mode protects against other OS users and against the wallet file leaking alone (backups, sync), not against malware running as you.
import { spawnSync } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { file, writeSecure, tightenPerms, profileDir } from './store.mjs';

const SERVICE = 'myclawn-network';
const account = () => createHash('sha256').update(profileDir()).digest('hex').slice(0, 24);
const TIMEOUT = 4000;

function keychainBackend() {
  if (process.env.MYCLAWN_NET_KEYSTORE === 'file') return null;
  if (process.platform === 'darwin') return macBackend;
  if (process.platform === 'linux' && process.env.DBUS_SESSION_BUS_ADDRESS) {
    const probe = spawnSync('which', ['secret-tool'], { stdio: 'ignore', timeout: TIMEOUT });
    if (probe.status === 0) return secretToolBackend;
  }
  return null;
}

const secretToolBackend = {
  name: 'libsecret',
  get() {
    const r = spawnSync('secret-tool', ['lookup', 'service', SERVICE, 'account', account()], { encoding: 'utf8', timeout: TIMEOUT });
    return r.status === 0 && r.stdout ? r.stdout.trim() : null;
  },
  set(hex) {
    // Value goes over stdin, never argv.
    const r = spawnSync('secret-tool', ['store', '--label=MyClawn Network wallet key', 'service', SERVICE, 'account', account()], { input: hex, timeout: TIMEOUT });
    return r.status === 0;
  },
};

const macBackend = {
  name: 'macos-keychain',
  get() {
    const r = spawnSync('security', ['find-generic-password', '-s', SERVICE, '-a', account(), '-w'], { encoding: 'utf8', timeout: TIMEOUT });
    return r.status === 0 && r.stdout ? r.stdout.trim() : null;
  },
  set(hex) {
    // `security -i` reads the command from stdin so the key never appears in the process list.
    const r = spawnSync('security', ['-i'], { input: `add-generic-password -U -s ${SERVICE} -a ${account()} -w ${hex}\n`, timeout: TIMEOUT });
    return r.status === 0;
  },
};

let cached = null;

function fileKeyPath() {
  return file('wallet.key');
}

export async function getMasterKey() {
  if (cached) return cached;
  const path = fileKeyPath();
  if (existsSync(path)) {
    tightenPerms(path);
    cached = Buffer.from(readFileSync(path, 'utf8').trim(), 'hex');
    if (cached.length !== 32) throw new Error('wallet.key is corrupted');
    return cached;
  }
  const backend = keychainBackend();
  if (backend) {
    const got = backend.get();
    if (got) return (cached = Buffer.from(got, 'hex'));
    const hex = randomBytes(32).toString('hex');
    // Only trust the keychain after reading the value back; a locked or fake keyring must not lose the wallet.
    if (backend.set(hex) && backend.get() === hex) return (cached = Buffer.from(hex, 'hex'));
  }
  const hex = randomBytes(32).toString('hex');
  writeSecure(path, hex + '\n');
  return (cached = Buffer.from(hex, 'hex'));
}

export function keystoreKind() {
  if (existsSync(fileKeyPath())) return 'file';
  return keychainBackend()?.name ?? 'file';
}

export function _resetKeyCache() {
  cached = null;
}
