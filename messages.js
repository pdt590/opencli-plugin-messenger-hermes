import { cli, Strategy } from '@jackwener/opencli/registry';
import { DOMAIN, SITE, requireConversationId, truncate, withDeps, PAGE_ARGS } from './src/cli-common.js';

export async function messages(page, kwargs = {}) {
  const conversationId = requireConversationId(kwargs);
  return withDeps(page, async ({ client, store }) => {
    const thread = await client.readMessages(conversationId);
    const limit = Number(kwargs.limit) || 20;
    return thread.messages.slice(-limit).map(m => ({
      message_key: m.message_key,
      direction: m.direction,
      type: m.type,
      sender_id: m.sender_id,
      timestamp: m.timestamp,
      text: kwargs.full ? m.text : truncate(m.text, 100),
      state: store.getMessage(m.page_id, m.message_key)?.status || '',
    }));
  }, { kwargs });
}

cli({
  site: SITE, name: 'messages', access: 'read',
  description: 'Read the latest messages of one conversation, normalized (direction, ids, timestamps)',
  example: 'opencli messenger-hermes messages --conversation 1820968286',
  domain: DOMAIN, strategy: Strategy.UI, browser: true, navigateBefore: false, // ephemeral tab: never disturbs a running poll
  args: [
    { name: 'conversation', type: 'string', required: true, help: 'Conversation id from `inbox`' },
    { name: 'limit', type: 'int', default: 20, help: 'Number of most recent messages' },
    { name: 'full', type: 'boolean', default: false, help: 'Do not truncate message text' },
    ...PAGE_ARGS,
  ],
  columns: ['message_key', 'direction', 'type', 'sender_id', 'timestamp', 'text', 'state'],
  func: messages,
});
