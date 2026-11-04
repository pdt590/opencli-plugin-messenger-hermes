import test from 'node:test';
import assert from 'node:assert/strict';
import { planTyping, plannedDurationMs } from '../src/typing.js';
import { processConversation } from '../src/processor.js';
import { ConversationStore } from '../src/store.js';
import { HermesError } from '../src/hermes-runner.js';
import { FakeClient, FakeHermes, baseConfig, inbound } from './fakes.js';

const replay = steps => steps.map(s => (s.kind === 'newline' ? '\n' : s.text)).join('');

test('typing plan reproduces the text exactly (diacritics, emoji, line breaks)', () => {
  const text = 'Chào bạn! Khóa học “AI Thực Chiến” 👩‍💻\n\nGiá: 1.990.000đ.';
  for (let i = 0; i < 20; i++) assert.equal(replay(planTyping(text)), text);
  const chunks = planTyping('👩‍💻👩‍💻👩‍💻').filter(s => s.kind === 'text').map(s => s.text);
  assert.ok(chunks.every(c => [...new Intl.Segmenter('vi', { granularity: 'grapheme' }).segment(c)].every(g => g.segment === '👩‍💻')));
});

test('typing plan is human-paced for short text and bounded for long text', () => {
  const short = planTyping('Dạ, bên mình có khóa học online ạ.', { cps: 8, maxMs: 30_000 });
  const ms = plannedDurationMs(short);
  assert.ok(ms > 2000 && ms < 8000, `short reply took ${ms}ms`);
  assert.ok(short.length > 10, 'typed in many small bursts');
  const long = planTyping('chữ '.repeat(500), { cps: 8, maxMs: 20_000, minStepMs: 120 });
  assert.ok(plannedDurationMs(long) <= 20_000);
  assert.ok(long.length <= Math.floor(20_000 / 120) + 5);
  assert.equal(long[long.length - 1].delayMs, 0);
});

test('typing plan pauses longer after punctuation', () => {
  const random = () => 0.5;
  const steps = planTyping('ab. cd', { cps: 10, random });
  const dot = steps.find(s => s.kind === 'text' && /[.]\s*$/.test(s.text));
  const plain = steps.find(s => s.kind === 'text' && !/[.]\s*$/.test(s.text) && s.delayMs > 0);
  assert.ok(dot.delayMs > plain.delayMs);
});

function depsWithIndicator(replies) {
  const client = new FakeClient({ threads: { '1820968286': [inbound('m1', 'Xin chào')] } });
  const events = [];
  client.startTypingIndicator = async () => { events.push('start'); return { stop: async () => { events.push('stop'); return { ticks: 2 }; } }; };
  const hermes = new FakeHermes(replies);
  const generate = hermes.generate.bind(hermes);
  hermes.generate = async (...a) => { events.push('hermes'); return generate(...a); };
  return { deps: { client, store: new ConversationStore(':memory:'), hermes, config: baseConfig({ typingIndicator: true }) }, events };
}

test('typing indicator runs around the Hermes call and is stopped before sending', async () => {
  const { deps, events } = depsWithIndicator();
  const row = await processConversation(deps, { conversationId: '1820968286', send: true });
  assert.equal(row.status, 'sent');
  assert.deepEqual(events, ['start', 'hermes', 'stop']);
  assert.equal(row.typing_indicator_ticks, 2);
});

test('typing indicator is stopped when Hermes fails', async () => {
  const { deps, events } = depsWithIndicator([new HermesError('hermes_timeout', 't', { transient: true })]);
  const row = await processConversation(deps, { conversationId: '1820968286', send: true });
  assert.equal(row.status, 'retry_scheduled');
  assert.deepEqual(events, ['start', 'hermes', 'stop']);
});

test('no typing indicator in dry-run or when disabled', async () => {
  const a = depsWithIndicator();
  await processConversation(a.deps, { conversationId: '1820968286', send: false });
  assert.deepEqual(a.events, ['hermes']);
  const b = depsWithIndicator();
  b.deps.config.typingIndicator = false;
  await processConversation(b.deps, { conversationId: '1820968286', send: true });
  assert.deepEqual(b.events, ['hermes']);
});
