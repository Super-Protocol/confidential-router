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

    def json(self, status, payload, headers=()):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        for name, value in headers:
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(body)

    def read_body(self):
        length = int(self.headers.get('Content-Length') or 0)
        try:
            return json.loads(self.rfile.read(length) or b'{}')
        except ValueError:
            return {}

    def do_POST(self):
        s = read_scenario()
        # The marketplace half: sign-in is the only write the resolver makes.
        if self.path == '/api/auth/sign-in/email':
            status = s.get('mpSignInStatus', 200)
            if status != 200:
                self.json(status, {'message': 'no'})
                return
            self.json(200, {'user': {'email': self.read_body().get('email')}},
                      [('Set-Cookie', 'better-auth.session_token=fake; Path=/; HttpOnly')])
            return
        if self.path == '/auth/bootstrap':
            status = s.get('bootstrapStatus', 200)
            # A deployment only knows its own token. `routerToken` is what this
            # one was deployed with, so a run presenting the previous
            # deployment's token is refused exactly as production refuses it.
            wanted = s.get('routerToken')
            if status == 200 and wanted is not None and self.read_body().get('token') != wanted:
                status = 401
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
        if self.path == '/api/v1/organizations':
            self.json(200, s.get('mpOrganizations', [{'id': 'org-1', 'name': 'Super Protocol'}]))
            return
        if self.path.startswith('/api/v1/organizations/'):
            rest = self.path[len('/api/v1/organizations/'):].split('/')
            # …/<org>/deployments and …/<org>/deployments/<id>/credentials
            if len(rest) == 2 and rest[1] == 'deployments':
                self.json(200, [d for d in s.get('mpDeployments', []) if d.get('_org', 'org-1') == rest[0]])
                return
            if len(rest) == 4 and rest[3] == 'credentials':
                status = s.get('mpCredentialsStatus', 200)
                if status != 200:
                    self.json(status, {'message': 'no'})
                    return
                self.json(200, s.get('mpCredentials', {}).get(rest[2], []))
                return
            self.send_response(404)
            self.end_headers()
            return
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

# A stand-in for the `multica` CLI, so what the alert would have said is
# something a test can read. Every comment body is appended to one file: an
# alarm that fires is the half of this tool that cannot be checked by looking
# at its exit code.
cat > "$workdir/bin/multica" << 'EOF'
#!/usr/bin/env bash
file=''
while [ $# -gt 0 ]; do
  [ "$1" = --content-file ] && file="$2"
  shift
done
{
  printf -- '--- alert ---\n'
  [ -n "$file" ] && cat "$file"
} >> "$MULTICA_FAKE_LOG"
EOF
chmod +x "$workdir/bin/multica"
alerts_file="$workdir/alerts.txt"
: > "$alerts_file"
alerts() { cat "$alerts_file"; }
reset_alerts() { : > "$alerts_file"; }
alert_count() { grep -c -- '--- alert ---' "$alerts_file" || true; }

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

# --- the way out of a shrink (SUP-432) ----------------------------------------
#
# The refusal above is sticky by design, and that used to be a dead end: the
# baseline lives in state.json, which only a successful run rewrites, so the
# advice to "re-run" could never clear a true shrink. These cover the front door
# out of the loop, and that the record of having used it outlives the next run.

reset_state
set_scenario '{"users":3,"codes":9}'
run --local-only --quiet > /dev/null
set_scenario '{"users":1,"codes":9}'
out="$(run --local-only --quiet)"
expect_contains 'a shrinking export does not advise a bare re-run' "$out" 'Re-running on its own changes nothing'
expect_contains 'a shrinking export names the flag that clears it' "$out" "re-run with --accept-shrink 'why the counts fell'"
# `die` pastes the reason into a Markdown blockquote on the alert issue, where a
# renderer would read an angle-bracket placeholder as a raw HTML tag and drop it.
case "$out" in
  *'<'*) fail 'the remedy survives a Markdown renderer' "the refusal carries an angle bracket: $out" ;;
  *) pass 'the remedy survives a Markdown renderer' ;;
esac

