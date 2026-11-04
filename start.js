import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cli, Strategy } from '@jackwener/opencli/registry';
import { CommandExecutionError, ConfigError as CliConfigError } from '@jackwener/opencli/errors';
import { loadConfig, requirePageConfig } from './src/config.js';
import { HermesRunner } from './src/hermes-runner.js';
import { HERMES_ARGS, PAGE_ARGS, SITE, flagOverrides, toCliError } from './src/cli-common.js';
import { isAlive, listWatchers, watcherPaths } from './src/watcher.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const WATCH_SCRIPT = path.join(ROOT, 'scripts', 'watch.js');
const delay = ms => new Promise(r => setTimeout(r, ms));

function tail(file, bytes = 1500) {
  try {
    const buf = fs.readFileSync(file);
    return buf.subarray(Math.max(0, buf.length - bytes)).toString('utf8').trim();
  } catch { return ''; }
}

export async function start(kwargs = {}) {
  let config;
  try {
    const overrides = flagOverrides(kwargs);
    if (kwargs.allow) overrides.ALLOWED_SENDER_IDS = String(kwargs.allow);
    config = requirePageConfig(loadConfig(process.env, overrides));
  } catch (error) { throw toCliError(error); }

  const paths = watcherPaths(config);
  const find = () => listWatchers(config.stateDir).find(w => w.key === paths.key);
  let running = find();
  if (running?.meta.stopping_since) {
    // A `stop` is still draining its last poll cycle: wait for it, then start fresh.
    const deadline = Date.now() + (Number(kwargs.timeout) || 180) * 1000;
    while (running && isAlive(running.pid) && Date.now() < deadline) { await delay(1000); running = find(); }
    if (running && isAlive(running.pid)) {
      return [{ status: 'stopping', pid: running.pid, stopping_since: running.meta.stopping_since, log: paths.out,
        detail: 'Previous watcher is still finishing its poll cycle; run start again shortly' }];
    }
    running = undefined;
  }
  if (running) {
    return [{ status: 'already_running', pid: running.pid, page_url: running.meta.page_url || config.pageUrl || null,
      hermes_profile: running.meta.hermes_profile || '(default)', mode: running.meta.mode, started_at: running.meta.started_at, log: paths.out }];
  }

  if (config.hermesProfile && (await new HermesRunner(config).profileExists()) === false) {
    throw new CliConfigError(`Hermes profile "${config.hermesProfile}" does not exist`, 'List profiles with: hermes profile list');
  }

  const args = [WATCH_SCRIPT];
  if (config.pageUrl) args.push('--page-url', config.pageUrl);
  if (config.hermesProfile) args.push('--hermes-profile', config.hermesProfile);
  if (kwargs['dry-run'] === true || kwargs.dryRun === true) args.push('--dry-run');
  const env = { ...process.env };
  if (kwargs.allow) env.ALLOWED_SENDER_IDS = String(kwargs.allow);
  if (kwargs.window !== undefined && kwargs.window !== null && kwargs.window !== '') {
    const mode = String(kwargs.window);
    if (!['foreground', 'background'].includes(mode)) throw new CliConfigError(`--window must be foreground or background (got "${mode}")`);
    env.OPENCLI_WINDOW = mode; // inherited by every `poll` the watcher spawns
  }

  fs.mkdirSync(path.dirname(paths.out), { recursive: true, mode: 0o700 });
  const fd = fs.openSync(paths.out, 'a', 0o600);
  fs.writeSync(fd, `\n--- start ${new Date().toISOString()} ---\n`);
  const child = spawn(process.execPath, args, { cwd: ROOT, env, detached: true, stdio: ['ignore', fd, fd] });
  child.unref();
  fs.closeSync(fd);

  // Confirm the watcher took its lock (or report why it died).
  for (let i = 0; i < 40; i++) {
    await delay(250);
    const mine = listWatchers(config.stateDir).find(w => w.key === paths.key && w.pid === child.pid);
    if (mine) {
      return [{ status: 'started', pid: child.pid, page_url: config.pageUrl || null, page_name: config.pageName || null,
        hermes_profile: config.hermesProfile || '(default)', mode: mine.meta.mode, interval_ms: config.pollIntervalMs,
        watcher_id: paths.key,
        hermes_sessions: mine.meta.mode === 'dry-run' || config.hermesSessionScope === 'oneshot' ? 'oneshot'
          : config.hermesSessionScope === 'watcher' ? `mh-${paths.key}` : `mh-${paths.key}-<conversation_id>`,
        window: env.OPENCLI_WINDOW || 'foreground',
        allowed_sender_ids: env.ALLOWED_SENDER_IDS || config.allowedSenderIds.join(',') || '(all)', log: paths.out }];
    }
    if (!isAlive(child.pid)) break;
  }
  throw new CommandExecutionError(`Watcher did not start. Output:\n${tail(paths.out) || '(none)'}`);
}

cli({
  site: SITE, name: 'start', access: 'write',
  description: 'Start the background auto-reply watcher for a fanpage (polls the inbox and answers via Hermes)',
  example: 'opencli messenger-hermes start --page-url https://www.facebook.com/handsonai --hermes-profile zalolily',
  strategy: Strategy.LOCAL, browser: false, defaultFormat: 'json',
  args: [
    ...PAGE_ARGS, ...HERMES_ARGS,
    { name: 'allow', type: 'string', help: 'Only auto-reply to these conversation ids (comma list) — sandbox testing' },
    { name: 'dry-run', type: 'boolean', default: false, help: 'Generate replies but never send them' },
    { name: 'window', type: 'string', help: 'Browser window for the watcher: foreground (default, typing is visible) or background' },
    { name: 'timeout', type: 'int', default: 180, help: 'Seconds to wait for a stopping watcher to exit before starting' },
  ],
  func: start,
});
