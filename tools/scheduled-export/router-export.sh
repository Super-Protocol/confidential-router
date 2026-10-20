#!/usr/bin/env bash
# Takes a deployment export off a running router and keeps it somewhere the
# router cannot take with it when it dies (SUP-317).
#
#   router-export.sh [--local-only] [--quiet] [--accept-shrink '<reason>']
#
# Read by a systemd timer once a day; safe to run by hand at any time. One run
# is one directory, locally and in object storage:
#
#   <EXPORT_DIR>/<stamp>/router-export-<stamp>.json.gz
#   <EXPORT_DIR>/<stamp>/invite-codes-<stamp>.csv
#   <EXPORT_DIR>/<stamp>/manifest.json
#
# Nothing here is clever, and that is deliberate: the one thing a backup must
# not do is report success it did not have. Every step that could fail silently
# is checked against the surface that decides it — the bundle's own hash against
# the response header, the uploaded bytes against the local ones, this run's row
# counts against the last run's — and any refusal both exits non-zero and says
# so on the issue named by ALERT_ISSUE_ID.
#
# The one refusal a re-run cannot clear is the shrink guard: the baseline it
# compares against is only rewritten by a successful run, so a true shrink
# refuses identically forever. `--accept-shrink '<reason>'` is the front door —
# it takes this smaller reading as the new baseline, says the old → new counts
# whatever --quiet asked for, and appends the reason to shrink-acceptances.log,
# which nothing in this script ever truncates. Use it only after finding out
# where the rows went; blessing a real loss rotates it out of the backups.
#
# The administrator's key is read from the deployment at run time rather than
# written down here (SUP-438). `auth.bootstrapToken` is a *generated* parameter
# of the marketplace deployment, so every production rebuild mints a new one and
# any copy kept on this host becomes a 401 the day the rebuild lands — which is
# exactly the day a backup matters. Given a marketplace account, this asks the
# marketplace for the token of whichever deployment currently serves
# ROUTER_API_ORIGIN, the same value its console shows in the credentials dialog.
# That account is not deployment-scoped, so it survives what the token does not.
#
# Configuration: ~/.config/router-export/env, mode 0600.
#
#   ROUTER_API_ORIGIN       https://api.router.superprotocol.com
#   ROUTER_CONSOLE_ORIGIN   https://console.router.superprotocol.com
#   MARKETPLACE_ORIGIN      https://marketplace.demo.superprotocol.dev — where the
#                           token is read from; unset means "use the stored one"
#   MARKETPLACE_EMAIL       a marketplace account with `member` on the organization
#   MARKETPLACE_PASSWORD    its password. Not deployment-scoped: a rebuild of the
#                           router does not touch it
#   MARKETPLACE_ORG_ID      optional; without it, every organization the account
#                           belongs to is searched for the matching deployment
#   MARKETPLACE_DEPLOYMENT_ID  optional pin. Rarely wanted: a rebuild is a new
#                           deployment, so a pinned id goes stale as a token does
#   ROUTER_BOOTSTRAP_TOKEN  auth.bootstrapToken — a password for the administrator.
#                           The fallback for a marketplace that cannot be reached,
#                           and the whole credential when none is configured
#   EXPORT_CONTAINER        prod-exports   (container of its own; never qa-artifacts)
#   BLOB_PREFIX             optional prefix inside that container; empty is fine
#                           and is the point of a dedicated container
#   LOCAL_KEEP              7              (run directories kept on this host)
#   ALERT_ISSUE_ID          multica issue a failed run comments on; empty = no alert
#   EXPORT_DIR              ~/prod-exports (optional)
#
# Storage credentials come from ~/.config/qa-publish/env — the key of a storage
# account dedicated to artefacts, and the only Azure credential an agent host
# holds. The account is shared with qa-publish; the container is not, and must
# not be: `qa-artifacts` has read-only SAS links minted off it and pasted into
# issue comments every day, which is no place for a neighbour holding personal
# data and live invitation codes.

set -euo pipefail

CONFIG="${ROUTER_EXPORT_CONFIG:-$HOME/.config/router-export/env}"
BLOB_CONFIG="${ROUTER_EXPORT_BLOB_CONFIG:-$HOME/.config/qa-publish/env}"

# The container this tool must never write to, whatever the configuration says.
FORBIDDEN_CONTAINER='qa-artifacts'

# `readlink -f` because the installed copy is a symlink into a checkout, and the
# verifier beside the script has to be found through it.
here="$(CDPATH='' cd -- "$(dirname -- "$(readlink -f -- "$0")")" && pwd)"

