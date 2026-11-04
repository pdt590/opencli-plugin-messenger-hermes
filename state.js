import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError } from '@jackwener/opencli/errors';
import { SITE, withDeps } from './src/cli-common.js';

export async function state(kwargs = {}) {
  const action = kwargs.action || 'stats';
  return withDeps(null, async ({ store, config }) => {
    const pageId = kwargs.page ? String(kwargs.page) : (config.pageId || undefined);
    if (action === 'stats') {
      return Object.entries(store.stats(pageId)).map(([status, count]) => ({ page_id: pageId || '(all)', status, count }));
    }
    if (action === 'list') {
      return store.list({ pageId, conversationId: kwargs.conversation, status: kwargs.status, limit: Number(kwargs.limit) || 50 })
        .map(r => ({
          conversation_id: r.conversation_id, message_key: r.message_key, status: r.status, attempts: r.attempts,
          error_code: r.error_code || '', reason: r.reason || '', reply_message_id: r.reply_message_id || '',
          updated_at: new Date(r.updated_at).toISOString(),
        }));
    }
    if (action === 'purge') {
      const olderThanMs = kwargs['older-than-days'] ? Number(kwargs['older-than-days']) * 86_400_000 : undefined;
      if (!kwargs.conversation && !olderThanMs && !kwargs.page) {
        throw new ArgumentError('purge needs --conversation, --page or --older-than-days');
      }
      const removed = store.purge({ pageId: kwargs.page, conversationId: kwargs.conversation, olderThanMs });
      return [{ action: 'purge', removed }];
    }
    if (action === 'retry') {
      if (!kwargs.conversation) throw new ArgumentError('retry needs --conversation');
      const rows = store.list({ pageId, conversationId: kwargs.conversation, limit: 500 })
        .filter(r => ['failed', 'needs_human', 'send_unknown'].includes(r.status) && (!kwargs.status || r.status === kwargs.status));
      store.setStatus(rows[0]?.page_id, rows.map(r => r.message_key), 'received', { attempts: 0, next_attempt_at: null, error_code: null });
      return [{ action: 'retry', requeued: rows.length }];
    }
    throw new ArgumentError('--action must be stats, list, purge or retry');
  }, { needPage: false });
}

cli({
  site: SITE, name: 'state', access: 'write',
  description: 'Inspect or clean the local processing state (no browser): stats, list, purge, retry',
  example: 'opencli messenger-hermes state --action list --status failed',
  strategy: Strategy.LOCAL, browser: false,
  args: [
    { name: 'action', type: 'string', default: 'stats', choices: ['stats', 'list', 'purge', 'retry'], help: 'stats | list | purge | retry' },
    { name: 'page', type: 'string', help: 'Page id filter (default MESSENGER_PAGE_ID)' },
    { name: 'conversation', type: 'string', help: 'Conversation id filter' },
    { name: 'status', type: 'string', help: 'Status filter for list/retry' },
    { name: 'older-than-days', type: 'int', help: 'purge: rows not updated for this many days' },
    { name: 'limit', type: 'int', default: 50, help: 'list: max rows' },
  ],
  func: state,
});
