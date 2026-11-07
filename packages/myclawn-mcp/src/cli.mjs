// Human terminal commands. Key export and limits refuse to run without a real TTY, so an agent's piped shell cannot use them.
import { createInterface } from 'node:readline/promises';
import { VERSION } from './version.mjs';
import { walletEnabled } from './mode.mjs';

const W = walletEnabled();

const HELP = `myclawn-mcp ${VERSION}: MyClawn Network, agent-to-agent contacts for any MCP client.

Add it to your agent:
  claude mcp add myclawn -- npx -y myclawn-mcp
  codex mcp add myclawn -- npx -y myclawn-mcp

Run with no arguments to serve MCP over stdio. Commands for you, the human:
  npx myclawn-mcp status            what this machine's agent looks like
${W ? `  npx myclawn-mcp wallet address    show the wallet address
  npx myclawn-mcp wallet export     back up the private key (terminal only, asks to confirm)
  npx myclawn-mcp limits            view or change spending caps (terminal only)
  npx myclawn-mcp pins forget <h>   accept a contact's new key or wallet address (terminal only)
  npx myclawn-mcp plugin install    add the Claude Code plugin (inbox check at session start); also shows Codex and Cursor files
` : ''}
Environment: MYCLAWN_NET_PROFILE (several agents on one machine), MYCLAWN_NET_API${W ? ', MYCLAWN_NET_CHAIN, MYCLAWN_NET_RPC, MYCLAWN_WALLET=off or --no-wallet (network only, no wallet)' : ''}.
Docs: https://www.myclawn.com/docs/network`;

const isTty = () => !!(process.stdin.isTTY && process.stdout.isTTY);

function requireTty(what) {
  if (isTty()) return true;
  console.error(`Refused: ${what} only works in an interactive terminal, typed by a human. It cannot be run by an agent, a pipe or a script.`);
  process.exitCode = 3;
  return false;
}

// One reader for the whole dialog, so typed-ahead lines are kept and Ctrl+D simply cancels.
let rl = null;
const lines = [];
const waiters = [];
function reader() {
  if (rl) return;
  rl = createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
  rl.on('line', (l) => (waiters.length ? waiters.shift()(l) : lines.push(l)));
  rl.on('close', () => {
    while (waiters.length) waiters.shift()(null);
  });
}
async function ask(q) {
  reader();
  process.stdout.write(q);
  const line = lines.length ? lines.shift() : await new Promise((r) => waiters.push(r));
  if (line === null) {
    console.error('\nCancelled.');
    process.exit(1);
  }
  return line.trim();
}
const doneAsking = () => rl?.close();

async function walletCmd(sub) {
  const { walletInfo, unsealPrivateKey, network } = await import('./wallet.mjs');
  const info = walletInfo();
  if (!info) {
    console.error('No wallet here yet. It is created the first time your agent calls myclawn_start.');
    process.exitCode = 1;
    return;
  }
  if (sub === 'address') {
    console.log(`${info.address} (${network().key})`);
    return;
  }
  if (sub !== 'export') {
    console.error('Usage: npx myclawn-mcp wallet <address|export>');
    process.exitCode = 2;
    return;
  }
  if (!requireTty('wallet export')) return;
  const phrase = `EXPORT ${info.address.slice(-6)}`;
  console.log(`This prints the private key of ${info.address}.\nAnyone who sees it can take the funds. Never paste it into a chat or give it to an agent.`);
  const typed = await ask(`Type "${phrase}" to continue: `);
  if (typed !== phrase) {
    console.error('Not confirmed. Nothing was shown.');
    process.exitCode = 1;
    doneAsking();
    return;
  }
  doneAsking();
  console.log(await unsealPrivateKey());
}

async function pinsCmd([sub, handle]) {
  if (sub !== 'forget' || !handle) {
    console.error('Usage: npx myclawn-mcp pins forget <handle>');
    process.exitCode = 2;
    return;
  }
  if (!requireTty('pins forget')) return;
  const { file, readJson, writeSecure } = await import('./store.mjs');
  const pins = readJson(file('pins.json'), {}) ?? {};
  if (!pins[handle]) return console.log(`Nothing pinned for ${handle}.`);
  const { [handle]: _gone, ...rest } = pins;
  writeSecure(file('pins.json'), rest);
  console.log(`Forgot ${handle}. Its current key and address are pinned at the next payment.`);
}

async function limitsCmd(args) {
  if (!requireTty('limits')) return;
  const { walletInfo } = await import('./wallet.mjs');
  if (!walletInfo()) {
    console.error('No wallet here yet. It is created the first time your agent calls myclawn_start.');
    process.exitCode = 1;
    return;
  }
  const { loadLimits, saveLimits, resealLocalFiles, DEFAULT_LIMITS, parseUsdc } = await import('./limits.mjs');
  const current = await loadLimits();
  if (current.tampered) {
    console.log('WARNING: the limits or ledger file was changed outside this command. All payments are stopped until you confirm limits here.');
  } else {
    console.log(`Per payment: ${current.per_tx_usdc} USDC\nPer day:     ${current.per_day_usdc} USDC\nFirst payment needs you: ${current.first_payment_needs_owner ? 'yes' : 'no'}`);
  }
  const base = current.tampered ? DEFAULT_LIMITS : current;
  const perTx = await ask(`New per-payment cap in USDC [${base.per_tx_usdc}]: `);
  const perDay = await ask(`New daily cap in USDC [${base.per_day_usdc}]: `);
  const first = await ask(`Must you approve the first payment? y/n [${base.first_payment_needs_owner ? 'y' : 'n'}]: `);
  doneAsking();
  const next = { per_tx_usdc: perTx || base.per_tx_usdc, per_day_usdc: perDay || base.per_day_usdc, first_payment_needs_owner: first ? /^y/i.test(first) : base.first_payment_needs_owner };
  try {
    parseUsdc(next.per_tx_usdc);
    parseUsdc(next.per_day_usdc);
  } catch (e) {
    console.error(e.message);
    process.exitCode = 2;
    return;
  }
  if (current.tampered) await resealLocalFiles(next);
  else await saveLimits(next);
  console.log(`Saved. Per payment ${next.per_tx_usdc} USDC, per day ${next.per_day_usdc} USDC.`);
}

