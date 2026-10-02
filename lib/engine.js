'use strict';
const nodeCrypto = require('node:crypto');
const T = require('./time');
const { compose } = require('./messages');
const wa = require('./wa');
const { buildIcs } = require('./ics');

const M = 60000;
const ACTIVE = ['pending', 'confirmed', 'arrived', 'in_service'];
const CHAIN = ['confirmed', 'arrived', 'in_service'];
const hex = (n) => Array.from(globalThis.crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(16).padStart(2, '0')).join('');
const rid = (p) => p + hex(5);
const tok = () => hex(12);
const ceil5 = (ms) => Math.ceil(ms / (5 * M)) * 5 * M;
const round5 = (ms) => Math.round(ms / (5 * M)) * 5 * M;

class HttpError extends Error {
  constructor(status, msg) { super(msg); this.status = status; }
}
const bad = (msg, status = 400) => { throw new HttpError(status, msg); };

// Owner keys are long random secrets, so a salted SHA-256 is enough (and runs on Node and Cloudflare Workers alike).
const asciiKey = (k) => /^[\x21-\x7e]{12,}$/.test(String(k || ''));
function hashKey(key, salt) { return nodeCrypto.createHash('sha256').update(salt + ':' + key).digest('hex'); }
function sameHex(a, b) { let d = a.length ^ b.length; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ (b.charCodeAt(i) || 0); return d === 0; }

const DEFAULT_POLICY = {
  leadMin: 60, windowDays: 21, cancelHours: 12, alertMin: 8, gapThreshold: 25, slotStep: 15,
  reminders: [24, 2], marketingMaxDays: 7, softDelayMax: 7, extCap: 20, autoConfirm: true, prepareMin: 15,
};

class Engine {
  constructor(db, { now = () => Date.now(), baseUrl = 'http://localhost:3000', transport = wa } = {}) {
    this.db = db; this.now = now; this.baseUrl = baseUrl; this.transport = transport;
  }
  get d() { return this.db.d; }
  save() { this.db.save(); }

  // ---------- businesses ----------
  createBusiness({ slug, name, ownerKey, tz = T.TZ }) {
    if (!/^[a-z0-9-]{2,40}$/.test(slug)) bad('slug לא תקין');
    if (!asciiKey(ownerKey)) bad('מפתח הבעלים חייב להיות באורך 12 תווים לפחות, באותיות אנגליות, מספרים וסימנים בלבד');
    if (this.d.businesses.some((b) => b.slug === slug)) bad('slug תפוס', 409);
    const salt = hex(8);
    const day = [{ open: '09:00', close: '18:00' }];
    const biz = {
      id: rid('b_'), slug, name, tagline: '', tz, salt, ownerKeyHash: hashKey(ownerKey, salt),
      brand: { primary: '#7c3aed', secondary: '#f5d0fe', bg: '#fffaf5', font: 'Heebo', logo: '', cover: '', tone: 'neutral' },
      contact: { address: '', whatsapp: '', instagram: '', phone: '', showPhonePublic: true },
      hours: { 0: day, 1: day, 2: day, 3: day, 4: day, 5: [{ open: '09:00', close: '13:00' }], 6: [] },
      exceptions: {}, providers: [{ id: rid('p_'), name: 'ראשי', active: true, serviceIds: [] }],
      services: [], policy: { ...DEFAULT_POLICY }, messaging: { auto: false, wa: { token: '', phoneId: '' } }, openGaps: [], stats: { gapsOffered: 0, gapsApproved: 0, gapsClaimed: 0 },
      createdAt: this.now(),
    };
    this.d.businesses.push(biz); this.save();
    return biz;
  }
  // Replace the owner's key (forgotten key, or handing a business over to its owner).
  setOwnerKey(biz, key) {
    if (!asciiKey(key)) bad('המפתח חייב להיות באורך 12 תווים לפחות, באותיות אנגליות, מספרים וסימנים בלבד');
    biz.salt = hex(8); biz.ownerKeyHash = hashKey(key, biz.salt); this.save();
  }
  bizBySlug(slug) { const b = this.d.businesses.find((x) => x.slug === slug); if (!b) bad('העסק לא נמצא', 404); return b; }
  bizByKey(key) {
    if (!key) return null;
    return this.d.businesses.find((b) => sameHex(hashKey(key, b.salt), b.ownerKeyHash)) || null;
  }
  addService(biz, s) {
    const svc = { id: rid('s_'), name: s.name, publicLabel: s.publicLabel || s.name, description: s.description || '', duration: +s.duration || 30, buffer: s.buffer != null ? +s.buffer : 10, price: +s.price || 0, active: s.active !== false, walkin: !!s.walkin };
    if (!svc.name) bad('שם שירות חסר');
    biz.services.push(svc); this.save(); return svc;
  }
  service(biz, id) { const s = biz.services.find((x) => x.id === id); if (!s) bad('שירות לא נמצא', 404); return s; }
  provider(biz, id) { const p = biz.providers.find((x) => x.id === id); if (!p) bad('נותן שירות לא נמצא', 404); return p; }

  // ---------- customers ----------
  normPhone(p) {
    let s = String(p || '').replace(/\D/g, '');
    if (s.startsWith('00')) s = s.slice(2);
    if (s.startsWith('0')) s = '972' + s.slice(1);
    if (s.length < 10 || s.length > 13) bad('מספר טלפון לא תקין');
    return s;
  }
  customerByPhone(biz, phone) { return this.d.customers.find((c) => c.bizId === biz.id && c.phone === phone) || null; }
  upsertCustomer(biz, { name, phone, marketingConsent }) {
    const ph = this.normPhone(phone);
    let c = this.customerByPhone(biz, ph);
    if (!c) {
      c = { id: rid('c_'), bizId: biz.id, name: String(name || '').trim().slice(0, 60) || 'אורח/ת', phone: ph, notes: '', tags: [], marketingConsent: false, consentAt: null, flexMinutes: 0, durations: {}, declines: {}, lastMarketingAt: 0, token: tok(), createdAt: this.now() };
      this.d.customers.push(c);
    } else if (name && (c.name === 'אורח/ת')) c.name = String(name).trim().slice(0, 60);
    if (marketingConsent != null) this.setConsent(c, !!marketingConsent);
    this.save();
    return c;
  }
  setConsent(c, v) { if (c.marketingConsent !== v) { c.marketingConsent = v; c.consentAt = this.now(); c.optedOut = !v; } }
  cust(id) { return this.d.customers.find((c) => c.id === id); }
  durationFor(svc, cust) { return (cust && cust.durations && cust.durations[svc.id]) || svc.duration; }

