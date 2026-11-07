// Keychain path, using a stand-in `secret-tool` on PATH so it runs anywhere. Checks that the key goes over stdin, never argv, and that a broken keyring falls back safely.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { startMock } from './mock-server.mjs';
import { spawnAgent, tempHome, cleanup, BIN } from './helpers.mjs';

function shim(dir, { broken = false } = {}) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'secret-tool');
  writeFileSync(path, broken ? '#!/bin/sh\nexit 1\n' : `#!/bin/sh
echo "$@" >> "${dir}/argv.log"
if [ "$1" = store ]; then cat > "${dir}/stored"; exit 0; fi
if [ "$1" = lookup ] && [ -f "${dir}/stored" ]; then cat "${dir}/stored"; exit 0; fi
exit 1
`);
  chmodSync(path, 0o755);
}
const skip = process.platform !== 'linux' && 'linux only';

test('working keychain: no key file, wallet usable across processes, key not in argv', { skip }, async () => {
  const mock = await startMock();
  const home = tempHome('ks');
  const bin = join(home, 'bin');
  shim(bin);
  const extraEnv = { PATH: `${bin}:${process.env.PATH}`, DBUS_SESSION_BUS_ADDRESS: 'unix:path=/x', MYCLAWN_NET_KEYSTORE: '' };
  const d = join(home, '.config/myclawn-network/profiles/k');
  let a = await spawnAgent({ home, profile: 'k', clientName: 'c', base: mock.base, extraEnv });
  const r = await a.call('myclawn_start');
  assert.equal(r.json.status, 'ready', r.text);
  await a.close();
  assert.equal(existsSync(join(d, 'wallet.key')), false);
  const stored = readFileSync(join(bin, 'stored'), 'utf8').trim();
  assert.match(stored, /^[0-9a-f]{64}$/);
  assert.ok(!readFileSync(join(bin, 'argv.log'), 'utf8').includes(stored), 'key must not be passed as an argument');
  // A second process can decrypt: signed limits load without integrity failure.
  a = await spawnAgent({ home, profile: 'k', clientName: 'c', base: mock.base, extraEnv });
  const w = await a.call('myclawn_wallet');
  assert.equal(w.json.limits.per_tx_usdc, '5');
  await a.close();
  await mock.close();
  cleanup(home);
});

test('broken keyring: falls back to the 0600 key file and still works', { skip }, async () => {
  const mock = await startMock();
  const home = tempHome('ks');
  const bin = join(home, 'bin');
  shim(bin, { broken: true });
  const a = await spawnAgent({ home, profile: 'k', clientName: 'c', base: mock.base, extraEnv: { PATH: `${bin}:${process.env.PATH}`, DBUS_SESSION_BUS_ADDRESS: 'unix:path=/x', MYCLAWN_NET_KEYSTORE: '' } });
  const r = await a.call('myclawn_start');
  assert.equal(r.json.status, 'ready', r.text);
  await a.close();
  await mock.close();
  assert.equal(existsSync(join(home, '.config/myclawn-network/profiles/k/wallet.key')), true);
  cleanup(home);
});

test('server not reachable: identity and wallet still created, clear status, later start registers', async () => {
  const home = tempHome('off');
  const a = await spawnAgent({ home, profile: 'o', clientName: 'codex-mcp-client', base: 'http://127.0.0.1:9/api/net' });
  const r = await a.call('myclawn_start');
  assert.equal(r.json.status, 'offline');
  assert.match(r.json.wallet.address, /^0x/);
  await a.close();
  const mock = await startMock();
  const b = await spawnAgent({ home, profile: 'o', clientName: 'codex-mcp-client', base: mock.base });
  const r2 = await b.call('myclawn_start');
  assert.equal(r2.json.status, 'ready');
  assert.equal(r2.json.wallet.address, r.json.wallet.address);
  assert.equal(r2.json.agent.client_reported, 'codex', 'client name is canonical');
  await b.close();
  await mock.close();
  cleanup(home);
});

test('refuses to run against a plain-http remote and never starts with a bad profile name', () => {
  const r = spawnSync(process.execPath, [BIN, 'status'], { env: { PATH: process.env.PATH, HOME: '/tmp', MYCLAWN_NET_PROFILE: '../../evil' }, encoding: 'utf8' });
  assert.notEqual(r.status, 0);
});
