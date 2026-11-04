import { cli, Strategy } from '@jackwener/opencli/registry';
import { threadEligibility } from './src/messages.js';
import { DOMAIN, SITE, truncate, withDeps, PAGE_ARGS } from './src/cli-common.js';

export async function inbox(page, kwargs = {}) {
  return withDeps(page, async ({ client, store, config }) => {
    const threads = await client.listConversations({ limit: Number(kwargs.limit) || 20 });
    return threads
      .filter(t => !kwargs.unread || t.unread)
      .map(t => {
        const watermark = store.getWatermark(client.pageId, t.conversation_id);
        return {
          conversation_id: t.conversation_id,
          title: t.title,
          snippet: truncate(t.snippet, 60),
          unread: t.unread,
          last_activity: t.last_activity,
          new_since_watermark: t.last_activity_ms > watermark,
          auto_reply: threadEligibility(t, config) || 'eligible',
        };
      });
  }, { kwargs });
}

cli({
  site: SITE, name: 'inbox', access: 'read',
  description: 'List Messenger conversations of the configured Page (Meta Business Suite inbox)',
  example: 'opencli messenger-hermes inbox --limit 20',
  domain: DOMAIN, strategy: Strategy.UI, browser: true, navigateBefore: false, // ephemeral tab: never disturbs a running poll
  args: [
    { name: 'limit', type: 'int', default: 20, help: 'Maximum conversations to list' },
    { name: 'unread', type: 'boolean', default: false, help: 'Only unread conversations' },
    ...PAGE_ARGS,
  ],
  columns: ['conversation_id', 'title', 'snippet', 'unread', 'last_activity', 'new_since_watermark', 'auto_reply'],
  func: inbox,
});