  // ---------- appointments ----------
  appt(id, bizId) { const a = this.d.appointments.find((x) => x.id === id && (!bizId || x.bizId === bizId)); if (!a) bad('תור לא נמצא', 404); return a; }
  apptByToken(token) { const a = this.d.appointments.find((x) => x.token === token); if (!a) bad('תור לא נמצא', 404); return a; }
  dayAppts(biz, providerId, key) {
    return this.d.appointments.filter((a) => a.bizId === biz.id && (!providerId || a.providerId === providerId) && T.dateKey(a.start, biz.tz) === key).sort((a, b) => a.start - b.start);
  }
  windows(biz, key) {
    const list = key in biz.exceptions ? biz.exceptions[key] : biz.hours[T.weekday(key, biz.tz)];
    return (list || []).map((w) => ({ start: T.atTime(key, w.open, biz.tz), end: T.atTime(key, w.close, biz.tz) }));
  }
  busy(biz, providerId, key, excludeId) {
    const out = [];
    const proj = this.project(biz, providerId);
    for (const a of this.dayAppts(biz, providerId, key)) {
      if (!ACTIVE.includes(a.status) || a.id === excludeId) continue;
      let end = a.start + a.duration * M;
      const p = proj.get(a.id);
      if (p && a.status === 'in_service') end = Math.max(end, p.estEnd);
      out.push([a.start, end + a.buffer * M]);
    }
    for (const b of this.d.blocks) if (b.bizId === biz.id && b.providerId === providerId && T.dateKey(b.start, biz.tz) === key) out.push([b.start, b.end]);
    return out;
  }
  slots(biz, { serviceId, providerId, dateKey, phone, excludeId, ignoreLead }) {
    const svc = this.service(biz, serviceId);
    const cust = phone ? this.customerByPhone(biz, this.normPhone(phone)) : null;
    const dur = this.durationFor(svc, cust);
    const now = this.now(), pol = biz.policy, today = T.dateKey(now, biz.tz);
    if (dateKey < today || dateKey > T.addDays(today, pol.windowDays)) return [];
    const provs = providerId && providerId !== 'any' ? [this.provider(biz, providerId)] : biz.providers.filter((p) => p.active);
    const out = new Map();
    for (const p of provs) {
      if (!p.active || (p.serviceIds.length && !p.serviceIds.includes(svc.id))) continue;
      const busy = this.busy(biz, p.id, dateKey, excludeId);
      for (const w of this.windows(biz, dateKey)) {
        for (let t = w.start; t + dur * M <= w.end; t += pol.slotStep * M) {
          const quick = biz.openGaps.some((g) => g.providerId === p.id && t >= g.start && t + dur * M <= g.end);
          if (!ignoreLead && !quick && t < now + pol.leadMin * M) continue;
          if (t < now) continue;
          const e = t + (dur + svc.buffer) * M;
          if (busy.some(([s, en]) => t < en && e > s)) continue;
          if (!out.has(t)) out.set(t, p.id);
        }
      }
    }
    return [...out].sort((a, b) => a[0] - b[0]).map(([start, pid]) => ({ start, providerId: pid, time: T.fmtTime(start, biz.tz) }));
  }
  // Exact-time placement check (used for owner-approved offers, which may sit off the booking grid).
  canPlace(biz, { providerId, start, minutes, buffer, excludeId }) {
    const key = T.dateKey(start, biz.tz);
    if (start < this.now()) return false;
    if (!this.windows(biz, key).some((w) => start >= w.start && start + minutes * M <= w.end)) return false;
    return !this.busy(biz, providerId, key, excludeId).some(([s, e]) => start < e && start + (minutes + buffer) * M > s);
  }
  availableDays(biz, q) {
    const today = T.dateKey(this.now(), biz.tz), out = [];
    for (let i = 0; i <= biz.policy.windowDays; i++) {
      const k = T.addDays(today, i);
      const n = this.slots(biz, { ...q, dateKey: k }).length;
      if (n) out.push({ date: k, count: n });
    }
    return out;
  }
  book(biz, { serviceId, providerId, start, name, phone, marketingConsent, source = 'online', notes = '', status, flex, ignoreLead }) {
    const svc = this.service(biz, serviceId);
    if (!svc.active && source === 'online') bad('השירות לא זמין');
    const cust = this.upsertCustomer(biz, { name, phone, marketingConsent });
    const key = T.dateKey(start, biz.tz);
    const slot = this.slots(biz, { serviceId, providerId, dateKey: key, phone, ignoreLead: source !== 'online' || ignoreLead }).find((s) => s.start === start);
    if (!slot) bad('השעה שנבחרה כבר לא פנויה', 409);
    return this.createAppt(biz, { cust, svc, providerId: slot.providerId, start, source, notes, status: status || (source === 'online' && !biz.policy.autoConfirm ? 'pending' : 'confirmed'), flex });
  }
  createAppt(biz, { cust, svc, providerId, start, source, notes = '', status = 'confirmed', flex, arrived }) {
    const a = {
      id: rid('a_'), bizId: biz.id, providerId, customerId: cust.id, serviceId: svc.id, start, duration: this.durationFor(svc, cust), buffer: svc.buffer, price: svc.price,
      status, source, notes, token: tok(), createdAt: this.now(), extra: 0, extensions: [], notifiedEst: ceil5(start), allowEarly: !!(flex || cust.flexMinutes), sent: {}, signal: null,
    };
    if (arrived) { a.status = 'arrived'; a.arrivedAt = this.now(); }
    // Reminders that are already in the past at creation time are skipped.
    const untilStart = start - this.now();
    if (untilStart < 24 * M * 60) a.sent.r24 = true;
    if (untilStart < 2 * M * 60) a.sent.r2 = true;
    this.d.appointments.push(a); this.save();
    if (a.status === 'pending') {
      if (this.autoActive(biz)) this.notify(biz, a, 'pending'); // on screen the customer already sees "request received"
    } else this.notify(biz, a, 'created');
    if (['online', 'waitlist'].includes(source)) this.alertOwner(biz, a, a.status === 'pending' ? 'pending' : 'new');
    return a;
  }