local_only=0
quiet=0
accept_shrink=0
accept_reason=''
while [ $# -gt 0 ]; do
  case "$1" in
    --local-only) local_only=1 ;;
    --quiet) quiet=1 ;;
    --accept-shrink)
      accept_reason="${2:-}"
      # The reason is the whole point of the flag — it is what the acceptance
      # log has to show a month later — so a missing or blank one is an error
      # and not an empty field. A reason starting with `--` is a forgotten
      # argument: `--accept-shrink --local-only` would otherwise swallow
      # --local-only and upload the shrunk bundle the operator meant to keep on
      # this host. Only `--`, so a reason may still begin with a single dash —
      # "-2 rehearsal accounts" is a perfectly good thing to write.
      if [[ -z "${accept_reason//[[:space:]]/}" || "$accept_reason" == --* ]]; then
        echo "router-export: --accept-shrink needs a reason that is neither blank nor a flag, e.g. --accept-shrink 'the SUP-359 rehearsal account was withdrawn'" >&2
        exit 2
      fi
      accept_shrink=1
      shift
      ;;
    -h | --help)
      # The header block, minus the shebang and the comment markers, so the
      # usage text cannot drift from the file that documents itself.
      awk 'NR > 1 && /^#/ { sub(/^#[[:space:]]?/, ""); print; next } NR > 1 { exit }' "$0"
      exit 0
      ;;
    *)
      echo "router-export: unknown argument: $1" >&2
      exit 2
      ;;
  esac
  shift
done

log() { [ "$quiet" = 1 ] || printf '%s router-export: %s\n' "$(date -u '+%FT%TZ')" "$1" >&2; }
# A refusal is said whatever --quiet asked for: the point of the flag is a timer
# that logs nothing on an ordinary day, not one that hides the day it breaks.
say() { printf '%s router-export: %s\n' "$(date -u '+%FT%TZ')" "$1" >&2; }

work=''
cookies=''
# Overwrite rather than unlink where the host has shred; a cookie jar holds a
# live administrator session, and so does the request body carrying the token.
wipe() { [ -f "$1" ] && { shred -u "$1" 2> /dev/null || rm -f "$1"; }; return 0; }

cleanup() {
  [ -n "$cookies" ] && wipe "$cookies"
  [ -n "$work" ] && [ -d "$work" ] && rm -rf "$work"
  return 0
}
trap cleanup EXIT INT TERM

# --- configuration ------------------------------------------------------------

[ -r "$CONFIG" ] || {
  echo "router-export: no readable configuration at $CONFIG" >&2
  exit 1
}
set -a
# shellcheck disable=SC1090
. "$CONFIG"
set +a

: "${ROUTER_API_ORIGIN:?set ROUTER_API_ORIGIN in $CONFIG}"
CONSOLE_ORIGIN="${ROUTER_CONSOLE_ORIGIN:-$ROUTER_API_ORIGIN}"
MARKETPLACE_ORIGIN="${MARKETPLACE_ORIGIN:-}"
MARKETPLACE_EMAIL="${MARKETPLACE_EMAIL:-}"
MARKETPLACE_PASSWORD="${MARKETPLACE_PASSWORD:-}"
MARKETPLACE_ORG_ID="${MARKETPLACE_ORG_ID:-}"
MARKETPLACE_DEPLOYMENT_ID="${MARKETPLACE_DEPLOYMENT_ID:-}"
# Exported deliberately: the sign-in body is written by a `node -e` that reads
# it out of the environment rather than off a command line, and a config file
# that omits the key entirely would otherwise leave it unexported here.
export ROUTER_BOOTSTRAP_TOKEN="${ROUTER_BOOTSTRAP_TOKEN:-}"
# One of the two has to be there. A marketplace half-configured is the worse
# failure of the two — it reads as "the modern way is on" while falling back to
# a stored token every night — so say which half is missing.
if [ -n "$MARKETPLACE_ORIGIN" ] && { [ -z "$MARKETPLACE_EMAIL" ] || [ -z "$MARKETPLACE_PASSWORD" ]; }; then
  echo "router-export: MARKETPLACE_ORIGIN is set but MARKETPLACE_EMAIL or MARKETPLACE_PASSWORD is not; set both in $CONFIG" >&2
  exit 1
fi
if [ -z "$MARKETPLACE_ORIGIN" ] && [ -z "$ROUTER_BOOTSTRAP_TOKEN" ]; then
  echo "router-export: set MARKETPLACE_ORIGIN (with MARKETPLACE_EMAIL and MARKETPLACE_PASSWORD) in $CONFIG, or a ROUTER_BOOTSTRAP_TOKEN to use instead" >&2
  exit 1
