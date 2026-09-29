#!/usr/bin/env node
'use strict';
// Creates a new business (a new client) on a running Zrima site and applies its setup file.
//   node scripts/create-business.js https://<your-site> examples/daniela.json            create a new business
//   node scripts/create-business.js https://<your-site> examples/daniela.json --update   apply the file to an EXISTING business (same slug)
//   node scripts/create-business.js https://<your-site> examples/daniela.json --reset-key give an existing business a new owner key
// Needs the platform MASTER_KEY (set once with: npx wrangler secret put MASTER_KEY).
const fs = require('fs');
const readline = require('readline');
const crypto = require('crypto');

function ask(q, hidden) {
  return new Promise((res) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) rl._writeToOutput = (s) => { if (s.includes(q)) process.stdout.write(s); };
    rl.question(q, (a) => { rl.close(); if (hidden) process.stdout.write('\n'); res(a.trim()); });
  });
}

(async () => {
  const flags = process.argv.slice(2).filter((a) => a.startsWith('--')), [site, file] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  if (!site || !file) { console.error('שימוש: node scripts/create-business.js https://<אתר> examples/<קובץ>.json'); process.exit(1); }
  const setup = JSON.parse(fs.readFileSync(file, 'utf8'));
  const { slug, ...rest } = setup;
  const master = process.env.MASTER_KEY || (await ask('מפתח ניהול-על (MASTER_KEY): ', true));
  if (!/^[\x21-\x7e]+$/.test(master)) { console.error('המפתח מכיל אותיות בעברית או רווחים. החליפו את שפת המקלדת לאנגלית והקלידו שוב (אותיות אנגליות, מספרים וסימנים בלבד).'); process.exit(1); }
  const ownerKey = process.env.OWNER_KEY || crypto.randomBytes(12).toString('base64url'); // 16 chars
  const base = site.replace(/\/$/, '');
  const call = async (path, body) => {
    const r = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + master }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { console.error('נכשל:', r.status, j.error || ''); process.exit(1); }
    return j;
  };
  let j = {}, shownKey = ownerKey;
  if (flags.includes('--update') || flags.includes('--reset-key')) {
    if (!flags.includes('--reset-key')) shownKey = null;
    j = await call(`/api/admin/businesses/${slug}/setup`, rest);
    if (flags.includes('--reset-key')) await call(`/api/admin/businesses/${slug}/owner-key`, { ownerKey });
  } else j = await call('/api/admin/businesses', { slug, name: rest.name, ownerKey, setup: rest });
  console.log(`\n${flags.some((f) => f === '--update' || f === '--reset-key') ? 'העסק עודכן' : 'העסק נוצר'} ✓  (${j.services.total} שירותים)\n`);
  console.log(`  עמוד הזמנה ללקוחות:  ${base}/b/${slug}`);
  console.log(`  לוח חי:              ${base}/live/${slug}`);
  console.log(`  כניסה לניהול:        ${base}/admin`);
  if (shownKey) { console.log(`  מפתח בעלים:          ${shownKey}`); console.log('\nשמרו את מפתח הבעלים ומסרו אותו לבעלת העסק. הוא לא יוצג שוב.'); }
  else console.log('\n(מפתח הבעלים לא שונה)');
})();
