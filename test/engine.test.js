'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { DB } = require('../lib/db');
const { Engine, M } = require('../lib/engine');
const T = require('../lib/time');

// Fixed clock: Monday 2026-10-05 in Israel time.
function setup(hhmm = '08:00') {
  const clock = { t: T.atTime('2026-10-05', hhmm) };
  const sent = [];
  const eng = new Engine(new DB(null), { now: () => clock.t, transport: { send: async (to, text) => { sent.push({ to, text }); return { ok: true }; } } });
  const biz = eng.createBusiness({ slug: 'demo', name: 'סטודיו', ownerKey: 'test-owner-key-1' });
  biz.hours[1] = [{ open: '09:00', close: '18:00' }];
  const gel = eng.addService(biz, { name: 'מילוי ג׳ל', duration: 60, buffer: 10, price: 100 });
  const quick = eng.addService(biz, { name: 'לק', duration: 30, buffer: 10, price: 50, walkin: true });
  const prov = biz.providers[0].id;
  const at = (h) => T.atTime('2026-10-05', h);
  const book = (svc, h, name, phone) => eng.book(biz, { serviceId: svc.id, providerId: prov, start: at(h), name, phone });
  return { clock, sent, eng, biz, gel, quick, prov, at, book };
}
const P = ['0501111111', '0502222222', '0503333333', '0504444444'];
const times = (s, svc) => s.eng.slots(s.biz, { serviceId: svc.id, providerId: 'any', dateKey: '2026-10-05' }).map((x) => x.time);

