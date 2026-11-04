import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquireWatcherLock, listWatchers, releaseWatcherLock, targetKey, watcherPaths, writeWatcherMeta } from '../src/watcher.js';

const cfg = (o = {}) => ({ stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'mhw-')), pageUrl: 'https://www.facebook.com/handsonai', hermesProfile: '', ...o });

test('target key differs per page and per profile', () => {
  const a = targetKey(cfg());
  assert.equal(a, targetKey(cfg()));
  assert.notEqual(a, targetKey(cfg({ hermesProfile: 'zalolily' })));
  assert.notEqual(a, targetKey(cfg({ pageUrl: 'https://www.facebook.com/other' })));
});

test('same Page written differently -> same watcher (web./m./www., trailing slash, query)', () => {
  const k = url => targetKey(cfg({ pageUrl: url }));
  const base = k('https://www.facebook.com/handsonai');
  for (const u of ['https://web.facebook.com/handsonai', 'https://m.facebook.com/handsonai/', 'https://facebook.com/handsonai?_rdc=1']) assert.equal(k(u), base, u);
});

test('lock: a live holder blocks, a dead holder is taken over, release removes files', () => {
  const c = cfg();
  const p = watcherPaths(c);
  // process.pid is alive but is not a watch.js process -> treated as stale.
  fs.writeFileSync(p.lock, '999999999');
  assert.ok(acquireWatcherLock(p));
  assert.equal(fs.readFileSync(p.lock, 'utf8'), String(process.pid));
  writeWatcherMeta(p, { pid: process.pid });
  releaseWatcherLock(p);
  assert.ok(!fs.existsSync(p.lock) && !fs.existsSync(p.meta));
});

test('listWatchers drops stale locks', () => {
  const c = cfg();
  const p = watcherPaths(c);
  fs.writeFileSync(p.lock, '999999999');
  writeWatcherMeta(p, { pid: 999999999 });
  assert.deepEqual(listWatchers(c.stateDir), []);
  assert.ok(!fs.existsSync(p.lock));
});
