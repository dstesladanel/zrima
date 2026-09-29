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
  assert.equal(r.status, 200); assert.deepEqual(r.json, { auto: true, hasCredentials: true, phoneId: '123456789012345' });
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
