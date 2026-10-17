#!/usr/bin/env bash
# Tests for router-export.sh, against a fake router served over HTTP.
#
#   bash tools/scheduled-export/router-export.test.sh   # or: pnpm nx run scheduled-export:test
#
# The fake router is python3's http.server with a handler that answers
# /auth/bootstrap, /admin/data/export and /admin/invite-codes/export.csv with
# whatever the current scenario asked for. The bundles are real: built by the
# same canonical form the router hashes with, so a test that says "the hash
# matches" is saying something.
#
# Nothing here uploads: every run is --local-only, and the one test that covers
# the upload path covers it by proving the script refuses when the storage
# credentials are missing.

set -uo pipefail

here="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
script="$here/router-export.sh"

failures=0
server_pid=''
workdir=''

cleanup() {
  [ -n "$server_pid" ] && kill "$server_pid" 2> /dev/null
  [ -n "$workdir" ] && [ -d "$workdir" ] && rm -rf "$workdir"
  return 0
}
trap cleanup EXIT INT TERM

pass() { printf '  ok   %s\n' "$1"; }
fail() {
  printf '  FAIL %s\n     %s\n' "$1" "$2"
  failures=$((failures + 1))
}

expect_eq() {
  if [ "$2" = "$3" ]; then pass "$1"; else fail "$1" "expected [$3], got [$2]"; fi
}

expect_contains() {
  case "$2" in
    *"$3"*) pass "$1" ;;
    *) fail "$1" "expected output to contain [$3], got [$2]" ;;
  esac
}

# --- the fake router ----------------------------------------------------------

workdir="$(mktemp -d "${TMPDIR:-/tmp}/router-export-test.XXXXXXXX")"
scenario="$workdir/scenario"
mkdir -p "$workdir/home/bin" "$workdir/home/.config/router-export"

cat > "$workdir/fake-router.py" << 'PY'
import gzip, hashlib, http.server, json, os, sys


def canonical(value):
    if isinstance(value, list):
        return '[' + ','.join(canonical(v) for v in value) + ']'
    if isinstance(value, dict):
        items = sorted(value.items())
        return '{' + ','.join(json.dumps(k) + ':' + canonical(v) for k, v in items) + '}'
    return json.dumps(value)


def bundle(users, codes, fmt='router-export', schema=1):
    data = {
        'users': [{'id': f'u{i}', 'email': f'u{i}@example.test'} for i in range(users)],
        'workspaces': [],
        'workspaceMembers': [],
        'creditLedger': [],
        'inviteCodes': [
            {'code': f'AAAA-BBBB-{i:04d}', 'campaign': 'test', 'status': 'unredeemed'} for i in range(codes)
        ],
        'inviteRedemptions': [],
        'externalEndpoints': [],
        'trustedMeasurements': [],
    }
    sha = hashlib.sha256(canonical(data).encode()).hexdigest()
    doc = {
        'format': fmt,
        'schemaVersion': schema,
        'exportedAt': '2026-10-17T03:17:00.000Z',
        'source': {'publicBaseUrl': 'http://127.0.0.1', 'routerVersion': '0.0.0-test'},
        'counts': {
            'users': users,
            'workspaces': 0,
            'workspaceMembers': 0,
            'creditEntries': 0,
            'inviteCampaigns': 1 if codes else 0,
            'inviteCodes': codes,
            'inviteCodesUnredeemed': codes,
            'inviteRedemptions': 0,
            'externalEndpoints': 0,
            'externalModels': 0,
            'trustedMeasurements': 0,
        },
        'totalBalanceMicros': '0',
        'data': data,
        'integrity': {'contentSha256': sha},
    }
    return gzip.compress(json.dumps(doc).encode()), sha


def csv(codes):
    header = 'code,url,campaign,grantUsd,status,redeemedByEmail,redeemedAt,createdAt,expiresAt,withdrawnAt,maxRedemptions,note\n'
    rows = ''.join(f'AAAA-BBBB-{i:04d},http://x,test,100,active,,,,,,1,\n' for i in range(codes))
    return (header + rows).encode()


