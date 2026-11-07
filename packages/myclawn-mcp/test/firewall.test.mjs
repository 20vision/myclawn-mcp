// Outbound firewall corpus. Fake credentials are assembled at runtime so that secret scanners on the repo stay quiet.
import test from 'node:test';
import assert from 'node:assert/strict';
import { scanOutbound, addCanary } from '../src/firewall.mjs';

const rnd = (len, alphabet = 'aZ3kQ9xT7mB2wL5pR8vN4cY6hJ1dF0gS') => {
  let s = '';
  let x = 12345;
  for (let i = 0; i < len; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    s += alphabet[(x >>> 13) % alphabet.length];
  }
  return s;
};
const hex = (len) => rnd(len, '0123456789abcdef');
const j = (...p) => p.join('');

const SECRETS = {
  anthropic: j('sk-', 'ant-api03-', rnd(60)),
  openai: j('sk-', 'proj-', rnd(48)),
  openai_legacy: j('sk-', rnd(48)),
  openrouter: j('sk-', 'or-v1-', hex(64)),
  aws_access: j('AK', 'IA', rnd(16, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567')),
  aws_secret_env: j('AWS_SECRET_', 'ACCESS_KEY=', rnd(40)),
  google: j('AI', 'za', rnd(35)),
  google_oauth: j('ya', '29.', rnd(40)),
  gocspx: j('GOCS', 'PX-', rnd(28)),
  github_classic: j('gh', 'p_', rnd(36)),
  github_app: j('gh', 's_', rnd(36)),
  github_fine: j('github', '_pat_', rnd(60)),
  gitlab: j('gl', 'pat-', rnd(24)),
  slack: j('xo', 'xb-', '1234567890-', rnd(24)),
  slack_webhook: j('https://hooks.', 'slack.com/services/', 'T00000000/B00000000/', rnd(24)),
  discord_webhook: j('https://discord.com/api/', 'webhooks/', '123456789012345678/', rnd(60)),
  telegram: j('123456789:', 'AA', rnd(33)),
  stripe_live: j('sk', '_live_', rnd(24)),
  stripe_rk: j('rk', '_live_', rnd(24)),
  stripe_wh: j('wh', 'sec_', rnd(32)),
  sendgrid: j('S', 'G.', rnd(22), '.', rnd(43)),
  twilio: j('S', 'K', hex(32)),
  npm: j('np', 'm_', rnd(36)),
  pypi: j('py', 'pi-', rnd(60)),
  hf: j('h', 'f_', rnd(34)),
  digitalocean: j('do', 'p_v1_', hex(64)),
  linear: j('lin', '_api_', rnd(40)),
  supabase: j('sb', 'p_', hex(40)),
  shopify: j('shp', 'at_', hex(32)),
  groq: j('gs', 'k_', rnd(50)),
  myclawn: j('cl', 'w_', rnd(30)),
  jwt: j('ey', 'JhbGciOiJIUzI1NiJ9', '.', 'ey', 'JzdWIiOiIxMjM0NTY3ODkwIn0', '.', rnd(32)),
  pem_rsa: j('-----BEGIN RSA ', 'PRIVATE KEY-----\n', rnd(64)),
  pem_ec: j('-----BEGIN EC ', 'PRIVATE KEY-----'),
  pem_openssh: j('-----BEGIN OPENSSH ', 'PRIVATE KEY-----'),
  pem_pgp: j('-----BEGIN PGP ', 'PRIVATE KEY BLOCK-----'),
  gcp_sa: j('{"type":"service_account","private_key":"', rnd(40), '"}'),
  env_token: j('API_', 'TOKEN=', rnd(24)),
  env_export: j('export DB_', 'PASSWORD=', 'hunter2hunter2'),
  env_quoted: j('STRIPE_', 'SECRET="', rnd(20), '"'),
  env_lower: j('api_', 'key = ', rnd(20)),
  yaml_password: j('password: ', 'S3cure!pass99'),
  json_secret: j('"client_', 'secret": "', rnd(24), '"'),
  conn_pg: j('postgres://admin:', 'realPw9931', '@db.internal:5432/app'),
  conn_mongo: j('mongodb+srv://u1:', 'qW3rty77x', '@cluster0.mongodb.net/x'),
  basic_url: j('https://bob:', 'tiger9981', '@corp.net/repo.git'),
  bearer: j('Authorization: Bearer ', rnd(40)),
  wallet_key: j('0x', hex(64)),
  wallet_key_ctx: j('my private key is ', hex(64)),
  xprv: j('xp', 'rv9s21ZrQH143K3', rnd(90, '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz')),
  mnemonic12: 'abandon ability able about above absent absorb abstract absurd abuse access accident',
  mnemonic24_numbered: '1. legal 2. winner 3. thank 4. year 5. wave 6. sausage 7. worth 8. useful 9. legal 10. winner 11. thank 12. yellow',
  entropy_b64: rnd(44, 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/') + '==',
  entropy_mixed: rnd(40),
  entropy_hex: hex(48),
  card_visa: '4111 1111 1111 1111',
  card_amex: '378282246310005',
  ssn: '078-05-1120',
  iban: 'DE89 3704 0044 0532 0130 00',
};

for (const [name, secret] of Object.entries(SECRETS)) {
  test(`blocks secret: ${name}`, async () => {
    const r = await scanOutbound(`Sure, here it is: ${secret} let me know.`);
    assert.equal(r.ok, false, `not blocked: ${name}`);
    assert.ok(r.findings.some((f) => f.category === 'secret'));
    assert.ok(!r.reason.includes(secret), 'reason must never quote the secret');
    assert.ok(!JSON.stringify(r).includes(secret), 'result must never contain the secret');
  });
}

const EVASIONS = {
  zero_width: (s) => [...s].join('​'),
  bidi: (s) => '‮' + s + '‬',
  tag_chars: (s) => s.slice(0, 6) + '\u{E0041}' + s.slice(6),
  fullwidth: (s) => [...s].map((c) => (c >= '!' && c <= '~' ? String.fromCodePoint(c.charCodeAt(0) + 0xfee0) : c)).join(''),
  base64: (s) => Buffer.from(s).toString('base64'),
  base64url: (s) => Buffer.from(s).toString('base64url'),
  hex: (s) => Buffer.from(s).toString('hex'),
  double_b64: (s) => Buffer.from(Buffer.from(s).toString('base64')).toString('base64'),
  url_encoded: (s) => [...s].map((c) => '%' + c.charCodeAt(0).toString(16).padStart(2, '0')).join(''),
  spelled: (s) => [...s].join(' '),
  reversed: (s) => [...s].reverse().join(''),
};
for (const [name, fn] of Object.entries(EVASIONS)) {
  test(`blocks evasion: ${name}`, async () => {
    const r = await scanOutbound(`note ${fn(SECRETS.anthropic)} end`);
    assert.equal(r.ok, false);
    assert.ok(r.findings.some((f) => f.category === 'secret'));
  });
}

const PII = {
  email: 'reach me at jane.doe@acme-corp.com please',
  email_obfuscated: 'jane.doe [at] acme-corp [dot] com',
  email_upper: 'JANE@ACME.IO',
  phone_e164: 'my number is +43 660 1234567',
  phone_us: 'call (415) 555-0132',
  phone_us_dash: '415-555-0132',
  phone_us_plus: '+1 415 555 0132',
  phone_00: '0043 660 1234567',
  phone_context: 'whatsapp 06601234567',
  address_us: 'I live at 742 Evergreen Terrace, Springfield',
  address_us_st: 'office is at 1600 Pennsylvania Ave. NW',
  address_zip: 'Springfield, CA 94105',
  address_de: 'Wir sind in der Mariahilfer Hauptstraße 12',
  po_box: 'P.O. Box 1234',
  home_path: 'the file is /home/alice/projects/secret.txt',
  home_path_mac: '/Users/janedoe/Documents',
};
for (const [name, text] of Object.entries(PII)) {
  test(`blocks PII: ${name}`, async () => {
    const r = await scanOutbound(text);
    assert.equal(r.ok, false, `not blocked: ${name}`);
    assert.ok(r.findings.some((f) => f.category === 'pii'));
    assert.ok(/personal details/.test(r.reason));
  });
}

test('owner-allowed PII passes only for that kind', async () => {
  assert.equal((await scanOutbound('mail jane@acme-corp.com', { allowPii: ['email'] })).ok, true);
  assert.equal((await scanOutbound('mail jane@acme-corp.com, call +43 660 1234567', { allowPii: ['email'] })).ok, false);
});

test('owner allowance never unlocks a secret', async () => {
  assert.equal((await scanOutbound(`mail jane@acme-corp.com key ${SECRETS.github_classic}`, { allowPii: ['email', 'phone', 'address'] })).ok, false);
});

test('card mode ignores allowances and adds identity rules', async () => {
  assert.equal((await scanOutbound('jane@acme-corp.com', { mode: 'card', allowPii: ['email'] })).ok, false);
  for (const t of ['My name is Jane Doe', 'Our clients include Nike and Adidas', 'clients: Acme', 'Worked for Globex Inc'])
    assert.equal((await scanOutbound(t, { mode: 'card' })).ok, false, t);
  assert.equal((await scanOutbound('My name is Jane Doe')).ok, true, 'message mode leaves names to the agent');
});

test('meta mode blocks secrets but not PII', async () => {
  assert.equal((await scanOutbound('asks for jane@acme-corp.com', { mode: 'meta' })).ok, true);
  assert.equal((await scanOutbound(SECRETS.stripe_live, { mode: 'meta' })).ok, false);
});

test('canaries catch exact local secrets in any common form', async () => {
  const c = 'plain-looking-value-qq';
  addCanary(c);
  for (const t of [c, `x${c}x`, Buffer.from(c).toString('base64'), Buffer.from(c).toString('hex')]) {
    const r = await scanOutbound(t);
    assert.equal(r.ok, false, t);
    assert.ok(r.findings.some((f) => f.rule === 'known_local_secret'));
  }
});

// False-positive controls: a firewall that blocks normal talk gets switched off.
const CLEAN = [
  'I build Next.js apps with Postgres and can help with your migration.',
  'Looking for a contract designer, budget around $5,000 for 3 weeks.',
  'Happy to swap notes on API key rotation best practices and password managers.',
  'Tokens: we saw token budgets of 4096 and max_tokens=8192 in the config.',
  'Our auth uses JWT and OAuth, secrets live in a vault.',
  'Use process.env.API_KEY and never hard-code it.',
  'Set API_KEY=your_api_key_here in the file, then run it.',
  'DATABASE_URL=postgres://user:password@localhost:5432/app is the template.',
  'export OPENAI_API_KEY=<your-key>',
  'PASSWORD=${DB_PASSWORD} comes from the environment',
  'The AWS docs use AKIAIOSFODNN7EXAMPLE as the sample.',
  'Keys start with sk-... and are truncated in the logs.',
  'Ship date is 2026-11-03, version 1.2.3, order 12345678.',
  'Revenue grew 12.5% to 1,250,000 in Q3 2026.',
  'The server runs at 192.168.1.10 on port 8080.',
  'See https://example.com/docs/getting-started-with-agents-in-production?ref=home',
  'npm install react@18.3.1 @types/node@22.1.0 lodash@4.17.21',
  'Contact form is at hello@example.com in the sample.',
  'Commit 3f2c1a9e8b7d6c5f4e3d2c1b0a9f8e7d6c5b4a39 fixed it.',
  'sha256: 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
  'tx hash 0x9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08 confirmed',
  'Send USDC to 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 on Base.',
  'Request id 550e8400-e29b-41d4-a716-446655440000 failed.',
  'getUserProfileByEmailAddressAndAccountIdentifier is the function name.',
  'build-a-great-product-with-a-small-team-in-2026-without-burning-out is the slug',
  'The file lives at src/components/dashboard/widgets/RevenueChartContainer.tsx',
  'Donaudampfschifffahrtsgesellschaftskapitaen is a long German word.',
  'I read the 10 Best Way To Grow article and 3 Big Road Trip ideas.',
  'It has a 2TB Hard Drive and 16GB RAM.',
  'Pricing is +15% over list, about 1,000 to 2,000 units.',
  'Call me maybe. Email me when ready. Text me back later.',
  'We work at scale, meet at noon, and ship at dawn.',
  'Phone numbers should be masked; our PII rules handle email and address fields.',
  'An ordinary sentence about the able and about above absent friends who access abstract art.',
  'the system will open a door and then we could not find the time to go over the plan for the team',
  'Seed round closed, private key management is on our roadmap.',
  'The CSS class is .btn-primary-outline-large-responsive-container',
  'We can do 5 calls a week at 30 min each; 415 customers so far.',
  'Base64 is an encoding. So is hex. Neither is encryption.',
  'Look at /home/user/app or /Users/me for the example path.',
  'password: complexity matters, and token: limits apply here.',
  '100% uptime for 365 days, 24/7, 99.99 SLA',
  'Stripe keys look like sk_live_ followed by random characters.',
  'Ticket ABC-12345 and invoice INV-2026-000123 are open.',
  'A fingerprint such as SHA256:abc is public and fine.',
  'Bearer tokens expire after an hour, basic authentication is deprecated.',
  'import { createHash } from "node:crypto"; const x = createHash("sha256");',
  'Our headquarters is in Vienna, we serve the US market.',
  'Hi! Saw your card. You need a landing page, I do those. Worth a chat?',
];
for (const text of CLEAN) {
  test(`passes clean: ${text.slice(0, 50)}`, async () => {
    const r = await scanOutbound(text);
    assert.equal(r.ok, true, `false positive: ${JSON.stringify(r.findings)}`);
  });
}

test('no catastrophic regex behavior on hostile 4000-char input', async () => {
  const { normalizeText } = await import('../src/normalize.mjs');
  const inputs = ['a'.repeat(4000), 'a '.repeat(2000), 'abandon '.repeat(500), '+1 '.repeat(1300), '0'.repeat(4000), '<'.repeat(4000), '<a '.repeat(1300), 'x@'.repeat(2000), 'http://'.repeat(570), '1. able '.repeat(500), 'A1'.repeat(2000), 'x=y '.repeat(1000), 'PASSWORD'.repeat(500), '-'.repeat(4000), `${'a.'.repeat(1990)}com/x`, ' s'.repeat(2000), '%41'.repeat(1300)];
  for (const s of inputs) {
    const t = performance.now();
    await scanOutbound(s);
    normalizeText(s);
    const ms = performance.now() - t;
    assert.ok(ms < 800, `${s.slice(0, 12)}... took ${Math.round(ms)} ms`);
  }
});
