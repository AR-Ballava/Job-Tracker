import express from 'express';
import * as cheerio from 'cheerio';
import pg from 'pg';
import path from 'node:path'; import net from 'node:net';
import dns from 'node:dns/promises'; import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import PAGE from './page.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try { process.loadEnvFile(path.join(ROOT, '.env')); } catch {}   // local dev only; on a host, use real env vars
const today = () => new Date().toISOString().slice(0, 10);
const now = () => new Date().toISOString();

// ---------- storage: Postgres (Neon, added from the Vercel Marketplace). Tables are created on the first request ----------
// Accepts DATABASE_URL, POSTGRES_URL, or any pooled postgres:// variable Vercel added (e.g. STORAGE_URL if you chose a custom prefix)
const DB_URL = process.env.DATABASE_URL || process.env.POSTGRES_URL ||
  Object.entries(process.env).find(([k, v]) => /^postgres(ql)?:\/\//.test(v || '') && !/UNPOOLED|NON_POOLING/.test(k))?.[1];
const missing = [!DB_URL && 'DATABASE_URL', !process.env.SESSION_SECRET && 'SESSION_SECRET'].filter(Boolean);
const pool = DB_URL ? new pg.Pool({ connectionString: DB_URL, max: 3, idleTimeoutMillis: 10000 }) : null;
const q = (text, params) => pool.query(text, params).then(r => r.rows);
let ready;
const init = () => ready ||= (async () => {
  await q(`CREATE TABLE IF NOT EXISTS users(id SERIAL PRIMARY KEY, email TEXT UNIQUE NOT NULL, pw TEXT NOT NULL, created TEXT)`);
  await q(`CREATE TABLE IF NOT EXISTS jobs(id SERIAL PRIMARY KEY, user_id INT NOT NULL, company TEXT, role TEXT, job_url TEXT, location TEXT,
   work_mode TEXT, salary TEXT, job_type TEXT, status TEXT DEFAULT 'Wishlist', date_added TEXT, date_applied TEXT, source TEXT,
   referral_contact TEXT, referral_status TEXT, interview_date TEXT, next_follow_up_date TEXT, priority TEXT DEFAULT 'medium',
   notes TEXT, job_description_full TEXT, summary TEXT, posted_date TEXT, ai_filled_fields TEXT DEFAULT '[]',
   needs_review INT DEFAULT 0, last_updated TEXT, deleted INT DEFAULT 0)`);
  await q(`CREATE INDEX IF NOT EXISTS jobs_user ON jobs(user_id)`);
  await q(`CREATE TABLE IF NOT EXISTS history(id SERIAL PRIMARY KEY, job_id INT, status TEXT, at TEXT)`);
  await q(`CREATE TABLE IF NOT EXISTS llm_cache(k TEXT PRIMARY KEY, json TEXT)`);
  await q(`CREATE TABLE IF NOT EXISTS attempts(k TEXT, at BIGINT)`);
})().catch(e => { ready = null; throw e; });

async function insert(o) {
  const k = Object.keys(o);
  const r = await q(`INSERT INTO jobs(${k}) VALUES(${k.map((_, i) => '$' + (i + 1))}) RETURNING id`, k.map(x => o[x] ?? null));
  await q('INSERT INTO history(job_id,status,at) VALUES($1,$2,$3)', [r[0].id, o.status || 'Wishlist', now()]);
  return r[0].id;
}

// ---------- security: only public http(s) URLs (re-checked on every redirect) ----------
async function checkUrl(u) {
  let x; try { x = new URL(u); } catch { throw new Error('That is not a valid URL'); }
  if (!/^https?:$/.test(x.protocol)) throw new Error('Only http/https links are allowed');
  const host = x.hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  for (const { address: a } of addrs)
    if (/^(127\.|10\.|0\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|::1$|f[cd]|fe80)/i.test(a))
      throw new Error('Local/private addresses are blocked');
  return x.href;
}

// ---------- scraper ----------
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const KEYS = ['company', 'role', 'location', 'work_mode', 'salary', 'job_type', 'posted_date', 'summary'];
const clean = s => (s == null ? null : String(s).replace(/\s+/g, ' ').trim() || null);
const put = (o, k, v) => { v = clean(v); if (v && !o[k]) o[k] = v; };   // fill ONLY empty fields
const htmlToText = h => clean(cheerio.load(`<div>${h}</div>`).text());

/* ADD A NEW SITE: one line here. `sel` maps field -> CSS selector. `slug` = company is the first URL path
   segment (Greenhouse/Lever/Ashby style). Sites that block bots simply fall through to later steps. */
const SITES = [
  { re: /greenhouse\.io/, name: 'Greenhouse', slug: true, sel: { role: '.app-title, h1', company: '.company-name', location: '.location' } },
  { re: /lever\.co/, name: 'Lever', slug: true, sel: { role: '.posting-headline h2', location: '.posting-categories .location' } },
  { re: /ashbyhq\.com/, name: 'Ashby', slug: true, sel: { role: 'h1' } },
  { re: /linkedin\.com/, name: 'LinkedIn', sel: { role: '.top-card-layout__title', company: '.topcard__org-name-link', location: '.topcard__flavor--bullet' } },
  { re: /indeed\.com/, name: 'Indeed', sel: { role: '[data-testid="jobsearch-JobInfoHeader-title"]', company: '[data-testid="inlineHeader-companyName"]' } },
  { re: /naukri\.com/, name: 'Naukri', sel: { role: 'h1', company: '.jd-header-comp-name a' } },
  { re: /wellfound\.com/, name: 'Wellfound', sel: { role: 'h1' } },
  { re: /myworkdayjobs\.com/, name: 'Workday', sel: { role: '[data-automation-id="jobPostingHeader"]' } },
];

async function getPage(u) {                                  // follows redirects manually so every hop is safety-checked
  for (let i = 0; i < 5; i++) {
    const r = await fetch(await checkUrl(u), { headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' }, signal: AbortSignal.timeout(15000), redirect: 'manual' });
    if (r.status >= 300 && r.status < 400 && r.headers.get('location')) { u = new URL(r.headers.get('location'), u).href; continue; }
    return r;
  }
  throw new Error('too many redirects');
}

function fromJsonLd($, o) {                                   // step 1
  $('script[type="application/ld+json"]').each((_, el) => {
    let d; try { d = JSON.parse($(el).text()); } catch { return; }
    const list = (Array.isArray(d) ? d : [d, ...(d['@graph'] || [])]).flat();
    const j = list.find(x => x && [].concat(x['@type']).includes('JobPosting'));
    if (!j) return;
    put(o, 'role', j.title); put(o, 'company', j.hiringOrganization?.name);
    const a = [].concat(j.jobLocation || [])[0]?.address;
    if (a) put(o, 'location', [a.addressLocality, a.addressRegion, a.addressCountry?.name || a.addressCountry].filter(Boolean).join(', '));
    if (j.jobLocationType === 'TELECOMMUTE') put(o, 'work_mode', 'remote');
    const v = j.baseSalary?.value;
    if (v) put(o, 'salary', `${j.baseSalary.currency || ''} ${v.minValue ?? v.value ?? ''}${v.maxValue ? '–' + v.maxValue : ''} ${v.unitText ? '/' + v.unitText.toLowerCase() : ''}`);
    put(o, 'job_type', [].concat(j.employmentType || []).join(', ').replace(/_/g, ' ').toLowerCase());
    put(o, 'posted_date', j.datePosted && String(j.datePosted).slice(0, 10));
    if (j.description) o._desc = htmlToText(j.description);
  });
}

function fromMeta($, o) {                                     // step 2 + step 4 (title heuristics)
  put(o, 'company', $('meta[property="og:site_name"]').attr('content'));
  const t = clean($('meta[property="og:title"]').attr('content') || $('title').text());
  if (!t) return;
  const m = t.match(/^(.+?)\s+(?:at|@)\s+(.+?)(?:\s*[|\-–].*)?$/i) || t.match(/^(.+?)\s+[-–|]\s+(.+?)(?:\s*[|\-–].*)?$/);
  if (m) { put(o, 'role', m[1]); put(o, 'company', m[2]); } else put(o, 'role', t);
}

function fromSite($, o, url) {                                // step 3
  const u = new URL(url), s = SITES.find(x => x.re.test(u.hostname));
  if (!s) return u.hostname.replace(/^www\./, '');
  for (const [k, sel] of Object.entries(s.sel)) put(o, k, $(sel).first().text());
  if (s.slug) { const g = u.pathname.split('/')[1]; if (g) put(o, 'company', g.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase())); }
  return s.name;
}

function pageText($) {                                        // clean text for the LLM, max 12k chars
  $('script,style,nav,footer,header,noscript,svg,iframe,form').remove();
  const root = $('main').length ? $('main') : $('article').length ? $('article') : $('body');
  return (clean(root.text()) || '').slice(0, 12000);
}

// ---------- LLM fallback ----------
const PRESETS = {
  gemini: { base: 'https://generativelanguage.googleapis.com/v1beta/openai/', model: 'gemini-2.5-flash', key: 'GEMINI_API_KEY' },
  groq: { base: 'https://api.groq.com/openai/v1', model: 'openai/gpt-oss-120b', key: 'GROQ_API_KEY' },
  openrouter: { base: 'https://openrouter.ai/api/v1', model: 'meta-llama/llama-3.3-70b-instruct:free', key: 'OPENROUTER_API_KEY' },
  ollama: { base: 'http://localhost:11434/v1', model: 'llama3.1', key: null },
};
const SYS = 'Extract job details. Return ONLY valid JSON with keys: company, role, location, work_mode (remote/hybrid/onsite/null), salary, job_type, posted_date, summary (max 500 chars). Use null for anything not stated. Never guess.';

export async function askLLM(text, fetchFn = fetch) {
  const limited = [];
  for (const n of (process.env.LLM_PROVIDERS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean)) {
    const p = PRESETS[n]; if (!p) continue;
    const key = process.env[p.key]; if (p.key && !key) continue;
    for (let attempt = 0; attempt < 2; attempt++) {           // 2nd attempt = retry on invalid JSON
      try {
        const r = await fetchFn(p.base.replace(/\/$/, '') + '/chat/completions', {
          method: 'POST', signal: AbortSignal.timeout(60000),
          headers: { 'Content-Type': 'application/json', ...(key && { Authorization: 'Bearer ' + key }) },
          body: JSON.stringify({ model: process.env[n.toUpperCase() + '_MODEL'] || p.model, temperature: 0,
            messages: [{ role: 'system', content: SYS }, { role: 'user', content: text }] }) });
        if (r.status === 429) { limited.push(n); break; }       // rate limited -> next provider
        if (!r.ok) break;
        const c = (await r.json()).choices?.[0]?.message?.content || '';
        return { data: JSON.parse(c.replace(/```(?:json)?/g, '').replace(/^[^{]*/, '').replace(/[^}]*$/, '')), provider: n, limited };
      } catch { /* bad JSON or network error: retry once */ }
    }
  }
  return { data: null, limited };
}

// ---------- build a job record from a URL (and/or pasted text) ----------
export async function build(url, pasted) {
  const o = {}, warnings = []; let text = pasted || '', source = new URL(url).hostname.replace(/^www\./, ''), blocked = false;
  if (!pasted) {
    try {
      const r = await getPage(url);
      if (!r.ok) throw new Error(`site returned HTTP ${r.status}`);
      const $ = cheerio.load(await r.text());
      fromJsonLd($, o); source = fromSite($, o, url); fromMeta($, o);
      text = o._desc || pageText($);
      if (!text && !o.role) blocked = true;
    } catch (e) { blocked = true; warnings.push(`Could not read the page (${e.message}). Saved for review.`); }
  }
  const ai = []; let provider = null;
  const gaps = KEYS.filter(k => !o[k]);
  if (gaps.length && text.length > 200) {
    const ck = crypto.createHash('sha1').update(pasted ? text : url).digest('hex');
    let res = (await q('SELECT json FROM llm_cache WHERE k=$1', [ck]))[0];
    res = res ? JSON.parse(res.json) : await askLLM(text.slice(0, 12000));
    if (res.data) {
      await q('INSERT INTO llm_cache VALUES($1,$2) ON CONFLICT(k) DO UPDATE SET json=$2', [ck, JSON.stringify(res)]);
      provider = res.provider;
      for (const k of gaps) {                                   // LLM fills gaps only
        let v = clean(res.data[k]); if (!v || v === 'null') continue;
        if (k === 'work_mode') { v = v.toLowerCase(); if (!/^(remote|hybrid|onsite)$/.test(v)) continue; }
        o[k] = v; ai.push(k);
      }
    }
    if (res.limited?.length) warnings.push(`Rate limit hit on ${res.limited.join(', ')}.`);
  }
  const row = { company: o.company, role: o.role, job_url: url, location: o.location, work_mode: o.work_mode, salary: o.salary,
    job_type: o.job_type, posted_date: o.posted_date, summary: (o.summary || (text || '').slice(0, 500)) || null,
    job_description_full: text || null, source, status: 'Wishlist', date_added: today(), last_updated: now(),
    ai_filled_fields: JSON.stringify(ai), needs_review: blocked || !o.company || !o.role ? 1 : 0 };
  return { row, warnings, provider };
}

// ---------- auth: email + password, signed cookie session (no extra libraries) ----------
const SECRET = process.env.SESSION_SECRET || 'missing';   // sessions are signed with it (required, checked below)
const sign = v => { const b = Buffer.from(JSON.stringify(v)).toString('base64url'); return b + '.' + crypto.createHmac('sha256', SECRET).update(b).digest('base64url'); };
function unsign(t) {
  try {
    const [b, s] = (t || '').split('.'); if (!s) return;
    const e = crypto.createHmac('sha256', SECRET).update(b).digest('base64url');
    if (s.length !== e.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(e))) return;
    const v = JSON.parse(Buffer.from(b, 'base64url')); return v.exp > Date.now() ? v : undefined;
  } catch {}
}
const scrypt = (p, s) => new Promise((ok, no) => crypto.scrypt(p, s, 32, (e, k) => e ? no(e) : ok(k)));
const hash = async p => { const s = crypto.randomBytes(16); return s.toString('hex') + ':' + (await scrypt(p, s)).toString('hex'); };
const check = async (p, h) => { const [s, k] = h.split(':'); return crypto.timingSafeEqual(await scrypt(p, Buffer.from(s, 'hex')), Buffer.from(k, 'hex')); };
async function limit(req) {                                  // brute-force guard stored in the DB (serverless has no shared memory): 10 tries / 15 min / IP
  const t = Date.now();
  await q('DELETE FROM attempts WHERE at<$1', [t - 9e5]);
  if (Number((await q('SELECT count(*) c FROM attempts WHERE k=$1', [req.ip]))[0].c) >= 10) throw new Error('Too many attempts. Try again in 15 minutes.');
  await q('INSERT INTO attempts VALUES($1,$2)', [req.ip, t]);
}
const EMAIL = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/, PASS = /^[A-Za-z0-9]{6,64}$/;
const login = (req, res, uid) => res.setHeader('Set-Cookie', `sid=${sign({ uid, exp: Date.now() + 30 * 864e5 })}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${30 * 86400}${req.secure ? '; Secure' : ''}`);
const creds = req => ({ email: String(req.body.email || '').trim().toLowerCase(), pw: String(req.body.password || '') });
const auth = (req, res, next) => {
  const s = unsign((req.headers.cookie || '').match(/(?:^|; )sid=([^;]+)/)?.[1]);
  if (!s) return res.status(401).json({ error: 'Please log in' });
  req.uid = s.uid; next();
};

// ---------- API ----------
const app = express();
app.set('trust proxy', 1);
if (missing.length) app.use((_req, res) => res.status(500).type('text').send(   // readable message instead of a blank 500
  'Setup incomplete. Missing environment variable(s): ' + missing.join(', ') + '. Add them in Vercel > Settings > Environment Variables, then Redeploy.'));                                    // hosts put an HTTPS proxy in front
app.use(express.json({ limit: '2mb' }));
app.get(['/', '/index.html'], (_req, res) => res.type('html').set('Cache-Control', 'no-cache').send(PAGE));   // the UI
app.get('/favicon.ico', (_req, res) => res.status(204).end());
app.use('/api', async (_req, _res, next) => { await init(); next(); });   // create tables once per instance
app.get('/healthz', (_, res) => res.send('ok'));

app.post('/api/signup', async (req, res) => {
  await limit(req); const { email, pw } = creds(req);
  if (!EMAIL.test(email)) throw new Error('Enter a valid email address');
  const allowed = (process.env.ALLOWED_EMAILS || '').toLowerCase().split(',').map(x => x.trim()).filter(Boolean);   // signup is invite-only
  if (!allowed.includes(email)) throw new Error('Signup is limited to invited emails');
  if (!PASS.test(pw)) throw new Error('Password must be 6+ letters or numbers (no spaces or symbols)');
  try { const r = await q('INSERT INTO users(email,pw,created) VALUES($1,$2,$3) RETURNING id', [email, await hash(pw), now()]); login(req, res, r[0].id); res.json({ ok: true }); }
  catch (e) { throw e.code == '23505' ? new Error('That email is already registered') : e; }
});
app.post('/api/login', async (req, res) => {
  await limit(req); const { email, pw } = creds(req);
  const u = (await q('SELECT id,pw FROM users WHERE email=$1', [email]))[0];
  if (!u || !(await check(pw, u.pw))) throw new Error('Wrong email or password');
  login(req, res, u.id); res.json({ ok: true });
});
app.post('/api/logout', (_, res) => { res.setHeader('Set-Cookie', 'sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0'); res.json({ ok: true }); });
app.use('/api/jobs', auth); app.use('/api/export.csv', auth);   // everything below needs a login

const EDIT = ['company', 'role', 'job_url', 'location', 'work_mode', 'salary', 'job_type', 'status', 'date_applied', 'referral_contact',
  'referral_status', 'interview_date', 'next_follow_up_date', 'priority', 'notes'];
const LIST = 'id,company,role,job_url,location,work_mode,salary,job_type,status,date_added,date_applied,source,next_follow_up_date,priority,notes,ai_filled_fields,needs_review';
const own = async (id, uid) => (await q('SELECT * FROM jobs WHERE id=$1 AND user_id=$2', [parseInt(id) || 0, uid]))[0];

app.get('/api/jobs', async (req, res) => res.json(await q(`SELECT ${LIST} FROM jobs WHERE user_id=$1 AND deleted=0 ORDER BY id DESC`, [req.uid])));
app.get('/api/jobs/:id', async (req, res) => {
  const j = await own(req.params.id, req.uid); if (!j) return res.status(404).json({ error: 'Not found' });
  res.json({ ...j, history: await q('SELECT status,at FROM history WHERE job_id=$1 ORDER BY id', [j.id]) });
});

app.post('/api/jobs', async (req, res) => {
  const original = String(req.body.url || '').trim();          // saved exactly as pasted
  const url = await checkUrl(original);
  const dup = (await q('SELECT id,company,role FROM jobs WHERE job_url=$1 AND user_id=$2 AND deleted=0', [original, req.uid]))[0];
  if (dup && !req.body.force) return res.status(409).json({ error: 'Already tracked', dup });
  if (Number((await q('SELECT count(*) c FROM jobs WHERE user_id=$1 AND date_added=$2', [req.uid, today()]))[0].c) >= 50) throw new Error('Daily limit of 50 added jobs reached');
  const { row, warnings, provider } = await build(url, req.body.text);
  row.job_url = original; row.user_id = req.uid;
  res.json({ id: await insert(row), warnings, provider, needs_review: !!row.needs_review });
});

app.patch('/api/jobs/:id', async (req, res) => {
  const cur = await own(req.params.id, req.uid); if (!cur) return res.status(404).json({ error: 'Not found' });
  const set = {}; let ai = JSON.parse(cur.ai_filled_fields || '[]');
  for (const k of EDIT) if (k in req.body) { set[k] = req.body[k] === '' ? null : String(req.body[k]).slice(0, 5000); ai = ai.filter(f => f !== k); }
  if (set.status && set.status !== cur.status) {
    await q('INSERT INTO history(job_id,status,at) VALUES($1,$2,$3)', [cur.id, set.status, now()]);
    if (set.status === 'Applied' && !cur.date_applied && !set.date_applied) set.date_applied = today();
  }
  set.ai_filled_fields = JSON.stringify(ai); set.last_updated = now();
  if ((set.company ?? cur.company) && (set.role ?? cur.role)) set.needs_review = 0;
  const k = Object.keys(set);
  await q(`UPDATE jobs SET ${k.map((x, i) => x + '=$' + (i + 1))} WHERE id=$${k.length + 1} AND user_id=$${k.length + 2}`, [...k.map(x => set[x]), cur.id, req.uid]);
  res.json({ ok: true, date_applied: set.date_applied });
});

app.delete('/api/jobs/:id', async (req, res) => { await q('UPDATE jobs SET deleted=1 WHERE id=$1 AND user_id=$2', [parseInt(req.params.id) || 0, req.uid]); res.json({ ok: true }); });
app.post('/api/jobs/:id/undelete', async (req, res) => { await q('UPDATE jobs SET deleted=0 WHERE id=$1 AND user_id=$2', [parseInt(req.params.id) || 0, req.uid]); res.json({ ok: true }); });

app.get('/api/export.csv', async (req, res) => {
  const rows = await q('SELECT id,company,role,job_url,work_mode,salary,job_type,status,date_added,date_applied,source,referral_contact,referral_status,interview_date,next_follow_up_date,priority,notes,needs_review,last_updated FROM jobs WHERE user_id=$1 AND deleted=0 ORDER BY id', [req.uid]);
  const c = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  res.type('text/csv').attachment('applications.csv').send('\uFEFF' + [Object.keys(rows[0] || { id: 1 }).join(','), ...rows.map(r => Object.values(r).map(c).join(','))].join('\r\n'));
});

app.use((e, _req, res, _next) => res.status(400).json({ error: e.message }));

export default app;   // Vercel runs this as a serverless function; `npm start` uses local.js
