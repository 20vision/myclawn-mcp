// Minimal MCP server over stdio (newline-delimited JSON-RPC 2.0). No SDK at runtime, so `npx` stays fast and the supply chain stays small.
// Conformance is tested with the official SDK client in test/e2e.test.mjs.
import { INSTRUCTIONS } from './instructions.mjs';
import { TOOLS, errorResult, TRAILER } from './tools.mjs';
import { createSession } from './core.mjs';
import { VERSION } from './version.mjs';
import { isEnveloped } from './normalize.mjs';
import { walletEnabled } from './mode.mjs';

const SUPPORTED = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const MAX_LINE = 2 * 1024 * 1024;

// Small JSON-schema subset, matching what the tool schemas above use.
export function validate(schema, value, path = 'arguments') {
  if (schema.type === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return `${path} must be an object`;
    for (const r of schema.required ?? []) if (value[r] === undefined) return `${path}.${r} is required`;
    for (const [k, v] of Object.entries(value)) {
      const sub = schema.properties?.[k];
      if (!sub) {
        if (schema.additionalProperties === false) return `${path}.${k} is not a known field`;
        continue;
      }
      const err = validate(sub, v, `${path}.${k}`);
      if (err) return err;
    }
    return null;
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) return `${path} must be an array`;
    if (schema.maxItems !== undefined && value.length > schema.maxItems) return `${path} has too many items (max ${schema.maxItems})`;
    for (let i = 0; i < value.length; i++) {
      const err = validate(schema.items, value[i], `${path}[${i}]`);
      if (err) return err;
    }
    return null;
  }
  if (schema.type === 'string') {
    if (typeof value !== 'string') return `${path} must be a string`;
    if (schema.minLength !== undefined && value.length < schema.minLength) return `${path} is too short`;
    if (schema.maxLength !== undefined && value.length > schema.maxLength) return `${path} is too long (max ${schema.maxLength})`;
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) return `${path} has an invalid format`;
    if (schema.enum && !schema.enum.includes(value)) return `${path} must be one of ${schema.enum.join(', ')}`;
    return null;
  }
  if (schema.type === 'boolean' && typeof value !== 'boolean') return `${path} must be true or false`;
  return null;
}

const publicTools = TOOLS.map(({ name, description, inputSchema, annotations }) => ({ name, title: annotations?.title, description, inputSchema, annotations }));
const byName = new Map(TOOLS.map((t) => [t.name, t]));

export function renderResult(result, { isError = false } = {}) {
  const content = [{ type: 'text', text: JSON.stringify(result, null, 2) }];
  // The fixed trailer also stands alone, last, so nothing a peer wrote is the final word the model reads.
  if (isEnveloped(result)) content.push({ type: 'text', text: TRAILER });
  return isError ? { content, isError: true } : { content };
}

// Network-only mode: the server still answers with peers' wallet fields. They stop here.
const dropWalletFields = (v) => {
  if (Array.isArray(v)) return v.map(dropWalletFields);
  if (v === null || typeof v !== 'object') return v;
  return Object.fromEntries(Object.entries(v).filter(([k]) => !/^(wallet_|price_usdc$)/.test(k)).map(([k, x]) => [k, dropWalletFields(x)]));
};

export async function callTool(session, name, args) {
  const tool = byName.get(name);
  const schemaErr = validate(tool.inputSchema, args ?? {});
  if (schemaErr) return renderResult({ status: 'invalid_input', reason: schemaErr }, { isError: true });
  try {
    const result = await tool.run(session, args ?? {});
    return renderResult(walletEnabled() ? result : dropWalletFields(result));
  } catch (e) {
    return renderResult(errorResult(e), { isError: true });
  }
}

export function runStdioServer({ input = process.stdin, output = process.stdout } = {}) {
  const session = createSession();
  const send = (msg) => output.write(JSON.stringify(msg) + '\n');
  const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
  const fail = (id, code, message) => send({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
  const pending = new Set();

  async function handleRequest(m) {
    const { id, method, params } = m;
    switch (method) {
      case 'initialize': {
        session.clientInfo = params?.clientInfo ?? null;
        const want = params?.protocolVersion;
        return reply(id, {
          protocolVersion: SUPPORTED.includes(want) ? want : SUPPORTED[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'myclawn-mcp', title: 'MyClawn Network', version: VERSION, websiteUrl: 'https://contacts.myclawn.com' },
          instructions: INSTRUCTIONS,
        });
      }
      case 'ping':
        return reply(id, {});
      case 'tools/list':
        return reply(id, { tools: publicTools });
      case 'tools/call': {
        if (!byName.has(params?.name)) return fail(id, -32602, `Unknown tool: ${params?.name}`);
        return reply(id, await callTool(session, params.name, params.arguments));
      }
      default:
        return fail(id, -32601, `Method not found: ${method}`);
    }
  }

  function dispatch(m) {
    if (m === null || typeof m !== 'object' || Array.isArray(m) || m.jsonrpc !== '2.0') return fail(m?.id, -32600, 'Invalid Request');
    if (typeof m.method !== 'string') return; // A response to something; we never send requests.
    if (m.id === undefined) return; // Notification: initialized, cancelled, ...
    const p = handleRequest(m)
      .catch((e) => fail(m.id, -32603, 'Internal error'))
      .finally(() => pending.delete(p));
    pending.add(p);
  }

  let buf = '';
  input.setEncoding('utf8');
  input.on('data', (chunk) => {
    buf += chunk;
    if (buf.length > MAX_LINE && !buf.includes('\n')) {
      buf = '';
      fail(null, -32600, 'Message too large');
      return;
    }
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        fail(null, -32700, 'Parse error');
        continue;
      }
      if (Array.isArray(parsed)) parsed.forEach(dispatch);
      else dispatch(parsed);
    }
  });
  input.on('end', async () => {
    await Promise.allSettled([...pending]);
    process.exit(0);
  });
  output.on('error', () => process.exit(0));
}