  // ---------- new booking requests (owner approval flow) ----------
  autoActive(biz) { const c = this.msgCfg(biz); return !!(c.auto && c.wa.token && c.wa.phoneId); }
  waNumber(raw) { let d = String(raw || '').replace(/\D/g, ''); if (d.startsWith('00')) d = d.slice(2); if (d.startsWith('0')) d = '972' + d.slice(1); return d.length >= 10 ? d : ''; }
  requestLink(a) { return this.manageLink(a); }
  manageLink(a) { return `${this.baseUrl}/admin?appt=${a.id}`; }
  // Which channel reaches the owner by itself? "cloud" = WhatsApp API of the business, "callmebot" = free third-party gateway.
  // With neither, the new booking still shows up in the admin app ("new bookings" card with a badge).
  ownerChannel(biz) {
    const to = this.waNumber(biz.contact.whatsapp || biz.contact.phone), cfg = this.msgCfg(biz);
    if (this.autoActive(biz) && to) return { type: 'cloud', to };
    const cm = cfg.ownerAlert.callmebot;
    if (cm.phone && cm.apiKey) return { type: 'callmebot', to: cm.phone, key: cm.apiKey };
    return null;
  }
  sendToOwner(biz, text, { apptId = null, customerId = null } = {}) {
    const ch = this.ownerChannel(biz);
    if (!ch) return null;
    if (ch.type === 'cloud') {
      const m = this.queue(biz, { customerId, apptId, pipeline: 'ops', type: 'owner_alert', text, to: ch.to });
      m.toOwner = true; m.ownerPhone = ch.to; this.save();
      return m;
    }
    const m = { id: rid('m_'), bizId: biz.id, customerId, apptId, pipeline: 'ops', type: 'owner_alert', text, channel: 'callmebot', status: 'sending', at: this.now(), toOwner: true, ownerPhone: ch.to };
    this.d.messages.push(m); this.save();
    const done = (ok) => { m.status = ok ? 'sent' : 'failed'; if (ok) m.sentAt = this.now(); this.save(); };
    Promise.resolve((this.transport.callMeBot || (async () => ({ ok: false })))(ch.to, text, ch.key)).then((r) => done(!!r.ok)).catch(() => done(false));
    return m;
  }
  alertOwner(biz, a, kind = 'new') {
    const cust = this.cust(a.customerId) || {}, svc = biz.services.find((s) => s.id === a.serviceId) || {};
    const when = `${T.dayLabel(a.start, this.now(), biz.tz)} בשעה ${T.fmtTime(a.start, biz.tz)}`;
    const head = { new: 'תור חדש', pending: 'בקשת תור חדשה', cancelled: 'התור בוטל על ידי הלקוח', moved: 'הלקוח הזיז תור' }[kind] || 'עדכון תור';
    const tail = kind === 'pending' ? `לאישור בלחיצה: ${this.manageLink(a)}` : kind === 'cancelled' ? '' : `לניהול (הזזה / ביטול): ${this.manageLink(a)}`;
    return this.sendToOwner(biz, `*${biz.name}*\n${head}: ${cust.name}, ${svc.name}, ${when}.${tail ? '\n' + tail : ''}`, { apptId: a.id, customerId: cust.id });
  }
  // "New bookings" card in the admin app: online / waitlist bookings the owner has not looked at yet.
  newBookings(biz) {
    const since = this.now() - 72 * 60 * M;
    return this.d.appointments.filter((a) => a.bizId === biz.id && ['online', 'waitlist'].includes(a.source) && a.status === 'confirmed' && !a.ownerSeen && a.createdAt >= since && a.start >= this.now() - 24 * 60 * M)
      .sort((x, y) => x.createdAt - y.createdAt).map((a) => this.listRow(biz, a));
  }
  listRow(biz, a) { const c = this.cust(a.customerId) || {}, s = biz.services.find((v) => v.id === a.serviceId) || {}; return { id: a.id, customerName: c.name, phone: c.phone, serviceName: s.name, start: a.start, when: `${T.dayLabel(a.start, this.now(), biz.tz)} בשעה ${T.fmtTime(a.start, biz.tz)}`, createdAt: a.createdAt }; }
  // ---------- calendar feed (subscribe once, the phone keeps itself in sync) ----------
  calToken(biz) { if (!biz.calToken) { biz.calToken = hex(16); this.save(); } return biz.calToken; }
  rotateCalToken(biz) { biz.calToken = hex(16); this.save(); return biz.calToken; }
  bizByCalToken(t) { return this.d.businesses.find((b) => b.calToken && sameHex(b.calToken, String(t || ''))) || null; }
  calendarFeed(biz) {
    const now = this.now(), from = now - 30 * 24 * 60 * M, events = [];
    for (const a of this.d.appointments) {
      if (a.bizId !== biz.id || a.start < from) continue;
      const gone = ['cancelled', 'no_show'].includes(a.status);
      if (gone && a.start < now - 7 * 24 * 60 * M) continue;
      const c = this.cust(a.customerId) || {}, s = biz.services.find((v) => v.id === a.serviceId) || {};
      const end = (a.actualEnd && a.status === 'done') ? a.actualEnd : a.start + (a.duration + (a.extra || 0)) * M;
      events.push({
        uid: `${a.id}@zrima`, start: a.start, end,
        summary: `${a.status === 'pending' ? '⏳ ' : ''}${c.name || ''} · ${s.name || ''}`,
        description: [c.phone ? `טלפון: ${c.phone.replace(/^972/, '0')}` : '', a.price ? `מחיר: ₪${a.price}` : '', a.notes || '', `לניהול: ${this.manageLink(a)}`].filter(Boolean).join('\n'),
        location: biz.contact.address || '', url: this.manageLink(a), status: gone ? 'CANCELLED' : a.status === 'pending' ? 'TENTATIVE' : 'CONFIRMED',
      });
    }
    return buildIcs({ name: biz.name, tz: biz.tz, events, now });
  }
  pendingRequests(biz) {
    return this.d.appointments.filter((a) => a.bizId === biz.id && a.status === 'pending').sort((x, y) => x.createdAt - y.createdAt)
      .map((a) => { const c = this.cust(a.customerId) || {}, s = biz.services.find((v) => v.id === a.serviceId) || {}; return { id: a.id, customerName: c.name, phone: c.phone, serviceName: s.name, start: a.start, when: `${T.dayLabel(a.start, this.now(), biz.tz)} בשעה ${T.fmtTime(a.start, biz.tz)}`, createdAt: a.createdAt }; });
  }
  apptDetails(biz, id) {
    const a = this.appt(id, biz.id), c = this.cust(a.customerId) || {}, s = biz.services.find((v) => v.id === a.serviceId) || {};
    return { id: a.id, status: a.status, customerName: c.name, phone: c.phone, serviceName: s.name, duration: a.duration, price: a.price, start: a.start, notes: a.notes, when: `${T.dayLabel(a.start, this.now(), biz.tz)} בשעה ${T.fmtTime(a.start, biz.tz)}`, source: a.source };
  }
  // wa.me link with the ready message for the customer (approval / rejection), for the owner's one tap
  lastWaUrl(biz, apptId, type) {
    const m = [...this.d.messages].reverse().find((x) => x.bizId === biz.id && x.apptId === apptId && x.type === type && x.status === 'queued' && !x.toOwner);
    const c = m && this.cust(m.customerId);
    return m && c && c.phone ? { id: m.id, url: `https://wa.me/${c.phone}?text=${encodeURIComponent(m.text)}` } : null;
  }

