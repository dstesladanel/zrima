'use strict';
const TZ = 'Asia/Jerusalem';
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function parts(ms, tz = TZ) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short' });
  const o = {};
  for (const p of f.formatToParts(new Date(ms))) o[p.type] = p.value;
  return { y: +o.year, m: +o.month, d: +o.day, h: +o.hour, mi: +o.minute, s: +o.second, wd: WD.indexOf(o.weekday) };
}
function offset(ms, tz) {
  const p = parts(ms, tz);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000;
}
function zoned(y, m, d, h, mi, tz = TZ) {
  const g = Date.UTC(y, m - 1, d, h, mi);
  const r = g - offset(g, tz);
  return g - offset(r, tz);
}
const pad = (n) => String(n).padStart(2, '0');
function dateKey(ms, tz = TZ) { const p = parts(ms, tz); return `${p.y}-${pad(p.m)}-${pad(p.d)}`; }
function fromKey(k) { const [y, m, d] = k.split('-').map(Number); return { y, m, d }; }
function dayStart(k, tz = TZ) { const { y, m, d } = fromKey(k); return zoned(y, m, d, 0, 0, tz); }
function atTime(k, hhmm, tz = TZ) { const { y, m, d } = fromKey(k); const [h, mi] = hhmm.split(':').map(Number); return zoned(y, m, d, h, mi, tz); }
function fmtTime(ms, tz = TZ) { const p = parts(ms, tz); return `${pad(p.h)}:${pad(p.mi)}`; }
function addDays(k, n) { const { y, m, d } = fromKey(k); const t = new Date(Date.UTC(y, m - 1, d + n)); return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`; }
function weekday(k, tz = TZ) { return parts(atTime(k, '12:00', tz), tz).wd; }
function dayLabel(ms, now, tz = TZ) {
  const k = dateKey(ms, tz), t = dateKey(now, tz);
  if (k === t) return 'היום';
  if (k === addDays(t, 1)) return 'מחר';
  return new Intl.DateTimeFormat('he-IL', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'numeric' }).format(new Date(ms));
}
module.exports = { TZ, parts, zoned, dateKey, fromKey, dayStart, atTime, fmtTime, addDays, weekday, dayLabel };
