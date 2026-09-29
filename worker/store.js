// Persistent store for a Cloudflare Durable Object (SQLite-backed).
// The engine works on plain in-memory arrays (store.d); this class loads them on wake-up
// and writes back only the documents that changed.
const COLLS = ['businesses', 'customers', 'appointments', 'blocks', 'waitlist', 'messages'];

export class SqlStore {
  constructor(sql) {
    this.sql = sql;
    sql.exec('CREATE TABLE IF NOT EXISTS docs (coll TEXT NOT NULL, id TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY (coll, id))');
    this.d = { businesses: [], customers: [], appointments: [], blocks: [], waitlist: [], messages: [], dismissed: [] };
    this.meta = {};
    this.snap = new Map();
    this.dirty = false;
    this.timer = null;
    for (const row of sql.exec('SELECT coll, id, json FROM docs').toArray()) {
      const v = JSON.parse(row.json);
      this.snap.set(`${row.coll}/${row.id}`, row.json);
      if (row.coll === 'meta') this.meta = v;
      else if (row.coll === 'dismissed') this.d.dismissed = v;
      else if (this.d[row.coll]) this.d[row.coll].push(v);
    }
  }
  save() {
    this.dirty = true;
    if (!this.timer) this.timer = setTimeout(() => { this.timer = null; this.flush(); }, 0); // covers async callbacks
  }
  flush() {
    if (!this.dirty) return;
    this.dirty = false;
    const seen = new Set();
    const put = (coll, id, obj) => {
      const key = `${coll}/${id}`, j = JSON.stringify(obj);
      seen.add(key);
      if (this.snap.get(key) !== j) {
        this.sql.exec('INSERT INTO docs (coll, id, json) VALUES (?, ?, ?) ON CONFLICT (coll, id) DO UPDATE SET json = excluded.json', coll, id, j);
        this.snap.set(key, j);
      }
    };
    for (const c of COLLS) for (const doc of this.d[c]) put(c, doc.id, doc);
    put('dismissed', 'all', this.d.dismissed);
    put('meta', 'meta', this.meta);
    for (const key of [...this.snap.keys()]) {
      if (seen.has(key)) continue;
      const i = key.indexOf('/');
      this.sql.exec('DELETE FROM docs WHERE coll = ? AND id = ?', key.slice(0, i), key.slice(i + 1));
      this.snap.delete(key);
    }
  }
}