  // ---------- messaging ----------
  link(a) { return `${this.baseUrl}/t/${a.token}`; }
  notify(biz, a, type, extra = {}) {
    const cust = this.cust(a.customerId), svc = biz.services.find((s) => s.id === a.serviceId);
    const text = compose(type, { biz, cust, appt: a, svc, link: this.link(a), bookLink: `${this.baseUrl}/b/${biz.slug}`, now: this.now(), ...extra });
    return this.queue(biz, { customerId: cust.id, apptId: a.id, pipeline: 'ops', type, text, needsApproval: extra.needsApproval, to: cust.phone });
  }
  queue(biz, { customerId, apptId, pipeline, type, text, needsApproval, to }) {
    const m = { id: rid('m_'), bizId: biz.id, customerId, apptId: apptId || null, pipeline, type, text, channel: 'whatsapp', status: needsApproval ? 'needs_approval' : 'queued', at: this.now() };
    this.d.messages.push(m); this.save();
    if (!needsApproval) this.deliver(m, to);
    return m;
  }
  deliver(m, to) {
    const phone = to || (this.cust(m.customerId) || {}).phone;
    if (!phone) { m.status = 'skipped'; return; }
    const biz = this.d.businesses.find((b) => b.id === m.bizId), cfg = biz && this.msgCfg(biz);
    if (!cfg || !cfg.auto || !cfg.wa.token || !cfg.wa.phoneId) return; // manual: the message waits in the owner's outbox
    m.status = 'sending';
    const fail = () => { m.status = 'queued'; m.autoFailed = true; this.save(); }; // never lost: falls back to the outbox
    Promise.resolve(this.transport.send(phone, m.text, cfg.wa)).then((r) => {
      if (!r.ok) return fail();
      m.status = 'sent'; m.sentAt = this.now(); this.save();
    }).catch(fail);
  }
  // Per-business choice: "manual" (free: the owner taps send) or "auto" (WhatsApp Cloud API credentials of the business).
  msgCfg(biz) {
    if (!biz.messaging) biz.messaging = { auto: false, wa: { token: '', phoneId: '' } };
    if (!biz.messaging.ownerAlert) biz.messaging.ownerAlert = { callmebot: { phone: '', apiKey: '' } };
    return biz.messaging;
  }
  // Free mode: messages waiting for the owner to send them with one tap through WhatsApp.
  outbox(biz) {
    return this.d.messages.filter((m) => m.bizId === biz.id && m.status === 'queued').sort((a, b) => a.at - b.at)
      .map((m) => { const c = this.cust(m.customerId) || {}; const phone = m.toOwner ? m.ownerPhone : c.phone; return { id: m.id, type: m.type, pipeline: m.pipeline, at: m.at, customerName: m.toOwner ? 'התראה אליך' : c.name, phone, text: m.text, url: phone ? `https://wa.me/${phone}?text=${encodeURIComponent(m.text)}` : null }; });
  }
  markSent(biz, id) {
    const m = this.d.messages.find((x) => x.id === id && x.bizId === biz.id);
    if (!m) bad('הודעה לא נמצאה', 404);
    if (m.status === 'queued') { m.status = 'sent'; m.sentAt = this.now(); m.manual = true; this.save(); }
    return m;
  }
  approveMessage(biz, id, text) {
    const m = this.d.messages.find((x) => x.id === id && x.bizId === biz.id);
    if (!m || m.status !== 'needs_approval') bad('אין הודעה לאישור', 404);
    if (text) m.text = String(text).slice(0, 1000);
    m.status = 'queued'; this.deliver(m); this.save(); return m;
  }

  // ---------- projection of the live day ----------
  project(biz, providerId, now = this.now()) {
    const key = T.dateKey(now, biz.tz);
    const list = this.dayAppts(biz, providerId, key).filter((a) => CHAIN.includes(a.status));
    const blocks = this.d.blocks.filter((b) => b.bizId === biz.id && b.providerId === providerId).sort((a, b) => a.start - b.start);
    const out = new Map();
    let cursor = 0;
    for (const a of list) {
      let s, e;
      if (a.status === 'in_service') { s = a.actualStart; e = Math.max(s + (a.duration + a.extra) * M, now); }
      else {
        s = Math.max(a.start, cursor);
        if (a.status === 'arrived') s = Math.max(s, now);
        for (const b of blocks) if (s >= b.start && s < b.end) s = b.end;
        e = s + a.duration * M;
      }
      out.set(a.id, { estStart: s, estEnd: e });
      cursor = e + a.buffer * M;
    }
    return out;
  }
  // Recompute every waiting customer's projected entry time and message anyone whose time moved.
  reproject(biz, providerId, { force = false } = {}) {
    const proj = this.project(biz, providerId), now = this.now(), out = [];
    for (const [id, p] of proj) {
      const a = this.appt(id);
      if (!['confirmed', 'arrived'].includes(a.status)) continue;
      const est = ceil5(p.estStart), delta = est - a.notifiedEst;
      if (Math.abs(delta) < 5 * M) continue;
      if (!force && a.lastDelayMsgAt && now - a.lastDelayMsgAt < 10 * M) continue;
      const delay = Math.round((est - ceil5(a.start)) / M);
      let type, needsApproval = false;
      if (delta > 0) {
        if (delay <= biz.policy.softDelayMax) type = 'delay_soft';
        else if (delay <= 15) { type = 'delay_clear'; a.freeChange = true; }
        else { type = 'delay_big'; a.freeChange = true; needsApproval = true; }
      } else if (a.notifiedEst > ceil5(a.start)) type = 'delay_update';
      else { a.notifiedEst = est; continue; }
      a.notifiedEst = est; a.lastDelayMsgAt = now;
      out.push(this.notify(biz, a, type, { est, delay, needsApproval }));
    }
    if (out.length) this.save();
    return out;
  }

