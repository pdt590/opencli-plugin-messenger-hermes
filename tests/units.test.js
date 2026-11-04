import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { parseHermesOutput, runProcess, HermesRunner } from '../src/hermes-runner.js';
import { normalizeMessage, fingerprint, comparableText } from '../src/messages.js';
import { classifySecurity, sameName } from '../src/messenger-web-client.js';
import { loadConfig } from '../src/config.js';
import { Logger } from '../src/logger.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PAGE = '115027273745576';

test('parse: plain JSON line', () => {
  assert.deepEqual(parseHermesOutput('{"reply": "Chào bạn", "handoff": false}', { maxReplyLength: 100 }), { reply: 'Chào bạn', handoff: false, truncated: false });
});

test('parse: JSON inside a code fence with CLI noise', () => {
  const out = '\u001b[32m```json\n{"reply":"Dạ, giá là 100k"}\n```\u001b[0m\nsession_id: local-abc\n';
  assert.equal(parseHermesOutput(out, { maxReplyLength: 100 }).reply, 'Dạ, giá là 100k');
});

test('parse: handoff and empty reply', () => {
  assert.equal(parseHermesOutput('{"reply": null, "handoff": true}', { maxReplyLength: 100 }).handoff, true);
  assert.equal(parseHermesOutput('{"reply": "   "}', { maxReplyLength: 100 }).handoff, true);
});

test('parse: rejects non-JSON and wrong types', () => {
  assert.throws(() => parseHermesOutput('Xin chào bạn', { maxReplyLength: 100 }), { code: 'hermes_invalid_output' });
  assert.throws(() => parseHermesOutput('{"reply": 42}', { maxReplyLength: 100 }), { code: 'hermes_invalid_output' });
  assert.throws(() => parseHermesOutput('', { maxReplyLength: 100 }), { code: 'hermes_empty_output' });
});

test('parse: truncates over-long replies', () => {
  const r = parseHermesOutput(JSON.stringify({ reply: 'chữ '.repeat(100) }), { maxReplyLength: 50 });
  assert.ok([...r.reply].length <= 50);
  assert.ok(r.truncated);
});

function fakeSpawn({ stdout = '', stderr = '', code = 0, hang = false }) {
  return (bin, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.received = { bin, args, opts, input: '' };
    child.stdin.on('data', d => { child.received.input += d; });
    child.kill = () => { setImmediate(() => child.emit('close', null, 'SIGTERM')); };
    fakeSpawn.last = child;
    if (!hang) setImmediate(() => { child.stdout.end(stdout); child.stderr.end(stderr); setImmediate(() => child.emit('close', code, null)); });
    return child;
  };
}

test('runProcess: prompt goes to stdin, never argv, no shell', async () => {
  const spawnImpl = fakeSpawn({ stdout: '{"reply":"ok"}' });
  const r = await runProcess('hermes', ['chat'], { input: 'SECRET PROMPT', cwd: os.tmpdir(), timeoutMs: 1000, maxOutputBytes: 1000, spawnImpl });
  assert.equal(r.exitCode, 0);
  assert.equal(fakeSpawn.last.received.input, 'SECRET PROMPT');
  assert.ok(!fakeSpawn.last.received.args.join(' ').includes('SECRET'));
  assert.equal(fakeSpawn.last.received.opts.shell, false);
});

test('runProcess: timeout is transient', async () => {
  const spawnImpl = fakeSpawn({ hang: true });
  await assert.rejects(runProcess('hermes', [], { input: '', cwd: os.tmpdir(), timeoutMs: 50, maxOutputBytes: 1000, spawnImpl }), e => e.code === 'hermes_timeout' && e.transient);
});

test('runProcess: output cap', async () => {
  const spawnImpl = fakeSpawn({ stdout: 'x'.repeat(5000) });
  await assert.rejects(runProcess('hermes', [], { input: '', cwd: os.tmpdir(), timeoutMs: 1000, maxOutputBytes: 100, spawnImpl }), { code: 'hermes_output_too_large' });
});

test('HermesRunner: auth/config errors are permanent, others transient', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-'));
  const cfg = { hermesBin: 'hermes', hermesArgs: [], hermesWorkdir: dir, hermesTimeoutMs: 1000, hermesMaxOutputBytes: 10000, maxReplyLength: 100 };
  const run = (stderr, exitCode) => async () => ({ exitCode, stdout: '', stderr, durationMs: 1 });
  await assert.rejects(new HermesRunner(cfg, { run: run('invalid_params: bad model', 1) }).generate('p'), e => e.code === 'hermes_config' && !e.transient);
  await assert.rejects(new HermesRunner(cfg, { run: run('connection reset', 1) }).generate('p'), e => e.code === 'hermes_exit' && e.transient);
});

test('normalize: direction from isFromViewer and page sender id', () => {
  const ctx = { pageId: PAGE, conversationId: '1820968286' };
  assert.equal(normalizeMessage({ id: 'a', from_viewer: false, sender_id: '1820968286', text: 'hi', timestamp: 1 }, ctx).direction, 'inbound');
  assert.equal(normalizeMessage({ id: 'b', from_viewer: true, sender_id: PAGE, text: 'hi', timestamp: 1 }, ctx).direction, 'outbound');
  assert.equal(normalizeMessage({ id: 'c', from_viewer: null, sender_id: PAGE, text: 'hi', timestamp: 1 }, ctx).direction, 'outbound');
  assert.equal(normalizeMessage({ id: 'd', from_viewer: null, sender_id: null, text: 'hi', timestamp: 1 }, ctx).direction, 'unknown');
});

