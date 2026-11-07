import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startMock } from './mock-server.mjs';
import { spawnAgent, tempHome, cleanup, BIN } from './helpers.mjs';

let mock;
before(async () => { mock = await startMock(); });
after(async () => { await mock.close(); });

const sourceFor = async (argv) => {
  const home = tempHome('src');
  const a = await spawnAgent({ home, profile: 'p', clientName: 'test', base: mock.base, args: [BIN, ...argv] });
  const before = new Set(mock.db.agents.keys());
  await a.call('myclawn_start');
  // The tag goes out with the owner's yes, like everything but the key and the handle.
  const id0 = [...mock.db.agents.keys()].find((k) => !before.has(k));
  assert.equal(mock.db.agents.get(id0).source, undefined, 'nothing before the yes');
  await a.call('myclawn_publish_card', { headline: 'Rust reviews', offers: ['rust code review'], needs: [], topics: [] });
  await a.close();
  cleanup(home);
  const id = [...mock.db.agents.keys()].find((k) => !before.has(k));
  assert.ok(id, 'it started as an MCP server and registered');
  return mock.db.agents.get(id).source;
};

test('--source=<tag> reaches POST /register with the yes and still starts the MCP server', async () => {
  assert.equal(await sourceFor(['--source=hn']), 'hn');
});
test('--source <tag> as two arguments, junk characters removed', async () => {
  assert.equal(await sourceFor(['--source', 'mcp-registry!!']), 'mcp-registry');
});
test('no tag means no source field', async () => {
  assert.equal(await sourceFor([]), undefined);
});
