'use strict';
// App log, the Bigfoot Terminal activity log, and a JSONL audit trail. Each rotates at 5 MB.

const fs = require('fs');
const path = require('path');

const MAX_BYTES = 5 * 1024 * 1024;

class Logger {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    this.appLog = path.join(dir, 'app.log');
    this.auditLog = path.join(dir, 'audit.jsonl');
    this.activityLog = path.join(dir, 'activity.log');
  }

  write(file, line) {
    try {
      try {
        if (fs.statSync(file).size > MAX_BYTES) fs.renameSync(file, file + '.1');
      } catch { /* missing file */ }
      fs.appendFileSync(file, line + '\n');
    } catch (err) {
      console.error('log write failed', err.message);
    }
  }

  line(level, parts) {
    const text = parts.map((p) => (typeof p === 'string' ? p : p instanceof Error ? p.stack : JSON.stringify(p))).join(' ');
    this.write(this.appLog, `${new Date().toISOString()} ${level} ${text}`);
    (level === 'ERROR' ? console.error : console.log)(`[${level}]`, text);
  }

  info(...parts) { this.line('INFO', parts); }
  error(...parts) { this.line('ERROR', parts); }

  activity({ ts, kind, text }) {
    const stamp = new Date(ts).toISOString();
    const body = String(text).replace(/\r?\n/g, '\n' + ' '.repeat(stamp.length + 10));
    this.write(this.activityLog, `${stamp}  ${kind.padEnd(7)} ${body}`);
  }

  audit(event, data) { this.write(this.auditLog, JSON.stringify({ ts: new Date().toISOString(), event, ...data })); }
}

module.exports = { Logger };