fi
EXPORT_DIR="${EXPORT_DIR:-$HOME/prod-exports}"
# `${x-}` and not `${x:-…}`: a container of this tool's own needs no prefix at
# all, so an explicitly empty value has to survive rather than be defaulted away.
BLOB_PREFIX="${BLOB_PREFIX-}"
LOCAL_KEEP="${LOCAL_KEEP:-7}"
ALERT_ISSUE_ID="${ALERT_ISSUE_ID:-}"

STAMP="$(date -u '+%Y%m%dT%H%M%SZ')"
DAY="${STAMP%T*}"
RUN_DIR="$EXPORT_DIR/$STAMP"
LOG_FILE="$EXPORT_DIR/router-export.log"
STATE_FILE="$EXPORT_DIR/state.json"
# Append-only, and deliberately not inside state.json: the state file is
# rewritten wholesale by every successful run, which is exactly how the first
# hand-made acceptance record was erased by the run that followed it (SUP-432).
ACCEPT_LOG="$EXPORT_DIR/shrink-acceptances.log"
# Set while the run-time token lookup is failing and the stored token is
# carrying the export on its own. Its only job is to keep the alert about that
# to one comment per outage rather than one a night (SUP-438).
DEGRADED_FLAG="$EXPORT_DIR/.token-lookup-degraded"

mkdir -p "$EXPORT_DIR"
chmod 700 "$EXPORT_DIR"
work="$(mktemp -d "${TMPDIR:-/tmp}/router-export.XXXXXXXX")"
chmod 700 "$work"
cookies="$work/cookies.txt"

# --- failing loudly -----------------------------------------------------------

# One line per run, appended whatever the outcome: the file a human greps to
# answer "is the backup alive" without trusting anything this script says.
record() {
  printf '%s\t%s\t%s\n' "$(date -u '+%FT%TZ')" "$1" "$2" >> "$LOG_FILE"
  chmod 600 "$LOG_FILE" 2>/dev/null || true
}

# Posts whatever is on stdin to the alert issue. Nothing a human has to go
# looking for counts as having been said, so the one place a comment is written
# is here, and both the refusals and the still-running-but-degraded warning go
# through it.
#
# Returns non-zero only when a post was attempted and failed. A host with no
# ALERT_ISSUE_ID, or none of the CLI, never promised a comment and so has not
# failed to deliver one — but a caller that remembers "this has been said
# already" must only remember it when it actually was. One lost CLI call turning
# a once-per-outage alarm into a never alarm is how the loud path goes quiet.
alert() {
  local body
  body="$(cat)"
  [ -n "$ALERT_ISSUE_ID" ] && command -v multica > /dev/null 2>&1 || return 0
  printf '%s' "$body" > "$EXPORT_DIR/.alert.md"
  # Named for what a non-zero return means, which is the opposite of what the
  # word `posted` would read as here.
  local undelivered=0
  # From `$EXPORT_DIR`, with a relative path: the CLI refuses a
  # `--content-file` outside its working directory, and a directory with no
  # task context is what makes it use the host's own credentials.
  (cd "$EXPORT_DIR" && multica issue comment add "$ALERT_ISSUE_ID" --content-file ./.alert.md) \
    > /dev/null 2>&1 \
    || {
      undelivered=1
      say 'the alert comment could not be posted — the message above is only in this log'
    }
  rm -f "$EXPORT_DIR/.alert.md"
  return "$undelivered"
}

# A refusal has to reach a person. systemd would only mark the unit failed, and
# a unit nobody looks at is the silent backup this issue exists to end.
die() {
  local reason="$1"
  say "FAILED — $reason"
  record 'FAILED' "$reason"
  {
    printf '## Scheduled production export failed\n\n'
    printf 'Run `%s` on the agent host did not produce a usable copy.\n\n' "$STAMP"
    printf '> %s\n\n' "$reason"
    printf 'Nothing was uploaded for this run, so the newest good copy is whatever the previous run left. '
    printf 'Until this is fixed the production data has one copy again, inside the deployment.\n\n'
    # Not a bare "re-run": a transport failure clears on the next attempt, but
    # a refusal about the data itself does not — the shrink guard compares
    # against a baseline only a successful run rewrites, so re-running it
    # unchanged refuses identically (SUP-432). The reason above says which.
    printf 'Local log: `%s`. Re-run by hand with `router-export.sh` on the agent host once the cause above is addressed — a re-run clears a failure to reach the router, but not a refusal about what the export holds.\n' "$LOG_FILE"
  } | alert
  exit 1
}

