# Scheduled deployment export

Takes the deployment export off a running router once a day and puts it where
the router cannot take it along when it dies.

The need is not theoretical. The production install's only copy of its data has
twice been a file somebody remembered to download by hand, and once there was no
file at all: the cloud went down on 2026-10-13 with the accounts, balances,
invitation codes and redemptions inside it, and the rebuild started from an empty
database (SUP-308, SUP-313, SUP-359). This is the copy that makes the next
incident cost an hour.

It is **operator tooling, not part of the router**. Nothing here is deployed,
nothing runs in the enclave, and the deployment does not know it exists. The
proper home for a scheduled export is the router itself — an export target as a
deployment parameter, so the bundle never transits an operator's machine — and
when that ships, this goes away.

## What it does

```
router-export.sh [--local-only] [--quiet]
```

1. signs in at `POST /auth/bootstrap` with the deployment's `auth.bootstrapToken`
   — its designed break-glass purpose, and the only credential that works with
   nobody watching, because ordinary sign-in is a code mailed to a mailbox;
2. downloads `GET /admin/data/export` and `GET /admin/invite-codes/export.csv`;
3. signs the session out again, so a daily run does not leave ninety live
   administrator sessions behind in a quarter;
4. **verifies** before keeping anything: the bundle is readable gzipped JSON, its
   `data` hashes to the `integrity.contentSha256` it declares, that hash equals
   the `X-Export-Sha256` the response declared, every count in its manifest
   matches the rows it carries, the codes CSV starts with the header the importer
   accepts and holds a row per code the bundle counted;
5. **refuses an empty or shrinking export**: zero accounts is never a true
   reading of a live deployment, and counts that fall between two runs mean
   either a loss or a restore from something older. Either way the bundle is kept
   locally and not uploaded, so it cannot take the last good copy's place;
6. uploads the run directory to object storage and **reads back what the
   container holds**, comparing names and byte counts against the local files —
   the upload is the one step whose failure would otherwise look like success;
7. prunes local copies to the newest `LOCAL_KEEP`, and appends one line to
   `router-export.log`.

Any refusal exits non-zero, says why on stderr whatever `--quiet` asked for, and
posts a comment on the multica issue named by `ALERT_ISSUE_ID`. A silent backup
is the same as no backup, so the alert is not optional — `router-export-alert.sh`
covers even the failures that stop the script before it can speak, through the
unit's `OnFailure=`.

One run is one directory, named for the UTC instant it started:

```
<EXPORT_DIR>/20261017T031700Z/
  router-export-20261017T031700Z.json.gz
  invite-codes-20261017T031700Z.csv
  manifest.json
```

and the same three objects under `<BLOB_PREFIX>/<date>/<stamp>/` in the
container.

## Configuration

`~/.config/router-export/env`, mode `0600`:

| | |
|---|---|
| `ROUTER_API_ORIGIN` | `https://api.router.superprotocol.com` |
| `ROUTER_CONSOLE_ORIGIN` | `https://console.router.superprotocol.com` — sent as `Origin` |
| `ROUTER_BOOTSTRAP_TOKEN` | the deployment's `auth.bootstrapToken` |
| `BLOB_PREFIX` | prefix inside the container, e.g. `prod-exports` |
| `LOCAL_KEEP` | run directories kept on this host; `0` keeps all |
| `ALERT_ISSUE_ID` | issue a failed run comments on; empty disables the alert |
| `EXPORT_DIR` | optional; defaults to `~/prod-exports` |

Storage credentials are read from `~/.config/qa-publish/env`
(`AZ_STORAGE_ACCOUNT`, `AZ_STORAGE_KEY`, `AZ_STORAGE_CONTAINER`) — the key of the
storage account dedicated to artefacts, which is the only Azure credential an
agent host holds.

## Installing

```sh
ln -sf "$PWD/tools/scheduled-export/router-export.sh"       ~/bin/router-export
ln -sf "$PWD/tools/scheduled-export/router-export-alert.sh" ~/bin/router-export-alert
cp tools/scheduled-export/router-export*.service \
   tools/scheduled-export/router-export.timer ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now router-export.timer
sudo loginctl enable-linger "$USER"   # or the timer stops at logout
```

`03:17 UTC` daily with a 15-minute spread, `Persistent=true` so a host that was
off takes the export when it comes back rather than skipping the day.

Run it by hand any time; `--local-only` skips the upload.

## What the file holds, and what that costs

| In it | Not in it |
|---|---|
| accounts: address, name, sign-up date, which invitation each came from | chats, prompts, completions, generation logs |
| workspaces, balances, the whole credit ledger | API keys (hashed, they cannot move) |
| **every invitation code, including unredeemed ones** | upstream keys of external endpoints |
| external endpoints and the trust list | sessions, sign-in credentials |

No secrets in the cryptographic sense, and still personal data plus live
redeemable codes. Two consequences an operator agreed to by running this:

- **the copies sit in object storage on a schedule.** The container is private
  with anonymous access disabled, so a copy is reachable only with a key or a
  SAS nobody has minted. It is still personal data in a cloud account, written
  daily and not watched daily;
- **a long-lived administrator credential sits in a file.** `auth.bootstrapToken`
  is a password for the administrator account. `0600` on a host that already
  holds DNS and storage credentials is not a new class of exposure, but it is one
  more of them, and it is now used every day rather than once. Each use writes a
  `Break-glass sign-in` warning to the router's log, which is the audit trail
  that makes that acceptable — a run that nobody scheduled is visible there.

Rotating the token means rotating it in both places: reconfigure the deployment,
then rewrite the configuration file. A stale copy fails the next run with `401`
and says so.

## What it does not cover

- **A timer that never fires says nothing.** Every failure *of a run* is
  reported; a run that does not happen — because somebody disabled the timer,
  or the unit was never enabled after a host rebuild — is only visible as a
  `router-export.log` whose last line is old. `Persistent=true` covers a host
  that was merely switched off. Nothing here watches the watcher, and a second
  timer to check the first is the same bet one level up.
- **Where the copies live is where the credentials live.** The host that holds
  the storage key is the host that writes the backups, so losing it badly enough
  loses the ability to take new ones. The copies already written survive it.
- **The container's lifecycle deletes objects 30 days after they are written.**
  That is a month of dailies, which is the right shape for this, but it is not
  an archive: nothing here is the copy to reach for in a year.
- **The bundle is stored as it comes off the router** — not encrypted at rest
  beyond what the storage account does. Encrypting it would mean a key that has
  to outlive this host, which is a question with an owner, not a default.

All four shrink to nothing when the router exports itself to a target given as a
deployment parameter. That is the fix; this is the bridge to it.

## Tests

```sh
bash tools/scheduled-export/router-export.test.sh   # or: pnpm nx run scheduled-export:test
```

A fake router on loopback, built by the same canonical form the real one hashes
with, so "the hash matches" means something. Covers the good path, a refused
token, a missing bootstrap endpoint, a sign-in that sets no cookie, a failing
export, a truncated bundle, a hash the header disagrees with, a missing hash
header, an empty export, a short and a malformed codes CSV, a shrinking export, a
growing one, local rotation, and both missing-configuration refusals. Nothing
in the suite reaches the network or object storage.
