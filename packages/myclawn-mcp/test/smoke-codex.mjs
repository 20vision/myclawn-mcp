#!/usr/bin/env node
// Manual smoke: the real codex CLI as MCP host. No OpenAI account here, so the model endpoint is a local stub that asks codex to call our tools.
// Proves what matters for us: codex spawns the server, handshakes, reports its clientInfo, calls tools, gets results.
// usage: CODEX_BIN=... node test/smoke-codex.mjs <dir with tarball installed>
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { startMock } from './mock-server.mjs';
import { tempHome, cleanup } from './helpers.mjs';

const clean = process.argv[2];
const CODEX = process.env.CODEX_BIN || 'codex';
const mock = await startMock();
const home = tempHome('codex');
const codexHome = join(home, 'codex');
mkdirSync(codexHome);
const env = { ...process.env, HOME: home, CODEX_HOME: codexHome, STUB_KEY: 'stub', XDG_CONFIG_HOME: join(home, 'xdg'), MYCLAWN_NET_API: mock.base, MYCLAWN_NET_CHAIN: 'base-sepolia', MYCLAWN_NET_KEYSTORE: 'file', MYCLAWN_NET_PROFILE: 'cx' };
const run = (args, timeoutMs = 90000) =>
  new Promise((resolve) => {
    const c = spawn(CODEX, args, { cwd: clean, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    c.stdout.on('data', (d) => (out += d));
    c.stderr.on('data', (d) => (err += d));
    const t = setTimeout(() => c.kill(), timeoutMs);
    c.on('close', (code) => {
      clearTimeout(t);
      resolve({ code, out, err });
    });
  });

// Codex passes only a small env whitelist to MCP servers, so settings must go through --env. The plain one-liner needs none.
const envFlags = ['MYCLAWN_NET_API', 'MYCLAWN_NET_CHAIN', 'MYCLAWN_NET_KEYSTORE', 'MYCLAWN_NET_PROFILE', 'XDG_CONFIG_HOME'].flatMap((k) => ['--env', `${k}=${env[k]}`]);
const add = await run(['mcp', 'add', ...envFlags, 'myclawn', '--', 'npx', '-y', 'myclawn-mcp']);
console.log(add.code === 0 ? 'PASS' : 'FAIL', 'codex mcp add myclawn -- npx -y myclawn-mcp', add.out.trim().split('\n')[0]);
const list = await run(['mcp', 'list']);
console.log(/myclawn/.test(list.out) ? 'PASS' : 'FAIL', 'codex mcp list');

// Stub model: first turn calls myclawn_start, second publishes a card, third finishes.
const seen = { tools: null, step: 0, outputs: [] };
const sse = (res, events) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const e of events) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  res.end();
};
const stub = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    if (!req.url.includes('/responses')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{"data":[],"models":[]}');
    }
    const body = JSON.parse(raw);
    seen.tools = (body.tools ?? []).map((t) => t.name ?? t.function?.name ?? t.type);
    for (const i of body.input ?? []) if (i.type === 'function_call_output') seen.outputs.push(typeof i.output === 'string' ? i.output : JSON.stringify(i.output));
    // Codex groups MCP tools in a namespace per server; the server `instructions` become its description.
    const ns = (body.tools ?? []).find((t) => t.type === 'namespace' && t.name.includes('myclawn'));
    seen.toolNames = ns?.tools?.map((t) => t.name) ?? seen.toolNames;
    seen.instructions = ns?.description ?? seen.instructions;
    const find = (n) => seen.toolNames?.find((t) => t.includes(n));
    const id = `resp_${seen.step}`;
    const done = { type: 'response.completed', response: { id, output: [], usage: { input_tokens: 1, input_tokens_details: null, output_tokens: 1, output_tokens_details: null, total_tokens: 2 } } };
    const created = { type: 'response.created', response: { id } };
    seen.step++;
    const calls = [
      [find('myclawn_start'), {}],
      [find('myclawn_publish_card'), { headline: 'Rust help', offers: ['rust code review'], needs: ['logo design'], topics: ['rust'] }],
    ];
    const step = calls[seen.step - 1];
    if (step?.[0]) return sse(res, [created, { type: 'response.output_item.done', item: { type: 'function_call', id: `fc_${seen.step}`, call_id: `call_${seen.step}`, namespace: ns?.name, name: step[0], arguments: JSON.stringify(step[1]) } }, done]);
    return sse(res, [created, { type: 'response.output_item.done', item: { type: 'message', role: 'assistant', id: 'm1', content: [{ type: 'output_text', text: 'Done.' }] } }, done]);
  });
});
await new Promise((r) => stub.listen(0, '127.0.0.1', r));
const cfgPath = join(codexHome, 'config.toml');
const cfg = readFileSync(cfgPath, 'utf8');
writeFileSync(cfgPath, `model = "stub-model"\nmodel_provider = "stub"\n\n[model_providers.stub]\nname = "stub"\nbase_url = "http://127.0.0.1:${stub.address().port}/v1"\nenv_key = "STUB_KEY"\nwire_api = "responses"\n\n${cfg}`);
const r = await run(['exec', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', '--json', 'Set up MyClawn.'], 120000);
const agent = [...mock.db.agents.values()][0];
console.log(seen.toolNames?.length === 14 ? 'PASS' : 'FAIL', `codex lists all tools (${seen.toolNames?.length})`);
console.log(/Publish this\?/.test(seen.instructions ?? '') ? 'PASS' : 'FAIL', 'server instructions reach the codex model');
console.log(agent ? 'PASS' : 'FAIL', 'registered through the real codex CLI', agent ? `client=${agent.client.name} ${agent.client.version}` : r.err.slice(-600) + r.out.slice(-600));
console.log(agent?.card.visibility === 'published' ? 'PASS' : 'FAIL', 'card published via tool call from codex');
console.log(seen.outputs.some((o) => o.includes('claim_url')) ? 'PASS' : 'FAIL', 'tool result reached codex');
stub.closeAllConnections?.();
stub.close();
await mock.close();
cleanup(home);
process.exit(agent ? 0 : 1);
