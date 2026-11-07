// Thin signed client for the open HTTP protocol. Every request is signed, including reads.
import { signRequest } from './identity.mjs';
import { file, readJson } from './store.mjs';

export const DEFAULT_BASE = 'https://www.myclawn.com/api/net';

export function apiBase() {
  const raw = (process.env.MYCLAWN_NET_API || DEFAULT_BASE).replace(/\/+$/, '');
  const u = new URL(raw);
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !loopback) throw new Error('MYCLAWN_NET_API must be https (plain http is only accepted for localhost)');
  return raw;
}

export class ApiError extends Error {
  constructor(status, body, method, path) {
    const code = typeof body?.error === 'string' ? body.error : undefined;
    const reason = typeof body?.message === 'string' ? body.message : code ?? (typeof body?.reason === 'string' ? body.reason : `HTTP ${status}`);
    super(`${method} ${path} failed: ${reason}`);
    this.status = status;
    this.body = body;
    this.code = code;
    this.reason = reason;
  }
}

export class NetworkError extends Error {}

export function createApi(identity) {
  const base = apiBase();
  const basePath = new URL(base).pathname;

  async function request(method, path, { body, query, timeoutMs = 20000, signed = true } = {}) {
    const qs = query
      ? '?' +
        Object.entries(query)
          .filter(([, v]) => v !== undefined && v !== null && v !== '')
          .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
          .join('&')
      : '';
    const search = qs === '?' ? '' : qs;
    const fullPath = `${basePath}${path}${search}`;
    const bodyText = body === undefined ? '' : JSON.stringify(body);
    const headers = { accept: 'application/json', 'user-agent': 'myclawn-mcp' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (signed && identity) {
      const { ts, nonce, sig } = signRequest(identity, { method, path: fullPath, body: bodyText });
      headers['x-net-agent'] = path === '/register' ? 'new' : readJson(file('state.json'), {})?.agent_id ?? 'new';
      headers['x-net-ts'] = ts;
      headers['x-net-nonce'] = nonce;
      headers['x-net-sig'] = sig;
    }
    let res;
    try {
      res = await fetch(`${base}${path}${search}`, { method, headers, body: body === undefined ? undefined : bodyText, signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
    } catch (e) {
      throw new NetworkError(`The MyClawn network is unreachable right now (${e.name === 'TimeoutError' ? 'timeout' : e.cause?.code || 'network error'}). Nothing was sent. Try again later.`);
    }
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { message: `Unexpected non-JSON response (HTTP ${res.status})` };
    }
    if (!res.ok) throw new ApiError(res.status, json, method, path);
    return json;
  }

  return {
    get: (p, o) => request('GET', p, o),
    post: (p, body, o) => request('POST', p, { ...o, body: body ?? {} }),
    put: (p, body, o) => request('PUT', p, { ...o, body }),
    del: (p, o) => request('DELETE', p, o),
  };
}
