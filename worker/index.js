// Cloudflare Worker entry. Static pages are served from ./public (free, unlimited);
// all API traffic goes to ONE Durable Object that owns the data (single-threaded => no race conditions).
import { DurableObject } from 'cloudflare:workers';
import { Engine } from '../lib/engine.js';
import { createApp } from '../lib/routes.js';
import { bootstrap } from '../lib/bootstrap.js';
import { SqlStore } from './store.js';

const PAGES = [[/^\/b\/[^/]+$/, '/booking.html'], [/^\/t\/[^/]+$/, '/my.html'], [/^\/live\/[^/]+$/, '/live.html'], [/^\/w\/[^/]+$/, '/wait.html'], [/^\/o\/[^/]+$/, '/optout.html'], [/^\/admin\/?$/, '/admin.html']];
const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
const reply = (status, obj) => new Response(JSON.stringify(obj), { status, headers: JSON_HEADERS });

export class App extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.store = new SqlStore(ctx.storage.sql);
    this.eng = new Engine(this.store, { baseUrl: env.BASE_URL || this.store.meta.baseUrl || '' });
    this.api = createApp(this.eng, env);
    bootstrap(this.eng, env);
    this.store.flush();
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/__tick') { this.eng.tick(); this.store.flush(); return new Response('ok'); }
    if (!this.env.BASE_URL && this.store.meta.baseUrl !== url.origin) { this.store.meta.baseUrl = url.origin; this.eng.baseUrl = url.origin; this.store.save(); }
    let body = {};
    if (request.method !== 'GET' && request.method !== 'DELETE') {
      try { const t = await request.text(); if (t.length > 2e6) return reply(413, { error: 'גדול מדי' }); body = t ? JSON.parse(t) : {}; }
      catch { return reply(400, { error: 'JSON לא תקין' }); }
    }
    const r = await this.api({
      method: request.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body,
      ip: request.headers.get('cf-connecting-ip') || '', authKey: (request.headers.get('authorization') || '').replace(/^Bearer /, ''),
    });
    this.store.flush();
    return reply(r.status, r.json);
  }
}

const hub = (env) => env.APP.get(env.APP.idFromName('main'));

export default {
  async fetch(request, env) {
    const url = new URL(request.url), p = url.pathname;
    if (p.startsWith('/api/')) return hub(env).fetch(request);
    if (p === '/healthz') return new Response('ok');
    if (p === '/favicon.ico') return new Response(null, { status: 204 });
    if (p === '/') return Response.redirect(url.origin + '/admin', 302);
    const page = PAGES.find(([re]) => re.test(p));
    if (page) return env.ASSETS.fetch(new Request(new URL(page[1], request.url)));
    return env.ASSETS.fetch(request);
  },
  // Cron trigger (every minute): reminders, "get ready" messages, delay updates.
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(hub(env).fetch('https://internal/__tick'));
  },
};
