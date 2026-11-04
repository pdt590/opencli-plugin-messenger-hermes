// Fake MessengerWebClient and Hermes for tests: no browser, no network.
import { normalizeMessage } from '../src/messages.js';

export const PAGE_ID = '115027273745576';

export function baseConfig(overrides = {}) {
  return {
    pageName: 'AI Thực Chiến',
    pageId: PAGE_ID,
    allowedSenderIds: [],
    maxMessageAgeMin: 1440,
    maxConversationsPerPoll: 10,
    historyMessages: 12,
    maxContextChars: 6000,
    maxReplyLength: 2000,
    hermesMaxAttempts: 3,
    retryBaseMs: 1000,
    systemPromptFile: '',
    hermesSessionScope: 'conversation',
    watcherId: 'cli',
    ...overrides,
  };
}

export class FakeClient {
  constructor({ threads = {}, titles = {} } = {}) {
    this.pageId = PAGE_ID;
    this.threads = threads; // conversationId -> raw messages
    this.titles = titles;
    this.sent = [];
    this.failSend = null;
    this.reads = 0;
  }

  async resolvePage() { return this.pageId; }

  async listConversations() {
    return Object.entries(this.threads).map(([id, msgs]) => ({
      page_id: PAGE_ID, conversation_id: id, title: this.titles[id] || id, snippet: '',
      unread: true, is_group: false, platform: 'MESSENGER',
      last_activity_ms: Math.max(0, ...msgs.map(m => m.timestamp)),
    }));
  }

  async readMessages(conversationId) {
    this.reads++;
    const raw = this.threads[conversationId] || [];
    return {
      page_id: PAGE_ID, page_name: 'AI Thực Chiến', conversation_id: conversationId,
      messages: raw.map(r => normalizeMessage(r, { pageId: PAGE_ID, conversationId })),
      composer: { present: true, text: '' },
    };
  }

  async sendTextReply(conversationId, text, { dryRun, expectedLastMessageKey } = {}) {
    if (this.failSend) { const e = this.failSend; this.failSend = null; throw e; }
    const raw = this.threads[conversationId];
    if (expectedLastMessageKey && raw[raw.length - 1].id !== expectedLastMessageKey) {
      const e = new Error('changed'); e.code = 'conversation_changed'; e.transient = true; throw e;
    }
    if (dryRun) return { sent: false, dry_run: true, composer_verified: true };
    const id = `mid.sent-${this.sent.length + 1}`;
    const ts = Date.now();
    raw.push({ id, from_viewer: true, sender_id: PAGE_ID, text, timestamp: ts });
    this.sent.push({ conversationId, text });
    return { sent: true, verified: true, message_id: id, timestamp: new Date(ts).toISOString() };
  }
}

export function inbound(id, text, ageMs = 60_000, senderId = '1820968286') {
  return { id, from_viewer: false, sender_id: senderId, text, timestamp: Date.now() - ageMs, attachments: 0 };
}

export function outbound(id, text, ageMs = 30_000) {
  return { id, from_viewer: true, sender_id: PAGE_ID, text, timestamp: Date.now() - ageMs, attachments: 0 };
}

export class FakeHermes {
  constructor(replies = []) {
    this.replies = replies;
    this.prompts = [];
    this.sessions = [];
  }

  async generate(prompt, opts = {}) {
    this.prompts.push(prompt);
    this.sessions.push(opts.session ?? null);
    const next = this.replies.shift();
    if (next instanceof Error) throw next;
    if (next === null) return { reply: null, handoff: true, truncated: false, durationMs: 5 };
    return { reply: next ?? 'Chào bạn!', handoff: false, truncated: false, durationMs: 5 };
  }
}