# The loop the message warns about: without the flag, the second run compares
# against the same baseline and refuses the same way.
out="$(run --local-only --quiet)"
expect_eq 'a bare re-run refuses again' "$?" '1'
expect_contains 'a bare re-run compares against the same baseline' "$out" 'the export shrank: 3 → 1 account(s)'

acceptances="$HOME_DIR/prod-exports/shrink-acceptances.log"
out="$(run --local-only --quiet --accept-shrink 'the SUP-359 rehearsal account was withdrawn')"
expect_eq 'an accepted shrink exits 0' "$?" '0'
expect_contains 'an accepted shrink is loud even under --quiet' "$out" 'ACCEPTING A SHRINK — 3 → 1 account(s)'
expect_contains 'the acceptance log records what shrank' \
  "$(cat "$acceptances")" '3 → 1 account(s), 9 → 9 invitation code(s)'
expect_contains 'the acceptance log records the reason' \
  "$(cat "$acceptances")" 'the SUP-359 rehearsal account was withdrawn'
expect_eq 'one acceptance is one line' "$(grep -c '' "$acceptances")" '1'
expect_contains 'the run log shows the day the alarm was overruled' \
  "$(cat "$HOME_DIR/prod-exports/router-export.log")" 'ACCEPTED-SHRINK'
expect_contains 'an accepted shrink becomes the new baseline' \
  "$(cat "$HOME_DIR/prod-exports/state.json")" '"users": 1'