test('slot cannot cut the buffer of the previous appointment', () => {
  const s = setup();
  s.book(s.gel, '09:00', 'א', P[0]); // ends 10:00, buffer to 10:10
  const t = times(s, s.gel);
  assert.ok(!t.includes('10:00') && !t.includes('10:05'));
  assert.ok(t.includes('10:15'));
});
test('new slot cannot run into the next appointment', () => {
  const s = setup();
  s.book(s.gel, '12:00', 'א', P[0]);
  const t = times(s, s.gel);
  assert.ok(!t.includes('11:00'), '11:00+60+10 would run into 12:00');
  assert.ok(t.includes('10:45'));
});
test('lead time hides near slots', () => {
  const s = setup('08:30');
  const t = times(s, s.quick);
  assert.ok(!t.includes('09:15') && t.includes('09:30'));
});
test('timer starts only on start, not on arrival', () => {
  const s = setup('09:00');
  const a = s.book(s.gel, '10:00', 'א', P[0]);
  s.clock.t = s.at('10:00'); s.eng.arrive(s.biz, a.id);
  assert.equal(a.actualStart, undefined);
  s.clock.t = s.at('10:05'); s.eng.start(s.biz, a.id);
  assert.equal(a.actualStart, s.at('10:05'));
});
test('extension pushes the next customer and always notifies', () => {
  const s = setup('09:00');
  const a = s.book(s.gel, '10:00', 'א', P[0]); s.book(s.gel, '11:15', 'ב', P[1]);
  s.clock.t = s.at('10:00'); s.eng.start(s.biz, a.id);
  const before = s.eng.d.messages.length;
  s.clock.t = s.at('10:50'); s.eng.extend(s.biz, a.id, 15);
  // a ends 11:15, buffer to 11:25; b planned 11:15 -> 11:25 (10 min)
  const msgs = s.eng.d.messages.slice(before);
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].type, 'delay_clear');
  assert.match(msgs[0].text, /11:25/);
  assert.match(msgs[0].text, /סטודיו/);
});
test('small push is soft; >15 needs owner approval', () => {
  const s = setup('09:00');
  const a = s.book(s.gel, '10:00', 'א', P[0]); s.book(s.gel, '11:15', 'ב', P[1]);
  s.clock.t = s.at('10:00'); s.eng.start(s.biz, a.id);
  const n0 = s.eng.d.messages.length;
  s.eng.extend(s.biz, a.id, 5); // absorbed by the 10-minute buffer: nobody is affected
  assert.equal(s.eng.d.messages.length, n0);
  s.eng.extend(s.biz, a.id, 5); // 5 minutes of real push
  assert.equal(s.eng.d.messages[n0].type, 'delay_soft');
  s.eng.extend(s.biz, a.id, 5); // 10 minutes late
  assert.equal(s.eng.d.messages[s.eng.d.messages.length - 1].type, 'delay_clear');
  s.eng.extend(s.biz, a.id, 10, true); // 20 minutes late
  const m = s.eng.d.messages.slice(n0), last = m[m.length - 1];
  assert.equal(last.type, 'delay_big'); assert.equal(last.status, 'needs_approval');
});
test('extension cap of 20 needs explicit override', () => {
  const s = setup('09:00');
  const a = s.book(s.gel, '10:00', 'א', P[0]);
  s.clock.t = s.at('10:00'); s.eng.start(s.biz, a.id);
  s.eng.extend(s.biz, a.id, 15);
  assert.throws(() => s.eng.extend(s.biz, a.id, 10), /חריגה/);
  s.eng.extend(s.biz, a.id, 10, true);
  assert.equal(a.extra, 25);
});
test('live board is anonymous', () => {
  const s = setup('09:00');
  const a = s.book(s.gel, '10:00', 'שירה כהן', P[0]); s.book(s.gel, '11:15', 'דנה אברמוב', P[1]);
  s.clock.t = s.at('10:00'); s.eng.start(s.biz, a.id);
  const json = JSON.stringify(s.eng.liveBoard(s.biz));
  for (const x of ['שירה', 'כהן', 'דנה', 'אברמוב', '0501111111', '972501111111', '0502222222']) assert.ok(!json.includes(x), x);
  assert.match(json, /in_service/);
});
test('customer view exposes only their own appointment', () => {
  const s = setup('09:00');
  s.book(s.gel, '10:00', 'שירה', P[0]); const b = s.book(s.gel, '11:15', 'דנה', P[1]);
  const v = JSON.stringify(s.eng.myView(s.biz, b));
  assert.ok(!v.includes('שירה') && !v.includes(P[0]));
});
test('marketing needs consent and honours the frequency cap', () => {
  const s = setup('09:00');
  s.eng.upsertCustomer(s.biz, { name: 'א', phone: P[0], marketingConsent: true });
  s.eng.upsertCustomer(s.biz, { name: 'ב', phone: P[1], marketingConsent: false });
  let r = s.eng.sendCampaign(s.biz, { type: 'all' }, 'מבצע 10%');
  assert.equal(r.sent, 1); assert.equal(r.skippedNoConsent, 1);
  assert.match(s.eng.d.messages.find((x) => x.pipeline === 'marketing').text, /\/o\//);
  r = s.eng.sendCampaign(s.biz, { type: 'all' }, 'עוד מבצע');
  assert.equal(r.sent, 0); assert.equal(r.skippedFrequency, 1);
  s.clock.t += 8 * 24 * 60 * M;
  assert.equal(s.eng.sendCampaign(s.biz, { type: 'all' }, 'שוב').sent, 1);
});
test('opt-out stops marketing but not operational messages', () => {
  const s = setup('09:00');
  const c = s.eng.upsertCustomer(s.biz, { name: 'א', phone: P[0], marketingConsent: true });
  s.eng.optOut(c.token);
  assert.equal(s.eng.sendCampaign(s.biz, { type: 'all' }, 'x').sent, 0);
  const a = s.book(s.gel, '10:00', 'א', P[0]);
  assert.ok(s.eng.d.messages.some((m) => m.apptId === a.id && m.pipeline === 'ops'));
});
test('walk-in never overrides a confirmed appointment', () => {
  const s = setup('08:30');
  s.book(s.quick, '10:00', 'א', P[0]);
  s.clock.t = s.at('09:50');
  const r = s.eng.walkinCheck(s.biz, s.prov, s.quick.id);
  assert.equal(r.when, 'in');
  assert.ok(r.start >= s.at('10:40'), `walk-in starts ${T.fmtTime(r.start)}`);
});
test('gap detection + waitlist suggestion, no automatic moves', () => {
  const s = setup('09:00');
  const a = s.book(s.gel, '10:00', 'א', P[0]);
  const b = s.book(s.gel, '12:00', 'ב', P[1]);
  s.eng.addWaitlist(s.biz, { name: 'ג', phone: P[2], serviceId: s.quick.id });
  s.clock.t = s.at('10:00'); s.eng.start(s.biz, a.id); s.clock.t = s.at('11:00'); s.eng.end(s.biz, a.id);
  const sg = s.eng.suggestions(s.biz, s.prov);
  assert.ok(sg.some((x) => x.type === 'waitlist'));
  assert.equal(b.start, s.at('12:00'), 'no automatic move');
  const before = s.eng.d.messages.length;
  s.eng.approveSuggestion(s.biz, s.prov, sg.find((x) => x.type === 'waitlist').id);
  assert.equal(s.eng.d.messages.length, before + 1);
  assert.equal(s.eng.claimWait(s.eng.d.waitlist[0]).source, 'waitlist');
});
test('self-cancel is blocked inside the policy window unless delayed', () => {
  const s = setup('09:00');
  const a = s.book(s.gel, '10:00', 'א', P[0]);
  assert.throws(() => s.eng.customerCancel(a), /ביטול עצמי/);
  a.freeChange = true;
  s.eng.customerCancel(a);
  assert.equal(a.status, 'cancelled');
});
test('actual duration recorded; duration suggestion after 3 sessions, never auto-applied', () => {
  const s = setup('09:00');
  const c = s.eng.upsertCustomer(s.biz, { name: 'א', phone: P[0] });
  for (let i = 0; i < 3; i++) {
    const a = s.eng.createAppt(s.biz, { cust: c, svc: s.gel, providerId: s.prov, start: s.at('10:00') + i * 3 * 3600000, source: 'manual' });
    s.clock.t = a.start; s.eng.start(s.biz, a.id); s.clock.t += 75 * M; s.eng.end(s.biz, a.id);
  }
  const card = s.eng.customerCard(s.biz, c.id);
  assert.equal(card.durationSuggestions[0].suggested, 75);
  assert.equal(c.durations[s.gel.id], undefined);
});

test('free mode: messages wait in the outbox, one tap marks them sent', () => {
  const s = setup('09:00');
  const a = s.book(s.gel, '10:00', 'א', P[0]);
  const m = s.eng.d.messages.find((x) => x.apptId === a.id);
  m.status = 'queued'; // the test transport reports ok; free mode leaves messages queued
  const box = s.eng.outbox(s.biz);
  assert.equal(box.length, 1);
  assert.match(box[0].url, /^https:\/\/wa\.me\/972501111111\?text=/);
  s.eng.markSent(s.biz, m.id);
  assert.equal(s.eng.outbox(s.biz).length, 0);
  assert.equal(m.status, 'sent');
});
test('owner key: right key logs in, wrong key does not', () => {
  const s = setup('09:00');
  assert.equal(s.eng.bizByKey('test-owner-key-1'), s.biz);
  assert.equal(s.eng.bizByKey('nope'), null);
  assert.equal(s.eng.bizByKey(''), null);
});

test('setup import: services, hours, brand, fonts; bad input rejected', async () => {
  const { createApp } = require('../lib/routes');
  const s = setup('09:00');
  const app = createApp(s.eng, {});
  const call = (body) => app({ method: 'PUT', path: '/api/owner/import', body, authKey: 'test-owner-key-1' });
  const r = await call({
    tagline: 'AMORE', contact: { phone: '0546922413', address: 'חריש' },
    brand: { primary: '#cfa8af', font: 'Noto Sans Hebrew', logo: 'https://example.com/l.jpg', cover: 'javascript:alert(1)' },
    hours: { 0: [{ open: '09:00', close: '14:00' }], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] },
    services: [{ name: 'לק ג׳ל', duration: 60, buffer: 10, price: 150 }, { name: 'מילוי גל', duration: 30, price: 1, active: false }],
  });
  assert.equal(r.status, 200);
  assert.equal(s.biz.brand.font, 'Noto Sans Hebrew');
  assert.equal(s.biz.brand.logo, 'https://example.com/l.jpg');
  assert.equal(s.biz.brand.cover, '', 'non-http image links are dropped');
  assert.equal(s.biz.hours[0][0].close, '14:00');
  assert.ok(s.biz.services.find((v) => v.name === 'לק ג׳ל' && v.price === 150));
  assert.equal(s.biz.services.find((v) => v.name === 'מילוי גל').active, false);
  // importing again updates instead of duplicating
  const again = await call({ services: [{ name: 'לק ג׳ל', duration: 45, price: 160 }] });
  assert.equal(again.json.services.updated, 1);
  assert.equal(s.biz.services.filter((v) => v.name === 'לק ג׳ל').length, 1);
  assert.equal((await call({ hours: { 0: [{ open: '18:00', close: '09:00' }] } })).status, 400);
  assert.equal((await app({ method: 'PUT', path: '/api/owner/import', body: {}, authKey: 'wrong' })).status, 401);
});
test('platform admin can create a second business with setup; needs MASTER_KEY', async () => {
  const { createApp } = require('../lib/routes');
  const s = setup('09:00');
  const app = createApp(s.eng, { MASTER_KEY: 'master-secret-1' });
  const body = { slug: 'daniela', name: 'דניאלה', ownerKey: 'owner-key-123456', setup: { services: [{ name: 'לק', duration: 45, price: 100 }] } };
  assert.equal((await app({ method: 'POST', path: '/api/admin/businesses', body, authKey: 'nope' })).status, 401);
  const r = await app({ method: 'POST', path: '/api/admin/businesses', body, authKey: 'master-secret-1' });
  assert.equal(r.status, 200); assert.equal(r.json.services.total, 1);
  assert.equal(s.eng.bizByKey('owner-key-123456').slug, 'daniela');
  assert.equal(s.eng.bizByKey('test-owner-key-1').slug, 'demo', 'the first business is untouched');
});