# The one JSON reader in here. `?? ''` and not `undefined`: a field that is not
# there reads as absent rather than as the four letters that look like a value.
json_field() {
  node -e 'const f=require("node:fs");process.stdout.write(String(JSON.parse(f.readFileSync(process.argv[1],"utf8"))[process.argv[2]] ?? ""))' \
    "$1" "$2"
}

# write_json <file> <key> <value> [<key> <value> …] — a key ending in `#` is
# written as a number.
#
# Through `JSON.stringify` and not a heredoc, because several of these values
# are not this host's: `tokenSource` carries the marketplace's free-form
# `appVersion`, `routerVersion` comes out of the bundle the router sent, and
# `uploadedTo` is assembled from configuration. One `"` in any of them and a
# heredoc writes a file that is not JSON — and `state.json` unreadable is not
# cosmetic: the baseline read below treats an unparseable state file as no
# state at all, so the shrink guard would compare against zero, never fire
# again, and never heal. That is SUP-363 disarmed by our own bookkeeping.
#
# A `#` value that is not a number is a refusal and not a `null`: `Number("")`
# is 0 and `Number("x")` serialises as `null`, and the baseline read does
# `s.users ?? 0` — so a bad count would quietly become a zero baseline, which
# is the same disarmed guard by a shorter route. Every call site is already
# validated, so this is the guard and not the case; bookkeeping is the last
# place to be forgiving.
#
# Written to a temporary file and renamed, because `> "$target"` truncates
# before node runs: a node that died mid-write would leave exactly the
# unparseable state.json this helper exists to prevent.
write_json() {
  local target="$1"
  shift
  node -e '
    const out = {};
    const argv = process.argv.slice(1);
    for (let i = 0; i < argv.length; i += 2) {
      const key = argv[i];
      if (!key.endsWith("#")) {
        out[key] = argv[i + 1];
        continue;
      }
      const raw = argv[i + 1];
      const value = Number(raw);
      // The blank is checked separately because `Number("")` is 0, and a count
      // that silently became zero is the whole failure being guarded against.
      if (raw === undefined || raw.trim() === "" || !Number.isFinite(value)) {
        process.stderr.write(`${key.slice(0, -1)} is ${JSON.stringify(raw ?? null)}, which is not a number`);
        process.exit(1);
      }
      out[key.slice(0, -1)] = value;
    }
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  ' "$@" > "$target.partial" 2> "$work/write-json.err" \
    || die "could not write $target: $(tr '\n\t' '  ' < "$work/write-json.err")"
  mv "$target.partial" "$target"
}

need() { command -v "$1" > /dev/null 2>&1 || die "$1 is not installed on this host"; }
need curl
need node

# --- the administrator's key --------------------------------------------------
#
# `auth.bootstrapToken` belongs to one deployment, and a production rebuild is a
# new deployment: whatever is written down here stops working the moment the
# rebuild lands, and the export 401s on the first night it is most needed. So
# ask the marketplace that made the deployment, every run, for the token of
# whichever deployment currently serves ROUTER_API_ORIGIN (SUP-438).
#
# A marketplace that cannot be reached falls back to the stored token rather
# than refusing: the stored one is usually still good, and a backup that stops
# because a *second* system is down is worse than the problem. But the fallback
# is a silent re-arming of the original defect, so it says so on the alert issue
# the first time it happens, and keeps saying nothing until a run resolves
# cleanly again — one comment per outage, not one a night.

token_source='the stored ROUTER_BOOTSTRAP_TOKEN'
lookup_failure=''

