// Local state: ~/.config/myclawn-network (XDG aware), dir 0700, files 0600. Profiles let several agents share a machine.
import { mkdirSync, chmodSync, readFileSync, writeFileSync, renameSync, openSync, closeSync, fsyncSync, unlinkSync, statSync, existsSync, appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { randomBytes } from 'node:crypto';

export function rootDir(env = process.env) {
  const xdg = env.XDG_CONFIG_HOME && isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : join(homedir(), '.config');
  return join(xdg, 'myclawn-network');
}

export function profileName(env = process.env) {
  const p = env.MYCLAWN_NET_PROFILE;
  if (!p || p === 'default') return 'default';
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(p)) throw new Error('MYCLAWN_NET_PROFILE may only contain letters, digits, _ and -');
  return p;
}

export function profileDir(env = process.env) {
  const name = profileName(env);
  return name === 'default' ? rootDir(env) : join(rootDir(env), 'profiles', name);
}

export function ensureDir(env = process.env) {
  const root = rootDir(env);
  const dir = profileDir(env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const d of dir === root ? [root] : [root, join(root, 'profiles'), dir]) chmodSync(d, 0o700);
  return dir;
}

export function file(name, env = process.env) {
  return join(ensureDir(env), name);
}

export function readJson(path, fallback = null) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return fallback;
    throw new Error(`Could not read ${path}: ${e.code || 'invalid JSON'}`);
  }
}

// Atomic write, always 0600. A crash leaves the old file intact, never a half-written key.
export function writeSecure(path, content) {
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  const data = typeof content === 'string' ? content : JSON.stringify(content, null, 2) + '\n';
  const fd = openSync(tmp, 'wx', 0o600);
  try {
    writeFileSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  chmodSync(path, 0o600);
}

export function appendSecure(path, line) {
  appendFileSync(path, line.endsWith('\n') ? line : line + '\n', { mode: 0o600 });
  chmodSync(path, 0o600);
}

// Repairs permissions if something widened them. Returns true if a repair was needed.
export function tightenPerms(path) {
  if (process.platform === 'win32' || !existsSync(path)) return false;
  if (statSync(path).mode & 0o077) {
    chmodSync(path, 0o600);
    return true;
  }
  return false;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Cross-process lock (two sessions of one profile must not double-create a wallet or race past the daily cap).
export async function withLock(name, fn, { timeoutMs = 15000, staleMs = 60000 } = {}) {
  const path = file(`${name}.lock`);
  const start = Date.now();
  for (;;) {
    try {
      closeSync(openSync(path, 'wx', 0o600));
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        if (Date.now() - statSync(path).mtimeMs > staleMs) unlinkSync(path);
      } catch {}
      if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for the ${name} lock`);
      await sleep(25 + Math.random() * 50);
    }
  }
  try {
    return await fn();
  } finally {
    try {
      unlinkSync(path);
    } catch {}
  }
}
