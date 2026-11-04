// Configuration: environment variables override an optional JSON file.
// The file lives at $MESSENGER_HERMES_CONFIG or ~/.opencli/messenger-hermes/config.json
// and uses the same keys as the environment variables. No secrets belong here:
// the browser session is owned by OpenCLI/Chrome and Hermes owns its own credentials.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_STATE_DIR = path.join(os.homedir(), '.opencli', 'messenger-hermes');
export const DEFAULT_INBOX_URL = 'https://business.facebook.com/latest/inbox/messenger';

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
    this.code = 'config_invalid';
  }
}

function readFileConfig(env) {
  const file = env.MESSENGER_HERMES_CONFIG
    || path.join(env.MESSENGER_HERMES_STATE_DIR || DEFAULT_STATE_DIR, 'config.json');
  if (!fs.existsSync(file)) return { file: null, values: {} };
  try {
    const values = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('top level must be an object');
    return { file, values };
  } catch (error) {
    throw new ConfigError(`Cannot read config file ${file}: ${error.message}`);
  }
}

function int(raw, name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ConfigError(`${name} must be an integer between ${min} and ${max}. Received: ${raw}`);
  }
  return value;
}

function bool(raw, fallback) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  if (typeof raw === 'boolean') return raw;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).toLowerCase());
}

function list(raw) {
  if (raw === undefined || raw === null || raw === '') return [];
  const values = Array.isArray(raw) ? raw : String(raw).split(',');
  return values.map(v => String(v).trim()).filter(Boolean);
}

function argv(raw, name) {
  if (raw === undefined || raw === null || raw === '') return null;
  if (Array.isArray(raw)) return raw.map(String);
  try {
    const parsed = JSON.parse(String(raw));
    if (Array.isArray(parsed) && parsed.every(v => typeof v === 'string')) return parsed;
  } catch { /* fall through */ }
  throw new ConfigError(`${name} must be a JSON array of strings, e.g. ["chat","-Q"]`);
}

/**
 * Default Hermes invocation: one-shot, prompt on stdin. Without a profile it runs
 * in --safe-mode (no user config, rules, plugins or MCP). With a profile
 * (`hermes -p <profile>`) the profile's own model, persona (SOUL.md) and config
 * are used, so safe mode is off unless HERMES_SAFE_MODE=true is set explicitly.
 */
export function defaultHermesArgs({ profile, provider, model, toolsets, safeMode }) {
  const args = [];
  if (profile) args.push('-p', profile);
  args.push('chat', '-Q', '--query-file', '-', '--source', 'tool', '--max-turns', '1');
  if (toolsets) args.push('-t', toolsets);
  if (safeMode) args.push('--safe-mode');
  if (provider) args.push('--provider', provider);
  if (model) args.push('--model', model);
  return args;
}

const PROFILE_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const WATCHER_ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const SESSION_SCOPES = ['conversation', 'watcher', 'oneshot'];

/**
 * @param env process environment
 * @param overrides values from command-line flags (same keys as env); they win over env and file
 */
