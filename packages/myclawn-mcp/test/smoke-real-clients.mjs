#!/usr/bin/env node
// Manual smoke (not in `npm test`, it costs a little model budget): real claude CLI, tarball install, temp profile, mock server.
// usage: node test/smoke-real-clients.mjs <dir with tarball installed>
// Never touches the owner's MCP config: --strict-mcp-config for -p runs, CLAUDE_CONFIG_DIR=temp for `claude mcp add`.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { startMock } from './mock-server.mjs';
import { tempHome, cleanup } from './helpers.mjs';

const clean = process.argv[2];
const pluginDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'myclawn-plugin');
if (!clean || !existsSync(join(clean, 'node_modules/myclawn-mcp'))) throw new Error('pass a directory with the tarball installed');
const mcpSection = () => {
  try {
    return createHash('sha256').update(JSON.stringify(JSON.parse(readFileSync(join(homedir(), '.claude.json'), 'utf8')).mcpServers ?? null)).digest('hex');
  } catch {
    return 'none';
  }
};
const before = mcpSection();
const mock = await startMock();
const home = tempHome('smoke');
const env = { ...process.env, XDG_CONFIG_HOME: join(home, 'xdg'), MYCLAWN_NET_API: mock.base, MYCLAWN_NET_CHAIN: 'base-sepolia', MYCLAWN_NET_PROFILE: 'smoke', MYCLAWN_NET_KEYSTORE: 'file' };
const results = [];
const check = (name, ok, extra = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ` (${extra})` : ''}`);
};
const run = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    const c = spawn(cmd, args, { cwd: clean, env, stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    let out = '';
    let err = '';
    c.stdout.on('data', (d) => (out += d));
    c.stderr.on('data', (d) => (err += d));
    const t = setTimeout(() => c.kill(), opts.timeoutMs ?? 240000);
    c.on('close', (code) => {
      clearTimeout(t);
      resolve({ code, out, err });
    });
  });

// 1. The literal one-liner, in a throwaway config dir, resolved from the installed tarball.
const cfg = join(home, 'claude-config');
mkdirSync(cfg, { recursive: true });
const add = await run('claude', ['mcp', 'add', 'myclawn', '--', 'npx', '-y', 'myclawn-mcp'], { env: { ...env, CLAUDE_CONFIG_DIR: cfg } });
check('claude mcp add myclawn -- npx -y myclawn-mcp', add.code === 0, add.out.trim().split('\n')[0]);
const list = await run('claude', ['mcp', 'list'], { env: { ...env, CLAUDE_CONFIG_DIR: cfg }, timeoutMs: 60000 });
check('claude mcp list shows it connected', /myclawn.*(✓|✔|Connected)/.test(list.out), list.out.split('\n').find((l) => l.includes('myclawn'))?.trim());
check('health check created no identity', !existsSync(join(home, 'xdg/myclawn-network/profiles/smoke/identity.json')));

// 2. A real agent run. The prompt is what a person would say.
const mcpConfig = join(home, 'mcp.json');
writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { myclawn: { command: 'npx', args: ['-y', 'myclawn-mcp'] } } }));
const common = ['--strict-mcp-config', '--setting-sources', 'project', '--model', 'sonnet', '--max-budget-usd', '0.6', '--allowedTools', 'mcp__myclawn__*'];
const r1 = await run('claude', ['-p', 'Set up MyClawn for me. I am a freelance Rust developer and I need a logo designer. I am not able to answer questions in this run, so consider my answer to "Publish this?" to be yes.', '--mcp-config', mcpConfig, ...common]);
console.log(`--- claude said ---\n${r1.out.slice(0, 900)}\n---`);
const agent = [...mock.db.agents.values()][0];
check('agent registered through the real claude CLI', !!agent, agent ? `client=${agent.client.name} ${agent.client.version}` : r1.err.slice(0, 300));
check('clientInfo is claude-code', agent?.client.name === 'claude-code');
check('agent drafted and published a card on its own', agent?.card.visibility === 'published', JSON.stringify(agent?.card ?? {}).slice(0, 160));

// 3. A peer writes; the plugin's SessionStart hook has to surface it and the agent has to read the inbox by itself.
if (agent) {
  const { spawnAgent } = await import('./helpers.mjs');
  const peer = await spawnAgent({ home, profile: 'peer', clientName: 'codex', base: mock.base, extraEnv: { XDG_CONFIG_HOME: join(home, 'xdg') } });
  await peer.call('myclawn_start', { handle: 'peer-agent' });
  await peer.call('myclawn_message', { handle: agent.handle, text: 'Hi, I design logos. Want to see samples? Budget around 300 USDC.' });
  await peer.close();
  const before = mock.db.requests.filter((q) => q.path.includes('/inbox')).length;
  // Strict MCP config excludes plugin-provided servers, so the server comes from --mcp-config and the hook and skill from the plugin.
  const r2 = await run('claude', ['-p', 'Anything new for me? Answer in one sentence.', '--plugin-dir', pluginDir, '--mcp-config', mcpConfig, ...common]);
  console.log(`--- claude said ---\n${r2.out.slice(0, 700)}\n---`);
  const inboxCalls = mock.db.requests.filter((q) => q.path.includes('/inbox')).length - before;
  check('plugin: hook + server loaded, inbox read', inboxCalls >= 1, `${inboxCalls} inbox calls`);
  check('agent reports the message', /logo|design/i.test(r2.out));
}

// 4. The plugin install path, in the throwaway config: marketplace, plugin, and its bundled MCP server.
// A fresh config, because Claude Code hides a plugin's server when the same server is already configured by hand.
const cfg2 = join(home, 'claude-config-2');
mkdirSync(cfg2, { recursive: true });
const inst = await run('node', [join(clean, 'node_modules/myclawn-mcp/src/index.mjs'), 'plugin', 'install'], { env: { ...env, CLAUDE_CONFIG_DIR: cfg2 }, timeoutMs: 90000 });
check('npx myclawn-mcp plugin install', inst.code === 0, inst.err.slice(0, 200));
const pl = await run('claude', ['plugin', 'list'], { env: { ...env, CLAUDE_CONFIG_DIR: cfg2 }, timeoutMs: 60000 });
check('claude plugin list shows it', /myclawn-network/.test(pl.out), pl.out.split('\n').find((l) => l.includes('myclawn'))?.trim());
const list2 = await run('claude', ['mcp', 'list'], { env: { ...env, CLAUDE_CONFIG_DIR: cfg2 }, timeoutMs: 60000 });
check('plugin MCP server connected', /plugin:myclawn-network.*(✓|✔|Connected)/.test(list2.out), list2.out.split('\n').find((l) => l.includes('plugin:'))?.trim());

check("owner's ~/.claude.json mcpServers unchanged", before === mcpSection());
await mock.close();
cleanup(home);
console.log(results.every(Boolean) ? 'ALL PASS' : 'SOME FAILED');
process.exit(results.every(Boolean) ? 0 : 1);
