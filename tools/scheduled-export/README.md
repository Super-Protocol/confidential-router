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
   locally and not uploaded, so it cannot take the last good copy's place
   (*Accepting a legitimate shrink*, below, is how an operator overrules this);
6. uploads the run directory to a container of its own — never the shared
   artefact container; see *Configuration* — and **reads back what that container
   holds**, comparing names and byte counts against the local files, because the
   upload is the one step whose failure would otherwise look like success;
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

and the same three objects under `<date>/<stamp>/` in the container — prefixed
by `BLOB_PREFIX` if one is set, which a container of this tool's own does not
need.

## Configuration

`~/.config/router-export/env`, mode `0600`:

| | |
|---|---|
| `ROUTER_API_ORIGIN` | `https://api.router.superprotocol.com` |
| `ROUTER_CONSOLE_ORIGIN` | `https://console.router.superprotocol.com` — sent as `Origin` |
| `ROUTER_BOOTSTRAP_TOKEN` | the deployment's `auth.bootstrapToken` |
| `EXPORT_CONTAINER` | the container these go in — a container of their own, e.g. `prod-exports` |
| `BLOB_PREFIX` | optional prefix inside it; leave empty in a dedicated container |
| `LOCAL_KEEP` | run directories kept on this host; `0` keeps all |
| `ALERT_ISSUE_ID` | issue a failed run comments on; empty disables the alert |
| `EXPORT_DIR` | optional; defaults to `~/prod-exports` |

Storage credentials are read from `~/.config/qa-publish/env`
(`AZ_STORAGE_ACCOUNT`, `AZ_STORAGE_KEY`) — the key of the storage account
dedicated to artefacts, which is the only Azure credential an agent host holds.

**The account is shared with `qa-publish`; the container is not.** `qa-artifacts`
exists to have read-only SAS links minted off it and pasted into issue comments,
and a bundle of personal data and live invitation codes has no business being one
prefix away from that habit. So `EXPORT_CONTAINER` from *this* configuration wins
over the `AZ_STORAGE_CONTAINER` that arrives with the credentials — which has to
keep meaning `qa-artifacts` for `qa-publish` — and the script **refuses outright**
to upload to `qa-artifacts`, however it was asked to. The fallback chain reaches
that container the moment `EXPORT_CONTAINER` is forgotten, which is exactly when
nobody is watching, so the refusal is in the code and not in this paragraph.

Creating the container needs only the same account key:

```sh
az storage container create --account-name "$AZ_STORAGE_ACCOUNT" \
  --account-key "$AZ_STORAGE_KEY" --name prod-exports --public-access off
```

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

**Point those symlinks at a checkout that will still be there.** Installing from
a throwaway worktree works until somebody tidies the worktree up, and then the
unit's `ExecStart` names a file that is gone. It fails loudly — the timer's
`OnFailure=` still reaches a person, which is the design behaving — but it is a
break nobody intended, so the long-lived clone is the right place to point at:

```sh
ln -sf ~/projects/sp/confidential-router/tools/scheduled-export/router-export.sh ~/bin/router-export
```

`verify-bundle.mjs` is found beside the script through `readlink -f`, so moving
the checkout only ever means re-pointing these two symlinks.

### Accepting a legitimate shrink

Not every fall in the counts is a loss. A withdrawn test account, a deleted
campaign, a cleaned-up endpoint — each one makes the next export smaller than the
last, and the script refuses it on principle because it cannot tell that apart
from a deployment that came back from an older copy. The refusal is **sticky**:
`state.json` still holds the old counts, so every re-run refuses again until a
person says the new reading is the right one.

That person's move is to edit `~/prod-exports/state.json` — lower `users` and
`inviteCodes` to what the deployment really holds now, or delete the file to make
the next run the new baseline — and then re-run `router-export`. Deleting it
costs only the comparison for one run; nothing else reads it.

Check the *reason* for the shrink before doing that. `router-export.log` holds the
counts of every previous run, and the last uploaded bundle holds the rows
themselves, so "which accounts went away" is an answerable question and worth
answering first. Blessing a shrink is how a real loss gets rotated out of the
backups a week later.

### The lifecycle rule is a human's job

`qa-artifacts` auto-deletes objects 30 days after they are written. A new
container starts with **no lifecycle rule at all**, and the account key this tool
uses cannot add one — lifecycle management is a management-plane operation, which
means the Azure Portal or an `az` session with rights over the storage account,
neither of which an agent has or should have.

So until somebody with that access adds a rule to `prod-exports`, the exports
accumulate: about 20 KB a day at today's size, which is roughly 7 MB a year.
Not urgent, and not free either — and worth deciding deliberately rather than
inheriting, because the right retention for a backup is a different question from
the right retention for a test video.

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
- **Retention is undecided until a human decides it** — see *The lifecycle rule
  is a human's job*. Whatever rule lands there, a month of dailies is a rotation
  and not an archive: nothing here is the copy to reach for in a year.
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
with, so "the hash matches" means something, and a stand-in `az` in place of the
real CLI. **45 assertions**, covering:

| | |
|---|---|
| the good path | exit 0, manifest with the right counts, codes CSV beside the bundle, mode `600`, log line, counts remembered |
| sign-in | a refused token, a missing bootstrap endpoint, a 200 that sets no cookie, a router that does not answer at all |
| the file that arrived | a failing export, a truncated bundle, a hash the header disagrees with, a missing hash header, a foreign `format`, a newer `schemaVersion` |
| what it carries | an empty export, a codes CSV shorter than the bundle's count, a codes CSV with the wrong header |
| between runs | a shrinking export naming what shrank, a growing one accepted, local rotation to `LOCAL_KEEP` |
| the container | `qa-artifacts` named outright, `qa-artifacts` reached by falling through, `EXPORT_CONTAINER` winning over the credentials env |
| the read-back | an upload that fails, a container holding different bytes, a container missing an object, objects that cannot be listed back |
| configuration | no config file, no storage credentials, an unknown argument |

Nothing in the suite reaches the network or object storage. The container is
resolved before any `az` call, which is what lets the refusal be tested without a
storage account; everything past it goes through the stand-in, which is also why
the suite costs 13 seconds instead of a minute — a slow suite is a suite that
stops being run.
