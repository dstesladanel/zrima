'use strict';
// Node adapter (local development / any VPS or Docker host). The Cloudflare Worker uses the same lib/routes.js.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { DB } = require('./lib/db');
const { Engine } = require('./lib/engine');
const { createApp } = require('./lib/routes');
const { bootstrap } = require('./lib/bootstrap');

const PORT = +process.env.PORT || 3000;
const BASE = process.env.BASE_URL || `http://localhost:${PORT}`;
const db = new DB(process.env.DB_FILE || path.join(__dirname, 'data', 'db.json'));
const eng = new Engine(db, { baseUrl: BASE });
const app = createApp(eng, process.env);
const PUB = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };
const PAGES = [[/^\/b\/[^/]+$/, 'booking.html'], [/^\/t\/[^/]+$/, 'my.html'], [/^\/live\/[^/]+$/, 'live.html'], [/^\/w\/[^/]+$/, 'wait.html'], [/^\/o\/[^/]+$/, 'optout.html'], [/^\/admin\/?$/, 'admin.html'], [/^\/platform\/?$/, 'platform.html']];

function readBody(req) {
  return new Promise((res, rej) => {
    let s = ''; req.on('data', (d) => { s += d; if (s.length > 2e6) { req.destroy(); rej(Object.assign(new Error('גדול מדי'), { status: 413 })); } });
    req.on('end', () => { try { res(s ? JSON.parse(s) : {}); } catch { rej(Object.assign(new Error('JSON לא תקין'), { status: 400 })); } });
  });
}
function serveFile(res, file) {
  fs.readFile(file, (e, buf) => {
    if (e) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' }); res.end(buf);
  });
}
async function handler(req, res) {
  const url = new URL(req.url, 'http://x'), p = url.pathname;
  if (p.startsWith('/api/')) {
    const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
    try {
      const body = req.method === 'GET' || req.method === 'DELETE' ? {} : await readBody(req);
      const r = await app({ method: req.method, path: p, query: Object.fromEntries(url.searchParams), body, ip: req.socket.remoteAddress || '', authKey: (req.headers.authorization || '').replace(/^Bearer /, '') });
      return send(r.status, r.json);
    } catch (e) { return send(e.status || 500, { error: e.message }); }
  }
  if (p === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
  if (p === '/favicon.ico') { res.writeHead(204); return res.end(); }
  const cal = p.match(/^\/cal\/([^/]+)$/);
  if (cal) {
    const r = await app({ method: 'GET', path: '/api/cal/' + cal[1] });
    res.writeHead(r.status, { 'Content-Type': r.type || 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(r.text !== undefined ? r.text : JSON.stringify(r.json));
  }
  const page = PAGES.find(([re]) => re.test(p));
  if (page) return serveFile(res, path.join(PUB, page[1]));
  if (p === '/') { res.writeHead(302, { Location: '/admin' }); return res.end(); }
  const f = path.join(PUB, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
  if (!f.startsWith(PUB)) { res.writeHead(403); return res.end(); }
  serveFile(res, f);
}

if (require.main === module) {
  bootstrap(eng, process.env);
  http.createServer(handler).listen(PORT, () => console.log(`זרימה listening on ${BASE}`));
  setInterval(() => { try { eng.tick(); } catch (e) { console.error('tick', e); } }, 30000);
  process.on('SIGTERM', () => { db.flush(); process.exit(0); });
  process.on('SIGINT', () => { db.flush(); process.exit(0); });
}
module.exports = { handler, eng };