if [ -n "$MARKETPLACE_ORIGIN" ]; then
  log "reading the bootstrap token off the deployment serving $ROUTER_API_ORIGIN"
  resolved="$work/resolved.json"
  if MARKETPLACE_ORIGIN="$MARKETPLACE_ORIGIN" \
    MARKETPLACE_EMAIL="$MARKETPLACE_EMAIL" \
    MARKETPLACE_PASSWORD="$MARKETPLACE_PASSWORD" \
    MARKETPLACE_ORG_ID="$MARKETPLACE_ORG_ID" \
    MARKETPLACE_DEPLOYMENT_ID="$MARKETPLACE_DEPLOYMENT_ID" \
    ROUTER_API_ORIGIN="$ROUTER_API_ORIGIN" \
    node "$here/resolve-bootstrap-token.mjs" > "$resolved" 2> "$work/resolve.err"; then
    chmod 600 "$resolved"
    ROUTER_BOOTSTRAP_TOKEN="$(json_field "$resolved" token)"
    token_source="deployment $(json_field "$resolved" deploymentId) ($(json_field "$resolved" appVersion), $(json_field "$resolved" status)) on $MARKETPLACE_ORIGIN"
    wipe "$resolved"
    log "token read from $token_source"
    if [ -f "$DEGRADED_FLAG" ]; then
      say 'the bootstrap token can be read off the deployment again.'
      {
        printf '## The scheduled export is reading the bootstrap token again\n\n'
        printf 'Run `%s` read the current token off the deployment, so the fallback to the stored copy reported earlier is over.\n\n' "$STAMP"
        printf 'Read from %s.\n' "$token_source"
      } | alert || true
      # Cleared whether or not that comment landed, and deliberately: a flag
      # left behind would suppress the alarm for the *next* outage, which is
      # the failure direction that matters. A duplicate alarm is not.
      rm -f "$DEGRADED_FLAG"
    fi
  else
    # The refusal is on stdout by design; stderr only has anything in it when
    # node fell over before reaching its own error handling, and that is
    # precisely the case where the operator needs to be told something. That
    # one is a stack trace, so it is folded onto a single line before it goes
    # anywhere near `record` — the run log is one tab-separated line per run,
    # and it is the file the README tells a human to grep.
    lookup_failure="$(cat "$resolved" 2> /dev/null || true)"
    [ -n "$lookup_failure" ] \
      || lookup_failure="$(head -c 400 "$work/resolve.err" 2> /dev/null | tr '\n\t' '  ' || true)"
    [ -n "$lookup_failure" ] || lookup_failure='the lookup failed without saying why'
    wipe "$resolved"
    [ -n "$ROUTER_BOOTSTRAP_TOKEN" ] \
      || die "the bootstrap token could not be read off the deployment, and no ROUTER_BOOTSTRAP_TOKEN is configured to fall back to: $lookup_failure"
    say "the bootstrap token could not be read off the deployment ($lookup_failure) — falling back to the stored ROUTER_BOOTSTRAP_TOKEN, which a rebuild may already have replaced."
    if [ ! -f "$DEGRADED_FLAG" ]; then
      # The marker goes down only if the comment went up. A `multica` that
      # failed once would otherwise buy permanent silence: the alarm suppressed
      # from the second night on, having never been delivered on the first, and
      # the export running on a deployment-scoped token with nothing said
      # anywhere — the exact failure this whole change removes.
      if {
        printf '## The scheduled export is back on a stored bootstrap token\n\n'
        printf 'Run `%s` could not read the current token off the deployment, and is using the copy in `%s` instead.\n\n' \
          "$STAMP" "$CONFIG"
        printf '> %s\n\n' "$lookup_failure"
        printf 'That copy belongs to one deployment. It works until the next production rebuild and then stops, '
        printf 'which is the failure SUP-438 removed — so this is the alarm for it rather than a note in a log. '
        printf 'Fix the marketplace credentials in `%s`, or expect to paste a new token by hand after the next deploy.\n\n' "$CONFIG"
        printf 'This is said once per outage: no further comment until a run reads the token cleanly again.\n'
      } | alert; then
        : > "$DEGRADED_FLAG"
        chmod 600 "$DEGRADED_FLAG" 2> /dev/null || true
      else
        say 'the fallback could not be announced, so the next run will try to announce it again rather than go quiet.'
      fi
    fi
  fi
fi

# --- the export ---------------------------------------------------------------

log "signing in at $ROUTER_API_ORIGIN"
token_json="$work/token.json"
# The token travels in a file, not on a command line, where `ps` would show it.
node -e 'process.stdout.write(JSON.stringify({ token: process.env.ROUTER_BOOTSTRAP_TOKEN }))' > "$token_json"

status="$(
  curl -sS --max-time 60 -o "$work/bootstrap.json" -w '%{http_code}' \
    -c "$cookies" \
    -X POST "$ROUTER_API_ORIGIN/auth/bootstrap" \
    -H 'Content-Type: application/json' \
    -H "Origin: $CONSOLE_ORIGIN" \
    --data-binary "@$token_json" || true
)"
wipe "$token_json"