test('platform admin: update an existing business and reset its owner key', async () => {
  const { createApp } = require('../lib/routes');
  const s = setup('09:00');
  const app = createApp(s.eng, { MASTER_KEY: 'master-secret-1' });
  const adm = (path, body, key = 'master-secret-1') => app({ method: 'POST', path, body, authKey: key });
  assert.equal((await adm('/api/admin/businesses/demo/setup', {}, 'x')).status, 401);
  const u = await adm('/api/admin/businesses/demo/setup', { tagline: 'חדש', services: [{ name: 'שירות', duration: 30, price: 10 }] });
  assert.equal(u.status, 200); assert.equal(s.biz.tagline, 'חדש');
  assert.equal((await adm('/api/admin/businesses/demo/owner-key', { ownerKey: 'short' })).status, 400);
  assert.equal((await adm('/api/admin/businesses/demo/owner-key', { ownerKey: 'a-brand-new-key-1' })).status, 200);
  assert.equal(s.eng.bizByKey('test-owner-key-1'), null, 'old key no longer works');
  assert.equal(s.eng.bizByKey('a-brand-new-key-1'), s.biz);
  assert.equal((await adm('/api/admin/businesses/nope/setup', {})).status, 404);
});

test('owner keys must be ASCII (a Hebrew keyboard layout would make an unusable key)', () => {
  const s = setup('09:00');
  assert.throws(() => s.eng.createBusiness({ slug: 'x1', name: 'x', ownerKey: 'סיסמה-בעברית-123' }), /אנגליות/);
  assert.throws(() => s.eng.setOwnerKey(s.biz, 'short'), /12/);
  assert.throws(() => s.eng.setOwnerKey(s.biz, 'has space in it 123'), /אנגליות/);
});

