// Browser-side functions passed to page.evaluate(fn, ...args). Each one must be
// self-contained (it is serialized with fn.toString()). Arguments are passed as
// JSON by OpenCLI, never concatenated into code.
//
// Meta Business Suite renders the inbox with React. Stable identifiers are
// read from React props (thread FBID, message IDs, isFromViewer) and the
// `data-message-id` / `data-surface` attributes instead of generated CSS classes.

/** Login / checkpoint / unexpected layout detection plus the selected Page scope. */
export function readPageState() {
  const url = location.href;
  const body = (document.body && document.body.innerText) || '';
  const title = document.title || '';
  let scope = null;
  const surface = document.querySelector('[data-surface*="business_scope:page:"]');
  if (surface) {
    const m = surface.getAttribute('data-surface').match(/business_scope:page:(\d+):([^/]*)/);
    if (m) scope = { id: m[1], name: m[2], source: 'data-surface' };
  }
  const html = scope ? '' : document.documentElement.innerHTML;
  if (!scope) {
    const m = html.match(/"current_scope":\{[^{}]*?"scope_id":"(\d+)","scope_name":"((?:[^"\\]|\\.)*)"/);
    if (m) { try { scope = { id: m[1], name: JSON.parse(`"${m[2]}"`), source: 'current_scope' }; } catch { /* ignore */ } }
  }
  return {
    url,
    title,
    host: location.host,
    path: location.pathname,
    bodyText: body.slice(0, 4000),
    scope,
    hasInbox: !!document.querySelector('[aria-label^="Message list container"]') || /\/latest\/inbox/.test(location.pathname),
    readyState: document.readyState,
  };
}

/** Pages the logged-in account can manage, as embedded in Business Suite bootstrap data. */
export function readPageList() {
  const html = document.documentElement.innerHTML;
  const out = [];
  const seen = new Set();
  const re = /"asset_type":"PAGE","asset_id":"(\d+)","name":"((?:[^"\\]|\\.)*)"/g;
  let m;
  while ((m = re.exec(html))) {
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    let name = m[2];
    try { name = JSON.parse(`"${m[2]}"`); } catch { /* keep raw */ }
    out.push({ id: m[1], name });
  }
  return out;
}

/** Thread list from the inbox list's React props. Returns null when the list is not rendered. */
export function readThreadList() {
  const rows = document.querySelectorAll('div[role="presentation"]');
  for (const row of rows) {
    const key = Object.keys(row).find(k => k.startsWith('__reactFiber'));
    if (!key) continue;
    let fiber = row[key];
    for (let i = 0; i < 40 && fiber; i++, fiber = fiber.return) {
      const p = fiber.memoizedProps;
      if (p && Array.isArray(p.threadList)) {
        return {
          pageID: p.pageID ? String(p.pageID) : null,
          canLoadMore: !!p.canLoadMoreRows,
          threads: p.threadList.map(t => ({
            threadFBID: t.threadFBID != null ? String(t.threadFBID) : null,
            threadID: t.threadID || null,
            threadType: t.threadType || null,
            commPlatform: t.commPlatform || null,
            inboxID: t.inboxID != null ? String(t.inboxID) : null,
            title: t.title || '',
            snippetText: t.snippetText || '',
            isRead: t.isRead,
            isGroupThread: !!t.isGroupThread,
            timestamp: t.timestamp || 0,
          })),
        };
      }
    }
  }
  return null;
}