  // ---------- floor actions ----------
  floorAppt(biz, id) { return this.appt(id, biz.id); }
  arrive(biz, id) {
    const a = this.floorAppt(biz, id);
    if (!['confirmed', 'pending'].includes(a.status)) bad('לא ניתן לסמן הגעה במצב הנוכחי');
    a.status = 'arrived'; a.arrivedAt = this.now(); this.save(); this.reproject(biz, a.providerId); return a;
  }
  unarrive(biz, id) {
    const a = this.floorAppt(biz, id);
    if (a.status !== 'arrived') bad('הלקוח לא במצב הגיע');
    a.status = 'confirmed'; this.save(); return a;
  }
  start(biz, id) {
    const a = this.floorAppt(biz, id);
    if (!['arrived', 'confirmed'].includes(a.status)) bad('לא ניתן להתחיל טיפול במצב הנוכחי');
    if (this.d.appointments.some((x) => x.providerId === a.providerId && x.status === 'in_service')) bad('יש כבר טיפול פתוח', 409);
    if (!a.arrivedAt) a.arrivedAt = this.now();
    a.status = 'in_service'; a.actualStart = this.now(); a.startedByTimer = true;
    this.save(); this.reproject(biz, a.providerId, { force: true }); return a;
  }
  extend(biz, id, minutes, override = false) {
    const a = this.floorAppt(biz, id);
    if (a.status !== 'in_service') bad('אפשר להאריך רק טיפול פעיל');
    if (![5, 10, 15].includes(+minutes)) bad('מדרגות הארכה: 5 / 10 / 15');
    if (a.extra + +minutes > biz.policy.extCap && !override) bad(`הארכה מעבר ל־${biz.policy.extCap} דקות דורשת אישור חריגה`, 409);
    a.extra += +minutes; a.extensions.push({ minutes: +minutes, at: this.now() });
    this.save();
    return { appt: a, messages: this.reproject(biz, a.providerId, { force: true }) };
  }
  end(biz, id) {
    const a = this.floorAppt(biz, id);
    if (a.status !== 'in_service') bad('אין טיפול פעיל');
    a.status = 'done'; a.actualEnd = this.now(); a.actualMinutes = Math.max(1, Math.round((a.actualEnd - a.actualStart) / M));
    this.save();
    const proj = this.project(biz, a.providerId), now = this.now();
    // Offer earlier entry only where the customer allowed it (or already arrived); otherwise the gap stays.
    for (const [nid, p] of proj) {
      const n = this.appt(nid);
      if (n.status !== 'confirmed' || !n.allowEarly || n.sent.early) continue;
      const earliest = ceil5(Math.max(now, a.actualEnd + a.buffer * M));
      if (n.start - earliest >= 10 * M) { n.sent.early = true; this.notify(biz, n, 'early', { est: earliest }); }
      break;
    }
    this.reproject(biz, a.providerId);
    return a;
  }
  noShow(biz, id) {
    const a = this.floorAppt(biz, id);
    if (!['confirmed', 'arrived'].includes(a.status)) bad('לא ניתן לסמן לא הגיע');
    a.status = 'no_show'; this.save(); this.reproject(biz, a.providerId); return a;
  }
  cancel(biz, id, by = 'owner') {
    const a = this.floorAppt(biz, id);
    if (!ACTIVE.includes(a.status)) bad('התור לא פעיל');
    a.status = 'cancelled'; a.cancelledBy = by; this.save();
    if (by === 'owner') this.notify(biz, a, 'cancelled');
    this.reproject(biz, a.providerId); this.offerFreedSlot(biz, a);
    return a;
  }
  offerFreedSlot() { /* surfaced through gap suggestions for owner approval */ }
  moveAppt(biz, id, start, by = 'owner', providerId) {
    const a = this.floorAppt(biz, id);
    if (!['pending', 'confirmed'].includes(a.status)) bad('אפשר להזיז רק תור מתוכנן');
    const svc = this.service(biz, a.serviceId), cust = this.cust(a.customerId);
    const pid = providerId || a.providerId;
    const ok = by === 'owner'
      ? this.canPlace(biz, { providerId: pid, start, minutes: a.duration, buffer: a.buffer, excludeId: a.id })
      : this.slots(biz, { serviceId: svc.id, providerId: pid, dateKey: T.dateKey(start, biz.tz), phone: cust.phone, excludeId: a.id }).some((s) => s.start === start);
    if (!ok) bad('השעה שנבחרה לא פנויה', 409);
    a.start = start; a.providerId = pid; a.notifiedEst = ceil5(start); a.sent = {}; a.freeChange = false; a.status = 'confirmed';
    const until = start - this.now();
    if (until < 24 * 60 * M) a.sent.r24 = true;
    if (until < 120 * M) a.sent.r2 = true;
    this.save(); this.notify(biz, a, 'moved'); return a;
  }
  approve(biz, id) { const a = this.floorAppt(biz, id); if (a.status !== 'pending') bad('התור לא ממתין לאישור'); a.status = 'confirmed'; this.save(); this.notify(biz, a, 'approved'); return a; }
  reject(biz, id) { const a = this.floorAppt(biz, id); if (a.status !== 'pending') bad('התור לא ממתין לאישור'); a.status = 'cancelled'; a.cancelledBy = 'owner'; this.save(); this.notify(biz, a, 'rejected'); return a; }

  // Customer self-service
  canSelfChange(biz, a) {
    if (!['pending', 'confirmed'].includes(a.status)) return false;
    return a.freeChange || a.start - this.now() >= biz.policy.cancelHours * 60 * M;
  }
  customerCancel(a) {
    const biz = this.d.businesses.find((b) => b.id === a.bizId);
    if (!this.canSelfChange(biz, a)) bad(`ביטול עצמי אפשרי עד ${biz.policy.cancelHours} שעות לפני התור. אפשר לפנות לעסק.`, 403);
    const r = this.cancel(biz, a.id, 'customer');
    this.alertOwner(biz, a, 'cancelled');
    return r;
  }
  customerReschedule(a, start) {
    const biz = this.d.businesses.find((b) => b.id === a.bizId);
    if (!this.canSelfChange(biz, a)) bad(`הזזה עצמית אפשרית עד ${biz.policy.cancelHours} שעות לפני התור. אפשר לפנות לעסק.`, 403);
    const r = this.moveAppt(biz, a.id, start, 'customer');
    this.alertOwner(biz, a, 'moved');
    return r;
  }
  customerSignal(a, signal) {
    if (!['omw', 'late', 'not_coming', 'confirmed'].includes(signal)) bad('פעולה לא מוכרת');
    if (!ACTIVE.includes(a.status)) bad('התור לא פעיל');
    if (signal === 'confirmed') a.attendanceConfirmed = this.now(); else { a.signal = signal; a.signalAt = this.now(); }
    this.save(); return a;
  }

  // Walk-in
  walkinCheck(biz, providerId, serviceId) {
    const svc = this.service(biz, serviceId), now = this.now(), key = T.dateKey(now, biz.tz);
    if (!svc.walkin) bad('השירות לא מסומן כמתאים ל־walk-in');
    const busy = this.busy(biz, providerId, key).sort((a, b) => a[0] - b[0]);
    const wins = this.windows(biz, key);
    const dur = svc.duration * M, need = dur + svc.buffer * M;
    let t = ceil5(now);
    for (let guard = 0; guard < 50; guard++) {
      if (!wins.some((w) => t >= w.start && t + dur <= w.end)) {
        const next = wins.find((w) => w.start > t && w.start + dur <= w.end);
        if (!next) return { when: 'none', svc };
        t = next.start; continue;
      }
      const conflict = busy.find(([s, e]) => t < e && t + need > s);
      if (!conflict) break;
      t = ceil5(conflict[1]);
    }
    const wait = Math.round((t - now) / M);
    const ok = wins.some((w) => t >= w.start && t + dur <= w.end) && T.dateKey(t, biz.tz) === key;
    if (!ok) return { when: 'none', svc };
    return { when: wait <= 2 ? 'now' : 'in', minutes: wait, start: t, svc };
  }
  walkin(biz, { providerId, serviceId, name, phone }) {
    const chk = this.walkinCheck(biz, providerId, serviceId);
    if (chk.when === 'none') bad('אין מקום היום', 409);
    const svc = chk.svc;
    const cust = phone ? this.upsertCustomer(biz, { name: name || 'Walk-in', phone }) : this.walkinCustomer(biz, name);
    const a = this.createAppt(biz, { cust, svc, providerId, start: chk.start, source: 'walkin', status: 'arrived', arrived: true });
    a.silent = !phone;
    return a;
  }
  walkinCustomer(biz, name) {
    const c = { id: rid('c_'), bizId: biz.id, name: (name || 'Walk-in').slice(0, 60), phone: '', notes: '', tags: [], marketingConsent: false, flexMinutes: 0, durations: {}, declines: {}, lastMarketingAt: 0, token: tok(), createdAt: this.now(), anonymous: true };
    this.d.customers.push(c); return c;
  }
  addBreak(biz, providerId, minutes = 15) {
    const now = this.now();
    const cur = this.d.appointments.find((x) => x.providerId === providerId && x.status === 'in_service');
    if (cur) bad('יש טיפול פעיל', 409);
    const b = { id: rid('k_'), bizId: biz.id, providerId, start: now, end: now + minutes * M, label: 'break' };
    this.d.blocks.push(b); this.save(); this.reproject(biz, providerId, { force: true }); return b;
  }
  addBlock(biz, { providerId, start, end, label = 'blocked' }) {
    if (!(end > start)) bad('טווח לא תקין');
    const b = { id: rid('k_'), bizId: biz.id, providerId, start, end, label };
    this.d.blocks.push(b); this.save(); return b;
  }