test('messaging: manual by default; auto sends with the business credentials; failures fall back to the outbox; token never exposed', async () => {
  const { createApp } = require('../lib/routes');
  const calls = [];
  const s = setup('09:00');
  let ok = true;
  s.eng.transport = { send: async (to, text, creds) => { calls.push({ to, creds }); return { ok }; } };
  const app = createApp(s.eng, {});
  const put = (body) => app({ method: 'PUT', path: '/api/owner/messaging', body, authKey: 'test-owner-key-1' });
  // manual by default: nothing is sent, the message waits in the outbox
  const a = s.book(s.gel, '10:00', 'א', P[0]);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(calls.length, 0);
  assert.equal(s.eng.d.messages.find((m) => m.apptId === a.id).status, 'queued');
  // auto needs credentials
  assert.equal((await put({ auto: true })).status, 400);
  assert.equal((await put({ auto: true, token: 'x'.repeat(30), phoneId: 'abc' })).status, 400);
  const r = await put({ auto: true, token: 'EAAB' + 'x'.repeat(30), phoneId: '123456789012345' });
  assert.equal(r.status, 200); assert.equal(r.json.auto, true); assert.equal(r.json.hasCredentials, true); assert.equal(r.json.phoneId, '123456789012345');
  const me = JSON.stringify((await app({ method: 'GET', path: '/api/owner/me', authKey: 'test-owner-key-1' })).json);
  assert.ok(!me.includes('EAAB'), 'the token is never returned to the browser');
  // auto: the next message is sent with this business's credentials
  const b = s.book(s.gel, '12:00', 'ב', P[1]);
  await new Promise((r2) => setTimeout(r2, 5));
  assert.equal(calls.length, 1); assert.equal(calls[0].creds.phoneId, '123456789012345');
  assert.equal(s.eng.d.messages.find((m) => m.apptId === b.id).status, 'sent');
  // a failed send returns to the outbox instead of being lost
  ok = false;
  const c = s.book(s.gel, '14:00', 'ג', P[2]);
  await new Promise((r2) => setTimeout(r2, 5));
  const mc = s.eng.d.messages.find((m) => m.apptId === c.id);
  assert.equal(mc.status, 'queued'); assert.equal(mc.autoFailed, true);
  // clearing credentials switches back to manual
  await put({ clear: true });
  assert.equal(s.eng.msgCfg(s.biz).auto, false);
});

