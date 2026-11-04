// Processes one conversation: read -> filter/dedupe -> Hermes -> send -> verify.
// The client is any object implementing the MessengerWebClient interface
// (readMessages, sendTextReply), which lets tests use a fake client.
import crypto from 'node:crypto';
import { newCorrelationId, nullLogger } from './logger.js';
import { selectPending } from './messages.js';
import { buildPrompt, loadInstructions } from './prompt.js';
import { STATUS } from './store.js';
import { hermesSessionName } from './config.js';
import { BLOCKING_UI_CODES } from './errors.js';

const LOCK_LEASE_MS = 10 * 60_000;

export function backoffMs(attempt, baseMs, random = Math.random) {
  const exp = baseMs * 2 ** Math.max(0, attempt - 1);
  return Math.round(Math.min(exp, 60 * 60_000) * (0.75 + random() * 0.5));
}

/**
 * @param {object} deps { client, store, hermes, config, logger, now }
 * @param {object} opts { conversationId, messageKey?, send: boolean, owner? }
 * @returns {object} one result row
 */
export async function processConversation(deps, opts) {
  const { client, store, hermes, config } = deps;
  const logger = deps.logger || nullLogger;
  const now = deps.now || (() => Date.now());
  const persist = opts.send === true;
  const owner = opts.owner || `proc-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
  const conversationId = String(opts.conversationId);
  const correlationId = newCorrelationId();
  const started = now();
  const base = { conversation_id: conversationId, correlation_id: correlationId, mode: persist ? 'live' : 'dry-run' };
  const log = (level, event, fields = {}) => logger[level](event, { correlation_id: correlationId, page_id: client.pageId, conversation_id: conversationId, ...fields });

  // Lock key needs the page id; resolve it before taking the lease.
  if (typeof client.resolvePage === 'function') await client.resolvePage();
  const pageId = client.pageId;
  if (persist && !store.acquireLock(pageId, conversationId, owner, LOCK_LEASE_MS)) {
    log('info', 'conversation_locked', { stage: 'lock', status: 'locked' });
    return { ...base, status: 'locked', detail: 'Another worker holds this conversation' };
  }

  let pendingKeys = [];
  try {
    // 1. Read the conversation from the UI.
    let thread;
    try {
      thread = await client.readMessages(conversationId);
    } catch (error) {
      log('error', 'read_failed', { stage: 'read', status: 'error', error_code: error.code || 'read_failed' });
      throw error;
    }
    const messages = thread.messages;
    const latestTs = Math.max(0, ...messages.map(m => Date.parse(m.timestamp || '') || 0));

    // 2. Filter, dedupe and select what still needs an answer.
    const sel = selectPending(messages, { config, store, nowMs: now() });
    if (persist) {
      for (const { message, reason } of sel.skipped) {
        const row = store.recordReceived(message);
        if (row.status === STATUS.RECEIVED) store.setStatus(pageId, [message.message_key], STATUS.SKIPPED, { reason });
      }
    }
    const ambiguous = messages.slice(messages.indexOf(sel.lastOutbound) + 1).some(m => m.direction === 'unknown');
    let pending = sel.pending;
    if (opts.messageKey) {
      if (!pending.some(p => p.message.message_key === opts.messageKey)) {
        if (persist) store.setWatermark(pageId, conversationId, latestTs);
        const stored = store.getMessage(pageId, opts.messageKey);
        return { ...base, status: 'not_pending', message_key: opts.messageKey, detail: stored ? `Already ${stored.status}` : 'Message is not an unanswered inbound text message in this conversation' };
      }
    }
    if (!pending.length) {
      if (persist) store.setWatermark(pageId, conversationId, latestTs);
      log('info', 'nothing_pending', { stage: 'filter', status: 'idle', skipped: sel.skipped.length });
      return { ...base, status: 'idle', detail: sel.skipped.length ? `skipped: ${[...new Set(sel.skipped.map(s => s.reason))].join(',')}` : 'No unanswered inbound messages' };
    }
    pendingKeys = pending.map(p => p.message.message_key);
    const newest = pending[pending.length - 1].message;
    const last = messages[messages.length - 1];

    if (persist) for (const p of pending) store.recordReceived(p.message);

    if (ambiguous) {
      if (persist) store.setStatus(pageId, pendingKeys, STATUS.NEEDS_HUMAN, { correlation_id: correlationId, reason: 'ambiguous_direction' });
      log('warn', 'ambiguous_direction', { stage: 'filter', status: STATUS.NEEDS_HUMAN });
      return { ...base, status: STATUS.NEEDS_HUMAN, message_key: newest.message_key, detail: 'Could not tell inbound from outbound safely' };
    }

    // Respect retry backoff of an earlier failed attempt.
    const storedNewest = persist ? store.getMessage(pageId, newest.message_key) : null;
    if (storedNewest?.next_attempt_at && storedNewest.next_attempt_at > now()) {
      return { ...base, status: 'backoff', message_key: newest.message_key, detail: `Next attempt at ${new Date(storedNewest.next_attempt_at).toISOString()}` };
    }

    // 3. Hermes.
    let attempt = 1;
    if (persist) {
      store.setStatus(pageId, pendingKeys, STATUS.QUEUED, { correlation_id: correlationId });
      attempt = store.incrementAttempts(pageId, pendingKeys);
      store.setStatus(pageId, pendingKeys, STATUS.PROCESSING, { correlation_id: correlationId });
    }
    const prompt = buildPrompt({
      instructions: loadInstructions(config),
      pageName: thread.page_name || config.pageName,
      history: sel.history,
      pending: pending.map(p => p.message),
      maxReplyLength: config.maxReplyLength,
      historyMessages: config.historyMessages,
      maxContextChars: config.maxContextChars,
    });
    // Dry-run stays one-shot so replies that were never sent do not enter the session.
    const session = persist ? hermesSessionName(config, conversationId) : null;
    base.hermes_session = session || 'oneshot';
    log('info', 'hermes_start', { stage: 'hermes', status: STATUS.PROCESSING, attempt, message_key: newest.message_key, pending: pendingKeys.length, hermes_session: base.hermes_session, prompt });
    // While Hermes thinks, show the customer that the Page is typing (live runs only).
    let typing = null;
    if (persist && config.typingIndicator && typeof client.startTypingIndicator === 'function') {
      typing = await client.startTypingIndicator().catch((error) => {
        log('warn', 'typing_indicator_failed', { stage: 'hermes', error_code: error.code || 'typing_indicator' });
        return null;
      });
    }
    let result;
    let hermesError = null;
    try {
      result = await hermes.generate(prompt, { session });
    } catch (error) {
      hermesError = error;
    } finally {
      if (typing) {
        try {
          const t = await typing.stop();
          base.typing_indicator_ticks = t.ticks;
        } catch (error) {
          log('warn', 'typing_indicator_stop_failed', { stage: 'hermes', error_code: error.code || 'typing_indicator' });
        }
      }
    }
    if (hermesError) {
      const error = hermesError;
      const retry = error.transient && attempt < config.hermesMaxAttempts;
      if (persist) {
        store.setStatus(pageId, pendingKeys, retry ? STATUS.QUEUED : STATUS.FAILED, {
          error_code: error.code || 'hermes_error',
          next_attempt_at: retry ? now() + backoffMs(attempt, config.retryBaseMs) : null,
          duration_ms: error.durationMs ?? null,
        });
      }
      log('error', 'hermes_failed', { stage: 'hermes', status: retry ? STATUS.QUEUED : STATUS.FAILED, attempt, error_code: error.code, duration_ms: error.durationMs, detail: error.message });
      return { ...base, status: retry ? 'retry_scheduled' : STATUS.FAILED, message_key: newest.message_key, attempt, error_code: error.code, detail: error.message };
    }
    if (result.hermesSessionId) base.hermes_session_id = result.hermesSessionId;
    log('info', 'hermes_done', { stage: 'hermes', status: 'ok', attempt, duration_ms: result.durationMs, handoff: result.handoff, hermes_session_id: result.hermesSessionId, session_resumed: result.sessionResumed, session_reset: result.sessionReset, reply: result.reply || '' });

    if (result.handoff || !result.reply) {
      if (persist) store.setStatus(pageId, pendingKeys, STATUS.NEEDS_HUMAN, { reason: 'hermes_handoff', duration_ms: result.durationMs });
      if (persist) store.setWatermark(pageId, conversationId, latestTs);
      return { ...base, status: STATUS.NEEDS_HUMAN, message_key: newest.message_key, detail: 'Hermes requested a human handoff', hermes_ms: result.durationMs };
    }

    // 4. Send (or type-and-clear in dry-run) through the UI.
    let sent;
    try {
      sent = await client.sendTextReply(conversationId, result.reply, {
        expectedLastMessageKey: last.message_key,
        dryRun: !persist,
        navigate: false,
      });
    } catch (error) {
      if (error.sendMayHaveHappened) {
        if (persist) store.setStatus(pageId, pendingKeys, STATUS.SEND_UNKNOWN, { error_code: error.code, reply_chars: result.reply.length });
        log('error', 'send_unverified', { stage: 'send', status: STATUS.SEND_UNKNOWN, error_code: error.code });
        return { ...base, status: STATUS.SEND_UNKNOWN, message_key: newest.message_key, error_code: error.code, detail: error.message, reply: result.reply };
      }
      // Nothing was submitted on any of these paths, so a later retry is safe.
      let status;
      let nextAttemptAt = null;
      if (error.code === 'conversation_changed') {
        status = STATUS.QUEUED; // re-read with the newer messages on the next poll
      } else if (error.code === 'composer_not_empty') {
        status = STATUS.NEEDS_HUMAN;
      } else if (BLOCKING_UI_CODES.has(error.code) || (error.transient && attempt < config.hermesMaxAttempts)) {
        status = STATUS.QUEUED;
        nextAttemptAt = now() + backoffMs(attempt, config.retryBaseMs);
      } else {
        status = STATUS.FAILED;
      }
      if (persist) store.setStatus(pageId, pendingKeys, status, { error_code: error.code || 'send_failed', next_attempt_at: nextAttemptAt });
      log('error', 'send_failed', { stage: 'send', status, error_code: error.code });
      if (BLOCKING_UI_CODES.has(error.code)) throw error;
      return { ...base, status: status === STATUS.QUEUED ? 'retry_scheduled' : status, message_key: newest.message_key, error_code: error.code, detail: error.message };
    }

    const durationMs = now() - started;
    if (!persist) {
      log('info', 'dry_run_done', { stage: 'send', status: 'dry_run', duration_ms: durationMs });
      return { ...base, status: 'dry_run', message_key: newest.message_key, pending: pendingKeys.length, reply: result.reply, composer_verified: !!sent.composer_verified, hermes_ms: result.durationMs, duration_ms: durationMs };
    }
    store.setStatus(pageId, pendingKeys, STATUS.SENT, { reply_chars: result.reply.length, reply_message_id: sent.message_id, duration_ms: durationMs, error_code: null, next_attempt_at: null });
    store.setWatermark(pageId, conversationId, Math.max(latestTs, Date.parse(sent.timestamp || '') || 0));
    log('info', 'reply_sent', { stage: 'complete', status: STATUS.SENT, duration_ms: durationMs, message_key: newest.message_key, reply_message_id: sent.message_id, typing: sent.typing, typing_steps: sent.typing_steps, typing_ms: sent.typing_ms, typing_indicator_ticks: base.typing_indicator_ticks, reply: result.reply });
    return { ...base, status: STATUS.SENT, message_key: newest.message_key, pending: pendingKeys.length, reply: result.reply, reply_message_id: sent.message_id, hermes_ms: result.durationMs, duration_ms: durationMs };
  } finally {
    if (persist) store.releaseLock(pageId, conversationId, owner);
  }
}