  // ---------- owner day view ----------
  floor(biz, providerId) {
    const now = this.now(), key = T.dateKey(now, biz.tz), proj = this.project(biz, providerId);
    const all = this.dayAppts(biz, providerId, key);
    const view = all.map((a) => {
      const c = this.cust(a.customerId), s = biz.services.find((x) => x.id === a.serviceId), p = proj.get(a.id);
      return { ...a, customerName: c.name, phone: c.phone, serviceName: s.name, estStart: p ? p.estStart : null, estEnd: p ? p.estEnd : null, flexible: !!c.flexMinutes };
    });
    const current = view.find((a) => a.status === 'in_service') || null;
    const upcoming = view.filter((a) => ['confirmed', 'arrived', 'pending'].includes(a.status));
    const next = upcoming.find((a) => a.status !== 'pending') || null;
    const block = this.d.blocks.find((b) => b.bizId === biz.id && b.providerId === providerId && b.start <= now && now < b.end) || null;
    let mode = 'between';
    if (current) mode = 'in_service';
    else if (next && next.status === 'arrived') mode = 'arrived';
    else if (next && this.isImminent(biz, next, now)) mode = 'before_arrival';
    const hints = [];
    if (current) {
      const rem = current.actualStart + (current.duration + current.extra) * M - now;
      current.remainingMs = rem;
      if (rem <= 0) hints.push({ type: 'overdue', text: 'הזמן המתוכנן הסתיים' });
      else if (rem <= biz.policy.alertMin * M) hints.push({ type: 'ending_soon', text: `נשארו כ־${Math.ceil(rem / M)} דקות` });
    }
    if (!current) {
      const w = upcoming.find((a) => a.status === 'arrived' && now - Math.max(a.start, a.arrivedAt || 0) >= 3 * M);
      if (w) hints.push({ type: 'start_nudge', text: `${w.customerName} מחכה — להתחיל טיימר?` });
    }
    for (const a of view) if (a.signal && ['confirmed', 'arrived'].includes(a.status)) hints.push({ type: 'signal_' + a.signal, apptId: a.id, text: `${a.customerName}: ${{ omw: 'בדרך', late: 'מאחר/ת', not_coming: 'לא מגיע/ה' }[a.signal]}` });
    const remaining = view.filter((a) => ['confirmed', 'arrived', 'in_service'].includes(a.status)).length;
    const behind = view.filter((a) => ['confirmed', 'arrived'].includes(a.status) && a.estStart).reduce((m, a) => Math.max(m, Math.round((ceil5(a.estStart) - ceil5(a.start)) / M)), 0);
    return { now, dateKey: key, mode, current, next, block, appts: view, remaining, behindMin: behind, hints, policy: { alertMin: biz.policy.alertMin, extCap: biz.policy.extCap } };
  }
  isImminent() { return true; }

  // ---------- public live board ----------
  liveBoard(biz, token) {
    const now = this.now(), key = T.dateKey(now, biz.tz);
    const chairs = biz.providers.filter((p) => p.active).map((p) => {
      const list = this.dayAppts(biz, p.id, key), proj = this.project(biz, p.id);
      const cur = list.find((a) => a.status === 'in_service');
      const block = this.d.blocks.find((b) => b.bizId === biz.id && b.providerId === p.id && b.start <= now && now < b.end);
      const wins = this.windows(biz, key);
      const open = wins.some((w) => now >= w.start && now < w.end);
      const waiting = list.filter((a) => ['confirmed', 'arrived'].includes(a.status));
      const nextA = waiting[0];
      let state = cur ? 'in_service' : block ? 'break' : open ? 'open' : 'closed';
      const o = { state, waiting: waiting.length };
      if (biz.providers.length > 1) o.label = p.name;
      if (cur) {
        const svc = biz.services.find((s) => s.id === cur.serviceId);
        const rem = cur.actualStart + (cur.duration + cur.extra) * M - now;
        o.serviceLabel = svc.publicLabel;
        o.remaining = rem <= 0 ? 'עוד רגע' : `כ־${Math.max(5, round5(rem) / M)} דקות`;
      }
      if (nextA && state !== 'closed') o.nextEntry = T.fmtTime(ceil5(proj.get(nextA.id).estStart), biz.tz);
      return o;
    });
    const out = { business: { name: biz.name, tagline: biz.tagline, brand: biz.brand, contact: this.publicContact(biz) }, chairs, updatedAt: now };
    if (token) {
      const a = this.d.appointments.find((x) => x.token === token && x.bizId === biz.id);
      if (a) out.mine = this.myView(biz, a);
    }
    return out;
  }
  publicContact(biz) { const c = { ...biz.contact }; if (!c.showPhonePublic) c.phone = ''; delete c.showPhonePublic; return c; }
  myView(biz, a) {
    const now = this.now(), key = T.dateKey(a.start, biz.tz), svc = biz.services.find((s) => s.id === a.serviceId);
    const proj = this.project(biz, a.providerId), p = proj.get(a.id);
    const day = this.dayAppts(biz, a.providerId, key).filter((x) => !['cancelled', 'no_show'].includes(x.status));
    const idx = day.findIndex((x) => x.id === a.id) + 1;
    const ahead = day.filter((x) => x.start < a.start && ['confirmed', 'arrived', 'in_service'].includes(x.status));
    const isToday = key === T.dateKey(now, biz.tz);
    const m = { id: a.id, status: a.status, service: svc.name, plannedStart: a.start, plannedTime: T.fmtTime(a.start, biz.tz), when: `${T.dayLabel(a.start, now, biz.tz)} בשעה ${T.fmtTime(a.start, biz.tz)}`, canSelfChange: this.canSelfChange(biz, a), cancelHours: biz.policy.cancelHours, signal: a.signal, attendanceConfirmed: !!a.attendanceConfirmed };
    if (p && isToday) {
      m.estTime = T.fmtTime(ceil5(p.estStart), biz.tz);
      m.delayed = ceil5(p.estStart) > ceil5(a.start);
      m.position = idx;
      m.positionText = ahead.length === 0 ? 'את/ה הבא/ה בתור' : ahead.length === 1 && ahead[0].status === 'in_service' ? 'הבא/ה אחרי הטיפול הנוכחי' : `את/ה ה${ORD[idx] || idx}/ת היום`;
    }
    if (a.status === 'pending') {
      const to = this.waNumber(biz.contact.whatsapp || biz.contact.phone), cust = this.cust(a.customerId) || {};
      if (to) m.ownerWa = { url: `https://wa.me/${to}?text=${encodeURIComponent(`היי, קבעתי תור ל${svc.name} ${m.when} (על שם ${cust.name}). לאישור: ${this.requestLink(a)}`)}` };
    }
    if (a.moveOffer) m.moveOffer = { time: T.fmtTime(a.moveOffer.start, biz.tz) };
    return m;
  }