test('booking request (free mode): customer gets a ready WhatsApp to the owner; approving gives the owner a ready confirmation', async () => {
  const { createApp } = require('../lib/routes');
  const s = setup('09:00');
  s.biz.policy.autoConfirm = false; s.biz.contact.whatsapp = '054-692-2413';
  s.eng.baseUrl = 'https://zrima.example';
  const app = createApp(s.eng, {}), key = 'test-owner-key-1';
  const a = s.book(s.gel, '12:00', 'שירה כהן', P[0]);
  assert.equal(a.status, 'pending');
  assert.equal(s.eng.d.messages.filter((m) => m.apptId === a.id).length, 0, 'nothing is queued for the customer yet (the screen already says "request received")');
  // the slot is held while the request waits
  assert.ok(!times(s, s.gel).includes('12:00'));
  // customer screen: ready-made message to the owner with the approval link
  const view = s.eng.myView(s.biz, a);
  assert.match(view.ownerWa.url, /^https:\/\/wa\.me\/972546922413\?text=/);
  const sentText = decodeURIComponent(view.ownerWa.url.split('text=')[1]);
  assert.ok(sentText.includes(`https://zrima.example/admin?appt=${a.id}`) && sentText.includes('שירה כהן'));
  // owner side: the request is listed, and needs the owner key
  const list = await app({ method: 'GET', path: '/api/owner/today', authKey: key });
  assert.equal(list.json.pendingRequests.length, 1);
  assert.equal((await app({ method: 'GET', path: `/api/owner/appts/${a.id}`, authKey: 'wrong-key-123456' })).status, 401);
  assert.equal((await app({ method: 'POST', path: `/api/owner/appts/${a.id}/approve`, authKey: 'wrong-key-123456' })).status, 401);
  const det = await app({ method: 'GET', path: `/api/owner/appts/${a.id}`, authKey: key });
  assert.equal(det.json.customerName, 'שירה כהן'); assert.equal(det.json.status, 'pending');
  // one tap: approve -> confirmed, and a ready WhatsApp confirmation for the customer
  const ok = await app({ method: 'POST', path: `/api/owner/appts/${a.id}/approve`, authKey: key });
  assert.equal(ok.json.status, 'confirmed');
  assert.match(ok.json.wa.url, /^https:\/\/wa\.me\/972501111111\?text=/);
  assert.ok(decodeURIComponent(ok.json.wa.url).includes('אושר'));
  assert.equal(s.eng.myView(s.biz, a).ownerWa, undefined, 'no more "ask the owner" prompt once approved');
  assert.equal((await app({ method: 'GET', path: '/api/owner/today', authKey: key })).json.pendingRequests.length, 0);
});
test('booking request: rejecting frees the slot and prepares a message with a link to book again', async () => {
  const { createApp } = require('../lib/routes');
  const s = setup('09:00');
  s.biz.policy.autoConfirm = false;
  const app = createApp(s.eng, {}), key = 'test-owner-key-1';
  const a = s.book(s.gel, '12:00', 'א', P[0]);
  const r = await app({ method: 'POST', path: `/api/owner/appts/${a.id}/reject`, authKey: key });
  assert.equal(r.json.status, 'cancelled');
  assert.ok(decodeURIComponent(r.json.wa.url).includes('/b/demo'));
  assert.ok(times(s, s.gel).includes('12:00'), 'the slot is free again');
});
test('booking request (automatic mode): the owner is alerted by the system, with the approval link', async () => {
  const { createApp } = require('../lib/routes');
  const s = setup('09:00');
  s.biz.policy.autoConfirm = false; s.biz.contact.whatsapp = '0546922413';
  s.eng.baseUrl = 'https://zrima.example';
  const calls = [];
  s.eng.transport = { send: async (to, text) => { calls.push({ to, text }); return { ok: true }; } };
  const app = createApp(s.eng, {});
  await app({ method: 'PUT', path: '/api/owner/messaging', authKey: 'test-owner-key-1', body: { auto: true, token: 'EAAB' + 'x'.repeat(30), phoneId: '123456789012345' } });
  const a = s.book(s.gel, '12:00', 'שירה', P[0]);
  await new Promise((r) => setTimeout(r, 5));
  const toOwner = calls.find((c) => c.to === '972546922413');
  assert.ok(toOwner, 'a WhatsApp went to the owner');
  assert.ok(toOwner.text.includes(`https://zrima.example/admin?appt=${a.id}`) && toOwner.text.includes('שירה'));
  assert.ok(calls.some((c) => c.to === '972501111111'), 'and the customer gets an acknowledgement');
});
test('free mode: no owner alert is invented; a failed automatic owner alert lands in the outbox addressed to the owner', async () => {
  const s = setup('09:00');
  s.biz.policy.autoConfirm = false; s.biz.contact.whatsapp = '0546922413';
  s.book(s.gel, '12:00', 'א', P[0]);
  assert.equal(s.eng.d.messages.length, 0);
  Object.assign(s.eng.msgCfg(s.biz), { auto: true, wa: { token: 'x'.repeat(30), phoneId: '123456789012345' } });
  s.eng.transport = { send: async () => ({ ok: false }) };
  s.book(s.gel, '14:00', 'ב', P[1]);
  await new Promise((r) => setTimeout(r, 5));
  const item = s.eng.outbox(s.biz).find((m) => m.type === 'owner_alert');
  assert.ok(item && item.phone === '972546922413' && item.url.startsWith('https://wa.me/972546922413'));
});

