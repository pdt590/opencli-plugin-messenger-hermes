// MessageNormalizer + MessageFilter: map raw Business Suite UI data to the
// internal contract and decide which inbound messages need a reply.
import crypto from 'node:crypto';
import { STATUS, TERMINAL } from './store.js';

export function normalizeText(text) {
  return String(text ?? '')
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .split('\n').map(line => line.replace(/[ \t ]+/g, ' ').trim()).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Comparison form for verifying that what appears in the UI equals what we sent. */
export function comparableText(text) {
  return normalizeText(text).replace(/\s+/g, ' ').toLowerCase();
}

export function fingerprint(parts) {
  return `fp:${crypto.createHash('sha256').update(parts.map(p => String(p ?? '')).join('␟')).digest('hex').slice(0, 32)}`;
}

/**
 * Raw message (from the DOM/React props) -> internal contract.
 * Identifiers are opaque strings. Direction is decided by the UI's own
 * `isFromViewer` flag and cross-checked against the sender id.
 */
export function normalizeMessage(raw, { pageId, conversationId }) {
  const text = raw.text == null ? '' : normalizeText(raw.text);
  const ts = Number(raw.timestamp);
  const timestamp = Number.isFinite(ts) && ts > 0 ? new Date(ts).toISOString() : null;
  let direction;
  if (raw.from_viewer === true || (raw.sender_id && raw.sender_id === pageId)) direction = 'outbound';
  else if (raw.from_viewer === false) direction = 'inbound';
  else direction = 'unknown';
  const messageKey = raw.id
    ? String(raw.id)
    : fingerprint([pageId, conversationId, direction, text, timestamp]);
  let type = 'text';
  if (raw.is_log) type = 'system';
  else if (raw.is_template) type = 'template';
  else if (raw.attachments > 0 && !text) type = 'attachment';
  else if (raw.attachments > 0) type = 'text+attachment';
  else if (!text) type = 'empty';
  return {
    page_id: String(pageId),
    conversation_id: String(conversationId),
    sender_id: raw.sender_id ? String(raw.sender_id) : null,
    message_key: messageKey,
    message_id: raw.id ? String(raw.id) : null,
    text,
    timestamp,
    direction,
    type,
  };
}

export function normalizeThread(raw, { pageId }) {
  const ts = Number(raw.timestamp);
  return {
    page_id: String(pageId),
    conversation_id: String(raw.threadFBID),
    thread_id: raw.threadID ? String(raw.threadID) : null,
    title: raw.title ? String(raw.title) : '',
    snippet: raw.snippetText ? normalizeText(raw.snippetText) : '',
    unread: raw.isRead === false,
    is_group: raw.isGroupThread === true,
    platform: raw.commPlatform || null,
    thread_type: raw.threadType || null,
    last_activity_ms: Number.isFinite(ts) ? ts : 0,
    last_activity: Number.isFinite(ts) && ts > 0 ? new Date(ts).toISOString() : null,
  };
}

/** Is this thread eligible for automatic processing at all? */
export function threadEligibility(thread, config, nowMs = Date.now()) {
  if (thread.is_group) return 'group_thread';
  if (thread.platform && thread.platform !== 'MESSENGER') return 'not_messenger';
  if (config.allowedSenderIds.length && !config.allowedSenderIds.includes(thread.conversation_id)) return 'not_allowlisted';
  if (thread.last_activity_ms && nowMs - thread.last_activity_ms > config.maxMessageAgeMin * 60_000) return 'too_old';
  return null;
}

/**
 * Select the inbound messages that still need a reply: those after the last
 * outbound (Page) message, that pass the filters, and that are not in a
 * terminal state. Returns { pending, skipped, history, lastMessageKey }.
 */
export function selectPending(messages, { config, store, nowMs = Date.now() }) {
  const ordered = [...messages];
  let lastOutbound = -1;
  ordered.forEach((m, i) => { if (m.direction === 'outbound') lastOutbound = i; });
  const tail = ordered.slice(lastOutbound + 1);
  const pending = [];
  const skipped = [];
  for (const m of tail) {
    const reason = skipReason(m, config, nowMs);
    const stored = store?.getMessage(m.page_id, m.message_key);
    if (stored && TERMINAL.has(stored.status)) continue;
    if (reason) { skipped.push({ message: m, reason }); continue; }
    pending.push({ message: m, stored });
  }
  const firstPending = pending.length ? ordered.indexOf(pending[0].message) : ordered.length;
  const history = ordered.slice(0, firstPending).filter(m => m.text && (m.type === 'text' || m.type === 'text+attachment'));
  return {
    pending,
    skipped,
    history,
    lastMessage: ordered[ordered.length - 1] || null,
    lastOutbound: lastOutbound >= 0 ? ordered[lastOutbound] : null,
  };
}

export function skipReason(m, config, nowMs = Date.now()) {
  if (m.direction !== 'inbound') return m.direction === 'unknown' ? 'unknown_direction' : 'outbound';
  if (m.sender_id && m.sender_id === m.page_id) return 'outbound';
  if (m.type !== 'text' && m.type !== 'text+attachment') return `unsupported_${m.type}`;
  if (!m.text) return 'empty';
  if (config.allowedSenderIds.length && !config.allowedSenderIds.includes(m.sender_id || m.conversation_id)) return 'not_allowlisted';
  const ts = Date.parse(m.timestamp || '');
  if (!Number.isFinite(ts)) return 'no_timestamp';
  if (nowMs - ts > config.maxMessageAgeMin * 60_000) return 'too_old';
  return null;
}

export { STATUS };
