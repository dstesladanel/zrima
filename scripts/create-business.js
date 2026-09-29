#!/usr/bin/env node
'use strict';
// Creates a new business (a new client) on a running Zrima site and applies its setup file.
//   node scripts/create-business.js https://<your-site> examples/daniela.json
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
  const [site, file] = process.argv.slice(2);
  if (!site || !file) { console.error('שימוש: node scripts/create-business.js https://<אתר> examples/<קובץ>.json'); process.exit(1); }
  const setup = JSON.parse(fs.readFileSync(file, 'utf8'));
  const { slug, ...rest } = setup;
  const master = process.env.MASTER_KEY || (await ask('מפתח ניהול-על (MASTER_KEY): ', true));
  const ownerKey = process.env.OWNER_KEY || crypto.randomBytes(12).toString('base64url'); // 16 chars
  const r = await fetch(site.replace(/\/$/, '') + '/api/admin/businesses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + master },
    body: JSON.stringify({ slug, name: rest.name, ownerKey, setup: rest }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { console.error('נכשל:', r.status, j.error || ''); process.exit(1); }
  const base = site.replace(/\/$/, '');
  console.log(`\nהעסק נוצר ✓  (${j.services.total} שירותים)\n`);
  console.log(`  עמוד הזמנה ללקוחות:  ${base}/b/${slug}`);
  console.log(`  לוח חי:              ${base}/live/${slug}`);
  console.log(`  כניסה לניהול:        ${base}/admin`);
  console.log(`  מפתח בעלים:          ${ownerKey}`);
  console.log('\nשמרו את מפתח הבעלים ומסרו אותו לבעלת העסק. הוא לא יוצג שוב.');
})();