SCENARIO = sys.argv[1]


def read_scenario():
    with open(SCENARIO) as f:
        return json.load(f)


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        s = read_scenario()
        if self.path == '/auth/bootstrap':
            status = s.get('bootstrapStatus', 200)
            self.send_response(status)
            if status == 200 and s.get('setCookie', True):
                # Without the __Secure- prefix the real router uses: curl
                # refuses to store a __Secure- cookie off an https connection,
                # and this fake is plain http on loopback.
                self.send_header('Set-Cookie', 'cr_session=fake; Path=/')
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(b'{"user":{"id":"u0","email":"admin@example.test"}}')
            return
        self.send_response(200)
        self.end_headers()

    def do_GET(self):
        s = read_scenario()
        users, codes = s.get('users', 2), s.get('codes', 3)
        if self.path.startswith('/admin/data/export'):
            status = s.get('exportStatus', 200)
            if status != 200:
                self.send_response(status)
                self.end_headers()
                return
            body, sha = bundle(users, codes, s.get('format', 'router-export'), s.get('schemaVersion', 1))
            if s.get('truncate'):
                body = body[: len(body) // 2]
            self.send_response(200)
            self.send_header('Content-Type', 'application/gzip')
            if not s.get('dropShaHeader'):
                self.send_header('X-Export-Sha256', s.get('headerSha') or sha)
            self.end_headers()
            self.wfile.write(body)
            return
        if self.path.startswith('/admin/invite-codes/export.csv'):
            rows = s.get('csvCodes', codes)
            body = csv(rows) if not s.get('badCsvHeader') else b'nope,not,the,header\n'
            self.send_response(200)
            self.send_header('Content-Type', 'text/csv')
            self.end_headers()
            self.wfile.write(body)
            return
        self.send_response(404)
        self.end_headers()


server = http.server.HTTPServer(('127.0.0.1', 0), Handler)
with open(os.environ['PORT_FILE'], 'w') as f:
    f.write(str(server.server_address[1]))
server.serve_forever()
PY

set_scenario() { printf '%s' "$1" > "$scenario"; }

set_scenario '{}'
PORT_FILE="$workdir/port" python3 "$workdir/fake-router.py" "$scenario" &
server_pid=$!
for _ in $(seq 1 50); do
  [ -s "$workdir/port" ] && break
  sleep 0.1
done
[ -s "$workdir/port" ] || {
  echo 'the fake router did not start' >&2
  exit 1
}
PORT="$(cat "$workdir/port")"

# --- running the script -------------------------------------------------------

# A home of its own, so a developer's real ~/.config and ~/prod-exports are
# never what a test reads or prunes.
HOME_DIR="$workdir/home"

# write_config [local_keep] [export_container]
#   export_container 'unset' leaves EXPORT_CONTAINER out of the file entirely,
#   which is how the fallback chain gets exercised.
write_config() {
  cat > "$HOME_DIR/.config/router-export/env" << EOF
ROUTER_API_ORIGIN=http://127.0.0.1:$PORT
ROUTER_CONSOLE_ORIGIN=http://127.0.0.1:$PORT
ROUTER_BOOTSTRAP_TOKEN=a-token-of-at-least-32-characters-long
BLOB_PREFIX=prod-exports
LOCAL_KEEP=${1:-7}
ALERT_ISSUE_ID=
EOF
  case "${2:-prod-exports}" in
    unset) : ;;
    *) printf 'EXPORT_CONTAINER=%s\n' "${2:-prod-exports}" >> "$HOME_DIR/.config/router-export/env" ;;
  esac
}

# What the qa-publish env looks like: the account and key this tool borrows, and
# an AZ_STORAGE_CONTAINER that has to keep meaning qa-artifacts for qa-publish.
cat > "$workdir/blob-env" << 'EOF'
AZ_STORAGE_ACCOUNT=notanaccount
AZ_STORAGE_KEY=bm90YWtleQ==
AZ_STORAGE_CONTAINER=qa-artifacts
EOF