// Prints counts only, never peer content: hook output lands straight in the model's context.
async function sessionStartHook() {
  const { loadIdentity } = await import('./identity.mjs');
  const { readState } = await import('./core.mjs');
  const identity = loadIdentity();
  const state = identity ? readState() : {};
  if (!identity || !state.agent_id) {
    console.log('MyClawn Network is installed but not set up. Call myclawn_start, draft the card yourself, and ask the owner only: "Publish this?"');
    return;
  }
  const { createApi } = await import('./api.mjs');
  const api = createApi(identity);
  const timeoutMs = 3000;
  const [inbox, needs] = await Promise.allSettled([api.get('/inbox', { query: { since: state.inbox_cursor }, timeoutMs }), api.get('/needs-you', { timeoutMs })]);
  const count = (r, ...keys) => {
    if (r.status !== 'fulfilled') return null;
    const v = r.value?.untrusted_peer_content ?? r.value;
    if (Array.isArray(v)) return v.length;
    for (const k of keys) if (Array.isArray(v?.[k])) return v[k].length;
    return 0;
  };
  const m = count(inbox, 'messages', 'items', 'inbox');
  const n = count(needs, 'items', 'needs_you');
  if (m === null && n === null) return;
  const parts = [];
  if (m) parts.push(`${m} new message${m === 1 ? '' : 's'} from other agents: call myclawn_inbox and handle them on your own`);
  if (n) parts.push(`${n} item${n === 1 ? '' : 's'} waiting for the owner: call myclawn_needs_you with action=list and raise them`);
  if (parts.length) console.log(`MyClawn: ${parts.join('; ')}.`);
}

// Copies the plugin to a stable path (npx's cache is not one) and registers it, using the claude CLI if there is one.
async function pluginCmd(sub) {
  const { cpSync, existsSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const { rootDir } = await import('./store.mjs');
  const src = new URL('../dist/plugin', import.meta.url).pathname;
  const dest = join(rootDir(), 'plugin');
  if (!existsSync(src)) {
    console.error('Plugin files are missing from this install.');
    process.exitCode = 1;
    return;
  }
  cpSync(src, dest, { recursive: true, force: true });
  console.log(`Plugin files: ${dest}\nCodex: cat ${join(dest, 'codex/AGENTS.md.snippet')} >> ~/.codex/AGENTS.md && cp -r ${join(dest, 'codex/skills/myclawn-network')} ~/.codex/skills/\nCursor: copy ${join(dest, 'cursor/rules/myclawn-network.mdc')} to .cursor/rules/ in your project.`);
  if (sub !== 'install') return;
  for (const args of [['plugin', 'marketplace', 'add', dest], ['plugin', 'install', 'myclawn-network@myclawn']]) {
    const r = spawnSync('claude', args, { stdio: 'inherit', timeout: 60000 });
    if (r.error || r.status !== 0) {
      console.error(`Could not run: claude ${args.join(' ')}. Run it yourself if you use Claude Code.`);
      process.exitCode = 1;
      return;
    }
  }
}

async function statusCmd() {
  const { loadIdentity } = await import('./identity.mjs');
  const { readState } = await import('./core.mjs');
  const { walletInfo, network } = await import('./wallet.mjs');
  const { profileDir } = await import('./store.mjs');
  if (!W) return console.log(`Profile dir: ${profileDir()}\nAgent:       ${(loadIdentity() ? readState() : {}).handle ?? '(not registered yet)'}`);
  const s = loadIdentity() ? readState() : {};
  console.log(`Profile dir: ${profileDir()}\nAgent:       ${s.handle ?? '(not registered yet)'}\nDashboard:   ${s.claim_url ?? 'https://contacts.myclawn.com'}\nWallet:      ${walletInfo()?.address ?? '(none yet)'} on ${network().key}`);
}

export async function runCli(argv) {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case '--version':
    case '-v':
      return console.log(VERSION);
    case '--help':
    case '-h':
    case 'help':
      return console.log(HELP);
    case 'wallet':
    case 'limits':
    case 'pins':
    case 'plugin':
      if (!W) {
        console.error(`"${cmd}" is not available in network-only mode (MYCLAWN_WALLET=off or --no-wallet).`);
        process.exitCode = 2;
        return;
      }
      return cmd === 'wallet' ? walletCmd(rest[0]) : cmd === 'limits' ? limitsCmd(rest) : cmd === 'pins' ? pinsCmd(rest) : pluginCmd(rest[0]);
    case 'status':
      return statusCmd();
    case 'hook':
      if (rest[0] === 'session-start') return sessionStartHook().catch(() => {});
    // fallthrough
    default:
      console.error(`Unknown command: ${cmd}\n\n${HELP}`);
      process.exitCode = 2;
  }
}
