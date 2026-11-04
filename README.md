# opencli-plugin-messenger-hermes

OpenCLI plugin that answers a Facebook Page's Messenger inbox with **Hermes CLI**.
Everything happens through the **Meta Business Suite inbox UI** in the Chrome
session OpenCLI controls: no Graph API, no Page token, no webhook, no cookies read.

```
Messenger ─▶ Business Suite inbox (Chrome) ─▶ OpenCLI plugin ─▶ filter / dedupe / state (SQLite)
                     ▲                                            │
                     └──────── reply typed + verified ◀── Hermes CLI (stdin, no tools)
```

## Commands

| Command | Access | What it does |
|---|---|---|
| `opencli messenger-hermes status` | read | Login state, selected Page (verified), conversation counts, Hermes version, config. Without `--page-url`: checks the running watcher's Page, or lists the watchers |
| `opencli messenger-hermes inbox [--limit 20] [--unread]` | read | Conversations: id, title, snippet, unread, last activity, auto-reply eligibility |
| `opencli messenger-hermes messages --conversation <id> [--limit 20] [--full]` | read | Normalized messages (message id, direction, sender, timestamp, text, state) |
| `opencli messenger-hermes reply --conversation <id> --text "…" [--dry-run]` | write | Type a reply, verify the reply box, send, confirm it is rendered. `--dry-run` types, verifies and clears |
| `opencli messenger-hermes process --conversation <id> [--message <mid>] [--send]` | write | Answer the unanswered inbound messages of one conversation via Hermes. Dry-run unless `--send` |
| `opencli messenger-hermes poll [--send] [--limit N]` | write | One poll cycle over all conversations with new activity. Dry-run unless `--send` |
| `opencli messenger-hermes state --action stats\|list\|purge\|retry` | local | Inspect / delete / requeue local state (no browser) |
| `opencli messenger-hermes start --page-url L [--hermes-profile P] [--allow ids] [--dry-run]` | local | Start the background auto-reply watcher for that Page+profile (one per target) |
| `opencli messenger-hermes stop [--page-url L] [--hermes-profile P] [--all] [--force]` | local | Stop it after its current poll cycle (no flags: the only running watcher) |
| `node scripts/watch.js [--page-url L] [--hermes-profile P] [--dry-run] [--once]` | — | The watcher loop itself (`poll --send` every `MESSENGER_POLL_INTERVAL_MS`), what `start` runs in the background |

Dry-run modes never send and never write state. A dry-run still types into the
reply box (then clears it), so the customer may briefly see a typing indicator.

## Install / uninstall

Requirements: Node ≥ 22.13, OpenCLI 2.x with the Browser Bridge extension
connected (`opencli doctor`), Chrome logged in to a Facebook account that
manages the Page, and Hermes CLI installed and logged in.

The scripts only install or remove the plugin. The fanpage and the Hermes profile are
not part of the installation; they are given when the plugin runs (next section).

```bash
./install.sh               # checks Node/OpenCLI/Hermes, runs the tests, links the plugin
./install.sh --skip-tests  # (re-running it refreshes an existing install)
./uninstall.sh             # stops running watchers, removes the plugin; keeps its data
./uninstall.sh --purge     # also deletes ~/.opencli/messenger-hermes (asks first; --yes to skip)
```

Manual alternative: `opencli plugin install /path/to/this/repo` / `opencli plugin uninstall messenger-hermes`.

## Choosing the Page and the Hermes profile

Every browser command takes `--page-url <fanpage link>`; `status`, `process` and `poll`
(and `scripts/watch.js`) also take `--hermes-profile <name>`. Flags override
`MESSENGER_PAGE_URL` / `HERMES_PROFILE` from the environment or `config.json`.

```bash
opencli messenger-hermes status --page-url https://www.facebook.com/handsonai --hermes-profile zalolily
node scripts/watch.js --page-url https://www.facebook.com/handsonai --hermes-profile zalolily
```

