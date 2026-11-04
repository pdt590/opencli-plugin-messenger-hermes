#!/usr/bin/env bash
# Install (or refresh) the messenger-hermes OpenCLI plugin from this directory.
# Only the plugin is installed: the fanpage and the Hermes profile are chosen at
# run time, e.g.
#   opencli messenger-hermes start --page-url <fanpage link> --hermes-profile <profile>
#
# Usage: ./install.sh [--skip-tests] [-h|--help]
set -euo pipefail

PLUGIN_NAME="messenger-hermes"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKIP_TESTS=0

info() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31mxx\033[0m %s\n' "$*" >&2; exit 1; }
usage() { sed -n '2,7p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --skip-tests) SKIP_TESTS=1; shift ;;
    -h|--help)    usage 0 ;;
    *)            warn "Unknown option: $1"; usage 64 ;;
  esac
done

# ---------------------------------------------------------------- prerequisites
info "Checking prerequisites"
command -v node >/dev/null 2>&1 || die "Node.js is required (>= 22.13)."
node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=13)?0:1)' \
  || die "Node.js >= 22.13 is required (found $(node -v)); node:sqlite is needed."
command -v opencli >/dev/null 2>&1 || die "OpenCLI not found. Install it: npm install -g @jackwener/opencli"
OPENCLI_VERSION="$(opencli --version 2>/dev/null || true)"
case "$OPENCLI_VERSION" in 2.*) ;; *) die "OpenCLI 2.x is required (found '${OPENCLI_VERSION:-unknown}')." ;; esac
command -v hermes >/dev/null 2>&1 || warn "Hermes CLI not found on PATH; set HERMES_BIN before running the plugin."

# ---------------------------------------------------------------- tests
if [ "$SKIP_TESTS" -eq 0 ]; then
  info "Running unit tests"
  (cd "$SCRIPT_DIR" && node --test "tests/*.test.js" >/dev/null) || die "Unit tests failed; run 'npm test' in $SCRIPT_DIR for details."
fi

# ---------------------------------------------------------------- plugin
EXISTING="$(opencli plugin list 2>/dev/null | node -e '
  let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
    try { const p=(JSON.parse(s).data||[]).find(x=>x.name===process.argv[1]); console.log(p ? p.source : ""); } catch { console.log(""); }
  })' "$PLUGIN_NAME")"
if [ -z "$EXISTING" ]; then
  info "Installing OpenCLI plugin '$PLUGIN_NAME' from $SCRIPT_DIR"
  opencli plugin install "$SCRIPT_DIR" >/dev/null
elif [ "$EXISTING" = "local:$SCRIPT_DIR" ]; then
  info "Plugin already linked to this directory; refreshing it"
  opencli plugin update "$PLUGIN_NAME" >/dev/null
else
  die "Plugin '$PLUGIN_NAME' is already installed from '$EXISTING'. Run ./uninstall.sh (or opencli plugin uninstall $PLUGIN_NAME) first."
fi
opencli "$PLUGIN_NAME" --help >/dev/null 2>&1 || die "OpenCLI does not list '$PLUGIN_NAME' commands after install."

cat <<DONE

Installed '$PLUGIN_NAME' (OpenCLI $OPENCLI_VERSION) from $SCRIPT_DIR.

Usage (Chrome must run with the OpenCLI Browser Bridge connected and be logged in to an
account that manages the Page):
  opencli $PLUGIN_NAME status --page-url <fanpage link>
  opencli $PLUGIN_NAME start  --page-url <fanpage link> --hermes-profile <profile>
  opencli $PLUGIN_NAME stop   --page-url <fanpage link> --hermes-profile <profile>
DONE
