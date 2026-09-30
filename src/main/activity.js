'use strict';
// In-memory feed behind the Bigfoot Terminal, mirrored to logs/activity.log.

const MAX_ENTRIES = 3000;
const MAX_TEXT = 20000;

class ActivityLog {
  constructor(logger) {
    this.logger = logger;
    this.entries = [];
    this.listeners = new Set();
  }

  add(kind, text) {
    let body = String(text == null ? '' : text);
    if (body.length > MAX_TEXT) body = `${body.slice(0, MAX_TEXT)}\n… (truncated)`;
    const entry = { ts: Date.now(), kind, text: body };
    this.entries.push(entry);
    if (this.entries.length > MAX_ENTRIES) this.entries.splice(0, this.entries.length - MAX_ENTRIES);
    this.logger.activity(entry);
    for (const fn of this.listeners) fn(entry);
  }

  clear() { this.entries.length = 0; }
  onEntry(fn) { this.listeners.add(fn); }
}

module.exports = { ActivityLog };