/** Messages of the currently open thread plus composer/selection facts. */
export function readOpenThread() {
  const params = new URLSearchParams(location.search);
  const nodes = document.querySelectorAll('[data-message-id]');
  const byId = new Map();
  let index = 0;
  for (const el of nodes) {
    const key = Object.keys(el).find(k => k.startsWith('__reactFiber'));
    let fiber = key ? el[key] : null;
    let found = null;
    for (let i = 0; i < 25 && fiber; i++, fiber = fiber.return) {
      const p = fiber.memoizedProps;
      if (p && p.message && p.message.messageID) { found = p; break; }
    }
    const domId = el.getAttribute('data-message-id');
    if (!found) {
      if (!byId.has(domId)) byId.set(domId, { id: domId, unresolved: true, order: index++ });
      continue;
    }
    const m = found.message;
    if (byId.has(m.messageID) && !byId.get(m.messageID).unresolved) continue;
    const sender = m.sender || {};
    byId.set(m.messageID, {
      id: m.messageID,
      from_viewer: typeof found.isFromViewer === 'boolean' ? found.isFromViewer : null,
      sender_id: sender.userID != null ? String(sender.userID) : (sender.id != null ? String(sender.id) : null),
      sender_name: sender.name || null,
      text: m.textPayload && typeof m.textPayload.text === 'string' ? m.textPayload.text : null,
      timestamp: m.timestamp || null,
      attachments: Array.isArray(m.attachments) ? m.attachments.length : 0,
      is_log: !!m.logMessage,
      is_template: !!m.templatedMessagePayload,
      order: index++,
    });
  }
  const composer = document.querySelector('[contenteditable="true"][data-lexical-editor="true"]')
    || document.querySelector('[role="textbox"][contenteditable="true"]');
  const container = document.querySelector('[aria-label^="Message list container"]');
  const loading = !!(container && container.querySelector('[role="progressbar"], [aria-busy="true"], [data-visualcompletion="loading-state"]'));
  return {
    url: location.href,
    loading,
    selected: params.get('selected_item_id'),
    assetId: params.get('asset_id'),
    messages: [...byId.values()].sort((a, b) => a.order - b.order),
    composer: composer ? { present: true, text: composer.innerText.replace(/​/g, '').trim(), placeholder: composer.getAttribute('aria-placeholder') || '' } : { present: false },
  };
}

/** Focus the reply composer and put the caret at the end. */
export function focusComposer() {
  const el = document.querySelector('[contenteditable="true"][data-lexical-editor="true"]')
    || document.querySelector('[role="textbox"][contenteditable="true"]');
  if (!el) return { focused: false, reason: 'composer_not_found' };
  el.scrollIntoView({ block: 'center' });
  el.focus();
  const sel = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  sel.removeAllRanges();
  sel.addRange(range);
  return { focused: document.activeElement === el || el.contains(document.activeElement), text: el.innerText.replace(/​/g, '').trim() };
}

/** Click the composer's send button (aria-label Submit/Send) nearest to the composer. */
export function clickSendButton() {
  const composer = document.querySelector('[contenteditable="true"][data-lexical-editor="true"]');
  if (!composer) return { clicked: false, reason: 'composer_not_found' };
  const selector = '[role="button"][aria-label="Submit"], [role="button"][aria-label="Send"], [role="button"][aria-label="Gửi"]';
  let node = composer.parentElement;
  for (let i = 0; i < 12 && node; i++, node = node.parentElement) {
    const btn = node.querySelector(selector);
    if (btn) {
      if (btn.getAttribute('aria-disabled') === 'true') return { clicked: false, reason: 'send_disabled' };
      btn.click();
      return { clicked: true, label: btn.getAttribute('aria-label') };
    }
  }
  return { clicked: false, reason: 'send_button_not_found' };
}

/**
 * On a facebook.com Page (vanity or profile URL): the Business Suite asset id is
 * the classic Page id exposed as `delegate_page.id`; `profile_owner.id` is the
 * Page's profile id and is only a fallback.
 */
export function readPageIdentity() {
  const html = document.documentElement.innerHTML;
  const uniq = re => [...new Set([...html.matchAll(re)].map(m => m[1]))];
  return {
    url: location.href,
    title: document.title || '',
    bodyText: ((document.body && document.body.innerText) || '').slice(0, 2000),
    delegates: uniq(/"delegate_page":\{"id":"(\d+)"/g),
    owners: uniq(/"profile_owner":\{"id":"(\d+)"/g),
    vanity: uniq(/"userVanity":"([^"]*)"/g),
  };
}
