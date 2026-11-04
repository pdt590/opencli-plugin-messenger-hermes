import { cli, Strategy } from '@jackwener/opencli/registry';
import { describeConfig, loadConfig } from './src/config.js';
import { listWatchers } from './src/watcher.js';
import { DOMAIN, SITE, withDeps, PAGE_ARGS, HERMES_ARGS, flagOverrides, toCliError } from './src/cli-common.js';

const watcherRow = w => ({
  watcher: 'running', pid: w.pid, page_url: w.meta.page_url || null, page_name: w.meta.page_name || null,
  hermes_profile: w.meta.hermes_profile || '(default)', mode: w.meta.mode, interval_ms: w.meta.interval_ms,
  started_at: w.meta.started_at, stopping_since: w.meta.stopping_since, log: w.meta.log,
});

export async function status(page, kwargs = {}) {
  // No Page given: fall back to the running watcher, or just list watchers.
  let base;
  try { base = loadConfig(process.env, flagOverrides(kwargs)); } catch (error) { throw toCliError(error); }
  if (!base.pageName && !base.pageId && !base.pageUrl) {
    const running = listWatchers(base.stateDir).filter(w => w.meta.page_url || w.meta.page_name || w.meta.page_id);
    if (running.length !== 1) {
      return running.length ? running.map(watcherRow)
        : [{ watcher: 'none running', detail: 'No watcher is running. Pass --page-url <link> to check a Page, or start one with: opencli messenger-hermes start --page-url <link>' }];
    }
    const m = running[0].meta;
    if (m.page_url) kwargs = { ...kwargs, 'page-url': m.page_url };
    else process.env[m.page_id ? 'MESSENGER_PAGE_ID' : 'MESSENGER_PAGE_NAME'] = m.page_id || m.page_name;
    if (!kwargs['hermes-profile'] && m.hermes_profile) kwargs = { ...kwargs, 'hermes-profile': m.hermes_profile };
  }
  return withDeps(page, async ({ client, store, hermes, config }) => {
    const session = await client.checkSession();
    const threads = await client.listConversations({ limit: 50 });
    const hermesVersion = await hermes.version();
    const profileOk = await hermes.profileExists();
    const stats = store.stats(session.page_id);
    return [{
      ...describeConfig(config),
      logged_in: true,
      page_id: session.page_id,
      page_name: session.page_name,
      conversations: threads.length,
      unread: threads.filter(t => t.unread).length,
      hermes: hermesVersion || `NOT AVAILABLE (${config.hermesBin})`,
      hermes_profile_status: profileOk === null ? 'default profile' : (profileOk ? 'exists' : `NOT FOUND: ${config.hermesProfile}`),
      watchers: listWatchers(config.stateDir).map(w => `${w.meta.page_url || w.meta.page_name || '?'} [${w.meta.hermes_profile || 'default'}] ${w.meta.mode} pid ${w.pid}`).join('; ') || 'none running',
      state: Object.entries(stats).map(([k, v]) => `${k}=${v}`).join(' ') || '(empty)',
    }];
  }, { kwargs });
}

cli({
  site: SITE, name: 'status', access: 'read',
  description: 'Check the Business Suite login, the selected Page, Hermes availability and local state (without --page-url: the running watcher\'s Page, or the list of watchers)',
  example: 'opencli messenger-hermes status',
  domain: DOMAIN, strategy: Strategy.UI, browser: true, navigateBefore: false, // ephemeral tab: never disturbs a running poll
  defaultFormat: 'json',
  args: [...PAGE_ARGS, ...HERMES_ARGS],
  func: status,
});