# A stand-in for `az`, so the upload path is covered without a storage account
# and without the real CLI's start-up and DNS retries — three seconds a call,
# which is the difference between a suite that gets run and one that does not.
# `$workdir/az-mode` chooses what it pretends happened.
mkdir -p "$workdir/bin"
cat > "$workdir/bin/az" << 'EOF'
#!/usr/bin/env bash
mode="$(cat "$AZ_FAKE_MODE" 2> /dev/null || echo ok)"
action="$1 $2 $3"
prefix=''
while [ $# -gt 0 ]; do
  [ "$1" = --prefix ] && prefix="$2"
  shift
done
case "$action" in
  'storage blob upload-batch')
    [ "$mode" = upload-fails ] && exit 1
    exit 0
    ;;
  'storage blob list')
    [ "$mode" = list-fails ] && exit 1
    # The objects the container would hold: whatever the run directory holds,
    # found through the stamp at the tail of the prefix.
    dir="$AZ_FAKE_EXPORT_DIR/$(basename "${prefix%/}")"
    for f in "$dir"/*; do
      size="$(stat -c%s "$f")"
      [ "$mode" = wrong-size ] && size=$((size + 1))
      [ "$mode" = missing-one ] && case "$f" in *manifest.json) continue ;; esac
      printf '%s%s\t%s\n' "$prefix" "$(basename "$f")" "$size"
    done
    exit 0
    ;;
esac
exit 0
EOF
chmod +x "$workdir/bin/az"
az_mode() { printf '%s' "$1" > "$workdir/az-mode"; }
az_mode ok

# Resolving the container happens before any `az` call, so the container
# refusals below are reached whether or not `az` can do anything.
run_with_blob_env() {
  HOME="$HOME_DIR" \
    PATH="$workdir/bin:$PATH" \
    AZ_FAKE_MODE="$workdir/az-mode" \
    AZ_FAKE_EXPORT_DIR="$HOME_DIR/prod-exports" \
    ROUTER_EXPORT_CONFIG="$HOME_DIR/.config/router-export/env" \
    ROUTER_EXPORT_BLOB_CONFIG="$workdir/blob-env" \
    EXPORT_DIR="$HOME_DIR/prod-exports" \
    bash "$script" "$@" 2>&1
}

run() {
  HOME="$HOME_DIR" \
    ROUTER_EXPORT_CONFIG="$HOME_DIR/.config/router-export/env" \
    EXPORT_DIR="$HOME_DIR/prod-exports" \
    bash "$script" "$@" 2>&1
}

reset_state() { rm -rf "$HOME_DIR/prod-exports"; }

# --- tests --------------------------------------------------------------------

printf 'router-export.sh\n'

write_config
reset_state
set_scenario '{"users":2,"codes":3}'
out="$(run --local-only --quiet)"
expect_eq 'a good export exits 0' "$?" '0'
runs=("$HOME_DIR"/prod-exports/*T*Z)
if [ -f "${runs[0]}/manifest.json" ]; then
  pass 'it writes a manifest beside the bundle'
  manifest="$(cat "${runs[0]}/manifest.json")"
  expect_contains 'the manifest records the account count' "$manifest" '"users": 2'
  expect_contains 'the manifest records the code count' "$manifest" '"inviteCodes": 3'
else
  fail 'it writes a manifest beside the bundle' "no manifest under ${runs[0]}"
fi
expect_contains 'the log records the run' "$(cat "$HOME_DIR/prod-exports/router-export.log")" 'ok'
expect_contains 'it remembers the counts for next time' "$(cat "$HOME_DIR/prod-exports/state.json")" '"users": 2'
if ls "${runs[0]}"/invite-codes-*.csv > /dev/null 2>&1; then
  pass 'it keeps the invitation codes beside the bundle'
else
  fail 'it keeps the invitation codes beside the bundle' "no CSV under ${runs[0]}"
fi
mode="$(stat -c%a "${runs[0]}"/router-export-*.json.gz)"
expect_eq 'the bundle is readable only by its owner' "$mode" '600'

reset_state
set_scenario '{"bootstrapStatus":401}'
out="$(run --local-only --quiet)"
expect_eq 'a refused token exits non-zero' "$?" '1'
expect_contains 'a refused token says the token was refused' "$out" 'bootstrap token was refused'

reset_state
set_scenario '{"bootstrapStatus":404}'
out="$(run --local-only --quiet)"
expect_contains 'a 404 bootstrap says the endpoint is not there' "$out" 'no bootstrap endpoint'

reset_state
set_scenario '{"bootstrapStatus":200,"setCookie":false}'
out="$(run --local-only --quiet)"
expect_contains 'a sign-in with no cookie is refused' "$out" 'set no session cookie'

reset_state
set_scenario '{"exportStatus":500}'
out="$(run --local-only --quiet)"
expect_contains 'a failed export is refused' "$out" 'export answered HTTP 500'

reset_state
set_scenario '{"users":2,"codes":3,"truncate":true}'
out="$(run --local-only --quiet)"
expect_eq 'a truncated bundle exits non-zero' "$?" '1'
expect_contains 'a truncated bundle says it was truncated' "$out" 'truncated in transit'

reset_state
set_scenario '{"users":2,"codes":3,"headerSha":"0000000000000000000000000000000000000000000000000000000000000000"}'
out="$(run --local-only --quiet)"
expect_contains 'a hash the header disagrees with is refused' "$out" 'is not what was sent'

reset_state
set_scenario '{"users":2,"codes":3,"dropShaHeader":true}'
out="$(run --local-only --quiet)"
expect_contains 'an export with no hash header is refused' "$out" 'no X-Export-Sha256'

reset_state
set_scenario '{"users":2,"codes":3,"format":"something-else"}'
out="$(run --local-only --quiet)"
expect_contains 'a file that is not a router export is refused' "$out" 'which is not a router export'

reset_state
set_scenario '{"users":2,"codes":3,"schemaVersion":2}'
out="$(run --local-only --quiet)"
expect_contains 'a newer schema version is refused' "$out" 'this checker knows version 1'

reset_state
set_scenario '{"users":0,"codes":0}'
out="$(run --local-only --quiet)"
expect_eq 'an empty export exits non-zero' "$?" '1'
expect_contains 'an empty export says it is empty, not small' "$out" 'empty, not small'

reset_state
set_scenario '{"users":2,"codes":3,"csvCodes":1}'
out="$(run --local-only --quiet)"
expect_contains 'a short codes CSV is refused' "$out" 'one of the two is incomplete'

reset_state
set_scenario '{"users":2,"codes":3,"badCsvHeader":true}'
out="$(run --local-only --quiet)"
expect_contains 'a codes CSV with the wrong header is refused' "$out" 'header the importer accepts'

# A deployment that came back from an older copy, or lost rows: the counts fall.
reset_state
set_scenario '{"users":3,"codes":9}'
run --local-only --quiet > /dev/null
set_scenario '{"users":1,"codes":9}'
out="$(run --local-only --quiet)"
expect_eq 'a shrinking export exits non-zero' "$?" '1'
expect_contains 'a shrinking export says what shrank' "$out" 'the export shrank: 3 → 1 account(s)'

# And a growing one does not.
set_scenario '{"users":4,"codes":12}'
out="$(run --local-only --quiet)"
expect_eq 'a growing export is fine' "$?" '0'

reset_state
write_config 2
for _ in 1 2 3 4; do
  set_scenario '{"users":2,"codes":3}'
  run --local-only --quiet > /dev/null
  sleep 1.1
done
kept="$(ls -1d "$HOME_DIR"/prod-exports/*T*Z | wc -l)"
expect_eq 'it keeps only LOCAL_KEEP run directories' "$kept" '2'

write_config
reset_state
set_scenario '{"users":2,"codes":3}'
out="$(
  HOME="$HOME_DIR" \
    ROUTER_EXPORT_CONFIG="$HOME_DIR/.config/router-export/env" \
    ROUTER_EXPORT_BLOB_CONFIG="$workdir/nonexistent-blob-env" \
    EXPORT_DIR="$HOME_DIR/prod-exports" \
    bash "$script" --quiet 2>&1
)"
expect_eq 'no storage credentials exits non-zero' "$?" '1'
expect_contains 'no storage credentials says where it looked' "$out" 'no readable storage credentials'

# The container question (SUP-317 pre-review): the account is shared with
# qa-publish, the container must not be.
write_config 7 unset
reset_state
set_scenario '{"users":2,"codes":3}'
out="$(run_with_blob_env --quiet)"
expect_eq 'falling through to qa-artifacts exits non-zero' "$?" '1'
expect_contains 'falling through to qa-artifacts is refused by name' "$out" "refusing to upload to 'qa-artifacts'"
expect_contains 'the refusal says which knob fixes it' "$out" 'set EXPORT_CONTAINER'

write_config 7 qa-artifacts
reset_state
out="$(run_with_blob_env --quiet)"
expect_contains 'naming qa-artifacts outright is refused too' "$out" "refusing to upload to 'qa-artifacts'"

# And EXPORT_CONTAINER wins over the AZ_STORAGE_CONTAINER that arrives with the
# credentials — which is the whole point of the override.
write_config 7 prod-exports
reset_state
az_mode ok
out="$(run_with_blob_env --quiet)"
expect_eq 'EXPORT_CONTAINER gets past the guard' "$?" '0'
expect_contains 'the upload goes to EXPORT_CONTAINER, not the credentials one' \
  "$(cat "$HOME_DIR/prod-exports/state.json")" '"uploadedTo": "prod-exports/'

# The read-back after the upload is the only check standing between a lost
# object and a run that reported success, so all three of its readings matter.
reset_state
az_mode upload-fails
out="$(run_with_blob_env --quiet)"
expect_eq 'an upload that fails exits non-zero' "$?" '1'
expect_contains 'an upload that fails names the destination' "$out" 'the upload to prod-exports/'

reset_state
az_mode wrong-size
out="$(run_with_blob_env --quiet)"
expect_eq 'a container holding different bytes exits non-zero' "$?" '1'
expect_contains 'a container holding different bytes is refused' "$out" 'does not match what was uploaded'

reset_state
az_mode missing-one
out="$(run_with_blob_env --quiet)"
expect_contains 'a container missing an object is refused' "$out" 'does not match what was uploaded'

reset_state
az_mode list-fails
out="$(run_with_blob_env --quiet)"
expect_contains 'objects that cannot be listed back are refused' "$out" 'could not be listed back'
az_mode ok

# Port 9 (discard) is reserved and nothing listens on it here, so curl reports
# no response at all — the reading that used to be unreachable because the
# status was assembled from two sources.
cat > "$workdir/dead-router-env" << EOF
ROUTER_API_ORIGIN=http://127.0.0.1:9
ROUTER_CONSOLE_ORIGIN=http://127.0.0.1:9
ROUTER_BOOTSTRAP_TOKEN=a-token-of-at-least-32-characters-long
LOCAL_KEEP=7
ALERT_ISSUE_ID=
EOF
reset_state
out="$(
  HOME="$HOME_DIR" \
    ROUTER_EXPORT_CONFIG="$workdir/dead-router-env" \
    EXPORT_DIR="$HOME_DIR/prod-exports" \
    bash "$script" --local-only --quiet 2>&1
)"
expect_eq 'a router that does not answer exits non-zero' "$?" '1'
expect_contains 'a router that does not answer says so' "$out" 'did not answer'

out="$(
  HOME="$HOME_DIR" ROUTER_EXPORT_CONFIG="$workdir/nonexistent-env" bash "$script" --quiet 2>&1
)"
expect_contains 'no configuration says where it looked' "$out" 'no readable configuration at'

out="$(HOME="$HOME_DIR" bash "$script" --nonsense 2>&1)"
expect_contains 'an unknown argument is refused' "$out" 'unknown argument'

printf '\n'
if [ "$failures" -gt 0 ]; then
  printf '%d failure(s)\n' "$failures"
  exit 1
fi
printf 'all tests passed\n'
