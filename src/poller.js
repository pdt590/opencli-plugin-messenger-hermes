// InboxPoller: one poll cycle. Lists conversations, picks those with activity
// newer than their watermark (or with a retry that is due) and processes them
// one at a time. Conversations are sequential because they share one browser
// tab; order inside a conversation is preserved by processing the whole
// unanswered tail as one turn.
import { BLOCKING_UI_CODES } from './errors.js';
import { nullLogger } from './logger.js';
import { threadEligibility } from './messages.js';
import { processConversation } from './processor.js';

export async function pollOnce(deps, { send = false, limit, owner } = {}) {
  const { client, store, config } = deps;
  const logger = deps.logger || nullLogger;
  const now = deps.now || (() => Date.now());
  const started = now();
  const threads = await client.listConversations({ limit: 50 });
  const pageId = client.pageId;
  const due = new Set(send ? store.dueRetries(pageId) : []);
  const max = limit || config.maxConversationsPerPoll;
  const rows = [];
  const candidates = [];

  for (const t of threads) {
    const ineligible = threadEligibility(t, config, now());
    if (ineligible) continue;
    const watermark = store.getWatermark(pageId, t.conversation_id);
    if (t.last_activity_ms > watermark || due.has(t.conversation_id)) candidates.push(t);
  }
  // Oldest activity first, so nobody waits behind a busy conversation forever.
  candidates.sort((a, b) => a.last_activity_ms - b.last_activity_ms);

  for (const t of candidates.slice(0, max)) {
    try {
      const row = await processConversation(deps, { conversationId: t.conversation_id, send, owner });
      rows.push({ title: t.title, ...row });
    } catch (error) {
      logger.error('conversation_failed', { page_id: pageId, conversation_id: t.conversation_id, stage: 'poll', error_code: error.code || 'error' });
      rows.push({ title: t.title, conversation_id: t.conversation_id, status: 'error', error_code: error.code || 'error', detail: error.message });
      // Logged out / checkpoint / wrong Page: stop the whole cycle, do not touch other conversations.
      if (BLOCKING_UI_CODES.has(error.code)) break;
    }
  }
  logger.info('poll_done', {
    page_id: pageId, stage: 'poll', status: 'done', duration_ms: now() - started,
    conversations: threads.length, candidates: candidates.length, processed: rows.length,
    sent: rows.filter(r => r.status === 'sent').length,
  });
  return { threads, candidates, rows };
}