  // ---------- gaps & suggestions ----------
  gaps(biz, providerId, key) {
    const now = this.now(), thr = biz.policy.gapThreshold * M, proj = this.project(biz, providerId);
    const list = this.dayAppts(biz, providerId, key).filter((a) => [...CHAIN, 'done'].includes(a.status)).sort((a, b) => (proj.get(a.id)?.estStart ?? a.actualStart ?? a.start) - (proj.get(b.id)?.estStart ?? b.actualStart ?? b.start));
    const out = [];
    for (let i = 0; i < list.length - 1; i++) {
      const a = list[i], b = list[i + 1];
      if (b.status === 'done' || b.status === 'in_service') continue;
      const endA = a.status === 'done' ? a.actualEnd : proj.get(a.id).estEnd;
      const gs = ceil5(Math.max(endA + a.buffer * M, now)), ge = proj.get(b.id).estStart;
      if (ge - gs >= thr) out.push({ providerId, start: gs, end: ge, minutes: Math.round((ge - gs) / M), nextApptId: b.id });
    }
    return out;
  }
  suggestions(biz, providerId) {
    const now = this.now(), key = T.dateKey(now, biz.tz), out = [];
    for (const g of this.gaps(biz, providerId, key)) {
      const base = `${g.providerId}:${g.start}`;
      const mk = (type, extra) => ({ id: `${type}:${base}${extra.ref ? ':' + extra.ref : ''}`, type, gap: g, ...extra });
      const gapText = `${T.fmtTime(g.start, biz.tz)}–${T.fmtTime(g.end, biz.tz)}`;
      for (const w of this.d.waitlist.filter((x) => x.bizId === biz.id && x.status === 'waiting')) {
        const c = this.cust(w.customerId), svc = biz.services.find((s) => s.id === w.serviceId);
        if (!svc || (c.declines[key] || 0) >= 2) continue;
        if (w.dateFrom && key < w.dateFrom) continue;
        if (w.dateTo && key > w.dateTo) continue;
        if (this.durationFor(svc, c) + svc.buffer > g.minutes) continue;
        out.push(mk('waitlist', { ref: w.id, title: `להציע את החור (${gapText}) ל${c.name} מרשימת ההמתנה`, detail: `${svc.name}, ${this.durationFor(svc, c)} דק'` }));
      }
      const nb = this.appt(g.nextApptId), nc = this.cust(nb.customerId);
      if (nb.status === 'confirmed' && (nc.declines[key] || 0) < 2) {
        const shift = Math.min(20, g.minutes);
        const newStart = ceil5(Math.max(g.start, nb.start - shift * M));
        if (nb.start - newStart >= 5 * M) out.push(mk('move_earlier', { ref: nb.id, priority: nc.flexMinutes ? 1 : 0, title: `להציע ל${nc.name} להקדים ל־${T.fmtTime(newStart, biz.tz)}`, detail: `הקדמה של ${Math.round((nb.start - newStart) / M)} דקות${nc.flexMinutes ? ' (סימנ/ה שמוכנ/ה להזיז)' : ''}`, newStart, apptId: nb.id }));
      }
      const brk = this.d.blocks.find((b) => b.bizId === biz.id && b.providerId === providerId && b.label === 'break' && b.start > g.end);
      if (brk && brk.end - brk.start <= g.end - g.start) out.push(mk('pull_break', { ref: brk.id, title: `להקדים את ההפסקה אל תוך החור (${gapText})`, detail: `ההפסקה מתוכננת ל־${T.fmtTime(brk.start, biz.tz)}`, blockId: brk.id }));
      out.push(mk('open_quick', { title: `לפתוח את החור (${gapText}) לשירות קצר / הזמנה מיידית`, detail: 'יופיע ללקוחות ללא הגבלת lead time' }));
    }
    const dismissed = new Set(this.d.dismissed);
    const res = out.filter((s) => !dismissed.has(s.id)).sort((a, b) => (b.priority || 0) - (a.priority || 0));
    return res;
  }
  approveSuggestion(biz, providerId, id) {
    const s = this.suggestions(biz, providerId).find((x) => x.id === id);
    if (!s) bad('ההצעה כבר לא רלוונטית', 404);
    const g = s.gap;
    biz.stats.gapsOffered++;
    if (s.type === 'waitlist') {
      const w = this.d.waitlist.find((x) => x.id === s.id.split(':')[3]);
      w.offer = { providerId: g.providerId, start: g.start, end: g.end, at: this.now() }; w.status = 'offered';
      const c = this.cust(w.customerId);
      this.queue(biz, { customerId: c.id, pipeline: 'ops', type: 'gap_open', to: c.phone, text: compose('gap_open', { biz, cust: c, gapWhen: `היום ב־${T.fmtTime(g.start, biz.tz)}`, link: `${this.baseUrl}/w/${w.token}` }) });
    } else if (s.type === 'move_earlier') {
      const a = this.appt(s.apptId); a.moveOffer = { start: s.newStart, at: this.now() };
      this.notify(biz, a, 'move_offer', { est: s.newStart });
    } else if (s.type === 'pull_break') {
      const b = this.d.blocks.find((x) => x.id === s.blockId); const len = b.end - b.start; b.start = g.start; b.end = g.start + len;
      this.reproject(biz, providerId);
    } else if (s.type === 'open_quick') biz.openGaps.push({ providerId: g.providerId, start: g.start, end: g.end });
    biz.stats.gapsApproved++;
    this.d.dismissed.push(s.id); this.save();
    return s;
  }
  dismissSuggestion(id) { this.d.dismissed.push(id); this.save(); }

  // Customer accepts / declines a move offer
  acceptMove(a) {
    const biz = this.d.businesses.find((b) => b.id === a.bizId);
    if (!a.moveOffer) bad('אין הצעה פעילה', 404);
    const start = a.moveOffer.start; a.moveOffer = null;
    const r = this.moveAppt(biz, a.id, start, 'owner');
    biz.stats.gapsClaimed++; this.save(); return r;
  }
  declineMove(a) {
    const biz = this.d.businesses.find((b) => b.id === a.bizId), c = this.cust(a.customerId), key = T.dateKey(this.now(), biz.tz);
    c.declines[key] = (c.declines[key] || 0) + 1; a.moveOffer = null; this.save();
  }

  // ---------- waitlist ----------
  addWaitlist(biz, { name, phone, serviceId, dateFrom, dateTo, note, marketingConsent }) {
    const svc = this.service(biz, serviceId), c = this.upsertCustomer(biz, { name, phone, marketingConsent });
    const w = { id: rid('w_'), bizId: biz.id, customerId: c.id, serviceId: svc.id, dateFrom: dateFrom || null, dateTo: dateTo || null, note: String(note || '').slice(0, 200), status: 'waiting', token: tok(), createdAt: this.now() };
    this.d.waitlist.push(w); this.save(); return w;
  }
  waitByToken(t) { const w = this.d.waitlist.find((x) => x.token === t); if (!w) bad('לא נמצא', 404); return w; }
  claimWait(w) {
    const biz = this.d.businesses.find((b) => b.id === w.bizId);
    if (w.status !== 'offered' || !w.offer) bad('ההצעה כבר לא בתוקף', 410);
    const c = this.cust(w.customerId), svc = this.service(biz, w.serviceId);
    if (!this.canPlace(biz, { providerId: w.offer.providerId, start: w.offer.start, minutes: this.durationFor(svc, c), buffer: svc.buffer })) { w.status = 'waiting'; w.offer = null; this.save(); bad('המקום כבר נתפס', 409); }
    const a = this.createAppt(biz, { cust: c, svc, providerId: w.offer.providerId, start: w.offer.start, source: 'waitlist', status: 'confirmed' });
    w.status = 'booked'; w.offer = null; biz.stats.gapsClaimed++; this.save(); return a;
  }