# `-w '%{http_code}'` writes 000 when curl never got a response, and nothing at
# all if curl itself could not run; both mean the router did not answer.
case "${status:-000}" in
  200) : ;;
  # Which of the two 401s this is matters: a refused *stored* token is the old
  # "a rebuild happened and nobody pasted the new one" and the remedy is to
  # stop storing it; a refused *resolved* token is a real fault, because the
  # marketplace just handed it over as the current one.
  401)
    if [ -n "$lookup_failure" ]; then
      die "the stored bootstrap token was refused (401), and the current one could not be read off the deployment to replace it: $lookup_failure"
    elif [ -n "$MARKETPLACE_ORIGIN" ]; then
      die "the bootstrap token read from $token_source was refused (401). The deployment was rebuilt between that read and this sign-in, or the administrator account the token opens no longer exists."
    else
      die 'the bootstrap token was refused (401). It was rotated, or this copy is stale — set MARKETPLACE_ORIGIN so the token is read off the deployment at run time instead of being written down.'
    fi
    ;;
  404) die 'the deployment has no bootstrap endpoint (404). Either auth.bootstrapToken is unset, or the administrator account it opens no longer exists.' ;;
  000) die "the router did not answer at $ROUTER_API_ORIGIN (connection failed or timed out)." ;;
  *) die "sign-in answered HTTP $status; expected 200." ;;
esac

grep -q 'cr_session' "$cookies" || die 'sign-in answered 200 but set no session cookie.'

mkdir -p "$RUN_DIR"
chmod 700 "$RUN_DIR"

log 'fetching the deployment export'
bundle="$RUN_DIR/router-export-$STAMP.json.gz"
status="$(
  curl -sS --max-time 300 -b "$cookies" -D "$work/export.headers" -o "$bundle" -w '%{http_code}' \
    -H "Origin: $CONSOLE_ORIGIN" "$ROUTER_API_ORIGIN/admin/data/export" || true
)"
[ "${status:-000}" = 200 ] || die "the export answered HTTP ${status:-000}; expected 200."

log 'fetching the invitation codes'
codes="$RUN_DIR/invite-codes-$STAMP.csv"
status="$(
  curl -sS --max-time 300 -b "$cookies" -o "$codes" -w '%{http_code}' \
    -H "Origin: $CONSOLE_ORIGIN" "$ROUTER_API_ORIGIN/admin/invite-codes/export.csv" || true
)"
[ "${status:-000}" = 200 ] || die "the invitation-code export answered HTTP ${status:-000}; expected 200."

chmod 600 "$bundle" "$codes"

# The session is not needed past this point, and a daily run that left one
# behind would stack up ninety live administrator sessions in a quarter.
curl -sS --max-time 30 -b "$cookies" -o /dev/null \
  -X POST "$ROUTER_API_ORIGIN/auth/sign-out" -H "Origin: $CONSOLE_ORIGIN" || true
wipe "$cookies"
cookies=''

# --- verification -------------------------------------------------------------
#
# A file that arrived is not a file that is good. The bundle declares a hash
# over its own `data`, and the response declares the same hash in a header: the
# three have to agree, or something between the database and this disk changed
# the bytes. Re-derived in node because the canonical form the hash is taken
# over is `JSON.stringify` with sorted keys — the router's own
# `contentSha256`, not an approximation of it.

header_sha="$(
  tr -d '\r' < "$work/export.headers" | sed -n 's/^[Xx]-[Ee]xport-[Ss]ha256: *//p' | tail -1
)"
[ -n "$header_sha" ] || die 'the export response carried no X-Export-Sha256 header.'

verify_json="$work/verify.json"
if ! EXPORT_HEADER_SHA="$header_sha" node "$here/verify-bundle.mjs" "$bundle" > "$verify_json"; then
  die "$(cat "$verify_json" 2>/dev/null || echo 'the bundle did not verify')"
fi

read_field() { json_field "$verify_json" "$1"; }

content_sha="$(read_field contentSha256)"
users="$(read_field users)"
invite_codes="$(read_field inviteCodes)"
exported_at="$(read_field exportedAt)"
router_version="$(read_field routerVersion)"

# The codes CSV is checked the only way it can be: its header is the one the
# importer accepts, and it carries a row per code the bundle counted.
# `grep -c ''` and not `wc -l`, which misses a last row with no newline after it.
csv_rows="$(($(grep -c '' "$codes") - 1))"
head -1 "$codes" | grep -q '^code,url,campaign,grantUsd,status,' \
  || die 'the invitation-code CSV does not start with the header the importer accepts.'
[ "$csv_rows" = "$invite_codes" ] \
  || die "the codes CSV holds $csv_rows row(s) but the bundle counted $invite_codes invitation code(s); one of the two is incomplete."

