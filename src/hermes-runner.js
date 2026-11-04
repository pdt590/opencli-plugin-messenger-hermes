// HermesRunner: spawns the Hermes CLI without a shell, passes the prompt on
// stdin (never in argv, so it is not visible in the process list), enforces a
// timeout and an output cap, and parses/validates the JSON reply contract.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

export class HermesError extends Error {
  constructor(code, message, { transient = false, exitCode = null, durationMs = null } = {}) {
    super(message);
    this.name = 'HermesError';
    this.code = code;
    this.transient = transient;
    this.exitCode = exitCode;
    this.durationMs = durationMs;
  }
}

// A stored session that cannot be resumed (deleted, or a policy conflict): start a new one.
const RESUME_UNUSABLE = /session not found|creation overrides are unsupported on resume|resume retains/i;
const SESSION_ID = /(?:session_id|Session)\s*:\s*(local-[0-9a-f]+|[A-Za-z0-9_-]{8,})/g;

const CREATION_ONLY = new Set(['-t', '--toolsets', '--max-turns']);
export function stripCreationOverrides(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (CREATION_ONLY.has(args[i])) { i++; continue; }
    if (/^(--toolsets|--max-turns)=/.test(args[i])) continue;
    out.push(args[i]);
  }
  return out;
}

export function parseSessionId({ stdout = '', stderr = '' }) {
  const ids = [...`${stderr}\n${stdout}`.matchAll(SESSION_ID)].map(m => m[1]);
  return ids.length ? ids[ids.length - 1] : null;
}

/** Last meaningful error line(s) from Hermes, for logs and the result row (no prompt text). */
export function errorTail({ stdout = '', stderr = '' }) {
  const lines = `${stderr}\n${stdout}`.replace(/\u001b\[[0-9;?]*[ -\/]*[@-~]/g, '').split('\n')
    .map(l => l.trim()).filter(l => l && !/^(session_id|Session)\s*:/i.test(l) && !l.startsWith('↻'));
  return lines.slice(-2).join(' ').slice(0, 300);
}

const ANSI = /\u001b\[[0-9;?]*[ -\/]*[@-~]|\u001b\][^\u0007]*\u0007/g;
const PERMANENT_STDERR = /invalid_params|unauthori[sz]ed|authentication|api[ _-]?key|credential|not logged in|unknown or invalid|read no profile default|no such (model|provider)|HTTP 40[13]|oauth token|rejected your sign-in|sign in again|auth add|profile '[^']*' does not exist/i;

export function runProcess(bin, args, { input, cwd, timeoutMs, maxOutputBytes, env = process.env, spawnImpl = spawn }) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    let child;
    try {
      child = spawnImpl(bin, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true });
    } catch (error) {
      reject(new HermesError('hermes_spawn_failed', error.message));
      return;
    }
    const out = [];
    const err = [];
    let outBytes = 0;
    let errBytes = 0;
    let settled = false;
    let overflow = false;
    let timedOut = false;
    const finish = (fn) => { if (!settled) { settled = true; clearTimeout(timer); fn(); } };
    const kill = () => {
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
      setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } }, 3000).unref();
    };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      outBytes += chunk.length;
      if (outBytes > maxOutputBytes) { overflow = true; kill(); return; }
      out.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      errBytes += chunk.length;
      if (errBytes <= maxOutputBytes) err.push(chunk);
    });
    child.on('error', (error) => finish(() => reject(new HermesError(
      error.code === 'ENOENT' ? 'hermes_not_found' : 'hermes_spawn_failed',
      error.code === 'ENOENT' ? `Hermes executable not found: ${bin}` : error.message,
    ))));
    child.on('close', (exitCode, signal) => finish(() => {
      const durationMs = Date.now() - started;
      const stdout = Buffer.concat(out).toString('utf8');
      const stderr = Buffer.concat(err).toString('utf8');
      if (timedOut) return reject(new HermesError('hermes_timeout', `Hermes timed out after ${timeoutMs} ms`, { transient: true, durationMs }));
      if (overflow) return reject(new HermesError('hermes_output_too_large', `Hermes output exceeded ${maxOutputBytes} bytes`, { durationMs }));
      resolve({ exitCode, signal, stdout, stderr, durationMs });
    }));
    child.stdin.on('error', () => { /* EPIPE if the CLI exits early; exit code reports it */ });
    child.stdin.end(input, 'utf8');
  });
}

function stripCliNoise(text) {
  return String(text)
    .replace(ANSI, '')
    .split('\n')
    .filter(l => !/^\s*(session_id|Session)\s*:\s*\S+\s*$/i.test(l))
    .join('\n')
    .trim();
}

function candidateJson(text) {
  const out = [];
  for (const m of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) out.push(m[1].trim());
  out.push(text.trim());
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first >= 0 && last > first) out.push(text.slice(first, last + 1));
  // Last resort: the last line that looks like a JSON object.
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.startsWith('{') && l.endsWith('}'));
  if (lines.length) out.push(lines[lines.length - 1]);
  return out;
}