export function loadConfig(env = process.env, overrides = {}) {
  const { file, values } = readFileConfig(env);
  const present = v => v !== undefined && v !== null && v !== '';
  const get = key => (present(overrides[key]) ? overrides[key] : present(env[key]) ? env[key] : values[key]);
  const stateDir = path.resolve(String(get('MESSENGER_HERMES_STATE_DIR') || DEFAULT_STATE_DIR));

  const profile = get('HERMES_PROFILE') ? String(get('HERMES_PROFILE')).trim() : '';
  if (profile && !PROFILE_RE.test(profile)) throw new ConfigError(`HERMES_PROFILE "${profile}" is not a valid Hermes profile name`);
  const safeMode = bool(get('HERMES_SAFE_MODE'), !profile);
  // --safe-mode ignores the profile config, so the model must then be explicit.
  const provider = get('HERMES_PROVIDER') || (safeMode ? 'anthropic' : '');
  const model = get('HERMES_MODEL') || (safeMode ? 'claude-sonnet-5-5' : '');
  const pageUrl = get('MESSENGER_PAGE_URL') ? String(get('MESSENGER_PAGE_URL')).trim() : '';
  if (pageUrl) validatePageUrl(pageUrl);
  const toolsets = get('HERMES_TOOLSETS') ?? 'clarify';

  const config = {
    configFile: file,
    pageName: get('MESSENGER_PAGE_NAME') ? String(get('MESSENGER_PAGE_NAME')).normalize('NFC').trim() : '',
    pageId: get('MESSENGER_PAGE_ID') ? String(get('MESSENGER_PAGE_ID')).trim() : '',
    pageUrl,
    hermesProfile: profile,
    inboxUrl: String(get('MESSENGER_INBOX_URL') || DEFAULT_INBOX_URL),
    pollIntervalMs: int(get('MESSENGER_POLL_INTERVAL_MS'), 'MESSENGER_POLL_INTERVAL_MS', 15_000, { min: 5_000 }),
    maxConversationsPerPoll: int(get('MESSENGER_MAX_CONVERSATIONS_PER_POLL'), 'MESSENGER_MAX_CONVERSATIONS_PER_POLL', 10, { min: 1, max: 100 }),
    maxMessageAgeMin: int(get('MESSENGER_MAX_MESSAGE_AGE_MIN'), 'MESSENGER_MAX_MESSAGE_AGE_MIN', 1440, { min: 1 }),
    historyMessages: int(get('MESSENGER_HISTORY_MESSAGES'), 'MESSENGER_HISTORY_MESSAGES', 12, { min: 0, max: 100 }),
    maxContextChars: int(get('MESSENGER_MAX_CONTEXT_CHARS'), 'MESSENGER_MAX_CONTEXT_CHARS', 6000, { min: 500 }),
    uiTimeoutMs: int(get('MESSENGER_UI_TIMEOUT_MS'), 'MESSENGER_UI_TIMEOUT_MS', 25_000, { min: 3000 }),
    allowedSenderIds: list(get('ALLOWED_SENDER_IDS')),
    hermesBin: String(get('HERMES_BIN') || 'hermes'),
    hermesArgs: argv(get('HERMES_ARGS'), 'HERMES_ARGS') || defaultHermesArgs({ profile, provider, model, toolsets, safeMode }),
    hermesArgsCustom: !!get('HERMES_ARGS'),
    hermesSessionScope: sessionScope(get('HERMES_SESSION_SCOPE')),
    // Set by scripts/watch.js for its poll runs, so every watcher (`start`) gets
    // its own Hermes sessions and workdir. Manual commands use "cli".
    watcherId: watcherId(env.MESSENGER_HERMES_WATCHER_ID),
    hermesWorkdir: path.resolve(String(get('HERMES_WORKDIR') || path.join(stateDir, 'hermes-workdir'))),
    hermesTimeoutMs: int(get('HERMES_TIMEOUT_MS'), 'HERMES_TIMEOUT_MS', 180_000, { min: 5000 }),
    hermesMaxOutputBytes: int(get('HERMES_MAX_OUTPUT_BYTES'), 'HERMES_MAX_OUTPUT_BYTES', 64 * 1024, { min: 1024 }),
    hermesMaxAttempts: int(get('HERMES_MAX_ATTEMPTS'), 'HERMES_MAX_ATTEMPTS', 3, { min: 1, max: 10 }),
    retryBaseMs: int(get('MESSENGER_RETRY_BASE_MS'), 'MESSENGER_RETRY_BASE_MS', 30_000, { min: 1000 }),
    systemPromptFile: get('HERMES_SYSTEM_PROMPT_FILE') ? path.resolve(String(get('HERMES_SYSTEM_PROMPT_FILE'))) : '',
    humanTyping: bool(get('MESSENGER_HUMAN_TYPING'), true),
    typingCps: int(get('MESSENGER_TYPING_CPS'), 'MESSENGER_TYPING_CPS', 15, { min: 1, max: 100 }),
    typingMaxMs: int(get('MESSENGER_TYPING_MAX_MS'), 'MESSENGER_TYPING_MAX_MS', 10_000, { min: 0, max: 300_000 }),
    typingIndicator: bool(get('MESSENGER_TYPING_INDICATOR'), true),
    typingIndicatorIntervalMs: int(get('MESSENGER_TYPING_INDICATOR_INTERVAL_MS'), 'MESSENGER_TYPING_INDICATOR_INTERVAL_MS', 3000, { min: 1000, max: 30_000 }),
    maxReplyLength: int(get('MAX_REPLY_LENGTH'), 'MAX_REPLY_LENGTH', 2000, { min: 20, max: 20_000 }),
    stateDir,
    logContent: bool(get('MESSENGER_HERMES_LOG_CONTENT'), false),
    logStderr: bool(get('MESSENGER_HERMES_LOG_STDERR'), false),
    retentionDays: int(get('MESSENGER_RETENTION_DAYS'), 'MESSENGER_RETENTION_DAYS', 30, { min: 1 }),
  };
  return config;
}