  // ---------- marketing (manual, separate pipeline) ----------
  segment(biz, seg = {}) {
    const now = this.now();
    return this.d.customers.filter((c) => {
      if (c.bizId !== biz.id || !c.phone) return false;
      const hist = this.d.appointments.filter((a) => a.customerId === c.id && a.status === 'done').sort((a, b) => b.start - a.start);
      if (seg.type === 'service' && !(hist[0] && hist[0].serviceId === seg.serviceId)) return false;
      if (seg.type === 'inactive' && !(hist[0] ? now - hist[0].start >= (seg.weeks || 4) * 7 * 24 * 60 * M : true)) return false;
      if (seg.type === 'tag' && !c.tags.includes(seg.tag)) return false;
      return true;
    });
  }
  campaignPreview(biz, seg, text) {
    const now = this.now(), all = this.segment(biz, seg), maxAge = biz.policy.marketingMaxDays * 24 * 60 * M;
    const noConsent = all.filter((c) => !c.marketingConsent), tooSoon = all.filter((c) => c.marketingConsent && now - c.lastMarketingAt < maxAge);
    const eligible = all.filter((c) => c.marketingConsent && now - c.lastMarketingAt >= maxAge);
    return { total: all.length, eligible: eligible.length, skippedNoConsent: noConsent.length, skippedFrequency: tooSoon.length, sample: text ? this.marketingText(biz, text, eligible[0] || { token: 'xxxx' }) : '', recipients: eligible.map((c) => c.name) };
  }
  marketingText(biz, text, c) { return `*${biz.name}*\n${String(text).slice(0, 800)}\n\nלהסרה מרשימת התפוצה: ${this.baseUrl}/o/${c.token}`; }
  sendCampaign(biz, seg, text) {
    if (!String(text || '').trim()) bad('טקסט ההודעה חסר');
    const pre = this.campaignPreview(biz, seg), now = this.now();
    const maxAge = biz.policy.marketingMaxDays * 24 * 60 * M;
    const targets = this.segment(biz, seg).filter((c) => c.marketingConsent && now - c.lastMarketingAt >= maxAge);
    for (const c of targets) { c.lastMarketingAt = now; this.queue(biz, { customerId: c.id, pipeline: 'marketing', type: 'campaign', text: this.marketingText(biz, text, c), to: c.phone }); }
    this.save();
    return { sent: targets.length, skippedNoConsent: pre.skippedNoConsent, skippedFrequency: pre.skippedFrequency };
  }
  optOut(token) {
    const c = this.d.customers.find((x) => x.token === token);
    if (!c) bad('לא נמצא', 404);
    this.setConsent(c, false); this.save(); return c;
  }

  // ---------- customer card ----------
  customerCard(biz, id) {
    const c = this.d.customers.find((x) => x.id === id && x.bizId === biz.id);
    if (!c) bad('לקוח לא נמצא', 404);
    const hist = this.d.appointments.filter((a) => a.customerId === c.id).sort((a, b) => b.start - a.start).map((a) => ({ id: a.id, start: a.start, status: a.status, service: (biz.services.find((s) => s.id === a.serviceId) || {}).name, planned: a.duration, actual: a.actualMinutes || null }));
    const sugg = [];
    for (const s of biz.services) {
      const done = hist.filter((h) => h.actual && this.d.appointments.find((a) => a.id === h.id).serviceId === s.id);
      if (done.length >= 3) {
        const avg = Math.round(done.reduce((t, h) => t + h.actual, 0) / done.length / 5) * 5;
        if (avg && avg !== this.durationFor(s, c)) sugg.push({ serviceId: s.id, service: s.name, current: this.durationFor(s, c), suggested: avg, samples: done.length });
      }
    }
    return { customer: c, history: hist, durationSuggestions: sugg };
  }

  // ---------- background tick ----------
  tick() {
    const now = this.now();
    for (const biz of this.d.businesses) {
      for (const a of this.d.appointments) {
        if (a.bizId !== biz.id || a.status !== 'confirmed') continue;
        const until = a.start - now;
        if (a.silent) continue;
        if (!a.sent.r24 && until <= 24 * 60 * M && until > 0) { a.sent.r24 = true; this.notify(biz, a, 'reminder24'); }
        if (!a.sent.r2 && until <= 2 * 60 * M && until > 0) { a.sent.r2 = true; this.notify(biz, a, 'reminder2'); }
        const est = (this.project(biz, a.providerId).get(a.id) || {}).estStart;
        if (est && !a.sent.prep && T.dateKey(now, biz.tz) === T.dateKey(a.start, biz.tz) && est - now <= biz.policy.prepareMin * M && est > now) { a.sent.prep = true; this.notify(biz, a, 'prepare', { est: ceil5(est) }); }
      }
      for (const w of this.d.waitlist) if (w.bizId === biz.id && w.status === 'offered' && now - w.offer.at > 30 * M) { w.status = 'waiting'; w.offer = null; }
      for (const p of biz.providers) this.reproject(biz, p.id);
      biz.openGaps = biz.openGaps.filter((g) => g.end > now);
    }
    const cut = now - 90 * 24 * 60 * M;
    this.d.dismissed = this.d.dismissed.slice(-300);
    this.d.messages = this.d.messages.filter((m) => m.at >= cut || m.status === 'queued' || m.status === 'needs_approval');
    this.save();
  }

  metrics(biz, days = 30) {
    const since = this.now() - days * 24 * 60 * M;
    const ap = this.d.appointments.filter((a) => a.bizId === biz.id && a.start >= since && ['done', 'no_show', 'cancelled', 'in_service'].includes(a.status));
    const done = ap.filter((a) => a.status === 'done');
    const timed = done.filter((a) => a.startedByTimer);
    const gap = done.filter((a) => a.actualMinutes);
    const msgs = this.d.messages.filter((m) => m.bizId === biz.id && m.at >= since);
    const opt = this.d.customers.filter((c) => c.bizId === biz.id && c.optedOut).length;
    const pct = (n, d) => (d ? Math.round((n / d) * 100) : null);
    return {
      days, sessions: done.length, timerUsagePct: pct(timed.length, done.length + ap.filter((a) => a.status === 'no_show').length),
      avgPlannedVsActual: gap.length ? +(gap.reduce((t, a) => t + (a.actualMinutes - a.duration), 0) / gap.length).toFixed(1) : null,
      delayMessages: msgs.filter((m) => m.type.startsWith('delay')).length, noShowPct: pct(ap.filter((a) => a.status === 'no_show').length, ap.length),
      gaps: biz.stats, marketingOptOuts: opt, marketingSent: msgs.filter((m) => m.pipeline === 'marketing').length,
    };
  }
}
const ORD = ['', 'ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שביעי', 'שמיני', 'תשיעי', 'עשירי'];
module.exports = { Engine, HttpError, ACTIVE, CHAIN, ceil5, M };
