// Structured JSON-lines logger. By default it records identifiers, stages,
// statuses, durations and error codes only. Message text is written only when
// MESSENGER_HERMES_LOG_CONTENT is enabled on purpose.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const CONTENT_FIELDS = new Set(['text', 'reply', 'prompt', 'stdout', 'stderr']);
const SECRET_PATTERN = /(c_user|xs|fr|datr|sb)=[^;\s]+|access_token=[^&\s]+|EAA[A-Za-z0-9]{20,}/g;

export function newCorrelationId() {
  return crypto.randomUUID();
}

export function redact(value) {
  return typeof value === 'string' ? value.replace(SECRET_PATTERN, '[redacted]') : value;
}

export class Logger {
  constructor({ dir, logContent = false, stderr = false, now = () => new Date() } = {}) {
    this.dir = dir;
    this.logContent = logContent;
    this.stderr = stderr;
    this.now = now;
    if (dir) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  log(level, event, fields = {}) {
    const ts = this.now();
    const record = { ts: ts.toISOString(), level, event };
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined) continue;
      if (CONTENT_FIELDS.has(key) && !this.logContent) {
        record[`${key}_chars`] = typeof value === 'string' ? value.length : undefined;
        continue;
      }
      record[key] = redact(value);
    }
    const line = `${JSON.stringify(record)}\n`;
    if (this.dir) {
      const file = path.join(this.dir, `messenger-hermes-${record.ts.slice(0, 10)}.jsonl`);
      try { fs.appendFileSync(file, line, { mode: 0o600 }); } catch { /* logging must never break processing */ }
    }
    if (this.stderr) process.stderr.write(line);
    return record;
  }

  info(event, fields) { return this.log('info', event, fields); }
  warn(event, fields) { return this.log('warn', event, fields); }
  error(event, fields) { return this.log('error', event, fields); }
}

export const nullLogger = { info() {}, warn() {}, error() {}, log() {} };
