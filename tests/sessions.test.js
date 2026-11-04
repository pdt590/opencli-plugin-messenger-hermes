import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hermesSessionName, loadConfig } from '../src/config.js';
import { HermesRunner, stripCreationOverrides } from '../src/hermes-runner.js';
import { processConversation } from '../src/processor.js';
import { ConversationStore } from '../src/store.js';
import { FakeClient, FakeHermes, baseConfig, inbound } from './fakes.js';

const CONV = '1820968286';

async function replyAs(watcherId, scope = 'conversation', send = true) {
  const deps = {
    client: new FakeClient({ threads: { [CONV]: [inbound('m1', 'Xin chào')] } }),
    store: new ConversationStore(':memory:'),
    hermes: new FakeHermes(),
    config: baseConfig({ watcherId, hermesSessionScope: scope }),
  };
  const row = await processConversation(deps, { conversationId: CONV, send });
  return { row, session: deps.hermes.sessions[0] };
}

test('two watchers (two `start`) talk to two different Hermes sessions', async () => {
  const a = await replyAs('c519f68d6b36');
  const b = await replyAs('7e1f00aa1234');
  assert.equal(a.session, `mh-c519f68d6b36-${CONV}`);
  assert.equal(b.session, `mh-7e1f00aa1234-${CONV}`);
  assert.notEqual(a.session, b.session);
  assert.equal(a.row.hermes_session, a.session);
});

test('session scope: conversation vs watcher vs oneshot', () => {
  const c = s => ({ watcherId: 'w1', hermesSessionScope: s });
  assert.notEqual(hermesSessionName(c('conversation'), '1'), hermesSessionName(c('conversation'), '2'));
  assert.equal(hermesSessionName(c('watcher'), '1'), hermesSessionName(c('watcher'), '2'));
  assert.equal(hermesSessionName(c('oneshot'), '1'), null);
});

test('dry-run never writes into a Hermes session', async () => {
  const { row, session } = await replyAs('c519f68d6b36', 'conversation', false);
  assert.equal(session, null);
  assert.equal(row.hermes_session, 'oneshot');
});

test('runner: create a session, store its id, resume it without creation-only flags', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mhs-'));
  const cfg = loadConfig({ MESSENGER_HERMES_STATE_DIR: dir, MESSENGER_HERMES_WATCHER_ID: 'c519f68d6b36' }, { HERMES_PROFILE: 'zalolily' });
  const calls = [];
  let next = [];
  const run = async (bin, args, opts) => {
    calls.push({ args, cwd: opts.cwd });
    return next.shift() || { exitCode: 0, stdout: '{"reply":"ok"}', stderr: '\nsession_id: local-abc123\n', durationMs: 1 };
  };
  const runner = new HermesRunner(cfg, { run });
  const workdir = path.join(dir, 'hermes-workdir', 'c519f68d6b36');

  const first = await runner.generate('p', { session: 'mh-c519f68d6b36-1' });
  assert.equal(calls[0].cwd, workdir);
  assert.ok(calls[0].args.includes('-t') && calls[0].args.includes('--max-turns'));
  assert.ok(!calls[0].args.includes('--resume'));
  assert.equal(first.hermesSessionId, 'local-abc123');
  assert.equal(first.sessionResumed, false);

  const second = await runner.generate('p', { session: 'mh-c519f68d6b36-1' });
  const a2 = calls[1].args;
  assert.deepEqual(a2.slice(0, 3), ['-p', 'zalolily', 'chat']);
  assert.ok(!a2.includes('-t') && !a2.includes('--max-turns'), 'creation-only flags are not repeated on resume');
  assert.deepEqual(a2.slice(-4), ['--in', workdir, '--resume', 'local-abc123']);
  assert.equal(second.sessionResumed, true);

  // Another conversation gets its own session; one-shot runs never resume.
  await runner.generate('p', { session: 'mh-c519f68d6b36-2' });
  assert.ok(!calls[2].args.includes('--resume'));
  await runner.generate('p');
  assert.ok(!calls[3].args.includes('--resume'));

  // Stored session deleted in Hermes: one fresh retry, new id stored.
  next = [
    { exitCode: 1, stdout: '', stderr: 'Session not found: local-abc123', durationMs: 1 },
    { exitCode: 0, stdout: '{"reply":"ok"}', stderr: 'session_id: local-def456', durationMs: 1 },
  ];
  const reset = await runner.generate('p', { session: 'mh-c519f68d6b36-1' });
  assert.ok(calls[4].args.includes('--resume') && !calls[5].args.includes('--resume'));
  assert.equal(reset.hermesSessionId, 'local-def456');
  assert.equal(reset.sessionReset, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(workdir, 'sessions.json'), 'utf8'))['mh-c519f68d6b36-1'].id, 'local-def456');
});

test('runner: Hermes error text is surfaced (not just the exit code)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mhs-'));
  const cfg = loadConfig({ MESSENGER_HERMES_STATE_DIR: dir });
  const run = async () => ({ exitCode: 2, stdout: '', stderr: 'Error: Something specific broke\nsession_id: local-x', durationMs: 1 });
  await assert.rejects(new HermesRunner(cfg, { run }).generate('p'), e => /Something specific broke/.test(e.message) && !/session_id/.test(e.message));
});

test('stripCreationOverrides removes only -t/--toolsets/--max-turns', () => {
  assert.deepEqual(stripCreationOverrides(['-p', 'z', 'chat', '-t', 'clarify', '--max-turns', '1', '--toolsets=x', '-Q']), ['-p', 'z', 'chat', '-Q']);
});

test('config: watcher id and scope validation', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mhs-'));
  assert.equal(loadConfig({ MESSENGER_HERMES_STATE_DIR: dir }).watcherId, 'cli');
  assert.throws(() => loadConfig({ MESSENGER_HERMES_STATE_DIR: dir, MESSENGER_HERMES_WATCHER_ID: '../x' }), /watcher_id|MESSENGER_HERMES_WATCHER_ID/);
  assert.throws(() => loadConfig({ MESSENGER_HERMES_STATE_DIR: dir, HERMES_SESSION_SCOPE: 'global' }), /HERMES_SESSION_SCOPE/);
});