function sessionScope(raw) {
  const value = raw ? String(raw).trim().toLowerCase() : 'conversation';
  if (!SESSION_SCOPES.includes(value)) throw new ConfigError(`HERMES_SESSION_SCOPE must be one of ${SESSION_SCOPES.join(', ')}`);
  return value;
}

function watcherId(raw) {
  if (!raw) return 'cli';
  if (!WATCHER_ID_RE.test(String(raw))) throw new ConfigError('MESSENGER_HERMES_WATCHER_ID must be lowercase letters, digits or dashes');
  return String(raw);
}

/**
 * Hermes session name for one reply, or null for a one-shot run.
 * conversation: one session per (watcher, customer conversation) -- default, no cross-customer context
 * watcher:      one session per watcher, shared by all its conversations
 * oneshot:      a fresh session every time
 */
export function hermesSessionName(config, conversationId) {
  if (config.hermesSessionScope === 'oneshot') return null;
  if (config.hermesSessionScope === 'watcher') return `mh-${config.watcherId}`;
  return `mh-${config.watcherId}-${conversationId}`;
}

export function requirePageConfig(config) {
  if (!config.pageName && !config.pageId && !config.pageUrl) {
    throw new ConfigError('Give the fanpage with --page-url <link>, or set MESSENGER_PAGE_URL / MESSENGER_PAGE_NAME / MESSENGER_PAGE_ID.');
  }
  return config;
}

/** Shape safe to print: never includes prompts, message text or session data. */
export function describeConfig(config) {
  return {
    config_file: config.configFile,
    page_url: config.pageUrl || null,
    page_name: config.pageName || null,
    page_id: config.pageId || null,
    hermes_profile: config.hermesProfile || '(default)',
    hermes_session_scope: config.hermesSessionScope,
    inbox_url: config.inboxUrl,
    poll_interval_ms: config.pollIntervalMs,
    max_message_age_min: config.maxMessageAgeMin,
    allowed_sender_ids: config.allowedSenderIds.length ? config.allowedSenderIds.join(',') : '(all)',
    hermes_bin: config.hermesBin,
    hermes_args: config.hermesArgs.join(' '),
    hermes_timeout_ms: config.hermesTimeoutMs,
    max_reply_length: config.maxReplyLength,
    state_dir: config.stateDir,
  };
}

const FB_HOST = /(^|\.)(facebook\.com|fb\.com)$/i;

export function validatePageUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new ConfigError(`Page URL is not a valid URL: ${raw}`); }
  if (!/^https?:$/.test(u.protocol) || !FB_HOST.test(u.hostname)) {
    throw new ConfigError(`Page URL must be a facebook.com link, got: ${raw}`);
  }
  return u;
}

/**
 * Parse a fanpage link. Business Suite links carry the Page asset id directly;
 * any other facebook.com link (vanity name, profile.php?id=, numeric path) is
 * resolved in the browser, because the id in such links can be the Page's
 * profile id rather than the asset id Business Suite uses.
 */
export function parsePageUrl(raw) {
  const u = validatePageUrl(raw);
  const assetId = u.searchParams.get('asset_id');
  if (/^business\./i.test(u.hostname) && assetId && /^\d+$/.test(assetId)) return { pageId: assetId, url: u.toString() };
  const path = u.pathname.replace(/\/+$/, '') || '/';
  if (path === '/' && !u.searchParams.get('id')) throw new ConfigError(`Page URL has no Page in it: ${raw}`);
  const canonical = new URL(`https://www.facebook.com${path}`);
  if (path === '/profile.php' && u.searchParams.get('id')) canonical.searchParams.set('id', u.searchParams.get('id'));
  return { pageId: null, url: canonical.toString() };
}

/** Worst-case seconds for one conversation (read + Hermes + human typing + send verification). */
export function perConversationSeconds(config) {
  return Math.ceil((config.hermesTimeoutMs + config.typingMaxMs + 4 * config.uiTimeoutMs + 30_000) / 1000);
}
