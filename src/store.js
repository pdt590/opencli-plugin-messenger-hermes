// ConversationStore: idempotency keys, processing status, per-conversation
// watermarks and leases. Backed by SQLite (node:sqlite). Message text is not
// stored; the conversation is re-read from the UI whenever context is needed.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const STATUS = Object.freeze({
  RECEIVED: 'received',
  QUEUED: 'queued',
  PROCESSING: 'processing',
  SENT: 'sent',
  FAILED: 'failed',
  SKIPPED: 'skipped',
  NEEDS_HUMAN: 'needs_human',
  SEND_UNKNOWN: 'send_unknown',
});

/** Terminal states never trigger another Hermes call or send attempt automatically. */
export const TERMINAL = new Set([STATUS.SENT, STATUS.FAILED, STATUS.SKIPPED, STATUS.NEEDS_HUMAN, STATUS.SEND_UNKNOWN]);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
  page_id TEXT NOT NULL,
  message_key TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  direction TEXT NOT NULL,
  message_ts INTEGER,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER,
  correlation_id TEXT,
  error_code TEXT,
  reason TEXT,
  reply_chars INTEGER,
  reply_message_id TEXT,
  duration_ms INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (page_id, message_key)
);
CREATE INDEX IF NOT EXISTS messages_conv ON messages(page_id, conversation_id);
CREATE INDEX IF NOT EXISTS messages_status ON messages(page_id, status);
CREATE TABLE IF NOT EXISTS conversations (
  page_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  watermark_ts INTEGER NOT NULL DEFAULT 0,
  lock_owner TEXT,
  lock_expires_at INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (page_id, conversation_id)
);
`;

export class ConversationStore {
  constructor(file, { now = () => Date.now() } = {}) {
    this.file = file;
    this.now = now;
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    this.db.exec(SCHEMA);
    if (file !== ':memory:') { try { fs.chmodSync(file, 0o600); } catch { /* best effort */ } }
  }

  static open(stateDir, opts) {
    return new ConversationStore(path.join(stateDir, 'state.db'), opts);
  }

  close() { this.db.close(); }

  getMessage(pageId, messageKey) {
    return this.db.prepare('SELECT * FROM messages WHERE page_id = ? AND message_key = ?').get(pageId, messageKey) || null;
  }

  /** Insert as `received` if unseen; never downgrades an existing record. Returns the stored row. */
  recordReceived(msg) {
    const t = this.now();
    this.db.prepare(`INSERT OR IGNORE INTO messages
      (page_id, message_key, conversation_id, direction, message_ts, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      msg.page_id, msg.message_key, msg.conversation_id, msg.direction, Date.parse(msg.timestamp) || null,
      STATUS.RECEIVED, t, t);
    return this.getMessage(msg.page_id, msg.message_key);
  }

  /** Update status and selected fields for a set of message keys of one page. */
  setStatus(pageId, messageKeys, status, fields = {}) {
    const allowed = ['attempts', 'next_attempt_at', 'correlation_id', 'error_code', 'reason', 'reply_chars', 'reply_message_id', 'duration_ms'];
    const sets = ['status = ?', 'updated_at = ?'];
    const values = [status, this.now()];
    for (const key of allowed) {
      if (fields[key] === undefined) continue;
      sets.push(`${key} = ?`);
      values.push(fields[key]);
    }
    const stmt = this.db.prepare(`UPDATE messages SET ${sets.join(', ')} WHERE page_id = ? AND message_key = ?`);
    for (const key of messageKeys) stmt.run(...values, pageId, key);
  }

  incrementAttempts(pageId, messageKeys) {
    const stmt = this.db.prepare('UPDATE messages SET attempts = attempts + 1, updated_at = ? WHERE page_id = ? AND message_key = ?');
    for (const key of messageKeys) stmt.run(this.now(), pageId, key);
    return Math.max(...messageKeys.map(k => this.getMessage(pageId, k)?.attempts || 0));
  }

  getWatermark(pageId, conversationId) {
    return this.db.prepare('SELECT watermark_ts FROM conversations WHERE page_id = ? AND conversation_id = ?')
      .get(pageId, conversationId)?.watermark_ts || 0;
  }

  setWatermark(pageId, conversationId, ts) {
    const t = this.now();
    this.db.prepare(`INSERT INTO conversations (page_id, conversation_id, watermark_ts, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(page_id, conversation_id) DO UPDATE SET watermark_ts = MAX(watermark_ts, excluded.watermark_ts), updated_at = excluded.updated_at`)
      .run(pageId, conversationId, ts || 0, t);
  }

  /** Lease-based lock: an expired lease (crashed worker) can be taken over. */
  acquireLock(pageId, conversationId, owner, leaseMs) {
    const t = this.now();
    this.db.prepare(`INSERT OR IGNORE INTO conversations (page_id, conversation_id, watermark_ts, updated_at) VALUES (?, ?, 0, ?)`)
      .run(pageId, conversationId, t);
    const result = this.db.prepare(`UPDATE conversations SET lock_owner = ?, lock_expires_at = ?, updated_at = ?
      WHERE page_id = ? AND conversation_id = ? AND (lock_owner IS NULL OR lock_owner = ? OR lock_expires_at < ?)`)
      .run(owner, t + leaseMs, t, pageId, conversationId, owner, t);
    return result.changes === 1;
  }

  releaseLock(pageId, conversationId, owner) {
    this.db.prepare(`UPDATE conversations SET lock_owner = NULL, lock_expires_at = NULL, updated_at = ?
      WHERE page_id = ? AND conversation_id = ? AND lock_owner = ?`).run(this.now(), pageId, conversationId, owner);
  }

  /** Conversations with non-terminal inbound work whose backoff has elapsed. */
  dueRetries(pageId) {
    return this.db.prepare(`SELECT DISTINCT conversation_id FROM messages WHERE page_id = ?
      AND status IN ('received', 'queued', 'processing') AND (next_attempt_at IS NULL OR next_attempt_at <= ?)`)
      .all(pageId, this.now()).map(r => r.conversation_id);
  }

  stats(pageId) {
    const rows = pageId
      ? this.db.prepare('SELECT status, COUNT(*) AS n FROM messages WHERE page_id = ? GROUP BY status').all(pageId)
      : this.db.prepare('SELECT status, COUNT(*) AS n FROM messages GROUP BY status').all();
    return Object.fromEntries(rows.map(r => [r.status, r.n]));
  }

  list({ pageId, conversationId, status, limit = 50 } = {}) {
    const where = [];
    const values = [];
    if (pageId) { where.push('page_id = ?'); values.push(pageId); }
    if (conversationId) { where.push('conversation_id = ?'); values.push(conversationId); }
    if (status) { where.push('status = ?'); values.push(status); }
    const sql = `SELECT * FROM messages ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY updated_at DESC LIMIT ?`;
    return this.db.prepare(sql).all(...values, limit);
  }

  /** Delete state by page/conversation and/or age. Returns the number of message rows removed. */
  purge({ pageId, conversationId, olderThanMs } = {}) {
    const where = [];
    const values = [];
    if (pageId) { where.push('page_id = ?'); values.push(pageId); }
    if (conversationId) { where.push('conversation_id = ?'); values.push(conversationId); }
    if (olderThanMs) { where.push('updated_at < ?'); values.push(this.now() - olderThanMs); }
    if (!where.length) throw new Error('Refusing to purge without a page, conversation or age filter');
    const removed = this.db.prepare(`DELETE FROM messages WHERE ${where.join(' AND ')}`).run(...values).changes;
    if (!olderThanMs) {
      const convWhere = where.filter(w => !w.startsWith('updated_at'));
      this.db.prepare(`DELETE FROM conversations WHERE ${convWhere.join(' AND ')}`).run(...values);
    }
    return removed;
  }
}
