'use strict';
// Creates a demo business. Usage: node seed.js  (owner key printed at the end)
const path = require('path');
const { DB } = require('./lib/db');
const { Engine } = require('./lib/engine');
const db = new DB(process.env.DB_FILE || path.join(__dirname, 'data', 'db.json'));
const eng = new Engine(db);
const slug = process.env.SLUG || 'demo', key = process.env.OWNER_KEY || 'demo-owner-key';
if (db.d.businesses.some((b) => b.slug === slug)) { console.log(`העסק ${slug} כבר קיים`); process.exit(0); }
const b = eng.createBusiness({ slug, name: 'סטודיו נועה', ownerKey: key });
b.tagline = 'ציפורניים ג׳ל · בניה · לק';
b.contact = { address: 'הרצל 12, תל אביב', whatsapp: '972501234567', instagram: 'noa.nails', phone: '0501234567', showPhonePublic: true };
b.brand = { primary: '#be185d', secondary: '#fce7f3', bg: '#fff7fb', font: 'Heebo', logo: '', cover: '', tone: 'female' };
eng.addService(b, { name: 'מילוי ג׳ל', publicLabel: 'מילוי ג׳ל', duration: 75, buffer: 10, price: 180 });
eng.addService(b, { name: 'לק ג׳ל', publicLabel: 'לק ג׳ל', duration: 45, buffer: 10, price: 120, walkin: true });
eng.addService(b, { name: 'הסרה', publicLabel: 'הסרה', duration: 20, buffer: 5, price: 50, walkin: true });
db.flush();
console.log(`נוצר עסק דמו.\n  עמוד הזמנה:  /b/${slug}\n  לוח חי:      /live/${slug}\n  ניהול:       /admin   (מפתח בעלים: ${key})`);