- **Fanpage link** — any `facebook.com` link to the Page (`/handsonai`, `profile.php?id=…`,
  `web.`/`m.` hosts) or a Business Suite link with `asset_id=`. Non-Business-Suite links are
  opened once in the browser and the Business Suite id is read from `delegate_page.id`
  (the Page's profile id is a different number); the result is cached in
  `~/.opencli/messenger-hermes/page-cache.json`. The inbox is then opened with that id and the
  selected Page is verified; a link to a Page the account does not manage is refused before
  anything is read or sent.
- **Hermes profile** — runs `hermes -p <profile> chat …`, so the profile's model, persona
  (`SOUL.md`) and config answer the customer. Safe mode is therefore **off** with a profile:
  only `-t clarify` and `--max-turns 1` limit it, and MCP servers configured in that profile
  stay reachable. Use a dedicated profile without MCP servers or risky tools for the bot,
  or set `HERMES_SAFE_MODE=true` (which ignores the profile's config and persona).
  Expired provider logins (e.g. OAuth `HTTP 401`) are reported as `hermes_config` and are not retried.

`poll`, `process` and `reply` accept `--timeout <seconds>` (defaults 1800/600/300); OpenCLI
otherwise stops a browser command after 60 s, which is shorter than Hermes + human typing.
The watcher passes a timeout sized from the config (conversations per poll × worst case per
conversation).

Read-only commands (`status`, `inbox`, `messages`) use their own temporary tab; write
commands (`reply`, `process`, `poll`) share one persistent tab under an OpenCLI lease, so
they run one at a time.

## Configuration

Environment variables, or the same keys in `~/.opencli/messenger-hermes/config.json`
(path overridable with `MESSENGER_HERMES_CONFIG`). Environment wins.

```json
{
  "MESSENGER_PAGE_NAME": "AI Thực Chiến",
  "MESSENGER_POLL_INTERVAL_MS": 15000,
  "HERMES_BIN": "/home/you/.local/bin/hermes",
  "HERMES_TIMEOUT_MS": 180000,
  "MAX_REPLY_LENGTH": 2000
}
```

| Key | Default | Meaning |
|---|---|---|
| `MESSENGER_PAGE_URL` (`--page-url`) | — | Fanpage link (preferred way to choose the Page) |
| `MESSENGER_PAGE_NAME` | — | Page name; resolved from the Business Suite Page switcher, or used as an extra check |
| `MESSENGER_PAGE_ID` | — | Page asset id, skips name resolution (name is still verified if both set) |
| `MESSENGER_INBOX_URL` | `https://business.facebook.com/latest/inbox/messenger` | Inbox URL |
| `MESSENGER_POLL_INTERVAL_MS` | `15000` | `watch.js` interval (min 5000) |
| `MESSENGER_MAX_CONVERSATIONS_PER_POLL` | `10` | Conversations processed per cycle |
| `MESSENGER_MAX_MESSAGE_AGE_MIN` | `1440` | Older inbound messages are skipped (no replies to a stale backlog) |
| `MESSENGER_HISTORY_MESSAGES` / `MESSENGER_MAX_CONTEXT_CHARS` | `12` / `6000` | Context sent to Hermes |
| `MESSENGER_UI_TIMEOUT_MS` | `25000` | Max wait for UI states |
| `ALLOWED_SENDER_IDS` | (all) | Comma list of conversation/sender ids allowed to get automatic replies — use it while testing |
| `HERMES_BIN` | `hermes` | Hermes executable |
| `HERMES_SESSION_SCOPE` | `conversation` | Hermes session reuse: `conversation` (one per watcher × customer), `watcher` (one per watcher), `oneshot` (new each reply) |
| `HERMES_PROFILE` (`--hermes-profile`) | — (default profile, safe mode) | Hermes profile: `hermes -p <profile>` |
| `HERMES_PROVIDER` / `HERMES_MODEL` | safe mode: `anthropic` / `claude-sonnet-5-5`; profile: from the profile | Passed explicitly when set |
| `HERMES_TOOLSETS` | `clarify` | Toolsets enabled for the run |
| `HERMES_SAFE_MODE` | `true` without a profile, `false` with one | `--safe-mode`: no user config, AGENTS.md, plugins or MCP servers |
| `HERMES_ARGS` | built from the above | Full argv override, JSON array of strings |
| `HERMES_WORKDIR` | `~/.opencli/messenger-hermes/hermes-workdir` | Working directory of the Hermes process |
| `HERMES_TIMEOUT_MS` / `HERMES_MAX_OUTPUT_BYTES` / `HERMES_MAX_ATTEMPTS` | `180000` / `65536` / `3` | Limits |
| `HERMES_SYSTEM_PROMPT_FILE` | built-in Vietnamese CS prompt | Your own instructions (`{{PAGE_NAME}}` is substituted) |
| `MESSENGER_HUMAN_TYPING` | `true` | Type replies like a person (bursts, jittered pauses, longer after punctuation); `false` pastes each line |
| `MESSENGER_TYPING_CPS` / `MESSENGER_TYPING_MAX_MS` | `15` / `10000` | Typing speed (characters/second) and the cap on total typing time (long replies type in bigger bursts) |
| `MESSENGER_TYPING_INDICATOR` | `true` | While Hermes works, keep Messenger's "typing…" indicator on (live runs only) |
| `MESSENGER_TYPING_INDICATOR_INTERVAL_MS` | `3000` | Indicator keep-alive period |
| `MAX_REPLY_LENGTH` | `2000` | Longer replies are cut at a word boundary |
| `MESSENGER_HERMES_STATE_DIR` | `~/.opencli/messenger-hermes` | SQLite state, logs |
| `MESSENGER_HERMES_LOG_CONTENT` | `false` | Log message/reply text (off by default) |
| `MESSENGER_RETENTION_DAYS` | `30` | Suggested `state --action purge --older-than-days` value |

Default Hermes call without a profile (prompt on **stdin**, never in argv):

```
hermes chat -Q --query-file - --source tool --max-turns 1 -t clarify --safe-mode --provider anthropic --model claude-sonnet-5-5
```

With `--hermes-profile zalolily`: `hermes -p zalolily chat -Q --query-file - --source tool --max-turns 1 -t clarify`.

Hermes must print one JSON object: `{"reply": "…", "handoff": false}`, or
`{"reply": null, "handoff": true}` to leave the conversation to a person.

## How a conversation is processed

1. **Page check** — the inbox is opened with `asset_id=<page>`; the selected Page is read from
   `data-surface="…business_scope:page:<id>:<name>"` and must match. Mismatch → nothing is read or sent.
2. **Read** — thread list and messages come from React props of the inbox (`threadFBID`,
   `data-message-id`, `isFromViewer`, `sender.userID`), not CSS classes. Every inbound
   message must come from the conversation's own customer id.
3. **Filter** — only inbound text messages *after the last Page message*, not older than
   `MESSENGER_MAX_MESSAGE_AGE_MIN`, allowlisted, and not already in a terminal state.
   Several unanswered messages form one turn, answered once, in order.
4. **Hermes** — instructions, history and new messages are separate sections; customer
   text is JSON-encoded data. Timeout/exit errors retry with exponential backoff + jitter
   (max `HERMES_MAX_ATTEMPTS`); config/auth/invalid output → `failed`.
5. **Typing indicator** — in live runs, while Hermes generates the reply, a single character is
   typed into the empty reply box and deleted every few seconds so the customer sees
   "typing…". The box is empty between ticks; it is verified empty before the reply is typed.
   (If Hermes hands off, the customer saw typing but gets no automatic reply.)
6. **Send** — refuses if new messages arrived since the read, or if the reply box already
   holds a (human) draft. Types the reply like a person (grapheme bursts, jittered pauses,
   Shift+Enter for line breaks, ~8 chars/s, capped at 30 s), verifies the box, presses Enter
   (falls back to the Send button only when the text is still in the box), then waits for
   the new outbound message with the same text to render.
7. **State** — `received → queued → processing → sent`, or `failed` / `skipped` /
   `needs_human` / `send_unknown`. `send_unknown` (submitted but not confirmed) is never
   retried automatically. Per-conversation leases recover from crashed workers.

Logged out / checkpoint / CAPTCHA / wrong Page stops the cycle; `watch.js` exits with
code 2 on these so an operator can log in again.

## State and logs

```bash
opencli messenger-hermes state                                  # counts by status
opencli messenger-hermes state --action list --status failed
opencli messenger-hermes state --action retry --conversation <id>   # requeue failed/needs_human
opencli messenger-hermes state --action purge --older-than-days 30
opencli messenger-hermes state --action purge --conversation <id>
```

- `~/.opencli/messenger-hermes/state.db` — ids, statuses, attempts, error codes. **No message text.**
- `~/.opencli/messenger-hermes/logs/*.jsonl` — `correlation_id`, `page_id`, `conversation_id`,
  `message_key`, `stage`, `status`, `duration_ms`, `attempt`, `error_code`. Text only with
  `MESSENGER_HERMES_LOG_CONTENT=1`.

## Running continuously

```bash
opencli messenger-hermes start --page-url https://www.facebook.com/handsonai --allow <conversation-id>  # sandbox first
opencli messenger-hermes start --page-url https://www.facebook.com/handsonai --hermes-profile zalolily  # whole Page
opencli messenger-hermes status            # includes the running watchers
opencli messenger-hermes stop --page-url https://www.facebook.com/handsonai --hermes-profile zalolily
opencli messenger-hermes stop --all
```

`start` launches `scripts/watch.js` detached (output in
`~/.opencli/messenger-hermes/logs/watch-<id>.out`), refuses a second watcher for the same
Page+profile, and checks the Hermes profile exists. Different Pages/profiles can run side by
side; their write commands still take turns on the shared browser tab. `stop` sends SIGTERM and
waits (up to `--timeout`, 180 s) for the current cycle to finish so a reply is never cut in
half; `--force` kills after the timeout. A watcher exits by itself (code 2) when the session is
logged out, hits a checkpoint or the configuration is wrong.

**Hermes sessions per watcher.** Each watcher has an id (`watch-<id>`, printed by `start`;
`web.`/`m.`/`www.` spellings of one Page give the same id) and its own Hermes workdir
`~/.opencli/messenger-hermes/hermes-workdir/<id>/`. The first reply of a session runs Hermes
normally (with the `-t`/`--max-turns` policy) and its `session_id` is stored in
`<workdir>/sessions.json`; later replies run `--resume <session_id>` without `-t`/`--max-turns`
(Hermes rejects those on resume — the session keeps the policy it was created with). A
session that no longer exists is recreated once automatically. Two `start` commands (different
Page or profile) therefore never share a Hermes chat session:

| `HERMES_SESSION_SCOPE` | Session name | Use |
|---|---|---|
| `conversation` (default) | `mh-<watcher-id>-<conversation-id>` | Hermes remembers each customer separately; no context leaks between customers |
| `watcher` | `mh-<watcher-id>` | One shared session for all conversations of that watcher |
| `oneshot` | — | A fresh session for every reply (previous behaviour) |

Manual `process`/`poll` runs use the watcher id `cli`. Dry-runs are always one-shot so unsent
drafts never enter a session, and the prompt tells Hermes that the visible `<conversation>`
history wins over anything the session remembers. A custom `HERMES_ARGS` is used verbatim
(no session flags added).

To start on login, run the `start` command from your session startup (or schedule
`opencli messenger-hermes poll --send --page-url … --hermes-profile …` with cron).

## Tests

```bash
npm test     # node:test, no browser or network
```

## Limits (MVP)

Text messages only (attachments, stickers, audio are skipped), Messenger only (no
Instagram/WhatsApp), 1:1 conversations only, conversations processed sequentially in one
browser tab. The selectors depend on Business Suite internals; `layout_changed` errors
mean they need updating.