# The record has to leave the host too — only the run directory is uploaded.
accepted_run=("$HOME_DIR"/prod-exports/*T*Z)
if [ -f "${accepted_run[${#accepted_run[@]} - 1]}/shrink-acceptances.log" ]; then
  pass 'the acceptance is copied into the directory that gets uploaded'
else
  fail 'the acceptance is copied into the directory that gets uploaded' \
    "no shrink-acceptances.log under ${accepted_run[${#accepted_run[@]} - 1]}"
fi

# The whole reason the acceptance is not a field in state.json: the next good
# run rewrites that file wholesale, which is what erased the first acceptance
# when it was hand-edited in during the SUP-366 restore.
set_scenario '{"users":2,"codes":9}'
run --local-only --quiet > /dev/null
expect_contains 'the acceptance survives the next successful run' \
  "$(cat "$acceptances")" 'the SUP-359 rehearsal account was withdrawn'

# And a later acceptance appends to the record rather than replacing it. A
# reason pasted in off a comment thread can carry newlines; one acceptance has
# to stay one grep hit anyway.
set_scenario '{"users":1,"codes":9}'
run --local-only --quiet --accept-shrink 'withdrawn in SUP-366,
see the thread' > /dev/null
expect_eq 'a second acceptance appends' "$(grep -c '' "$acceptances")" '2'
expect_contains 'a reason with a newline in it stays one line' \
  "$(tail -1 "$acceptances")" 'withdrawn in SUP-366, see the thread'
expect_eq 'and so does the run log line' \
  "$(grep -c 'ACCEPTED-SHRINK' "$HOME_DIR/prod-exports/router-export.log")" '2'

# Nothing to accept: the flag is a no-op on a healthy run, not a licence that
# lingers in the state file. Said even under --quiet, because an operator who
# thinks they just blessed a shrink is wrong about the deployment.
set_scenario '{"users":5,"codes":9}'
out="$(run --local-only --quiet --accept-shrink 'nothing actually fell')"
expect_eq 'the flag with nothing to accept exits 0' "$?" '0'
expect_contains 'the flag with nothing to accept says so even under --quiet' "$out" 'nothing shrank'
expect_eq 'the flag with nothing to accept writes no acceptance' "$(grep -c '' "$acceptances")" '2'

# The reason is the entire value of the record, so a missing or blank one is an
# error rather than an empty field in the log.
out="$(run --local-only --quiet --accept-shrink)"
expect_eq 'a reasonless acceptance exits 2' "$?" '2'
expect_contains 'a reasonless acceptance says it needs a reason' "$out" 'needs a reason'

out="$(run --local-only --quiet --accept-shrink '   ')"
expect_eq 'a blank reason exits 2' "$?" '2'
expect_contains 'a blank reason says it needs a reason' "$out" 'needs a reason'

# `--accept-shrink --local-only` must not swallow --local-only as the reason:
# that would upload a shrunk bundle the operator meant to keep on this host.
out="$(run --quiet --accept-shrink --local-only)"
expect_eq 'a flag where the reason should be exits 2' "$?" '2'
expect_contains 'a flag where the reason should be is not taken as one' "$out" 'needs a reason'

# But only `--` is a flag. A reason is prose, and prose starts with whatever it
# starts with — refusing "-2 accounts" would send the operator back to editing
# state.json by hand, which is the habit this flag exists to replace.
set_scenario '{"users":3,"codes":9}'
run --local-only --quiet > /dev/null
set_scenario '{"users":2,"codes":9}'
out="$(run --local-only --quiet --accept-shrink '-1 rehearsal account, withdrawn')"
expect_eq 'a reason starting with a single dash is a reason' "$?" '0'
expect_contains 'a reason starting with a single dash is recorded verbatim' \
  "$(tail -1 "$acceptances")" '-1 rehearsal account, withdrawn'

# The read-back compares the container's objects against the run directory's,
# so the copy an accepting run adds has to be on both sides of that comparison
# — a fourth file would otherwise turn every accepted shrink into a refusal.
reset_state
az_mode ok
set_scenario '{"users":3,"codes":9}'
run_with_blob_env --quiet > /dev/null
set_scenario '{"users":2,"codes":9}'
out="$(run_with_blob_env --quiet --accept-shrink 'the rehearsal account was withdrawn')"
expect_eq 'an accepted shrink uploads and passes the read-back' "$?" '0'
expect_contains 'an accepted shrink records where it was uploaded' \
  "$(cat "$HOME_DIR/prod-exports/state.json")" '"uploadedTo": "prod-exports/'

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

# --- the bootstrap token is read off the deployment, not written down ---------
#
# `auth.bootstrapToken` belongs to one deployment and a production rebuild mints
# a new one, so the question these ask is the one SUP-438 is about: what happens
# to the backup the night after a rebuild. The fake router here only accepts the
# token its own `routerToken` names, exactly as a freshly rebuilt deployment
# refuses the previous one's.

STALE_TOKEN='the-previous-deployments-token-32'
FIRST_TOKEN='the-first-deployments-token-3232'
SECOND_TOKEN='the-second-deployments-token-323'

# write_marketplace_config <stored-token> [marketplace-origin] [alert-issue]
write_marketplace_config() {
  cat > "$HOME_DIR/.config/router-export/env" << EOF
ROUTER_API_ORIGIN=http://127.0.0.1:$PORT
ROUTER_CONSOLE_ORIGIN=http://127.0.0.1:$PORT
MARKETPLACE_ORIGIN=${2:-http://127.0.0.1:$PORT}
MARKETPLACE_EMAIL=ops@example.test
MARKETPLACE_PASSWORD=not-a-real-password
ROUTER_BOOTSTRAP_TOKEN=$1
EXPORT_CONTAINER=prod-exports
LOCAL_KEEP=7
ALERT_ISSUE_ID=${3-}
EOF
}

# The alerts are the other half of what is under test: a refusal nobody is told
# about is the defect, not the symptom. So these runs get a `multica` on PATH.
run_watched() {
  HOME="$HOME_DIR" \
    PATH="$workdir/bin:$PATH" \
    MULTICA_FAKE_LOG="$alerts_file" \
    ROUTER_EXPORT_CONFIG="$HOME_DIR/.config/router-export/env" \
    EXPORT_DIR="$HOME_DIR/prod-exports" \
    bash "$script" "$@" 2>&1
}

# deployment <id> <status> <hostname> <created>
deployment() {
  printf '{"id":"%s","status":"%s","appVersion":"0.19.0","createdAt":"%s","parameters":{"apiHostname":"%s"}}' \
    "$1" "$2" "$4" "$3"
}
credential() { printf '{"%s":[{"id":"bootstrapToken","title":"First sign-in token","value":"%s","source":"parameter"}]}' "$1" "$2"; }

reset_state
reset_alerts
write_marketplace_config "$STALE_TOKEN" '' alert-issue
set_scenario "{\"routerToken\":\"$FIRST_TOKEN\",
  \"mpDeployments\":[$(deployment dep-1 running 127.0.0.1 2026-10-01T00:00:00Z)],
  \"mpCredentials\":$(credential dep-1 "$FIRST_TOKEN")}"
out="$(run_watched --local-only --quiet)"
expect_eq 'the token off the deployment is preferred to the stored one' "$?" '0'
expect_contains 'the run records which deployment it got the token from' \
  "$(cat "$HOME_DIR/prod-exports/state.json")" '"tokenSource": "deployment dep-1'

# A rebuild, as it actually looks from here: the old deployment is on its way
# out and still answers to the hostname, a new one is running with a token of
# its own, and nobody has touched the config file.
set_scenario "{\"routerToken\":\"$SECOND_TOKEN\",
  \"mpDeployments\":[$(deployment dep-1 deleting 127.0.0.1 2026-10-01T00:00:00Z),
                     $(deployment dep-2 running 127.0.0.1 2026-10-20T12:00:00Z)],
  \"mpCredentials\":{$(credential dep-1 "$FIRST_TOKEN" | sed 's/^{//; s/}$//'),
                     $(credential dep-2 "$SECOND_TOKEN" | sed 's/^{//; s/}$//')}}"
out="$(run_watched --local-only --quiet)"
expect_eq 'a rebuild that rotates the token does not stop the export' "$?" '0'
expect_contains 'the rebuilt deployment is the one it reads from' \
  "$(cat "$HOME_DIR/prod-exports/state.json")" '"tokenSource": "deployment dep-2'
expect_eq 'a rebuild it survived raises no alarm' "$(alert_count)" '0'

# The same rebuild against the tool as it was: the stored token is all there is,
# and it is now the previous deployment's. The run has to fail, and the failure
# has to reach the issue rather than only the log.
reset_state
reset_alerts
cat > "$HOME_DIR/.config/router-export/env" << EOF
ROUTER_API_ORIGIN=http://127.0.0.1:$PORT
ROUTER_CONSOLE_ORIGIN=http://127.0.0.1:$PORT
ROUTER_BOOTSTRAP_TOKEN=$FIRST_TOKEN
EXPORT_CONTAINER=prod-exports
LOCAL_KEEP=7
ALERT_ISSUE_ID=alert-issue
EOF
out="$(run_watched --local-only --quiet)"
expect_eq 'a stored token the rebuild invalidated exits non-zero' "$?" '1'
expect_contains 'it names the stored token as the thing that was refused' "$out" 'refused (401)'
expect_eq 'it raises exactly one alarm' "$(alert_count)" '1'
expect_contains 'the alarm says the export failed' "$(alerts)" 'Scheduled production export failed'
expect_contains 'the alarm carries the reason' "$(alerts)" '401'

# --- when the marketplace itself cannot be reached ----------------------------
#
# Falling back to the stored token is right — a backup that stops because a
# second system is down is worse than the problem — but it silently re-arms the
# defect, so it is said out loud, once per outage.

reset_state
reset_alerts
write_marketplace_config "$SECOND_TOKEN" 'http://127.0.0.1:9' alert-issue
set_scenario "{\"routerToken\":\"$SECOND_TOKEN\",\"mpDeployments\":[]}"
out="$(run_watched --local-only --quiet)"
expect_eq 'an unreachable marketplace still takes the backup' "$?" '0'
expect_contains 'it says it fell back to the stored token' "$out" 'falling back to the stored'
expect_eq 'the fallback raises an alarm of its own' "$(alert_count)" '1'
expect_contains 'the alarm explains what the fallback costs' "$(alerts)" 'back on a stored bootstrap token'

out="$(run_watched --local-only --quiet)"
expect_eq 'the second degraded run still takes the backup' "$?" '0'
expect_eq 'but does not repeat the alarm every night' "$(alert_count)" '1'

write_marketplace_config "$SECOND_TOKEN" '' alert-issue
set_scenario "{\"routerToken\":\"$SECOND_TOKEN\",
  \"mpDeployments\":[$(deployment dep-2 running 127.0.0.1 2026-10-20T12:00:00Z)],
  \"mpCredentials\":$(credential dep-2 "$SECOND_TOKEN")}"
out="$(run_watched --local-only)"
expect_contains 'a recovered lookup says so' "$out" 'can be read off the deployment again'
if [ -f "$HOME_DIR/prod-exports/.token-lookup-degraded" ]; then
  fail 'recovery clears the once-per-outage flag' 'the flag is still there'
else
  pass 'recovery clears the once-per-outage flag'
fi

# --- refusals from the lookup itself ------------------------------------------

reset_state
reset_alerts
write_marketplace_config '' 'http://127.0.0.1:9' alert-issue
out="$(run_watched --local-only --quiet)"
expect_eq 'no stored token and no marketplace is a refusal' "$?" '1'
expect_contains 'it says the deployment could not be asked' "$out" 'could not be read off the deployment'
expect_contains 'it says there was nothing to fall back to' "$out" 'no ROUTER_BOOTSTRAP_TOKEN'

reset_state
write_marketplace_config ''
set_scenario "{\"routerToken\":\"$SECOND_TOKEN\",
  \"mpDeployments\":[$(deployment dep-9 running api.elsewhere.test 2026-10-20T12:00:00Z)],
  \"mpCredentials\":$(credential dep-9 "$SECOND_TOKEN")}"
out="$(run --local-only --quiet)"
expect_eq 'a deployment serving another hostname is not this one' "$?" '1'
expect_contains 'it names the hostnames it did see' "$out" 'api.elsewhere.test'

reset_state
write_marketplace_config ''
set_scenario "{\"routerToken\":\"$SECOND_TOKEN\",\"mpSignInStatus\":401,
  \"mpDeployments\":[$(deployment dep-2 running 127.0.0.1 2026-10-20T12:00:00Z)]}"
out="$(run --local-only --quiet)"
expect_contains 'a marketplace account that cannot sign in says so' "$out" 'refused the sign-in'

reset_state
write_marketplace_config ''
set_scenario "{\"routerToken\":\"$SECOND_TOKEN\",\"mpCredentialsStatus\":403,
  \"mpDeployments\":[$(deployment dep-2 running 127.0.0.1 2026-10-20T12:00:00Z)]}"
out="$(run --local-only --quiet)"
expect_contains 'a viewer is told which role reading the token needs' "$out" '"member" role'

reset_state
write_marketplace_config ''
set_scenario "{\"routerToken\":\"$SECOND_TOKEN\",
  \"mpDeployments\":[$(deployment dep-2 running 127.0.0.1 2026-10-20T12:00:00Z)],
  \"mpCredentials\":{\"dep-2\":[]}}"
out="$(run --local-only --quiet)"
expect_contains 'a deployment whose token was supplied by hand says so' "$out" 'no bootstrapToken among its generated values'

# Half a marketplace reads as "the modern way is on" while falling back every
# night, which is the defect wearing the fix's clothes.
reset_state
cat > "$HOME_DIR/.config/router-export/env" << EOF
ROUTER_API_ORIGIN=http://127.0.0.1:$PORT
MARKETPLACE_ORIGIN=http://127.0.0.1:$PORT
ROUTER_BOOTSTRAP_TOKEN=$SECOND_TOKEN
ALERT_ISSUE_ID=
EOF
out="$(run --local-only --quiet)"
expect_eq 'a half-configured marketplace is refused' "$?" '1'
expect_contains 'and says which half is missing' "$out" 'MARKETPLACE_EMAIL'

# Back to a plain configuration, so anything added after this starts where the
# rest of the suite expects to be.
write_config
reset_state
set_scenario '{"users":2,"codes":3}'

printf '\n'
if [ "$failures" -gt 0 ]; then
  printf '%d failure(s)\n' "$failures"
  exit 1
fi
printf 'all tests passed\n'