test('normalize: stable fingerprint when no message id', () => {
  const ctx = { pageId: PAGE, conversationId: '1820968286' };
  const raw = { from_viewer: false, text: 'hi', timestamp: 1700000000000 };
  assert.equal(normalizeMessage(raw, ctx).message_key, normalizeMessage({ ...raw }, ctx).message_key);
  assert.notEqual(fingerprint(['a', 'b']), fingerprint(['ab', '']));
});

test('comparableText ignores whitespace/case/unicode form', () => {
  assert.equal(comparableText('Thực  Chiến\n'), comparableText('thực chiến'.normalize('NFD')));
});

test('security classification', () => {
  assert.equal(classifySecurity({ url: 'https://www.facebook.com/login/?next=x', bodyText: '' }), 'logged_out');
  assert.equal(classifySecurity({ url: 'https://www.facebook.com/checkpoint/123', bodyText: '' }), 'checkpoint');
  assert.equal(classifySecurity({ url: 'https://business.facebook.com/latest/inbox', bodyText: 'Log in to Facebook', scope: null }), 'logged_out');
  assert.equal(classifySecurity({ url: 'https://business.facebook.com/latest/inbox', bodyText: 'Log in to Facebook', scope: { id: '1' } }), null);
  assert.ok(sameName('AI Thực Chiến', 'ai thực  chiến'.normalize('NFD')));
});

test('config: env overrides file, defaults are safe', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ MESSENGER_PAGE_NAME: 'File Page', MAX_REPLY_LENGTH: 500 }));
  const c = loadConfig({ MESSENGER_HERMES_STATE_DIR: dir, MAX_REPLY_LENGTH: '800' });
  assert.equal(c.pageName, 'File Page');
  assert.equal(c.maxReplyLength, 800);
  assert.ok(c.hermesArgs.includes('--safe-mode'));
  assert.ok(c.hermesArgs.includes('--query-file'));
  assert.throws(() => loadConfig({ MESSENGER_HERMES_STATE_DIR: dir, HERMES_ARGS: 'chat -Q' }), /JSON array/);
});

test('logger omits content by default and redacts cookies', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-'));
  const logger = new Logger({ dir });
  const rec = logger.info('x', { text: 'nội dung riêng tư', detail: 'cookie c_user=12345; xs=abc' });
  assert.equal(rec.text, undefined);
  assert.equal(rec.text_chars, 17);
  assert.ok(!rec.detail.includes('12345'));
});

import { parsePageUrl } from '../src/config.js';

test('page url: Business Suite asset id is used directly, others need the browser', () => {
  assert.equal(parsePageUrl('https://business.facebook.com/latest/inbox/all?asset_id=115027273745576').pageId, '115027273745576');
  assert.deepEqual(parsePageUrl('https://web.facebook.com/handsonai/?_rdc=1'), { pageId: null, url: 'https://www.facebook.com/handsonai' });
  assert.equal(parsePageUrl('https://m.facebook.com/profile.php?id=100063958126490').url, 'https://www.facebook.com/profile.php?id=100063958126490');
  assert.throws(() => parsePageUrl('https://evil.example.com/handsonai'), /facebook\.com/);
  assert.throws(() => parsePageUrl('https://facebook.com.evil.io/x'), /facebook\.com/);
  assert.throws(() => parsePageUrl('https://www.facebook.com/'), /no Page/);
});

test('hermes profile: -p goes first, safe mode off by default, flags override env', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-'));
  const c = loadConfig({ MESSENGER_HERMES_STATE_DIR: dir, HERMES_PROFILE: 'other' }, { HERMES_PROFILE: 'zalolily' });
  assert.deepEqual(c.hermesArgs.slice(0, 3), ['-p', 'zalolily', 'chat']);
  assert.ok(!c.hermesArgs.includes('--safe-mode'));
  assert.ok(!c.hermesArgs.includes('--model'));
  const forced = loadConfig({ MESSENGER_HERMES_STATE_DIR: dir, HERMES_PROFILE: 'zalolily', HERMES_SAFE_MODE: 'true' });
  assert.ok(forced.hermesArgs.includes('--safe-mode'));
  assert.throws(() => loadConfig({ MESSENGER_HERMES_STATE_DIR: dir, HERMES_PROFILE: '-x; rm' }), /valid Hermes profile/);
});

test('hermes auth failures (expired OAuth) are permanent', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-'));
  const cfg = { hermesBin: 'hermes', hermesArgs: [], hermesWorkdir: dir, hermesTimeoutMs: 1000, hermesMaxOutputBytes: 10000, maxReplyLength: 100 };
  const run = async () => ({ exitCode: 1, stdout: 'ChatGPT or Codex Subscription rejected your sign-in. Provider said: HTTP 401', stderr: '', durationMs: 1 });
  await assert.rejects(new HermesRunner(cfg, { run }).generate('p'), e => e.code === 'hermes_config' && !e.transient);
});
