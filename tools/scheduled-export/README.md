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
router-export.sh [--local-only] [--quiet] [--accept-shrink '<reason>']
```

0. **reads the deployment's current `auth.bootstrapToken` off the marketplace
   that deployed it** — the same value the operator console shows in its
   credentials dialog, found by whichever deployment is currently serving
   `ROUTER_API_ORIGIN`. That parameter is *generated per deployment*, so a copy
   written down here stops working the day production is rebuilt; see *The token
   is not written down*, below;
1. signs in at `POST /auth/bootstrap` with it — the token's designed break-glass
   purpose, and the only credential that works with nobody watching, because
   ordinary sign-in is a code mailed to a mailbox;
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
   (`--accept-shrink '<reason>'` is how an operator overrules this, and the only
   way — see *Accepting a legitimate shrink*, below);
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

and the same objects under `<date>/<stamp>/` in the container — prefixed
by `BLOB_PREFIX` if one is set, which a container of this tool's own does not
need. A run that overruled the shrink guard carries a fourth file,
`shrink-acceptances.log`; see *Accepting a legitimate shrink*.

## Configuration

`~/.config/router-export/env`, mode `0600`:

| | |
|---|---|
| `ROUTER_API_ORIGIN` | `https://api.router.superprotocol.com` |
| `ROUTER_CONSOLE_ORIGIN` | `https://console.router.superprotocol.com` — sent as `Origin` |
| `MARKETPLACE_ORIGIN` | the marketplace that deployed the router, e.g. `https://marketplace.demo.superprotocol.dev`. Unset means "use the stored token and nothing else" |
| `MARKETPLACE_EMAIL` | a marketplace account with the `member` role on the organization that owns the deployment |
| `MARKETPLACE_PASSWORD` | its password. **Not** deployment-scoped — rebuilding the router does not touch it |
| `MARKETPLACE_ORG_ID` | optional but wanted — see below. Without it, every organization the account belongs to is searched for the deployment serving `ROUTER_API_ORIGIN` |
| `MARKETPLACE_DEPLOYMENT_ID` | optional pin. Rarely what you want: a rebuild is a *new* deployment, so a pinned id goes stale exactly as a stored token does |
| `ROUTER_BOOTSTRAP_TOKEN` | the deployment's `auth.bootstrapToken`. The fallback when the marketplace cannot be reached, and the whole credential when none is configured |
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

### The token is not written down

`auth.bootstrapToken` is a *generated* parameter of the marketplace deployment.
Every production rebuild is a new deployment with a new one, so a copy kept in
this configuration file turns into a `401` the moment the rebuild lands — and
then stays a 401 until somebody notices and pastes the new value in by hand.
That happened three times; the last on 2026-10-20, during the SUP-434 deploy
train, when the 12:00 export 401'd (SUP-438). It is the worst possible timing: a
rebuild is exactly when the previous deployment's data is about to stop existing.

So the token is not stored. Given `MARKETPLACE_ORIGIN` and an account, each run:

1. signs in to the marketplace (`POST /api/auth/sign-in/email`);
2. lists the deployments of every organization that account belongs to, and
   takes the one whose `apiHostname` parameter is the host in
   `ROUTER_API_ORIGIN`. **By hostname, not by id** — a rebuild is a new
   deployment row serving the same hostname, so an id would go stale exactly as
   a token does. Deployments being deleted are skipped, and when a rebuild
   leaves two answering at once the newest running one wins;
3. reads `GET …/deployments/<id>/credentials` and takes `bootstrapToken` — the
   same call the console's credentials dialog makes. It needs the `member` role;
   a viewer is refused, and the refusal says so.

The marketplace account is not deployment-scoped, which is the whole point: a
rebuild of the router does not touch it. Which deployment a run got its token
from is recorded in `state.json` as `tokenSource`.

**Pin `MARKETPLACE_ORG_ID`.** It is optional, and leaving it out is the worse
default: listing an organization's deployments re-syncs *every* one of them
against its cloud, so an unpinned nightly run does that for every organization
the account can see. Pinning shrinks both the side effect and the blast radius
to the one organization that owns the router. Give the host a service account of
its own at `member` — the narrowest role that may read generated values — rather
than an operator's login.

