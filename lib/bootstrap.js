'use strict';
// First deploy: create the first business from environment variables when the database is empty.
function bootstrap(eng, env) {
  const { BOOTSTRAP_SLUG: slug, BOOTSTRAP_NAME: name, OWNER_KEY: key } = env;
  if (!slug || !key || eng.d.businesses.length) return false;
  if (key.length < 12) { console.error('OWNER_KEY חייב להיות באורך 12 תווים לפחות'); return false; }
  const b = eng.createBusiness({ slug, name: name || slug, ownerKey: key });
  if (env.BOOTSTRAP_DEMO === '1') {
    eng.addService(b, { name: 'מילוי ג׳ל', duration: 75, buffer: 10, price: 180 });
    eng.addService(b, { name: 'לק ג׳ל', duration: 45, buffer: 10, price: 120, walkin: true });
  }
  eng.save();
  console.log(`נוצר עסק: /b/${slug}`);
  return true;
}
module.exports = { bootstrap };
