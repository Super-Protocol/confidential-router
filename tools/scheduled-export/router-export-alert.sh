#!/usr/bin/env bash
# The alert of last resort (SUP-317).
#
#   router-export-alert.sh [unit]
#
# `router-export.sh` says so itself whenever it refuses, which covers every
# failure it can see. This covers the ones it cannot: a missing interpreter, an
# OOM kill, a bad edit to the unit file — anything that stops the script before
# it reaches its own `die`. systemd runs it through `OnFailure=`, and all it has
# to go on is the journal.
#
# Where the alert lands is read from the same configuration the script uses, so
# there is one place to change it.

set -uo pipefail

CONFIG="${ROUTER_EXPORT_CONFIG:-$HOME/.config/router-export/env}"
UNIT="${1:-router-export.service}"

[ -r "$CONFIG" ] || {
  echo "router-export-alert: no readable configuration at $CONFIG" >&2
  exit 1
}
set -a
# shellcheck disable=SC1090
. "$CONFIG"
set +a

[ -n "${ALERT_ISSUE_ID:-}" ] || {
  echo 'router-export-alert: ALERT_ISSUE_ID is unset; nowhere to say it' >&2
  exit 0
}
command -v multica > /dev/null 2>&1 || {
  echo 'router-export-alert: the multica CLI is not on PATH' >&2
  exit 1
}

# Inside the directory the CLI will be run from: it refuses a `--content-file`
# that resolves outside its working directory.
dir="${EXPORT_DIR:-$HOME/prod-exports}"
mkdir -p "$dir"
body="$dir/.alert.md"
trap 'rm -f "$body"' EXIT INT TERM

{
  printf '## Scheduled production export failed to run\n\n'
  printf 'The `%s` unit on the agent host failed before the export script could report anything, ' "$UNIT"
  printf 'so the reason is in the journal rather than in the export log.\n\n'
  printf '```\n'
  journalctl --user -u "$UNIT" -n 30 --no-pager 2>&1 | tail -30
  printf '```\n\n'
  printf 'No copy was taken for this run. Production data has one copy again, inside the deployment, until this is fixed.\n'
} > "$body"

# From the directory the body is in, so the CLI reads the host's own credentials
# instead of looking for a task-scoped token in whatever directory it was
# started in, and accepts the relative path.
cd "$dir" || exit 1
multica issue comment add "$ALERT_ISSUE_ID" --content-file ./.alert.md > /dev/null