**If the marketplace cannot be reached**, the run falls back to a stored
`ROUTER_BOOTSTRAP_TOKEN` rather than refusing — a backup that stops because a
*second* system is down is worse than the problem it guards against. But that
fallback quietly re-arms the original defect, so it is not left in a log: the
first degraded run comments on `ALERT_ISSUE_ID` and drops a
`.token-lookup-degraded` marker in `EXPORT_DIR`, and nothing is said again until
a run reads the token cleanly, says so, and clears it. One comment per outage,
not one a night.

**The marker is only dropped if the comment was actually delivered.** A `multica`
that fails is not a comment that was sent, and remembering it as one would buy
permanent silence from the second night on — the loud fallback turned back into
the quiet one by a single lost CLI call. A run that could not announce the
fallback says so and leaves the next run to try again. (A host with no
`ALERT_ISSUE_ID` never promised a comment, and is not treated as having failed
to send one.)

**A deployment not made by a marketplace** — a hand-rolled install, a chart
applied directly — has no credentials dialog to ask. Leave `MARKETPLACE_ORIGIN`
unset there and keep `ROUTER_BOOTSTRAP_TOKEN`; the behaviour is what it always
was, and a rebuild means editing this file, which is why the redeploy runbook in
[`docs/router.md`](../../docs/router.md) names that step explicitly.

### Checking it survives a rebuild

Without rebuilding anything: rotate the token out from under the tool and see
that the run is unaffected.

```sh
# What this host would have used before, if anything:
grep '^ROUTER_BOOTSTRAP_TOKEN=' ~/.config/router-export/env | sed 's/=.*/=…/'

# Break it on purpose — this is what a rebuild does to it — and run:
sed -i 's/^ROUTER_BOOTSTRAP_TOKEN=.*/ROUTER_BOOTSTRAP_TOKEN=rotated-away-by-a-rebuild-3232/' \
  ~/.config/router-export/env
router-export.sh --local-only
```

It should sign in and finish. `state.json`'s `tokenSource` names the deployment
it read from, and the stored value it ignored is still the broken one.

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
from a deployment that came back from an older copy.

The refusal is **sticky, and re-running does not clear it**: `state.json` is
rewritten only by a run that succeeded, so a refused run leaves the old counts in
place and the next run compares against the same baseline and refuses the same
way. Only a person can end that loop, by saying the new reading is the right one:

```sh
router-export --accept-shrink 'the SUP-359 rehearsal account was withdrawn'
```

The reason is required, and must be neither blank nor another flag — mistyping
`--accept-shrink --local-only` would otherwise record "--local-only" as the
justification and upload the bundle you meant to keep on this host. The run then
says the old → new counts on stderr whatever `--quiet` asked for, appends the
reason, the counts, the run stamp and the invoking user to
`shrink-acceptances.log`, and goes on to upload and to make this smaller reading
the new baseline. Passing the flag when nothing shrank accepts nothing and says
so, also whatever `--quiet` asked for.

**That log is the record, and `state.json` is not.** Every successful run
rewrites `state.json` wholesale, so anything written into it to explain an
acceptance is gone one run later — which is precisely what happened to the first
acceptance, hand-edited in on 2026-10-19 and erased by the run that followed
(SUP-432). `shrink-acceptances.log` is append-only and nothing in this script
truncates it, so `cat ~/prod-exports/shrink-acceptances.log` answers "has anyone
ever overruled the loss alarm, and why" for the life of the host — and because
that is one host, an accepting run also copies the log into its run directory,
so the record goes to object storage with the bundle it vouches for. The
accepting run leaves an `ACCEPTED-SHRINK` line in `router-export.log` too,
between the ordinary `ok` lines, so the day-by-day story does not go quiet
about it.

Find out *why* the counts fell before reaching for the flag. `router-export.log`
holds the counts of every previous run, and the last uploaded bundle holds the
rows themselves, so "which accounts went away" is an answerable question —

```sh
zcat ~/prod-exports/<stamp>/router-export-<stamp>.json.gz \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(
      JSON.parse(s).data.users.map(u=>u.email).sort().join("\n")))'
```

— and worth answering first. Blessing a shrink is how a real loss gets rotated
out of the backups a week later.

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
- **Reading the token adds a dependency on the marketplace** — a second system
  that can be down. It is a soft one: the run falls back to the stored token and
  carries on, and only a host with neither is stopped. The trade is deliberate,
  because the dependency is on a system that is up when it matters (a rebuild
  goes *through* the marketplace) and the alternative was a credential that is
  guaranteed wrong precisely then.