/** Validates `{"reply": string|null, "handoff"?: boolean}` and applies the length cap. */
export function parseHermesOutput(stdout, { maxReplyLength }) {
  const cleaned = stripCliNoise(stdout);
  if (!cleaned) throw new HermesError('hermes_empty_output', 'Hermes returned no output');
  let parsed = null;
  for (const candidate of candidateJson(cleaned)) {
    try {
      const value = JSON.parse(candidate);
      if (value && typeof value === 'object' && !Array.isArray(value) && 'reply' in value) { parsed = value; break; }
    } catch { /* try next */ }
  }
  if (!parsed) throw new HermesError('hermes_invalid_output', 'Hermes output is not the expected JSON object {"reply": ...}');
  const handoff = parsed.handoff === true;
  if (parsed.reply !== null && typeof parsed.reply !== 'string') {
    throw new HermesError('hermes_invalid_output', '"reply" must be a string or null');
  }
  let reply = parsed.reply == null ? '' : String(parsed.reply)
    .replace(/\r\n?/g, '\n')
    .replace(/^\s*(?:\*\*|__)?(?:reply|trả lời)\s*:\s*/i, '')
    .trim();
  if (handoff || !reply) return { reply: null, handoff: true, truncated: false };
  let truncated = false;
  if ([...reply].length > maxReplyLength) {
    const chars = [...reply].slice(0, maxReplyLength - 1).join('');
    const cut = Math.max(chars.lastIndexOf('. '), chars.lastIndexOf('\n'), chars.lastIndexOf(' '));
    reply = `${(cut > maxReplyLength * 0.6 ? chars.slice(0, cut + 1) : chars).trim()}…`;
    truncated = true;
  }
  return { reply, handoff: false, truncated };
}

export class HermesRunner {
  constructor(config, { run = runProcess } = {}) {
    this.config = config;
    this.run = run;
  }

  /** Per-watcher working directory (`--in`); also holds this watcher's session map. */
  workdir() {
    return path.join(this.config.hermesWorkdir, this.config.watcherId || 'cli');
  }

  sessionMapFile() {
    return path.join(this.workdir(), 'sessions.json');
  }

  readSessionMap() {
    try { return JSON.parse(fs.readFileSync(this.sessionMapFile(), 'utf8')); } catch { return {}; }
  }

  writeSessionMap(map) {
    const file = this.sessionMapFile();
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(map, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  /**
   * argv for one run.
   * - new session: the configured args (with -t / --max-turns policy) + --in
   * - resume:      the same args WITHOUT creation-only overrides (-t/--toolsets,
   *                --max-turns), which Hermes rejects on resume; the session keeps
   *                the policy it was launched with.
   */
  buildArgs({ resumeId } = {}) {
    const base = resumeId ? stripCreationOverrides(this.config.hermesArgs) : [...this.config.hermesArgs];
    if (this.config.hermesArgsCustom) return base;
    base.push('--in', this.workdir());
    if (resumeId) base.push('--resume', resumeId);
    return base;
  }

  async generate(prompt, { session } = {}) {
    const c = this.config;
    const cwd = this.workdir();
    fs.mkdirSync(cwd, { recursive: true, mode: 0o700 });
    const useSessions = !!session && !c.hermesArgsCustom;
    const map = useSessions ? this.readSessionMap() : {};
    let resumeId = useSessions ? map[session]?.id : null;

    const call = () => this.run(c.hermesBin, this.buildArgs({ resumeId }), {
      input: prompt, cwd, timeoutMs: c.hermesTimeoutMs, maxOutputBytes: c.hermesMaxOutputBytes,
    });
    let result = await call();
    let sessionReset = false;
    if (resumeId && result.exitCode !== 0 && RESUME_UNUSABLE.test(`${result.stderr}\n${result.stdout}`)) {
      // The stored session is gone or cannot be resumed: start a fresh one once.
      delete map[session];
      resumeId = null;
      sessionReset = true;
      result = await call();
    }
    if (result.exitCode !== 0) {
      const permanent = PERMANENT_STDERR.test(`${result.stderr}\n${result.stdout}`);
      const tail = errorTail(result);
      throw new HermesError(permanent ? 'hermes_config' : 'hermes_exit',
        `Hermes exited with code ${result.exitCode}${result.signal ? ` (${result.signal})` : ''}${tail ? `: ${tail}` : ''}`,
        { transient: !permanent, exitCode: result.exitCode, durationMs: result.durationMs });
    }
    let hermesSessionId = resumeId;
    if (useSessions) {
      hermesSessionId = resumeId || parseSessionId(result);
      if (hermesSessionId) {
        map[session] = { id: hermesSessionId, created_at: map[session]?.created_at || new Date().toISOString(), last_used_at: new Date().toISOString() };
        try { this.writeSessionMap(map); } catch { /* next run just starts a new session */ }
      }
    }
    try {
      return {
        ...parseHermesOutput(result.stdout, { maxReplyLength: c.maxReplyLength }),
        durationMs: result.durationMs,
        hermesSessionId: hermesSessionId || null,
        sessionResumed: !!resumeId,
        sessionReset,
      };
    } catch (error) {
      error.durationMs = result.durationMs;
      throw error;
    }
  }

  /** `hermes profile show <name>` succeeds only for an existing profile. */
  async profileExists() {
    const name = this.config.hermesProfile;
    if (!name) return null;
    try {
      const r = await this.run(this.config.hermesBin, ['profile', 'show', name], { input: '', cwd: process.cwd(), timeoutMs: 20_000, maxOutputBytes: 32_768 });
      return r.exitCode === 0;
    } catch {
      return false;
    }
  }

  /** Cheap availability probe for `status`. */
  async version() {
    try {
      const r = await this.run(this.config.hermesBin, ['--version'], { input: '', cwd: process.cwd(), timeoutMs: 15_000, maxOutputBytes: 8192 });
      return r.exitCode === 0 ? stripCliNoise(r.stdout).split('\n')[0] : null;
    } catch {
      return null;
    }
  }
}
