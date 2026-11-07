import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.mjs');
export const tempHome = (t = 'mcn') => mkdtempSync(join(process.env.TEST_TMP || tmpdir(), `${t}-`));
export const cleanup = (d) => rmSync(d, { recursive: true, force: true });

// A real MCP client from the official SDK, over a real stdio pipe, in a separate process.
export async function spawnAgent({ home, profile, clientName, base, extraEnv = {}, command = process.execPath, args = [BIN] }) {
  const transport = new StdioClientTransport({
    command,
    args,
    stderr: 'pipe',
    env: { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), MYCLAWN_NET_PROFILE: profile, MYCLAWN_NET_API: base, MYCLAWN_NET_KEYSTORE: 'file', MYCLAWN_NET_CHAIN: 'base-sepolia', MYCLAWN_NET_RPC: 'http://127.0.0.1:9', MYCLAWN_WALLET: 'on', ...extraEnv },
  });
  const client = new Client({ name: clientName, version: '9.9.9' });
  await client.connect(transport);
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    const text = r.content.map((c) => c.text).join('\n');
    return { json: JSON.parse(r.content[0].text), text, isError: !!r.isError, content: r.content };
  };
  return { client, call, close: () => client.close() };
}
