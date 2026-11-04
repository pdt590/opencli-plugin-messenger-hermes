import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError } from '@jackwener/opencli/errors';
import { normalizeText } from './src/messages.js';
import { DOMAIN, SITE, requireArg, requireConversationId, withDeps, PAGE_ARGS, timeoutArg } from './src/cli-common.js';

export async function reply(page, kwargs = {}) {
  const conversationId = requireConversationId(kwargs);
  const text = normalizeText(requireArg(kwargs, 'text'));
  const dryRun = kwargs['dry-run'] === true || kwargs.dryRun === true;
  return withDeps(page, async ({ client, config, logger }) => {
    if ([...text].length > config.maxReplyLength) {
      throw new ArgumentError(`--text is longer than MAX_REPLY_LENGTH (${config.maxReplyLength})`);
    }
    const result = await client.sendTextReply(conversationId, text, { dryRun });
    logger.info(dryRun ? 'manual_reply_dry_run' : 'manual_reply_sent', {
      page_id: client.pageId, conversation_id: conversationId, stage: 'send',
      status: result.sent ? 'sent' : 'dry_run', reply_message_id: result.message_id, reply: text,
    });
    return [{ conversation_id: conversationId, page_id: client.pageId, ...result }];
  }, { kwargs });
}

cli({
  site: SITE, name: 'reply', access: 'write',
  description: 'Send a text reply in one conversation through the inbox UI and confirm it appears',
  example: 'opencli messenger-hermes reply --conversation 1820968286 --text "Chào bạn" --dry-run',
  domain: DOMAIN, strategy: Strategy.UI, browser: true, siteSession: 'persistent', navigateBefore: false,
  defaultWindowMode: 'foreground', // typing is visible; override with --window background or OPENCLI_WINDOW
  defaultFormat: 'json',
  args: [
    { name: 'conversation', type: 'string', required: true, help: 'Conversation id from `inbox`' },
    { name: 'text', type: 'string', required: true, help: 'Reply text (plain text)' },
    { name: 'dry-run', type: 'boolean', default: false, help: 'Type into the reply box, verify, then clear it without sending' },
    ...PAGE_ARGS,
    timeoutArg(300),
  ],
  func: reply,
});
