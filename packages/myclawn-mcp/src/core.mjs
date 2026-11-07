// Shared session context: lazy first-run setup, firewall arming, registration.
import { loadOrCreateIdentity, loadIdentity } from './identity.mjs';
import { createApi, ApiError, NetworkError } from './api.mjs';
import { file, readJson, writeSecure, withLock } from './store.mjs';
import { addCanary, scanOutbound } from './firewall.mjs';
import { loadOrCreateWallet, signWalletBinding, signWalletProof, unsealPrivateKey, network, walletInfo } from './wallet.mjs';
import { getMasterKey } from './keystore.mjs';
import { appendSecure } from './store.mjs';
import { VERSION } from './version.mjs';
import { walletEnabled } from './mode.mjs';

// Clients report varied names (codex reports "codex-mcp-client"). One name per product keeps per-client stats meaningful.
export function canonicalClient(raw) {
  const n = String(raw || 'unknown').toLowerCase().slice(0, 40);
  if (n.startsWith('codex')) return 'codex';
  if (n.includes('cursor')) return 'cursor';
  if (n.startsWith('claude-code') || n === 'claude code') return 'claude-code';
  return n;
}

export const readState = () => readJson(file('state.json'), {}) ?? {};
export function patchState(patch) {
  const next = { ...readState(), ...patch };
  armClaimCanary(next.claim_url);
  writeSecure(file('state.json'), next);
  return next;
}

let armed = false;
async function armFirewall(identity) {
  if (armed) return;
  armed = true;
  addCanary(identity._pem.replace(/-----[^-]+-----|\s/g, ''));
  // walletInfo, not walletEnabled: network-only mode must not create a master key, yet a wallet that already sits in this profile stays a secret.
  if (walletInfo()) {
    try {
      addCanary((await getMasterKey()).toString('hex'));
      addCanary(await unsealPrivateKey());
    } catch (e) {
      if (walletEnabled()) throw e;
    }
  }
  armClaimCanary(readState().claim_url);
}

// The live claim code is a secret from everyone but the owner, however it gets spelled.
function armClaimCanary(url) {
  const code = String(url ?? '').split('/claim/')[1];
  if (code) addCanary(code);
}

export function createSession({ clientInfo = null } = {}) {
  const session = {
    clientInfo,
    identity: null,
    api: null,

    client() {
      const c = session.clientInfo ?? {};
      return { name: canonicalClient(c.name), version: String(c.version || 'unknown').slice(0, 24) };
    },

    // Creates identity + wallet (network-only mode: identity alone) if needed. Works offline: registration can happen later.
    async local() {
      if (!session.identity) {
        session.identity = await loadOrCreateIdentity();
        session.api = createApi(session.identity);
      }
      const wallet = walletEnabled() ? await loadOrCreateWallet() : null;
      await armFirewall(session.identity);
      return { identity: session.identity, api: session.api, wallet };
    },

    // Returns state with agent_id or throws NetworkError / ApiError.
    async registered({ handle } = {}) {
      const { identity, api, wallet } = await session.local();
      const client = session.client();
      return withLock('register', async () => {
        const state = readState();
        if (state.agent_id) {
          // Same identity opened from another client or version: refresh what the network shows. Best effort, never blocks work.
          if (state.client?.name !== client.name || state.client?.version !== client.version) {
            try {
              const r = await api.post('/register', await registerBody({ identity, wallet, client, handle: state.handle, accepted: !!state.accepted }));
              // The server rotates the claim code on re-register, so the stored link must follow.
              return patchState({ client, claim_url: r?.claim_url ?? state.claim_url });
            } catch {}
          }
          return state;
        }
        let res;
        try {
          res = await api.post('/register', await registerBody({ identity, wallet, client, handle }));
        } catch (e) {
          // A taken handle must not stop first run.
          if (handle && e instanceof ApiError && e.status === 409) res = await api.post('/register', await registerBody({ identity, wallet, client }));
          else throw e;
        }
        return patchState({ agent_id: res.agent_id, handle: res.handle, claim_url: res.claim_url, client, registered_at: new Date().toISOString(), client_package: VERSION });
      });
    },

    // The owner said yes to "Publish this?". Only now does the rest of the registration leave this machine.
    async accept() {
      const { identity, api, wallet } = await session.local();
      const client = session.client();
      const state = await session.registered();
      if (state.accepted) return state;
      const r = await api.post('/register', await registerBody({ identity, wallet, client, handle: state.handle, accepted: true }));
      return patchState({ accepted: true, client, claim_url: r?.claim_url ?? state.claim_url });
    },

    // Runs every outgoing text through the firewall. Returns null if clean, a tool result if blocked.
    async guard(texts, { mode, toHandle } = {}) {
      const joined = (Array.isArray(texts) ? texts : [texts]).filter(Boolean).join('\n');
      await session.local();
      let verdict = await scanOutbound(joined, { mode });
      if (!verdict.ok && toHandle && verdict.findings.every((f) => f.category === 'pii')) {
        const allowed = await allowedKinds(session.api, toHandle);
        if (allowed.length) verdict = await scanOutbound(joined, { mode, allowPii: allowed });
      }
      if (verdict.ok) return null;
      logBlock(mode, verdict.findings);
      return { status: 'blocked_locally', sent: false, reason: verdict.reason, rules: verdict.findings.map((f) => f.rule) };
    },
  };
  return session;
}

function logBlock(mode, findings) {
  // Rule names only. The blocked text is never written anywhere.
  appendSecure(file('firewall.log'), JSON.stringify({ at: new Date().toISOString(), mode, rules: findings.map((f) => f.rule) }));
}

// Before the owner's yes the server gets the key and the handle, and nothing else.
async function registerBody({ identity, wallet, client, handle, accepted = false }) {
  if (!accepted) return { pubkey: identity.pubkey, ...(handle ? { handle } : {}) };
  const body = { pubkey: identity.pubkey, client, tos: true };
  if (wallet) Object.assign(body, { wallet_address: wallet.address, wallet_sig: await signWalletBinding(identity, wallet.address), wallet_proof: await signWalletProof(identity, wallet.address) });
  if (handle) body.handle = handle;
  const source = (process.env.MYCLAWN_NET_SOURCE || '').replace(/[^a-z0-9_.-]/gi, '').slice(0, 40);
  if (source) body.source = source;
  return body;
}

// Owner-set reveals, from the dashboard. Accepts {handle, kinds[]}, {handle, kind} and "handle:kind".
export async function allowedKinds(api, handle) {
  try {
    const policy = await api.get('/policy');
    const out = [];
    for (const r of policy?.allowed_reveals ?? []) {
      if (typeof r === 'string') {
        const [h, k] = r.split(':');
        if (h === handle && k) out.push(k);
      } else if (r?.handle === handle) {
        if (Array.isArray(r.kinds)) out.push(...r.kinds);
        else if (r.kind) out.push(r.kind);
      }
    }
    return out.map(String).filter((k) => ['email', 'phone', 'address'].includes(k));
  } catch {
    return []; // Cannot confirm permission: stays blocked.
  }
}

export { loadIdentity, ApiError, NetworkError, network };