test('owner is alerted about every new online booking, with a link to move or cancel it', async () => {
  const s = setup('09:00');
  s.biz.contact.whatsapp = '0546922413'; s.eng.baseUrl = 'https://zrima.example';
  const cm = [];
  s.eng.transport = { send: async () => ({ ok: true }), callMeBot: async (phone, text, key) => { cm.push({ phone, text, key }); return { ok: true }; } };
  // no channel configured: nothing is sent, but the booking shows in the app as new
  const a = s.book(s.gel, '12:00', 'שירה כהן', P[0]);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(cm.length, 0);
  assert.equal(s.eng.newBookings(s.biz).length, 1);
  // free automatic channel
  s.eng.msgCfg(s.biz).ownerAlert.callmebot = { phone: '972546922413', apiKey: 'abc12345' };
  const b = s.book(s.gel, '14:00', 'דנה', P[1]);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(cm.length, 1);
  assert.equal(cm[0].phone, '972546922413'); assert.equal(cm[0].key, 'abc12345');
  assert.ok(cm[0].text.includes('תור חדש') && cm[0].text.includes('דנה') && cm[0].text.includes(`https://zrima.example/admin?appt=${b.id}`));
  assert.equal(s.eng.d.messages.find((m) => m.type === 'owner_alert').status, 'sent');
  // manual bookings by the owner herself do not alert her
  s.eng.book(s.biz, { serviceId: s.gel.id, providerId: s.prov, start: s.at('16:00'), name: 'ג', phone: P[2], source: 'manual' });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(cm.length, 1);
  // a customer cancelling tells the owner too
  a.freeChange = true; s.eng.customerCancel(a);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(cm.length, 2); assert.ok(cm[1].text.includes('בוטל'));
  // a failing gateway is recorded, never thrown
  s.eng.transport.callMeBot = async () => ({ ok: false });
  s.book(s.gel, '10:00', 'ד', P[3]);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(s.eng.d.messages.filter((m) => m.type === 'owner_alert').at(-1).status, 'failed');
});
test('owner can move or cancel a booking and gets a ready WhatsApp for the customer; opening it marks it seen', async () => {
  const { createApp } = require('../lib/routes');
  const s = setup('09:00'), app = createApp(s.eng, {}), key = 'test-owner-key-1';
  const a = s.book(s.gel, '12:00', 'שירה', P[0]);
  assert.equal(s.eng.newBookings(s.biz).length, 1);
  assert.equal((await app({ method: 'GET', path: `/api/owner/appts/${a.id}`, authKey: key })).status, 200);
  assert.equal(s.eng.newBookings(s.biz).length, 0, 'viewing it counts as seen');
  const mv = await app({ method: 'POST', path: `/api/owner/appts/${a.id}/move`, authKey: key, body: { start: s.at('15:00') } });
  assert.equal(mv.status, 200); assert.equal(a.start, s.at('15:00'));
  assert.match(mv.json.wa.url, /^https:\/\/wa\.me\/972501111111\?text=/);
  const cn = await app({ method: 'POST', path: `/api/owner/appts/${a.id}/cancel`, authKey: key });
  assert.equal(cn.json.status, 'cancelled'); assert.ok(cn.json.wa.url.includes('wa.me/972501111111'));
  assert.equal((await app({ method: 'POST', path: `/api/owner/appts/${a.id}/cancel`, authKey: 'wrong-key-123456' })).status, 401);
});
test('calendar feed: valid iCalendar with the bookings, secret link, can be rotated', async () => {
  const { createApp } = require('../lib/routes');
  const s = setup('09:00'), app = createApp(s.eng, {}), key = 'test-owner-key-1';
  s.biz.contact.address = 'טורקיז 3, חריש'; s.eng.baseUrl = 'https://zrima.example';
  const a = s.book(s.gel, '12:00', 'שירה, כהן', P[0]);
  const c = s.book(s.gel, '14:00', 'דנה', P[1]); s.eng.cancel(s.biz, c.id);
  const { json: { token } } = await app({ method: 'GET', path: '/api/owner/calendar', authKey: key });
  const r = await app({ method: 'GET', path: `/api/cal/${token}.ics` });
  assert.equal(r.status, 200); assert.match(r.type, /text\/calendar/);
  const ics = r.text;
  assert.ok(ics.startsWith('BEGIN:VCALENDAR\r\n') && ics.endsWith('END:VCALENDAR\r\n'));
  assert.ok(ics.includes(`UID:${a.id}@zrima`) && ics.includes('STATUS:CONFIRMED') && ics.includes('STATUS:CANCELLED'));
  assert.ok(ics.includes('LOCATION:טורקיז 3\\, חריש'), 'commas are escaped');
  assert.ok(ics.includes('DTSTART:' + new Date(s.at('12:00')).toISOString().replace(/[-:]|\.\d+/g, '')));
  const unfolded = ics.replace(/\r\n /g, '');
  assert.ok(unfolded.includes('SUMMARY:שירה\\, כהן'));
  for (const line of ics.split('\r\n')) assert.ok(new TextEncoder().encode(line).length <= 75, 'folded to 75 octets: ' + line);
  assert.equal((await app({ method: 'GET', path: '/api/cal/not-a-token.ics' })).status, 404);
  const rot = await app({ method: 'POST', path: '/api/owner/calendar/rotate', authKey: key });
  assert.notEqual(rot.json.token, token);
  assert.equal((await app({ method: 'GET', path: `/api/cal/${token}.ics` })).status, 404, 'the old link stops working');
  assert.equal((await app({ method: 'GET', path: '/api/owner/calendar', authKey: 'wrong-key-123456' })).status, 401);
});

