'use strict';
const fs = require('fs');
const path = require('path');
class DB {
  constructor(file) {
    this.file = file;
    this.d = { businesses: [], customers: [], appointments: [], blocks: [], waitlist: [], messages: [], dismissed: [] };
    if (file && fs.existsSync(file)) Object.assign(this.d, JSON.parse(fs.readFileSync(file, 'utf8')));
    this.t = null;
  }
  save() { if (!this.file) return; clearTimeout(this.t); this.t = setTimeout(() => this.flush(), 60); }
  flush() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.d));
    fs.renameSync(tmp, this.file);
  }
}
module.exports = { DB };
