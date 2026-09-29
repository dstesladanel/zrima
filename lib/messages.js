'use strict';
const T = require('./time');
// Tone helper: business chooses female / male / neutral addressing.
const g = (tone, f, m, n) => (tone === 'female' ? f : tone === 'male' ? m : n);
function compose(type, c) {
  const { biz, cust, appt, svc, link, now } = c;
  const tone = biz.brand.tone || 'neutral';
  const name = (cust && cust.name) || '';
  const time = (ms) => T.fmtTime(ms, biz.tz);
  const est = c.est != null ? time(c.est) : appt ? time(appt.start) : '';
  const when = appt ? `${T.dayLabel(appt.start, now, biz.tz)} בשעה ${time(appt.start)}` : '';
  const addr = biz.contact.address ? `\n📍 ${biz.contact.address}` : '';
  let body;
  switch (type) {
    case 'created': body = `היי ${name}, התור ל${svc.name} נקבע ל${when}.${addr}\nניהול התור, סטטוס חי וביטול: ${link}`; break;
    case 'pending': body = `היי ${name}, קיבלנו את הבקשה ל${svc.name} ב${when}. נחזור עם אישור בהקדם.\n${link}`; break;
    case 'approved': body = `היי ${name}, התור ל${svc.name} אושר: ${when}.${addr}\n${link}`; break;
    case 'rejected': body = `היי ${name}, לא הצלחנו לאשר את התור המבוקש. אפשר לקבוע שעה אחרת כאן: ${c.bookLink}`; break;
    case 'reminder24': case 'reminder2': body = `תזכורת: התור שלך ${when}.${addr}\n${g(tone, 'אישור הגעה', 'אישור הגעה', 'אישור הגעה')} בלחיצה: ${link}`; break;
    case 'prepare': body = `הגיע הזמן להתכונן 🙂 שעת הכניסה המעודכנת: ${est}.\n${link}`; break;
    case 'delay_soft': body = `עיכוב קל, שעת הכניסה המעודכנת כ־${est}.\n${link}`; break;
    case 'delay_update': body = `עדכון: שעת הכניסה המעודכנת כ־${est}.\n${link}`; break;
    case 'delay_clear': body = `יש עיכוב של כ־${c.delay} דקות. שעת הכניסה החדשה: ${est}.\n${g(tone, 'אם לא מתאים לך', 'אם לא מתאים לך', 'אם לא מתאים')} אפשר להזיז או לבטל ללא עלות: ${link}`; break;
    case 'delay_big': body = `יש עיכוב משמעותי של כ־${c.delay} דקות. שעת הכניסה החדשה: ${est}.\nנשמח להתאים לך: אפשר להזיז או לבטל ללא עלות כאן: ${link}`; break;
    case 'early': body = `${g(tone, 'אפשר להיכנס', 'אפשר להיכנס', 'אפשר להיכנס')} מוקדם יותר, כבר ב־${est}? אם כן, עדכנו כאן: ${link}`; break;
    case 'cancelled': body = `התור ${when} בוטל.\nלקביעת תור חדש: ${c.bookLink}`; break;
    case 'moved': body = `התור עודכן ל${when}.\n${link}`; break;
    case 'gap_open': body = `התפנה מקום ${c.gapWhen}. ${g(tone, 'רוצה', 'רוצה', 'מעוניינ/ת')} לתפוס? ${link}`; break;
    case 'move_offer': body = `אפשר להקדים את התור שלך ל־${est}? ${link}`; break;
    default: body = c.text || '';
  }
  return `*${biz.name}*\n${body}`;
}
module.exports = { compose };