# "Empty while users exist" — a deployment that answers with an export of
# nothing is the failure mode this whole exercise is insurance against, and it
# arrives as a 200. A router always holds at least the administrator, so zero
# accounts is never a true reading; and counts that fall between two runs mean
# either a restore from something older or a loss, neither of which should be
# discovered a month later.
[ "$users" -ge 1 ] || die "the export holds 0 accounts. A live deployment always has at least its administrator, so this bundle is empty, not small — keeping it would overwrite the last good copy's place in the rotation."

if [ -r "$STATE_FILE" ]; then
  # A state file this run cannot read is treated as no state at all: a refusal
  # here would be the backup stopping over its own bookkeeping.
  previous="$(node -e 'const f=require("node:fs");let s={};try{s=JSON.parse(f.readFileSync(process.argv[1],"utf8"))}catch{}process.stdout.write(`${s.users ?? 0}\t${s.inviteCodes ?? 0}`)' "$STATE_FILE")"
  previous_users="${previous%%$'\t'*}"
  previous_codes="${previous##*$'\t'}"
  if [ "$users" -lt "$previous_users" ] || [ "$invite_codes" -lt "$previous_codes" ]; then
    shrank="$previous_users → $users account(s), $previous_codes → $invite_codes invitation code(s)"
    # "then re-run" was the old advice here and it was wrong: $STATE_FILE is
    # only rewritten after a successful upload, so a refused run leaves the
    # baseline untouched and the next run refuses identically. The remedy is to
    # find out where the rows went and then say so with --accept-shrink.
    # No angle-bracket placeholder in the remedy: `die` pastes this reason into
    # a Markdown blockquote in the alert comment, and a renderer reads
    # `<reason>` as a raw HTML tag and drops it, leaving the operator looking at
    # an empty pair of quotes.
    [ "$accept_shrink" = 1 ] || die "the export shrank: $shrank. The bundle is kept locally at $RUN_DIR but was not uploaded. Re-running on its own changes nothing — $STATE_FILE still holds the old counts, so the next run compares against the same baseline and refuses the same way. Find out where the rows went first: $LOG_FILE holds every previous run's counts, and the last uploaded bundle holds the rows themselves. If the fall is understood and right, re-run with --accept-shrink 'why the counts fell' to take this reading as the new baseline."

    # Both logs below are one line per entry, so one entry stays one grep hit:
    # a reason pasted in with a newline or a tab in it would otherwise look
    # like two, and in the tab-separated run log like a different shape.
    reason_1line="$(printf '%s' "$accept_reason" | tr '\n\t' '  ')"

    # Said through `say`, not `log`: an overruled data-loss alarm is the last
    # thing a --quiet timer run should be able to swallow.
    say "ACCEPTING A SHRINK — $shrank. Reason: $reason_1line"
    # Written here, where the guard is overruled, and not after the upload: the
    # operator overruled a data-loss alarm whether or not the run that followed
    # went on to succeed, and the `ok`/`FAILED` line this run adds to
    # $LOG_FILE right below says which it was.
    printf '%s\t%s\t%s\t%s\t%s\n' \
      "$(date -u '+%FT%TZ')" "$STAMP" "$shrank" \
      "$(id -un 2> /dev/null || echo "${USER:-unknown}")" "$reason_1line" >> "$ACCEPT_LOG"
    chmod 600 "$ACCEPT_LOG" 2> /dev/null || true
    # And into the run directory, which is what gets uploaded: a record that
    # only ever exists on this host is one host away from the fate it exists to
    # document. The file is append-only, so the copy an accepting run carries
    # off is the whole history up to and including its own acceptance.
    cp "$ACCEPT_LOG" "$RUN_DIR/shrink-acceptances.log"
    chmod 600 "$RUN_DIR/shrink-acceptances.log"
    # And in the run log too, so the day-by-day story of the backup does not go
    # quiet about the day the guard was overruled.
    record 'ACCEPTED-SHRINK' "$shrank — $reason_1line"
  fi
fi

# `${shrank:-}` is set only by the branch above, so this is "the flag was passed
# and there was nothing to use it on". Through `say` and not `log`: an operator
# who believes they just blessed a shrink is wrong about the state of the
# deployment, and --quiet is not a reason to leave them believing it.
if [ "$accept_shrink" = 1 ] && [ -z "${shrank:-}" ]; then
  say 'nothing shrank — --accept-shrink was not needed and nothing was accepted'
fi

write_json "$RUN_DIR/manifest.json" \
  run "$STAMP" \
  exportedAt "$exported_at" \
  source "$ROUTER_API_ORIGIN" \
  routerVersion "$router_version" \
  contentSha256 "$content_sha" \
  'users#' "$users" \
  'inviteCodes#' "$invite_codes" \
  'bundleBytes#' "$(stat -c%s "$bundle")" \
  'codesCsvBytes#' "$(stat -c%s "$codes")" \
  'codesCsvRows#' "$csv_rows"
