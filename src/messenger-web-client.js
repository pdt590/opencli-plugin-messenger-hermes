// MessengerWebClient: every Messenger interaction goes through the Meta Business
// Suite inbox UI in the OpenCLI-controlled browser. No Graph API, tokens or
// cookies are used or read.
import fs from 'node:fs';
import path from 'node:path';
import { parsePageUrl } from './config.js';
import { UiError } from './errors.js';
import { planTyping } from './typing.js';
import { comparableText, normalizeMessage, normalizeThread } from './messages.js';
import {
  clickSendButton,
  focusComposer,
  readOpenThread,
  readPageIdentity,
  readPageList,
  readPageState,
  readThreadList,
} from './dom-scripts.js';

const SECURITY_PATTERNS = [
  { code: 'logged_out', url: [/\/login(?:\.php)?(?:[/?#]|$)/i, /\/loginpage/i, /\/recover(?:\/|$)/i], text: [/log in to facebook/i, /log into facebook/i, /you must log in/i, /đăng nhập vào facebook/i, /bạn phải đăng nhập/i] },
  { code: 'checkpoint', url: [/\/checkpoint(?:\/|$)/i, /two_step_verification/i], text: [/confirm your identity/i, /enter (the )?security code/i, /xác nhận danh tính/i, /nhập mã bảo mật/i, /suspicious activity/i] },
  { code: 'captcha', url: [/captcha/i], text: [/i'm not a robot/i, /tôi không phải là người máy/i] },
];

export function classifySecurity(state) {
  for (const p of SECURITY_PATTERNS) {
    if (p.url.some(re => re.test(state.url || ''))) return p.code;
    // Text patterns only count when the inbox itself is not rendered.
    if (!state.scope && p.text.some(re => re.test(`${state.title}\n${state.bodyText}`))) return p.code;
  }
  return null;
}

export function sameName(a, b) {
  const norm = s => String(s || '').normalize('NFC').trim().toLowerCase().replace(/\s+/g, ' ');
  return norm(a) === norm(b);
}

const delay = ms => new Promise(r => setTimeout(r, ms));

export class MessengerWebClient {
  constructor(page, config, { logger, sleep = delay } = {}) {
    if (!page) throw new UiError('no_browser', 'This command requires an OpenCLI browser page');
    this.page = page;
    this.config = config;
    this.logger = logger;
    this.sleep = sleep;
    this.pageId = config.pageId || null;
    this.pageName = config.pageName || null;
  }

  url({ conversationId } = {}) {
    const u = new URL(this.config.inboxUrl);
    if (this.pageId) u.searchParams.set('asset_id', this.pageId);
    if (conversationId) {
      u.searchParams.set('selected_item_id', conversationId);
      u.searchParams.set('thread_type', 'FB_MESSAGE');
    }
    return u.toString();
  }

  async waitFor(fn, predicate, { timeoutMs = this.config.uiTimeoutMs, intervalMs = 500, args = [] } = {}) {
    const deadline = Date.now() + timeoutMs;
    let last;
    for (;;) {
      try { last = await this.page.evaluate(fn, ...args); } catch (error) { last = { __error: error.message }; }
      if (last && !last.__error && predicate(last)) return { ok: true, value: last };
      if (Date.now() >= deadline) return { ok: false, value: last };
      await this.sleep(intervalMs);
    }
  }

  async assertSafe() {
    const state = await this.page.evaluate(readPageState);
    const code = classifySecurity(state);
    if (code) {
      throw new UiError(code, `Meta Business Suite is showing a ${code} state at ${state.url}. Resolve it manually in Chrome, then retry.`);
    }
    return state;
  }

  /** Navigate and wait until the Page scope is known; verifies it is the configured Page. */
  async open(url) {
    await this.page.goto(url, { waitUntil: 'load', settleMs: 1500 });
    const waited = await this.waitFor(readPageState, s => !!s.scope || !!classifySecurity(s));
    const state = waited.value || {};
    const code = classifySecurity(state);
    if (code) throw new UiError(code, `Meta Business Suite is showing a ${code} state at ${state.url}. Resolve it manually in Chrome, then retry.`);
    if (!state.scope && this.pageId && url.includes(`asset_id=${this.pageId}`)) {
      throw new UiError('page_not_found', `Business Suite did not open Page ${this.pageId}: the logged-in account probably does not manage this Page (or the link points to another Page). Nothing was read or sent.`);
    }
    if (!state.scope) throw new UiError('layout_changed', `Could not identify the selected Page at ${state.url || url}; the Business Suite layout may have changed.`, { transient: true });
    return state;
  }

  verifyScope(state) {
    if (state.scope.id !== this.pageId) {
      throw new UiError('page_mismatch', `Business Suite selected Page ${state.scope.id} (${state.scope.name}), expected ${this.pageId}. Nothing was read or sent.`);
    }
    if (this.config.pageName && !sameName(state.scope.name, this.config.pageName)) {
      throw new UiError('page_mismatch', `Business Suite selected Page "${state.scope.name}", expected "${this.config.pageName}". Nothing was read or sent.`);
    }
    this.pageName = state.scope.name;
  }

  pageCacheFile() {
    return path.join(this.config.stateDir, 'page-cache.json');
  }

  readPageCache() {
    try { return JSON.parse(fs.readFileSync(this.pageCacheFile(), 'utf8')); } catch { return {}; }
  }

  writePageCache(url, entry) {
    const cache = this.readPageCache();
    cache[url] = { ...entry, resolved_at: new Date().toISOString() };
    try {
      fs.mkdirSync(this.config.stateDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(this.pageCacheFile(), JSON.stringify(cache, null, 2), { mode: 0o600 });
    } catch { /* cache is an optimization only */ }
  }

  /** Fanpage link -> Business Suite asset id (cached per link). */
  async resolvePageUrl() {
    const parsed = parsePageUrl(this.config.pageUrl);
    if (parsed.pageId) return parsed.pageId;
    const cached = this.readPageCache()[parsed.url];
    if (cached?.page_id) return cached.page_id;
    await this.page.goto(parsed.url, { waitUntil: 'load', settleMs: 1500 });
    const waited = await this.waitFor(readPageIdentity, s => s.delegates.length > 0 || s.owners.length > 0 || !!classifySecurity({ ...s, scope: null }));
    const info = waited.value || {};
    const code = classifySecurity({ ...info, scope: null });
    if (code) throw new UiError(code, `Facebook is showing a ${code} state at ${info.url}. Resolve it manually in Chrome, then retry.`);
    const ids = info.delegates?.length ? info.delegates : (info.owners || []);
    if (ids.length !== 1) {
      throw new UiError('page_not_found', `Could not read a single Page id from ${parsed.url} (found: ${ids.join(', ') || 'none'}). Check the link, or set MESSENGER_PAGE_ID.`);
    }
    this.writePageCache(parsed.url, { page_id: ids[0], profile_id: info.owners?.[0] || null, vanity: info.vanity?.[0] || null, title: info.title });
    return ids[0];
  }

  /** Resolve the target Page once: MESSENGER_PAGE_ID, then the fanpage link, then the name. */
  async resolvePage() {
    if (this.pageId && (!this.config.pageUrl || this.pageUrlChecked)) return this.pageId;
    if (this.config.pageUrl) {
      const fromUrl = await this.resolvePageUrl();
      this.pageUrlChecked = true;
      if (this.pageId && this.pageId !== fromUrl) {
        throw new UiError('page_mismatch', `Page link ${this.config.pageUrl} is Page ${fromUrl}, but MESSENGER_PAGE_ID is ${this.pageId}.`);
      }
      this.pageId = fromUrl;
      return this.pageId;
    }
    if (this.pageId) return this.pageId;
    const state = await this.open(this.config.inboxUrl);
    if (sameName(state.scope.name, this.config.pageName)) {
      this.pageId = state.scope.id;
      return this.pageId;
    }
    const pages = await this.page.evaluate(readPageList);
    const match = pages.filter(p => sameName(p.name, this.config.pageName));
    if (match.length !== 1) {
      const names = pages.map(p => p.name).join(', ') || '(none visible)';
      throw new UiError('page_not_found', `${match.length ? 'Several Pages' : 'No Page'} named "${this.config.pageName}" found. Available: ${names}. Set MESSENGER_PAGE_ID to disambiguate.`);
    }
    this.pageId = match[0].id;
    return this.pageId;
  }

  async checkSession() {
    await this.resolvePage();
    const state = await this.open(this.url());
    this.verifyScope(state);
    return { page_id: this.pageId, page_name: this.pageName, url: state.url };
  }

  async listConversations({ limit = 20 } = {}) {
    await this.checkSession();
    const waited = await this.waitFor(readThreadList, v => v !== null && v.pageID != null);
    if (!waited.ok) throw new UiError('layout_changed', 'Inbox conversation list was not found; the Business Suite layout may have changed.', { transient: true });
    if (waited.value.pageID !== this.pageId) {
      throw new UiError('page_mismatch', `Conversation list belongs to Page ${waited.value.pageID}, expected ${this.pageId}.`);
    }
    return waited.value.threads
      .filter(t => t.threadFBID && (!t.inboxID || t.inboxID === this.pageId))
      .map(t => normalizeThread(t, { pageId: this.pageId }))
      .slice(0, limit);
  }

  /**
   * Open one conversation and read the messages rendered in it. Verifies the
   * Page, the selected conversation and that every inbound message came from
   * that conversation's customer before returning anything.
   */
  async readMessages(conversationId, { navigate = true } = {}) {
    conversationId = String(conversationId);
    await this.resolvePage();
    if (navigate) {
      const state = await this.open(this.url({ conversationId }));
      this.verifyScope(state);
    } else {
      const state = await this.assertSafe();
      if (!state.scope) throw new UiError('layout_changed', 'Selected Page is no longer identifiable.', { transient: true });
      this.verifyScope(state);
    }
    let previousCount = null;
    let stableReads = 0;
    const waited = await this.waitFor(readOpenThread, (t) => {
      if (t.selected !== conversationId || !t.composer.present) return false;
      if (t.messages.some(m => m.unresolved) || t.loading) { stableReads = 0; return false; }
      // Business Suite first paints the cached last message, then fetches the
      // rest: require the list to stay unchanged for several reads.
      const signature = t.messages.map(m => m.id).join('|');
      stableReads = signature === previousCount ? stableReads + 1 : 0;
      previousCount = signature;
      return t.messages.length > 0 && stableReads >= 4;
    });
    const thread = waited.value;
    if (!waited.ok) {
      if (thread && thread.selected && thread.selected !== conversationId) {
        throw new UiError('conversation_mismatch', `Business Suite opened conversation ${thread.selected}, expected ${conversationId}.`);
      }
      throw new UiError('thread_not_loaded', `Conversation ${conversationId} did not load its messages in time.`, { transient: true });
    }
    if (thread.assetId && thread.assetId !== this.pageId) {
      throw new UiError('page_mismatch', `Open thread belongs to asset ${thread.assetId}, expected ${this.pageId}.`);
    }
    const messages = thread.messages.map(raw => normalizeMessage(raw, { pageId: this.pageId, conversationId }));
    const foreign = messages.find(m => m.direction === 'inbound' && m.sender_id && m.sender_id !== conversationId);
    if (foreign) {
      throw new UiError('conversation_mismatch', `Inbound message ${foreign.message_key} is from ${foreign.sender_id}, not conversation ${conversationId}. Nothing will be sent.`);
    }
    return { page_id: this.pageId, page_name: this.pageName, conversation_id: conversationId, messages, composer: thread.composer, raw: thread.messages };
  }

  /**
   * Type into the focused reply box. Human-like by default (bursts, jittered
   * pauses, Shift+Enter for line breaks); MESSENGER_HUMAN_TYPING=false pastes
   * each line at once. Returns timing facts for the result row.
   */
  async typeText(text) {
    const started = Date.now();
    if (!this.config.humanTyping) {
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (i > 0) await this.page.pressKey('Shift+Enter');
        if (lines[i]) await this.page.insertText(lines[i]);
      }
      return { typing: 'paste', typing_ms: Date.now() - started };
    }
    const steps = planTyping(text, { cps: this.config.typingCps, maxMs: this.config.typingMaxMs });
    let refocus = false;
    for (const step of steps) {
      const t0 = Date.now();
      // Lexical can restore a stale selection after a pause: put the caret back at the end.
      if (refocus) await this.page.evaluate(focusComposer);
      if (step.kind === 'newline') await this.page.pressKey('Shift+Enter');
      else await this.page.insertText(step.text);
      const wait = step.delayMs - (Date.now() - t0);
      if (wait > 0) await this.sleep(wait);
      refocus = step.delayMs >= 500;
    }
    return { typing: 'human', typing_steps: steps.length, typing_ms: Date.now() - started };
  }

  /**
   * Show the customer that the Page is typing while Hermes works: every few
   * seconds type one character into the empty reply box and delete it. The box
   * is empty between ticks, and stop() waits for the last tick and verifies it
   * is empty again. Never starts if the box already holds a draft.
   */
  async startTypingIndicator({ intervalMs = this.config.typingIndicatorIntervalMs } = {}) {
    if (typeof this.page.insertText !== 'function' || typeof this.page.pressKey !== 'function') return null;
    const focus = await this.page.evaluate(focusComposer);
    if (!focus.focused || focus.text) return null;
    let stopped = false;
    let ticks = 0;
    const tick = async () => {
      if (stopped) return;
      await this.page.evaluate(focusComposer);
      await this.page.insertText('.');
      await this.sleep(350 + Math.floor(Math.random() * 300));
      await this.page.pressKey('Backspace');
      ticks++;
    };
    let chain = tick().catch(() => {});
    const timer = setInterval(() => { chain = chain.then(tick).catch(() => {}); }, intervalMs);
    return {
      stop: async () => {
        stopped = true;
        clearInterval(timer);
        await chain;
        const t = await this.page.evaluate(readOpenThread);
        let clean = !t.composer.text;
        if (!clean) clean = await this.clearComposer();
        if (!clean) throw new UiError('composer_not_empty', 'Could not clear the reply box after the typing indicator.');
        return { ticks };
      },
    };
  }

  async clearComposer() {
    await this.page.evaluate(focusComposer);
    await this.page.pressKey('Control+a');
    await this.page.pressKey('Backspace');
    const after = await this.page.evaluate(readOpenThread);
    return !after.composer.text;
  }

  /**
   * Type and send a text reply in the open conversation, then confirm the new
   * outbound message is rendered. Never sends twice: if the first attempt's
   * outcome cannot be confirmed the error carries `sendMayHaveHappened`.
   */
  async sendTextReply(conversationId, text, { expectedLastMessageKey, dryRun = false, navigate = true } = {}) {
    if (typeof this.page.insertText !== 'function' || typeof this.page.pressKey !== 'function') {
      throw new UiError('bridge_unsupported', 'Browser Bridge lacks insertText/pressKey support; update OpenCLI.');
    }
    const before = await this.readMessages(conversationId, { navigate });
    const last = before.messages[before.messages.length - 1];
    if (expectedLastMessageKey && last?.message_key !== expectedLastMessageKey) {
      throw new UiError('conversation_changed', 'New messages arrived since the conversation was read; it will be processed again.', { transient: true });
    }
    if (before.composer.text) {
      throw new UiError('composer_not_empty', 'The reply box already contains a draft (possibly typed by a person). Not sending.');
    }
    const focus = await this.page.evaluate(focusComposer);
    if (!focus.focused) throw new UiError('composer_not_found', `Could not focus the reply box (${focus.reason || 'unknown'}).`, { transient: true });

    const typing = await this.typeText(text);
    await this.sleep(300);
    const typed = await this.page.evaluate(readOpenThread);
    if (comparableText(typed.composer.text) !== comparableText(text)) {
      await this.clearComposer().catch(() => {});
      throw new UiError('composer_mismatch', 'Reply box content did not match the reply after typing; cleared it and did not send.', { transient: true });
    }
    if (dryRun) {
      const cleared = await this.clearComposer();
      return { sent: false, dry_run: true, composer_verified: true, composer_cleared: cleared, ...typing };
    }

    const beforeIds = new Set(before.messages.map(m => m.message_key));
    const isOurs = m => m.direction === 'outbound' && !beforeIds.has(m.message_key) && comparableText(m.text) === comparableText(text);
    const findSent = (t) => t.messages
      .map(raw => normalizeMessage(raw, { pageId: this.pageId, conversationId }))
      .find(isOurs);

    await this.page.pressKey('Enter');
    let method = 'enter';
    let check = await this.waitFor(readOpenThread, t => !!findSent(t) || !t.composer.text, { timeoutMs: 4000 });
    if (!check.ok && check.value?.composer?.text && comparableText(check.value.composer.text) === comparableText(text)) {
      // Enter did not submit (text still in the box, nothing new rendered): safe to click Send once.
      const click = await this.page.evaluate(clickSendButton);
      if (!click.clicked) {
        await this.clearComposer().catch(() => {});
        throw new UiError('send_button_not_found', `Could not submit the reply (${click.reason}); cleared the reply box.`, { transient: true });
      }
      method = 'button';
    }
    check = await this.waitFor(readOpenThread, t => !!findSent(t), { timeoutMs: this.config.uiTimeoutMs });
    const sent = check.ok ? findSent(check.value) : null;
    if (!sent) {
      const error = new UiError('send_unverified', 'Reply was submitted but did not appear in the conversation in time. Check the conversation manually; it will not be re-sent automatically.');
      error.sendMayHaveHappened = true;
      throw error;
    }
    return { sent: true, verified: true, method, message_id: sent.message_key, timestamp: sent.timestamp, ...typing };
  }
}
