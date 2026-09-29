'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { DB } = require('./lib/db');
const { Engine, HttpError } = require('./lib/engine');
const T = require('./lib/time');

const PORT = +process.env.PORT || 3000;
const BASE = process.env.BASE_URL || `http://localhost:${PORT}`;
const db = new DB(process.env.DB_FILE || path.join(__dirname, 'data', 'db.json'));
const eng = new Engine(db, { baseUrl: BASE });
const PUB = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };

const routes = [];
const route = (method, pattern, fn, auth) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '([^/]+)') + '$'), keys: [...pattern.matchAll(/:(\w+)/g)].map((m) => m[1]), fn, auth });
const pub = (m, p, fn) => route(m, p, fn, false);
const own = (m, p, fn) => route(m, p, fn, true);

// tiny in-memory rate limiter for public writes
const hits = new Map();
function limited(ip, key, max, windowMs) {
  const k = ip + key, now = Date.now(), arr = (hits.get(k) || []).filter((t) => now - t < windowMs);
  arr.push(now); hits.set(k, arr); return arr.length > max;
}

const num = (v) => (v == null || v === '' ? undefined : +v);
const pickBrand = (b = {}) => ({ primary: hex(b.primary), secondary: hex(b.secondary), bg: hex(b.bg), font: ['Heebo', 'Assistant', 'Rubik', 'Varela Round', 'Frank Ruhl Libre'].includes(b.font) ? b.font : 'Heebo', logo: safeUrl(b.logo), cover: safeUrl(b.cover), tone: ['female', 'male', 'neutral'].includes(b.tone) ? b.tone : 'neutral' });
const hex = (c) => (/^#[0-9a-fA-F]{6}$/.test(c || '') ? c : '#7c3aed');
const safeUrl = (u) => (/^https?:\/\/|^data:image\//.test(u || '') ? String(u).slice(0, 500000) : '');
const pid = (biz, q) => (q && q !== 'any' ? q : biz.providers.find((p) => p.active).id);

// ---------------- public ----------------
pub('GET', '/api/public/:slug', (c) => {
  const b = eng.bizBySlug(c.p.slug);
  return { name: b.name, tagline: b.tagline, brand: b.brand, contact: eng.publicContact(b), tone: b.brand.tone, providers: b.providers.filter((p) => p.active).map((p) => ({ id: p.id, name: p.name })), services: b.services.filter((s) => s.active).map((s) => ({ id: s.id, name: s.name, description: s.description, duration: s.duration, price: s.price })), policy: { cancelHours: b.policy.cancelHours, windowDays: b.policy.windowDays } };
});
pub('GET', '/api/public/:slug/days', (c) => { const b = eng.bizBySlug(c.p.slug); return eng.availableDays(b, { serviceId: c.q.serviceId, providerId: c.q.providerId, phone: c.q.phone }); });
pub('GET', '/api/public/:slug/slots', (c) => { const b = eng.bizBySlug(c.p.slug); return eng.slots(b, { serviceId: c.q.serviceId, providerId: c.q.providerId, dateKey: c.q.date, phone: c.q.phone }); });
pub('POST', '/api/public/:slug/book', (c) => {
  if (limited(c.ip, 'book', 10, 600000)) throw new HttpError(429, 'יותר מדי ניסיונות, נסו שוב מאוחר יותר');
  const b = eng.bizBySlug(c.p.slug), x = c.body;
  const a = eng.book(b, { serviceId: x.serviceId, providerId: x.providerId, start: +x.start, name: x.name, phone: x.phone, marketingConsent: !!x.marketingConsent });
  return { token: a.token, status: a.status };
});
pub('POST', '/api/public/:slug/waitlist', (c) => {
  if (limited(c.ip, 'wl', 10, 600000)) throw new HttpError(429, 'יותר מדי ניסיונות');
  const b = eng.bizBySlug(c.p.slug), x = c.body;
  eng.addWaitlist(b, { name: x.name, phone: x.phone, serviceId: x.serviceId, dateFrom: x.dateFrom, dateTo: x.dateTo, note: x.note, marketingConsent: !!x.marketingConsent });
  return { ok: true };
});
pub('GET', '/api/public/:slug/live', (c) => eng.liveBoard(eng.bizBySlug(c.p.slug), c.q.token));

const tokBiz = (a) => eng.d.businesses.find((b) => b.id === a.bizId);
pub('GET', '/api/t/:token', (c) => { const a = eng.apptByToken(c.p.token), b = tokBiz(a); return { board: eng.liveBoard(b), mine: eng.myView(b, a), slug: b.slug }; });
pub('GET', '/api/t/:token/slots', (c) => { const a = eng.apptByToken(c.p.token), b = tokBiz(a); return eng.slots(b, { serviceId: a.serviceId, providerId: 'any', dateKey: c.q.date, phone: eng.cust(a.customerId).phone, excludeId: a.id, ignoreLead: false }); });
pub('GET', '/api/t/:token/days', (c) => { const a = eng.apptByToken(c.p.token), b = tokBiz(a); return eng.availableDays(b, { serviceId: a.serviceId, providerId: 'any', phone: eng.cust(a.customerId).phone, excludeId: a.id }); });
pub('POST', '/api/t/:token/signal', (c) => { eng.customerSignal(eng.apptByToken(c.p.token), c.body.signal); return { ok: true }; });
pub('POST', '/api/t/:token/cancel', (c) => { eng.customerCancel(eng.apptByToken(c.p.token)); return { ok: true }; });
pub('POST', '/api/t/:token/reschedule', (c) => { eng.customerReschedule(eng.apptByToken(c.p.token), +c.body.start); return { ok: true }; });
pub('POST', '/api/t/:token/offer/accept', (c) => { eng.acceptMove(eng.apptByToken(c.p.token)); return { ok: true }; });
pub('POST', '/api/t/:token/offer/decline', (c) => { eng.declineMove(eng.apptByToken(c.p.token)); return { ok: true }; });
pub('GET', '/api/w/:token', (c) => {
  const w = eng.waitByToken(c.p.token), b = eng.d.businesses.find((x) => x.id === w.bizId), s = b.services.find((x) => x.id === w.serviceId);
  return { business: { name: b.name, brand: b.brand, contact: eng.publicContact(b) }, status: w.status, service: s.name, offerTime: w.offer ? T.fmtTime(w.offer.start, b.tz) : null };
});
pub('POST', '/api/w/:token/claim', (c) => { const a = eng.claimWait(eng.waitByToken(c.p.token)); return { token: a.token }; });
pub('POST', '/api/o/:token', (c) => { eng.optOut(c.p.token); return { ok: true }; });

// ---------------- owner ----------------
const provQ = (b, c) => pid(b, c.q.providerId);
own('GET', '/api/owner/me', (c) => { const { salt, ownerKeyHash, ...rest } = c.biz; return rest; });
own('PUT', '/api/owner/profile', (c) => { const b = c.biz, x = c.body; if (x.name) b.name = String(x.name).slice(0, 80); b.tagline = String(x.tagline || '').slice(0, 140); Object.assign(b.contact, { address: x.address || '', whatsapp: x.whatsapp || '', instagram: x.instagram || '', phone: x.phone || '', showPhonePublic: x.showPhonePublic !== false }); eng.save(); return { ok: true }; });
own('PUT', '/api/owner/brand', (c) => { c.biz.brand = pickBrand(c.body); eng.save(); return c.biz.brand; });
own('PUT', '/api/owner/policy', (c) => {
  const p = c.biz.policy, x = c.body;
  const set = (k, v, ok) => { if (v != null && ok(v)) p[k] = v; };
  set('leadMin', num(x.leadMin), (v) => v >= 0 && v <= 1440); set('windowDays', num(x.windowDays), (v) => v >= 1 && v <= 120);
  set('cancelHours', num(x.cancelHours), (v) => v >= 0 && v <= 168); set('alertMin', num(x.alertMin), (v) => [5, 8, 10].includes(v));
  set('gapThreshold', num(x.gapThreshold), (v) => [20, 25, 30, 40].includes(v)); set('softDelayMax', num(x.softDelayMax), (v) => v >= 0 && v <= 15);
  set('marketingMaxDays', num(x.marketingMaxDays), (v) => v >= 1 && v <= 60); set('slotStep', num(x.slotStep), (v) => [5, 10, 15, 30].includes(v));
  if (typeof x.autoConfirm === 'boolean') p.autoConfirm = x.autoConfirm;
  if (Array.isArray(x.reminders)) p.reminders = x.reminders.map(Number).filter((n) => n > 0 && n <= 168).slice(0, 3);
  eng.save(); return p;
});
own('PUT', '/api/owner/hours', (c) => {
  const ok = (l) => Array.isArray(l) && l.every((w) => /^\d\d:\d\d$/.test(w.open) && /^\d\d:\d\d$/.test(w.close) && w.open < w.close);
  if (c.body.hours) { for (let d = 0; d < 7; d++) if (!ok(c.body.hours[d] || [])) throw new HttpError(400, 'שעות לא תקינות'); c.biz.hours = c.body.hours; }
  if (c.body.exceptions) { for (const [k, v] of Object.entries(c.body.exceptions)) if (!/^\d{4}-\d\d-\d\d$/.test(k) || (v !== null && !ok(v))) throw new HttpError(400, 'חריג לא תקין'); c.biz.exceptions = c.body.exceptions; }
  eng.save(); return { ok: true };
});
own('POST', '/api/owner/services', (c) => eng.addService(c.biz, c.body));
own('PUT', '/api/owner/services/:id', (c) => { const s = eng.service(c.biz, c.p.id), x = c.body; for (const k of ['name', 'publicLabel', 'description']) if (x[k] != null) s[k] = String(x[k]).slice(0, 200); for (const k of ['duration', 'buffer', 'price']) if (x[k] != null) s[k] = Math.max(0, +x[k]); for (const k of ['active', 'walkin']) if (x[k] != null) s[k] = !!x[k]; eng.save(); return s; });
own('POST', '/api/owner/providers', (c) => { const p = { id: 'p_' + Math.random().toString(16).slice(2, 10), name: String(c.body.name || 'עובד/ת').slice(0, 40), active: true, serviceIds: [] }; c.biz.providers.push(p); eng.save(); return p; });
own('PUT', '/api/owner/providers/:id', (c) => { const p = eng.provider(c.biz, c.p.id); if (c.body.name) p.name = String(c.body.name).slice(0, 40); if (c.body.active != null) p.active = !!c.body.active; if (Array.isArray(c.body.serviceIds)) p.serviceIds = c.body.serviceIds; eng.save(); return p; });

own('GET', '/api/owner/today', (c) => eng.floor(c.biz, provQ(c.biz, c)));
own('GET', '/api/owner/week', (c) => {
  const start = c.q.start || T.dateKey(eng.now(), c.biz.tz), p = provQ(c.biz, c), days = [];
  for (let i = 0; i < 7; i++) {
    const k = T.addDays(start, i);
    days.push({ date: k, windows: eng.windows(c.biz, k), appts: eng.dayAppts(c.biz, p, k).filter((a) => !['cancelled'].includes(a.status)).map((a) => ({ ...a, customerName: eng.cust(a.customerId).name, serviceName: (c.biz.services.find((s) => s.id === a.serviceId) || {}).name })), blocks: eng.d.blocks.filter((b) => b.bizId === c.biz.id && b.providerId === p && T.dateKey(b.start, c.biz.tz) === k) });
  }
  return days;
});
const act = (name, fn) => own('POST', `/api/owner/appts/:id/${name}`, (c) => { const r = fn(c); return r && r.id ? { ok: true, status: r.status } : r || { ok: true }; });
act('arrive', (c) => eng.arrive(c.biz, c.p.id)); act('unarrive', (c) => eng.unarrive(c.biz, c.p.id));
act('start', (c) => eng.start(c.biz, c.p.id)); act('end', (c) => eng.end(c.biz, c.p.id));
act('extend', (c) => { const r = eng.extend(c.biz, c.p.id, c.body.minutes, !!c.body.override); return { ok: true, notified: r.messages.length, pendingApproval: r.messages.filter((m) => m.status === 'needs_approval').length }; });
act('noshow', (c) => eng.noShow(c.biz, c.p.id)); act('cancel', (c) => eng.cancel(c.biz, c.p.id));
act('approve', (c) => eng.approve(c.biz, c.p.id)); act('reject', (c) => eng.reject(c.biz, c.p.id));
act('move', (c) => eng.moveAppt(c.biz, c.p.id, +c.body.start, 'owner', c.body.providerId));
own('POST', '/api/owner/appts', (c) => { const x = c.body; const a = eng.book(c.biz, { serviceId: x.serviceId, providerId: x.providerId || pid(c.biz), start: +x.start, name: x.name, phone: x.phone, source: 'manual', notes: x.notes }); return { id: a.id }; });
own('PUT', '/api/owner/appts/:id', (c) => { const a = eng.appt(c.p.id, c.biz.id); if (c.body.notes != null) a.notes = String(c.body.notes).slice(0, 500); eng.save(); return { ok: true }; });
own('POST', '/api/owner/appts/:id/whatsapp', (c) => ({ ok: true }));
own('POST', '/api/owner/walkin/check', (c) => { const r = eng.walkinCheck(c.biz, pid(c.biz, c.body.providerId), c.body.serviceId); return { when: r.when, minutes: r.minutes, start: r.start }; });
own('POST', '/api/owner/walkin', (c) => { const a = eng.walkin(c.biz, { providerId: pid(c.biz, c.body.providerId), serviceId: c.body.serviceId, name: c.body.name, phone: c.body.phone }); return { id: a.id }; });
own('POST', '/api/owner/break', (c) => eng.addBreak(c.biz, pid(c.biz, c.body.providerId), Math.min(120, +c.body.minutes || 15)));
own('POST', '/api/owner/blocks', (c) => eng.addBlock(c.biz, { providerId: pid(c.biz, c.body.providerId), start: +c.body.start, end: +c.body.end, label: c.body.label }));
own('DELETE', '/api/owner/blocks/:id', (c) => { eng.d.blocks = eng.d.blocks.filter((b) => !(b.id === c.p.id && b.bizId === c.biz.id)); eng.save(); return { ok: true }; });

own('GET', '/api/owner/customers', (c) => eng.d.customers.filter((x) => x.bizId === c.biz.id && !x.anonymous).map(({ token, ...r }) => r).sort((a, b) => a.name.localeCompare(b.name, 'he')));
own('GET', '/api/owner/customers/:id', (c) => eng.customerCard(c.biz, c.p.id));
own('PUT', '/api/owner/customers/:id', (c) => {
  const cu = eng.customerCard(c.biz, c.p.id).customer, x = c.body;
  if (x.name) cu.name = String(x.name).slice(0, 60); if (x.notes != null) cu.notes = String(x.notes).slice(0, 1000);
  if (Array.isArray(x.tags)) cu.tags = x.tags.map((t) => String(t).slice(0, 20)).slice(0, 10);
  if (x.flexMinutes != null) cu.flexMinutes = [0, 15].includes(+x.flexMinutes) ? +x.flexMinutes : 0;
  if (x.marketingConsent != null) eng.setConsent(cu, !!x.marketingConsent);
  if (x.durations) for (const [k, v] of Object.entries(x.durations)) { if (v) cu.durations[k] = +v; else delete cu.durations[k]; }
  eng.save(); return { ok: true };
});
own('GET', '/api/owner/waitlist', (c) => eng.d.waitlist.filter((w) => w.bizId === c.biz.id && ['waiting', 'offered'].includes(w.status)).map((w) => ({ ...w, customerName: eng.cust(w.customerId).name, phone: eng.cust(w.customerId).phone, serviceName: (c.biz.services.find((s) => s.id === w.serviceId) || {}).name })));
own('POST', '/api/owner/waitlist', (c) => eng.addWaitlist(c.biz, c.body));
own('DELETE', '/api/owner/waitlist/:id', (c) => { const w = eng.d.waitlist.find((x) => x.id === c.p.id && x.bizId === c.biz.id); if (w) w.status = 'removed'; eng.save(); return { ok: true }; });
own('GET', '/api/owner/suggestions', (c) => eng.suggestions(c.biz, provQ(c.biz, c)));
own('POST', '/api/owner/suggestions/approve', (c) => { eng.approveSuggestion(c.biz, provQ(c.biz, c), c.body.id); return { ok: true }; });
own('POST', '/api/owner/suggestions/dismiss', (c) => { eng.dismissSuggestion(c.body.id); return { ok: true }; });
own('GET', '/api/owner/messages', (c) => eng.d.messages.filter((m) => m.bizId === c.biz.id).sort((a, b) => b.at - a.at).slice(0, 100).map((m) => ({ ...m, customerName: (eng.cust(m.customerId) || {}).name })));
own('POST', '/api/owner/messages/:id/approve', (c) => eng.approveMessage(c.biz, c.p.id, c.body.text));
own('POST', '/api/owner/campaigns/preview', (c) => eng.campaignPreview(c.biz, c.body.segment, c.body.text));
own('POST', '/api/owner/campaigns/send', (c) => eng.sendCampaign(c.biz, c.body.segment, c.body.text));
own('GET', '/api/owner/metrics', (c) => eng.metrics(c.biz));

// ---------------- http plumbing ----------------
function readBody(req) {
  return new Promise((res, rej) => {
    let s = ''; req.on('data', (d) => { s += d; if (s.length > 2e6) { rej(new HttpError(413, 'גדול מדי')); req.destroy(); } });
    req.on('end', () => { try { res(s ? JSON.parse(s) : {}); } catch { rej(new HttpError(400, 'JSON לא תקין')); } });
  });
}
function serveFile(res, file) {
  fs.readFile(file, (e, buf) => {
    if (e) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' }); res.end(buf);
  });
}
const PAGES = [[/^\/b\/[^/]+$/, 'booking.html'], [/^\/t\/[^/]+$/, 'my.html'], [/^\/live\/[^/]+$/, 'live.html'], [/^\/w\/[^/]+$/, 'wait.html'], [/^\/o\/[^/]+$/, 'optout.html'], [/^\/admin\/?$/, 'admin.html']];

async function handler(req, res) {
  const url = new URL(req.url, 'http://x'), p = url.pathname;
  if (p.startsWith('/api/')) {
    const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
    try {
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = p.match(r.re); if (!m) continue;
        const ctx = { p: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])), q: Object.fromEntries(url.searchParams), ip: req.socket.remoteAddress || '', body: {} };
        if (r.auth) {
          const key = (req.headers.authorization || '').replace(/^Bearer /, '');
          ctx.biz = eng.bizByKey(key);
          if (!ctx.biz) return send(401, { error: 'לא מורשה' });
        }
        if (req.method !== 'GET' && req.method !== 'DELETE') ctx.body = await readBody(req);
        return send(200, await r.fn(ctx));
      }
      return send(404, { error: 'לא נמצא' });
    } catch (e) {
      if (e instanceof HttpError) return send(e.status, { error: e.message });
      console.error(e); return send(500, { error: 'שגיאת שרת' });
    }
  }
  const page = PAGES.find(([re]) => re.test(p));
  if (page) return serveFile(res, path.join(PUB, page[1]));
  if (p === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
  if (p === '/favicon.ico') { res.writeHead(204); return res.end(); }
  if (p === '/') { res.writeHead(302, { Location: '/admin' }); return res.end(); }
  const f = path.join(PUB, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
  if (!f.startsWith(PUB)) { res.writeHead(403); return res.end(); }
  serveFile(res, f);
}

// First deploy: create the business from env vars if the database is empty.
function bootstrap() {
  const { BOOTSTRAP_SLUG: slug, BOOTSTRAP_NAME: name, OWNER_KEY: key } = process.env;
  if (!slug || !key || db.d.businesses.length) return;
  if (key.length < 12) { console.error('OWNER_KEY חייב להיות באורך 12 תווים לפחות'); return; }
  const b = eng.createBusiness({ slug, name: name || slug, ownerKey: key });
  if (process.env.BOOTSTRAP_DEMO === '1') {
    eng.addService(b, { name: 'מילוי ג׳ל', duration: 75, buffer: 10, price: 180 });
    eng.addService(b, { name: 'לק ג׳ל', duration: 45, buffer: 10, price: 120, walkin: true });
  }
  db.flush(); console.log(`נוצר עסק: /b/${slug}`);
}

if (require.main === module) {
  bootstrap();
  http.createServer(handler).listen(PORT, () => console.log(`זרימה listening on ${BASE}`));
  setInterval(() => { try { eng.tick(); } catch (e) { console.error('tick', e); } }, 30000);
  process.on('SIGTERM', () => { db.flush(); process.exit(0); });
  process.on('SIGINT', () => { db.flush(); process.exit(0); });
}
module.exports = { handler, eng };
