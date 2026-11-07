// Spending caps + local ledger. Enforced here, on this machine, before anything is signed.
// Both files carry an HMAC from the wallet master key: a hand-edited or agent-edited file fails closed (caps become 0).
// Honest limit: something running as the same OS user can in principle read the key too; that is why the wallet should only hold spending money.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { file, readJson, writeSecure, withLock } from './store.mjs';
import { getMasterKey } from './keystore.mjs';
import { existsSync } from 'node:fs';

// Once a wallet exists both files exist. A missing one was removed, and removing a file
// must not be the way to get fresh caps or a fresh daily budget: same as a failed MAC.
const walletExists = () => existsSync(file('wallet.json'));

// Called when the wallet is created, so the rule above holds from the first second.
export async function initLocalFiles() {
  const key = await getMasterKey();
  if (!readJson(file('limits.json'))) signedWrite(file('limits.json'), key, { v: 1, ...DEFAULT_LIMITS });
  if (!readJson(file('ledger.json'))) signedWrite(file('ledger.json'), key, { v: 1, ever_paid: false, entries: [] });
}

export const DEFAULT_LIMITS = { per_tx_usdc: '5', per_day_usdc: '20', first_payment_needs_owner: false };
const MICRO = 1_000_000n;

export function parseUsdc(value) {
  const s = String(value ?? '').trim();
  if (!/^\d{1,12}(?:\.\d{1,6})?$/.test(s)) throw new Error('Amount must be a plain positive decimal with at most 6 decimals, for example 1.50');
  const [i, f = ''] = s.split('.');
  return BigInt(i) * MICRO + BigInt((f + '000000').slice(0, 6));
}

export function formatUsdc(micro) {
  const v = BigInt(micro);
  const frac = (v % MICRO).toString().padStart(6, '0').replace(/0+$/, '');
  return frac ? `${v / MICRO}.${frac}` : `${v / MICRO}`;
}

function mac(key, obj) {
  const { mac: _ignored, ...rest } = obj;
  return createHmac('sha256', key).update(`myclawn-limits-v1\n${JSON.stringify(rest)}`).digest('hex');
}

function macOk(key, obj) {
  const a = Buffer.from(mac(key, obj), 'hex');
  const b = Buffer.from(String(obj.mac ?? ''), 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

function signedWrite(path, key, obj) {
  writeSecure(path, { ...obj, mac: mac(key, obj) });
}

export async function loadLimits() {
  const path = file('limits.json');
  const key = await getMasterKey();
  const j = readJson(path);
  if (!j) {
    if (walletExists()) return { per_tx_usdc: '0', per_day_usdc: '0', first_payment_needs_owner: true, tampered: true };
    const fresh = { v: 1, ...DEFAULT_LIMITS };
    signedWrite(path, key, fresh);
    return { ...fresh, tampered: false };
  }
  if (!macOk(key, j)) return { per_tx_usdc: '0', per_day_usdc: '0', first_payment_needs_owner: true, tampered: true };
  const { mac: _m, ...rest } = j;
  return { ...rest, tampered: false };
}

export async function saveLimits(next) {
  parseUsdc(next.per_tx_usdc);
  parseUsdc(next.per_day_usdc);
  const key = await getMasterKey();
  signedWrite(file('limits.json'), key, { v: 1, per_tx_usdc: String(next.per_tx_usdc), per_day_usdc: String(next.per_day_usdc), first_payment_needs_owner: !!next.first_payment_needs_owner });
}

const utcDay = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);

async function readLedger(key) {
  const j = readJson(file('ledger.json'));
  if (!j) return { v: 1, ever_paid: walletExists(), entries: [], tampered: walletExists() };
  if (!macOk(key, j)) return { v: 1, ever_paid: true, entries: [], tampered: true };
  const { mac: _m, ...rest } = j;
  return { ...rest, tampered: false };
}

function writeLedger(key, ledger) {
  const { tampered: _t, ...rest } = ledger;
  signedWrite(file('ledger.json'), key, rest);
}

export function spentToday(ledger, now = Date.now()) {
  const day = utcDay(now);
  let sum = 0n;
  for (const e of ledger.entries) if (e.day === day && e.state !== 'released') sum += BigInt(e.micro);
  return sum;
}

export async function ledgerView() {
  const key = await getMasterKey();
  const ledger = await readLedger(key);
  return { ledger, spent_today_usdc: formatUsdc(spentToday(ledger)) };
}

// Atomic check-and-reserve. Returns {ok, id} or {ok:false, why} where why explains which cap stopped it.
export async function reserve({ micro, to_handle, to_address }) {
  return withLock('ledger', async () => {
    const key = await getMasterKey();
    const limits = await loadLimits();
    const ledger = await readLedger(key);
    if (limits.tampered || ledger.tampered) return { ok: false, why: 'The local limits or ledger file failed its integrity check, so all payments are stopped. The owner must review them with `npx myclawn-mcp limits` in a terminal.' };
    const perTx = parseUsdc(limits.per_tx_usdc);
    const perDay = parseUsdc(limits.per_day_usdc);
    if (micro > perTx) return { ok: false, why: `Above the per-payment cap of ${limits.per_tx_usdc} USDC.` };
    const spent = spentToday(ledger);
    if (spent + micro > perDay) return { ok: false, why: `Above the daily cap of ${limits.per_day_usdc} USDC (${formatUsdc(spent)} already used today, UTC).` };
    if (limits.first_payment_needs_owner && !ledger.ever_paid) return { ok: false, why: 'The wallet policy requires the owner to approve the first payment.' };
    const id = `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    ledger.entries.push({ id, day: utcDay(), at: new Date().toISOString(), micro: micro.toString(), to_handle, to_address, state: 'reserved' });
    ledger.entries = ledger.entries.slice(-1000);
    writeLedger(key, ledger);
    return { ok: true, id };
  });
}

export async function settle(id, patch) {
  return withLock('ledger', async () => {
    const key = await getMasterKey();
    const ledger = await readLedger(key);
    const e = ledger.entries.find((x) => x.id === id);
    if (!e) return;
    Object.assign(e, patch);
    if (patch.state === 'confirmed' || patch.state === 'submitted') ledger.ever_paid = true;
    writeLedger(key, ledger);
  });
}

// Owner-only (TTY) recovery after an integrity failure: re-signs what is there, keeping today's entries when readable.
export async function resealLocalFiles(limits) {
  const key = await getMasterKey();
  await saveLimits(limits);
  const raw = readJson(file('ledger.json'));
  if (raw) {
    const { mac: _m, ...rest } = raw;
    signedWrite(file('ledger.json'), key, rest);
  } else {
    signedWrite(file('ledger.json'), key, { v: 1, ever_paid: true, entries: [] });
  }
}
