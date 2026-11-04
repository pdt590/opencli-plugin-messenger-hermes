// Plugin-internal error with a machine-readable code. Commands translate these
// into OpenCLI CliError subclasses (see cli-common.js) at the boundary.
export class UiError extends Error {
  constructor(code, message, { transient = false, details } = {}) {
    super(message);
    this.name = 'UiError';
    this.code = code;
    this.transient = transient;
    this.details = details;
  }
}

/** UI states in which nothing may be read or sent until a human intervenes. */
export const BLOCKING_UI_CODES = new Set(['logged_out', 'checkpoint', 'captcha', 'page_mismatch', 'page_not_found']);
