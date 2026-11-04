import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError } from '@jackwener/opencli/errors';
import { loadConfig } from './src/config.js';
import { HERMES_ARGS, PAGE_ARGS, SITE, flagOverrides, toCliError } from './src/cli-common.js';
import { isAlive, listWatchers, watcherPaths } from './src/watcher.js';

const delay = ms => new Promise(r => setTimeout(r, ms));

export async function stop(kwargs = {}) {
  let config;
  try { config = loadConfig(process.env, flagOverrides(kwargs)); } catch (error) { throw toCliError(error); }
  const running = listWatchers(config.stateDir);
  const describe = w => `${w.meta.page_url || w.meta.page_name || w.meta.page_id || '?'} [${w.meta.hermes_profile || 'default'}] pid ${w.pid}`;

  let targets;
  const explicit = kwargs['page-url'] || kwargs['hermes-profile'];
  if (kwargs.all) targets = running;
  else if (explicit) targets = running.filter(w => w.key === watcherPaths(config).key);
  else if (running.length <= 1) targets = running;
  else throw new ArgumentError(`${running.length} watchers are running; pass --page-url/--hermes-profile or --all:\n  ${running.map(describe).join('\n  ')}`);

  if (!targets.length) return [{ status: 'not_running', page_url: config.pageUrl || null, hermes_profile: config.hermesProfile || '(default)' }];

  for (const w of targets) process.kill(w.pid, 'SIGTERM');
  // watch.js finishes the poll cycle in progress (never cuts a send in half), then exits.
  const deadline = Date.now() + (Number(kwargs.timeout) || 180) * 1000;
  while (targets.some(w => isAlive(w.pid)) && Date.now() < deadline) await delay(1000);

  return targets.map((w) => {
    let status = isAlive(w.pid) ? 'stopping' : 'stopped';
    if (status === 'stopping' && kwargs.force) {
      try { process.kill(w.pid, 'SIGKILL'); status = 'killed'; } catch { status = 'stopped'; }
    }
    return { status, pid: w.pid, page_url: w.meta.page_url || null, hermes_profile: w.meta.hermes_profile || '(default)',
      mode: w.meta.mode, started_at: w.meta.started_at,
      detail: status === 'stopping' ? 'Still finishing its current poll cycle; it exits on its own (or use --force)' : undefined };
  });
}

cli({
  site: SITE, name: 'stop', access: 'write',
  description: 'Stop the background auto-reply watcher (after its current poll cycle)',
  example: 'opencli messenger-hermes stop --page-url https://www.facebook.com/handsonai --hermes-profile zalolily',
  strategy: Strategy.LOCAL, browser: false, defaultFormat: 'json',
  args: [
    ...PAGE_ARGS, ...HERMES_ARGS,
    { name: 'all', type: 'boolean', default: false, help: 'Stop every running watcher' },
    { name: 'timeout', type: 'int', default: 180, help: 'Seconds to wait for the current cycle to finish' },
    { name: 'force', type: 'boolean', default: false, help: 'SIGKILL if still running after --timeout (a reply may then be left send_unknown)' },
  ],
  func: stop,
});
