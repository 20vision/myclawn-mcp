// Outbound firewall: every message and card passes through here BEFORE it leaves the machine.
// Secrets are never allowed. PII only when the owner allowed that kind for that contact. Reasons name a rule, never the matched text.
import { userInfo } from 'node:os';

const PLACEHOLDER = /(?:^|[^a-z])(?:your|my|example|sample|placeholder|changeme|change[_-]?me|redacted|dummy|fake|foo|bar|xxx+|none|null|undefined|true|false|todo|secret|password|token|api[_-]?key|insert|replace)(?:[^a-z]|$)|x{4,}|\*{3,}|\.{3}|…|^<.*>$|^\$\{?[A-Za-z_]|^%[A-Z_]+%$|^\{\{.*\}\}$|process\.env|os\.environ|getenv|EXAMPLE/i;

export function shannon(s) {
  const m = new Map();
  for (const c of s) m.set(c, (m.get(c) || 0) + 1);
  let h = 0;
  for (const n of m.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

// id, regex, optional validator on the match. Provider prefixes are high confidence and also checked on reversed text.
const TOKEN_RULES = [
  ['anthropic_key', /\bsk-ant-[A-Za-z0-9_-]{16,}/],
  ['openrouter_key', /\bsk-or-(?:v\d-)?[A-Za-z0-9_-]{20,}/],
  ['openai_key', /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}/],
  ['aws_access_key', /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA)[A-Z0-9]{16}\b/],
  ['google_api_key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['google_oauth', /\b(?:ya29\.[0-9A-Za-z_-]{20,}|GOCSPX-[0-9A-Za-z_-]{20,})/],
  ['github_token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})/],
  ['gitlab_token', /\bgl(?:pat|dt|cbt|ptt|rt)-[A-Za-z0-9_-]{20,}/],
  ['slack_token', /\bxox[abeoprs]-[A-Za-z0-9-]{10,}/],
  ['slack_webhook', /hooks\.slack\.com\/services\/[A-Za-z0-9/_-]{20,}/],
  ['discord_webhook', /discord(?:app)?\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]{20,}/],
  ['discord_token', /\b[MNO][A-Za-z0-9_-]{23,27}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}/],
  ['telegram_bot_token', /\b\d{8,10}:AA[A-Za-z0-9_-]{32,}/],
  ['stripe_key', /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/],
  ['stripe_webhook', /\bwhsec_[A-Za-z0-9+/=]{20,}/],
  ['sendgrid_key', /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/],
  ['twilio_key', /\b(?:SK|AC)[0-9a-f]{32}\b/],
  ['mailgun_key', /\bkey-[0-9a-f]{32}\b/],
  ['npm_token', /\bnpm_[A-Za-z0-9]{36}\b/],
  ['pypi_token', /\bpypi-[A-Za-z0-9_-]{32,}/],
  ['huggingface_token', /\bhf_[A-Za-z0-9]{30,}/],
  ['digitalocean_token', /\bdo[opr]_v1_[a-f0-9]{64}\b/],
  ['linear_key', /\blin_(?:api|oauth)_[A-Za-z0-9]{32,}/],
  ['notion_token', /\b(?:secret_[A-Za-z0-9]{43}|ntn_[A-Za-z0-9]{40,})\b/],
  ['supabase_token', /\b(?:sbp|sb_secret)_[A-Za-z0-9_-]{30,}/],
  ['shopify_token', /\bshp(?:at|ca|pa|ss)_[a-fA-F0-9]{32}\b/],
  ['vercel_token', /\b(?:vercel_|vc[pkai]_)[A-Za-z0-9]{24,}/],
  ['replicate_token', /\br8_[A-Za-z0-9]{32,}/],
  ['groq_key', /\bgsk_[A-Za-z0-9]{32,}/],
  ['xai_key', /\bxai-[A-Za-z0-9]{32,}/],
  ['perplexity_key', /\bpplx-[A-Za-z0-9]{32,}/],
  ['myclawn_token', /\b(?:clw|mcc|mcr|mcn|mcnr)_[A-Za-z0-9_-]{20,}/],
  // Whoever holds a claim link can take the agent over. The owner gets it in chat, nobody else.
  ['claim_link', /\/claim\/[A-Za-z0-9_-]{16,}/],
  ['age_key', /\bAGE-SECRET-KEY-1[A-Z0-9]{50,}/],
  ['xprv_key', /\b[xyz]prv[1-9A-HJ-NP-Za-km-z]{70,}/],
  ['pem_private_key', /-{3,}\s*BEGIN[A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?\s*-{3,}/],
  ['jwt', /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]{8,}/],
  ['gcp_service_account', /"private_key(?:_id)?"\s*:\s*"[^"]{8,}"/],
];

const ENV_KEY = /(?:^|[\s;,{(\[`"'])(?:export\s+)?["']?((?:[A-Za-z_][A-Za-z0-9_.-]*?)?(?:SECRET|TOKEN|PASSWORD|PASSWD|PASSPHRASE|PWD|_PASS|API[_-]?KEY|APIKEY|PRIVATE[_-]?KEY|ACCESS[_-]?KEY|AUTH[_-]?KEY|CREDENTIALS?|SEED[_-]?PHRASE|MNEMONIC|DATABASE_URL|DB_URL|DSN|CONN(?:ECTION)?_?STR(?:ING)?)[A-Za-z0-9_.-]*)["']?\s*(=|:=|:|=>)\s*["'`]?([^\s"'`,;)}\]]{5,})/gi;

function envFinding(text) {
  for (const m of text.matchAll(ENV_KEY)) {
    const [, key, sep, value] = m;
    if (PLACEHOLDER.test(value)) continue;
    if (/^(?:auth|oauth|jwt|basic|bearer|required|optional|enabled|disabled|rotation|budget|limits?|counts?|usage)$/i.test(value)) continue;
    // Prose such as "password: complexity" or "token: budgets" is lowercase letters after a colon on a lowercase key.
    if (sep === ':' && /^[a-z]+$/.test(value) && key === key.toLowerCase()) continue;
    if (/^\d+$/.test(value) && key.toLowerCase().includes('token')) continue; // max_tokens=4096
    if (/(?:max|min|num|total|input|output|count|cache)[_.-]?tokens?/i.test(key)) continue;
    return 'env_secret_assignment';
  }
  return null;
}

function hashContextBefore(text, index) {
  return /(?:sha-?\d*|md5|commit|digest|checksum|hash|etag|integrity|tx|txn|transaction|block|cid|revision|rev)\b[^\n]{0,24}$/i.test(text.slice(Math.max(0, index - 48), index));
}

const isUuid = (t) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(t);

function entropyFinding(text) {
  for (const m of text.matchAll(/[A-Za-z0-9+/=_-]{24,}/g)) {
    const t = m[0];
    if (isUuid(t)) continue;
    const pure = t.replace(/^[-_/=]+|[-_/=]+$/g, '');
    if (pure.length < 24) continue;
    // Domain, path or slug pieces are judged segment by segment unless the token is clearly one blob.
    const segments = pure.split(/[-_/]/).filter(Boolean);
    const blob = pure.includes('+') || pure.endsWith('=') || segments.some((s) => s.length >= 24);
    if (!blob) continue;
    for (const seg of segments.filter((s) => s.length >= 24)) {
      if (looksRandom(seg, text, m.index)) return 'high_entropy_string';
    }
    if ((pure.includes('+') || pure.endsWith('=')) && pure.length >= 32 && looksRandom(pure.replace(/[-_]/g, ''), text, m.index)) return 'high_entropy_string';
  }
  return null;
}

function looksRandom(t, text, index) {
  if (/^0x[0-9a-fA-F]{40}$/.test(t)) return false;
  if (/^(?:0x)?[0-9a-fA-F]+$/.test(t)) {
    const body = t.replace(/^0x/, '');
    if (body.length < 32 || shannon(body) < 3) return false;
    if (hashContextBefore(text, index)) return false;
    return true;
  }
  const hasDigit = /\d/.test(t);
  const hasLower = /[a-z]/.test(t);
  const hasUpper = /[A-Z]/.test(t);
  const classes = [hasDigit, hasLower, hasUpper].filter(Boolean).length;
  const h = shannon(t);
  if (classes < 2) return false;
  // Identifiers change character class rarely; random strings change it constantly.
  let transitions = 0;
  const cls = (c) => (/[a-z]/.test(c) ? 0 : /[A-Z]/.test(c) ? 1 : /\d/.test(c) ? 2 : 3);
  for (let i = 1; i < t.length; i++) if (cls(t[i]) !== cls(t[i - 1])) transitions++;
  const rate = transitions / t.length;
  if (!hasDigit && h < 4.4) return false; // camelCaseIdentifiersWithoutDigits
  if (h >= 4.4 && rate >= 0.2) return true;
  return h >= 3.6 && rate >= 0.3;
}

function luhn(d) {
  let sum = 0;
  let alt = false;
  for (let i = d.length - 1; i >= 0; i--) {
    let n = d.charCodeAt(i) - 48;
    if (alt && (n *= 2) > 9) n -= 9;
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

function ibanOk(s) {
  const c = s.replace(/\s+/g, '').toUpperCase();
  if (c.length < 15 || c.length > 34) return false;
  const moved = (c.slice(4) + c.slice(0, 4)).replace(/[A-Z]/g, (l) => String(l.charCodeAt(0) - 55));
  let rem = 0;
  for (const ch of moved) rem = (rem * 10 + +ch) % 97;
  return rem === 1;
}

function financialFinding(text) {
  for (const m of text.matchAll(/(?<![\d.-])(?:\d[ -]?){13,19}(?![\d-])/g)) {
    const d = m[0].replace(/\D/g, '');
    // Grouped like a card, and passes the checksum.
    if (d.length >= 13 && d.length <= 19 && luhn(d) && /^[3-6]/.test(d)) return 'payment_card_number';
  }
  if (/\b\d{3}-\d{2}-\d{4}\b/.test(text)) return 'us_ssn';
  for (const m of text.matchAll(/\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}(?:[ ]?[A-Z0-9]{1,4})?\b/g)) if (ibanOk(m[0])) return 'iban';
  return null;
}

function walletKeyFinding(text) {
  for (const m of text.matchAll(/(?<![0-9a-zA-Z])0x[0-9a-fA-F]{64}(?![0-9a-zA-Z])/g)) {
    if (!hashContextBefore(text, m.index) && shannon(m[0].slice(2)) >= 3) return 'wallet_private_key';
  }
  if (/\b(?:private[ _-]?key|secret[ _-]?key|priv[ _-]?key|seed)\b[^\n]{0,24}[0-9a-fA-F]{64}\b/i.test(text)) return 'wallet_private_key';
  return null;
}

let bip39 = null;
async function loadBip39() {
  if (!bip39) bip39 = new Set((await import('./bip39-words.mjs')).default);
  return bip39;
}

export async function mnemonicFinding(text) {
  const runs = text.toLowerCase().match(/\b[a-z]{3,8}(?:[\s,.;:|/-]+(?:\d{1,2}[.):]?\s*)?[a-z]{3,8}){11,}\b/g);
  if (!runs) return null;
  const words = await loadBip39();
  for (const run of runs) {
    const parts = run.split(/[^a-z]+/).filter(Boolean);
    let streak = 0;
    for (const w of parts) {
      streak = words.has(w) ? streak + 1 : 0;
      // English prose has long BIP39 runs far less often than 12 straight, and seed phrases are exactly that.
      if (streak >= 12 && mnemonicShape(parts)) return 'seed_phrase';
    }
  }
  return null;
}

// Prose carries function words; a seed phrase practically never has several of them.
function mnemonicShape(parts) {
  const fn = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'your', 'you', 'are', 'was', 'our', 'not', 'but', 'have', 'has', 'will', 'can', 'all', 'who', 'what', 'when', 'how', 'why', 'into', 'about', 'they', 'them', 'their', 'she', 'his', 'her', 'its', 'were', 'been', 'would', 'could', 'should', 'than', 'then', 'these', 'those', 'there', 'where', 'which', 'while', 'because', 'also', 'just', 'very', 'more', 'most', 'some', 'any', 'each', 'other', 'over', 'under', 'after', 'before', 'between', 'through']);
  const count = parts.filter((p) => fn.has(p)).length;
  return count / parts.length < 0.1;
}

const PLACEHOLDER_EMAIL_DOMAIN = /@(?:(?:[\w-]+\.)*example\.(?:com|org|net)|[\w.-]+\.(?:test|invalid|example|localhost)|localhost|domain\.com|email\.com)$/i;

function piiFindings(text, mode) {
  const out = new Set();
  for (const m of text.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g)) {
    if (!PLACEHOLDER_EMAIL_DOMAIN.test(m[0])) out.add('email');
  }
  if (/\b[\w.+-]+\s*(?:\(at\)|\[at\]|\{at\}|\sat\s)\s*[\w-]+\s*(?:\(dot\)|\[dot\]|\{dot\}|\sdot\s)\s*[a-z]{2,}\b/i.test(text)) out.add('email');
  for (const m of text.matchAll(/(?<![\w.$€£])\+\d[\d\s().-]{7,20}\d(?![\w%])/g)) {
    const n = m[0].replace(/\D/g, '').length;
    if (n >= 8 && n <= 15) out.add('phone');
  }
  if (/(?<![\d.-])\(?[2-9]\d{2}\)?[\s.-]\d{3}[\s.-]\d{4}(?![\d.-])/.test(text)) out.add('phone');
  if (/(?<![\d.])00[1-9]\d[\s-]?\d[\d\s-]{6,14}\d(?![\d.])/.test(text)) out.add('phone');
  if (/\b(?:call|phone|tel|telephone|mobile|cell|whats\s?app|signal|sms|text me|fax|handy|telefon)\b[^\d\n]{0,15}\+?\d[\d\s().-]{6,18}\d/i.test(text)) out.add('phone');
  // Street addresses. Case-sensitive on purpose: "10 best ways" and "3 main roads" must pass.
  if (/\b\d{1,5}[A-Za-z]?\s+(?:[NSEW]\.?\s+)?(?:(?!Hard\b|Flash\b|Thumb\b|Test\b|Google\b|One\b|Big\b|Best\b|New\b|Fast\b|Easy\b|Simple\b|Key\b|Top\b)[A-Z][A-Za-z'.-]*\s+){1,4}(?:Street|St\.?|Avenue|Ave\.?|Road|Rd\.?|Boulevard|Blvd\.?|Lane|Ln\.?|Drive|Dr\.|Terrace|Parkway|Pkwy\.?|Highway|Hwy\.?)(?=[\s,.;]|$)/.test(text)) out.add('address');
  if (/\b[A-ZÄÖÜ][\wäöüß-]*(?:straße|strasse|gasse|platz|allee)\s+\d{1,4}[a-z]?\b/.test(text)) out.add('address');
  if (/\b(?:P\.?\s?O\.?\s?Box|Postfach)\s+\d+/i.test(text)) out.add('address');
  if (/,\s*[A-Z]{2}\s+\d{5}(?:-\d{4})?\b/.test(text)) out.add('address');
  if (/(?:\/home\/|\/Users\/|[A-Za-z]:\\Users\\)(?!(?:user|username|me|you|name|runner|ubuntu|node|<)\b)[A-Za-z0-9._-]+/.test(text)) out.add('home_path');
  // Cards are public: naming yourself or your clients there is against the card rules.
  if (mode === 'card') {
    if (/\b(?:my name is|i am called|i'm called|call me)\s+[A-Z][a-z]+/i.test(text)) out.add('real_name');
    if (/\b(?:[Mm]y|[Oo]ur)\s+[Cc]lients?\s+(?:is|are|include|includes)\s+[A-Z]/.test(text) || /\bclients?\s*:\s*[A-Z][\w&-]+/.test(text) || /\b(?:[Ww]orked|[Ww]orking|[Ww]ork)\s+(?:for|with)\s+[A-Z][\w&-]+(?:\s+(?:Inc|LLC|Ltd|GmbH|AG|Corp|SA|BV))\b/.test(text)) out.add('client_name');
  }
  return out;
}

function foldForScan(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .replace(/[\p{Cf}\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u034F\u115F\u1160\u17B4\u17B5\u180B-\u180F\u3164\uFE00-\uFE0F\uFFA0\u{E0100}-\u{E01EF}]/gu, '');
}

// Encodings an injected agent would be told to use. Only decode what yields mostly printable text.
function decodedVariants(text, depth = 0) {
  const out = [];
  if (depth > 1) return out;
  const printable = (s) => s.length > 4 && [...s].filter((c) => c >= ' ' && c <= '~').length / s.length > 0.9;
  for (const m of text.matchAll(/[A-Za-z0-9+/_-]{20,}={0,2}/g)) {
    const raw = m[0];
    const dec = Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    if (printable(dec)) out.push(dec, ...decodedVariants(dec, depth + 1));
  }
  for (const m of text.matchAll(/\b(?:[0-9a-fA-F]{2}[ :]?){12,}\b/g)) {
    const dec = Buffer.from(m[0].replace(/[ :]/g, ''), 'hex').toString('utf8');
    if (printable(dec)) out.push(dec, ...decodedVariants(dec, depth + 1));
  }
  if (/%[0-9a-fA-F]{2}/.test(text)) {
    try {
      out.push(decodeURIComponent(text));
    } catch {}
  }
  // "s k - a n t - ..." spelled out
  for (const m of text.matchAll(/(?<!\S)(?:\S[ \t.]){15,}\S(?!\S)/g)) if (m[0].split(/[ \t.]/).every((p) => p.length <= 1)) out.push(m[0].replace(/[ \t.]/g, ''));
  return out;
}

const canaries = new Set();
// Exact values of things this machine knows are secret (own keys, env secrets). Zero false positives, whatever the format.
export function addCanary(value) {
  const v = String(value ?? '').trim();
  if (v.length < 8) return;
  canaries.add(v);
  if (/^0x[0-9a-fA-F]+$/.test(v)) canaries.add(v.slice(2));
}

const SENSITIVE_ENV = /SECRET|TOKEN|PASSWORD|PASSWD|API[_-]?KEY|APIKEY|PRIVATE|CREDENTIAL|_KEY$|^KEY_|DATABASE_URL|_DSN$/i;
const NOT_SECRET_ENV = /^(?:SSH_AUTH_SOCK|GPG_KEY|TERM_SESSION_ID|MAX_.*TOKENS?)$/;
let envLoaded = false;
function loadEnvCanaries() {
  if (envLoaded) return;
  envLoaded = true;
  for (const [k, v] of Object.entries(process.env)) {
    if (SENSITIVE_ENV.test(k) && !NOT_SECRET_ENV.test(k) && v && v.length >= 12 && !/^(?:\/|~|true$|false$|https?:\/\/[^@]*$)/.test(v)) addCanary(v);
  }
}

function canaryFinding(variants) {
  loadEnvCanaries();
  if (!canaries.size) return null;
  for (const v of variants) {
    for (const c of canaries) {
      if (v.includes(c) || v.includes(Buffer.from(c).toString('base64').replace(/=+$/, '')) || v.includes(Buffer.from(c).toString('hex'))) return 'known_local_secret';
    }
  }
  return null;
}

function secretRuleScan(text, rules = TOKEN_RULES, needs = null) {
  const found = [];
  for (const [id, re] of rules) {
    const m = re.exec(text);
    if (m && !/EXAMPLE|x{6,}|\.\.\./i.test(m[0]) && (!needs || needs.test(m[0]))) found.push(id);
  }
  return found;
}

function urlCredsFinding(text) {
  for (const m of text.matchAll(/\b[a-z][a-z0-9+.-]{1,20}:\/\/([^\s:/@]+):([^\s:/@]{3,})@[^\s/]+/gi)) {
    if (!PLACEHOLDER.test(m[2]) && !/^(?:pass|pw|pwd|user)$/i.test(m[2])) return 'credentials_in_url';
  }
  return null;
}

function bearerFinding(text) {
  for (const m of text.matchAll(/\b(?:authorization\s*:\s*)?(?:bearer|token|basic)\s+([A-Za-z0-9._~+/-]{20,}={0,2})/gi)) {
    if (/\d/.test(m[1]) && shannon(m[1]) >= 3.2 && !PLACEHOLDER.test(m[1])) return 'auth_header_token';
  }
  return null;
}

/**
 * @param {string} input outgoing text
 * @param {{mode?: 'message'|'card'|'meta', allowPii?: string[]}} opts
 *   mode 'meta' = goes only to our own server (search, escalation), so secrets are blocked, PII is not.
 * @returns {Promise<{ok: boolean, findings: {category: string, rule: string}[], reason?: string}>}
 */
export async function scanOutbound(input, { mode = 'message', allowPii = [] } = {}) {
  const text = foldForScan(input);
  const variants = [text, ...decodedVariants(text)];
  const secret = new Set();
  const pii = new Set();

  const c = canaryFinding(variants);
  if (c) secret.add(c);
  for (const v of variants) {
    for (const id of secretRuleScan(v)) secret.add(id);
    for (const f of [envFinding(v), walletKeyFinding(v), urlCredsFinding(v), bearerFinding(v), financialFinding(v)]) if (f) secret.add(f);
    const mn = await mnemonicFinding(v);
    if (mn) secret.add(mn);
    if (mode !== 'meta') for (const k of piiFindings(v, mode)) pii.add(k);
  }
  const reversed = [...text].reverse().join('');
  for (const id of secretRuleScan(reversed)) secret.add(id);
  // A key cut into groups: "sk-ant-api03 abcDEF 123456", "AKIA-IOSF-ODNN". Provider prefixes only: glued prose reads as anything else.
  for (const glued of [text.replace(/[ \t]+/g, ''), text.replace(/[ \t-]+/g, '')]) for (const id of secretRuleScan(glued, TOKEN_RULES, /\d/)) secret.add(id);
  const e = entropyFinding(text);
  if (e && !secret.size) secret.add(e);

  const allowed = mode === 'message' ? new Set(allowPii) : new Set();
  const findings = [...[...secret].map((rule) => ({ category: 'secret', rule })), ...[...pii].filter((k) => !allowed.has(k)).map((rule) => ({ category: 'pii', rule }))];
  if (!findings.length) return { ok: true, findings: [] };
  return { ok: false, findings, reason: describe(findings, mode) };
}

function describe(findings, mode) {
  const secret = findings.filter((f) => f.category === 'secret').map((f) => f.rule);
  const pii = findings.filter((f) => f.category === 'pii').map((f) => f.rule);
  const parts = [];
  if (secret.length) parts.push(`it appears to contain a secret or sensitive credential (${secret.join(', ')}). Remove it; secrets can never be sent`);
  if (pii.length) {
    parts.push(
      mode === 'card'
        ? `it appears to contain personal or client-identifying details (${pii.join(', ')}). Cards are public and pseudonymous: remove them`
        : `it appears to contain personal details (${pii.join(', ')}). Remove them, or ask your owner via myclawn_needs_you to allow this reveal for this contact`,
    );
  }
  return `Blocked before leaving this machine: ${parts.join('; ')}.`;
}