test('platform admin: overview lists businesses with numbers only; generated keys work and are shown once', async () => {
  const { createApp } = require('../lib/routes');
  const s = setup('09:00'), MK = 'master-secret-1';
  const app = createApp(s.eng, { MASTER_KEY: MK });
  const call = (method, path, body, key = MK) => app({ method, path, body: body || {}, authKey: key, ip: '1.1.1.1' });
  s.book(s.gel, '12:00', 'שירה כהן', P[0]);
  Object.assign(s.eng.msgCfg(s.biz), { auto: true, wa: { token: 'EAAB' + 'y'.repeat(30), phoneId: '123456789012345' } });
  assert.equal((await call('GET', '/api/admin/businesses', null, 'wrong-key-123456')).status, 401);
  assert.equal((await call('GET', '/api/admin/businesses', null, 'test-owner-key-1')).status, 401, 'an owner key is not a master key');
  const list = await call('GET', '/api/admin/businesses');
  assert.equal(list.status, 200); assert.equal(list.json.length, 1);
  const row = list.json[0];
  assert.equal(row.slug, 'demo'); assert.equal(row.customers, 1); assert.equal(row.services, 2); assert.ok(row.lastBookingAt);
  const dump = JSON.stringify(list.json);
  for (const secret of ['EAAB', 'ownerKeyHash', 'salt', 'calToken', 'שירה', P[0], '972501111111']) assert.ok(!dump.includes(secret), 'no secrets or personal data: ' + secret);
  // create without a key -> a strong ASCII key is generated and returned once; it logs in
  const made = await call('POST', '/api/admin/businesses', { slug: 'noa', name: 'נועה', setup: { services: [{ name: 'לק', duration: 45, price: 100 }] } });
  assert.equal(made.status, 200); assert.match(made.json.ownerKey, /^[\x21-\x7e]{12,}$/);
  assert.equal(s.eng.bizByKey(made.json.ownerKey).slug, 'noa');
  // a supplied key is never echoed back
  const own = await call('POST', '/api/admin/businesses', { slug: 'dana', name: 'דנה', ownerKey: 'my-own-chosen-key-1' });
  assert.equal(own.json.ownerKey, undefined); assert.equal(s.eng.bizByKey('my-own-chosen-key-1').slug, 'dana');
  // creation is all-or-nothing: a bad setup leaves no half-made business
  const bad = await call('POST', '/api/admin/businesses', { slug: 'bad', name: 'x', setup: { hours: { 0: [{ open: '18:00', close: '09:00' }] } } });
  assert.equal(bad.status, 400); assert.ok(!s.eng.d.businesses.some((b) => b.slug === 'bad'));
  assert.equal((await call('POST', '/api/admin/businesses', { slug: 'noa', name: 'again' })).status, 409);
  // new key without typing one
  const old = made.json.ownerKey, re = await call('POST', '/api/admin/businesses/noa/owner-key');
  assert.equal(re.status, 200); assert.notEqual(re.json.ownerKey, old);
  assert.equal(s.eng.bizByKey(old), null); assert.equal(s.eng.bizByKey(re.json.ownerKey).slug, 'noa');
});
test('repeated wrong keys from one address are throttled', async () => {
  const { createApp } = require('../lib/routes');
  const s = setup('09:00'), app = createApp(s.eng, { MASTER_KEY: 'master-secret-1' });
  const bad = () => app({ method: 'GET', path: '/api/owner/me', authKey: 'wrong-key-123456', ip: '9.9.9.9' });
  for (let i = 0; i < 31; i++) assert.equal((await bad()).status, 401);
  assert.equal((await bad()).status, 429);
  assert.equal((await app({ method: 'GET', path: '/api/owner/me', authKey: 'test-owner-key-1', ip: '8.8.8.8' })).status, 200, 'other addresses are unaffected');
});
