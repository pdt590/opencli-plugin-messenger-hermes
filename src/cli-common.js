// Shared wiring for the command files: config, store, logger, client, and the
// translation of plugin errors into OpenCLI error types.
import path from 'node:path';
import {
  ArgumentError,
  AuthRequiredError,
  CliError,
  CommandExecutionError,
  ConfigError as CliConfigError,
  LoginWallError,
} from '@jackwener/opencli/errors';
import { loadConfig, requirePageConfig, ConfigError, perConversationSeconds } from './config.js';

export { perConversationSeconds };
import { HermesRunner } from './hermes-runner.js';
import { Logger } from './logger.js';
import { MessengerWebClient } from './messenger-web-client.js';
import { ConversationStore } from './store.js';

export const SITE = 'messenger-hermes';
export const DOMAIN = 'business.facebook.com';

/** Command-line flags shared by the browser commands; they override env/config.json. */
export const PAGE_ARGS = [
  { name: 'page-url', type: 'string', help: 'Fanpage link, e.g. https://www.facebook.com/handsonai (overrides MESSENGER_PAGE_URL)' },
];
export const HERMES_ARGS = [
  { name: 'hermes-profile', type: 'string', help: 'Hermes profile to answer with: runs `hermes -p <profile>` (overrides HERMES_PROFILE)' },
];

/**
 * OpenCLI cuts a browser command after 60 s unless it declares a `timeout` arg.
 * A reply needs: Hermes (HERMES_TIMEOUT_MS) + human typing (MESSENGER_TYPING_MAX_MS)
 * + several UI waits, so these commands declare a generous default.
 */
export function timeoutArg(defaultSeconds) {
  return { name: 'timeout', type: 'int', default: defaultSeconds, help: `Overall command timeout in seconds (default ${defaultSeconds})` };
}

export function flagOverrides(kwargs = {}) {
  const pick = (...names) => names.map(n => kwargs[n]).find(v => v !== undefined && v !== null && v !== '');
  return {
    MESSENGER_PAGE_URL: pick('page-url', 'pageUrl'),
    HERMES_PROFILE: pick('hermes-profile', 'hermesProfile'),
  };
}

export function buildDeps(page, { needPage = true, kwargs } = {}) {
  let config;
  try {
    config = loadConfig(process.env, flagOverrides(kwargs));
    if (needPage) requirePageConfig(config);
  } catch (error) {
    throw toCliError(error);
  }
  const logger = new Logger({ dir: path.join(config.stateDir, 'logs'), logContent: config.logContent, stderr: config.logStderr });
  const store = ConversationStore.open(config.stateDir);
  const client = page ? new MessengerWebClient(page, config, { logger }) : null;
  const hermes = new HermesRunner(config);
  return { config, logger, store, client, hermes };
}

export function toCliError(error) {
  if (!error || error instanceof CliError) return error;
  if (error instanceof ConfigError) return new CliConfigError(error.message, 'See README.md > Configuration.');
  switch (error.code) {
    case 'logged_out':
      return new AuthRequiredError(DOMAIN, error.message, 'Log in to Facebook / Meta Business Suite in the Chrome profile used by OpenCLI, then retry.');
    case 'checkpoint':
    case 'captcha':
      return new LoginWallError(error.message, 200, `https://${DOMAIN}`, '', 'Resolve the checkpoint or CAPTCHA manually in Chrome, then retry.');
    case 'page_not_found':
    case 'page_mismatch':
      return new CliConfigError(error.message, 'Check --page-url (or MESSENGER_PAGE_URL / MESSENGER_PAGE_NAME / MESSENGER_PAGE_ID) and that the logged-in account manages the Page.');
    default:
      return new CommandExecutionError(`[${error.code || 'error'}] ${error.message}`);
  }
}

export async function withDeps(page, fn, opts) {
  const deps = buildDeps(page, opts);
  try {
    return await fn(deps);
  } catch (error) {
    throw toCliError(error);
  } finally {
    deps.store.close();
  }
}

export function requireArg(kwargs, name) {
  const value = kwargs[name];
  if (value === undefined || value === null || String(value).trim() === '') {
    throw new ArgumentError(`--${name} is required`);
  }
  return String(value).trim();
}

export function requireConversationId(kwargs) {
  const id = requireArg(kwargs, 'conversation');
  if (!/^\d{5,25}$/.test(id)) throw new ArgumentError('--conversation must be the numeric conversation id shown by `inbox`');
  return id;
}

export function truncate(text, max = 80) {
  const s = String(text ?? '').replace(/\s+/g, ' ');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
