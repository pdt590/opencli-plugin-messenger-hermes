#!/usr/bin/env bash
# Uninstall the messenger-hermes OpenCLI plugin.
#
#   ./uninstall.sh            # stop running watchers (`start`), remove the plugin; keep its data
#   ./uninstall.sh --purge    # also delete the plugin data in ~/.opencli/messenger-hermes
#
# Options:
#   --purge     Delete the state directory (asks for confirmation unless --yes)
#   --yes       Do not ask for confirmation
#   -h, --help  Show this help
#
# The plugin source directory, Chrome, the OpenCLI daemon and Hermes are never touched.
set -euo pipefail

PLUGIN_NAME="messenger-hermes"
STATE_DIR="${MESSENGER_HERMES_STATE_DIR:-$HOME/.opencli/messenger-hermes}"
PURGE=0 YES=0

info() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31mxx\033[0m %s\n' "$*" >&2; exit 1; }
usage() { sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --purge)   PURGE=1; shift ;;
    --yes|-y)  YES=1; shift ;;
    -h|--help) usage 0 ;;
    *)         warn "Unknown option: $1"; usage 64 ;;
  esac
done

# ---------------------------------------------------------------- running watchers
# A watcher left running would keep polling without the plugin. watch.js writes its
# pid to watch-*.lock; only signal processes that really are watch.js.
shopt -s nullglob
for lock in "$STATE_DIR"/watch*.lock; do
  pid="$(tr -cd '0-9' < "$lock" || true)"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | grep -q 'scripts/watch.js'; then
    info "Stopping watcher (pid $pid)"
    kill -TERM "$pid" 2>/dev/null || true
    info "Waiting for the current poll cycle to finish (up to 180s)"
    for _ in $(seq 1 180); do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
    kill -0 "$pid" 2>/dev/null && { warn "Watcher $pid did not stop in 180s; sending SIGKILL"; kill -KILL "$pid" 2>/dev/null || true; }
  fi
  rm -f "$lock"
done
shopt -u nullglob

# ---------------------------------------------------------------- plugin
if command -v opencli >/dev/null 2>&1; then
  if opencli plugin list 2>/dev/null | grep -q "\"name\":\"$PLUGIN_NAME\""; then
    info "Uninstalling OpenCLI plugin '$PLUGIN_NAME'"
    opencli plugin uninstall "$PLUGIN_NAME" >/dev/null
  else
    info "OpenCLI plugin '$PLUGIN_NAME' is not installed"
  fi
else
  warn "opencli not found; skipping plugin removal"
fi

# ---------------------------------------------------------------- state
if [ "$PURGE" -eq 1 ] && [ -d "$STATE_DIR" ]; then
  case "$STATE_DIR" in
    ""|"/"|"$HOME"|"$HOME/"|"$HOME/.opencli"|"$HOME/.opencli/") die "Refusing to delete '$STATE_DIR'." ;;
  esac
  if [ "$YES" -ne 1 ]; then
    printf 'Delete %s (state.db, logs, page cache, Hermes workdirs)? [y/N] ' "$STATE_DIR"
    read -r answer
    case "$answer" in y|Y|yes|YES) ;; *) info "Kept $STATE_DIR"; PURGE=0 ;; esac
  fi
  if [ "$PURGE" -eq 1 ]; then
    rm -rf -- "$STATE_DIR"
    info "Deleted $STATE_DIR"
  fi
elif [ -d "$STATE_DIR" ]; then
  info "Kept state and config in $STATE_DIR (use --purge to delete)"
fi

info "Done. Source code in $(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd) was left untouched."
