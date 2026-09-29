'use strict';
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => (n ? `₪${n}` : '');
const hm = (ms) => new Intl.DateTimeFormat('he-IL', { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ms));
const dayName = (key) => new Intl.DateTimeFormat('he-IL', { weekday: 'long', day: 'numeric', month: 'numeric' }).format(new Date(key + 'T12:00:00+03:00'));
const lastSeg = () => decodeURIComponent(location.pathname.split('/').filter(Boolean).pop());
async function api(path, { method = 'GET', body, key } = {}) {
  const h = { 'Content-Type': 'application/json' };
  if (key) h.Authorization = 'Bearer ' + key;
  const r = await fetch(path, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.error || 'שגיאה'); e.status = r.status; throw e; }
  return j;
}
function applyBrand(b) {
  if (!b) return;
  const st = document.documentElement.style;
  st.setProperty('--p', b.primary); st.setProperty('--s', b.secondary); st.setProperty('--bg', b.bg);
  st.setProperty('--font', `'${b.font}',system-ui,sans-serif`);
  if (!document.getElementById('gf')) {
    const l = document.createElement('link'); l.id = 'gf'; l.rel = 'stylesheet';
    l.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(b.font)}:wght@400;600;800&display=swap`; document.head.appendChild(l);
  }
}
function brandHead(biz) {
  const b = biz.brand || {};
  const logo = b.logo ? `<img src="${esc(b.logo)}" alt="">` : `<div class="logo">${esc((biz.name || '?')[0])}</div>`;
  return `${b.cover ? `<div class="cover" style="background-image:url('${esc(b.cover)}')"></div>` : ''}
  <div class="brandhead">${logo}<div><h1>${esc(biz.name)}</h1><div class="muted">${esc(biz.tagline || '')}</div></div></div>`;
}
function contactLinks(c = {}) {
  const l = [];
  if (c.whatsapp) l.push(`<a href="https://wa.me/${esc(c.whatsapp)}">וואטסאפ</a>`);
  if (c.instagram) l.push(`<a href="https://instagram.com/${esc(c.instagram)}">אינסטגרם</a>`);
  if (c.phone) l.push(`<a href="tel:${esc(c.phone)}">${esc(c.phone)}</a>`);
  return l.join(' · ');
}
const FOOT = '<div class="foot">מופעל על ידי זרימה</div>';
const STATE_TXT = { open: 'פתוח', in_service: 'בטיפול', break: 'בהפסקה', closed: 'סגור' };
function boardHTML(board) {
  return board.chairs.map((c) => `<div class="card"><div class="state"><span class="dot ${c.state}"></span>${c.label ? esc(c.label) + ' · ' : ''}${STATE_TXT[c.state]}</div>
  ${c.state === 'in_service' ? `<p class="big" style="font-size:1.4rem;margin:.5em 0 0">${esc(c.serviceLabel)}</p><div class="muted">נשארו ${esc(c.remaining)}</div>` : ''}
  ${c.waiting ? `<div class="muted" style="margin-top:6px">${c.waiting} ממתינים אחרי הנוכחי${c.nextEntry ? ` · כניסה משוערת הבאה ${esc(c.nextEntry)}` : ''}</div>` : ''}</div>`).join('');
}
