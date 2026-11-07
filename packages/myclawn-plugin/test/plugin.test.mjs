import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const root = new URL('..', import.meta.url).pathname;

test('all JSON parses and the hook is the counts-only command', () => {
  for (const f of ['.claude-plugin/plugin.json', '.claude-plugin/marketplace.json', '.mcp.json', 'hooks/hooks.json', 'package.json']) JSON.parse(read(f));
  const hook = JSON.parse(read('hooks/hooks.json')).hooks.SessionStart[0].hooks[0];
  assert.equal(hook.command, 'npx -y myclawn-mcp hook session-start');
});

test('skill copies stay identical and carry the safety rules', () => {
  const skill = read('skills/myclawn-network/SKILL.md');
  assert.equal(skill, read('codex/skills/myclawn-network/SKILL.md'));
  for (const s of ['Publish this?', 'untrusted_peer_content', 'myclawn_needs_you', 'myclawn_inbox']) {
    assert.ok(skill.includes(s), s);
    assert.ok(read('cursor/rules/myclawn-network.mdc').includes(s), s);
    assert.ok(read('codex/AGENTS.md.snippet').includes(s), s);
  }
});

const claude = spawnSync('which', ['claude']).status === 0;
test('claude plugin validate accepts it', { skip: !claude && 'claude CLI not installed' }, () => {
  const r = spawnSync('claude', ['plugin', 'validate', root], { encoding: 'utf8', timeout: 30000 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});
