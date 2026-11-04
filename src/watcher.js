// Shared watcher bookkeeping for scripts/watch.js and the `start` / `stop`
// commands. One watcher per (Page, Hermes profile) target:
//   watch-<hash>.lock  pid only (also read by uninstall.sh)
//   watch-<hash>.json  metadata: pid, page_url, hermes_profile, mode, started_at, log
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parsePageUrl } from './config.js';

/** Canonical link, so web./m./www. spellings of one Page map to one watcher. */
function canonicalPage(config) {
  if (config.pageUrl) {
    try { return parsePageUrl(config.pageUrl).url; } catch { return config.pageUrl; }
  }
  return config.pageId || config.pageName || '';
}

export function targetKey(config) {
  const page = canonicalPage(config);
  return crypto.createHash('sha256').update(`${page}|${config.hermesProfile || ''}`).digest('hex').slice(0, 12);
}

export function watcherPaths(config) {
  const key = targetKey(config);
  return {
    key,
    lock: path.join(config.stateDir, `watch-${key}.lock`),
    meta: path.join(config.stateDir, `watch-${key}.json`),
    out: path.join(config.stateDir, 'logs', `watch-${key}.out`),
  };
}

export function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

/** Is this pid really a watch.js process (guards against pid reuse)? */
export function isWatcherProcess(pid) {
  if (!isAlive(pid)) return false;
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('scripts/watch.js');
  } catch {
    return true; // no /proc (macOS): trust the lock
  }
}

function readPid(file) {
  try { return Number(String(fs.readFileSync(file, 'utf8')).trim()); } catch { return null; }
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/** Running watchers in a state dir; stale lock/meta files are removed. */
export function listWatchers(stateDir) {
  let files = [];
  try { files = fs.readdirSync(stateDir); } catch { return []; }
  const out = [];
  for (const f of files) {
    const m = f.match(/^watch-([0-9a-f]{12})\.lock$/);
    if (!m) continue;
    const lock = path.join(stateDir, f);
    const meta = path.join(stateDir, `watch-${m[1]}.json`);
    const pid = readPid(lock);
    if (!isWatcherProcess(pid)) {
      for (const stale of [lock, meta]) { try { fs.unlinkSync(stale); } catch { /* gone */ } }
      continue;
    }
    out.push({ key: m[1], pid, lock, meta: readJson(meta) || {} });
  }
  return out;
}

/** Take the lock for this process; false if another live watcher holds it. */
export function acquireWatcherLock(paths, pid = process.pid) {
  fs.mkdirSync(path.dirname(paths.lock), { recursive: true, mode: 0o700 });
  try {
    fs.writeFileSync(paths.lock, String(pid), { flag: 'wx', mode: 0o600 });
    return true;
  } catch {
    const holder = readPid(paths.lock);
    if (holder !== pid && isWatcherProcess(holder)) return false;
    fs.writeFileSync(paths.lock, String(pid), { mode: 0o600 });
    return true;
  }
}

export function writeWatcherMeta(paths, meta) {
  fs.writeFileSync(paths.meta, `${JSON.stringify(meta, null, 2)}\n`, { mode: 0o600 });
}

export function releaseWatcherLock(paths, pid = process.pid) {
  if (readPid(paths.lock) !== pid) return;
  for (const f of [paths.lock, paths.meta]) { try { fs.unlinkSync(f); } catch { /* gone */ } }
}