- **The marketplace account is a broader credential than the one it replaces.**
  `member` on the organization can deploy and reconfigure, where the bootstrap
  token only opened one router's administrator account. Give this host an
  account that belongs to it, not an operator's own.
- **Where the copies live is where the credentials live.** The host that holds
  the storage key is the host that writes the backups, so losing it badly enough
  loses the ability to take new ones. The copies already written survive it.
- **Retention is undecided until a human decides it** — see *The lifecycle rule
  is a human's job*. Whatever rule lands there, a month of dailies is a rotation
  and not an archive: nothing here is the copy to reach for in a year.
- **The bundle is stored as it comes off the router** — not encrypted at rest
  beyond what the storage account does. Encrypting it would mean a key that has
  to outlive this host, which is a question with an owner, not a default.

All of these shrink to nothing when the router exports itself to a target given as a
deployment parameter. That is the fix; this is the bridge to it.

## Tests

```sh
bash tools/scheduled-export/router-export.test.sh   # or: pnpm nx run scheduled-export:test
```

A fake router on loopback, built by the same canonical form the real one hashes
with, so "the hash matches" means something, and a stand-in `az` in place of the
real CLI. **120 assertions**, covering:

| | |
|---|---|
| the good path | exit 0, manifest with the right counts, codes CSV beside the bundle, mode `600`, log line, counts remembered |
| sign-in | a refused token, a missing bootstrap endpoint, a 200 that sets no cookie, a router that does not answer at all |
| the token, across a rebuild | the deployment's token preferred to the stored one and recorded in `tokenSource`; a rebuild that rotates it — old deployment deleting, new one running, config untouched — not stopping the export; the same rotation against a stored-token-only configuration failing *and* raising the alarm |
| the token, when the lookup cannot run | an unreachable marketplace falling back and saying so, the fallback alarm raised once and not repeated the next night, a recovered lookup saying so and clearing the marker, no stored token to fall back to refused, a marketplace half-configured refused by name |
| the token, when the lookup runs and finds nothing | no deployment serving this hostname (naming the ones it saw), a sign-in the marketplace refuses, a viewer told which role it needs, a deployment whose token was supplied by hand, a pin on a deployment serving another host, a pinned organization the account is not a member of |
| the alarm nobody received | a failed `multica` not stopping the backup and not being remembered as a delivered comment, the next run saying what the failed one could not, and still only once after that |
| values this host does not control | a `"` and a `\` in the marketplace's `appVersion` leaving `state.json` and the run manifest parseable, the odd version readable back verbatim, and — the point of it — the shrink guard still firing against the real baseline instead of against zero |
| the file that arrived | a failing export, a truncated bundle, a hash the header disagrees with, a missing hash header, a foreign `format`, a newer `schemaVersion` |
| what it carries | an empty export, a codes CSV shorter than the bundle's count, a codes CSV with the wrong header |
| between runs | a shrinking export naming what shrank, a growing one accepted, local rotation to `LOCAL_KEEP` |
| overruling the shrink guard | a bare re-run refusing identically, the refusal naming the flag in text a Markdown renderer cannot eat, `--accept-shrink` getting through and becoming the new baseline, the acceptance said even under `--quiet`, the acceptance log surviving the next successful run, appending rather than replacing, keeping one acceptance to one line through a reason with a newline in it, travelling with the upload and passing the read-back, the flag as a no-op when nothing shrank, a missing reason, a blank one and a flag-shaped one refused, a single-dash one accepted |
| the container | `qa-artifacts` named outright, `qa-artifacts` reached by falling through, `EXPORT_CONTAINER` winning over the credentials env |
| the read-back | an upload that fails, a container holding different bytes, a container missing an object, objects that cannot be listed back |
| configuration | no config file, no storage credentials, an unknown argument |

Nothing in the suite reaches the network or object storage. The container is
resolved before any `az` call, which is what lets the refusal be tested without a
storage account; everything past it goes through the stand-in, which is also why
the suite costs some twenty seconds instead of minutes — a slow suite is a suite
that stops being run. The marketplace is the same loopback server on different
paths, and the `multica` CLI has a stand-in too, because an alarm that fires is
the half of this tool no exit code can check.
