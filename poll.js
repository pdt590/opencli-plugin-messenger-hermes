import { cli, Strategy } from '@jackwener/opencli/registry';
import { pollOnce } from './src/poller.js';
import { DOMAIN, SITE, truncate, withDeps, PAGE_ARGS, HERMES_ARGS, timeoutArg } from './src/cli-common.js';

export async function poll(page, kwargs = {}) {
  const send = kwargs.send === true;
  return withDeps(page, async (deps) => {
    const { threads, candidates, rows } = await pollOnce(deps, { send, limit: Number(kwargs.limit) || undefined });
    if (!rows.length) {
      return [{ status: 'idle', mode: send ? 'live' : 'dry-run', conversations: threads.length, candidates: candidates.length, detail: 'No conversation with new activity' }];
    }
    return rows.map(r => ({ ...r, reply: r.reply ? truncate(r.reply, kwargs.full ? 5000 : 120) : undefined }));
  }, { kwargs });
}

cli({
  site: SITE, name: 'poll', access: 'write',
  description: 'One inbox poll cycle: find conversations with new inbound messages and answer them via Hermes (dry-run unless --send)',
  example: 'opencli messenger-hermes poll --send',
  domain: DOMAIN, strategy: Strategy.UI, browser: true, siteSession: 'persistent', navigateBefore: false,
  defaultWindowMode: 'foreground', // typing is visible; override with --window background or OPENCLI_WINDOW
  defaultFormat: 'json',
  args: [
    { name: 'send', type: 'boolean', default: false, help: 'Actually send replies and record state' },
    { name: 'limit', type: 'int', help: 'Max conversations to process this cycle (default MESSENGER_MAX_CONVERSATIONS_PER_POLL)' },
    { name: 'full', type: 'boolean', default: false, help: 'Show full reply text' },
    ...PAGE_ARGS, ...HERMES_ARGS,
    timeoutArg(1800),
  ],
  func: poll,
});
