#!/usr/bin/env node
// External scheduler: runs `opencli messenger-hermes poll` every
// MESSENGER_POLL_INTERVAL_MS. OpenCLI commands are short-lived, so the loop
// lives here. Single instance (pid lock), graceful stop on SIGINT/SIGTERM.
//
//   node scripts/watch.js                                   # live: poll --send
//   node scripts/watch.js --dry-run                         # generate replies but never send
//   node scripts/watch.js --page-url https://www.facebook.com/handsonai --hermes-profile zalolily
import path from 'node:path';
import { spawn } from 'node:child_process';
import { loadConfig, perConversationSeconds } from '../src/config.js';
import { Logger } from '../src/logger.js';
import { acquireWatcherLock, releaseWatcherLock, watcherPaths, writeWatcherMeta } from '../src/watcher.js';

const argv = process.argv.slice(2);
function flag(name) {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  const value = argv[i + 1];
  if (!value || value.startsWith('--')) { console.error(`${name} needs a value`); process.exit(64); }
  return value;
}
const dryRun = argv.includes('--dry-run');
const once = argv.includes('--once');
const pageUrl = flag('--page-url');
const hermesProfile = flag('--hermes-profile');
const config = loadConfig(process.env, { MESSENGER_PAGE_URL: pageUrl, HERMES_PROFILE: hermesProfile });
const logger = new Logger({ dir: path.join(config.stateDir, 'logs'), stderr: true });
const opencli = process.env.OPENCLI_BIN || 'opencli';
// One watcher per (Page, profile) target; see src/watcher.js.
const paths = watcherPaths(config);
const MAX_CONSECUTIVE_FAILURES = 5;

function runPoll() {
  return new Promise((resolve) => {
    // Enough time for every conversation this cycle may process (OpenCLI's default is 60 s).
    const timeoutSec = config.maxConversationsPerPoll * perConversationSeconds(config) + 60;
    const args = ['messenger-hermes', 'poll', '-f', 'json', '--timeout', String(timeoutSec), ...(dryRun ? [] : ['--send'])];
    if (pageUrl) args.push('--page-url', pageUrl);
    if (hermesProfile) args.push('--hermes-profile', hermesProfile);
    // The watcher id gives this watcher its own Hermes sessions and workdir.
    const child = spawn(opencli, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: false, env: { ...process.env, MESSENGER_HERMES_WATCHER_ID: paths.key } });
    let out = '';
    let err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', e => resolve({ code: -1, out, err: e.message }));
    child.on('close', code => resolve({ code, out, err }));
  });
}

let stopping = false;
let wake = null;
let meta = null;
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    if (!stopping && meta) {
      // Lets `start` tell a draining watcher from a live one.
      try { writeWatcherMeta(paths, { ...meta, stopping_since: new Date().toISOString() }); } catch { /* best effort */ }
    }
    stopping = true;
    logger.info('watch_stopping', { signal: sig });
    if (wake) wake();
  });
}

if (!acquireWatcherLock(paths)) {
  console.error(`Another watcher is already running for this Page/profile (see ${paths.lock}).`);
  process.exit(1);
}
meta = {
  pid: process.pid,
  page_url: config.pageUrl || null,
  page_name: config.pageName || null,
  page_id: config.pageId || null,
  hermes_profile: config.hermesProfile || null,
  mode: dryRun ? 'dry-run' : 'live',
  watcher_id: paths.key,
  hermes_session_scope: config.hermesSessionScope,
  interval_ms: config.pollIntervalMs,
  started_at: new Date().toISOString(),
  log: paths.out,
};
writeWatcherMeta(paths, meta);
process.on('exit', () => releaseWatcherLock(paths));

logger.info('watch_started', { mode: dryRun ? 'dry-run' : 'live', interval_ms: config.pollIntervalMs, page_url: config.pageUrl, page_name: config.pageName, hermes_profile: config.hermesProfile || '(default)' });
let failures = 0;
while (!stopping) {
  const started = Date.now();
  const r = await runPoll();
  let rows = [];
  try { rows = JSON.parse(r.out).data || []; } catch { /* non-JSON output */ }
  if (r.code === 0) {
    failures = 0;
    for (const row of rows) {
      if (row.status && row.status !== 'idle') logger.info('watch_row', { conversation_id: row.conversation_id, status: row.status, error_code: row.error_code });
    }
  } else {
    failures++;
    let error = {};
    try { error = JSON.parse(r.out || r.err).error || {}; } catch { error = { message: (r.err || r.out).slice(0, 300) }; }
    logger.error('watch_poll_failed', { exit_code: r.code, error_code: error.code, detail: error.message, failures });
    if (['auth_required', 'login_wall', 'config'].includes(String(error.code).toLowerCase()) || failures >= MAX_CONSECUTIVE_FAILURES) {
      logger.error('watch_giving_up', { reason: 'needs operator attention (login, checkpoint, configuration or repeated failures)' });
      process.exitCode = 2;
      break;
    }
  }
  if (once) break;
  const wait = Math.max(1000, config.pollIntervalMs * (failures ? Math.min(2 ** failures, 8) : 1) - (Date.now() - started));
  await new Promise(resolve => { wake = resolve; setTimeout(resolve, wait); });
  wake = null;
}
logger.info('watch_stopped', {});