chmod 600 "$RUN_DIR/manifest.json"

log "verified: $users account(s), $invite_codes code(s), sha256 $content_sha"

# --- off this host ------------------------------------------------------------

uploaded='skipped'
if [ "$local_only" = 1 ]; then
  log 'local only — not uploading'
else
  [ -r "$BLOB_CONFIG" ] || die "no readable storage credentials at $BLOB_CONFIG"
  set -a
  # shellcheck disable=SC1090
  . "$BLOB_CONFIG"
  set +a
  : "${AZ_STORAGE_ACCOUNT:?set AZ_STORAGE_ACCOUNT in $BLOB_CONFIG}"
  : "${AZ_STORAGE_KEY:?set AZ_STORAGE_KEY in $BLOB_CONFIG}"

  # The account is shared with `qa-publish`; the container is not. This tool's
  # own `EXPORT_CONTAINER` wins over the `AZ_STORAGE_CONTAINER` that arrives
  # with the credentials, because that one has to keep meaning `qa-artifacts`
  # for qa-publish.
  container="${EXPORT_CONTAINER:-${AZ_STORAGE_CONTAINER:-prod-exports}}"

  # `qa-artifacts` is where read-only SAS links are minted daily and pasted into
  # issue comments. Personal data and live invitation codes must not sit one
  # prefix away from that habit — so the one container this must never write to
  # is named in the code, not left to whichever env file was sourced last. The
  # fallback chain above reaches it the moment `EXPORT_CONTAINER` is forgotten,
  # which is precisely when nobody is watching.
  [ "$container" != "$FORBIDDEN_CONTAINER" ] || die "refusing to upload to '$FORBIDDEN_CONTAINER': that is the artefact container, where read-only SAS links are minted and pasted into issue comments. A production export holds personal data and live invitation codes — set EXPORT_CONTAINER in $CONFIG to a container of its own."
  need az

  destination="$DAY/$STAMP"
  [ -z "$BLOB_PREFIX" ] || destination="${BLOB_PREFIX%/}/$destination"
  log "uploading to $container/$destination/"
  az storage blob upload-batch \
    --account-name "$AZ_STORAGE_ACCOUNT" --account-key "$AZ_STORAGE_KEY" \
    --destination "$container" --destination-path "$destination" \
    --source "$RUN_DIR" --overwrite --no-progress --only-show-errors > /dev/null \
    || die "the upload to $container/$destination/ failed."

  # Read back what the container holds rather than trusting the upload's exit
  # code: this is the only step whose failure would otherwise look like success.
  remote="$(
    az storage blob list \
      --account-name "$AZ_STORAGE_ACCOUNT" --account-key "$AZ_STORAGE_KEY" \
      --container-name "$container" --prefix "$destination/" \
      --query "[].[name,properties.contentLength]" -o tsv --only-show-errors \
      | sed "s|^$destination/||" | sort
  )" || die 'the uploaded objects could not be listed back.'
  expected="$(cd "$RUN_DIR" && for f in *; do printf '%s\t%s\n' "$f" "$(stat -c%s "$f")"; done | sort)"
  [ "$remote" = "$expected" ] || die "what the container holds does not match what was uploaded. Expected:
$expected
Found:
$remote"
  uploaded="$container/$destination"
  log 'upload verified against the local bytes'
fi

# --- rotation and state -------------------------------------------------------

write_json "$STATE_FILE" \
  lastGoodRun "$STAMP" \
  contentSha256 "$content_sha" \
  'users#' "$users" \
  'inviteCodes#' "$invite_codes" \
  uploadedTo "$uploaded" \
  tokenSource "$token_source"
chmod 600 "$STATE_FILE"

# Local copies are the fallback for the day object storage is the thing that is
# broken; the newest LOCAL_KEEP of them is plenty, and the old ones hold live
# invitation codes nobody is minding.
if [ "$LOCAL_KEEP" -gt 0 ]; then
  # shellcheck disable=SC2012
  ls -1d "$EXPORT_DIR"/*T*Z 2> /dev/null | sort -r | tail -n "+$((LOCAL_KEEP + 1))" | while read -r old; do
    log "pruning $old"
    rm -rf "$old"
  done
fi

record 'ok' "$users account(s), $invite_codes code(s), sha256 $content_sha → $uploaded"
log "done — $RUN_DIR → $uploaded"
