import { cli, Strategy } from '@jackwener/opencli/registry';
import { processConversation } from './src/processor.js';
import { DOMAIN, SITE, requireConversationId, withDeps, PAGE_ARGS, HERMES_ARGS, timeoutArg } from './src/cli-common.js';

export async function processCommand(page, kwargs = {}) {
  const conversationId = requireConversationId(kwargs);
  const send = kwargs.send === true;
  return withDeps(page, async (deps) => {
    const row = await processConversation(deps, {
      conversationId,
      messageKey: kwargs.message ? String(kwargs.message) : undefined,
      send,
    });
    return [row];
  }, { kwargs });
}

cli({
  site: SITE, name: 'process', access: 'write',
  description: 'Answer the unanswered inbound messages of one conversation with Hermes (dry-run unless --send)',
  example: 'opencli messenger-hermes process --conversation 1820968286 --send',
  domain: DOMAIN, strategy: Strategy.UI, browser: true, siteSession: 'persistent', navigateBefore: false,
  defaultWindowMode: 'foreground', // typing is visible; override with --window background or OPENCLI_WINDOW
  defaultFormat: 'json',
  args: [
    { name: 'conversation', type: 'string', required: true, help: 'Conversation id from `inbox`' },
    { name: 'message', type: 'string', help: 'Only proceed if this message key (mid.$...) is still unanswered' },
    { name: 'send', type: 'boolean', default: false, help: 'Actually send and record state. Without it: generate, type, verify and clear (no state written)' },
    ...PAGE_ARGS, ...HERMES_ARGS,
    timeoutArg(600),
  ],
  func: processCommand,
});
